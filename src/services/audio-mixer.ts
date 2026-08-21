import { log } from './ipc'

const SCOPE = 'audio-mixer'

/** All audio is resampled to 48 kHz, matching Opus and the AAC output. */
const SAMPLE_RATE = 48000
/** Small FFT keeps the level meters cheap enough to poll at 20 Hz. */
const ANALYSER_FFT_SIZE = 256

export interface MixerInput {
  microphone: MediaStream | null
  systemAudio: MediaStream | null
}

export interface MixerGains {
  microphone: number
  systemAudio: number
}

/**
 * Combines microphone and system audio into a single stereo track.
 *
 * Web Audio is used rather than simply adding two tracks to the MediaStream
 * because MediaRecorder encodes only the first audio track it is given —
 * a second track would be silently dropped.
 */
export class AudioMixer {
  private context: AudioContext | null = null
  private destination: MediaStreamAudioDestinationNode | null = null

  private micGain: GainNode | null = null
  private systemGain: GainNode | null = null
  private micAnalyser: AnalyserNode | null = null
  private systemAnalyser: AnalyserNode | null = null

  private readonly sourceNodes: MediaStreamAudioSourceNode[] = []
  /** Kept per input so a device can be swapped without rebuilding the graph. */
  private micSource: MediaStreamAudioSourceNode | null = null
  private systemSource: MediaStreamAudioSourceNode | null = null
  private levelBuffer = new Uint8Array(ANALYSER_FFT_SIZE / 2)

  /** True when at least one input was successfully connected. */
  get hasAudio(): boolean {
    return this.sourceNodes.length > 0
  }

  /**
   * Builds the graph and returns the mixed track, or `null` when no input was
   * supplied (a silent recording is valid).
   */
  connect(inputs: MixerInput, gains: MixerGains): MediaStreamTrack | null {
    if (!inputs.microphone && !inputs.systemAudio) return null

    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' })
    this.context = context
    this.destination = context.createMediaStreamDestination()

    if (inputs.microphone) {
      const built = this.attach(inputs.microphone, gains.microphone, 'microphone')
      this.micGain = built.gain
      this.micAnalyser = built.analyser
    }

    if (inputs.systemAudio) {
      const built = this.attach(inputs.systemAudio, gains.systemAudio, 'systemAudio')
      this.systemGain = built.gain
      this.systemAnalyser = built.analyser
    }

    if (this.sourceNodes.length === 0) {
      void this.dispose()
      return null
    }

    const [track] = this.destination.stream.getAudioTracks()
    log.info(SCOPE, 'Audio graph ready', {
      sources: this.sourceNodes.length,
      sampleRate: context.sampleRate
    })

    return track ?? null
  }

  private attach(
    stream: MediaStream,
    gainValue: number,
    label: string
  ): { gain: GainNode; analyser: AnalyserNode } {
    const context = this.context
    const destination = this.destination
    if (!context || !destination) throw new Error('Mixer is not initialised')

    const source = context.createMediaStreamSource(stream)
    const gain = context.createGain()
    gain.gain.value = clampGain(gainValue)

    const analyser = context.createAnalyser()
    analyser.fftSize = ANALYSER_FFT_SIZE
    analyser.smoothingTimeConstant = 0.6

    // source -> gain -> destination, with the analyser tapped off the gain node
    // so the meter reflects what is actually being recorded.
    source.connect(gain)
    gain.connect(analyser)
    gain.connect(destination)

    this.sourceNodes.push(source)
    if (label === 'microphone') this.micSource = source
    else this.systemSource = source

    log.debug(SCOPE, 'Connected audio input', { label, gain: gain.gain.value })

    return { gain, analyser }
  }

  /**
   * Swaps one input's device stream without interrupting the recording.
   *
   * This works because MediaRecorder is attached to the mixer's *destination*
   * node, not to the device stream. The output track's identity never changes,
   * so a microphone can drop and come back mid-recording and the encoder never
   * notices — it just hears silence for the gap.
   *
   * Returns false when the graph has no slot for this input, which happens if
   * the recording started with that source disabled entirely.
   */
  replaceInput(kind: 'microphone' | 'systemAudio', stream: MediaStream | null): boolean {
    const context = this.context
    const destination = this.destination
    if (!context || !destination) return false

    const gain = kind === 'microphone' ? this.micGain : this.systemGain
    if (!gain) return false

    // Detach the dead source first so it stops holding the old device.
    const previous = kind === 'microphone' ? this.micSource : this.systemSource
    if (previous) {
      try {
        previous.disconnect()
      } catch {
        /* already detached */
      }
      const index = this.sourceNodes.indexOf(previous)
      if (index >= 0) this.sourceNodes.splice(index, 1)
    }

    if (!stream) {
      if (kind === 'microphone') this.micSource = null
      else this.systemSource = null
      log.info(SCOPE, 'Input detached', { kind })
      return true
    }

    const source = context.createMediaStreamSource(stream)
    source.connect(gain)
    this.sourceNodes.push(source)

    if (kind === 'microphone') this.micSource = source
    else this.systemSource = source

    log.info(SCOPE, 'Input hot-swapped', { kind })
    return true
  }

  /** Applies a gain change live, without interrupting the recording. */
  setGains(gains: Partial<MixerGains>): void {
    const now = this.context?.currentTime ?? 0

    if (gains.microphone !== undefined && this.micGain) {
      // Ramp rather than jump, to avoid an audible click in the recording.
      this.micGain.gain.setTargetAtTime(clampGain(gains.microphone), now, 0.02)
    }
    if (gains.systemAudio !== undefined && this.systemGain) {
      this.systemGain.gain.setTargetAtTime(clampGain(gains.systemAudio), now, 0.02)
    }
  }

  /** Current peak levels in the 0–1 range, for the UI meters. */
  readLevels(): { microphone: number; systemAudio: number } {
    return {
      microphone: this.readLevel(this.micAnalyser),
      systemAudio: this.readLevel(this.systemAnalyser)
    }
  }

  private readLevel(analyser: AnalyserNode | null): number {
    if (!analyser) return 0

    const bins = analyser.frequencyBinCount
    if (this.levelBuffer.length !== bins) this.levelBuffer = new Uint8Array(bins)

    analyser.getByteTimeDomainData(this.levelBuffer)

    // Peak deviation from the 128 silence midpoint.
    let peak = 0
    for (let index = 0; index < bins; index += 1) {
      const sample = Math.abs((this.levelBuffer[index] ?? 128) - 128)
      if (sample > peak) peak = sample
    }
    return Math.min(1, peak / 128)
  }

  /** Tears the graph down and releases the audio hardware. */
  async dispose(): Promise<void> {
    for (const node of this.sourceNodes) {
      try {
        node.disconnect()
      } catch {
        /* already detached */
      }
    }
    this.sourceNodes.length = 0
    this.micSource = null
    this.systemSource = null

    this.micGain?.disconnect()
    this.systemGain?.disconnect()
    this.micAnalyser?.disconnect()
    this.systemAnalyser?.disconnect()

    this.micGain = null
    this.systemGain = null
    this.micAnalyser = null
    this.systemAnalyser = null

    if (this.destination) {
      for (const track of this.destination.stream.getTracks()) track.stop()
      this.destination = null
    }

    if (this.context && this.context.state !== 'closed') {
      try {
        await this.context.close()
      } catch (error) {
        log.warn(SCOPE, 'AudioContext did not close cleanly', error)
      }
    }
    this.context = null
  }
}

const clampGain = (value: number): number =>
  Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1
