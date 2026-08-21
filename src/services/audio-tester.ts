import type { AppSettings, CaptureSource } from '@shared/types'
import {
  findDefaultMonitorDevice,
  hasAnyMicrophone,
  openLoopbackInput,
  openMicrophone
} from './audio-devices'
import { log } from './ipc'
import {
  microphoneBlockedMessage,
  noSystemAudioDeviceMessage,
  platformName
} from './platform'
import { openDesktopLoopbackAudio, stopStream } from './screen-capture'

const SCOPE = 'audio-tester'

/** How long a microphone sample runs before it is played back. */
const SAMPLE_SECONDS = 5
const TONE_SECONDS = 1.5
const ANALYSER_FFT_SIZE = 256

export type TestTarget = 'microphone' | 'systemAudio'

export type TestPhase =
  | 'idle'
  | 'starting'
  /** Live input, meter running. */
  | 'monitoring'
  /** Capturing a sample to play back. */
  | 'recording'
  /** A recorded sample is available. */
  | 'ready'

export interface AudioTestSnapshot {
  target: TestTarget | null
  phase: TestPhase
  error: string | null
  /** Blob URL of the recorded sample, ready for playback. */
  clipUrl: string | null
  secondsLeft: number
  /** True while the generated test tone is playing. */
  tonePlaying: boolean
}

const IDLE: AudioTestSnapshot = {
  target: null,
  phase: 'idle',
  error: null,
  clipUrl: null,
  secondsLeft: 0,
  tonePlaying: false
}

/**
 * Device check for the microphone and for system audio.
 *
 * Answers the two questions users actually have before they hit record:
 * "is my microphone picking anything up, and does it sound right?" and
 * "will the machine's own audio be captured?".
 *
 * Deliberately independent of the recording pipeline — it opens its own
 * streams and releases them on stop, so a test can never interfere with a
 * recording (the UI also disables testing while one is running).
 */
class AudioTester {
  private snapshot: AudioTestSnapshot = IDLE
  private readonly listeners = new Set<() => void>()

  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private levelBuffer = new Uint8Array(ANALYSER_FFT_SIZE / 2)

  private recorder: MediaRecorder | null = null
  private countdown: ReturnType<typeof setInterval> | null = null
  private toneTimer: ReturnType<typeof setTimeout> | null = null
  private oscillator: OscillatorNode | null = null

  /* ---------------------------- Store interface --------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): AudioTestSnapshot => this.snapshot

  private patch(changes: Partial<AudioTestSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...changes }
    for (const listener of this.listeners) listener()
  }

  /** Live input level, 0–1. Polled by the meter rather than pushed. */
  readLevel(): number {
    const analyser = this.analyser
    if (!analyser) return 0

    const bins = analyser.frequencyBinCount
    if (this.levelBuffer.length !== bins) this.levelBuffer = new Uint8Array(bins)

    analyser.getByteTimeDomainData(this.levelBuffer)

    let peak = 0
    for (let index = 0; index < bins; index += 1) {
      const sample = Math.abs((this.levelBuffer[index] ?? 128) - 128)
      if (sample > peak) peak = sample
    }
    return Math.min(1, peak / 128)
  }

  /* --------------------------------- Start -------------------------------- */

  async start(
    target: TestTarget,
    settings: AppSettings,
    source: CaptureSource | null,
    supportsNativeLoopback: boolean
  ): Promise<void> {
    await this.stop()

    this.patch({ ...IDLE, target, phase: 'starting' })

    try {
      this.stream =
        target === 'microphone'
          ? await openMicrophone(settings.audio.microphoneDeviceId, {
              noiseSuppression: settings.experimental.noiseSuppression
            })
          : await this.openSystemAudio(settings, source, supportsNativeLoopback)

      this.buildGraph(this.stream)
      this.patch({ phase: 'monitoring' })
      log.info(SCOPE, 'Audio test started', { target })
    } catch (error) {
      log.warn(SCOPE, 'Audio test could not start', error)

      // Distinguish "nothing is plugged in" from "the device refused to open";
      // they call for completely different fixes.
      const noDevice = target === 'microphone' ? !(await hasAnyMicrophone()) : false

      await this.stop()
      this.patch({ target, phase: 'idle', error: describeError(target, error, noDevice) })
    }
  }

  /**
   * Opens system audio for monitoring.
   *
   * Windows exposes desktop loopback, but only when a video track is requested
   * in the same call — hence the tiny throwaway capture. Elsewhere the loopback
   * is an ordinary input device (a PulseAudio monitor, or BlackHole on macOS)
   * and is opened directly.
   */
  private async openSystemAudio(
    settings: AppSettings,
    source: CaptureSource | null,
    supportsNativeLoopback: boolean
  ): Promise<MediaStream> {
    if (supportsNativeLoopback) {
      if (!source) throw new Error('NO_SOURCE')
      return openDesktopLoopbackAudio(source.id)
    }

    const deviceId =
      settings.audio.systemAudioDeviceId ?? (await findDefaultMonitorDevice())?.deviceId ?? null

    if (!deviceId) throw new Error('NO_MONITOR_DEVICE')
    return openLoopbackInput(deviceId)
  }

  private buildGraph(stream: MediaStream): void {
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.context = context

    const analyser = context.createAnalyser()
    analyser.fftSize = ANALYSER_FFT_SIZE
    analyser.smoothingTimeConstant = 0.6

    // Monitoring only — the input is never routed to the speakers, which would
    // cause feedback on the microphone test.
    context.createMediaStreamSource(stream).connect(analyser)
    this.analyser = analyser
  }

  /* ------------------------------ Sample check ---------------------------- */

  /**
   * Records a short sample and turns it into a playable clip, so the user can
   * hear exactly what the recording will sound like.
   */
  recordSample(): void {
    if (!this.stream || this.snapshot.phase !== 'monitoring') return

    this.revokeClip()

    const chunks: Blob[] = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : ''

    const recorder = new MediaRecorder(
      this.stream,
      mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : { audioBitsPerSecond: 128_000 }
    )
    this.recorder = recorder

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }

    recorder.onstop = () => {
      this.stopCountdown()
      this.recorder = null

      if (chunks.length === 0) {
        this.patch({ phase: 'monitoring', error: 'Nothing was captured.' })
        return
      }

      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
      this.patch({ phase: 'ready', clipUrl: URL.createObjectURL(blob), secondsLeft: 0 })
    }

    recorder.start()
    this.patch({ phase: 'recording', secondsLeft: SAMPLE_SECONDS, error: null })

    this.countdown = setInterval(() => {
      const next = this.snapshot.secondsLeft - 1
      if (next <= 0) {
        this.finishSample()
        return
      }
      this.patch({ secondsLeft: next })
    }, 1000)
  }

  /** Ends the sample early. */
  finishSample(): void {
    this.stopCountdown()
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
  }

  /** Discards the clip and returns to live monitoring. */
  clearSample(): void {
    this.revokeClip()
    if (this.snapshot.phase === 'ready') this.patch({ phase: 'monitoring' })
  }

  /* ------------------------------- Test tone ------------------------------ */

  /**
   * Plays a short tone through the speakers.
   *
   * Used with the system-audio test: it guarantees there is something for the
   * loopback to pick up, so a flat meter means a real configuration problem
   * rather than a silent desktop.
   */
  playTone(): void {
    if (this.snapshot.tonePlaying) return

    const context = this.context ?? new AudioContext()
    this.context = context

    const oscillator = context.createOscillator()
    const gain = context.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.value = 440

    // Fade in and out; an abrupt square edge on a sine is an audible click.
    const now = context.currentTime
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.18, now + 0.05)
    gain.gain.setValueAtTime(0.18, now + TONE_SECONDS - 0.05)
    gain.gain.linearRampToValueAtTime(0, now + TONE_SECONDS)

    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(now)
    oscillator.stop(now + TONE_SECONDS)

    this.oscillator = oscillator
    this.patch({ tonePlaying: true })

    this.toneTimer = setTimeout(() => {
      this.oscillator = null
      this.toneTimer = null
      this.patch({ tonePlaying: false })
    }, TONE_SECONDS * 1000)
  }

  /* --------------------------------- Stop --------------------------------- */

  async stop(): Promise<void> {
    this.stopCountdown()

    if (this.toneTimer) {
      clearTimeout(this.toneTimer)
      this.toneTimer = null
    }
    if (this.oscillator) {
      try {
        this.oscillator.stop()
      } catch {
        /* already stopped */
      }
      this.oscillator = null
    }

    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null
      this.recorder.onstop = null
      try {
        this.recorder.stop()
      } catch {
        /* already stopped */
      }
    }
    this.recorder = null

    stopStream(this.stream)
    this.stream = null

    this.analyser?.disconnect()
    this.analyser = null

    if (this.context && this.context.state !== 'closed') {
      try {
        await this.context.close()
      } catch {
        /* nothing useful to do */
      }
    }
    this.context = null

    this.revokeClip()
    this.snapshot = IDLE
    for (const listener of this.listeners) listener()
  }

  private stopCountdown(): void {
    if (!this.countdown) return
    clearInterval(this.countdown)
    this.countdown = null
  }

  private revokeClip(): void {
    if (!this.snapshot.clipUrl) return
    URL.revokeObjectURL(this.snapshot.clipUrl)
    this.snapshot = { ...this.snapshot, clipUrl: null }
  }
}

/** Turns a raw failure into something the user can act on. */
function describeError(target: TestTarget, error: unknown, noDevice: boolean): string {
  const message = error instanceof Error ? error.message : String(error)

  if (message === 'NO_MONITOR_DEVICE') return noSystemAudioDeviceMessage()

  if (message === 'NO_SOURCE') {
    return 'Select a capture source first — Windows captures system audio alongside the screen.'
  }

  const name = error instanceof Error ? error.name : ''

  if (name === 'NotAllowedError') {
    return target === 'microphone'
      ? microphoneBlockedMessage()
      : 'Permission to capture system audio was denied.'
  }

  if (name === 'NotFoundError') {
    if (target !== 'microphone') return 'The selected loopback device is no longer available.'

    return noDevice
      ? `No microphone is connected. Plug one in, or enable your built-in microphone in ${platformName()} sound settings.`
      : 'The selected microphone could not be opened. Choose a different device in Settings → Audio.'
  }

  if (name === 'NotReadableError') {
    return 'The device is in use by another application. Close it and try again.'
  }

  return message
}

export const audioTester = new AudioTester()
