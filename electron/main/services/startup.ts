import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from '../lib/logger'

const SCOPE = 'startup'

/**
 * Starting with the machine.
 *
 * Two mechanisms, because the platforms disagree. Windows and macOS both take
 * a login item through Electron; Linux has no such API and wants a desktop
 * entry dropped into an autostart folder, which this writes and removes itself.
 *
 * A tray app launched at login should not throw a window at somebody who is
 * still logging in, so every route here asks for a hidden start and
 * `wasLaunchedAtLogin()` tells the window layer to honour it.
 */

/** Passed on the command line so a hidden start is recognisable on every OS. */
export const HIDDEN_FLAG = '--hidden'

/** The autostart entry's filename on Linux. */
const DESKTOP_ENTRY = 'screen-recorder.desktop'

/**
 * True when this launch came from the login item rather than from a person.
 *
 * macOS reports it properly; elsewhere the flag put on the command line when
 * the entry was created is the signal.
 */
export function wasLaunchedAtLogin(): boolean {
  if (process.argv.includes(HIDDEN_FLAG)) return true

  if (process.platform === 'darwin') {
    const { wasOpenedAtLogin, wasOpenedAsHidden } = app.getLoginItemSettings()
    return wasOpenedAtLogin || wasOpenedAsHidden
  }

  return false
}

/**
 * Applies the setting to the OS.
 *
 * Never touches anything in development: registering a login item there would
 * point at the Electron binary in `node_modules` and quietly survive the
 * project being deleted. The setting is still stored, so a packaged build picks
 * it up on first run.
 */
export async function applyLoginItem(enabled: boolean): Promise<void> {
  if (!app.isPackaged) {
    logger.debug(SCOPE, 'Login item not applied in development', { enabled })
    return
  }

  try {
    if (process.platform === 'linux') await applyLinuxAutostart(enabled)
    else applyElectronLoginItem(enabled)

    logger.info(SCOPE, 'Login item updated', { enabled, platform: process.platform })
  } catch (error) {
    logger.warn(SCOPE, 'Could not update the login item', error)
  }
}

/* -------------------------------------------------------------------------- */
/*                              Windows and macOS                             */
/* -------------------------------------------------------------------------- */

function applyElectronLoginItem(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    // macOS honours this directly. Windows ignores it, which is why the flag
    // below is also passed — between them every platform starts out of sight.
    openAsHidden: enabled,
    args: enabled ? [HIDDEN_FLAG] : []
  })

  if (enabled) removeStaleWindowsLoginItem()
}

/**
 * Removes the login entry Electron wrote before this build named the app.
 *
 * Setting an AppUserModelID moved the startup registry value from
 * `electron.app.Screen Recorder` to the app id, and Electron never cleans up
 * the old key. Left in place it is a second entry pointing at the same exe, so
 * two copies race at boot — harmless once the loser knows to stay hidden, but
 * two lines in Task Manager's startup list and one wasted launch. This deletes
 * the orphan. Best effort, and Windows only.
 */
function removeStaleWindowsLoginItem(): void {
  if (process.platform !== 'win32') return

  execFile(
    'reg',
    [
      'delete',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v',
      'electron.app.Screen Recorder',
      '/f'
    ],
    { windowsHide: true },
    (error) => {
      // A missing value is the outcome we want and reports itself as an error;
      // only a real failure is worth a line.
      if (error && !/cannot find|unable to find/i.test(error.message)) {
        logger.debug(SCOPE, 'Could not remove the stale login item', error)
      }
    }
  )
}

/* -------------------------------------------------------------------------- */
/*                                    Linux                                   */
/* -------------------------------------------------------------------------- */

/**
 * `~/.config/autostart/screen-recorder.desktop`.
 *
 * `setLoginItemSettings` is a no-op on Linux — Electron dropped the
 * implementation, and there is no single mechanism to reinstate. The XDG
 * autostart directory is the one thing every desktop environment reads, so the
 * entry is written by hand and deleted again when the setting goes off.
 */
async function applyLinuxAutostart(enabled: boolean): Promise<void> {
  const path = autostartPath()

  if (!enabled) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      // Already gone is the outcome that was asked for.
      if (error.code !== 'ENOENT') throw error
    })
    return
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, desktopEntry(), 'utf8')
}

function autostartPath(): string {
  // XDG_CONFIG_HOME when the session sets it; the documented default otherwise.
  const configHome = process.env.XDG_CONFIG_HOME || join(app.getPath('home'), '.config')
  return join(configHome, 'autostart', DESKTOP_ENTRY)
}

function desktopEntry(): string {
  /*
   * An AppImage reports its own extracted binary in `process.execPath`, which
   * disappears the moment the app exits. `APPIMAGE` holds the path to the file
   * the user actually keeps, so that is what the entry has to point at.
   */
  const executable = process.env.APPIMAGE || process.execPath

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Screen Recorder',
    'Comment=Screen recorder, running in the tray',
    `Exec="${executable}" ${HIDDEN_FLAG}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}
