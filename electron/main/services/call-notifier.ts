import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from '../config/supabase'
import { logger } from '../lib/logger'
import { currentUser } from './auth'

const SCOPE = 'call-notifier'

/**
 * Asking the server to send the Slack reminders that have come due.
 *
 * Deliberately dumb. It knows nothing about which calls exist, whose they are
 * or whether anything is due — it asks, every few minutes, and the server works
 * that out. Which means every running copy of the app is a trigger, and a
 * reminder still goes out when the person it is for has their laptop shut: it
 * only takes one machine somewhere to be awake.
 *
 * That also means several machines ask at once, constantly. The server hands
 * each reminder to exactly one of them before anything is sent — Nexus does no
 * de-duplication, and a race here would be a second message in somebody's
 * Slack rather than a wasted request.
 *
 * A cron on the server would be tidier and would not depend on somebody having
 * the app open. This does not need one, and adding a scheduler is a thing to do
 * once the feature has earned it.
 */

/**
 * How often to ask.
 *
 * This is the granularity of the Slack reminder: a warning becomes due at an
 * exact minute, but it is only sent on the next pass after that, so a five
 * minute pass meant a thirty-minute warning could arrive anywhere in the four
 * minutes after 1:30. One minute keeps it within a minute of the moment asked
 * for. The pass itself is nearly free — it usually claims nothing — and the
 * Nexus message budget is untouched, since a message is only sent when there is
 * actually a reminder due.
 */
const INTERVAL_MS = 60 * 1000

let timer: NodeJS.Timeout | null = null

export function startCallNotifier(): void {
  if (timer !== null) return

  timer = setInterval(() => void sendDueReminders(), INTERVAL_MS)
  void sendDueReminders()

  logger.info(SCOPE, 'Reminder sender scheduled', { everyMs: INTERVAL_MS })
}

export function stopCallNotifier(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/**
 * Never throws. A reminder that could not be sent is the server's to retry, and
 * nothing in this process should stop because Slack was busy.
 */
export async function sendDueReminders(): Promise<void> {
  if (!isSupabaseConfigured() || !currentUser()) return

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/notify-due`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: '{}'
    })

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      sent?: number
      failed?: number
      error?: string
      failures?: Array<{ title: string; error: string }>
    }

    if (!response.ok || payload.ok !== true) {
      logger.warn(SCOPE, 'Reminder pass was refused', { status: response.status, ...payload })
      return
    }

    // Silence is the ordinary case, and logging it every five minutes would
    // bury everything else.
    if (payload.sent) logger.info(SCOPE, 'Reminders sent', { count: payload.sent })
    if (payload.failed) {
      logger.warn(SCOPE, 'Some reminders did not arrive', { failures: payload.failures })
    }
  } catch (error) {
    logger.debug(SCOPE, 'Could not ask for a reminder pass', error)
  }
}
