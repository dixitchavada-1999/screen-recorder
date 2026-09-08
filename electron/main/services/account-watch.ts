import { BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { AuthUser } from '@shared/types'
import { logger } from '../lib/logger'
import { currentUser, refreshAccount } from './auth'

const SCOPE = 'account-watch'

/**
 * How often a signed-in window checks whether its access has changed.
 *
 * A minute, and the number is a judgement about what it costs to be wrong in
 * each direction. Too slow and somebody keeps a button they should have lost;
 * too fast and every open copy asks the server for a profile it already has,
 * all day, for a change that happens twice a month.
 *
 * The window also re-reads whenever it regains focus, which in practice is what
 * catches almost every change — this is the floor under that, for a window
 * sitting open on a second monitor that nobody has clicked on.
 */
const EVERY_MS = 60_000

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Keeps a running window's idea of what it may do in step with the database.
 *
 * Permissions are resolved once and cached — they have to be, or every render
 * would be a round trip. The cost is that a role edited elsewhere leaves a
 * window offering things the database will refuse, which reads as the app being
 * broken rather than as access having changed.
 *
 * Polled rather than subscribed, which is this project's existing answer to
 * exactly this question — `tracking-policy.ts` says the same thing for the same
 * reason. A realtime channel would be fewer round trips and one more moving
 * part that has to reconnect correctly for the app to stay honest.
 */
export function startAccountWatch(): void {
  if (timer) return

  timer = setInterval(() => void check(), EVERY_MS)
  logger.info(SCOPE, 'Watching for permission changes', { everyMs: EVERY_MS })
}

export function stopAccountWatch(): void {
  if (!timer) return

  clearInterval(timer)
  timer = null
}

/* -------------------------------------------------------------------------- */

async function check(): Promise<void> {
  const before = currentUser()
  if (!before) return

  try {
    const after = await refreshAccount()
    if (!after || same(before, after)) return

    logger.info(SCOPE, 'Access changed', { role: after.roleKey })
    announce(after)
  } catch (error) {
    // A failed check says nothing about the account. It is tried again in a
    // minute, and the window keeps what it has until then.
    logger.warn(SCOPE, 'Could not check for permission changes', error)
  }
}

/**
 * Whether two readings of an account say the same thing.
 *
 * Only the parts that decide what a window offers. A name or an address
 * changing is not a reason to redraw every screen.
 */
function same(before: AuthUser, after: AuthUser): boolean {
  return (
    before.roleKey === after.roleKey &&
    before.fullAccess === after.fullAccess &&
    before.permissions.length === after.permissions.length &&
    before.permissions.every((permission) => after.permissions.includes(permission))
  )
}

function announce(account: AuthUser): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.EVENT_ACCOUNT_CHANGED, account)
  }
}
