import { app, powerMonitor, systemPreferences } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../lib/logger'
import type { ClockGap } from './clock-watchdog'
import { clockWatchdog } from './clock-watchdog'
import { settingsStore } from './settings-store'
import { currentPolicy, trackingPolicy } from './tracking-policy'

const SCOPE = 'input-counter'

/**
 * How much was done in each window, and nothing about what.
 *
 * A global hook is the only way any operating system will report input that
 * happened in other applications, and it is the same capability a keylogger
 * asks for. What separates this from one is the handler below: it adds one to a
 * number and returns. The key code is never read, never assigned, never logged.
 * That function is deliberately three lines long so anyone can check it.
 *
 * Counts are flushed on the same interval as screenshots, so a window has one
 * picture and one set of numbers describing the same ten minutes.
 */

/** How often the idle clock is checked, for the active-seconds figure. */
const ACTIVE_SAMPLE_MS = 5_000

interface Counters {
  keyPresses: number
  mouseClicks: number
  scrolls: number
  activeSeconds: number
}

const zero = (): Counters => ({
  keyPresses: 0,
  mouseClicks: 0,
  scrolls: 0,
  activeSeconds: 0
})

let counters = zero()
let windowStartedAt = 0

let flushTimer: NodeJS.Timeout | null = null
let activeTimer: NodeJS.Timeout | null = null
let hooked = false

/**
 * Whether this machine can count at all.
 *
 * `null` until the first attempt. False on a refused macOS permission or a
 * Wayland session, and it travels with every row so a machine that cannot
 * measure is never mistaken for a person who did nothing.
 */
let available: boolean | null = null

/* -------------------------------------------------------------------------- */
/*                                  Lifecycle                                 */
/* -------------------------------------------------------------------------- */

export function initInputCounter(): void {
  trackingPolicy.on('changed', () => reconcile())
  settingsStore.on('changed', () => reconcile())
  reconcile()

  /*
   * A window must never span a nap.
   *
   * The flush timer does not run while the machine is asleep, so a ten-minute
   * window that straddles one comes back as however long the nap was — and
   * every figure derived from it is wrong in the same direction: the machine
   * looks like it was on the whole time, and the work done inside the window
   * gets divided by that inflated total.
   *
   * So the window is closed at the last moment it was known to be running, and
   * a fresh one starts on waking. The nap itself belongs to neither.
   */
  clockWatchdog.on('gap', (gap: ClockGap) => void splitAt(gap))
}

/**
 * Ends the window where the machine stopped, and opens a new one where it
 * started again.
 *
 * The flush timer is restarted too. Left alone it would still be counting
 * towards a boundary set before the nap, making the first window after waking
 * an arbitrary length — the same fault in a smaller form.
 */
async function splitAt(gap: ClockGap): Promise<void> {
  if (flushTimer === null) return

  await flush(gap.stoppedAt)
  windowStartedAt = gap.resumedAt

  restartTimers()
}

export async function stopInputCounter(): Promise<void> {
  await flush()
  stop()
}

function reconcile(): void {
  const wanted = currentPolicy().trackingEnabled

  if (wanted && flushTimer === null) start()
  else if (!wanted && flushTimer !== null) {
    void flush()
    stop()
    logger.info(SCOPE, 'Input counting stopped')
  }
}

function start(): void {
  attachHook()

  windowStartedAt = Date.now()
  counters = zero()

  restartTimers()

  logger.info(SCOPE, 'Input counting started', {
    everyMinutes: settingsStore.get().tracking.screenshotIntervalMinutes,
    available
  })
}

function stop(): void {
  clearTimers()
  detachHook()
}

/** Puts both timers back on a boundary measured from now. */
function restartTimers(): void {
  clearTimers()

  const { tracking } = settingsStore.get()

  flushTimer = setInterval(() => void flush(), tracking.screenshotIntervalMinutes * 60_000)
  activeTimer = setInterval(sampleActive, ACTIVE_SAMPLE_MS)
}

function clearTimers(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  if (activeTimer !== null) {
    clearInterval(activeTimer)
    activeTimer = null
  }
}

/* -------------------------------------------------------------------------- */
/*                                   The hook                                 */
/* -------------------------------------------------------------------------- */

/*
 * Loaded lazily and through a guard.
 *
 * The module is native, and the ways it can fail are all environmental: no
 * Input Monitoring permission on macOS, no global hook at all under Wayland, a
 * prebuild missing for an unusual platform. None of those should stop the rest
 * of tracking, so a failure here sets `available` to false and everything else
 * carries on.
 */
function attachHook(): void {
  if (hooked) return

  /*
   * macOS refuses this by delivering nothing.
   *
   * A global input hook needs Accessibility trust, granted per application in
   * System Settings. Without it `uIOhook.start()` succeeds and no event ever
   * arrives — so the counters sit at zero and a working day is indistinguishable
   * from an idle one. That is worse than an error, because it looks like data.
   *
   * So the hook is not attached at all until macOS trusts the app, and
   * `available` stays false, which is what the rest of the tracker already
   * understands as "this machine cannot count input".
   */
  if (process.platform === 'darwin' && !isTrustedForInput()) {
    available = false
    logger.warn(
      SCOPE,
      'macOS has not granted Accessibility, so input cannot be counted',
      { hint: 'System Settings → Privacy & Security → Accessibility, then reopen the app' }
    )
    return
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi')

    // The three handlers. Each one adds to a number and returns — nothing about
    // the event itself is read, kept or written anywhere.
    uIOhook.on('keydown', countKey)
    uIOhook.on('click', countClick)
    uIOhook.on('wheel', countScroll)

    uIOhook.start()

    hooked = true
    available = true
  } catch (error) {
    available = false
    logger.warn(SCOPE, 'Input counting is unavailable on this machine', error)
  }
}

/**
 * Whether macOS trusts this app to see input in other applications.
 *
 * `false` so that asking does not raise the prompt — this runs whenever tracking
 * starts, which is not a moment the user chose. The prompt belongs to the button
 * in Settings, through `requestAccessibilityAccess`.
 */
function isTrustedForInput(): boolean {
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch (error) {
    logger.warn(SCOPE, 'Could not read accessibility trust', error)
    return false
  }
}

function detachHook(): void {
  if (!hooked) return

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi')
    uIOhook.off('keydown', countKey)
    uIOhook.off('click', countClick)
    uIOhook.off('wheel', countScroll)
    uIOhook.stop()
  } catch (error) {
    logger.debug(SCOPE, 'Could not detach the input hook', error)
  }

  hooked = false
}

/* The entire record kept of any input event. */
function countKey(): void {
  counters.keyPresses += 1
}

function countClick(): void {
  counters.mouseClicks += 1
}

function countScroll(): void {
  counters.scrolls += 1
}

/**
 * Adds to the active seconds when the machine was in use at this moment.
 *
 * Sampled from the same idle clock the timeline uses, so "active" means the
 * same thing in both places rather than two definitions that drift.
 */
function sampleActive(): void {
  const { tracking } = settingsStore.get()
  if (powerMonitor.getSystemIdleTime() >= tracking.idleAfterSeconds) return
  counters.activeSeconds += ACTIVE_SAMPLE_MS / 1000
}

/* -------------------------------------------------------------------------- */
/*                                   Flushing                                 */
/* -------------------------------------------------------------------------- */

/**
 * Closes the window, writes it, and starts the next one.
 *
 * Counters are swapped before anything is awaited, so input arriving during the
 * write belongs to the window it actually happened in rather than being lost or
 * double counted.
 *
 * `endedAt` defaults to now, which is right for an ordinary boundary. It is
 * passed explicitly when the window is being closed at a moment that has
 * already passed — a nap, where "now" is on the far side of time this machine
 * spent switched off.
 */
async function flush(endedAt: number = Date.now()): Promise<void> {
  const startedAt = windowStartedAt
  const taken = counters

  counters = zero()
  windowStartedAt = Date.now()

  if (startedAt === 0 || endedAt <= startedAt) return

  const row = {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    keyPresses: taken.keyPresses,
    mouseClicks: taken.mouseClicks,
    scrolls: taken.scrolls,
    activeSeconds: Math.round(taken.activeSeconds),
    inputAvailable: available
  }

  try {
    const directory = join(app.getPath('userData'), 'activity')
    await mkdir(directory, { recursive: true })

    const day = new Date(startedAt)
    const name = [
      day.getFullYear(),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    ].join('-')

    await appendFile(join(directory, `intervals-${name}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8')

    logger.info(SCOPE, 'Interval recorded', {
      keys: row.keyPresses,
      clicks: row.mouseClicks,
      activeSeconds: row.activeSeconds
    })
  } catch (error) {
    logger.warn(SCOPE, 'Could not record the interval', error)
  }
}
