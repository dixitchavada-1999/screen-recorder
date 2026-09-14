import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  constants as fsConstants,
  createWriteStream,
  existsSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import type { WriteStream } from 'node:fs'
import { buildFileBaseName } from '@shared/presets'
import { IPC } from '@shared/ipc'
import type {
  FinalizeRequest,
  FinalizeResult,
  OrphanRecording,
  ProcessingProgress,
  SessionHandle
} from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { libraryDirectory, registerRecording } from './library'
import { settingsStore } from './settings-store'
import { VOICE_TEMP_SUFFIX, adoptVoiceTrack } from './voice-track'
import { transcodeToMp4 } from './transcoder'

const SCOPE = 'recording-session'

/**
 * Owns the lifetime of a recording's intermediate file.
 *
 * The renderer streams MediaRecorder chunks here every second and they are
 * appended straight to disk. Nothing is buffered in memory, so a three hour
 * recording costs the same RAM as a three second one — this is what makes
 * long sessions stable.
 */
interface ActiveSession {
  sessionId: string
  tempPath: string
  stream: WriteStream
  bytesWritten: number
  startedAt: number
  /** Resolves once the stream has flushed and closed. */
  closing: Promise<void> | null

  /*
   * The hard-panned audio copy, opened only if the renderer actually sends any.
   *
   * A second, much smaller stream running alongside the first. It is opened
   * lazily so a capture with no audio never leaves an empty file behind for the
   * orphan scan to find.
   */
  voicePath: string
  voiceStream: WriteStream | null
  voiceBytes: number
  voiceClosing: Promise<void> | null
  /** Set once the voice stream has failed; writes stop, the capture does not. */
  voiceFailed: boolean
}

const sessions = new Map<string, ActiveSession>()

/* -------------------------------------------------------------------------- */
/*                                   Paths                                    */
/* -------------------------------------------------------------------------- */

/** Sub-folder used for scratch files when recordings live outside `userData`. */
const TEMP_FOLDER_NAME = '.incomplete'

/** The OS scratch location, used when no custom output folder is configured. */
function systemTempDirectory(): string {
  return join(app.getPath('temp'), 'screen-recorder')
}

/**
 * Where the intermediate capture is streamed while recording.
 *
 * With a custom output folder the scratch file follows it. The raw capture is
 * as large as the finished MP4, so streaming it to `%TEMP%` would keep filling
 * the system drive even after the user moved their recordings off it — the
 * exact problem choosing another folder is meant to solve.
 */
function tempDirectory(): string {
  const custom = settingsStore.get().storage.outputFolder
  const dir = custom ? join(libraryDirectory(), TEMP_FOLDER_NAME) : systemTempDirectory()

  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Every folder that may hold intermediate files.
 *
 * Recovery has to look in the previous location too: switching the output
 * folder must not orphan a capture left behind by an earlier crash.
 */
function scratchDirectories(): string[] {
  return [...new Set([tempDirectory(), systemTempDirectory()])]
}

/** Intermediate files are named so orphans can be identified after a crash. */
const INTERMEDIATE_PREFIX = 'session-'
const INTERMEDIATE_EXT = '.webm'

function intermediatePath(sessionId: string): string {
  return join(tempDirectory(), `${INTERMEDIATE_PREFIX}${sessionId}${INTERMEDIATE_EXT}`)
}

/** The voice scratch file for a session, beside its video counterpart. */
function voiceTempPath(sessionId: string): string {
  return join(tempDirectory(), `${INTERMEDIATE_PREFIX}${sessionId}${VOICE_TEMP_SUFFIX}`)
}

/** Ensures the configured output directory exists and is writable. */
async function ensureOutputFolder(folder: string): Promise<void> {
  try {
    await fsp.mkdir(folder, { recursive: true })
    await fsp.access(folder, fsConstants.W_OK)
  } catch (error) {
    throw new AppError(
      ERROR_CODES.OUTPUT_NOT_WRITABLE,
      `The output folder is not writable: ${folder}`,
      'Pick a different folder in Settings.',
      { cause: error }
    )
  }
}

/** Appends `_1`, `_2`, ... when a file with the generated name already exists. */
function uniqueOutputPath(folder: string, baseName: string): string {
  let candidate = join(folder, `${baseName}.mp4`)
  let counter = 1

  while (existsSync(candidate)) {
    candidate = join(folder, `${baseName}_${counter}.mp4`)
    counter += 1
  }
  return candidate
}

/* -------------------------------------------------------------------------- */
/*                              Session lifecycle                             */
/* -------------------------------------------------------------------------- */

export function beginSession(): SessionHandle {
  const sessionId = randomUUID()
  const tempPath = intermediatePath(sessionId)

  const stream = createWriteStream(tempPath, { flags: 'w' })
  stream.on('error', (error) => {
    logger.error(SCOPE, 'Intermediate stream error', { sessionId, error })
  })

  const session: ActiveSession = {
    sessionId,
    tempPath,
    stream,
    bytesWritten: 0,
    startedAt: Date.now(),
    closing: null,
    voicePath: voiceTempPath(sessionId),
    voiceStream: null,
    voiceBytes: 0,
    voiceClosing: null,
    voiceFailed: false
  }

  sessions.set(sessionId, session)
  logger.info(SCOPE, 'Session started', { sessionId, tempPath })

  return { sessionId, tempPath, startedAt: session.startedAt }
}

/**
 * Appends one chunk, honouring stream backpressure so a slow disk cannot make
 * the write queue grow without bound.
 */
export async function writeChunk(sessionId: string, chunk: ArrayBuffer): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) {
    throw new AppError(ERROR_CODES.SESSION_NOT_FOUND, `Unknown recording session ${sessionId}`)
  }

  const buffer = Buffer.from(chunk)
  session.bytesWritten += buffer.byteLength

  const hasRoom = session.stream.write(buffer)
  if (hasRoom) return

  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      session.stream.off('error', onError)
      resolve()
    }
    const onError = (error: Error): void => {
      session.stream.off('drain', onDrain)
      reject(
        new AppError(ERROR_CODES.WRITE_FAILED, `Failed writing recording data: ${error.message}`)
      )
    }
    session.stream.once('drain', onDrain)
    session.stream.once('error', onError)
  })
}

/**
 * Appends one chunk of the hard-panned audio copy.
 *
 * Deliberately quieter about failure than `writeChunk`. This file only ever
 * feeds a transcript; the recording does not depend on it, and a disk that
 * cannot take it is not a reason to fail a capture somebody is in the middle
 * of. The write is dropped, it is said once in the log, and the recording
 * carries on.
 */
export async function writeVoiceChunk(sessionId: string, chunk: ArrayBuffer): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session || session.voiceFailed) return

  if (!session.voiceStream) {
    try {
      const stream = createWriteStream(session.voicePath, { flags: 'w' })
      /*
       * Marked as failed rather than detached.
       *
       * The handle is kept so `closeVoiceStream` can still end it; dropping the
       * reference here would leave the file open until the process exits.
       */
      stream.on('error', (error) => {
        logger.warn(SCOPE, 'Voice stream error, dropping the voice track', { sessionId, error })
        session.voiceFailed = true
      })
      session.voiceStream = stream
    } catch (error) {
      logger.warn(SCOPE, 'Voice track could not be opened', { sessionId, error })
      session.voiceFailed = true
      return
    }
  }

  const stream = session.voiceStream
  const buffer = Buffer.from(chunk)
  session.voiceBytes += buffer.byteLength

  if (stream.write(buffer)) return

  /*
   * Backpressure — and every way out of it, not just the happy one.
   *
   * Waiting on `drain` alone is a deadlock waiting to happen: a stream that
   * errors or closes while full never drains, and this promise would never
   * settle. It is awaited through the IPC call, the renderer's write chain and
   * finally `stop()` — so a full disk here would hang the Stop button, on a
   * file the recording does not even need.
   */
  await new Promise<void>((resolve) => {
    const done = (): void => {
      stream.off('drain', done)
      stream.off('error', done)
      stream.off('close', done)
      resolve()
    }

    stream.once('drain', done)
    stream.once('error', done)
    stream.once('close', done)
  })
}

function closeVoiceStream(session: ActiveSession): Promise<void> {
  const stream = session.voiceStream
  if (!stream) return Promise.resolve()
  if (session.voiceClosing) return session.voiceClosing

  session.voiceClosing = new Promise<void>((resolve) => {
    stream.end(() => resolve())
  })
  return session.voiceClosing
}

function closeStream(session: ActiveSession): Promise<void> {
  if (session.closing) return session.closing

  session.closing = new Promise<void>((resolve) => {
    session.stream.end(() => resolve())
  })
  return session.closing
}

/* -------------------------------------------------------------------------- */
/*                                 Finalising                                 */
/* -------------------------------------------------------------------------- */

function emitProgress(progress: ProcessingProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.EVENT_PROCESSING_PROGRESS, progress)
    }
  }
}

/**
 * Closes the intermediate file and runs the FFmpeg pipeline that produces the
 * final MP4.
 */
export async function finalizeSession(request: FinalizeRequest): Promise<FinalizeResult> {
  const session = sessions.get(request.sessionId)
  if (!session) {
    throw new AppError(
      ERROR_CODES.SESSION_NOT_FOUND,
      `Unknown recording session ${request.sessionId}`
    )
  }

  await Promise.all([closeStream(session), closeVoiceStream(session)])
  sessions.delete(request.sessionId)

  logger.info(SCOPE, 'Session closed, starting processing', {
    sessionId: request.sessionId,
    bytes: session.bytesWritten,
    durationMs: request.durationMs
  })

  if (session.bytesWritten === 0) {
    await safeUnlink(session.tempPath)
    await safeUnlink(session.voicePath)
    throw new AppError(
      ERROR_CODES.SESSION_EMPTY,
      'The recording is empty.',
      'No frames were captured — check that screen recording permission is granted.'
    )
  }

  const voiceUsable = session.voiceBytes > 0 && !session.voiceFailed

  return processIntermediate(request, session.tempPath, voiceUsable ? session.voicePath : null)
}

/** Shared by normal finalisation and post-crash recovery. */
async function processIntermediate(
  request: FinalizeRequest,
  tempPath: string,
  voicePath: string | null = null
): Promise<FinalizeResult> {
  const settings = settingsStore.get()

  // The library folder — the app-managed default, or wherever the user pointed
  // `storage.outputFolder`. The Recordings page reads from exactly here.
  const outputFolder = libraryDirectory()
  await ensureOutputFolder(outputFolder)

  const baseName = buildFileBaseName(settings.storage.filenamePattern, new Date())
  const outputPath = uniqueOutputPath(outputFolder, baseName)

  emitProgress({
    sessionId: request.sessionId,
    stage: 'encoding',
    percent: 0,
    detail: 'Preparing conversion'
  })

  try {
    const outcome = await transcodeToMp4({
      inputPath: tempPath,
      outputPath,
      settings,
      request,
      onProgress: (percent, detail) => {
        emitProgress({ sessionId: request.sessionId, stage: 'encoding', percent, detail })
      }
    })

    emitProgress({
      sessionId: request.sessionId,
      stage: 'finalizing',
      percent: 99,
      detail: 'Writing file'
    })

    if (settings.storage.keepIntermediateFile) {
      // Move it beside the MP4 rather than leaving it in the temp directory,
      // where the next launch would report it as an unfinished recording.
      await preserveIntermediate(tempPath, outputPath)
    } else {
      await safeUnlink(tempPath)
    }

    // Catalogue it, so it is listed wherever it was written and keeps the
    // metadata the list cannot cheaply re-derive from the file.
    const recordingId = registerRecording(outputPath, {
      durationMs: request.durationMs,
      width: request.width,
      height: request.height
    })

    // After the catalogue entry, because the id is what the file is named for.
    const hasVoiceTrack = await adoptVoiceTrack(voicePath, recordingId)

    const fileSizeBytes = statSync(outputPath).size
    const result: FinalizeResult = {
      recordingId,
      outputPath,
      fileSizeBytes,
      durationMs: request.durationMs,
      encoder: outcome.encoder,
      usedFallbackEncoder: outcome.usedFallbackEncoder,
      hasVoiceTrack
    }

    logger.info(SCOPE, 'Recording saved', result)
    emitProgress({
      sessionId: request.sessionId,
      stage: 'done',
      percent: 100,
      detail: 'Saved'
    })

    return result
  } catch (error) {
    // The intermediate file is intentionally preserved on failure so the user
    // can recover the footage from the Recovery panel on the next launch.
    emitProgress({
      sessionId: request.sessionId,
      stage: 'failed',
      percent: 0,
      detail: error instanceof Error ? error.message : 'Conversion failed'
    })
    throw error
  }
}

/** Discards a session without producing an output file. */
export async function abortSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return

  await Promise.all([closeStream(session), closeVoiceStream(session)])
  sessions.delete(sessionId)
  await safeUnlink(session.tempPath)
  await safeUnlink(session.voicePath)
  logger.info(SCOPE, 'Session aborted', { sessionId })
}

export function hasActiveSessions(): boolean {
  return sessions.size > 0
}

/** Closes every open stream during shutdown so no data is truncated. */
export async function closeAllSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((session) => closeStream(session)))
  sessions.clear()
}

/* -------------------------------------------------------------------------- */
/*                              Crash recovery                                */
/* -------------------------------------------------------------------------- */

/**
 * Lists intermediate files with no owning session — the signature of a crash,
 * a force-quit or a failed conversion.
 */
export function listOrphanRecordings(): OrphanRecording[] {
  const orphans: OrphanRecording[] = []

  for (const dir of scratchDirectories()) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.startsWith(INTERMEDIATE_PREFIX) || !entry.endsWith(INTERMEDIATE_EXT)) continue

      /*
       * The voice scratch file ends in `.webm` too, and would otherwise be
       * offered in the Recovery panel as an unfinished recording — an
       * audio-only file presented as lost footage, under a session id with
       * `.voice` glued to the end.
       */
      if (entry.endsWith(VOICE_TEMP_SUFFIX)) continue

      const sessionId = entry.slice(INTERMEDIATE_PREFIX.length, -INTERMEDIATE_EXT.length)
      if (sessions.has(sessionId)) continue

      try {
        const path = join(dir, entry)
        const stats = statSync(path)
        if (stats.size === 0) {
          void safeUnlink(path)
          continue
        }
        orphans.push({
          sessionId,
          tempPath: path,
          sizeBytes: stats.size,
          createdAt: stats.birthtimeMs || stats.mtimeMs
        })
      } catch {
        /* entry vanished between readdir and stat */
      }
    }
  }

  return orphans.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * Converts an orphaned intermediate file into an MP4.
 *
 * The original duration and capture size are unknown, so the pipeline is asked
 * to re-encode rather than stream-copy; FFmpeg derives the real timings from
 * the container itself.
 */
export async function restoreOrphan(sessionId: string): Promise<FinalizeResult> {
  const orphan = listOrphanRecordings().find((item) => item.sessionId === sessionId)
  if (!orphan) {
    throw new AppError(ERROR_CODES.SESSION_NOT_FOUND, 'That recording is no longer available.')
  }

  logger.info(SCOPE, 'Recovering orphaned recording', orphan)

  return processIntermediate(
    {
      sessionId,
      durationMs: 0, // unknown — progress falls back to an indeterminate bar
      width: 0,
      height: 0,
      hasAudio: true,
      mimeType: 'video/webm'
    },
    orphan.tempPath,
    // A crash leaves both scratch files behind. The name is derived from the
    // session id, so the voice half is recoverable with the video half.
    existsSync(voiceTempPath(sessionId)) ? voiceTempPath(sessionId) : null
  )
}

export async function discardOrphan(sessionId: string): Promise<void> {
  const orphan = listOrphanRecordings().find((item) => item.sessionId === sessionId)
  if (!orphan) return

  await safeUnlink(orphan.tempPath)
  await safeUnlink(voiceTempPath(sessionId))
  logger.info(SCOPE, 'Discarded orphaned recording', { sessionId })
}

/**
 * Keeps the raw capture next to the finished MP4, e.g. `Recording_x.raw.webm`.
 * Falls back to a copy when the temp directory is on a different volume.
 */
async function preserveIntermediate(tempPath: string, outputPath: string): Promise<void> {
  const destination = outputPath.replace(/\.mp4$/i, '.raw.webm')

  try {
    await fsp.rename(tempPath, destination)
  } catch {
    try {
      await fsp.copyFile(tempPath, destination)
      await safeUnlink(tempPath)
    } catch (error) {
      logger.warn(SCOPE, 'Could not preserve the intermediate file', error)
      return
    }
  }

  logger.info(SCOPE, 'Kept intermediate capture', { path: destination })
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await fsp.unlink(path)
  } catch (error) {
    logger.debug(SCOPE, 'Could not remove file', { path, error })
  }
}
