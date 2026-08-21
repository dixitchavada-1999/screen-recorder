import { log } from './ipc'

const SCOPE = 'audio-devices'

export interface AudioInputDevice {
  deviceId: string
  label: string
  /**
   * True when the device looks like a system-audio loopback rather than a real
   * microphone (PulseAudio/PipeWire monitor sources, virtual cables).
   */
  isLoopbackMonitor: boolean
}

/**
 * Patterns that identify a loopback/monitor input rather than a real
 * microphone, across all three platforms:
 *
 *  - Linux    PulseAudio/PipeWire monitor sources
 *  - Windows  Stereo Mix and the popular virtual-cable drivers
 *  - macOS    the virtual audio devices users install because the OS ships no
 *             loopback of its own; BlackHole is the common free one, with
 *             Loopback, Soundflower and iShowU Audio close behind
 *
 * Getting a device into this list matters twice over: it keeps a loopback out
 * of the microphone picker, and it is the only way one reaches the system-audio
 * picker at all.
 */
const MONITOR_PATTERNS = [
  /\bmonitor\b/i,
  /\bloopback\b/i,
  /stereo mix/i,
  /what u hear/i,
  /\bvb-audio\b/i,
  /virtual cable/i,
  /\bblackhole\b/i,
  /soundflower/i,
  /ishowu/i,
  /\bmulti-output\b/i,
  /aggregate device/i
]

const isMonitorLabel = (label: string): boolean =>
  MONITOR_PATTERNS.some((pattern) => pattern.test(label))

/**
 * Enumerates audio inputs.
 *
 * Device labels are only populated once the page holds an active microphone
 * permission, so a short-lived probe stream is opened first when necessary.
 * Without it every device would come back as an empty string.
 */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  await ensureLabelsAvailable()

  const devices = await navigator.mediaDevices.enumerateDevices()

  return devices
    .filter((device) => device.kind === 'audioinput')
    .map((device, index) => {
      const label = device.label || fallbackLabel(device.deviceId, index)
      return {
        deviceId: device.deviceId,
        label,
        isLoopbackMonitor: isMonitorLabel(label)
      }
    })
}

/** Convenience split used by the settings UI. */
export async function listAudioInputsGrouped(): Promise<{
  microphones: AudioInputDevice[]
  monitors: AudioInputDevice[]
}> {
  const all = await listAudioInputs()
  return {
    microphones: all.filter((device) => !device.isLoopbackMonitor),
    monitors: all.filter((device) => device.isLoopbackMonitor)
  }
}

let labelsProbed = false

async function ensureLabelsAvailable(): Promise<void> {
  if (labelsProbed) return

  const devices = await navigator.mediaDevices.enumerateDevices()
  const hasLabels = devices.some((device) => device.kind === 'audioinput' && device.label)
  if (hasLabels) {
    labelsProbed = true
    return
  }

  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of probe.getTracks()) track.stop()
    labelsProbed = true
  } catch (error) {
    // No microphone, or permission denied. Enumeration still returns ids.
    log.warn(SCOPE, 'Could not obtain device labels', error)
  }
}

function fallbackLabel(deviceId: string, index: number): string {
  if (deviceId === 'default') return 'System default'
  if (deviceId === 'communications') return 'Communications device'
  return `Audio input ${index + 1}`
}

/* -------------------------------------------------------------------------- */
/*                              Stream acquisition                            */
/* -------------------------------------------------------------------------- */

/**
 * Opens the microphone.
 *
 * Echo cancellation and auto-gain are disabled by default: they are tuned for
 * voice calls and audibly degrade a screencast's narration. Noise suppression
 * follows the user's experimental setting.
 */
export async function openMicrophone(
  deviceId: string | null,
  options: { noiseSuppression: boolean }
): Promise<MediaStream> {
  /*
   * Deliberately minimal constraints.
   *
   * `sampleRate` and `channelCount` are NOT requested: a Bluetooth headset mic
   * runs mono at 16 kHz over HFP, and asking it for 48 kHz stereo makes
   * Chromium reject the device outright with NotFoundError even though the
   * microphone works perfectly. The Web Audio mixer resamples everything to
   * 48 kHz stereo anyway, so constraining here buys nothing and only breaks
   * legitimate hardware.
   */
  const preferred: MediaStreamConstraints = {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: options.noiseSuppression
    },
    video: false
  }

  try {
    return await navigator.mediaDevices.getUserMedia(preferred)
  } catch (error) {
    const name = error instanceof Error ? error.name : ''

    // A specific device that has been unplugged or taken by another
    // application — fall back to whatever the system considers default.
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      log.warn(SCOPE, 'Preferred microphone unavailable, using system default', { deviceId })
      return openMicrophone(null, options)
    }

    // Last resort: drop every processing hint. Some drivers refuse a request
    // that disables their echo canceller, but accept a bare audio request.
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
      log.warn(SCOPE, 'Constrained microphone request failed, retrying unconstrained', error)
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    }

    throw error
  }
}

/** True when the system exposes at least one audio input device. */
export async function hasAnyMicrophone(): Promise<boolean> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.some((device) => device.kind === 'audioinput' && !isMonitorLabel(device.label))
}

/**
 * Opens a loopback/monitor input as a system-audio source.
 *
 * This is the macOS and Linux path: Chromium captures desktop loopback on
 * Windows only. Elsewhere the loopback arrives as an ordinary input device — a
 * PulseAudio `.monitor` source on Linux, a virtual device such as BlackHole on
 * macOS — and is opened like any other microphone.
 */
export async function openLoopbackInput(deviceId: string): Promise<MediaStream> {
  // As with the microphone, no sample-rate or channel-count constraints — the
  // mixer normalises both, and over-constraining only rejects working devices.
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: deviceId },
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false
    },
    video: false
  })
}

/** Picks the monitor device to use when the user has not chosen one. */
export async function findDefaultMonitorDevice(): Promise<AudioInputDevice | null> {
  const { monitors } = await listAudioInputsGrouped()
  return monitors[0] ?? null
}
