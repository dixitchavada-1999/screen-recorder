import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { logger } from './lib/logger'
import { settingsStore } from './services/settings-store'

const SCOPE = 'window'

let mainWindow: BrowserWindow | null = null

/**
 * Set immediately before the app really exits, so the window's `close` handler
 * knows to let the close through instead of hiding to the tray.
 */
let quitting = false

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setQuitting(value: boolean): void {
  quitting = value
}

/**
 * Brings the window back from the tray.
 *
 * Coming back from the tray lands on the Recorder, not on wherever the window
 * was when it was put away. The renderer stays alive while hidden, so without
 * this the app would reopen on, say, the Call Manager somebody left it on days
 * ago — the tray is how you reach the recorder, and that is what it should
 * show. The signal only fires on a real hidden→visible transition, so it never
 * yanks the view out from under someone already using the window.
 */
export function showMainWindow(): void {
  const window = mainWindow ?? createMainWindow()

  const wasHidden = !window.isVisible() || window.isMinimized()

  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()

  if (wasHidden && !window.isDestroyed()) {
    window.webContents.send(IPC.EVENT_WINDOW_SHOWN)
  }
}

/** Hides the window to the tray without tearing down the renderer. */
export function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
}

/**
 * Shows or hides the window's taskbar button to match the setting.
 *
 * The tray is always the way back; this only decides whether an ordinary
 * taskbar button sits alongside it. No effect on macOS, which has no taskbar —
 * the Dock icon belongs to the application there, not to the window.
 */
export function applyTaskbarVisibility(show: boolean): void {
  if (process.platform === 'darwin') return
  const window = mainWindow
  if (!window || window.isDestroyed()) return

  window.setSkipTaskbar(!show)

  /*
   * Windows only reliably re-adds the taskbar button when the window is
   * re-registered with the shell, which a hide→show forces. `setSkipTaskbar`
   * alone removes the button but often fails to put it back on a window that
   * was created without one. Done directly here rather than through
   * `showMainWindow`, so it raises no "window shown" signal and never resets
   * the view the user is looking at. Only when turning the button *on*, and
   * only while the window is actually on screen — the other direction and a
   * hidden window both work without it.
   */
  if (process.platform === 'win32' && show && window.isVisible()) {
    window.hide()
    window.show()
  }

  logger.info(SCOPE, 'Taskbar button', { shown: show })
}

/**
 * True while the window was put away for a recording rather than by the user.
 *
 * Only the Linux path sets it, and only that path reads it: restoring has to
 * know the difference between a window this module hid a moment ago and one the
 * user had deliberately sent to the tray before they ever pressed record.
 */
let hiddenForCapture = false

/**
 * Keeps the window out of whatever is being recorded.
 *
 * The one thing a screen recorder must never film is itself. On a full-screen
 * capture its own window is in shot from the first frame — showing a preview of
 * the capture, inside the capture — which is both useless footage and the thing
 * everybody notices first.
 *
 * Windows and macOS can do this properly. `setContentProtection` asks the
 * compositor to leave the window out of every capture pipeline
 * (`WDA_EXCLUDEFROMCAPTURE`, `NSWindowSharingNone`), so it stays on screen and
 * fully usable while being absent from the recording — which is the better
 * outcome anyway: somebody can watch the elapsed time while they record.
 *
 * Linux has no equivalent and Electron's implementation is a no-op there, so
 * the window is hidden for the duration instead. That is survivable only
 * because the tray already carries Start, Pause, Resume and Stop, so the
 * recording stays controllable with no window on screen.
 */
export function setCaptureExclusion(excluded: boolean): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return

  if (process.platform === 'linux') {
    if (excluded) {
      // Already out of sight, so there is nothing to do — and nothing to undo
      // afterwards either, which is the point of the flag.
      if (!window.isVisible()) return
      hiddenForCapture = true
      window.hide()
      logger.info(SCOPE, 'Window hidden for the recording')
      return
    }

    if (!hiddenForCapture) return
    hiddenForCapture = false
    window.show()
    logger.info(SCOPE, 'Window restored after the recording')
    return
  }

  window.setContentProtection(excluded)
  logger.info(
    SCOPE,
    excluded ? 'Window excluded from screen capture' : 'Capture exclusion lifted'
  )
}

export interface CreateWindowOptions {
  /**
   * Whether to put the window on screen once it has rendered.
   *
   * False when the app was started by the login item: the renderer still loads
   * and the tray still works, the window simply waits to be asked for.
   */
  show?: boolean
}

export function createMainWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const showOnReady = options.show ?? true
  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 920,
    minHeight: 660,
    show: false,
    backgroundColor: '#0b1020',
    autoHideMenuBar: true,
    title: 'Screen Recorder',
    // The app lives in the system tray, so it deliberately keeps no taskbar
    // button. The tray menu is the way back to the window.
    //
    // Not on macOS: the Dock icon there belongs to the application rather than
    // to the window, it is the habitual way back to a hidden app, and the
    // `activate` handler restores the window from it. Hiding the app from the
    // Dock would leave the menu bar as the only route in, which is not what a
    // Mac user expects.
    ...(process.platform === 'darwin'
      ? {}
      : { skipTaskbar: !settingsStore.get().startup.showInTaskbar }),
    // `skipTaskbar` is macOS/Windows only — Electron dropped the Linux
    // implementation in v20 because Wayland has no equivalent. A toolbar-type
    // window gets there anyway: it sets _NET_WM_WINDOW_TYPE_TOOLBAR, which
    // every EWMH window manager (Mutter included) treats as skip-taskbar. No
    // ozone platform hint is set, so the app is always an X11 client and the
    // hint still applies through XWayland on Wayland sessions.
    ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security baseline: the renderer gets no Node access and runs in a
      // separate context from the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Keeps timers and the MediaRecorder running at full rate when the
      // window is minimised or hidden behind the captured application.
      backgroundThrottling: false
    }
  })

  mainWindow = window

  window.once('ready-to-show', () => {
    if (!showOnReady) {
      logger.info(SCOPE, 'Main window ready, kept hidden')
      return
    }

    window.show()
    logger.info(SCOPE, 'Main window shown')
  })

  // Closing the window hides it instead of quitting: a recording in progress
  // must survive the user tidying their desktop away.
  window.on('close', (event) => {
    if (quitting) return

    event.preventDefault()
    window.hide()
    logger.info(SCOPE, 'Window closed to tray')
  })

  // With no taskbar button there is nothing to restore a minimised window
  // from, so minimising hides to the tray. When a taskbar button is showing,
  // there *is* something to click, so an ordinary minimise is left alone.
  window.on('minimize', () => {
    if (!settingsStore.get().startup.showInTaskbar) window.hide()
  })

  window.on('closed', () => {
    mainWindow = null
  })

  // External links open in the user's browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Block any attempt to navigate the renderer away from the app bundle.
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return

    event.preventDefault()
    logger.warn(SCOPE, 'Blocked navigation attempt', { url })
  })

  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(SCOPE, 'Renderer process gone', details)
  })

  loadRenderer(window)
  return window
}

function loadRenderer(window: BrowserWindow): void {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']

  if (devServerUrl) {
    void window.loadURL(devServerUrl)
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
