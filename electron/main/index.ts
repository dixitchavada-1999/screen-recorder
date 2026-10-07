import { app, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import { registerIpcHandlers } from './ipc/register'
import { logger } from './lib/logger'
import { initActivityTracker, stopActivityTracker } from './services/activity-tracker'
import { initAppTracker, stopAppTracker } from './services/app-tracker'
import { UNINSTALL_GUARD_FLAG, runUninstallGuard } from './uninstall-guard'
import { startUninstallPasswordSync } from './services/uninstall-password'
import { startBrowserBridge, stopBrowserBridge } from './services/browser-bridge'
import { ensureBrowserExtensionPolicy } from './services/browser-policy'
import { startActivityUpload, stopActivityUpload } from './services/activity-upload'
import { startClockWatchdog, stopClockWatchdog } from './services/clock-watchdog'
import { initInputCounter, stopInputCounter } from './services/input-counter'
import {
  initScreenshotScheduler,
  stopScreenshotScheduler
} from './services/screenshot-scheduler'
import { startTrackingPolicy, stopTrackingPolicy } from './services/tracking-policy'
import { findDeepLink, handleDeepLink, registerProtocolClient } from './services/deep-link'
import { configureMediaAccess } from './services/display-media'
import { handleRecordingProtocol, registerRecordingScheme } from './services/library'
import {
  closeAllSessions,
  hasActiveSessions,
  listOrphanRecordings
} from './services/recording-session'
import { startReminderPrefs } from './services/reminder-prefs'
import { startGoogleSync } from './services/google-sync'
import { startReminders, stopReminders } from './services/reminders'
import { initUpdater, stopUpdater } from './services/updater'
import { startRosterSync, stopRosterSync } from './services/roster'
import { startCallNotifier, stopCallNotifier } from './services/call-notifier'
import { startMcpServer, stopMcpServer } from './services/mcp-server'
import { settingsStore } from './services/settings-store'
import { HIDDEN_FLAG, applyLoginItem, wasLaunchedAtLogin } from './services/startup'
import { cancelActiveTranscode } from './services/transcoder'
import { startAccountWatch, stopAccountWatch } from './services/account-watch'
import { applyShortcuts, releaseShortcuts } from './services/shortcuts'
import { createTray, destroyTray } from './services/tray'
import { startFloatingButton, stopFloatingButton } from './services/floating-button'
import { startQuickPanel, stopQuickPanel } from './services/quick-panel'
import {
  applyTaskbarVisibility,
  createMainWindow,
  hideMainWindow,
  setQuitting,
  showMainWindow
} from './window'

const SCOPE = 'main'

/* -------------------------------------------------------------------------- */
/*                              Single instance                               */
/* -------------------------------------------------------------------------- */

// Two instances would fight over the same intermediate files and settings.
if (process.argv.includes(UNINSTALL_GUARD_FLAG)) {
  // Started by the uninstaller to ask for its password, and nothing else.
  runUninstallGuard()
} else if (!app.isPackaged && !app.requestSingleInstanceLock({ devRestart: true })) {
  // Development only: an old `npm run dev` still running in the tray holds the
  // lock, and would otherwise swallow this launch and keep running stale code.
  // It has been asked to quit (see `second-instance`); take over once it has.
  void takeOverFromOldDevInstance()
} else if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  listenForSecondInstances()
  bootstrap()
}

function listenForSecondInstances(): void {
  // Launching the app again surfaces the existing window rather than starting
  // a second copy — important when there is no taskbar button to click.
  //
  // This is also how an email confirmation link reaches a running app on
  // Windows and Linux: the OS starts a second copy with the URL on its command
  // line, that copy loses the lock and quits, and its arguments arrive here.
  app.on('second-instance', (_event, argv, _cwd, additionalData) => {
    // A fresh `npm run dev` replacing this one. Through the normal quit path,
    // so a recording in progress is still finished properly first.
    if (!app.isPackaged && (additionalData as { devRestart?: boolean } | null)?.devRestart) {
      logger.info(SCOPE, 'A newer development instance started; quitting for it')
      setQuitting(true)
      app.quit()
      return
    }

    const link = findDeepLink(argv)
    if (link) {
      void handleDeepLink(link)
      return
    }

    // A copy launched at login carries `--hidden`, and login is exactly when a
    // second copy is most likely: the OS holds more than one startup entry for
    // the app, so two copies race at boot and the loser lands here. It must not
    // drag the window onto a desktop somebody is still logging in to. Only a
    // deliberate relaunch — with no `--hidden` — is a request to come forward.
    if (!argv.includes(HIDDEN_FLAG)) showMainWindow()
  })

  // macOS delivers the same link as an event instead of an argument.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    void handleDeepLink(url)
  })
}

/**
 * Waits for the old development instance to exit, then starts normally.
 *
 * The parts of startup that must happen before `ready` run straight away; the
 * rest waits for the lock. Gives up after a while — an old instance that will
 * not quit (stuck finishing a recording) is better left alone than fought.
 */
async function takeOverFromOldDevInstance(): Promise<void> {
  prepareBeforeReady()

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (app.requestSingleInstanceLock({ devRestart: true })) {
      listenForSecondInstances()
      startWhenReady()
      return
    }
  }

  console.error('[app] The old development instance did not quit; close it from the tray.')
  app.quit()
}

/* -------------------------------------------------------------------------- */
/*                                  Bootstrap                                 */
/* -------------------------------------------------------------------------- */

function bootstrap(): void {
  prepareBeforeReady()
  startWhenReady()
}

/** Everything that has to be in place before the app becomes ready. */
function prepareBeforeReady(): void {
  // Chromium flags that materially improve capture on Linux/Wayland and let
  // the GPU handle scaling and encoding where possible.
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')

  // Must happen before `ready`, otherwise the scheme cannot be made privileged
  // and <video> would refuse to stream or seek recordings.
  registerRecordingScheme()
}

function startWhenReady(): void {
  app.whenReady().then(onReady).catch((error) => {
    logger.error(SCOPE, 'Failed to start application', error)
    app.quit()
  })
}

async function onReady(): Promise<void> {
  logger.init()
  settingsStore.init()

  /*
   * Windows shows a desktop notification only for an app it can name, and it
   * names it by the AppUserModelID. Without this the `Notification` fired for a
   * call reminder is silently dropped in a packaged build — the classic reason
   * notifications work in development and vanish once installed. The id matches
   * the installer's `appId`, so it lines up with the Start-menu shortcut the
   * NSIS package creates. A no-op off Windows.
   */
  app.setAppUserModelId('com.screenrecorder.desktop')

  // Claims `screenrecorder://` so email links find their way back here. After
  // `logger.init()` so the outcome is actually recorded.
  registerProtocolClient()

  configureMediaAccess()
  handleRecordingProtocol()
  registerIpcHandlers()

  const orphans = listOrphanRecordings()
  if (orphans.length > 0) {
    logger.warn(SCOPE, 'Found recordings left behind by a previous session', {
      count: orphans.length
    })
  }

  /*
   * Runs from boot on every installed device.
   *
   * This is a managed tracking deployment: the recorder has to be in the tray
   * after login, or tracking and reminders do not run until somebody thinks to
   * start it. So the login item is always on, not a preference — and it is
   * re-asserted on every launch, because the OS entry can go stale on its own
   * (the app is moved, reinstalled, or something removes it) and this is the
   * cheapest moment to put it back. A no-op in development, where it would
   * point at the Electron binary in node_modules.
   */
  void applyLoginItem(true)

  // Started by the login item, this stays out of the way: the window is built
  // so it is ready, but nothing is put on screen over somebody's desktop while
  // they are still logging in.
  const hidden = wasLaunchedAtLogin()
  createMainWindow({ show: !hidden })
  if (hidden) logger.info(SCOPE, 'Launched at login; staying in the tray')

  // The window took its initial taskbar state from the setting; keep it in step
  // when the toggle is flipped.
  settingsStore.on('changed', (settings) => {
    applyTaskbarVisibility(settings.startup.showInTaskbar)

    // Rebound on every settings change rather than only when the accelerator
    // differs: it is one cheap call, and tracking the previous value here would
    // be a second copy of state that can drift from the one in the store.
    applyShortcuts()
  })

  // A one-click way to open the app from the desktop, alongside the tray.
  // Before the tray, whose menu shows whether it was left switched on.
  startFloatingButton()
  startQuickPanel()

  createTray({
    onShowWindow: showMainWindow,
    onHideWindow: hideMainWindow,
    onQuit: requestQuit
  })

  /*
   * The key that starts and stops a recording from anywhere.
   *
   * Registered here rather than with the window, because it has to work while
   * there is no window on screen — which is most of the time this application
   * is running.
   */
  applyShortcuts()

  /*
   * Keeps a running window's permissions honest.
   *
   * Does nothing while nobody is signed in, and catches the case a focus
   * refresh cannot — a window left open and untouched while somebody's access
   * is changed elsewhere.
   */
  startAccountWatch()

  // Call reminders. Safe before anyone signs in — it simply finds no schedule
  // to arm and tries again once a session exists.
  startReminders()

  // Keeps the weeks ahead in step with the connected Google calendars, so a
  // meeting added there gets its reminder even while the app sits in the tray.
  startGoogleSync()

  // Looks for a newer version, and keeps looking every few hours. Finding one
  // only lights up the banner on the dashboard - nothing downloads or installs
  // until somebody asks it to.
  initUpdater()

  // Asks the server to refresh the staff roster. The budget for that lives with
  // the partner API — fifty reads a day — so the server decides whether to go,
  // and this only ever asks.
  startRosterSync()

  // Asks the server to send any Slack reminder that has come due. Every running
  // copy asks; the server hands each one to exactly one of them.
  startCallNotifier()

  // Lets this employee's own Claude schedule/list/cancel their own calls,
  // loopback-only and gated by a local token — see Settings.
  startMcpServer()

  // Puts this person's choice of warnings somewhere the server can read it, so
  // their Slack message arrives when they asked rather than at a fixed time.
  startReminderPrefs()

  // Everything below records time, and none of it may claim time the machine
  // spent asleep. Started first so all three are already listening.
  startClockWatchdog()

  // Reads the signed-in account's policy before anything asks for it, and keeps
  // re-reading so an administrator's change reaches this machine on its own.
  startTrackingPolicy()

  initActivityTracker()

  // Same switch, separate schedule: the sampler runs every few seconds, this
  // one every few minutes, and neither should be able to stall the other.
  initScreenshotScheduler()

  // Counts what happened in each window. Same switch, same interval — one
  // picture and one set of numbers describing the same ten minutes.
  initInputCounter()

  // Which application is in front. Its own switch, off unless an administrator
  // turns it on for this person.
  initAppTracker()

  // Where the browser extension hands over tabs and searches. Listening does not
  // mean recording: what it accepts is decided by the same policy as the rest.
  startBrowserBridge()

  // Puts the extension on Chrome's and Edge's install list, and back on it if it
  // has been removed. Does nothing until the store ids are configured.
  void ensureBrowserExtensionPolicy()

  // Keeps this machine's copy of the uninstall password current, for the
  // uninstaller to check against even with no network.
  startUninstallPasswordSync()

  // Drains what those two write. Runs whether or not tracking is on: a policy
  // switched off mid-day still leaves a queue that belongs on the server.
  startActivityUpload()

  // Clicking the Dock icon (macOS) or relaunching the app must bring the window
  // back. `showMainWindow` recreates it when it is really gone and unhides it
  // when it is merely hidden to the tray — which, since closing the window
  // hides it, is the usual case. Checking for zero windows first would leave
  // the Dock icon doing nothing at all.
  app.on('activate', () => {
    showMainWindow()
  })

  // A link clicked while the app was closed arrives on this process's own
  // command line, so it is handled once the window exists to bring forward.
  const coldStartLink = findDeepLink(process.argv)
  if (coldStartLink) void handleDeepLink(coldStartLink)
}

/**
 * Quits for real (the tray's Quit item and the app menu route here).
 *
 * `setQuitting` releases the window's hide-to-tray behaviour first, otherwise
 * the close would be intercepted and the process would stay alive.
 */
function requestQuit(): void {
  logger.info(SCOPE, 'Quit requested from the tray')
  setQuitting(true)
  app.quit()
}

/* -------------------------------------------------------------------------- */
/*                                  Shutdown                                  */
/* -------------------------------------------------------------------------- */

/** Guards against re-entering the graceful shutdown path. */
let shutdownStarted = false

app.on('before-quit', (event) => {
  // Any quit path (tray, menu, OS shutdown) must release the hide-to-tray guard.
  setQuitting(true)

  if (shutdownStarted) return

  if (hasActiveSessions()) {
    // A recording is still open. Give the renderer a moment to stop the
    // MediaRecorder and flush its final chunk, otherwise the intermediate file
    // would be truncated mid-cluster and become unplayable.
    event.preventDefault()
    shutdownStarted = true

    logger.warn(SCOPE, 'Quit requested while recording — asking renderer to stop')

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.EVENT_REQUEST_STOP)
    }

    void waitForSessionsToClose(12_000)
      .then(finishShutdown)
      .finally(() => app.quit())
    return
  }

  shutdownStarted = true
  void finishShutdown()
})

/**
 * Waits for the renderer to flush and close its recording session.
 *
 * Polling beats a fixed delay: a short recording is ready almost immediately,
 * while a long one gets the time it needs to write its final chunk. If the
 * timeout is reached anyway the raw capture stays on disk and is offered for
 * recovery on the next launch, so no footage is lost either way.
 */
function waitForSessionsToClose(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs

    const poll = (): void => {
      if (!hasActiveSessions()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        logger.warn(SCOPE, 'Timed out waiting for the recording to close')
        resolve()
        return
      }
      setTimeout(poll, 250)
    }

    poll()
  })
}

async function finishShutdown(): Promise<void> {
  try {
    stopReminders()
    stopUpdater()
    stopRosterSync()
    stopCallNotifier()
    stopMcpServer()
    stopTrackingPolicy()
    stopActivityUpload()
    // Before the recorders below close their windows: a gap reported mid
    // shutdown would reopen what they are in the middle of closing.
    stopClockWatchdog()
    // Closes the open stretch at the time the machine is actually going down,
    // so the hours until the next boot belong to nobody.
    await stopActivityTracker()
    await stopInputCounter()
    await stopAppTracker()
    stopBrowserBridge()
    stopScreenshotScheduler()
    stopAccountWatch()
    releaseShortcuts()
    destroyTray()
    stopFloatingButton()
    stopQuickPanel()
    cancelActiveTranscode()
    await closeAllSessions()
    settingsStore.flush()
    logger.info(SCOPE, 'Shutdown complete')
  } catch (error) {
    logger.error(SCOPE, 'Error during shutdown', error)
  } finally {
    logger.close()
  }
}

// Deliberately does NOT quit. This is a tray application: closing the window
// hides it, and the app keeps running so a recording can continue. Quitting is
// an explicit choice made from the tray menu.
app.on('window-all-closed', () => {
  logger.debug(SCOPE, 'All windows closed; staying resident in the tray')
})

/* -------------------------------------------------------------------------- */
/*                            Last-resort handlers                            */
/* -------------------------------------------------------------------------- */

process.on('uncaughtException', (error) => {
  logger.error(SCOPE, 'Uncaught exception in main process', error)
})

process.on('unhandledRejection', (reason) => {
  logger.error(SCOPE, 'Unhandled promise rejection in main process', reason)
})
