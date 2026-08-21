import { app } from 'electron'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivitySegment } from '@shared/types'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'
import { currentDeviceId } from './device'
import { lastRecordedOwnerId } from './tracking-policy'

const SCOPE = 'activity-upload'

/**
 * Moves what the machine recorded to the server.
 *
 * Everything the tracker and the scheduler produce lands on local disk first
 * and stays there until this confirms it has arrived. That ordering is the
 * whole design: a laptop with no signal keeps recording a complete day, and
 * catches up when it next has one.
 *
 * Retries are safe by construction rather than by bookkeeping. Both tables have
 * a unique key over what identifies a row, and storage uploads overwrite the
 * same path, so sending the same thing twice changes nothing.
 */

/** How often the queue is drained. Often enough to feel live, rarely enough to be cheap. */
const DRAIN_INTERVAL_MS = 60_000

/** Images sent per pass. Keeps one catch-up after a long outage from stalling everything else. */
const BATCH_SIZE = 20

/**
 * When the backlog is worth complaining about.
 *
 * At ten minutes an image this is several days of failing uploads — long past
 * the point where somebody should have been told rather than left to discover
 * a full disk.
 */
const BACKLOG_WARNING = 500

let timer: NodeJS.Timeout | null = null
let draining = false

export function startActivityUpload(): void {
  if (timer !== null) return

  timer = setInterval(() => void drain(), DRAIN_INTERVAL_MS)
  void drain()

  logger.info(SCOPE, 'Upload queue started', { everyMs: DRAIN_INTERVAL_MS })
}

export function stopActivityUpload(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/**
 * One pass over both queues.
 *
 * Guarded against overlapping with itself: a slow upload on a poor connection
 * can easily outlast the interval, and two passes would fight over the same
 * files.
 */
async function drain(): Promise<void> {
  if (draining) return

  const user = currentUser()
  // Nothing can be filed without an account to file it under. The queue simply
  // waits — this is the offline case, not an error.
  if (!user) return

  /*
   * Whose queue this is, checked before a single row is filed.
   *
   * Rows are stamped with the signed-in account at upload time, not at capture
   * time, and those are no longer the same thing: a machine that boots without
   * a network records under the account it remembers before any session exists.
   * If somebody else signs in first, an unchecked drain would quietly file one
   * person's day — screenshots included — against another person's name.
   */
  const owner = await lastRecordedOwnerId()
  if (owner !== null && owner !== user.id) {
    logger.warn(SCOPE, 'The queue belongs to another account; leaving it alone', {
      signedInAs: user.email
    })
    return
  }

  draining = true
  try {
    await drainSegments(user.id)
    await drainIntervals(user.id)
    await drainScreenshots(user.id)
  } catch (error) {
    logger.warn(SCOPE, 'Upload pass failed; will retry', error)
  } finally {
    draining = false
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Segments                                  */
/* -------------------------------------------------------------------------- */

function activityDirectory(): string {
  return join(app.getPath('userData'), 'activity')
}

/**
 * Sends the stretches that have not been sent yet.
 *
 * Today's file is still being appended to while this runs, so the position
 * reached last time is remembered beside it and only the lines after it are
 * read. Reading to the last newline rather than to the end is what keeps a
 * half-written final line out of the batch.
 */
async function drainSegments(userId: string): Promise<void> {
  const directory = activityDirectory()

  let files: string[]
  try {
    files = (await readdir(directory)).filter(
      (name) => name.startsWith('segments-') && name.endsWith('.jsonl')
    )
  } catch {
    return // Nothing recorded yet.
  }

  for (const file of files.sort()) {
    const path = join(directory, file)
    const offsetPath = `${path}.offset`

    const content = await readFile(path, 'utf8')
    const offset = await readOffset(offsetPath)

    const end = content.lastIndexOf('\n')
    if (end < 0 || end + 1 <= offset) continue

    const lines = content
      .slice(offset, end + 1)
      .split('\n')
      .filter((line) => line.trim().length > 0)

    const rows = lines
      .map((line) => parseSegment(line, userId))
      .filter((row): row is SegmentRow => row !== null)

    if (rows.length > 0) {
      const { error } = await getSupabase()
        .from('activity_segments')
        .upsert(rows, {
          onConflict: 'user_id,device_id,started_at,state',
          ignoreDuplicates: true
        })

      // Leave the offset alone on failure: the same lines are read again next
      // pass, and the unique key makes that harmless.
      if (error) throw error

      logger.info(SCOPE, 'Segments uploaded', { file, count: rows.length })
    }

    await writeFile(offsetPath, String(end + 1), 'utf8')
  }
}

interface SegmentRow {
  user_id: string
  /**
   * Which machine recorded it, or null when this one had not registered yet —
   * a first run with no network. The unique index is declared `nulls not
   * distinct` so those rows still dedupe on a retry.
   */
  device_id: string | null
  started_at: string
  ended_at: string
  state: string
}

function parseSegment(line: string, userId: string): SegmentRow | null {
  try {
    const segment = JSON.parse(line) as ActivitySegment
    if (!segment.startedAt || !segment.endedAt) return null

    return {
      user_id: userId,
      device_id: currentDeviceId(),
      started_at: segment.startedAt,
      ended_at: segment.endedAt,
      state: segment.state
    }
  } catch {
    // A line mangled by a hard shutdown. Skipping it loses one stretch; failing
    // the batch would lose the rest of the day with it.
    return null
  }
}

async function readOffset(path: string): Promise<number> {
  try {
    const value = Number(await readFile(path, 'utf8'))
    return Number.isFinite(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Intervals                                 */
/* -------------------------------------------------------------------------- */

/**
 * The same append-and-offset dance as the segments, over the counts file.
 *
 * Kept as its own pass rather than folded into that one: the two files have
 * different shapes and different tables, and a failure uploading one should not
 * hold up the other.
 */
async function drainIntervals(userId: string): Promise<void> {
  const directory = activityDirectory()

  let files: string[]
  try {
    files = (await readdir(directory)).filter(
      (name) => name.startsWith('intervals-') && name.endsWith('.jsonl')
    )
  } catch {
    return
  }

  for (const file of files.sort()) {
    const path = join(directory, file)
    const offsetPath = `${path}.offset`

    const content = await readFile(path, 'utf8')
    const offset = await readOffset(offsetPath)

    const end = content.lastIndexOf('\n')
    if (end < 0 || end + 1 <= offset) continue

    const rows = content
      .slice(offset, end + 1)
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => parseInterval(line, userId))
      .filter((row): row is IntervalRow => row !== null)

    if (rows.length > 0) {
      const { error } = await getSupabase()
        .from('activity_intervals')
        .upsert(rows, { onConflict: 'user_id,device_id,started_at', ignoreDuplicates: true })

      if (error) throw error
      logger.info(SCOPE, 'Intervals uploaded', { file, count: rows.length })
    }

    await writeFile(offsetPath, String(end + 1), 'utf8')
  }
}

interface IntervalRow {
  user_id: string
  device_id: string | null
  started_at: string
  ended_at: string
  key_presses: number
  mouse_clicks: number
  scrolls: number
  active_seconds: number
  input_available: boolean | null
}

function parseInterval(line: string, userId: string): IntervalRow | null {
  try {
    const row = JSON.parse(line) as {
      startedAt: string
      endedAt: string
      keyPresses: number
      mouseClicks: number
      scrolls: number
      activeSeconds: number
      inputAvailable: boolean | null
    }

    if (!row.startedAt || !row.endedAt) return null

    return {
      user_id: userId,
      device_id: currentDeviceId(),
      started_at: row.startedAt,
      ended_at: row.endedAt,
      key_presses: row.keyPresses ?? 0,
      mouse_clicks: row.mouseClicks ?? 0,
      scrolls: row.scrolls ?? 0,
      active_seconds: row.activeSeconds ?? 0,
      input_available: row.inputAvailable ?? null
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*                                 Screenshots                                */
/* -------------------------------------------------------------------------- */

function pendingDirectory(): string {
  return join(app.getPath('userData'), 'screenshots', 'pending')
}

/**
 * Uploads captures, then records them, then deletes the local copy.
 *
 * That order is deliberate. A crash between any two steps leaves the file on
 * disk and the next pass repeats the work — an overwrite in storage and a
 * no-op on the row. The other order would delete a file that never arrived.
 */
async function drainScreenshots(userId: string): Promise<void> {
  const directory = pendingDirectory()

  let files: string[]
  try {
    files = (await readdir(directory)).filter((name) => name.endsWith('.jpg'))
  } catch {
    return
  }

  if (files.length > BACKLOG_WARNING) {
    logger.warn(SCOPE, 'Screenshot backlog is growing', { pending: files.length })
  }

  // Oldest first, so a backlog drains in the order it happened.
  for (const file of files.sort().slice(0, BATCH_SIZE)) {
    const capturedAt = Number(file.replace('.jpg', ''))
    if (!Number.isFinite(capturedAt)) continue

    const path = join(directory, file)
    const image = await readFile(path)
    const storagePath = buildStoragePath(userId, capturedAt)

    const upload = await getSupabase()
      .storage.from('screenshots')
      .upload(storagePath, image, {
        contentType: 'image/jpeg',
        // A retry of a capture already sent replaces it with the same bytes.
        upsert: true
      })

    if (upload.error) throw upload.error

    const { error } = await getSupabase()
      .from('screenshots')
      .upsert(
        {
          user_id: userId,
          device_id: currentDeviceId(),
          captured_at: new Date(capturedAt).toISOString(),
          storage_path: storagePath,
          bytes: image.length
        },
        { onConflict: 'user_id,device_id,captured_at', ignoreDuplicates: true }
      )

    if (error) throw error

    await unlink(path).catch(() => undefined)
    logger.info(SCOPE, 'Screenshot uploaded', { storagePath, kb: Math.round(image.length / 1024) })
  }
}

/** `{user_id}/{yyyy-mm-dd}/{epoch}.jpg` — the first segment is what the storage
 * policy checks, and the date makes a day's captures easy to list. */
function buildStoragePath(userId: string, capturedAt: number): string {
  const at = new Date(capturedAt)
  const day = [
    at.getFullYear(),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0')
  ].join('-')

  return `${userId}/${day}/${capturedAt}.jpg`
}
