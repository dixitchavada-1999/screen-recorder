import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { IPC } from '@shared/ipc'
import { logger } from '../lib/logger'
import { isSignedIn, onSignedInChange } from './auth'
import { hideQuickPanel, toggleQuickPanel } from './quick-panel'
import { settingsStore } from './settings-store'

const SCOPE = 'floating-button'

/**
 * A round app button that floats in the bottom-right corner of the desktop.
 *
 * One click opens the quick panel beside it — today's OKRs, tasks and calls —
 * and the next puts it away again. It can be dragged anywhere and stays above
 * other windows.
 *
 * It is its own little window: frameless, transparent and never focused, so
 * clicking it does not take focus from whatever the person is typing into. It
 * is also kept out of screen captures, so it never shows up in recordings or
 * tracking screenshots.
 *
 * Where it was left, and whether it was hidden from the tray, is remembered
 * across restarts in a small file of its own. That is window state rather than
 * a setting: it changes with every drag, and putting it in the settings store
 * would broadcast a settings change to the app window each time.
 */

/** The window is a little larger than the button so its shadow is not clipped. */
const WINDOW_SIZE = 72
/** Gap between the window and the edges of the work area. */
const MARGIN = 16

/** What is remembered between runs. No position means the default corner. */
interface ButtonState {
  visible: boolean
  x?: number
  y?: number
}

let button: BrowserWindow | null = null
let state: ButtonState = { visible: true }
let started = false
/** Cursor position relative to the window's corner when a drag began. */
let dragOffset: { x: number; y: number } | null = null

/**
 * A 2×2 grid of rounded squares — "open the panel" — drawn inline, so the
 * button needs no image file from the build and stays sharp at any scale.
 */
const GRID_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
  <rect x="3.5" y="3.5" width="7" height="7" rx="1.75"/>
  <rect x="13.5" y="3.5" width="7" height="7" rx="1.75"/>
  <rect x="3.5" y="13.5" width="7" height="7" rx="1.75"/>
  <rect x="13.5" y="13.5" width="7" height="7" rx="1.75"/>
</svg>`

/**
 * The button's page, inline: one icon and a few pointer handlers.
 *
 * A press that does not move is a click; one that moves more than a few pixels
 * is a drag, and the window follows the cursor until the button is let go.
 */
function pageHtml(color: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root { --bg: ${color}; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; }
  body { display: flex; align-items: center; justify-content: center; }
  #button {
    width: 56px; height: 56px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    /* The colour chosen in Settings, lightened towards the top-left corner. */
    background: linear-gradient(135deg, color-mix(in srgb, var(--bg) 70%, #ffffff), var(--bg));
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.12);
    cursor: pointer; transition: transform 120ms ease, opacity 160ms ease;
    /* Faded while it is just sitting there, so it does not draw the eye away
       from whatever is underneath; solid as soon as the pointer is on it. */
    opacity: 0.45;
  }
  #button:hover { transform: scale(1.08); opacity: 1; }
  #button.dragging { cursor: grabbing; transform: scale(1.08); opacity: 1; }
  #button svg { pointer-events: none; }
</style>
</head>
<body>
<div id="button" title="Today's calls and tasks">${GRID_ICON}</div>
<script>
  const el = document.getElementById('button')
  let start = null
  let dragging = false

  el.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    start = { x: event.screenX, y: event.screenY }
    dragging = false
    el.setPointerCapture(event.pointerId)
  })

  el.addEventListener('pointermove', (event) => {
    if (!start) return
    if (!dragging) {
      if (Math.hypot(event.screenX - start.x, event.screenY - start.y) < 4) return
      dragging = true
      el.classList.add('dragging')
      window.floating.dragStart()
    }
    window.floating.dragMove()
  })

  el.addEventListener('pointerup', () => {
    if (!start) return
    start = null
    el.classList.remove('dragging')
    if (dragging) window.floating.dragEnd()
    else window.floating.click()
    dragging = false
  })
</script>
</body>
</html>`
}

function stateFile(): string {
  return join(app.getPath('userData'), 'floating-button.json')
}

/** Reads the remembered state; anything missing or unreadable falls back to defaults. */
function loadState(): ButtonState {
  try {
    const file = stateFile()
    if (!existsSync(file)) return { visible: true }

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ButtonState>
    const next: ButtonState = { visible: raw.visible !== false }
    if (Number.isFinite(raw.x) && Number.isFinite(raw.y)) {
      next.x = Math.round(raw.x as number)
      next.y = Math.round(raw.y as number)
    }
    return next
  } catch (error) {
    logger.warn(SCOPE, 'Could not read the saved button state, using defaults', error)
    return { visible: true }
  }
}

/** Atomic (temp file + rename), like the settings file. */
function saveState(): void {
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(state), 'utf8')
    renameSync(`${file}.tmp`, file)
  } catch (error) {
    logger.error(SCOPE, 'Could not save the button state', error)
  }
}

/** Where the button sits by default: the bottom-right of the primary work area. */
function defaultPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - WINDOW_SIZE - MARGIN,
    y: area.y + area.height - WINDOW_SIZE - MARGIN
  }
}

/**
 * Pulls the button fully back inside the work area of the screen it is on.
 *
 * After a drag past an edge, onto the taskbar, or when a monitor is unplugged
 * or its resolution changes, the button would otherwise be half or wholly out
 * of sight with no way to grab it again.
 */
function keepOnScreen(): void {
  if (!button || button.isDestroyed()) return

  const [x, y] = button.getPosition()
  const area = screen.getDisplayNearestPoint({
    x: x + WINDOW_SIZE / 2,
    y: y + WINDOW_SIZE / 2
  }).workArea

  const clampedX = Math.min(Math.max(x, area.x), area.x + area.width - WINDOW_SIZE)
  const clampedY = Math.min(Math.max(y, area.y), area.y + area.height - WINDOW_SIZE)

  if (clampedX !== x || clampedY !== y) button.setPosition(clampedX, clampedY)
}

/** Opens the quick panel beside the button, or closes it. */
function onClick(): void {
  if (button && !button.isDestroyed()) toggleQuickPanel(button.getBounds())
}

function onDragStart(): void {
  if (!button || button.isDestroyed()) return

  const cursor = screen.getCursorScreenPoint()
  const [x, y] = button.getPosition()
  dragOffset = { x: cursor.x - x, y: cursor.y - y }
}

function onDragMove(): void {
  if (!button || button.isDestroyed() || !dragOffset) return

  const cursor = screen.getCursorScreenPoint()
  button.setBounds({
    x: cursor.x - dragOffset.x,
    y: cursor.y - dragOffset.y,
    width: WINDOW_SIZE,
    height: WINDOW_SIZE
  })
}

function onDragEnd(): void {
  dragOffset = null
  keepOnScreen()

  if (!button || button.isDestroyed()) return
  const [x, y] = button.getPosition()
  state = { ...state, x, y }
  saveState()
}

/** Only messages from the button's own page are acted on. */
function fromButton(handler: () => void) {
  return (event: Electron.IpcMainEvent): void => {
    if (button && !button.isDestroyed() && event.sender === button.webContents) handler()
  }
}

function createButton(): void {
  if (button) return

  // A saved spot is used as is; `keepOnScreen` pulls it back if the monitor it
  // was on has gone or shrunk since.
  const { x, y } =
    state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : defaultPosition()

  const window = new BrowserWindow({
    x,
    y,
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Screen Recorder',
    ...(process.platform === 'linux' ? { type: 'toolbar' } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/floating.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  button = window

  // Above ordinary always-on-top windows, but below the OS's own overlays.
  window.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true)

  // Never in a recording or a tracking screenshot.
  window.setContentProtection(true)

  keepOnScreen()

  window.once('ready-to-show', () => window.showInactive())
  window.on('closed', () => {
    if (button === window) button = null
    dragOffset = null
  })

  // The page has nowhere to go; refuse any navigation or new window.
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(settingsStore.get().floatingButton.color))}`)

  logger.info(SCOPE, 'Floating button shown')
}

function destroyButton(): void {
  if (button && !button.isDestroyed()) button.destroy()
  button = null
  dragOffset = null
}

/** Whether the button is switched on (the tray's checkbox). */
export function isFloatingButtonVisible(): boolean {
  return state.visible
}

/** Shows or hides the button from the tray, and remembers the choice. */
export function setFloatingButtonVisible(visible: boolean): void {
  if (state.visible === visible) return

  state = { ...state, visible }
  saveState()

  if (started) sync()
}

/**
 * Puts the button on screen or takes it off, to match two things: whether it
 * is switched on from the tray, and whether anybody is signed in.
 *
 * Signed out, it is not offered at all — the panel behind it is the person's
 * calls and tasks, and there is no person. The tray switch is remembered
 * meanwhile and applies again at the next sign-in.
 */
function sync(): void {
  const wanted = state.visible && isSignedIn()

  if (wanted) {
    createButton()
    return
  }

  if (button) {
    destroyButton()
    hideQuickPanel()
    logger.info(SCOPE, state.visible ? 'Floating button hidden while signed out' : 'Floating button hidden')
  }
}

let unsubscribeSignedIn: (() => void) | null = null

/**
 * Repaints the button in the colour from Settings, without reloading it.
 *
 * Safe to put into the page as is: the settings store only ever holds a plain
 * `#rrggbb` there.
 */
function applyColor(): void {
  if (!button || button.isDestroyed()) return

  const { color } = settingsStore.get().floatingButton
  void button.webContents
    .executeJavaScript(`document.documentElement.style.setProperty('--bg', ${JSON.stringify(color)})`)
    .catch(() => {
      /* still loading: it is built with the current colour anyway */
    })
}

export function startFloatingButton(): void {
  if (started) return
  started = true

  state = loadState()

  screen.on('display-removed', keepOnScreen)
  screen.on('display-metrics-changed', keepOnScreen)
  settingsStore.on('changed', applyColor)
  unsubscribeSignedIn = onSignedInChange(sync)

  // Usually nobody is signed in yet at this point — the session is restored a
  // moment later — and the button follows when it is.
  if (!state.visible) logger.info(SCOPE, 'Floating button left hidden, as it was last time')
  sync()
}

/** Shutdown only: closes the window without touching what was remembered. */
export function stopFloatingButton(): void {
  if (!started) return
  started = false

  screen.off('display-removed', keepOnScreen)
  screen.off('display-metrics-changed', keepOnScreen)
  settingsStore.off('changed', applyColor)
  unsubscribeSignedIn?.()
  unsubscribeSignedIn = null
  destroyButton()
}

ipcMain.on(IPC.FLOATING_CLICK, fromButton(onClick))
ipcMain.on(IPC.FLOATING_DRAG_START, fromButton(onDragStart))
ipcMain.on(IPC.FLOATING_DRAG_MOVE, fromButton(onDragMove))
ipcMain.on(IPC.FLOATING_DRAG_END, fromButton(onDragEnd))
