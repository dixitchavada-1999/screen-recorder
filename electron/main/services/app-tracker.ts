import { app, powerMonitor } from 'electron'
import { execFile } from 'node:child_process'
import { appendFile, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { logger } from '../lib/logger'
import type { ClockGap } from './clock-watchdog'
import { clockWatchdog } from './clock-watchdog'
import { currentPolicy, trackingPolicy } from './tracking-policy'

const SCOPE = 'app-tracker'

/**
 * Which application is in front, recorded as stretches.
 *
 * Off unless an administrator has switched it on for this person — the third
 * switch beside tracking and screenshots. What is kept is the application's name
 * and its window titles with how long each was showing, and nothing else: no
 * keystrokes, no page contents, no list of everything running in the
 * background.
 *
 * Only time at the keyboard counts. While the machine is idle nothing is in
 * use, whatever window happens to be in front, so the stretch closes.
 *
 * A stretch is one application, not one title. Titles change constantly — a
 * terminal's spinner, an unread count, every tab switch — and a row per title
 * would be thousands a day. Instead each stretch carries its handful of
 * longest-held titles with their seconds, and a new stretch starts when the
 * application changes or the stretch reaches the screenshot interval, so rows
 * line up with the other windows of the day.
 */

/** How often the window in front is read. */
const SAMPLE_MS = 5_000

/** Samples further apart than this mean the machine stopped, not that the app stayed. */
const GAP_TOLERANCE_MS = SAMPLE_MS * 4

/** Titles kept per stretch, longest first. */
const MAX_TITLES = 5

/** Longest title kept. Anything longer is a page that put its whole content up there. */
const MAX_TITLE_LENGTH = 300

/**
 * Titles that say the window is a private one. Its real title is replaced
 * before it is held anywhere — that is what private browsing is for.
 */
const PRIVATE_WINDOW = /incognito|inprivate|private browsing|private window/i

interface OpenStretch {
  app: string
  startedAt: number
  /** When the last sample that belonged to it was taken. */
  lastAt: number
  titles: Map<string, number>
}

let timer: NodeJS.Timeout | null = null
let open: OpenStretch | null = null
let lastSampleAt = 0

/* -------------------------------------------------------------------------- */
/*                                  Lifecycle                                 */
/* -------------------------------------------------------------------------- */

export function initAppTracker(): void {
  trackingPolicy.on('changed', () => void reconcile())
  void reconcile()

  // A nap ends the stretch where it began, not where the machine woke.
  clockWatchdog.on('gap', (gap: ClockGap) => {
    void closeOpen(Math.min(gap.stoppedAt, (open?.lastAt ?? gap.stoppedAt) + SAMPLE_MS))
    lastSampleAt = 0
  })
}

export async function stopAppTracker(): Promise<void> {
  clearTimer()
  await closeOpen(Date.now())
}

async function reconcile(): Promise<void> {
  const wanted = currentPolicy().appsEnabled

  if (wanted && timer === null) {
    lastSampleAt = 0
    timer = setInterval(() => void sample(), SAMPLE_MS)
    void sample()
    logger.info(SCOPE, 'Application tracking started', { everyMs: SAMPLE_MS })
    return
  }

  if (!wanted && timer !== null) {
    clearTimer()
    await closeOpen(Date.now())
    logger.info(SCOPE, 'Application tracking stopped')
  }
}

function clearTimer(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/* -------------------------------------------------------------------------- */
/*                                  Sampling                                  */
/* -------------------------------------------------------------------------- */

let sampling = false

async function sample(): Promise<void> {
  // A slow read (macOS spawns a helper) must not stack a second one on top.
  if (sampling) return
  sampling = true

  try {
    const policy = currentPolicy()
    if (!policy.appsEnabled) return

    const now = Date.now()

    if (lastSampleAt > 0 && now - lastSampleAt > GAP_TOLERANCE_MS && open) {
      await closeOpen(open.lastAt + SAMPLE_MS)
    }
    lastSampleAt = now

    // Away from the keyboard: nothing is in use, whatever is in front.
    if (powerMonitor.getSystemIdleTime() >= policy.idleAfterSeconds) {
      if (open) await closeOpen(open.lastAt + SAMPLE_MS)
      return
    }

    const window = await readActiveWindow()
    if (!window) {
      if (open) await closeOpen(open.lastAt + SAMPLE_MS)
      return
    }

    const maxStretchMs = policy.screenshotIntervalMinutes * 60_000

    if (open && (open.app !== window.app || now - open.startedAt >= maxStretchMs)) {
      await closeOpen(now)
    }

    if (!open) {
      open = { app: window.app, startedAt: now, lastAt: now, titles: new Map() }
    }

    open.lastAt = now
    open.titles.set(window.title, (open.titles.get(window.title) ?? 0) + SAMPLE_MS / 1000)
  } catch (error) {
    logger.debug(SCOPE, 'Could not sample the window in front', error)
  } finally {
    sampling = false
  }
}

/** Writes the open stretch out and clears it. A stretch of no length says nothing. */
async function closeOpen(endedAt: number): Promise<void> {
  const stretch = open
  open = null
  if (!stretch) return

  const end = Math.min(endedAt, Date.now())
  if (end <= stretch.startedAt) return

  /*
   * Each sample counts forward by a whole interval, so a stretch cut short —
   * switched off, gone idle — can hold more title time than it lasted. Scaled
   * back so the titles never add up to more than the stretch itself.
   */
  const spanSeconds = (end - stretch.startedAt) / 1000
  const counted = [...stretch.titles.values()].reduce((sum, seconds) => sum + seconds, 0)
  const scale = counted > spanSeconds ? spanSeconds / counted : 1

  const titles = [...stretch.titles.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TITLES)
    .map(([title, seconds]) => ({ title, seconds: Math.round(seconds * scale) }))

  await write({
    startedAt: new Date(stretch.startedAt).toISOString(),
    endedAt: new Date(end).toISOString(),
    app: stretch.app,
    titles
  })
}

/* -------------------------------------------------------------------------- */
/*                                   Storage                                  */
/* -------------------------------------------------------------------------- */

/** One stretch as it is written to disk and later uploaded. */
export interface AppStretch {
  startedAt: string
  endedAt: string
  app: string
  titles: Array<{ title: string; seconds: number }>
}

/**
 * Appended beside the other activity files, one per day, read and sent by the
 * same upload queue. Named by the day the stretch started.
 */
async function write(stretch: AppStretch): Promise<void> {
  try {
    const directory = join(app.getPath('userData'), 'activity')
    await mkdir(directory, { recursive: true })

    const day = new Date(stretch.startedAt)
    const name = [
      day.getFullYear(),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')
    ].join('-')

    await appendFile(join(directory, `apps-${name}.jsonl`), `${JSON.stringify(stretch)}\n`, 'utf8')
  } catch (error) {
    logger.warn(SCOPE, 'Could not record an application stretch', error)
  }
}

/* -------------------------------------------------------------------------- */
/*                           Reading the window in front                      */
/* -------------------------------------------------------------------------- */

interface ActiveWindow {
  app: string
  title: string
}

/**
 * The application in front and its title, or null when there is none or it
 * cannot be read.
 *
 * Built on the `get-windows` package, but reaching past its front door. On
 * Windows that front door loads its binary through `node-pre-gyp`, a build
 * tool that would otherwise ship inside the app with its own dependencies; the
 * binary is loaded directly instead. macOS runs the package's helper, and Linux
 * its X11 reader. The binary and the helper are unpacked from the asar archive
 * by electron-builder.
 */
async function readActiveWindow(): Promise<ActiveWindow | null> {
  const raw = await platformReader()?.()
  if (!raw) return null

  const name = cleanAppName(raw.owner?.name, raw.owner?.path)
  if (!name) return null

  return { app: name, title: cleanTitle(raw.title) }
}

interface RawWindow {
  title?: string
  owner?: { name?: string; path?: string }
}

type Reader = () => Promise<RawWindow | null | undefined>

/** Resolved once. `null` once this machine has been found unable to read windows. */
let reader: Reader | null | undefined

function platformReader(): Reader | null {
  if (reader !== undefined) return reader

  try {
    // Resolves to the package's own entry file; its folder is the package.
    const root = unpacked(dirname(require.resolve('get-windows')))

    if (process.platform === 'win32') {
      if (process.arch !== 'x64') throw new Error(`No Windows binary for ${process.arch}`)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require(
        join(root, 'lib', 'binding', 'napi-9-win32-unknown-x64', 'node-get-windows.node')
      ) as { getActiveWindow(): RawWindow | undefined }
      reader = async () => addon.getActiveWindow()
    } else if (process.platform === 'darwin') {
      const helper = join(root, 'main')
      const run = promisify(execFile)
      reader = async () => {
        // Screen Recording is what lets macOS hand over titles; the app already
        // needs it for screenshots. Accessibility is only for browser URLs,
        // which are not read.
        const { stdout } = await run(helper, ['--no-accessibility-permission'])
        return JSON.parse(stdout) as RawWindow | null
      }
    } else if (process.platform === 'linux') {
      const modulePromise = import(pathToFileURL(join(root, 'lib', 'linux.js')).href) as Promise<{
        activeWindow(): Promise<RawWindow | undefined>
      }>
      reader = async () => (await modulePromise).activeWindow()
    } else {
      reader = null
    }
  } catch (error) {
    logger.warn(SCOPE, 'The window in front cannot be read on this machine', error)
    reader = null
  }

  return reader
}

/** Files that run or load natively live in `app.asar.unpacked` once packaged. */
function unpacked(path: string): string {
  return path.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
}

function cleanAppName(name?: string, path?: string): string | null {
  const fromName = (name ?? '').trim()
  const fromPath = path ? basename(path).replace(/\.exe$/i, '').trim() : ''
  const chosen = fromName || fromPath
  return chosen ? chosen.slice(0, 200) : null
}

function cleanTitle(title?: string): string {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  if (PRIVATE_WINDOW.test(clean)) return '(private window)'
  return clean.slice(0, MAX_TITLE_LENGTH)
}
