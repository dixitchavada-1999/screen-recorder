import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { logger } from '../lib/logger'

const SCOPE = 'private-window'

/**
 * Whether a browser window is a private one — Chrome Incognito, Edge InPrivate,
 * Brave's private window — so nothing about it is recorded.
 *
 * The title alone does not say. Edge puts "InPrivate" in it, but Chrome's
 * incognito window is titled exactly like any other ("Page - Google Chrome"),
 * and so is the name it gives screen readers. What does differ is the toolbar:
 * where a normal window has the profile button with the person's name, a
 * private one has a button named "Incognito" (or "InPrivate"). Windows UI
 * Automation — the interface screen readers use — can see it.
 *
 * Only the browser's own toolbar is searched. A page with a button that happens
 * to be called "Incognito" sits inside the page's document and is ignored, so
 * it cannot make an ordinary window look private.
 *
 * Reading the toolbar costs a PowerShell start, so each window is checked once
 * and the answer kept: a window cannot change between private and not. Until
 * the answer is in, the window is treated as private — the safe way to be
 * wrong for a few hundred milliseconds.
 */

/** Text in a title that marks a private window outright. */
const PRIVATE_TITLE = /\b(incognito|inprivate)\b|private browsing/i

/** Browsers whose toolbar is checked. Executable names, lower case, without `.exe`. */
const CHROMIUM_BROWSERS = new Set(['chrome', 'msedge', 'brave', 'vivaldi', 'opera'])

/** How long an answer is kept. A closed window's handle can eventually be reused. */
const ANSWER_TTL_MS = 30 * 60_000

const answers = new Map<number, { private: boolean; at: number }>()
const pending = new Set<number>()

/**
 * True when the window is private, or might be and the answer is not in yet.
 *
 * `handle` is the native window handle (`get-windows` reports it as `id` on
 * Windows); `path` the executable that owns it.
 */
export function isPrivateWindow(handle: number | undefined, path: string | undefined, title: string | undefined): boolean {
  if (title && PRIVATE_TITLE.test(title)) return true

  if (process.platform !== 'win32' || !handle || !path) return false

  const exe = basename(path).replace(/\.exe$/i, '').toLowerCase()
  if (!CHROMIUM_BROWSERS.has(exe)) return false

  const known = answers.get(handle)
  if (known && Date.now() - known.at < ANSWER_TTL_MS) return known.private

  if (!pending.has(handle)) void check(handle)
  return true
}

/* -------------------------------------------------------------------------- */

/**
 * Prints 1 when the window's toolbar has a private-window button outside any
 * page document, otherwise 0. The handle is passed in as a number only.
 */
function script(handle: number): string {
  return `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.ControlType]
$root = $A::FromHandle([IntPtr]${handle})
$cond = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, $T::Button)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
foreach ($b in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
  if ($b.Current.Name -match '^(Incognito|InPrivate|Private)$') {
    $p = $walker.GetParent($b); $inPage = $false
    while ($p -ne $null -and -not $p.Equals($root)) {
      if ($p.Current.ControlType -eq $T::Document) { $inPage = $true; break }
      $p = $walker.GetParent($p)
    }
    if (-not $inPage) { '1'; exit }
  }
}
'0'`
}

function check(handle: number): Promise<void> {
  pending.add(handle)

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script(Math.trunc(handle))],
      { timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        pending.delete(handle)

        if (error) {
          // Not recorded as an answer, so the next sample asks again; until then
          // the window stays treated as private.
          logger.debug(SCOPE, 'Could not read the browser toolbar', error)
          resolve()
          return
        }

        const isPrivate = stdout.trim().endsWith('1')
        answers.set(handle, { private: isPrivate, at: Date.now() })

        // Keeps the map from growing without bound over a long session.
        if (answers.size > 500) {
          const oldest = [...answers.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 250)
          for (const [key] of oldest) answers.delete(key)
        }

        if (isPrivate) logger.debug(SCOPE, 'Private browser window found; it will not be recorded')
        resolve()
      }
    )
  })
}
