import type { AppSettings } from '@shared/types'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'
import { settingsStore } from './settings-store'

const SCOPE = 'reminder-prefs'

/**
 * Making one person's choice of warnings visible to the server.
 *
 * The choice itself stays where it was — in this machine's settings file, read
 * by the reminder scheduler, working with no network. Nothing about that
 * changes, and it must not: a desktop notification is something this computer
 * pops up.
 *
 * But the Slack message is sent by the server, for a call that is somebody
 * else's, and it has to arrive when *that* person asked to be warned. Their
 * preference is on their own laptop, where the server cannot see it. So it is
 * mirrored onto their profile row.
 *
 * One writer, one reader. The app writes; `claim_due_notifications` reads. The
 * mirror is never read back, which is what keeps the two from disagreeing about
 * which is authoritative — the file is, always.
 */

/** Values the server's constraint accepts. Anything else is dropped. */
const ALLOWED = new Set([0, 5, 10, 15, 30, 60, 120, 1440])

/** What was last sent, so an unchanged setting costs nothing. */
let lastSent: string | null = null

export function startReminderPrefs(): void {
  settingsStore.on('changed', (settings: AppSettings) => void mirror(settings))
  void mirror(settingsStore.get())
}

/**
 * Mirrors the current preference now.
 *
 * Called after signing in, and after a stored session is restored. Starting the
 * app is not enough on its own: this runs a few seconds before the session
 * comes back, finds nobody signed in and does nothing — and then waits for a
 * settings change that never comes, because the person had already chosen their
 * warnings weeks ago.
 */
export async function refreshReminderPrefs(): Promise<void> {
  await mirror(settingsStore.get())
}

/**
 * Forgets what was last sent, so the next mirror writes even if the numbers are
 * the same. Called when the account changes — the new person's profile has not
 * been told anything.
 */
export function resetReminderPrefs(): void {
  lastSent = null
}

/**
 * Never throws. A preference that did not reach the server means somebody's
 * Slack reminder arrives at the default fifteen minutes rather than the thirty
 * they asked for, which is a disappointment and not a failure.
 */
async function mirror(settings: AppSettings): Promise<void> {
  const user = currentUser()
  if (!user) return

  const { notifications } = settings

  /*
   * An empty list is a real answer, not a missing one.
   *
   * Somebody who turns reminders off, or picks no lead times, is asking not to
   * be interrupted — and that has to reach Slack too, or the one place they
   * cannot switch off keeps talking to them.
   */
  const leads = notifications.enabled
    ? [...new Set(notifications.leadMinutes)].filter((value) => ALLOWED.has(value)).sort((a, b) => b - a)
    : []

  const encoded = JSON.stringify(leads)
  if (encoded === lastSent) return

  const { error } = await getSupabase()
    .from('profiles')
    .update({ reminder_lead_minutes: leads })
    .eq('id', user.id)

  if (error) {
    logger.warn(SCOPE, 'Could not mirror the reminder preference', error)
    return
  }

  lastSent = encoded
  logger.info(SCOPE, 'Reminder preference mirrored', { leads })
}
