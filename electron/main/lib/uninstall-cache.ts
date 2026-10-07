import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type UninstallHash, isUninstallHash } from './uninstall-hash'

/**
 * This machine's copy of the uninstall password's hash.
 *
 * Encrypted with the OS keychain, so only this Windows user's processes can
 * read it — the app that keeps it current, and the uninstall guard that checks
 * against it. Separate from the sync service so the guard can read it without
 * loading anything to do with signing in.
 */

const CACHE_FILE = 'uninstall-guard.bin'

function cachePath(): string {
  return join(app.getPath('userData'), CACHE_FILE)
}

/** The copy on this machine, or null when there is none or it cannot be read. */
export async function readCachedUninstallHash(): Promise<UninstallHash | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const parsed: unknown = JSON.parse(safeStorage.decryptString(await readFile(cachePath())))
    return isUninstallHash(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function writeCachedUninstallHash(value: UninstallHash): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) return
  await writeFile(cachePath(), safeStorage.encryptString(JSON.stringify(value)))
}
