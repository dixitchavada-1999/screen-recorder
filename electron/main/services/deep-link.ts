import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { PROTOCOL_SCHEME } from '../config/deep-link'
import { toSerializedError } from '../lib/errors'
import { logger } from '../lib/logger'
import { applyAuthCallback } from './auth'
import { showMainWindow } from '../window'

const SCOPE = 'deep-link'

/**
 * Links that come back into the app from a browser.
 *
 * Email confirmation is the reason this exists: Supabase opens the user's
 * browser, the browser hands `screenrecorder://auth/callback#…` to the OS, and
 * the OS starts (or wakes) this app with that URL. Every platform delivers it
 * differently, which is what the three entry points below are for.
 */

/**
 * Claims the scheme with the OS.
 *
 * In development the running binary is Electron itself, so the registration has
 * to name the app directory as well — otherwise the OS would launch a bare
 * Electron with nothing to open.
 *
 * That path must be absolute. The OS starts the app from its own working
 * directory (`C:\Windows\system32` when a browser hands over a link), so the
 * `.` that `npm run dev` passes would be resolved against the wrong folder and
 * Electron would report "Unable to find Electron app".
 */
export function registerProtocolClient(): void {
  const appPath = process.argv[1] ? resolve(process.argv[1]) : null

  const registered =
    process.defaultApp && appPath
      ? app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [appPath])
      : app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)

  logger.info(SCOPE, 'Protocol client registration', {
    scheme: PROTOCOL_SCHEME,
    registered,
    ...(appPath ? { appPath } : {})
  })
}

/**
 * Picks the deep link out of a command line.
 *
 * Windows and Linux pass the URL as an ordinary argument — on a cold start it
 * sits in `process.argv`, on a warm one it arrives with `second-instance`.
 */
export function findDeepLink(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`)) ?? null
}

/**
 * Handles one incoming link.
 *
 * The window is raised first: the user just clicked something in their browser
 * and expects the app to come forward, whether the link turns out to carry a
 * session or not.
 */
export async function handleDeepLink(url: string): Promise<void> {
  logger.info(SCOPE, 'Received deep link', { path: safePath(url) })

  showMainWindow()

  try {
    const user = await applyAuthCallback(url)
    if (user) broadcast(IPC.EVENT_AUTH_CHANGED, user)
  } catch (error) {
    logger.error(SCOPE, 'Could not complete the link', error)
    broadcast(IPC.EVENT_AUTH_ERROR, toSerializedError(error))
  }
}

/* -------------------------------------------------------------------------- */

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

/**
 * The path alone, never the fragment — that is where the access token lives and
 * the log file is not the place for it.
 */
function safePath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return '(unparseable)'
  }
}
