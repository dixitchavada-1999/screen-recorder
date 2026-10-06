import { logger } from '../lib/logger'
import { currentUser } from './auth'
import { syncGoogleCalendars } from './google-calendar'
import { connectedEmails } from './google-accounts'
import { refreshReminders } from './reminders'

const SCOPE = 'google-sync'

/**
 * Keeping imported meetings current while nobody is looking at the Calendar.
 *
 * The Calendar screen syncs whatever window it shows, but only while it is
 * open. The app spends most of its life in the tray, and a meeting added in
 * Google this morning must still get its reminder this afternoon — so the
 * weeks ahead are reconciled on a timer as well.
 */

/** Often enough that a meeting booked for later today is picked up in time. */
const INTERVAL_MS = 10 * 60 * 1000

/** How far ahead is kept in step. Reminders never look further than a day. */
const HORIZON_DAYS = 31

let timer: NodeJS.Timeout | null = null
let running = false

export function startGoogleSync(): void {
  if (timer) return
  timer = setInterval(() => void syncAhead(), INTERVAL_MS)
  logger.info(SCOPE, 'Background calendar sync scheduled', { everyMs: INTERVAL_MS })
}

/**
 * Never throws. A calendar that could not be read now is read again at the next
 * tick, and the Calendar screen reports failures to the person who can fix them.
 */
export async function syncAhead(): Promise<void> {
  // One at a time: a slow Google must not stack a second pass on the first.
  if (running || !currentUser()) return

  running = true
  try {
    if ((await connectedEmails()).length === 0) return

    // From the start of today, so a meeting moved to earlier today is still seen.
    const from = new Date()
    from.setHours(0, 0, 0, 0)
    const to = new Date(from.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000)

    const result = await syncGoogleCalendars({ from: from.toISOString(), to: to.toISOString() })

    if (result.imported + result.updated + result.removed > 0) void refreshReminders()
  } catch (error) {
    logger.warn(SCOPE, 'Background calendar sync failed', error)
  } finally {
    running = false
  }
}
