import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '@shared/ipc'
import type { UpdateStatus } from '@shared/types'
import { logger } from '../lib/logger'

const SCOPE = 'updater'

/**
 * First check, once the window has had a moment to itself.
 *
 * Short: the banner is the only way anybody learns a new version exists, and a
 * quarter of a minute of a window that looks up to date is long enough to be
 * read as "there is nothing".
 */
const FIRST_CHECK_DELAY_MS = 2 * 1000

/**
 * And again this often, for a machine that stays open for days.
 *
 * Half an hour rather than six: a release published mid-morning should reach
 * people that morning. The check costs one small request and, when there is
 * nothing new, changes nothing on screen.
 */
const CHECK_INTERVAL_MS = 30 * 60 * 1000

/**
 * Keeps the application up to date, at the user's pace.
 *
 * Nothing here happens on its own beyond the check. The download waits for the
 * button, and so does the restart — a 100 MB transfer nobody asked for, or a
 * window that closes itself in the middle of a call, are both worse than being
 * a version behind for an afternoon.
 *
 * The state lives here rather than in the renderer because a window can be
 * closed to the tray and reopened, and the answer to "is there an update" must
 * survive that. A window that opens late asks for the state and gets whatever
 * has happened so far.
 */

let status: UpdateStatus = {
  state: 'idle',
  version: null,
  progress: null,
  message: null,
  checkedAt: null
}

let timer: ReturnType<typeof setInterval> | null = null

export function initUpdater(): void {
  /*
   * There is nothing to replace in development, and a portable build is a
   * single file the user placed themselves — writing over it is not ours to do.
   * Saying so plainly beats a check that fails with a confusing error.
   */
  if (!app.isPackaged) {
    set({ state: 'unsupported', message: 'Updates are checked in the installed application.' })
    return
  }

  if (process.env.PORTABLE_EXECUTABLE_FILE) {
    set({
      state: 'unsupported',
      message: 'This is the portable build. Download a new one to update.'
    })
    return
  }

  /*
   * Nothing moves until somebody presses Upgrade.
   *
   * A hundred-odd megabytes is not a thing to spend on a machine's connection
   * without being asked — somebody on a phone hotspot would have paid for it
   * before noticing. Pressing Upgrade is the ask, and from there the whole of
   * it runs through without another prompt: download, install, restart.
   *
   * `autoInstallOnAppQuit` catches the other way out. Somebody who quits from
   * the tray, or shuts the machine down, never presses Restart — and with the
   * app starting again at every login, an update that only ever applied on that
   * button would sit downloaded for weeks. Quitting applies it instead, and the
   * next launch is simply the new version.
   *
   * Safe at that point: the quit handler has already flushed and closed any
   * recording before the process exits, and the installer runs after it.
   */
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  /*
   * A check in progress is only worth showing when nothing better is known.
   * Once an update has been found the banner stays put through every later
   * check — flickering back to "checking…" and returning would make the one
   * thing the user is meant to act on blink in and out.
   */
  autoUpdater.on('checking-for-update', () => {
    if (status.state === 'idle' || status.state === 'error') {
      set({ state: 'checking', message: null })
    }
  })

  autoUpdater.on('update-available', (info) => {
    logger.info(SCOPE, 'Update available', { version: info.version })
    set({
      state: 'available',
      version: info.version,
      message: null,
      checkedAt: new Date().toISOString()
    })
  })

  autoUpdater.on('update-not-available', () => {
    set({
      state: 'idle',
      version: null,
      progress: null,
      message: null,
      checkedAt: new Date().toISOString()
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    set({ state: 'downloading', progress: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(SCOPE, 'Update downloaded', { version: info.version })
    set({ state: 'ready', version: info.version, progress: 100, message: null })

    /*
     * Upgrade was one button and means one thing, so the restart follows on its
     * own rather than asking a second time for something already agreed to.
     *
     * The pause is for the person, not the machine: it lets the banner say what
     * is about to happen before the window goes, so the app closing reads as the
     * update finishing rather than as a crash.
     */
    setTimeout(() => installUpdate(), 1500)
  })

  autoUpdater.on('error', (error: Error) => {
    logger.warn(SCOPE, 'Update check or download failed', error)

    /*
     * A failed check does not un-publish the release.
     *
     * If a version is already known to be waiting, a dropped connection on a
     * later check leaves the offer exactly where it was — otherwise a moment of
     * bad network would hide an update the user had already been shown, and
     * they would have no way back to it. A failure *during a download* is
     * different: that one they asked for and are watching, so it is reported.
     */
    if (status.state === 'available' && status.version) return

    set({
      state: 'error',
      progress: null,
      // The raw message names files and URLs; this is the half a user can act on.
      message: 'Could not reach the update server.'
    })
  })

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** The state a window asks for when it opens. */
export function updateStatus(): UpdateStatus {
  return status
}

/**
 * Asks whether there is a newer version.
 *
 * Never throws: a machine offline, or a release that has not been published
 * yet, is an ordinary state of the world rather than a failure the caller has
 * to handle. The `error` event above turns it into something the banner shows.
 */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (status.state === 'unsupported') return status

  // Downloading or already downloaded — checking again would restart it.
  if (status.state === 'downloading' || status.state === 'ready') return status

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    logger.warn(SCOPE, 'Update check failed', error)
  }

  return status
}

/** Starts the download of the version that was found. */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (status.state !== 'available') return status

  set({ state: 'downloading', progress: 0, message: null })

  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    logger.warn(SCOPE, 'Update download failed', error)
    set({ state: 'error', progress: null, message: 'The download did not finish.' })
  }

  return status
}

/**
 * Quits and installs what has been downloaded.
 *
 * Returns only if the install could not be started; on success this process is
 * already on its way out.
 */
export function installUpdate(): void {
  if (status.state !== 'ready') return

  logger.info(SCOPE, 'Installing update', { version: status.version })

  /*
   * `isSilent: true` keeps the installer's own window off the screen, and
   * `isForceRunAfter: true` brings the new version back up afterwards. Together
   * the app closes and reopens updated, which is the whole of what the person
   * pressing Restart asked for — a setup wizard appearing over their desktop is
   * a step they did not.
   *
   * The install cannot happen any earlier than this. Windows will not replace
   * the files of a running program, so quitting *is* the install; there is no
   * arrangement in which it finishes while the app is still open.
   */
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}

/* -------------------------------------------------------------------------- */

/** Records the new state and tells every open window about it. */
function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.EVENT_UPDATE_STATUS, status)
  }
}
