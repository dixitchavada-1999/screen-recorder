import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CHROME_EXTENSION_ID,
  CHROME_UPDATE_URL,
  EDGE_EXTENSION_ID,
  EDGE_UPDATE_URL
} from '../config/browser-extension'
import { logger } from '../lib/logger'

const SCOPE = 'browser-policy'

const run = promisify(execFile)

/**
 * Makes Chrome and Edge install the browser extension, and keep it installed.
 *
 * Both browsers read a force-install list from the Windows registry — the
 * mechanism organisations use for their own extensions. An extension on it is
 * fetched from the store, updated with it, and cannot be switched off or removed
 * from the browser; the browser shows "Managed by your organisation".
 *
 * Written to the current user's hive, which needs no administrator rights, and
 * checked at every start: if the entry has gone, it is put back. The installer
 * removes it on uninstall.
 *
 * The list is numbered 1, 2, 3… and the browsers stop reading at the first gap,
 * so an entry is added at the next free number and nothing already there — an
 * organisation's own extensions — is touched.
 */

interface Target {
  browser: 'Chrome' | 'Edge'
  key: string
  entry: string
}

/**
 * Where the app notes which entry it wrote, so the uninstaller can remove that
 * one entry and nothing an organisation put there itself. Read by
 * `build/installer.nsh`; the names must match.
 */
const MARKER_KEY = 'HKCU\\Software\\Screen Recorder\\BrowserExtension'

function targets(): Target[] {
  const list: Target[] = []

  if (/^[a-p]{32}$/.test(CHROME_EXTENSION_ID)) {
    list.push({
      browser: 'Chrome',
      key: 'HKCU\\Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist',
      entry: `${CHROME_EXTENSION_ID};${CHROME_UPDATE_URL}`
    })
  }

  if (/^[a-p]{32}$/.test(EDGE_EXTENSION_ID)) {
    list.push({
      browser: 'Edge',
      key: 'HKCU\\Software\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist',
      entry: `${EDGE_EXTENSION_ID};${EDGE_UPDATE_URL}`
    })
  }

  return list
}

/** Never throws: a browser that is not installed, or a refused write, leaves the app running. */
export async function ensureBrowserExtensionPolicy(): Promise<void> {
  if (process.platform !== 'win32') return

  const list = targets()
  if (list.length === 0) {
    logger.debug(SCOPE, 'No published extension ids yet; install policy not written')
    return
  }

  for (const target of list) {
    try {
      const existing = await readList(target.key)
      const extensionId = target.entry.split(';')[0]

      const present = [...existing.entries()].find(
        ([, value]) => value.split(';')[0] === extensionId
      )
      if (present) {
        await mark(target, present[0])
        continue
      }

      let index = 1
      while (existing.has(String(index))) index += 1

      await run('reg', [
        'add',
        target.key,
        '/v',
        String(index),
        '/t',
        'REG_SZ',
        '/d',
        target.entry,
        '/f'
      ])

      await mark(target, String(index))

      logger.info(SCOPE, 'Browser extension install policy written', {
        browser: target.browser,
        index
      })
    } catch (error) {
      logger.warn(SCOPE, 'Could not write the browser extension install policy', {
        browser: target.browser,
        error
      })
    }
  }
}

/** Records which entry is ours, for the uninstaller. */
async function mark(target: Target, index: string): Promise<void> {
  const value = (name: string, data: string): string[] =>
    ['add', MARKER_KEY, '/v', name, '/t', 'REG_SZ', '/d', data, '/f']

  await run('reg', value(`${target.browser}Index`, index))
  await run('reg', value(`${target.browser}Entry`, target.entry))
}

/** The values under a force-install key, by name. Empty when the key does not exist. */
async function readList(key: string): Promise<Map<string, string>> {
  const values = new Map<string, string>()

  try {
    const { stdout } = await run('reg', ['query', key])
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s+(\S+)\s+REG_SZ\s+(.*)$/.exec(line)
      if (match) values.set(match[1]!, match[2]!.trim())
    }
  } catch {
    // `reg query` fails on a missing key, which is simply an empty list.
  }

  return values
}
