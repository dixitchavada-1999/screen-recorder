import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { logger } from '../lib/logger'

const SCOPE = 'catalog'

const CATALOG_FILE = 'recordings-index.json'
const CATALOG_VERSION = 1

/**
 * One recording, wherever it happens to live.
 *
 * The absolute path is the only link to the file, which is what lets the
 * library span several folders and survive the output folder being changed.
 */
export interface CatalogEntry {
  /** Opaque, stable for the lifetime of the recording. Used in playback URLs. */
  id: string
  /** Absolute path of the MP4. */
  path: string
  /** Epoch milliseconds the recording was produced. */
  createdAt: number
  durationMs: number | null
  width: number | null
  height: number | null
  /** Free-text note. Empty when unset. */
  note: string
}

interface CatalogFile {
  version: number
  entries: CatalogEntry[]
  /**
   * Every folder the app has stored recordings in.
   *
   * Kept so the scan keeps covering previous locations, and so an index lost to
   * disk corruption rebuilds itself from what is actually on disk.
   */
  folders: string[]
  /**
   * True once the app's own folder has been swept for recordings made before
   * per-folder claims existed. That sweep runs exactly once; afterwards every
   * folder — including this one — only yields files the app has claimed.
   */
  appFolderAdopted: boolean
}

const EMPTY: CatalogFile = {
  version: CATALOG_VERSION,
  entries: [],
  folders: [],
  appFolderAdopted: false
}

/**
 * In-memory copy of the catalog.
 *
 * The playback protocol resolves an id on every HTTP range request, and a long
 * video seek issues a lot of those — re-reading and re-parsing the JSON each
 * time would be wasteful.
 */
let cache: CatalogFile | null = null

function catalogPath(): string {
  return join(app.getPath('userData'), CATALOG_FILE)
}

function load(): CatalogFile {
  if (cache) return cache

  const file = catalogPath()
  if (!existsSync(file)) {
    cache = structuredClone(EMPTY)
    return cache
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<CatalogFile>
    cache = {
      version: CATALOG_VERSION,
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isUsableEntry) : [],
      folders: Array.isArray(parsed.folders) ? parsed.folders.filter(isNonEmptyString) : [],
      appFolderAdopted: parsed.appFolderAdopted === true
    }
  } catch (error) {
    // A corrupt catalog must not hide the recordings: the folder scan will
    // repopulate it from disk on the next listing.
    logger.error(SCOPE, 'Catalog unreadable, rebuilding from the folder scan', error)
    cache = structuredClone(EMPTY)
  }

  return cache
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isUsableEntry(value: unknown): value is CatalogEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<CatalogEntry>
  return isNonEmptyString(entry.id) && isNonEmptyString(entry.path)
}

/** Persists atomically, so a crash mid-write cannot destroy the catalog. */
function persist(): void {
  if (!cache) return

  const file = catalogPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, JSON.stringify(cache, null, 2), 'utf8')
    renameSync(temp, file)
  } catch (error) {
    logger.error(SCOPE, 'Could not persist the catalog', error)
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Identity                                  */
/* -------------------------------------------------------------------------- */

/**
 * Comparison key for a path.
 *
 * Windows paths are case-insensitive, so `D:\Videos\a.mp4` and `d:\videos\A.MP4`
 * are the same file and must not become two entries.
 */
export function pathKey(filePath: string): string {
  const absolute = resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/* -------------------------------------------------------------------------- */
/*                                   Reading                                  */
/* -------------------------------------------------------------------------- */

/** Every catalogued recording, newest first. */
export function listEntries(): CatalogEntry[] {
  return [...load().entries].sort((a, b) => b.createdAt - a.createdAt)
}

export function findEntry(id: string): CatalogEntry | undefined {
  return load().entries.find((entry) => entry.id === id)
}

export function findEntryByPath(filePath: string): CatalogEntry | undefined {
  const key = pathKey(filePath)
  return load().entries.find((entry) => pathKey(entry.path) === key)
}

/** Folders to scan: everything the app has ever written recordings to. */
export function knownFolders(): string[] {
  return [...load().folders]
}

/** Whether the one-time sweep of the app's own folder has already happened. */
export function hasAdoptedAppFolder(): boolean {
  return load().appFolderAdopted
}

export function markAppFolderAdopted(): void {
  const catalog = load()
  if (catalog.appFolderAdopted) return

  catalog.appFolderAdopted = true
  persist()
}

/* -------------------------------------------------------------------------- */
/*                                   Writing                                  */
/* -------------------------------------------------------------------------- */

export function rememberFolder(folder: string): void {
  const catalog = load()
  const key = pathKey(folder)

  if (catalog.folders.some((known) => pathKey(known) === key)) return

  catalog.folders.push(resolve(folder))
  persist()
  logger.info(SCOPE, 'Folder added to the scan list', { folder })
}

export interface EntryMetadata {
  createdAt?: number
  durationMs?: number | null
  width?: number | null
  height?: number | null
  note?: string
}

/**
 * Adds a recording, or returns the existing entry when that path is already
 * catalogued. Metadata is only filled in where the entry has none, so a rescan
 * never overwrites a note or a duration recorded at capture time.
 *
 * `created` tells the caller whether this was a genuinely new recording, which
 * matters because two concurrent scans can both decide to adopt the same file.
 */
export function upsertByPath(
  filePath: string,
  meta: EntryMetadata = {}
): { entry: CatalogEntry; created: boolean } {
  const existing = findEntryByPath(filePath)

  if (existing) {
    let changed = false

    if (existing.durationMs === null && typeof meta.durationMs === 'number') {
      existing.durationMs = meta.durationMs
      changed = true
    }
    if (existing.width === null && typeof meta.width === 'number') {
      existing.width = meta.width
      changed = true
    }
    if (existing.height === null && typeof meta.height === 'number') {
      existing.height = meta.height
      changed = true
    }
    if (!existing.note && meta.note) {
      existing.note = meta.note
      changed = true
    }

    if (changed) persist()
    return { entry: existing, created: false }
  }

  const entry: CatalogEntry = {
    id: randomUUID(),
    path: resolve(filePath),
    createdAt: meta.createdAt ?? Date.now(),
    durationMs: positiveOrNull(meta.durationMs),
    width: positiveOrNull(meta.width),
    height: positiveOrNull(meta.height),
    note: meta.note ?? ''
  }

  load().entries.push(entry)
  persist()

  return { entry, created: true }
}

/** Replaces a recording's metadata. Unknown ids are ignored. */
export function updateEntry(id: string, patch: Partial<Omit<CatalogEntry, 'id'>>): void {
  const entry = findEntry(id)
  if (!entry) return

  Object.assign(entry, patch)
  if (patch.path) entry.path = resolve(patch.path)

  persist()
}

/** Drops a recording from the catalog without touching the file on disk. */
export function removeEntry(id: string): void {
  const catalog = load()
  const before = catalog.entries.length

  catalog.entries = catalog.entries.filter((entry) => entry.id !== id)
  if (catalog.entries.length !== before) persist()
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}
