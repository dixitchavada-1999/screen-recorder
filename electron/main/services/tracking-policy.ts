import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TrackingPolicy } from '@shared/types'
import { logger } from '../lib/logger'
import {
  currentUser,
  getSupabase,
  hasStoredSession,
  sessionRestoreAttempted,
  signOut
} from './auth'
import { getMachineId } from './device'

const SCOPE = 'tracking-policy'

/**
 * What this machine has been told to record, for the account signed in on it.
 *
 * The two switches live on the person's profile row rather than in local
 * settings, and this is the only thing that reads them. A machine-local setting
 * would be the tracked person's to change and invisible to anybody else, which
 * makes it useless as a policy — an administrator could neither switch tracking
 * on for someone else's laptop nor tell whether it was on.
 *
 * Polled rather than subscribed. A realtime channel would be fewer round trips,
 * but this has to keep working through a dropped connection, a sleeping laptop
 * and an expired socket, and re-reading two booleans every couple of minutes is
 * cheap enough that the simpler thing wins.
 */

/**
 * How often the policy is re-read.
 *
 * This is the delay between an administrator revoking tracking and the machine
 * noticing. Two minutes is short enough to mean something and long enough that
 * a hundred machines are not hammering the table.
 */
const REFRESH_INTERVAL_MS = 2 * 60 * 1000

/**
 * How stale the remembered answer may be before it stops being used.
 *
 * The last answer is kept on disk so a machine that boots without a network
 * still knows what it was told (see {@link readCache}). It is not kept forever:
 * a laptop that has not reached the server in a week may well have had its
 * tracking revoked in the meantime, and continuing to record on the strength of
 * a month-old "yes" is the wrong way to be wrong.
 */
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The schedule used until the server has said what it is. The same numbers the
 * server's own row starts with.
 */
const DEFAULT_INTERVAL_MINUTES = 10
const DEFAULT_IDLE_SECONDS = 300

/** Nothing is recorded until the server says otherwise. */
const OFF: TrackingPolicy = {
  trackingEnabled: false,
  screenshotsEnabled: false,
  appsEnabled: false,
  browserEnabled: false,
  screenshotIntervalMinutes: DEFAULT_INTERVAL_MINUTES,
  idleAfterSeconds: DEFAULT_IDLE_SECONDS,
  excludedDomains: []
}

/** The excluded sites as a clean list of lower-case hosts. Anything else is dropped. */
function domains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase().replace(/^www\./, ''))
    .filter((item) => item.length > 0 && item.length <= 255)
}

/**
 * The schedule within the bounds the server enforces, with the defaults in
 * place of anything missing — an older server answers without these fields.
 */
function schedule(raw: { interval?: unknown; idle?: unknown }): {
  screenshotIntervalMinutes: number
  idleAfterSeconds: number
} {
  const interval = Number(raw.interval)
  const idle = Number(raw.idle)

  return {
    screenshotIntervalMinutes:
      Number.isFinite(interval) && interval >= 1 && interval <= 240
        ? Math.round(interval)
        : DEFAULT_INTERVAL_MINUTES,
    idleAfterSeconds:
      Number.isFinite(idle) && idle >= 30 && idle <= 3600 ? Math.round(idle) : DEFAULT_IDLE_SECONDS
  }
}

let current: TrackingPolicy = OFF
let timer: NodeJS.Timeout | null = null

/**
 * Whether the server has answered at all since this process started.
 *
 * Separates "we have a live answer and lost the connection" — where the right
 * move is to carry on — from "we have never heard anything", which is where a
 * cold boot begins and where the remembered answer is worth having.
 */
let confirmed = false

/** Whether the server last said this installation is untracked; for the log only. */
let deviceUntracked = false

/** Keeps the fallback from repeating itself in the log every couple of minutes. */
let announcedFallback = false

/** Emits `changed` when either switch flips. */
export const trackingPolicy = new EventEmitter()

export function currentPolicy(): TrackingPolicy {
  return { ...current }
}

/**
 * The account this machine last recorded for, however long ago that was.
 *
 * Deliberately ignores the staleness rule that governs the policy itself. A
 * remembered "yes" going stale means stop recording; it does not mean the day
 * already on disk stopped belonging to the person who worked it.
 */
export async function lastRecordedOwnerId(): Promise<string | null> {
  try {
    const cached = JSON.parse(await readFile(cachePath(), 'utf8')) as CachedPolicy
    return typeof cached.userId === 'string' && cached.userId.length > 0 ? cached.userId : null
  } catch {
    return null
  }
}

export function startTrackingPolicy(): void {
  if (timer !== null) return

  timer = setInterval(() => void refreshPolicy(), REFRESH_INTERVAL_MS)
  void refreshPolicy()

  logger.info(SCOPE, 'Policy watcher started', { everyMs: REFRESH_INTERVAL_MS })
}

export function stopTrackingPolicy(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/**
 * Re-reads the policy and announces it if anything moved.
 *
 * Called on the interval, and directly after signing in or out — waiting up to
 * two minutes for those would mean recording under the wrong account, or
 * carrying on after the account went away.
 */
export async function refreshPolicy(): Promise<void> {
  const next = await read()

  const changed =
    next.trackingEnabled !== current.trackingEnabled ||
    next.screenshotsEnabled !== current.screenshotsEnabled ||
    next.appsEnabled !== current.appsEnabled ||
    next.browserEnabled !== current.browserEnabled ||
    next.screenshotIntervalMinutes !== current.screenshotIntervalMinutes ||
    next.idleAfterSeconds !== current.idleAfterSeconds ||
    next.excludedDomains.join(',') !== current.excludedDomains.join(',')

  current = next
  if (!changed) return

  logger.info(SCOPE, 'Policy changed', next)
  trackingPolicy.emit('changed', currentPolicy())
}

async function read(): Promise<TrackingPolicy> {
  const user = currentUser()

  if (!user) {
    // Signing out ends the run of confirmed answers: whoever signs in next
    // starts from nothing heard, the same as a cold boot.
    confirmed = false

    /*
     * No live session is two different situations, and they need opposite
     * answers.
     *
     * Signed out means stop: there is no account to file a day against and
     * nobody has asked for one. But a machine that booted without a network is
     * also sitting here with no session — the token is there, it simply could
     * not be exchanged — and answering "off" for that is the hole this closes.
     * Turning the Wi-Fi off before switching on would otherwise be all it took
     * to record nothing all day.
     *
     * A stored token is what separates them.
     *
     * Not before the restore has been tried, though. For the first second or
     * two of every run there is no session yet simply because nothing has asked
     * for one, and falling back there would start recording — and take a
     * screenshot — a moment before the server got the chance to say no.
     */
    if (!sessionRestoreAttempted()) return OFF
    if (!(await hasStoredSession())) return OFF

    const remembered = await readCache()
    if (!remembered) return OFF

    // Once, not every two minutes for as long as the outage lasts.
    if (!announcedFallback) {
      announcedFallback = true
      logger.info(SCOPE, 'No session yet; recording under the policy from last time', {
        trackingEnabled: remembered.trackingEnabled
      })
    }

    return withoutOwner(remembered)
  }

  try {
    /*
     * One call that answers all of it, including whether this person still
     * works here.
     *
     * That last part is not something the app enforces — the database refuses a
     * departed person's every read and write on its own, whatever this process
     * decides. It is here so the app can stop rather than sit there quietly
     * failing: a machine that keeps sampling, keeps photographing and keeps
     * being turned away is worse than one that admits what has happened.
     */
    // Which installation is asking: a device on the untracked list is told
    // every switch is off, whoever is signed in on it.
    const { data, error } = await getSupabase().rpc('my_status', {
      p_machine: await getMachineId()
    })

    if (error) throw error

    const row = (data ?? {}) as {
      active?: boolean
      tracking_enabled?: boolean | null
      screenshots_enabled?: boolean | null
      apps_enabled?: boolean | null
      device_untracked?: boolean | null
      browser_enabled?: boolean | null
      screenshot_interval_minutes?: number | null
      idle_after_seconds?: number | null
      excluded_domains?: unknown
    }

    if ((row.device_untracked === true) !== deviceUntracked) {
      deviceUntracked = row.device_untracked === true
      logger.info(
        SCOPE,
        deviceUntracked
          ? 'This device is on the untracked list; nothing will be recorded on it'
          : 'This device is no longer on the untracked list'
      )
    }

    if (row.active === false) {
      logger.warn(SCOPE, 'This account no longer appears in the staff list; signing out')

      // Ends the run of confirmed answers, so nothing falls back to a cached
      // "yes" and carries on recording after this.
      confirmed = false
      await forgetCache()
      void signOut()

      return OFF
    }

    const trackingEnabled = row.tracking_enabled === true

    const policy: TrackingPolicy = {
      trackingEnabled,
      // Screenshots without tracking is not a state that means anything: the
      // schedule they hang off is not running. Folding it in here keeps every
      // caller from having to remember that.
      // Its own switch: screenshots can run with Activity off.
      screenshotsEnabled: row.screenshots_enabled === true,
      appsEnabled: trackingEnabled && row.apps_enabled === true,
      browserEnabled: trackingEnabled && row.browser_enabled === true,
      ...schedule({ interval: row.screenshot_interval_minutes, idle: row.idle_after_seconds }),
      excludedDomains: domains(row.excluded_domains)
    }

    confirmed = true
    // The next outage is a new outage, and worth a line of its own.
    announcedFallback = false

    void writeCache(user.id, policy)
    return policy
  } catch (error) {
    /*
     * A failed read keeps whatever was last known, rather than switching
     * everything off.
     *
     * Otherwise every flaky connection would punch a hole in the day's record,
     * and a laptop taken somewhere without signal would quietly stop tracking
     * for as long as it was away. The policy only changes when the server
     * actually answers.
     */
    if (confirmed) {
      logger.warn(SCOPE, 'Could not read the tracking policy; keeping the last known one', error)
      return current
    }

    /*
     * Nothing has been heard yet, which means this is a cold start.
     *
     * "Last known" is `OFF` here, and returning it would open a hole big enough
     * to walk through: a machine booted with no network would record nothing at
     * all, all day, and the way to arrange that is simply to turn the Wi-Fi off
     * before switching on. So the answer from the previous session is read back
     * from disk and used until the server can be reached.
     */
    const remembered = await readCache()
    const usable = remembered !== null && remembered.userId === user.id

    logger.warn(
      SCOPE,
      usable
        ? 'Could not read the tracking policy; using the one remembered from last time'
        : 'Could not read the tracking policy and none was remembered; recording nothing',
      error
    )

    if (!usable) return OFF

    return withoutOwner(remembered)
  }
}

/** A remembered answer, minus the bookkeeping kept beside it on disk. */
function withoutOwner(remembered: CachedPolicy): TrackingPolicy {
  return {
    trackingEnabled: remembered.trackingEnabled,
    screenshotsEnabled: remembered.screenshotsEnabled,
    appsEnabled: remembered.appsEnabled,
    browserEnabled: remembered.browserEnabled,
    screenshotIntervalMinutes: remembered.screenshotIntervalMinutes,
    idleAfterSeconds: remembered.idleAfterSeconds,
    excludedDomains: remembered.excludedDomains
  }
}

/* -------------------------------------------------------------------------- */
/*                               Remembered answer                            */
/* -------------------------------------------------------------------------- */

/*
 * A plain file in the app's own data directory, and deliberately not treated as
 * trustworthy. Anybody who can edit it can also decline to run the app at all,
 * so hardening it would buy nothing; the server is the boundary, and the moment
 * it answers its word replaces whatever was here. This exists so that a boot
 * without a network is not a boot without a policy.
 */
interface CachedPolicy extends TrackingPolicy {
  userId: string
  savedAt: number
}

function cachePath(): string {
  return join(app.getPath('userData'), 'tracking-policy.json')
}

async function writeCache(userId: string, policy: TrackingPolicy): Promise<void> {
  const cached: CachedPolicy = { ...policy, userId, savedAt: Date.now() }

  try {
    await writeFile(cachePath(), JSON.stringify(cached), 'utf8')
  } catch (error) {
    // Costs nothing today; only the next offline boot would notice.
    logger.debug(SCOPE, 'Could not remember the tracking policy', error)
  }
}

/**
 * Throws the remembered policy away.
 *
 * Called when the server says this person no longer works there. Without it the
 * offline fallback would find a cached "tracking on" from yesterday and start
 * recording again on the next boot — the one case where falling back to the
 * last known answer is exactly wrong.
 */
async function forgetCache(): Promise<void> {
  try {
    await unlink(cachePath())
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') logger.debug(SCOPE, 'Could not clear the remembered policy', error)
  }
}

async function readCache(): Promise<CachedPolicy | null> {
  try {
    const cached = JSON.parse(await readFile(cachePath(), 'utf8')) as CachedPolicy

    if (typeof cached.userId !== 'string' || cached.userId.length === 0) return null

    const age = Date.now() - cached.savedAt
    if (!Number.isFinite(age) || age < 0 || age > CACHE_MAX_AGE_MS) return null

    const trackingEnabled = cached.trackingEnabled === true

    return {
      userId: cached.userId,
      savedAt: cached.savedAt,
      trackingEnabled,
      screenshotsEnabled: cached.screenshotsEnabled === true,
      // Absent from a file written by an older build, which never recorded them.
      appsEnabled: trackingEnabled && cached.appsEnabled === true,
      browserEnabled: trackingEnabled && cached.browserEnabled === true,
      ...schedule({ interval: cached.screenshotIntervalMinutes, idle: cached.idleAfterSeconds }),
      excludedDomains: domains(cached.excludedDomains)
    }
  } catch {
    // Never written, or unreadable. Both mean there is nothing to remember.
    return null
  }
}
