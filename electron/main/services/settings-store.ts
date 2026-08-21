import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  FPS_OPTIONS,
  QUALITY_ORDER,
  RESOLUTION_ORDER,
  SETTINGS_SCHEMA_VERSION
} from '@shared/presets'
import type { AppSettings } from '@shared/types'
import type { DeepPartial } from '@shared/api'
import { logger } from '../lib/logger'

const SCOPE = 'settings'

/**
 * Persistent application settings backed by a JSON file in `userData`.
 *
 * Writes are atomic (temp file + rename) so a crash mid-save cannot leave the
 * user with an unreadable settings file.
 */
class SettingsStore extends EventEmitter {
  private filePath = ''
  private cache: AppSettings = structuredClone(DEFAULT_SETTINGS)
  private saveTimer: NodeJS.Timeout | null = null
  /** True when the file on disk predates this build's schema. */
  private migrated = false

  init(): void {
    this.filePath = join(app.getPath('userData'), 'settings.json')
    this.cache = this.load()

    // Write the migrated shape back straight away. Otherwise the old file stays
    // on disk and every launch re-runs the migration against it, which would
    // undo a setting the user changed and never saved.
    if (this.migrated) this.persistNow()

    logger.info(SCOPE, 'Settings loaded', { path: this.filePath })
  }

  get(): AppSettings {
    return structuredClone(this.cache)
  }

  update(patch: DeepPartial<AppSettings>): AppSettings {
    this.cache = sanitize(deepMerge(this.cache, patch))
    this.scheduleSave()
    this.emit('changed', this.get())
    return this.get()
  }

  reset(): AppSettings {
    this.cache = structuredClone(DEFAULT_SETTINGS)
    this.scheduleSave()
    this.emit('changed', this.get())
    logger.info(SCOPE, 'Settings reset to defaults')
    return this.get()
  }

  /** Flushes any pending debounced write. Called during shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.persistNow()
  }

  private load(): AppSettings {
    if (!existsSync(this.filePath)) return structuredClone(DEFAULT_SETTINGS)

    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<AppSettings>
      const merged = sanitize(deepMerge(structuredClone(DEFAULT_SETTINGS), raw))
      this.migrated = raw.schemaVersion !== SETTINGS_SCHEMA_VERSION
      return migrate(merged)
    } catch (error) {
      logger.warn(SCOPE, 'Settings file unreadable, falling back to defaults', error)
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  /** Debounced so slider drags do not hammer the disk. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persistNow()
    }, 250)
  }

  private persistNow(): void {
    if (!this.filePath) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tempPath = `${this.filePath}.tmp`
      writeFileSync(tempPath, JSON.stringify(this.cache, null, 2), 'utf8')
      renameSync(tempPath, this.filePath)
    } catch (error) {
      logger.error(SCOPE, 'Failed to persist settings', error)
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Recursively merges `patch` into a clone of `base`. */
function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base

  const result = structuredClone(base) as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isPlainObject(value) && isPlainObject(current)
      ? deepMerge(current, value)
      : value
  }
  return result as T
}

const clamp = (value: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback

/**
 * Coerces untrusted values (hand-edited files, stale schemas) back into range
 * so the recording pipeline never receives a nonsensical configuration.
 */
function sanitize(settings: AppSettings): AppSettings {
  const next = settings

  if (!RESOLUTION_ORDER.includes(next.video.resolution)) {
    next.video.resolution = DEFAULT_SETTINGS.video.resolution
  }
  if (!FPS_OPTIONS.includes(next.video.fps)) {
    next.video.fps = DEFAULT_SETTINGS.video.fps
  }
  if (!QUALITY_ORDER.includes(next.video.quality)) {
    next.video.quality = DEFAULT_SETTINGS.video.quality
  }

  next.audio.microphoneGain = clamp(next.audio.microphoneGain, 0, 2, 1)
  next.audio.systemAudioGain = clamp(next.audio.systemAudioGain, 0, 2, 1)

  if (typeof next.storage.filenamePattern !== 'string' || !next.storage.filenamePattern.trim()) {
    next.storage.filenamePattern = DEFAULT_SETTINGS.storage.filenamePattern
  }

  // Hand-edited or stale files can hold anything here; the reminder scheduler
  // turns each entry into a timer, so a duplicate or a negative would mean a
  // repeated or an immediately-overdue notification.
  const leads = Array.isArray(next.notifications.leadMinutes)
    ? next.notifications.leadMinutes
    : DEFAULT_SETTINGS.notifications.leadMinutes

  next.notifications.leadMinutes = [
    ...new Set(
      leads
        .map((value) => Math.round(Number(value)))
        .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1440)
    )
  ].sort((a, b) => b - a)

  /*
   * Tracking bounds.
   *
   * The interval drives a timer and the idle threshold decides whether a
   * screenshot is taken at all, so a zero or a negative from a hand-edited file
   * would mean a screenshot every tick. The floor is a minute and the ceiling
   * four hours — outside that it is not the feature that was described.
   */
  next.tracking.screenshotIntervalMinutes = Math.round(
    clamp(next.tracking.screenshotIntervalMinutes, 1, 240, 10)
  )
  next.tracking.idleAfterSeconds = Math.round(clamp(next.tracking.idleAfterSeconds, 30, 3600, 300))

  // A blank string would otherwise read as "save to the current directory".
  // Anything that is not a usable path collapses back to the managed default.
  const folder = next.storage.outputFolder
  next.storage.outputFolder =
    typeof folder === 'string' && folder.trim() ? folder.trim() : null

  return next
}

/** Applies forward migrations when the persisted schema predates this build. */
function migrate(settings: AppSettings): AppSettings {
  if (settings.schemaVersion === SETTINGS_SCHEMA_VERSION) return settings

  logger.info(SCOPE, 'Migrating settings', {
    from: settings.schemaVersion,
    to: SETTINGS_SCHEMA_VERSION
  })

  if (settings.schemaVersion < 2) {
    // v1 files can still carry an `outputFolder` from before recordings moved
    // into the managed library, when it meant "where to drop the MP4". It now
    // means "this folder IS the library", so honouring a stale value would make
    // the Recordings page list — and offer to delete — every video in whatever
    // folder was configured years ago. Opting back in is one click in Settings.
    settings.storage.outputFolder = null
  }

  if (settings.schemaVersion < 4) {
    /*
     * Activity tracking arrives switched off, whatever the file says.
     *
     * The defaults merge would already do that for a file that predates the
     * section, but saying it here makes the rule explicit and survives someone
     * later changing what the default is: an update must never be the reason a
     * machine started tracking. Turning it on is a decision, taken once, with
     * the disclosure in front of the person taking it.
     */
    settings.tracking.enabled = false
  }

  settings.schemaVersion = SETTINGS_SCHEMA_VERSION
  return settings
}

export const settingsStore = new SettingsStore()
