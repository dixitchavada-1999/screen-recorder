import { app, Menu, nativeImage, Tray, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { RecorderStateSync, TrayCommand } from '@shared/types'
import { logger } from '../lib/logger'
import { currentUser } from './auth'
import { settingsStore } from './settings-store'

const SCOPE = 'tray'

/**
 * System tray icon and menu.
 *
 * The app lives in the tray rather than the taskbar, so this menu is the
 * primary way to reach it: the window can be shown or hidden from here, and a
 * recording can be driven start-to-finish without ever opening the window.
 *
 * The tray does not own any recording state. The renderer pushes a snapshot
 * through `recorder:state-sync`, and commands travel back the other way as
 * `event:tray-command`, keeping a single pipeline implementation.
 */

let tray: Tray | null = null

let currentState: RecorderStateSync = {
  state: 'idle',
  elapsedMs: 0,
  canStart: false
}

/** Callbacks supplied by the app shell so this module stays decoupled. */
interface TrayCallbacks {
  onShowWindow: () => void
  onHideWindow: () => void
  onQuit: () => void
}

let callbacks: TrayCallbacks | null = null

/* -------------------------------------------------------------------------- */
/*                                    Icon                                    */
/* -------------------------------------------------------------------------- */

/** Every place the build might have put an image asset, most specific first. */
function assetCandidates(fileName: string): string[] {
  return [
    join(process.resourcesPath, 'build', fileName),
    join(app.getAppPath(), 'build', fileName),
    join(__dirname, `../../build/${fileName}`)
  ]
}

/**
 * Loads the tray image.
 *
 * macOS wants a template image: black artwork plus alpha, which the system
 * tints for the light or dark menu bar and renders at the right density from
 * the @2x file sitting next to it. The colourful app icon would ignore both.
 *
 * Windows and Linux want the opposite — a normal coloured icon — and the
 * generated 512px app icon is downscaled to the 16px the tray expects, because
 * handing `Tray` the full-size image produces a blurred or oversized icon.
 */
function loadTrayIcon(): Electron.NativeImage {
  if (process.platform === 'darwin') {
    for (const candidate of assetCandidates('trayTemplate.png')) {
      if (!existsSync(candidate)) continue

      const image = nativeImage.createFromPath(candidate)
      if (image.isEmpty()) continue

      image.setTemplateImage(true)
      return image
    }

    logger.warn(SCOPE, 'Tray template asset not found, falling back to the app icon')
  }

  for (const candidate of assetCandidates('icon.png')) {
    if (!existsSync(candidate)) continue

    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) {
      return image.resize({ width: 16, height: 16, quality: 'best' })
    }
  }

  logger.warn(SCOPE, 'Tray icon asset not found, falling back to an empty image')
  return nativeImage.createEmpty()
}

/* -------------------------------------------------------------------------- */
/*                                    Menu                                    */
/* -------------------------------------------------------------------------- */

function sendCommand(command: TrayCommand): void {
  const [window] = BrowserWindow.getAllWindows()
  if (!window || window.isDestroyed()) {
    logger.warn(SCOPE, 'Tray command ignored, no window is available', { command })
    return
  }

  logger.info(SCOPE, 'Tray command issued', { command })
  window.webContents.send(IPC.EVENT_TRAY_COMMAND, command)
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(
    total % 60
  )}`
}

function buildMenu(): Electron.Menu {
  const { state, canStart } = currentState
  const { tracking } = settingsStore.get()

  const isRecording = state === 'recording'
  const isPaused = state === 'paused'
  const isLive = isRecording || isPaused
  const isBusy = state === 'preparing' || state === 'stopping' || state === 'processing'

  const statusLabel = isLive
    ? `${isPaused ? 'Paused' : 'Recording'} — ${formatElapsed(currentState.elapsedMs)}`
    : isBusy
      ? `${state.charAt(0).toUpperCase()}${state.slice(1)}…`
      : 'Idle'

  return Menu.buildFromTemplate([
    { label: `Screen Recorder — ${statusLabel}`, enabled: false },
    { type: 'separator' },

    {
      label: 'Show App',
      click: () => callbacks?.onShowWindow()
    },
    {
      label: 'Hide App',
      click: () => callbacks?.onHideWindow()
    },
    { type: 'separator' },

    {
      label: 'Start Recording',
      // Without a selected source there is nothing to capture; the renderer
      // reports whether a start is currently possible.
      enabled: !isLive && !isBusy && canStart,
      click: () => sendCommand('start')
    },
    {
      label: isPaused ? 'Resume Recording' : 'Pause Recording',
      enabled: isLive,
      click: () => sendCommand(isPaused ? 'resume' : 'pause')
    },
    {
      label: 'Stop Recording',
      enabled: isLive,
      click: () => sendCommand('stop')
    },
    { type: 'separator' },

    /*
     * Activity tracking, stated whether or not it is running.
     *
     * A line that only appears while tracking is on would leave "is this thing
     * watching me?" answerable only by opening the app. Saying "Activity
     * tracking: off" costs one row and answers it from the menu bar.
     *
     * Stopping is offered here; starting is not. Turning it on belongs where
     * the disclosure is, and that is Settings.
     */
    {
      label: `Activity tracking: ${tracking.enabled ? 'on' : 'off'}`,
      enabled: false
    },
    // Stopping is an administrator's, so the item only exists for one. The line
    // above stays for everybody: whether it is running is not a secret, only
    // the switch is.
    ...(tracking.enabled && currentUser()?.role === 'super_admin'
      ? [
          {
            label: 'Stop Tracking',
            click: () => stopTracking()
          } satisfies Electron.MenuItemConstructorOptions
        ]
      : []),
    { type: 'separator' },

    {
      label: 'Quit',
      click: () => callbacks?.onQuit()
    }
  ])
}

/**
 * Switches tracking off from the tray.
 *
 * Writes the setting rather than telling the renderer to: the tray has to work
 * with the window closed, and the settings store broadcasts the change to
 * whatever is open anyway.
 */
function stopTracking(): void {
  settingsStore.update({ tracking: { enabled: false } })
  logger.info(SCOPE, 'Tracking stopped from the tray')
}

/** Rebuilds the menu and refreshes the tooltip. */
function refresh(): void {
  if (!tray) return

  tray.setContextMenu(buildMenu())

  const { state } = currentState
  const tracking = settingsStore.get().tracking.enabled ? ' · tracking activity' : ''

  const tooltip =
    state === 'recording'
      ? `Screen Recorder — recording ${formatElapsed(currentState.elapsedMs)}`
      : state === 'paused'
        ? `Screen Recorder — paused ${formatElapsed(currentState.elapsedMs)}`
        : `Screen Recorder${tracking}`

  tray.setToolTip(tooltip)
}

/* -------------------------------------------------------------------------- */
/*                                   Public                                   */
/* -------------------------------------------------------------------------- */

export function createTray(handlers: TrayCallbacks): void {
  if (tray) return

  callbacks = handlers
  tray = new Tray(loadTrayIcon())

  // Clicking the icon toggles the window, matching common tray-app behaviour.
  tray.on('click', () => handlers.onShowWindow())
  tray.on('double-click', () => handlers.onShowWindow())

  // Tracking can be switched from the window, from here, or by a settings
  // change anywhere else — the menu follows the setting rather than whoever
  // happened to flip it.
  settingsStore.on('changed', () => refresh())

  refresh()
  logger.info(SCOPE, 'Tray created')
}

/** Applies a state snapshot pushed by the renderer. */
export function updateTrayState(next: RecorderStateSync): void {
  const stateChanged = next.state !== currentState.state
  const canStartChanged = next.canStart !== currentState.canStart

  // The elapsed time arrives several times a second; only the seconds digit
  // is displayed, so rebuilding the menu more often than that is wasted work.
  const secondsChanged =
    Math.floor(next.elapsedMs / 1000) !== Math.floor(currentState.elapsedMs / 1000)

  currentState = next

  if (stateChanged || canStartChanged || secondsChanged) refresh()
}

export function destroyTray(): void {
  if (!tray) return

  tray.destroy()
  tray = null
  callbacks = null
  logger.info(SCOPE, 'Tray destroyed')
}
