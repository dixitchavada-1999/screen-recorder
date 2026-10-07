import { BrowserWindow, app, ipcMain } from 'electron'
import { readCachedUninstallHash } from './lib/uninstall-cache'
import { type UninstallHash, checkUninstallPassword, isUninstallHash } from './lib/uninstall-hash'

/**
 * The password check the uninstaller runs before it removes anything.
 *
 * The uninstaller starts the app's own executable with this flag and waits. The
 * app shows one small window asking for the password, checks it, and exits
 * with 0 to let the uninstall go ahead or anything else to stop it. Nothing of
 * the normal app starts: no tray, no tracking, no single-instance lock — the
 * copy already running in the tray is left alone until the uninstaller closes
 * it.
 *
 * Which password: the one last set from Settings, as this machine copied it
 * down (encrypted for this Windows user), or failing that the one the
 * installer was built with (`npm run uninstall-password`). Only hashes exist in
 * either place. With neither, the uninstall goes ahead without asking.
 *
 * What this cannot stop: somebody deleting the program folder by hand. That
 * needs the app installed for all users and people without administrator
 * rights — a matter for how the machines are set up, not for this check.
 */

export const UNINSTALL_GUARD_FLAG = '--uninstall-guard'

const MAX_ATTEMPTS = 3

/** Exit codes the uninstaller reads. Only 0 lets it continue. */
const EXIT = { allowed: 0, cancelled: 2, refused: 3 } as const

export function runUninstallGuard(): void {
  void app.whenReady().then(async () => {
    const builtIn = isUninstallHash(__UNINSTALL_PASSWORD__) ? __UNINSTALL_PASSWORD__ : null
    const stored = (await readCachedUninstallHash()) ?? builtIn

    if (!stored) {
      app.exit(EXIT.allowed)
      return
    }

    ask(stored)
  })
}

function ask(stored: UninstallHash): void {
  let attempts = 0
  let decided = false

  const finish = (code: number): void => {
    decided = true
    app.exit(code)
  }

  ipcMain.handle('uninstall-guard:check', (_event, password: unknown) => {
    if (typeof password !== 'string' || password.length === 0 || password.length > 256) {
      return { ok: false, left: MAX_ATTEMPTS - attempts }
    }

    attempts += 1
    const ok = checkUninstallPassword(password, stored)

    if (ok) {
      // Let the window show the answer for a moment before the process goes.
      setTimeout(() => finish(EXIT.allowed), 150)
      return { ok: true, left: 0 }
    }

    if (attempts >= MAX_ATTEMPTS) setTimeout(() => finish(EXIT.refused), 1200)
    return { ok: false, left: MAX_ATTEMPTS - attempts }
  })

  ipcMain.on('uninstall-guard:cancel', () => finish(EXIT.cancelled))

  const window = new BrowserWindow({
    width: 400,
    height: 250,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Uninstall Screen Recorder',
    backgroundColor: '#0f1424',
    autoHideMenuBar: true,
    webPreferences: {
      // A fixed page of our own, never anything loaded from elsewhere.
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    }
  })

  window.on('closed', () => {
    if (!decided) finish(EXIT.cancelled)
  })

  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
}

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Uninstall Screen Recorder</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 22px; font: 13px/1.45 "Segoe UI", system-ui, sans-serif;
         background: #0f1424; color: #e6e9f2; user-select: none; }
  h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 14px; color: #9aa3b8; font-size: 12px; }
  input { width: 100%; height: 36px; padding: 0 12px; border-radius: 10px;
          border: 1px solid #2a3148; background: #161c30; color: #e6e9f2; font-size: 13px; outline: none; }
  input:focus { border-color: #6366f1; }
  .error { min-height: 18px; margin: 8px 0 0; color: #f87171; font-size: 12px; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  button { height: 32px; padding: 0 14px; border-radius: 9px; border: 1px solid #2a3148;
           background: transparent; color: #e6e9f2; font-size: 12px; cursor: pointer; }
  button.primary { background: #6366f1; border-color: #6366f1; }
  button:disabled { opacity: .5; cursor: default; }
</style>
</head>
<body>
  <h1>Uninstall Screen Recorder</h1>
  <p>Enter the uninstall password to continue.</p>
  <form id="form">
    <input id="password" type="password" autofocus autocomplete="off" spellcheck="false">
    <div class="error" id="error"></div>
    <div class="row">
      <button type="button" id="cancel">Cancel</button>
      <button type="submit" class="primary" id="go">Uninstall</button>
    </div>
  </form>
<script>
  const { ipcRenderer } = require('electron')
  const form = document.getElementById('form')
  const input = document.getElementById('password')
  const error = document.getElementById('error')
  const go = document.getElementById('go')
  document.getElementById('cancel').onclick = () => ipcRenderer.send('uninstall-guard:cancel')
  form.onsubmit = async (event) => {
    event.preventDefault()
    if (!input.value) return
    go.disabled = true
    const result = await ipcRenderer.invoke('uninstall-guard:check', input.value)
    input.value = ''
    if (result.ok) { error.style.color = '#4ade80'; error.textContent = 'Uninstalling…'; return }
    if (result.left <= 0) { error.textContent = 'Wrong password. Uninstall cancelled.'; input.disabled = true; return }
    error.textContent = 'Wrong password. ' + result.left + (result.left === 1 ? ' try' : ' tries') + ' left.'
    go.disabled = false
    input.focus()
  }
</script>
</body>
</html>`
