import type { UninstallPasswordInfo } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { readCachedUninstallHash, writeCachedUninstallHash } from '../lib/uninstall-cache'
import { hashUninstallPassword, isUninstallHash } from '../lib/uninstall-hash'
import { currentUser, getSupabase } from './auth'

const SCOPE = 'uninstall-password'

/**
 * Keeping this machine's copy of the uninstall password current.
 *
 * The device admins change the password from Settings; the server keeps only
 * its hash. Every app copies that hash down and stores it encrypted for the
 * current Windows user, so the uninstaller — which may run with no network and
 * nobody signed in — can still check against the latest password. Until a copy
 * exists, the guard falls back to the hash built into the installer.
 */

/** How often the server's hash is fetched. A changed password reaches machines within this. */
const SYNC_INTERVAL_MS = 5 * 60_000

let timer: NodeJS.Timeout | null = null

export function startUninstallPasswordSync(): void {
  if (timer) return
  timer = setInterval(() => void syncUninstallPassword(), SYNC_INTERVAL_MS)
  // Shortly after start, once a stored session has had the chance to come back.
  setTimeout(() => void syncUninstallPassword(), 20_000)
}

/** Never throws: the copy already on disk, or the built-in hash, still protects. */
export async function syncUninstallPassword(): Promise<void> {
  if (!currentUser()) return

  try {
    const { data, error } = await getSupabase().rpc('uninstall_password_hash')
    if (error) throw error
    if (!isUninstallHash(data)) return // None set from Settings yet.

    const current = await readCachedUninstallHash()
    if (current && current.salt === data.salt && current.hash === data.hash) return

    await writeCachedUninstallHash({ salt: data.salt, hash: data.hash })
    logger.info(SCOPE, 'Uninstall password updated on this machine')
  } catch (error) {
    logger.debug(SCOPE, 'Could not fetch the uninstall password', error)
  }
}

/* -------------------------------------------------------------------------- */
/*                         Settings — device admins only                      */
/* -------------------------------------------------------------------------- */

export async function uninstallPasswordInfo(): Promise<UninstallPasswordInfo> {
  if (!currentUser()) return { updatedAt: null }

  const { data, error } = await getSupabase().rpc('uninstall_password_hash')
  if (error) {
    logger.debug(SCOPE, 'Could not read when the uninstall password changed', error)
    return { updatedAt: null }
  }

  const row = data as { updated_at?: string } | null
  return { updatedAt: row?.updated_at ?? null }
}

/**
 * Sets a new password for every machine. Hashed here; only the hash is sent.
 * This machine's copy is replaced at once rather than at the next sync.
 */
export async function setUninstallPassword(password: string): Promise<UninstallPasswordInfo> {
  if (!currentUser()) throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign in to change the uninstall password.')

  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'Use at least 8 characters.')
  }

  const hashed = hashUninstallPassword(password)

  const { data, error } = await getSupabase().rpc('set_uninstall_password', {
    p_salt: hashed.salt,
    p_hash: hashed.hash
  })

  if (error) {
    logger.error(SCOPE, 'Could not change the uninstall password', error)
    if (error.code === '42501') {
      throw new AppError(ERROR_CODES.AUTH_FAILED, 'This account cannot change the uninstall password.')
    }
    if (error.code === 'PGRST202' || error.code === '42883') {
      throw new AppError(
        ERROR_CODES.UNKNOWN,
        'The uninstall password is not set up on the server yet.',
        'Apply the uninstall_password migration to the Supabase project.'
      )
    }
    throw new AppError(ERROR_CODES.UNKNOWN, 'Could not change the uninstall password.', error.message)
  }

  await writeCachedUninstallHash(hashed)
  logger.info(SCOPE, 'Uninstall password changed')
  return { updatedAt: typeof data === 'string' ? data : new Date().toISOString() }
}
