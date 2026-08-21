import type { AuthUser, SignInInput } from '@shared/types'
import { IpcError, unwrap } from './ipc'

/**
 * The account API as the UI sees it.
 *
 * Everything here is a thin pass-through to the main process, which owns the
 * Supabase client. No token, client or key exists in this window — a signed-in
 * renderer holds nothing but a name and an email.
 */

export type { AuthUser, SignInInput }

/** An error whose message is safe to show in the form. */
export class AuthError extends Error {
  /** Optional second line, e.g. what to do about it. */
  readonly hint: string | undefined

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'AuthError'
    this.hint = hint
  }
}

export async function signIn(input: SignInInput): Promise<AuthUser> {
  return call(() => window.api.auth.signIn(input))
}

export async function signOut(): Promise<void> {
  return call(() => window.api.auth.signOut())
}

/** Ends the session on every device, this one included. */
export async function signOutEverywhere(): Promise<void> {
  return call(() => window.api.auth.signOutEverywhere())
}

/**
 * The account signed in on a previous run, or `null`.
 *
 * The main process exchanges the stored refresh token for a fresh session, so
 * this can take a moment on a cold start and resolves to `null` offline.
 */
export async function restoreSession(): Promise<AuthUser | null> {
  return call(() => window.api.auth.session())
}

/* -------------------------------------------------------------------------- */

/** Re-labels IPC failures as `AuthError`, which the dialog knows how to show. */
async function call<T>(request: () => Promise<import('@shared/types').IpcResult<T>>): Promise<T> {
  try {
    return await unwrap(request())
  } catch (error) {
    if (error instanceof IpcError) throw new AuthError(error.message, error.hint)
    throw new AuthError('Something went wrong. Please try again.')
  }
}

/* --------------------------------- Rules ---------------------------------- */

/**
 * Minimum password length the sign-up form enforces.
 *
 * Supabase's own default is 6; this is deliberately stricter, and the server
 * remains free to refuse more.
 */
export const MIN_PASSWORD_LENGTH = 8

/**
 * Deliberately permissive: the server is the authority on whether an address
 * exists, and an over-strict pattern only rejects valid, unusual addresses.
 */
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())
}
