import { app, desktopCapturer, screen } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../lib/logger'
import { clockWatchdog } from './clock-watchdog'
import { assertScreenCaptureAllowed } from './permissions'
import { settingsStore } from './settings-store'
import { usesPortalCapture } from './sources'
import { currentPolicy, trackingPolicy } from './tracking-policy'

const SCOPE = 'screenshots'

/**
 * A picture of the screen on a fixed interval, for as long as tracking runs.
 *
 * Fires whether the machine is being used or not: an unattended screen is part
 * of the record rather than a hole in it, so idle changes what the timeline
 * says and nothing about whether a capture is taken.
 *
 * Captures are written to a local queue and left there. Uploading them is a
 * later phase, and the scheduler is deliberately unaware of it — a machine that
 * never reaches the network still ends the day with a complete set of files.
 */

/** Width every capture is scaled to. Height follows the display's own ratio. */
const TARGET_WIDTH = 1280

/**
 * JPEG quality. Chosen against the size budget rather than by eye: at 1280 wide
 * this lands near 200 KB a frame, which is what the storage figures assume.
 */
const JPEG_QUALITY = 70

let timer: NodeJS.Timeout | null = null

/**
 * True once this machine has been found unable to capture — Wayland, or a
 * permission that was refused. Recorded so the reason is logged once rather
 * than on every interval for the rest of the day.
 */
let blocked: string | null = null

/* -------------------------------------------------------------------------- */
/*                                  Lifecycle                                 */
/* -------------------------------------------------------------------------- */

export function initScreenshotScheduler(): void {
  // Two switches govern this: the server says whether screenshots are taken at
  // all, the local settings say how often.
  trackingPolicy.on('changed', () => reconcile())
  settingsStore.on('changed', () => reconcile())
  reconcile()

  /*
   * `setInterval` does not run while the machine is asleep, and fires
   * immediately on wake. Restarting the timer means one capture shortly after
   * waking rather than a burst of everything that was missed — those frames no
   * longer exist to be taken, and pretending otherwise would file the same
   * screen a dozen times with different timestamps.
   *
   * Driven by the measured gap rather than `powerMonitor`'s `resume`, which
   * modern Windows laptops do not reliably emit.
   */
  clockWatchdog.on('gap', () => {
    if (timer === null) return
    logger.debug(SCOPE, 'Machine was asleep; restarting the interval')
    stop()
    start()
  })
}

export function stopScreenshotScheduler(): void {
  stop()
}

function reconcile(): void {
  const wanted = currentPolicy().screenshotsEnabled

  if (wanted && timer === null) {
    start()
    return
  }

  if (!wanted && timer !== null) {
    stop()
    logger.info(SCOPE, 'Screenshot capture stopped')
  }
}

function start(): void {
  const { tracking } = settingsStore.get()
  const everyMs = tracking.screenshotIntervalMinutes * 60_000

  timer = setInterval(() => void capture(), everyMs)

  logger.info(SCOPE, 'Screenshot capture started', {
    everyMinutes: tracking.screenshotIntervalMinutes
  })

  /*
   * Catch up if the schedule has already slipped.
   *
   * Waiting a full interval after every start would leave a blind spot at the
   * beginning of each session — the ten minutes right after someone logs in and
   * opens their work, which is hardly the least interesting part of the day.
   * Capturing unconditionally is the other extreme: three restarts in five
   * minutes would file three near-identical frames.
   *
   * So: capture now only if the last one is already older than the interval.
   * A fresh start catches up, a restart does not.
   */
  void (async () => {
    const last = await readLastCaptureAt()
    if (last !== null && Date.now() - last < everyMs) return
    await capture()
  })()
}

function stop(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/* -------------------------------------------------------------------------- */
/*                                  Capturing                                 */
/* -------------------------------------------------------------------------- */

async function capture(): Promise<void> {
  if (!currentPolicy().screenshotsEnabled) return

  const at = Date.now()

  try {
    if (blocked !== null) return

    /*
     * Wayland asks the compositor for consent per capture session, and the app
     * cannot suppress that. An unattended screenshot every ten minutes would
     * mean a dialog every ten minutes, so it is refused once and reported
     * rather than turned into a machine nobody can use.
     */
    if (usesPortalCapture()) {
      blocked = 'wayland'
      logger.warn(SCOPE, 'Automatic screenshots are unavailable on Wayland', {
        detail: 'The compositor prompts for every capture session. Activity is still recorded.'
      })
      return
    }

    // macOS refuses silently otherwise; this turns it into a named failure the
    // permission banner already knows how to explain.
    assertScreenCaptureAllowed()

    const image = await grabPrimaryDisplay()
    if (image === null) return

    await writeToQueue(image, at)
  } catch (error) {
    // Never let one failed capture stop the schedule. The next interval may
    // well succeed — a screen was locked, a display was being reconfigured.
    logger.warn(SCOPE, 'Capture failed', error)
  }
}

/**
 * The primary display, scaled down, as JPEG bytes.
 *
 * Only the primary one. A three-monitor desk would otherwise triple both the
 * upload and the bill, and the extra screens rarely change the answer to what
 * the capture is for.
 */
async function grabPrimaryDisplay(): Promise<Buffer | null> {
  const display = screen.getPrimaryDisplay()
  const { width, height } = display.size

  // Asking the capturer for the final size is far cheaper than grabbing the
  // full screen and resizing it here.
  const thumbnailHeight = Math.max(1, Math.round((TARGET_WIDTH * height) / width))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: TARGET_WIDTH, height: thumbnailHeight },
    fetchWindowIcons: false
  })

  const source =
    sources.find((entry) => entry.display_id === String(display.id)) ?? sources[0]

  if (!source || source.thumbnail.isEmpty()) {
    logger.debug(SCOPE, 'No image came back from the capturer')
    return null
  }

  if (isBlank(source.thumbnail)) {
    // A locked, asleep or switched-off screen. Filing it would fill the day
    // with identical black frames that say nothing about anybody's work.
    logger.debug(SCOPE, 'Screen was blank; capture dropped')
    return null
  }

  return source.thumbnail.toJPEG(JPEG_QUALITY)
}

/**
 * Whether an image is effectively one flat colour.
 *
 * Sampled rather than exhaustive: a few hundred pixels spread across the frame
 * separate a lock screen from a real one, and walking three million of them
 * every ten minutes to learn the same thing would be waste.
 */
function isBlank(image: Electron.NativeImage): boolean {
  const { width, height } = image.getSize()
  if (width === 0 || height === 0) return true

  const bitmap = image.toBitmap()
  const channels = 4
  const samples = 400
  const step = Math.max(channels, Math.floor(bitmap.length / samples / channels) * channels)

  let min = 255
  let max = 0

  for (let index = 0; index + 2 < bitmap.length; index += step) {
    // BGRA. Averaging the three colour channels is enough to tell "flat" from
    // "has anything on it" without caring which colour it is.
    const value = (bitmap[index]! + bitmap[index + 1]! + bitmap[index + 2]!) / 3
    if (value < min) min = value
    if (value > max) max = value
  }

  // A real desktop always spans more than this, even a very dark theme.
  return max - min < 8
}

/* -------------------------------------------------------------------------- */
/*                                   Queue                                    */
/* -------------------------------------------------------------------------- */

/**
 * `userData/screenshots/pending/<epoch>.jpg`.
 *
 * The filename is the timestamp, so the queue needs no index and a crash
 * cannot separate an image from the moment it was taken. The uploader drains
 * this directory and deletes each file once the server has it.
 */
function pendingDirectory(): string {
  return join(app.getPath('userData'), 'screenshots', 'pending')
}

async function writeToQueue(jpeg: Buffer, at: number): Promise<void> {
  const directory = pendingDirectory()
  await mkdir(directory, { recursive: true })

  const path = join(directory, `${at}.jpg`)
  await writeFile(path, jpeg)
  await writeLastCaptureAt(at)

  logger.info(SCOPE, 'Screenshot captured', {
    kb: Math.round(jpeg.length / 1024),
    at: new Date(at).toISOString()
  })
}

/**
 * When the last capture was taken, kept across restarts.
 *
 * A separate file rather than the newest name in the queue, because the queue
 * empties as things upload — an uploaded day would otherwise look like a day
 * that never captured anything, and every restart would take a fresh frame.
 */
function stampPath(): string {
  return join(app.getPath('userData'), 'screenshots', 'last-capture')
}

async function readLastCaptureAt(): Promise<number | null> {
  try {
    const value = Number(await readFile(stampPath(), 'utf8'))
    return Number.isFinite(value) ? value : null
  } catch {
    // Never captured on this machine, or the file is unreadable. Either way the
    // right answer is to take one.
    return null
  }
}

async function writeLastCaptureAt(at: number): Promise<void> {
  try {
    await writeFile(stampPath(), String(at), 'utf8')
  } catch (error) {
    // Only costs an extra frame after the next restart.
    logger.debug(SCOPE, 'Could not record the capture time', error)
  }
}
