import type {
  AppSettings,
  FpsPreset,
  QualityPreset,
  ResolutionPreset
} from './types'

/* -------------------------------------------------------------------------- */
/*                              Resolution presets                            */
/* -------------------------------------------------------------------------- */

export interface ResolutionDefinition {
  label: string
  /** `null` for `native`, which means "do not constrain or rescale". */
  width: number | null
  height: number | null
}

export const RESOLUTIONS: Record<ResolutionPreset, ResolutionDefinition> = {
  native: { label: 'Native (source size)', width: null, height: null },
  '720p': { label: '720p / 1280 x 720', width: 1280, height: 720 },
  '1080p': { label: '1080p / 1920 x 1080', width: 1920, height: 1080 },
  '1440p': { label: '1440p / 2560 x 1440', width: 2560, height: 1440 },
  '2160p': { label: '4K / 3840 x 2160', width: 3840, height: 2160 }
}

export const RESOLUTION_ORDER: ResolutionPreset[] = [
  'native',
  '720p',
  '1080p',
  '1440p',
  '2160p'
]

export const FPS_OPTIONS: FpsPreset[] = [24, 30, 60]

/* -------------------------------------------------------------------------- */
/*                                Quality tiers                               */
/* -------------------------------------------------------------------------- */

export interface QualityDefinition {
  label: string
  description: string
  /** Constant Rate Factor handed to libx264 (lower = better quality). */
  crf: number
  /** x264 speed/compression preset. */
  x264Preset: string
  /** Multiplier applied to the resolution's base bitrate. */
  bitrateFactor: number
  /** Audio bitrate in kbps for the AAC track. */
  audioKbps: number
}

export const QUALITIES: Record<QualityPreset, QualityDefinition> = {
  low: {
    label: 'Low / smallest files',
    description: 'Best for long sessions and slower machines.',
    crf: 28,
    x264Preset: 'veryfast',
    bitrateFactor: 0.5,
    audioKbps: 96
  },
  balanced: {
    label: 'Balanced / recommended',
    description: 'Good quality at a moderate file size and CPU cost.',
    crf: 23,
    x264Preset: 'veryfast',
    bitrateFactor: 1,
    audioKbps: 128
  },
  high: {
    label: 'High / sharp text',
    description: 'Recommended when recording code or fine UI detail.',
    crf: 20,
    x264Preset: 'medium',
    bitrateFactor: 1.6,
    audioKbps: 192
  },
  ultra: {
    label: 'Ultra / near lossless',
    description: 'Largest files. Use for footage you intend to edit further.',
    crf: 17,
    x264Preset: 'slow',
    bitrateFactor: 2.4,
    audioKbps: 256
  }
}

export const QUALITY_ORDER: QualityPreset[] = ['low', 'balanced', 'high', 'ultra']

/** Base video bitrate in kbps at 30 fps, per resolution tier. */
const BASE_BITRATE_KBPS: Record<ResolutionPreset, number> = {
  native: 8000,
  '720p': 3000,
  '1080p': 6000,
  '1440p': 10000,
  '2160p': 20000
}

/**
 * Computes the video bitrate for a resolution/fps/quality combination.
 * Frame rate scales sub-linearly because temporal redundancy rises with fps.
 */
export function computeVideoBitrateKbps(
  resolution: ResolutionPreset,
  fps: FpsPreset,
  quality: QualityPreset
): number {
  const base = BASE_BITRATE_KBPS[resolution]
  const fpsFactor = 1 + ((fps - 30) / 30) * 0.5
  const value = base * Math.max(fpsFactor, 0.8) * QUALITIES[quality].bitrateFactor
  return Math.round(value)
}

/* -------------------------------------------------------------------------- */
/*                              Default settings                              */
/* -------------------------------------------------------------------------- */

export const SETTINGS_SCHEMA_VERSION = 5

/** Lead times the Call Manager settings offer, longest first. */
export const REMINDER_LEAD_OPTIONS = [30, 15, 5, 0] as const

/**
 * `storage.outputFolder` is `null` here rather than a path: the app-managed
 * default lives under `userData`, which shared code cannot resolve. The main
 * process substitutes it whenever the value is null.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  video: {
    resolution: '1080p',
    fps: 30,
    quality: 'balanced',
    hardwareAcceleration: true,
    captureCursor: true
  },
  audio: {
    microphoneEnabled: true,
    microphoneDeviceId: null,
    microphoneGain: 1,
    systemAudioEnabled: true,
    systemAudioDeviceId: null,
    systemAudioGain: 1
  },
  storage: {
    filenamePattern: 'Recording_{date}_{time}',
    outputFolder: null,
    keepIntermediateFile: false
  },
  notifications: {
    enabled: true,
    // The three the Call Manager was asked for. `0` (at the start) is offered
    // in Settings but off by default — by then the reminder is the call.
    leadMinutes: [30, 15, 5],
    systemNotifications: true,
    inAppNotifications: true
  },
  startup: {
    // On for every install: this is a managed tracking deployment, so the app
    // runs in the tray from boot on every device. Enforced on each launch by
    // the main process regardless of this value; kept here so the model agrees.
    openAtLogin: true,
    // Off by default: the app lives in the tray and keeps no taskbar button.
    showInTaskbar: false
  },
  shortcuts: {
    /*
     * Works with the window closed and somebody else's application in front —
     * which is the point: the moment worth recording is usually one where this
     * app is the last thing on screen.
     *
     * Ctrl+Space is what was asked for, and it is worth knowing what it costs:
     * Windows uses it to switch input methods, and most editors use it for
     * autocomplete. Registering it here takes it from all of them. It is a
     * setting rather than a constant so that can be undone without a release.
     */
    toggleRecording: 'Control+Space'
  },
  tracking: {
    // Off. A tracker that arrives already running is the thing this design
    // refuses to be; switching it on is a deliberate act, taken once.
    enabled: false,
    screenshotIntervalMinutes: 10,
    // Five minutes untouched before the timeline calls it idle. Long enough to
    // survive reading a document without flipping state every other minute.
    // Capture continues either way.
    idleAfterSeconds: 300
  },
  experimental: {
    webcamOverlay: {
      enabled: false,
      deviceId: null,
      position: 'bottom-right',
      size: 25
    },
    cursorHighlight: { enabled: false, color: '#facc15', radius: 40 },
    clickEffects: { enabled: false },
    noiseSuppression: false
  },
  schemaVersion: SETTINGS_SCHEMA_VERSION
}

/* -------------------------------------------------------------------------- */
/*                                  Filenames                                 */
/* -------------------------------------------------------------------------- */

const pad = (value: number): string => String(value).padStart(2, '0')

/** Characters that are illegal in Windows filenames. */
const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*]/g
const WHITESPACE = /\s+/g
const REPEATED_UNDERSCORES = /_{2,}/g
const EDGE_PUNCTUATION = /^[._]+|[._]+$/g

/**
 * Expands a filename template into a safe, extension-less base name.
 *
 * Tokens: `{date}` -> 2026-07-27, `{time}` -> 15-30-00, `{timestamp}` -> epoch ms.
 * Hyphens are preserved because the date and time tokens rely on them.
 */
export function buildFileBaseName(pattern: string, when: Date): string {
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
  const time = `${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`

  const expanded = (pattern || DEFAULT_SETTINGS.storage.filenamePattern)
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{timestamp\}/g, String(when.getTime()))

  const safe = expanded
    .replace(ILLEGAL_FILENAME_CHARS, '_')
    .replace(WHITESPACE, '_')
    .replace(REPEATED_UNDERSCORES, '_')
    .replace(EDGE_PUNCTUATION, '')

  return safe.length > 0 ? safe : `Recording_${date}_${time}`
}
