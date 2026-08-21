import { app, powerMonitor } from 'electron'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActivitySegment } from '@shared/types'
import { logger } from '../lib/logger'
import type { ClockGap } from './clock-watchdog'
import { clockWatchdog } from './clock-watchdog'
import { settingsStore } from './settings-store'
import { currentPolicy, trackingPolicy } from './tracking-policy'

const SCOPE = 'activity'

/**
 * Whether this machine is being used, recorded as stretches of time.
 *
 * The only signal read is how long it has been since the keyboard or mouse was
 * touched — `powerMonitor.getSystemIdleTime()`, which every platform answers
 * without a native module and without seeing a single keystroke.
 *
 * Sampling is frequent and storage is not: a sample every fifteen seconds is
 * what makes the boundary between working and away accurate to the quarter
 * minute, while what gets written is one row per stretch. A day of ordinary
 * work is a few dozen rows.
 *
 * Everything is written to disk as it closes. Nothing here talks to the network
 * — the upload that drains these files is a later phase, and the tracker must
 * keep working on a machine that never sees one.
 */

/** How often the idle clock is read. */
const SAMPLE_INTERVAL_MS = 15_000

/**
 * A gap this much larger than the interval means the samples stopped, not that
 * the state continued: the machine slept, hibernated, or was too busy to run a
 * timer. Time inside such a gap is not claimed as anything.
 */
const GAP_TOLERANCE_MS = SAMPLE_INTERVAL_MS * 4

let timer: NodeJS.Timeout | null = null

/** The stretch being accumulated, or null when the tracker is stopped. */
let open: ActivitySegment | null = null

/** When the last sample was taken, to recognise a gap on the next one. */
let lastSampleAt = 0

/* -------------------------------------------------------------------------- */
/*                                  Lifecycle                                 */
/* -------------------------------------------------------------------------- */

/**
 * Starts or stops the tracker to match the current settings, and keeps doing so
 * as they change. Safe to call repeatedly.
 */
export function initActivityTracker(): void {
  // The switch belongs to the server; the idle threshold is still a local
  // setting, so both are watched.
  trackingPolicy.on('changed', () => void reconcile())
  settingsStore.on('changed', () => void reconcile())
  void reconcile()

  /*
   * Sleep is a gap, and it has to be closed at the moment it started rather
   * than when the machine came back. Without this a laptop shut overnight would
   * report eight hours of whatever state it was in when the lid closed.
   *
   * This used to hang off `powerMonitor`'s `suspend` and `resume`, which was a
   * quiet way to be wrong: modern Windows laptops sleep without emitting them,
   * and worse, sometimes emit `resume` alone — which reopened sampling with the
   * pre-sleep stretch still open and no gap on record to close it. The measured
   * gap needs no cooperation from the platform.
   */
  clockWatchdog.on('gap', (gap: ClockGap) => {
    void (async () => {
      await closeOpen(new Date(gap.stoppedAt))
      lastSampleAt = 0
      await sample()
    })()
  })

  // Locking is not sleeping: the machine is still on and still counts as time,
  // it is simply time nobody is at the keyboard for — which the idle clock
  // already reports. Deliberately not handled as a separate case.
}

/**
 * Closes the open stretch at the real time and stops sampling.
 *
 * Called on the way out. The stretch is written with the time the app was
 * actually asked to quit, so the gap between shutdown and the next boot stays a
 * gap rather than being absorbed into either day.
 */
export async function stopActivityTracker(): Promise<void> {
  clearTimer()
  await closeOpen(new Date())
}

async function reconcile(): Promise<void> {
  const { tracking } = settingsStore.get()
  const wanted = currentPolicy().trackingEnabled

  if (wanted && timer === null) {
    lastSampleAt = 0
    timer = setInterval(() => void sample(), SAMPLE_INTERVAL_MS)
    void sample()
    logger.info(SCOPE, 'Activity tracking started', {
      idleAfterSeconds: tracking.idleAfterSeconds
    })
    return
  }

  if (!wanted && timer !== null) {
    clearTimer()
    await closeOpen(new Date())
    logger.info(SCOPE, 'Activity tracking stopped')
  }
}

function clearTimer(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/* -------------------------------------------------------------------------- */
/*                                  Sampling                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reads the idle clock once and folds the answer into the open stretch.
 *
 * Three outcomes: the state is unchanged and the stretch simply extends; the
 * state flipped and the stretch closes so a new one can begin; or the samples
 * stopped for a while, in which case the old stretch is closed at the last
 * moment it was known to be true and a fresh one starts now.
 */
async function sample(): Promise<void> {
  const { tracking } = settingsStore.get()
  if (!currentPolicy().trackingEnabled) return

  const now = Date.now()

  // `getSystemIdleTime` answers in seconds, and counts every input device the
  // OS knows about — not just the ones this app could see.
  const idleSeconds = powerMonitor.getSystemIdleTime()
  const state: ActivitySegment['state'] =
    idleSeconds >= tracking.idleAfterSeconds ? 'idle' : 'active'

  const gapped = lastSampleAt > 0 && now - lastSampleAt > GAP_TOLERANCE_MS

  if (gapped) {
    logger.debug(SCOPE, 'Gap between samples; closing the open stretch', {
      gapMs: now - lastSampleAt
    })
    // Known true up to one interval past the last sample, and nothing beyond.
    await closeOpen(new Date(lastSampleAt + SAMPLE_INTERVAL_MS))
  }

  lastSampleAt = now

  if (open === null) {
    open = { startedAt: new Date(now).toISOString(), endedAt: new Date(now).toISOString(), state }
    return
  }

  if (open.state !== state) {
    await closeOpen(new Date(now))
    open = { startedAt: new Date(now).toISOString(), endedAt: new Date(now).toISOString(), state }
    return
  }

  open.endedAt = new Date(now).toISOString()
}

/** Writes the open stretch out and clears it. Ignores one of zero length. */
async function closeOpen(endedAt: Date): Promise<void> {
  const segment = open
  open = null

  if (segment === null) return

  segment.endedAt = endedAt.toISOString()

  // A stretch that opened and closed inside one sample says nothing.
  if (new Date(segment.endedAt).getTime() <= new Date(segment.startedAt).getTime()) return

  await write(segment)
}

/* -------------------------------------------------------------------------- */
/*                                  Storage                                   */
/* -------------------------------------------------------------------------- */

/**
 * One newline-delimited JSON file per day.
 *
 * Append-only, so a crash costs at most the stretch currently open, and a
 * partially written last line is the only damage possible — which the reader
 * below simply skips. Files are named by the day the stretch *started*, so a
 * shift running past midnight lands in the day it began.
 */
function directory(): string {
  return join(app.getPath('userData'), 'activity')
}

function fileFor(iso: string): string {
  const day = new Date(iso)
  const name = [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0')
  ].join('-')

  return join(directory(), `segments-${name}.jsonl`)
}

async function write(segment: ActivitySegment): Promise<void> {
  try {
    await mkdir(directory(), { recursive: true })
    await appendFile(fileFor(segment.startedAt), `${JSON.stringify(segment)}\n`, 'utf8')

    logger.debug(SCOPE, 'Segment recorded', {
      state: segment.state,
      minutes: Math.round(
        (new Date(segment.endedAt).getTime() - new Date(segment.startedAt).getTime()) / 60_000
      )
    })
  } catch (error) {
    // Losing a stretch is bad; taking the app down over it is worse.
    logger.warn(SCOPE, 'Could not record a segment', error)
  }
}

/**
 * The stretches recorded for one day, oldest first.
 *
 * Includes the stretch still open, so today reads as it stands rather than
 * stopping at the last state change.
 */
export async function readSegments(day: Date): Promise<ActivitySegment[]> {
  const segments: ActivitySegment[] = []

  try {
    const contents = await readFile(fileFor(day.toISOString()), 'utf8')

    for (const line of contents.split('\n')) {
      if (!line.trim()) continue
      try {
        segments.push(JSON.parse(line) as ActivitySegment)
      } catch {
        // A half-written final line from a hard shutdown. Skip it and keep the
        // rest of the day, which is intact.
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') logger.warn(SCOPE, 'Could not read the day', error)
  }

  if (open !== null && sameDay(new Date(open.startedAt), day)) segments.push({ ...open })

  return segments
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
