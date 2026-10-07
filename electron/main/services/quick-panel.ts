import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { logger } from '../lib/logger'
import { loadRenderer, openMainWindowSection, showMainWindow } from '../window'

const SCOPE = 'quick-panel'

/**
 * The side panel the floating button opens: today's OKRs, tasks and calls.
 *
 * Shaped like the Windows notification panel — it opens just above the button,
 * slides in from the right, and goes away again on Escape, on a second click
 * of the button, or as soon as something else is clicked.
 *
 * It is the app's own renderer bundle loaded with `?view=panel`, on the app's
 * own preload, so it reads exactly what the dashboard reads through the same
 * calls, signed in as the same account. Built once and kept hidden between
 * uses, so opening it is instant.
 */

const WIDTH = 380
const MAX_HEIGHT = 600
/** Space between the panel and the button, and the panel and the screen edge. */
const GAP = 12

let panel: BrowserWindow | null = null
/**
 * When the panel last hid itself because it lost focus.
 *
 * Clicking the floating button while the panel is open can blur the panel
 * first; without this, the click that follows would open it straight back up.
 */
let lastBlurHideAt = 0

function createPanel(): BrowserWindow {
  const window = new BrowserWindow({
    width: WIDTH,
    height: MAX_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Screen Recorder',
    ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // Keeps its timers at full rate while hidden, so the background refresh
      // runs on schedule and the lists are current when it next opens.
      backgroundThrottling: false
    }
  })

  window.setAlwaysOnTop(true, 'pop-up-menu')

  // Not in a recording or a tracking screenshot, like the button itself.
  window.setContentProtection(true)

  window.on('blur', () => {
    if (!window.isVisible()) return
    lastBlurHideAt = Date.now()
    window.hide()
  })

  window.on('closed', () => {
    if (panel === window) panel = null
  })

  // The panel's own failures, into the shared log — it has no dev tools open.
  window.webContents.on('did-fail-load', (_event, code, description) => {
    logger.error(SCOPE, 'Panel failed to load', { code, description })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(SCOPE, 'Panel renderer gone', details)
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
  })

  loadRenderer(window, 'panel')
  return window
}

/**
 * Where the panel goes: above the button, right edges lined up — or below it when
 * the button has been dragged into the top half of the screen. Shorter than
 * usual when there is not much room on that side, and always kept inside the
 * work area.
 */
function placeNear(anchor: Electron.Rectangle): Electron.Rectangle | null {
  if (!panel) return null

  const area = screen.getDisplayMatching(anchor).workArea
  const above = anchor.y + anchor.height / 2 > area.y + area.height / 2

  const room = above
    ? anchor.y - area.y - GAP
    : area.y + area.height - (anchor.y + anchor.height) - GAP
  const height = Math.max(240, Math.min(MAX_HEIGHT, room - GAP / 2))

  let x = anchor.x + anchor.width - WIDTH
  let y = above ? anchor.y - height - GAP / 2 : anchor.y + anchor.height + GAP / 2

  x = Math.min(Math.max(x, area.x + GAP), area.x + area.width - WIDTH - GAP)
  y = Math.min(Math.max(y, area.y + GAP), area.y + area.height - height - GAP)

  return { x: Math.round(x), y: Math.round(y), width: WIDTH, height }
}

/** Opens the panel by `anchor`, or closes it when it is already open. */
export function toggleQuickPanel(anchor: Electron.Rectangle): void {
  if (panel?.isVisible()) {
    hideQuickPanel()
    return
  }

  // The click that blurred the panel away is the same one landing here.
  if (Date.now() - lastBlurHideAt < 300) return

  if (!panel || panel.isDestroyed()) panel = createPanel()
  const window = panel

  const target = placeNear(anchor)
  if (!target) return

  window.webContents.send(IPC.EVENT_PANEL_SHOWN)
  slideIn(window, target)
  window.focus()
}

/** How far the panel travels, and for how long, as it slides in. */
const SLIDE_DISTANCE = 32
const SLIDE_MS = 200
let slideTimer: NodeJS.Timeout | undefined

/**
 * Slides and fades the window itself in from the right.
 *
 * Done to the window rather than inside the page on purpose. An animation in
 * the page has to be restarted while the window is hidden, and Windows does not
 * present a hidden window's new frames — so opening showed the last frame, then
 * the restarted animation: a blink, and at times a stale "Loading…". Moving the
 * window needs nothing repainted: the page shows exactly what it last drew.
 */
function slideIn(window: BrowserWindow, target: Electron.Rectangle): void {
  clearInterval(slideTimer)

  const started = Date.now()
  const frame = (): void => {
    if (window.isDestroyed()) {
      clearInterval(slideTimer)
      return
    }

    const t = Math.min(1, (Date.now() - started) / SLIDE_MS)
    const eased = 1 - Math.pow(1 - t, 3)

    window.setBounds({ ...target, x: Math.round(target.x + SLIDE_DISTANCE * (1 - eased)) })
    window.setOpacity(eased)

    if (t >= 1) clearInterval(slideTimer)
  }

  window.setOpacity(0)
  window.setBounds({ ...target, x: target.x + SLIDE_DISTANCE })
  window.show()
  slideTimer = setInterval(frame, 16)
}

export function hideQuickPanel(): void {
  clearInterval(slideTimer)
  if (panel && !panel.isDestroyed() && panel.isVisible()) panel.hide()
}

/** Builds the panel ahead of the first click, so that click opens it at once. */
export function startQuickPanel(): void {
  if (!panel) panel = createPanel()
}

export function stopQuickPanel(): void {
  if (panel && !panel.isDestroyed()) panel.destroy()
  panel = null
}

/** Only messages from the panel's own page are acted on. */
function fromPanel<A extends unknown[]>(handler: (...args: A) => void) {
  return (event: Electron.IpcMainEvent, ...args: A): void => {
    if (panel && !panel.isDestroyed() && event.sender === panel.webContents) handler(...args)
  }
}

ipcMain.on(IPC.PANEL_HIDE, fromPanel(hideQuickPanel))

ipcMain.on(
  IPC.PANEL_OPEN_APP,
  fromPanel((section?: unknown) => {
    hideQuickPanel()
    if (typeof section === 'string' && section) openMainWindowSection(section)
    else showMainWindow()
  })
)
