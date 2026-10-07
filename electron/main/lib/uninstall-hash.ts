import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * How the uninstall password is hashed and checked.
 *
 * One place for the parameters, because three things must agree on them: the
 * build-time script (scripts/set-uninstall-password.mjs, which repeats them
 * because it runs outside the app), the Settings screen that changes the
 * password, and the uninstall guard that checks it.
 */

const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_LENGTH = 32

export interface UninstallHash {
  /** 16 bytes, hex. */
  salt: string
  /** 32 bytes, hex. */
  hash: string
}

export function hashUninstallPassword(password: string): UninstallHash {
  const salt = randomBytes(16)
  return {
    salt: salt.toString('hex'),
    hash: scryptSync(password, salt, KEY_LENGTH, PARAMS).toString('hex')
  }
}

export function checkUninstallPassword(password: string, stored: UninstallHash): boolean {
  const expected = Buffer.from(stored.hash, 'hex')
  const actual = scryptSync(password, Buffer.from(stored.salt, 'hex'), KEY_LENGTH, PARAMS)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function isUninstallHash(value: unknown): value is UninstallHash {
  if (!value || typeof value !== 'object') return false
  const { salt, hash } = value as Record<string, unknown>
  return (
    typeof salt === 'string' &&
    /^[0-9a-f]{32}$/.test(salt) &&
    typeof hash === 'string' &&
    /^[0-9a-f]{64}$/.test(hash)
  )
}
