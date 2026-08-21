import { BrowserWindow, Notification, powerMonitor } from 'electron'
import { IPC } from '@shared/ipc'
import type { CallReminder, ScheduledCall } from '@shared/types'
import { logger } from '../lib/logger'
import { currentUser } from './auth'
import { listCalls, markMissedCalls } from './calls'
import { settingsStore } from './settings-store'
import { showMainWindow } from '../window'

const SCOPE = 'reminders'

/**
 * Warns about calls that are about to start.
 *
 * Two layers, because neither alone is enough: an OS notification reaches the
 * user with the window hidden in the tray, and an in-app toast is what they see
 * if the window is already in front of them.
 *
 * Timers rather than a ticking clock — one `setTimeout` per reminder fires at
 * the right second, where a poll would have to run every minute forever and
 * still land up to a minute late.
 *
 * Everything here fires *before* a call. Once a call is over there is nothing
 * left to warn about, so a call nobody marked is quietly recorded as missed and
 * left for the Call Manager to show.
 */

/** How far ahead reminders are armed. Anything later is picked up by a refresh. */
const LOOKAHEAD_MS = 6 * 60 * 60 * 1000

/** Re-reads the schedule, catching calls added on another machine. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000

/**
 * A timer that fires this far behind schedule is dropped.
 *
 * `setTimeout` does not run while the machine is asleep; on wake it fires
 * immediately, which without this would announce "in 30 minutes" about a call
 * that ended an hour ago.
 */
const LATE_TOLERANCE_MS = 2 * 60 * 1000

/**
 * How long after a call's end the missed check runs.
 *
 * Slightly longer than the grace period `markMissedCalls` applies, so the
 * timer never arrives a second too early to find anything.
 */
const MISSED_CHECK_DELAY_MS = 3 * 60 * 1000

/** Armed reminders, keyed `callId:leadMinutes` so a refresh cannot double-arm. */
const timers = new Map<string, NodeJS.Timeout>()

/** Reminders already delivered this session, same key. */
const fired = new Set<string>()

let refreshTimer: NodeJS.Timeout | null = null
let refreshing = false

export function startReminders(): void {
  if (refreshTimer) return

  refreshTimer = setInterval(() => void refreshReminders(), REFRESH_INTERVAL_MS)

  // Sleeping through a reminder is the common way to miss one: every armed
  // timer is stale on wake, so they are all rebuilt from the current time.
  powerMonitor.on('resume', () => {
    logger.debug(SCOPE, 'Machine resumed, rebuilding reminders')
    void refreshReminders()
  })

  settingsStore.on('changed', () => void refreshReminders())

  void refreshReminders()
  logger.info(SCOPE, 'Reminder scheduler started')
}

export function stopReminders(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  clearTimers()
}

/**
 * Rebuilds every armed reminder from the current schedule and settings.
 *
 * Cheap to call: it is what runs after any change to a call, after a sign-in,
 * and on the interval.
 */
export async function refreshReminders(): Promise<void> {
  if (refreshing) return
  refreshing = true

  try {
    // The schedule belongs to an account; with nobody signed in there is
    // nothing to remind anyone about.
    if (!currentUser()) {
      clearTimers()
      return
    }

    // Bookkeeping rather than a warning, so it runs whatever the notification
    // settings say — somebody who has turned reminders off still wants their
    // Call Manager to be right.
    await sweepMissed()

    const { notifications } = settingsStore.get()

    if (!notifications.enabled || notifications.leadMinutes.length === 0) {
      clearTimers()
      return
    }

    const now = Date.now()
    const calls = await listCalls({
      from: new Date(now).toISOString(),
      to: new Date(now + LOOKAHEAD_MS).toISOString()
    })

    clearTimers()

    for (const call of calls) {
      if (call.status !== 'scheduled') continue

      for (const lead of notifications.leadMinutes) {
        arm(call, lead, now)
      }

      // Wake up shortly after it ends, so a call that goes by untouched is
      // settled then rather than waiting for the next five-minute sweep.
      armMissedCheck(call, now)
    }

    logger.debug(SCOPE, 'Reminders armed', { armed: timers.size, calls: calls.length })
  } catch (error) {
    // A failed refresh must not take the scheduler down; the interval will try
    // again, and a missing table or a dropped connection is not fatal here.
    logger.warn(SCOPE, 'Could not refresh reminders', error)
  } finally {
    refreshing = false
  }
}

/* -------------------------------------------------------------------------- */

function arm(call: ScheduledCall, leadMinutes: number, now: number): void {
  const key = `${call.id}:${leadMinutes}`
  if (fired.has(key)) return

  const fireAt = new Date(call.startsAt).getTime() - leadMinutes * 60_000
  const delay = fireAt - now

  // Already past, or beyond the window this pass covers.
  if (delay <= 0 || delay > LOOKAHEAD_MS) return

  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)

      if (Date.now() - fireAt > LATE_TOLERANCE_MS) {
        logger.debug(SCOPE, 'Skipping a reminder that came due while asleep', { key })
        return
      }

      fired.add(key)
      deliver(call, leadMinutes)
    }, delay)
  )
}

/**
 * Wakes up just after a call ends to settle it if it was left untouched.
 *
 * The check itself is `sweepMissed`, which is also run on every refresh; this
 * only makes it happen promptly for a call ending while the app is open.
 */
function armMissedCheck(call: ScheduledCall, now: number): void {
  const key = `${call.id}:missed-check`
  const endsAt =
    new Date(call.startsAt).getTime() + call.durationMinutes * 60_000 + MISSED_CHECK_DELAY_MS

  const delay = endsAt - now
  if (delay <= 0 || delay > LOOKAHEAD_MS) return

  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      void sweepMissed()
    }, delay)
  )
}

/**
 * Records calls that went by without being marked.
 *
 * Silent by design: the status lands in the Call Manager, where the user finds
 * it when they next look, rather than arriving as a notification about
 * something already over and no longer actionable.
 */
async function sweepMissed(): Promise<void> {
  if (!currentUser()) return

  try {
    const missed = await markMissedCalls()

    for (const call of missed) {
      logger.info(SCOPE, 'Missed call', { title: call.title, startsAt: call.startsAt })
    }
  } catch (error) {
    logger.warn(SCOPE, 'Could not check for missed calls', error)
  }
}

/**
 * Announces an upcoming call through both enabled channels.
 *
 * An OS notification reaches the user with the window hidden in the tray; the
 * in-app event is what they see if the window is already in front of them.
 */
function deliver(call: ScheduledCall, leadMinutes: number): void {
  logger.info(SCOPE, 'Reminder fired', { title: call.title, leadMinutes })

  const { notifications } = settingsStore.get()
  const body = describe(call, leadMinutes)

  if (notifications.systemNotifications && Notification.isSupported()) {
    const notification = new Notification({
      title: call.title,
      body,
      // A call about to start is worth interrupting for.
      urgency: 'critical'
    })

    // Clicking it is a request to look at the call.
    notification.on('click', () => showMainWindow())
    notification.show()
  }

  if (notifications.inAppNotifications) {
    const payload: CallReminder = {
      callId: call.id,
      title: call.title,
      startsAt: call.startsAt,
      leadMinutes
    }

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.EVENT_CALL_REMINDER, payload)
    }
  }
}

/** "Starts in 30 minutes · 6:00 PM" — the countdown and the actual time. */
function describe(call: ScheduledCall, leadMinutes: number): string {
  const lines: string[] = [`${dateLabel(call)} at ${startLabel(call)}`]

  const people = call.assignees.map((person) => person.name).filter(Boolean)
  if (people.length > 0) lines.push(`\u{1F464} ${people.join(', ')}`)

  const note = call.notes.trim()
  if (note) lines.push(`\u{1F4DD} ${note.length > 120 ? `${note.slice(0, 117)}…` : note}`)

  lines.push(
    leadMinutes === 0
      ? 'Starting now'
      : `Starts in ${leadMinutes} minute${leadMinutes === 1 ? '' : 's'}`
  )

  return lines.join('\n')
}

/** "Today" / "Tomorrow" / "Mon, 25 Aug" — the day the call falls on. */
function dateLabel(call: ScheduledCall): string {
  const start = new Date(call.startsAt)
  const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const today = new Date()
  const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const days = Math.round((startDay.getTime() - todayDay.getTime()) / 86_400_000)

  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return start.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

/** The start time, as the user's own clock would show it. */
function startLabel(call: ScheduledCall): string {
  return new Date(call.startsAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
}

function clearTimers(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}
