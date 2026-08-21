import type {
  ActivityDay,
  ActivityInterval,
  ActivitySegment,
  ActivityScreenshot
} from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'

const SCOPE = 'activity-day'

/**
 * One person's recorded day, read back for the admin panel.
 *
 * Row level security decides what comes out of here, not this code: an
 * administrator sees anybody, everyone else sees themselves, and a request for
 * somebody else's day simply returns nothing rather than an error. The checks
 * below turn the common refusal into a sentence; they are not the boundary.
 */

/**
 * How long a screenshot link stays valid.
 *
 * Long enough to read a day without the images expiring mid-scroll, short
 * enough that a link copied out of the app is not a permanent back door into a
 * private bucket.
 */
const SIGNED_URL_TTL_SECONDS = 60 * 60

export async function readActivityDay(
  userId: string,
  from: string,
  to: string
): Promise<ActivityDay> {
  if (!currentUser()) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign in to read activity.')
  }

  const [segments, screenshots, intervals] = await Promise.all([
    readSegments(userId, from, to),
    readScreenshots(userId, from, to),
    readIntervals(userId, from, to)
  ])

  const total = (state: ActivitySegment['state']): number =>
    segments
      .filter((segment) => segment.state === state)
      .reduce(
        (sum, segment) =>
          sum + (Date.parse(segment.endedAt) - Date.parse(segment.startedAt)),
        0
      )

  const sum = (pick: (interval: ActivityInterval) => number): number =>
    intervals.reduce((carried, interval) => carried + pick(interval), 0)

  const trackedMs = intervals.reduce(
    (carried, interval) =>
      carried + (Date.parse(interval.endedAt) - Date.parse(interval.startedAt)),
    0
  )

  const activeSeconds = sum((interval) => interval.activeSeconds)

  return {
    segments,
    screenshots,
    intervals,
    activeMs: total('active'),
    idleMs: total('idle'),
    keyPresses: sum((interval) => interval.keyPresses),
    mouseClicks: sum((interval) => interval.mouseClicks),
    scrolls: sum((interval) => interval.scrolls),
    trackedMs,
    // Capped at 100: the active clock is sampled every few seconds, so rounding
    // at the edges can otherwise put a fully-worked window a point over.
    activePercent:
      trackedMs > 0 ? Math.min(100, Math.round((activeSeconds * 1000 * 100) / trackedMs)) : null
  }
}

async function readIntervals(
  userId: string,
  from: string,
  to: string
): Promise<ActivityInterval[]> {
  const { data, error } = await getSupabase()
    .from('activity_intervals')
    .select('started_at, ended_at, key_presses, mouse_clicks, scrolls, active_seconds, input_available')
    .eq('user_id', userId)
    .gte('started_at', from)
    .lt('started_at', to)
    .order('started_at')

  if (error) throw translate(error, 'read the input counts')

  return (data as unknown as Array<{
    started_at: string
    ended_at: string
    key_presses: number
    mouse_clicks: number
    scrolls: number
    active_seconds: number
    input_available: boolean | null
  }>).map((row) => ({
    startedAt: row.started_at,
    endedAt: row.ended_at,
    keyPresses: row.key_presses,
    mouseClicks: row.mouse_clicks,
    scrolls: row.scrolls,
    activeSeconds: row.active_seconds,
    inputAvailable: row.input_available
  }))
}

/* -------------------------------------------------------------------------- */

async function readSegments(
  userId: string,
  from: string,
  to: string
): Promise<ActivitySegment[]> {
  const { data, error } = await getSupabase()
    .from('activity_segments')
    .select('started_at, ended_at, state')
    .eq('user_id', userId)
    // Half-open, so a stretch starting exactly at midnight belongs to one day
    // and not to both.
    .gte('started_at', from)
    .lt('started_at', to)
    .order('started_at')

  if (error) throw translate(error, 'read the activity')

  return (data as unknown as Array<{
    started_at: string
    ended_at: string
    state: string
  }>).map((row) => ({
    startedAt: row.started_at,
    endedAt: row.ended_at,
    state: row.state === 'idle' ? 'idle' : 'active'
  }))
}

/**
 * The day's captures, each with a link that will actually load.
 *
 * The bucket is private, so a path is useless to the window on its own. Signing
 * them in one batch rather than one request per image is what keeps opening a
 * day from making fifty round trips.
 */
async function readScreenshots(
  userId: string,
  from: string,
  to: string
): Promise<ActivityScreenshot[]> {
  const { data, error } = await getSupabase()
    .from('screenshots')
    .select('captured_at, storage_path')
    .eq('user_id', userId)
    .gte('captured_at', from)
    .lt('captured_at', to)
    .order('captured_at')

  if (error) throw translate(error, 'read the screenshots')

  const rows = data as unknown as Array<{ captured_at: string; storage_path: string }>
  if (rows.length === 0) return []

  const signed = await signAll(rows.map((row) => row.storage_path))

  return rows.map((row) => ({
    capturedAt: row.captured_at,
    storagePath: row.storage_path,
    url: signed.get(row.storage_path) ?? null
  }))
}

async function signAll(paths: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>()

  try {
    const { data, error } = await getSupabase()
      .storage.from('screenshots')
      .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS)

    if (error) throw error

    for (const entry of data ?? []) {
      if (entry.path && entry.signedUrl) urls.set(entry.path, entry.signedUrl)
    }
  } catch (error) {
    // The day is still worth showing without its pictures — the timeline is the
    // larger part of the answer, and a tile that says so beats an empty screen.
    logger.warn(SCOPE, 'Could not sign the screenshot links', error)
  }

  return urls
}

function translate(error: { code?: string; message: string }, action: string): AppError {
  logger.error(SCOPE, `Could not ${action}`, error)

  if (error.code === 'PGRST205' || error.code === '42P01') {
    return new AppError(
      ERROR_CODES.UNKNOWN,
      'Activity is not set up on the server yet.',
      'Run the create_activity_tables migration in the Supabase SQL editor.'
    )
  }

  return new AppError(ERROR_CODES.UNKNOWN, `Could not ${action}.`, error.message)
}
