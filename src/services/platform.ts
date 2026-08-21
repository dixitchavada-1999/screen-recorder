/**
 * Which OS the renderer is running on, and the platform-specific wording that
 * depends on it.
 *
 * The three platforms capture system audio in three different ways, so a single
 * message can only ever be right on one of them. Every place that has to
 * explain the situation to the user reads its text from here, so the advice
 * cannot drift apart between the Settings hint, the audio test and the warning
 * shown mid-recording.
 */

export type Platform = 'win32' | 'darwin' | 'linux' | 'unknown'

/**
 * A first guess from the user agent, so the wording is already correct on the
 * very first paint — `app:info` has not answered yet at that point.
 */
function detect(): Platform {
  const agent = navigator.userAgent
  if (agent.includes('Windows')) return 'win32'
  if (agent.includes('Macintosh') || agent.includes('Mac OS X')) return 'darwin'
  if (agent.includes('Linux') || agent.includes('X11')) return 'linux'
  return 'unknown'
}

let current: Platform = detect()

/** Applies the authoritative `process.platform` once app info has loaded. */
export function setPlatform(value: string): void {
  if (value === 'win32' || value === 'darwin' || value === 'linux') current = value
}

export const getPlatform = (): Platform => current
export const isMac = (): boolean => current === 'darwin'
export const isWindows = (): boolean => current === 'win32'
export const isLinux = (): boolean => current === 'linux'

/** Human-readable name, for messages that point at a system settings screen. */
export function platformName(): string {
  switch (current) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return 'This system'
  }
}

/* -------------------------------------------------------------------------- */
/*                              System audio help                             */
/* -------------------------------------------------------------------------- */

/** The one-line explanation shown under the system-audio device picker. */
export function systemAudioHint(): string {
  switch (current) {
    case 'win32':
      return 'Windows captures desktop audio directly; a device only needs picking if that fails.'
    case 'darwin':
      return 'macOS has no system-audio capture of its own. Install a virtual audio device — BlackHole is free — send your output through it, then choose it here.'
    case 'linux':
      return 'Linux has no desktop loopback API. Choose a "Monitor of ..." device provided by PulseAudio or PipeWire.'
    default:
      return 'Choose the input that carries your system audio.'
  }
}

/** Shown when no loopback device could be found at all. */
export function noSystemAudioDeviceMessage(): string {
  switch (current) {
    case 'darwin':
      return 'No system-audio device was found. Install BlackHole (brew install blackhole-2ch), set it as the output — or as part of a Multi-Output Device so you can still hear yourself — then pick it in Settings.'
    case 'linux':
      return 'No system-audio loopback device found. Select a "Monitor of ..." device in Settings.'
    case 'win32':
      return 'No system-audio device was found. Windows normally captures desktop audio on its own; check that something is playing through an active output device.'
    default:
      return 'No system-audio device was found. Choose one in Settings.'
  }
}

/** Shown when the OS refuses microphone access. */
export function microphoneBlockedMessage(): string {
  switch (current) {
    case 'win32':
      return 'Microphone access was blocked. Check Windows Settings → Privacy & security → Microphone, and allow desktop apps.'
    case 'darwin':
      return 'Microphone access was blocked. Allow it in System Settings → Privacy & Security → Microphone.'
    case 'linux':
      return 'Microphone access was blocked. Check that no other application holds the device, and that your user can read it.'
    default:
      return 'Microphone access was blocked.'
  }
}

/** Shown when screen capture itself is refused. */
export function screenCaptureBlockedHint(): string {
  switch (current) {
    case 'darwin':
      return 'Allow it in System Settings → Privacy & Security → Screen Recording, then quit and reopen the app.'
    case 'linux':
      return 'Allow screen capture in the system prompt, then start again. On Wayland a dismissed portal dialog looks the same.'
    default:
      return 'Allow screen capture in the system prompt, then start again.'
  }
}
