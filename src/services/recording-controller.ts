import { ERROR_CODES } from '@shared/ipc'
import type {
  AppSettings,
  CaptureSource,
  FinalizeResult,
  ProcessingProgress,
  RecordingState,
  SerializedError
} from '@shared/types'
import { AudioMixer } from './audio-mixer'
import { findDefaultMonitorDevice, openLoopbackInput, openMicrophone } from './audio-devices'
import { computeCaptureBitrate, pickRecordingCodec } from './codec'
import { IpcError, log, toSerializedError, unwrap } from './ipc'
import { noSystemAudioDeviceMessage } from './platform'
import { captureScreen, stopStream } from './screen-capture'

const SCOPE = 'recorder'

/** How often MediaRecorder hands us a chunk to append to disk. */
const CHUNK_INTERVAL_MS = 1000
/** UI timer refresh rate. */
const TICK_INTERVAL_MS = 250

export interface AudioStatus {
  microphoneActive: boolean
  systemAudioActive: boolean
  /** Explains any downgrade, e.g. why system audio could not be captured. */
  note: string | null
}

export interface RecorderSnapshot {
  state: RecordingState
  elapsedMs: number
  bytesWritten: number
  sessionId: string | null
  sourceName: string | null
  codecLabel: string | null
  audio: AudioStatus
  progress: ProcessingProgress | null
  lastResult: FinalizeResult | null
  error: SerializedError | null
}

const INITIAL_SNAPSHOT: RecorderSnapshot = {
  state: 'idle',
  elapsedMs: 0,
  bytesWritten: 0,
  sessionId: null,
  sourceName: null,
  codecLabel: null,
  audio: { microphoneActive: false, systemAudioActive: false, note: null },
  progress: null,
  lastResult: null,
  error: null
}

/**
 * Owns the entire recording lifecycle.
 *
 * Kept deliberately outside React: the pipeline must survive re-renders, and a
 * plain observable class keeps the media plumbing testable on its own. The UI
 * subscribes through `useSyncExternalStore`.
 */
class RecordingController {
  private snapshot: RecorderSnapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()

  /* Media resources held for the duration of a recording. */
  private recorder: MediaRecorder | null = null
  private mixer: AudioMixer | null = null
  private videoStream: MediaStream | null = null
  private micStream: MediaStream | null = null
  private systemStream: MediaStream | null = null
  private combinedStream: MediaStream | null = null

  /* Session bookkeeping. */
  private sessionId: string | null = null
  private startedAt = 0
  private pausedTotalMs = 0
  private pausedAt: number | null = null
  private captureWidth = 0
  private captureHeight = 0
  private hasAudioTrack = false
  private mimeType = ''

  /** Settings captured at start, used when re-opening a lost device. */
  private activeSettings: AppSettings | null = null
  private wantsMicrophone = false
  private micRecoveryTimer: ReturnType<typeof setTimeout> | null = null

  private tickTimer: ReturnType<typeof setInterval> | null = null
  /** Serialises chunk writes so they reach disk in capture order. */
  private writeChain: Promise<void> = Promise.resolve()
  private writeError: SerializedError | null = null

  /* ---------------------------- Store interface --------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): RecorderSnapshot => this.snapshot

  private patch(changes: Partial<RecorderSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes }
    for (const listener of this.listeners) listener()
  }

  /** Live audio levels for the meters; intentionally not part of the snapshot. */
  readLevels(): { microphone: number; systemAudio: number } {
    return this.mixer?.readLevels() ?? { microphone: 0, systemAudio: 0 }
  }

  /** Applies gain changes to an in-flight recording. */
  applyGains(settings: AppSettings): void {
    this.mixer?.setGains({
      microphone: settings.audio.microphoneGain,
      systemAudio: settings.audio.systemAudioGain
    })
  }

  isBusy(): boolean {
    return this.snapshot.state !== 'idle' && this.snapshot.state !== 'error'
  }

  /** Called by the app shell when the main process reports encode progress. */
  handleProgress(progress: ProcessingProgress): void {
    if (progress.stage === 'done' || progress.stage === 'failed') {
      this.patch({ progress: null })
      return
    }
    this.patch({ progress })
  }

  clearError(): void {
    if (this.snapshot.error) this.patch({ error: null, state: 'idle' })
  }

  clearLastResult(): void {
    if (this.snapshot.lastResult) this.patch({ lastResult: null })
  }

  /* -------------------------------- Start -------------------------------- */

  async start(source: CaptureSource, settings: AppSettings): Promise<void> {
    if (this.isBusy()) {
      log.warn(SCOPE, 'Start ignored, controller is busy', { state: this.snapshot.state })
      return
    }

    this.resetSessionState()
    this.patch({
      state: 'preparing',
      error: null,
      lastResult: null,
      sourceName: source.name,
      elapsedMs: 0,
      bytesWritten: 0
    })

    this.activeSettings = settings
    this.wantsMicrophone = settings.audio.microphoneEnabled

    try {
      /*
       * Before anything at all looks at the screen: take this window out of
       * shot. Awaited rather than fired off, so the compositor has already been
       * told by the time the first frame is grabbed — otherwise every recording
       * opens on a picture of the recorder.
       *
       * Not fatal if it fails. A recording with the app visible in it is still
       * a recording; refusing to start would cost somebody the thing they were
       * trying to capture.
       */
      const shielded = await window.api.window.excludeFromCapture(true).catch(() => null)
      if (!shielded?.ok) log.warn(SCOPE, 'Could not take the window out of the capture')

      // 1. Reserve the session first so every captured byte has somewhere to go.
      const handle = await unwrap(window.api.recording.begin())
      this.sessionId = handle.sessionId

      // 2. Screen capture (plus desktop loopback audio where supported).
      //    A placeholder selection is exchanged for a real source first. On
      //    Wayland that is what opens the portal session, so the system share
      //    prompt appears here — once per recording, rather than every time the
      //    app lists the available screens.
      const capturable = source.placeholder
        ? await unwrap(window.api.sources.resolve(source.id))
        : source

      if (capturable.name !== source.name) this.patch({ sourceName: capturable.name })

      const wantsSystemAudio = settings.audio.systemAudioEnabled
      const capture = await captureScreen(capturable, settings, {
        withLoopback: wantsSystemAudio
      })

      this.videoStream = capture.videoStream
      this.captureWidth = capture.width
      this.captureHeight = capture.height

      // 3. Audio inputs.
      const audio = await this.openAudioInputs(settings, capture.loopbackTrack)

      // 4. Mix everything into a single track.
      this.mixer = new AudioMixer()
      const mixedTrack = this.mixer.connect(
        { microphone: this.micStream, systemAudio: this.systemStream },
        {
          microphone: settings.audio.microphoneGain,
          systemAudio: settings.audio.systemAudioGain
        }
      )

      // 5. Assemble the stream MediaRecorder will consume.
      const videoTrack = capture.videoStream.getVideoTracks()[0]
      if (!videoTrack) {
        throw new IpcError({
          code: ERROR_CODES.CAPTURE_FAILED,
          message: 'The capture produced no video track.'
        })
      }

      // Stopping the shared source (closing the window, ending the OS share
      // prompt) must end the recording rather than silently record nothing.
      videoTrack.addEventListener('ended', this.handleSourceEnded)

      this.combinedStream = new MediaStream(
        mixedTrack ? [videoTrack, mixedTrack] : [videoTrack]
      )
      this.hasAudioTrack = mixedTrack !== null

      // 6. Start the recorder.
      this.startMediaRecorder(settings)

      this.startedAt = Date.now()
      this.startTicker()

      // Only meaningful once the graph exists: survive the mic coming and going.
      this.watchMicrophone()

      this.patch({
        state: 'recording',
        sessionId: handle.sessionId,
        audio,
        codecLabel: pickRecordingCodec().label
      })

      log.info(SCOPE, 'Recording started', {
        sessionId: handle.sessionId,
        source: capturable.name,
        width: capture.width,
        height: capture.height,
        frameRate: capture.frameRate,
        audio
      })
    } catch (error) {
      log.error(SCOPE, 'Failed to start recording', error)
      await this.releaseMedia()

      if (this.sessionId) {
        // Drop the empty intermediate file rather than leaving an orphan.
        await window.api.recording.abort(this.sessionId).catch(() => undefined)
        this.sessionId = null
      }

      this.patch({ state: 'error', error: toSerializedError(error), sessionId: null })
      throw error
    }
  }

  /**
   * Resolves which audio inputs are actually available and opens them.
   * Never throws: audio problems downgrade the recording, they do not abort it.
   */
  private async openAudioInputs(
    settings: AppSettings,
    loopbackTrack: MediaStreamTrack | null
  ): Promise<AudioStatus> {
    const status: AudioStatus = {
      microphoneActive: false,
      systemAudioActive: false,
      note: null
    }

    /* Microphone */
    if (settings.audio.microphoneEnabled) {
      try {
        this.micStream = await openMicrophone(settings.audio.microphoneDeviceId, {
          noiseSuppression: settings.experimental.noiseSuppression
        })
        status.microphoneActive = true
      } catch (error) {
        log.warn(SCOPE, 'Microphone unavailable', error)
        status.note = 'Microphone unavailable — recording without it.'
      }
    }

    /* System audio */
    if (settings.audio.systemAudioEnabled) {
      if (loopbackTrack) {
        // Windows: Chromium handed us the desktop loopback alongside the video.
        this.systemStream = new MediaStream([loopbackTrack])
        status.systemAudioActive = true
      } else {
        // macOS, Linux and fallback path: capture a monitor/virtual input.
        try {
          const deviceId =
            settings.audio.systemAudioDeviceId ??
            (await findDefaultMonitorDevice())?.deviceId ??
            null

          if (deviceId) {
            this.systemStream = await openLoopbackInput(deviceId)
            status.systemAudioActive = true
          } else {
            status.note = noSystemAudioDeviceMessage()
          }
        } catch (error) {
          log.warn(SCOPE, 'System audio unavailable', error)
          status.note = 'System audio could not be captured — recording without it.'
        }
      }
    }

    return status
  }

  private startMediaRecorder(settings: AppSettings): void {
    if (!this.combinedStream) throw new Error('No stream to record')

    const codec = pickRecordingCodec()
    this.mimeType = codec.mimeType

    const videoBitsPerSecond = computeCaptureBitrate(
      this.captureWidth,
      this.captureHeight,
      settings.video.fps,
      settings.video.quality
    )

    const options: MediaRecorderOptions = {
      ...(codec.mimeType ? { mimeType: codec.mimeType } : {}),
      videoBitsPerSecond,
      ...(this.hasAudioTrack ? { audioBitsPerSecond: 192_000 } : {})
    }

    const recorder = new MediaRecorder(this.combinedStream, options)
    this.recorder = recorder

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) this.enqueueChunk(event.data)
    }

    recorder.onerror = (event: Event) => {
      const error = (event as unknown as { error?: DOMException }).error
      log.error(SCOPE, 'MediaRecorder error', error)
      this.writeError = {
        code: ERROR_CODES.CAPTURE_FAILED,
        message: error?.message ?? 'The recorder stopped unexpectedly.'
      }
      void this.stop()
    }

    // A timeslice makes MediaRecorder emit chunks continuously instead of
    // holding the entire recording in memory until stop().
    recorder.start(CHUNK_INTERVAL_MS)
  }

  /** Appends a chunk, preserving order and surfacing the first write failure. */
  private enqueueChunk(blob: Blob): void {
    const sessionId = this.sessionId
    if (!sessionId) return

    this.writeChain = this.writeChain
      .then(async () => {
        const buffer = await blob.arrayBuffer()
        await unwrap(window.api.recording.writeChunk(sessionId, buffer))
        this.patch({ bytesWritten: this.snapshot.bytesWritten + buffer.byteLength })
      })
      .catch((error: unknown) => {
        // Record the first failure only; later chunks will usually fail too and
        // the original cause is the useful one.
        this.writeError ??= toSerializedError(error)
        log.error(SCOPE, 'Failed to write chunk', error)
      })
  }

  /* -------------------------- Pause / resume / stop ------------------------ */

  pause(): void {
    if (this.snapshot.state !== 'recording' || !this.recorder) return

    this.recorder.pause()
    this.pausedAt = Date.now()
    this.patch({ state: 'paused' })
    log.info(SCOPE, 'Recording paused')
  }

  resume(): void {
    if (this.snapshot.state !== 'paused' || !this.recorder) return

    if (this.pausedAt !== null) {
      this.pausedTotalMs += Date.now() - this.pausedAt
      this.pausedAt = null
    }
    this.recorder.resume()
    this.patch({ state: 'recording' })
    log.info(SCOPE, 'Recording resumed')
  }

  /**
   * Stops capture and runs the conversion.
   * Resolves with the finished file, or `null` when the run failed.
   */
  async stop(): Promise<FinalizeResult | null> {
    const state = this.snapshot.state
    if (state !== 'recording' && state !== 'paused') return null

    this.patch({ state: 'stopping' })
    this.stopTicker()

    const durationMs = this.computeElapsed()
    const sessionId = this.sessionId

    try {
      await this.stopMediaRecorder()
      // Wait for every queued chunk to reach disk before closing the file.
      await this.writeChain
      await this.releaseMedia()

      if (!sessionId) throw new Error('Recording session was lost')

      if (this.writeError) {
        // Data was lost mid-recording; abandon rather than ship a broken file.
        await window.api.recording.abort(sessionId).catch(() => undefined)
        throw new IpcError(this.writeError)
      }

      this.patch({ state: 'processing' })

      const result = await unwrap(
        window.api.recording.finalize({
          sessionId,
          durationMs,
          width: this.captureWidth,
          height: this.captureHeight,
          hasAudio: this.hasAudioTrack,
          mimeType: this.mimeType
        })
      )

      log.info(SCOPE, 'Recording finished', result)
      this.resetSessionState()
      this.patch({
        state: 'idle',
        lastResult: result,
        progress: null,
        sessionId: null,
        elapsedMs: 0
      })

      return result
    } catch (error) {
      log.error(SCOPE, 'Failed to finish recording', error)
      await this.releaseMedia()
      this.resetSessionState()
      this.patch({
        state: 'error',
        error: toSerializedError(error),
        progress: null,
        sessionId: null
      })
      return null
    }
  }

  /** Cancels a recording and deletes its intermediate file. */
  async cancel(): Promise<void> {
    const state = this.snapshot.state
    if (state !== 'recording' && state !== 'paused') return

    this.stopTicker()
    const sessionId = this.sessionId

    try {
      await this.stopMediaRecorder()
      await this.writeChain
    } catch (error) {
      log.warn(SCOPE, 'Error while cancelling', error)
    }

    await this.releaseMedia()

    if (sessionId) {
      await window.api.recording.abort(sessionId).catch(() => undefined)
    }

    this.resetSessionState()
    this.patch({ state: 'idle', sessionId: null, elapsedMs: 0, bytesWritten: 0, progress: null })
    log.info(SCOPE, 'Recording cancelled')
  }

  private stopMediaRecorder(): Promise<void> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') return Promise.resolve()

    return new Promise<void>((resolve) => {
      // `onstop` fires after the final `ondataavailable`, so by the time it
      // runs every byte has been queued on the write chain.
      recorder.onstop = () => resolve()

      try {
        recorder.stop()
      } catch (error) {
        log.warn(SCOPE, 'MediaRecorder.stop threw', error)
        resolve()
      }

      // Safety net: never hang the UI if `onstop` is not delivered.
      setTimeout(resolve, 5000)
    })
  }

  /* ------------------------------- Internals ------------------------------ */

  private handleSourceEnded = (): void => {
    log.warn(SCOPE, 'Capture source ended, stopping recording')
    void this.stop()
  }

  /* ------------------------- Microphone hot-swap -------------------------- */

  /**
   * Watches the microphone for disappearance.
   *
   * A Bluetooth headset dropping, a USB mic being unplugged, or Windows moving
   * the device to another profile all end or mute the track. Without this the
   * mixer would keep a dead source node connected and silently record nothing
   * for the rest of the session.
   */
  private watchMicrophone(): void {
    const track = this.micStream?.getAudioTracks()[0]
    if (!track) return

    track.addEventListener('ended', this.handleMicLost)
    track.addEventListener('mute', this.handleMicLost)

    // Fires when a device is plugged in or removed anywhere on the system.
    navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange)
  }

  private unwatchMicrophone(): void {
    const track = this.micStream?.getAudioTracks()[0]
    track?.removeEventListener('ended', this.handleMicLost)
    track?.removeEventListener('mute', this.handleMicLost)

    navigator.mediaDevices.removeEventListener('devicechange', this.handleDeviceChange)

    if (this.micRecoveryTimer !== null) {
      clearTimeout(this.micRecoveryTimer)
      this.micRecoveryTimer = null
    }
  }

  private handleMicLost = (): void => {
    if (!this.isLive()) return

    log.warn(SCOPE, 'Microphone track lost during recording')

    this.patch({
      audio: {
        ...this.snapshot.audio,
        microphoneActive: false,
        note: 'Microphone disconnected — the recording continues and will pick it back up automatically.'
      }
    })

    // Detach the dead node immediately so it cannot keep the device claimed.
    this.mixer?.replaceInput('microphone', null)
    stopStream(this.micStream)
    this.micStream = null

    this.scheduleMicRecovery(0)
  }

  private handleDeviceChange = (): void => {
    // A device appeared or vanished. If we currently have no microphone but
    // the user asked for one, this is the moment to try again.
    if (!this.isLive() || this.micStream || !this.wantsMicrophone) return
    this.scheduleMicRecovery(0)
  }

  /**
   * Retries opening the microphone with backoff.
   *
   * Bluetooth in particular takes several seconds to re-enumerate after
   * reconnecting, and the first attempt almost always fails.
   */
  private scheduleMicRecovery(attempt: number): void {
    if (this.micRecoveryTimer !== null) clearTimeout(this.micRecoveryTimer)

    const delay = attempt === 0 ? 400 : Math.min(1000 * 2 ** (attempt - 1), 8000)

    this.micRecoveryTimer = setTimeout(() => {
      this.micRecoveryTimer = null
      void this.tryRecoverMicrophone(attempt)
    }, delay)
  }

  private async tryRecoverMicrophone(attempt: number): Promise<void> {
    if (!this.isLive() || !this.wantsMicrophone || this.micStream) return

    const settings = this.activeSettings
    if (!settings) return

    try {
      const stream = await openMicrophone(settings.audio.microphoneDeviceId, {
        noiseSuppression: settings.experimental.noiseSuppression
      })

      const track = stream.getAudioTracks()[0]
      if (!track || track.muted) {
        stopStream(stream)
        throw new Error('Device reappeared but produced no usable track')
      }

      const swapped = this.mixer?.replaceInput('microphone', stream) ?? false
      if (!swapped) {
        // The recording began with the microphone disabled, so the mixer has no
        // channel for it. Adding one now would not reach the encoder.
        stopStream(stream)
        log.warn(SCOPE, 'Microphone returned but this recording has no microphone channel')
        return
      }

      this.micStream = stream
      this.watchMicrophone()

      this.patch({
        audio: { ...this.snapshot.audio, microphoneActive: true, note: null }
      })
      log.info(SCOPE, 'Microphone reconnected mid-recording', { attempt })
    } catch (error) {
      log.debug(SCOPE, 'Microphone recovery attempt failed', { attempt, error })

      // Keep trying for roughly a minute, then leave it to `devicechange`.
      if (attempt < 8) this.scheduleMicRecovery(attempt + 1)
    }
  }

  private isLive(): boolean {
    return this.snapshot.state === 'recording' || this.snapshot.state === 'paused'
  }

  private startTicker(): void {
    this.stopTicker()
    this.tickTimer = setInterval(() => {
      this.patch({ elapsedMs: this.computeElapsed() })
    }, TICK_INTERVAL_MS)
  }

  private stopTicker(): void {
    if (!this.tickTimer) return
    clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  private computeElapsed(): number {
    if (this.startedAt === 0) return 0

    const pausedNow = this.pausedAt !== null ? Date.now() - this.pausedAt : 0
    return Math.max(0, Date.now() - this.startedAt - this.pausedTotalMs - pausedNow)
  }

  /** Releases every media resource. Safe to call repeatedly. */
  private async releaseMedia(): Promise<void> {
    this.unwatchMicrophone()

    const videoTrack = this.videoStream?.getVideoTracks()[0]
    videoTrack?.removeEventListener('ended', this.handleSourceEnded)

    if (this.recorder) {
      this.recorder.ondataavailable = null
      this.recorder.onerror = null
      this.recorder.onstop = null
      this.recorder = null
    }

    stopStream(this.videoStream)
    stopStream(this.micStream)
    stopStream(this.systemStream)
    stopStream(this.combinedStream)

    this.videoStream = null
    this.micStream = null
    this.systemStream = null
    this.combinedStream = null

    if (this.mixer) {
      await this.mixer.dispose()
      this.mixer = null
    }

    /*
     * The window belongs back in view.
     *
     * Put here rather than in `stop()` because this is the teardown every exit
     * path already runs through — finished, cancelled, failed to start, source
     * pulled away — so none of them can leave the window shut out of capture
     * for the rest of the session.
     */
    await window.api.window.excludeFromCapture(false).catch(() => undefined)
  }

  private resetSessionState(): void {
    this.stopTicker()
    this.unwatchMicrophone()
    this.activeSettings = null
    this.wantsMicrophone = false
    this.sessionId = null
    this.startedAt = 0
    this.pausedTotalMs = 0
    this.pausedAt = null
    this.captureWidth = 0
    this.captureHeight = 0
    this.hasAudioTrack = false
    this.mimeType = ''
    this.writeChain = Promise.resolve()
    this.writeError = null
  }
}

/** Application-wide singleton — only one recording can run at a time. */
export const recordingController = new RecordingController()
