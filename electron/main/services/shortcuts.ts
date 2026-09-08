import { BrowserWindow, globalShortcut } from 'electron'
import { IPC } from '@shared/ipc'
import type { RecorderStateSync, TrayCommand } from '@shared/types'
import { logger } from '../lib/logger'
import { settingsStore } from './settings-store'

const SCOPE = 'shortcuts'

/**
 * One key that starts and stops a recording from anywhere on the machine.
 *
 * `globalShortcut` and not a menu accelerator, and that is the whole feature:
 * an accelerator only fires while this application has focus, and the moment
 * worth recording is almost always one where it does not — a call is in front,
 * or another window is. This fires whatever is on screen.
 *
 * What it costs is worth stating plainly. A global shortcut is taken from every
 * other application on the machine for as long as this one is running: nothing
 * else sees that key. `Control+Space` in particular is how Windows switches
 * input methods and how most editors ask for autocomplete. It is the default
 * because it was asked for, and it lives in settings so it can be changed
 * without a release.
 */

/** What the recorder was last known to be doing, so one key can mean two things. */
let currentState: RecorderStateSync = {
  state: 'idle',
  elapsedMs: 0,
  canStart: false
}

/** The accelerator actually registered, so it can be released before rebinding. */
let bound: string | null = null

/**
 * Binds the key from settings, releasing whatever was bound before.
 *
 * Answers whether it took. A registration can fail because another application
 * already holds the combination — Windows hands it out first-come — and there
 * is no way to take it, so the honest thing is to report it and let somebody
 * choose a different key.
 */
export function applyShortcuts(): boolean {
  release()

  const accelerator = settingsStore.get().shortcuts.toggleRecording.trim()

  // Empty is a real answer: no global key at all.
  if (!accelerator) {
    logger.info(SCOPE, 'No recording shortcut set')
    return true
  }

  try {
    const registered = globalShortcut.register(accelerator, toggleRecording)

    if (!registered) {
      logger.warn(SCOPE, 'Another application already holds this shortcut', { accelerator })
      return false
    }

    bound = accelerator
    logger.info(SCOPE, 'Recording shortcut registered', { accelerator })
    return true
  } catch (error) {
    // Electron throws on an accelerator it cannot parse, which is what a typo
    // in the settings field looks like from here.
    logger.warn(SCOPE, 'Shortcut could not be registered', { accelerator, error })
    return false
  }
}

/** Whether the key currently in settings is actually held by this app. */
export function shortcutIsActive(): boolean {
  return bound !== null && globalShortcut.isRegistered(bound)
}

export function releaseShortcuts(): void {
  release()
}

/** Kept in step by the same feed the tray uses. */
export function updateShortcutState(next: RecorderStateSync): void {
  currentState = next
}

/* -------------------------------------------------------------------------- */

/**
 * One key, two meanings, decided by what is happening.
 *
 * Start when idle, stop when running — including while paused, where stopping
 * is what somebody pressing it means. Nothing happens when a recording cannot
 * start, rather than starting one that would fail: without a chosen source
 * there is nothing to capture, and a key that silently errors is worse than one
 * that silently waits.
 */
function toggleRecording(): void {
  const { state, canStart } = currentState

  if (state === 'recording' || state === 'paused') {
    send('stop')
    return
  }

  if (state !== 'idle') {
    logger.info(SCOPE, 'Shortcut ignored while busy', { state })
    return
  }

  if (!canStart) {
    logger.info(SCOPE, 'Shortcut ignored, nothing is selected to record')
    return
  }

  send('start')
}

/**
 * Routed through the renderer, like the tray's own buttons.
 *
 * The capture pipeline lives there — `getUserMedia` and the recorder are the
 * window's — so the main process asks rather than does. The window survives
 * being hidden, so this works with nothing on screen.
 */
function send(command: TrayCommand): void {
  const [window] = BrowserWindow.getAllWindows()

  if (!window || window.isDestroyed()) {
    logger.warn(SCOPE, 'Shortcut ignored, no window is available', { command })
    return
  }

  logger.info(SCOPE, 'Shortcut fired', { command })
  window.webContents.send(IPC.EVENT_TRAY_COMMAND, command)
}

function release(): void {
  if (!bound) return

  try {
    globalShortcut.unregister(bound)
  } catch (error) {
    logger.warn(SCOPE, 'Shortcut could not be released', { accelerator: bound, error })
  }

  bound = null
}
