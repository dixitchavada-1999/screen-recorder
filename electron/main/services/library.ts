import { app, dialog, protocol, shell, BrowserWindow } from 'electron'
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { promises as fsp } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import type { RecordingEntry } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { resolveFfmpegPath } from './ffmpeg-locator'
import {
  findEntry,
  findEntryByPath,
  hasAdoptedAppFolder,
  knownFolders,
  listEntries,
  markAppFolderAdopted,
  pathKey,
  rememberFolder,
  removeEntry,
  updateEntry,
  upsertByPath
} from './recording-catalog'
import { settingsStore } from './settings-store'

const SCOPE = 'library'

/** Private scheme used to stream recordings into the renderer's video element. */
export const RECORDING_SCHEME = 'app-recording'

const VIDEO_EXTENSION = '.mp4'

/* -------------------------------------------------------------------------- */
/*                                 Directories                                */
/* -------------------------------------------------------------------------- */

/**
 * The fallback recordings folder, used when no custom location is configured.
 *
 * Recordings deliberately are NOT written next to the executable: on Windows
 * that is `Program Files`, which needs administrator rights. `userData` is the
 * per-user equivalent, always writable, and survives reinstalls.
 */
export function defaultLibraryDirectory(): string {
  return join(app.getPath('userData'), 'Recordings')
}

/**
 * The folder new recordings are written to.
 *
 * `storage.outputFolder` wins when set — that is how a machine with a full
 * system drive keeps captures on another disk. An unusable custom folder (an
 * unplugged external drive, a revoked network share) falls back to the default
 * rather than failing the recording, since footage matters more than location.
 *
 * Note this is only where *new* files land. The library itself spans every
 * folder in the catalog, so changing this never hides what is already there.
 */
export function libraryDirectory(): string {
  const configured = settingsStore.get().storage.outputFolder?.trim()

  if (configured) {
    try {
      mkdirSync(configured, { recursive: true })
      return configured
    } catch (error) {
      logger.error(SCOPE, 'Configured recordings folder is unusable, using the default', {
        folder: configured,
        error
      })
    }
  }

  const fallback = defaultLibraryDirectory()
  mkdirSync(fallback, { recursive: true })
  return fallback
}

/* -------------------------------------------------------------------------- */
/*                               Folder sidecar                               */
/* -------------------------------------------------------------------------- */

const FOLDER_INDEX_FILE = 'library.json'

/**
 * Per-folder record of the files this app put there.
 *
 * It serves two purposes. It is the receipt that says "these videos are ours",
 * which is what stops a scan of a shared folder like Downloads from swallowing
 * every unrelated video in it. And it is the backup the catalog is rebuilt from
 * if the catalog file is ever lost.
 *
 * The format is deliberately the one older builds wrote, so an existing library
 * is picked up without a conversion step.
 */
interface FolderIndexEntry {
  durationMs?: number | null
  width?: number | null
  height?: number | null
  createdAt?: number
  note?: string
}

type FolderIndex = Record<string, FolderIndexEntry>

function readFolderIndex(directory: string): FolderIndex {
  try {
    const file = join(directory, FOLDER_INDEX_FILE)
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8')) as FolderIndex
  } catch (error) {
    logger.debug(SCOPE, 'Ignoring an unreadable folder index', { directory, error })
    return {}
  }
}

function writeFolderIndex(directory: string, index: FolderIndex): void {
  try {
    const file = join(directory, FOLDER_INDEX_FILE)
    const temp = `${file}.tmp`
    // Write then rename, so a crash mid-write cannot corrupt the sidecar.
    writeFileSync(temp, JSON.stringify(index, null, 2), 'utf8')
    renameSync(temp, file)
  } catch (error) {
    logger.warn(SCOPE, 'Could not update the folder index', { directory, error })
  }
}

/** Records, in the destination folder, that this file belongs to the app. */
function claimInFolder(filePath: string, meta: FolderIndexEntry): void {
  const directory = dirname(filePath)
  const index = readFolderIndex(directory)

  index[basename(filePath)] = { ...index[basename(filePath)], ...meta }
  writeFolderIndex(directory, index)
}

function releaseFromFolder(filePath: string): void {
  const directory = dirname(filePath)
  const index = readFolderIndex(directory)

  if (!(basename(filePath) in index)) return

  delete index[basename(filePath)]
  writeFolderIndex(directory, index)
}

/* -------------------------------------------------------------------------- */
/*                                 Thumbnails                                 */
/* -------------------------------------------------------------------------- */

const LEGACY_THUMBNAIL_SUFFIX = '.thumb.jpg'

/**
 * Poster frames live in one cache keyed by recording id.
 *
 * They used to sit next to the video, which no longer works now that recordings
 * can be spread across several folders — and it kept scattering derived files
 * into folders the user browses.
 */
function thumbnailCacheDirectory(): string {
  const dir = join(app.getPath('userData'), 'Thumbnails')
  mkdirSync(dir, { recursive: true })
  return dir
}

function thumbnailPathFor(id: string): string {
  return join(thumbnailCacheDirectory(), `${id}.jpg`)
}

/**
 * Extracts a single poster frame with FFmpeg, once per recording.
 *
 * Seeking to one second avoids the black frame most captures start on. Failures
 * are swallowed — a missing thumbnail degrades to a placeholder tile and must
 * never stop the library from listing.
 */
async function ensureThumbnail(id: string, videoPath: string): Promise<string | null> {
  const target = thumbnailPathFor(id)
  if (existsSync(target)) return target

  // Adopt the poster frame an older build left beside the video rather than
  // spending an FFmpeg run to reproduce it.
  const legacy = videoPath.replace(/\.mp4$/i, LEGACY_THUMBNAIL_SUFFIX)
  if (existsSync(legacy)) {
    try {
      await fsp.copyFile(legacy, target)
      return target
    } catch (error) {
      logger.debug(SCOPE, 'Could not adopt a legacy thumbnail', { legacy, error })
    }
  }

  const binary = await resolveFfmpegPath()
  if (!binary) return null

  try {
    await new Promise<void>((resolveDone, reject) => {
      const child = spawn(
        binary,
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-ss', '1',
          '-i', videoPath,
          '-frames:v', '1',
          '-vf', 'scale=480:-2',
          '-q:v', '4',
          target
        ],
        { windowsHide: true }
      )
      child.on('error', reject)
      child.on('close', (code) => (code === 0 ? resolveDone() : reject(new Error(`exit ${code}`))))
    })

    return existsSync(target) ? target : null
  } catch (error) {
    logger.debug(SCOPE, 'Could not generate a thumbnail', { videoPath, error })
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*                                Registration                                */
/* -------------------------------------------------------------------------- */

/** Catalogues a newly saved recording and returns its id. */
export function registerRecording(
  filePath: string,
  meta: { durationMs: number | null; width: number | null; height: number | null }
): string {
  rememberFolder(dirname(filePath))

  const createdAt = Date.now()
  const { entry } = upsertByPath(filePath, {
    createdAt,
    durationMs: meta.durationMs,
    width: meta.width,
    height: meta.height
  })

  // Claim the file where it sits, so the folder itself carries proof of what
  // belongs to the app even if the catalog is later lost.
  claimInFolder(filePath, {
    createdAt,
    durationMs: meta.durationMs,
    width: meta.width,
    height: meta.height
  })

  return entry.id
}

/** Attaches or clears a recording's note. */
export function setRecordingNote(id: string, note: string): void {
  const entry = findEntry(id)
  if (!entry) {
    throw new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'That recording is no longer in the library.')
  }

  const trimmed = note.trim()
  updateEntry(id, { note: trimmed })
  claimInFolder(entry.path, { note: trimmed })

  logger.info(SCOPE, 'Note updated', { id, cleared: !trimmed })
}

/* -------------------------------------------------------------------------- */
/*                                  Listing                                   */
/* -------------------------------------------------------------------------- */

/**
 * Adopts recordings found on disk that the catalog does not know about.
 *
 * Only files this app recorded are ever adopted, and the proof is the folder's
 * `library.json` sidecar: no claim, no entry. Videos the user happens to keep in
 * the same folder — Downloads and Desktop are full of them — stay out of the
 * library entirely.
 *
 * The single exception is a one-time sweep of the app's own folder, for
 * recordings made before claims existed. Everything in that folder was put
 * there by the app, so the sweep cannot pick up anything foreign, and it runs
 * once: after it, that folder is treated exactly like any other.
 */
async function performScan(): Promise<void> {
  const seen = new Set<string>()

  /*
   * The app-managed folder is always scanned, even when the user has moved on
   * to a custom one. It is where every build before the catalog wrote, so this
   * is what carries an existing library across the upgrade.
   */
  const folders = [libraryDirectory(), defaultLibraryDirectory(), ...knownFolders()]

  for (const folder of folders) {
    const key = pathKey(folder)
    if (seen.has(key)) continue
    seen.add(key)

    let names: string[]
    try {
      names = await fsp.readdir(folder)
    } catch {
      // A folder that is gone (unplugged drive, deleted) is not an error: its
      // recordings simply list as unavailable.
      continue
    }

    const claimed = readFolderIndex(folder)

    /*
     * Pre-claim recordings in the app's own folder, once, so upgrading from a
     * build that never wrote sidecars does not empty the list.
     *
     * Skipped the moment that folder has a sidecar of its own: an existing
     * claim list is the app's own record of what it put there, and it is more
     * precise than assuming everything in the folder is ours.
     */
    const sweepAppFolder =
      key === pathKey(defaultLibraryDirectory()) &&
      !hasAdoptedAppFolder() &&
      Object.keys(claimed).length === 0

    for (const name of names) {
      if (extname(name).toLowerCase() !== VIDEO_EXTENSION) continue

      const filePath = join(folder, name)
      if (findEntryByPath(filePath)) continue

      const meta = claimed[name]
      if (!meta && !sweepAppFolder) continue

      let createdAt = meta?.createdAt
      if (!createdAt) {
        try {
          const stats = await fsp.stat(filePath)
          if (!stats.isFile()) continue
          createdAt = stats.birthtimeMs || stats.mtimeMs
        } catch {
          continue
        }
      }

      const { created } = upsertByPath(filePath, {
        createdAt,
        durationMs: meta?.durationMs ?? null,
        width: meta?.width ?? null,
        height: meta?.height ?? null,
        note: meta?.note ?? ''
      })

      // Leave a claim behind, so from here on this file is recognised by the
      // same rule as everything else rather than by where it happens to sit.
      if (!meta) claimInFolder(filePath, { createdAt })

      if (created) logger.info(SCOPE, 'Adopted a recording found on disk', { filePath })
    }

    if (sweepAppFolder) markAppFolderAdopted()
  }
}

/** In-flight scan, so concurrent listings share one pass over the disk. */
let activeScan: Promise<void> | null = null

function scanKnownFolders(): Promise<void> {
  if (!activeScan) {
    activeScan = performScan().finally(() => {
      activeScan = null
    })
  }
  return activeScan
}

/**
 * Every recording the app knows about, newest first.
 *
 * Entries whose file has gone missing are still returned, flagged unavailable,
 * so the user can remove them deliberately instead of watching them vanish.
 */
export async function listRecordings(): Promise<RecordingEntry[]> {
  rememberFolder(defaultLibraryDirectory())
  rememberFolder(libraryDirectory())
  await scanKnownFolders()

  const entries: RecordingEntry[] = []

  for (const entry of listEntries()) {
    let sizeBytes = 0
    let available = false

    try {
      const stats = await fsp.stat(entry.path)
      available = stats.isFile()
      sizeBytes = stats.size
    } catch {
      /* missing — reported as unavailable below */
    }

    const thumbnail = available ? await ensureThumbnail(entry.id, entry.path) : null

    entries.push({
      id: entry.id,
      fileName: basename(entry.path),
      filePath: entry.path,
      available,
      playbackUrl: `${RECORDING_SCHEME}://media/${entry.id}`,
      thumbnailUrl: thumbnail ? `${RECORDING_SCHEME}://thumb/${entry.id}` : null,
      sizeBytes,
      createdAt: entry.createdAt,
      durationMs: entry.durationMs,
      width: entry.width,
      height: entry.height,
      note: entry.note
    })
  }

  return entries
}

/* -------------------------------------------------------------------------- */
/*                                  Mutations                                 */
/* -------------------------------------------------------------------------- */

function requireEntry(id: string): { id: string; path: string } {
  const entry = findEntry(id)
  if (!entry) {
    throw new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'That recording is no longer in the library.')
  }
  return entry
}

export async function deleteRecording(id: string): Promise<void> {
  const entry = requireEntry(id)

  // Send to the recycle bin where possible, so a mistap is recoverable.
  try {
    await shell.trashItem(entry.path)
  } catch {
    await fsp.unlink(entry.path).catch(() => undefined)
  }

  // Derived data goes with the video, in both the old and the new location.
  await fsp.unlink(thumbnailPathFor(id)).catch(() => undefined)
  await fsp
    .unlink(entry.path.replace(/\.mp4$/i, LEGACY_THUMBNAIL_SUFFIX))
    .catch(() => undefined)

  removeEntry(id)
  releaseFromFolder(entry.path)

  logger.info(SCOPE, 'Recording deleted', { id, path: entry.path })
}

/**
 * Drops a recording from the list without touching the disk.
 *
 * The way out for an entry whose file was moved or deleted outside the app —
 * deleting is not an option when there is nothing left to delete.
 */
export async function forgetRecording(id: string): Promise<void> {
  removeEntry(id)
  await fsp.unlink(thumbnailPathFor(id)).catch(() => undefined)
  logger.info(SCOPE, 'Recording removed from the list', { id })
}

/** Copies a recording to a location the user picks. Returns null if cancelled. */
export async function exportRecording(id: string): Promise<string | null> {
  const entry = requireEntry(id)

  if (!existsSync(entry.path)) {
    throw new AppError(
      ERROR_CODES.SESSION_NOT_FOUND,
      'That file is no longer where the app left it.',
      'Remove it from the list, or put the file back and refresh.'
    )
  }

  const parent = BrowserWindow.getAllWindows()[0]
  const options: Electron.SaveDialogOptions = {
    title: 'Save recording',
    defaultPath: join(app.getPath('downloads'), basename(entry.path)),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }]
  }

  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)

  if (result.canceled || !result.filePath) return null

  await fsp.copyFile(entry.path, result.filePath)
  logger.info(SCOPE, 'Recording exported', { id, to: result.filePath })

  return result.filePath
}

export async function openLibraryFolder(): Promise<void> {
  const error = await shell.openPath(libraryDirectory())
  if (error) throw new Error(error)
}

/* -------------------------------------------------------------------------- */
/*                              Storage location                              */
/* -------------------------------------------------------------------------- */

/** Fails loudly if a folder cannot be created or written to. */
async function assertWritable(folder: string): Promise<void> {
  try {
    await fsp.mkdir(folder, { recursive: true })
    await fsp.access(folder, fsConstants.W_OK)
  } catch (error) {
    throw new AppError(
      ERROR_CODES.OUTPUT_NOT_WRITABLE,
      `That folder cannot be written to: ${folder}`,
      'Pick a folder you own, such as one inside your user profile or on a data drive.',
      { cause: error }
    )
  }
}

/**
 * Asks the user where recordings should be stored.
 *
 * The folder is validated here rather than at the next recording, so a bad
 * choice is rejected while the user is still looking at the picker instead of
 * an hour later when a capture fails to save.
 */
export async function chooseLibraryFolder(): Promise<string | null> {
  const parent = BrowserWindow.getAllWindows()[0]
  const options: Electron.OpenDialogOptions = {
    title: 'Choose where recordings are saved',
    defaultPath: libraryDirectory(),
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory']
  }

  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  const folder = result.canceled ? undefined : result.filePaths[0]
  if (!folder) return null

  await assertWritable(folder)
  logger.info(SCOPE, 'Recordings folder selected', { folder })

  return folder
}

/* -------------------------------------------------------------------------- */
/*                             Playback protocol                              */
/* -------------------------------------------------------------------------- */

/**
 * Must run before `app.whenReady()`.
 *
 * `stream: true` is what lets a <video> element seek: without it Chromium
 * refuses to issue range requests against the scheme.
 */
export function registerRecordingScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RECORDING_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    }
  ])
}

/**
 * Serves recordings to the renderer with HTTP range support.
 *
 * URLs carry a catalog id, never a path. That is the security boundary now that
 * recordings can live anywhere on disk: the renderer can only ever reach a file
 * the app itself catalogued, and a crafted URL resolves to nothing.
 *
 * Ranges are handled explicitly rather than delegating to `net.fetch(file://)`
 * because seeking in a long video depends on 206 responses, and only the
 * requested slice should ever be read off disk.
 */
export function handleRecordingProtocol(): void {
  protocol.handle(RECORDING_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const entry = id ? findEntry(id) : undefined
      if (!entry) return new Response('Not found', { status: 404 })

      const isImage = url.hostname === 'thumb'
      const filePath = isImage ? thumbnailPathFor(entry.id) : entry.path
      const stats = await fsp.stat(filePath)

      const range = request.headers.get('Range')
      const headers: Record<string, string> = {
        'Content-Type': isImage ? 'image/jpeg' : 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
      }

      if (!range) {
        return new Response(toWebStream(createReadStream(filePath)), {
          status: 200,
          headers: { ...headers, 'Content-Length': String(stats.size) }
        })
      }

      const match = /bytes=(\d*)-(\d*)/.exec(range)
      const start = match?.[1] ? Number(match[1]) : 0
      const end = match?.[2] ? Number(match[2]) : stats.size - 1

      if (Number.isNaN(start) || start >= stats.size) {
        return new Response('Range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${stats.size}` }
        })
      }

      const last = Math.min(end, stats.size - 1)

      return new Response(toWebStream(createReadStream(filePath, { start, end: last })), {
        status: 206,
        headers: {
          ...headers,
          'Content-Range': `bytes ${start}-${last}/${stats.size}`,
          'Content-Length': String(last - start + 1)
        }
      })
    } catch (error) {
      logger.warn(SCOPE, 'Playback request failed', { url: request.url, error })
      return new Response('Not found', { status: 404 })
    }
  })

  logger.info(SCOPE, 'Recording playback protocol registered', {
    scheme: RECORDING_SCHEME,
    directory: libraryDirectory()
  })
}

/** Node stream -> web stream, the shape `Response` expects. */
function toWebStream(stream: ReturnType<typeof createReadStream>): ReadableStream {
  return Readable.toWeb(stream) as ReadableStream
}
