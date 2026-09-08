import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import type { AuthUser, SignInInput, UserRole } from '@shared/types'
import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from '../config/supabase'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { getDeviceIdentity, setDeviceId } from './device'

const SCOPE = 'auth'

/**
 * Accounts, kept entirely inside the main process.
 *
 * The renderer never sees an access or refresh token: it asks this module to
 * sign in and gets back a name and an email. That is what makes it safe for the
 * anon key to ship in the app — a compromised page has nothing to steal and no
 * client to make requests with.
 *
 * The refresh token is written to disk encrypted with Electron's `safeStorage`,
 * which is backed by the OS keychain (DPAPI on Windows, libsecret/kwallet on
 * Linux). Where no keychain is available the token is simply not stored: an
 * extra sign-in per launch is a far better trade than a bearer token sitting in
 * a readable file.
 */

/** Encrypted refresh token. Not JSON — the bytes are a `safeStorage` blob. */
const SESSION_FILE = 'auth.bin'

let client: SupabaseClient | null = null
/** Mirrors the client's session so `currentUser()` needs no network call. */
let currentSession: Session | null = null

/** See {@link sessionRestoreAttempted}. */
let restoreAttempted = false

/**
 * What `profiles` says about the signed-in account.
 *
 * Read from the table rather than from the token, for two reasons. The role is
 * this application's and has to be current — one minted before a promotion
 * would keep claiming the old answer until it expired. And the address on the
 * Supabase account is a placeholder that cannot receive mail, so the person's
 * real one exists only on their profile row.
 *
 * Null until it has been read, and every fallback below is the least privileged
 * one, so a failed read can never grant anything.
 */
interface ProfileSnapshot {
  role: UserRole
  /**
   * The role exactly as stored, which `role` above is not.
   *
   * `role` is narrowed to the three the code knows by name, so a role somebody
   * has since invented reads as `user` — the least privileged answer, and the
   * right one for the old role tests that still exist. This keeps the real key,
   * for the screens that hand roles out and for showing somebody what they are.
   */
  roleKey: string
  /** The role's own name for itself, for showing rather than testing. */
  roleLabel: string
  /** True for a role that answers yes to everything without a lookup. */
  fullAccess: boolean
  /** What this account may do, resolved from its role. Empty on any failure. */
  permissions: string[]
  email: string
  name: string
  /**
   * Who this person is in Nexus.
   *
   * Kept here because it is the identity the Call Manager works in: a call is
   * assigned to a Nexus id, and can be assigned to somebody who has never
   * opened this app and so has no profile at all.
   */
  nexusUserId: string | null
}

let currentProfile: ProfileSnapshot | null = null

function sessionPath(): string {
  return join(app.getPath('userData'), SESSION_FILE)
}

/**
 * The shared Supabase client, for services other than this one.
 *
 * It carries whatever session is current, so every query those services make is
 * subject to the same row level security as the signed-in user.
 */
export function getSupabase(): SupabaseClient {
  return getClient()
}

function getClient(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new AppError(
      ERROR_CODES.AUTH_NOT_CONFIGURED,
      'Accounts are not available in this build.',
      'No Supabase project was configured when the app was packaged.'
    )
  }

  if (client) return client

  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // supabase-js would otherwise reach for `localStorage`, which does not
      // exist here — and a plain file is not where a refresh token belongs.
      persistSession: false,
      // Refreshing in the background matters: the window can sit in the tray for
      // hours between recordings and must not come back signed out.
      autoRefreshToken: true,
      // There is no browser redirect to read a session out of.
      detectSessionInUrl: false
    }
  })

  // One place to notice every session change, whoever caused it — sign-in,
  // sign-out, or a background refresh an hour from now.
  client.auth.onAuthStateChange((event, session) => {
    currentSession = session
    logger.debug(SCOPE, 'Auth state changed', { event, user: session?.user?.email ?? null })

    if (session?.refresh_token) {
      void persistRefreshToken(session.refresh_token)
      return
    }

    // Only an actual sign-out throws the stored token away. Creating the client
    // emits INITIAL_SESSION with no session — deleting on that would erase a
    // perfectly good token a moment before it is used to restore, and would
    // strand the user permanently whenever the refresh failed (offline start).
    if (event === 'SIGNED_OUT') void clearRefreshToken()
  })

  return client
}

/* -------------------------------------------------------------------------- */
/*                                   Public                                   */
/* -------------------------------------------------------------------------- */

/**
 * Restores the session saved by an earlier run, if there is one.
 *
 * Only the refresh token is kept, so this exchanges it for a fresh session.
 * Any failure — expired token, revoked account, no network — resolves to `null`
 * rather than throwing: startup must never be blocked by the account layer.
 */
export async function restoreSession(): Promise<AuthUser | null> {
  restoreAttempted = true

  if (!isSupabaseConfigured()) return null

  const refreshToken = await readRefreshToken()
  if (!refreshToken) return null

  try {
    const { data, error } = await getClient().auth.refreshSession({
      refresh_token: refreshToken
    })

    if (error || !data.session) {
      /*
       * Only a refusal throws the token away.
       *
       * A refresh that failed because there was no network says nothing about
       * whether the token is still good, and deleting it there would mean one
       * offline boot signs the machine out for good — the person would have to
       * type their password again, and everything keyed to their account,
       * tracking included, would stop until they did.
       */
      if (isRetryable(error)) {
        logger.info(SCOPE, 'Session could not be refreshed; keeping it for the next try', {
          reason: error?.message
        })
        return null
      }

      logger.info(SCOPE, 'Stored session was refused', { reason: error?.message })
      await clearRefreshToken()
      return null
    }

    currentSession = data.session
    await loadProfile(data.session.user.id)

    logger.info(SCOPE, 'Session restored', { role: currentProfile?.role })
    return toAuthUser(data.session)
  } catch (error) {
    logger.warn(SCOPE, 'Session restore failed', error)
    return null
  }
}

/**
 * Whether a failed refresh is worth trying again, or is the server saying no.
 *
 * A revoked account, a signed-out session and an expired token all come back
 * with a 4xx and mean the token is finished. Anything without a status at all
 * is the fetch never having got there, and anything in the 5xx range is the
 * server having a bad minute — neither is an answer about the token.
 */
function isRetryable(error: { status?: number; name?: string } | null): boolean {
  if (!error) return false
  if (error.name === 'AuthRetryableFetchError') return true

  const status = error.status ?? 0
  return status === 0 || status >= 500
}

/**
 * Re-reads what the signed-in account is allowed to do.
 *
 * Deliberately not `restoreSession`. That refreshes the token — a round trip
 * that also rotates it — and, more to the point, the IPC handler memoises its
 * result so the second caller gets the first caller's answer. Permissions
 * therefore never changed for a window that stayed open.
 *
 * This keeps the session exactly as it is and asks the two questions that can
 * actually have changed since: which role this person holds, and what that role
 * carries. Cheap enough to call whenever the window comes back to them.
 */
export async function refreshAccount(): Promise<AuthUser | null> {
  if (!currentSession) return null

  await loadProfile(currentSession.user.id)
  return toAuthUser(currentSession)
}

/** The signed-in account without touching the network, or `null`. */
export function currentUser(): AuthUser | null {
  return currentSession ? toAuthUser(currentSession) : null
}

/**
 * The signed-in person's Nexus id, or null while nobody is signed in — or when
 * their profile has never been linked, which is only possible for an account
 * that predates Nexus and has not signed in since.
 *
 * This is the identity the Call Manager is keyed by. `auth.uid()` answers "who
 * is using this app"; this answers "who are they at work", and a call can be
 * scheduled for somebody who has only ever been the second of those.
 */
export function currentNexusId(): string | null {
  return currentProfile?.nexusUserId ?? null
}

/**
 * Whether restoring the stored session has been tried yet.
 *
 * Anything that would act on the *absence* of a session has to wait for this,
 * because for the first second or two of every run there is no session simply
 * because nobody has asked for one yet. Acting early would read a machine that
 * is about to sign in as one that is offline.
 */
export function sessionRestoreAttempted(): boolean {
  return restoreAttempted
}

/**
 * Whether this machine holds a session, whether or not it can currently use it.
 *
 * The difference between "signed out" and "signed in but offline", which no
 * other signal here draws: `currentUser()` is null for both. Anything that must
 * keep working through an outage — recording a day before the network comes
 * back — needs to tell them apart, because one means carry on and the other
 * means stop.
 */
export async function hasStoredSession(): Promise<boolean> {
  if (currentSession) return true
  return (await readRefreshToken()) !== null
}

/** The live session, for operations that only make sense signed in. */
function requireSession(): Session {
  if (!currentSession) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'You are not signed in.', 'Sign in and try again.')
  }
  return currentSession
}

interface LoginResponse {
  ok?: boolean
  error?: string
  retry_after?: number
  access_token?: string
  refresh_token?: string
  device_id?: string | null
}

/**
 * Signs in through Nexus.
 *
 * The password goes to the `login` edge function and nowhere else. That function
 * is the only thing holding the Nexus API key — which is why it exists at all,
 * since a key that can attempt logins against an entire company's staff cannot
 * travel inside a desktop application.
 *
 * What comes back is an ordinary Supabase session, so everything after this
 * line behaves exactly as it did before: the refresh token is encrypted to the
 * keychain, expiry and renewal stay the platform's job, and every query the
 * app makes is subject to the same row level security as before.
 */
export async function signIn({ email, password }: SignInInput): Promise<AuthUser> {
  if (!isSupabaseConfigured()) {
    throw new AppError(ERROR_CODES.AUTH_NOT_CONFIGURED, 'Accounts are not available in this build.')
  }

  // Sent with the request so the machine is registered as part of signing in,
  // rather than in a second call that could fail on its own and leave a session
  // belonging to no device.
  const device = await getDeviceIdentity()

  let response: Response
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Edge functions want a project token. The anon key is one, and it
        // grants nothing on its own.
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: JSON.stringify({ email: email.trim(), password, device })
    })
  } catch (error) {
    networkFailure(error)
  }

  const payload = (await response.json().catch(() => ({}))) as LoginResponse

  if (!response.ok || payload.ok !== true) {
    throw translateLoginError(payload.error, response.status, payload.retry_after)
  }

  if (!payload.access_token || !payload.refresh_token) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign-in did not return a session.')
  }

  const { data, error } = await getClient().auth.setSession({
    access_token: payload.access_token,
    refresh_token: payload.refresh_token
  })

  if (error || !data.session) {
    throw translateAuthError(error ?? { message: 'Could not start a session.' })
  }

  currentSession = data.session
  setDeviceId(payload.device_id ?? null)
  await loadProfile(data.session.user.id)

  logger.info(SCOPE, 'Signed in', {
    role: currentProfile?.role,
    device: payload.device_id ?? 'unregistered'
  })

  return toAuthUser(data.session)
}

/*
 * There is no sign-up here, and no password change.
 *
 * Accounts are created in Nexus and passwords are set there. This app has no
 * way to make either happen and should not pretend otherwise: a form that
 * created a second, unrelated account, or changed a password that is not the
 * one anybody signs in with, would be worse than no form at all.
 */

/**
 * Adopts the session carried by a confirmation or recovery link.
 *
 * Supabase redirects to the app's own scheme and puts the tokens in the URL
 * fragment, e.g.
 *   screenrecorder://auth/callback#access_token=…&refresh_token=…&type=signup
 *
 * A link that carries no tokens (an expired one, or a user who declined) is not
 * an error worth interrupting anybody over — it resolves to `null`.
 */
export async function applyAuthCallback(rawUrl: string): Promise<AuthUser | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    logger.warn(SCOPE, 'Ignoring malformed auth callback')
    return null
  }

  // Tokens arrive in the fragment; errors can arrive in either half.
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''))
  const query = url.searchParams

  const errorDescription = fragment.get('error_description') ?? query.get('error_description')
  if (errorDescription) {
    logger.warn(SCOPE, 'Auth callback reported an error', { error: errorDescription })
    throw new AppError(ERROR_CODES.AUTH_FAILED, errorDescription)
  }

  const accessToken = fragment.get('access_token')
  const refreshToken = fragment.get('refresh_token')

  if (!accessToken || !refreshToken) {
    logger.info(SCOPE, 'Auth callback carried no session', { type: fragment.get('type') })
    return null
  }

  const { data, error } = await getClient()
    .auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
    .catch(networkFailure)

  if (error || !data.session) throw translateAuthError(error ?? { message: 'Link expired.' })

  currentSession = data.session
  await loadProfile(data.session.user.id)

  logger.info(SCOPE, 'Signed in from a link', { type: fragment.get('type') })

  return toAuthUser(data.session)
}

/*
 * Renaming used to live here too, and does not any more.
 *
 * The name is Nexus's — `login` copies it across on every sign-in, so anything
 * typed here would be silently overwritten the next morning. Somewhere that
 * shows a person a field, accepts their edit and then throws it away is worse
 * than somewhere that does not offer the field.
 */

/**
 * Ends the session on every device, not just this one.
 *
 * The local session goes with it — a "sign out everywhere" that left this
 * machine signed in would be a lie.
 */
export async function signOutEverywhere(): Promise<void> {
  requireSession()

  try {
    const { error } = await getClient().auth.signOut({ scope: 'global' })
    if (error) throw translateAuthError(error)
    logger.info(SCOPE, 'Signed out on every device')
  } finally {
    forgetSession()
    await clearRefreshToken()
  }
}

export async function signOut(): Promise<void> {
  try {
    await getClient().auth.signOut()
  } catch (error) {
    // A failure here means the server did not hear about it. The local session
    // still has to go — the user asked to leave.
    logger.warn(SCOPE, 'Sign-out request failed, clearing locally', error)
  } finally {
    forgetSession()
    await clearRefreshToken()
    logger.info(SCOPE, 'Signed out')
  }
}

/** Everything this process knows about who is signed in, dropped together. */
function forgetSession(): void {
  currentSession = null
  currentProfile = null
  setDeviceId(null)
}

/* -------------------------------------------------------------------------- */
/*                              Token persistence                             */
/* -------------------------------------------------------------------------- */

async function persistRefreshToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    logger.warn(
      SCOPE,
      'No OS keychain available; the session will not survive a restart'
    )
    return
  }

  try {
    await writeFile(sessionPath(), safeStorage.encryptString(token))
  } catch (error) {
    logger.warn(SCOPE, 'Could not store the session', error)
  }
}

async function readRefreshToken(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null

  try {
    const encrypted = await readFile(sessionPath())
    return safeStorage.decryptString(encrypted)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing file is the normal "nobody has signed in yet" case.
    if (code !== 'ENOENT') {
      logger.warn(SCOPE, 'Stored session could not be read', error)
      await clearRefreshToken()
    }
    return null
  }
}

async function clearRefreshToken(): Promise<void> {
  try {
    await unlink(sessionPath())
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') logger.warn(SCOPE, 'Could not clear the stored session', error)
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Internals                                 */
/* -------------------------------------------------------------------------- */

function toAuthUser(session: Session): AuthUser {
  /*
   * Neither the name nor the address comes off the session.
   *
   * The Supabase account carries a placeholder address that cannot receive mail
   * — it exists so nobody can obtain a session by asking Supabase for a password
   * reset instead of going through Nexus. Showing it would be showing somebody
   * an implementation detail where they expect their own email.
   */
  const email = currentProfile?.email ?? ''

  return {
    id: session.user.id,
    email,
    name: currentProfile?.name || nameFromEmail(email),
    role: currentProfile?.role ?? 'user',
    roleKey: currentProfile?.roleKey ?? 'user',
    roleLabel: currentProfile?.roleLabel ?? 'User',
    fullAccess: currentProfile?.fullAccess ?? false,
    permissions: currentProfile?.permissions ?? [],
    nexusUserId: currentProfile?.nexusUserId ?? null
  }
}

/**
 * Reads the profile row and caches it for the rest of the session.
 *
 * Any failure — no row yet, no network — leaves the role at `user` and the name
 * falling back to the address. Guessing upwards would hand out privileges on an
 * error.
 */
async function loadProfile(userId: string): Promise<void> {
  currentProfile = null

  try {
    const { data, error } = await getClient()
      .from('profiles')
      .select('email, full_name, role, nexus_user_id')
      .eq('id', userId)
      .single()

    if (error) {
      logger.warn(SCOPE, 'Could not read the profile', error)
      return
    }

    const row = (data ?? {}) as {
      email?: unknown
      full_name?: unknown
      role?: unknown
      nexus_user_id?: unknown
    }

    const email = typeof row.email === 'string' ? row.email : ''
    const name = typeof row.full_name === 'string' ? row.full_name.trim() : ''

    const roleKey = typeof row.role === 'string' && row.role ? row.role : 'user'
    const grant = await loadRole(roleKey)
    const permissions = grant.fullAccess
      ? grant.permissions
      : await applyOverrides(userId, grant.permissions)

    currentProfile = {
      role: roleKey === 'super_admin' ? 'super_admin' : roleKey === 'admin' ? 'admin' : 'user',
      roleKey,
      roleLabel: grant.label,
      fullAccess: grant.fullAccess,
      permissions,
      email,
      name: name || nameFromEmail(email),
      nexusUserId: typeof row.nexus_user_id === 'string' ? row.nexus_user_id : null
    }
  } catch (error) {
    logger.warn(SCOPE, 'Profile lookup failed', error)
  }
}

/**
 * What a role carries.
 *
 * One read with the grants embedded, because both halves are needed together
 * and neither is worth a second round trip on every sign-in.
 *
 * Every failure lands on nothing — no label, no full access, no permissions.
 * The window then offers nothing, which is recoverable; the opposite mistake is
 * handing somebody an administrator's buttons because a query timed out.
 */
async function loadRole(
  roleKey: string
): Promise<{ label: string; fullAccess: boolean; permissions: string[] }> {
  const empty = { label: roleKey, fullAccess: false, permissions: [] as string[] }

  try {
    const { data, error } = await getClient()
      .from('app_roles')
      .select('label, full_access, role_permissions(permission_key)')
      .eq('key', roleKey)
      .maybeSingle()

    if (error) {
      logger.warn(SCOPE, 'Could not read what this role may do', error)
      return empty
    }

    if (!data) {
      logger.warn(SCOPE, 'Signed in with a role that no longer exists', { roleKey })
      return empty
    }

    const row = data as {
      label?: unknown
      full_access?: unknown
      role_permissions?: Array<{ permission_key?: unknown }> | null
    }

    return {
      label: typeof row.label === 'string' && row.label ? row.label : roleKey,
      fullAccess: row.full_access === true,
      permissions: (row.role_permissions ?? [])
        .map((grant) => grant.permission_key)
        .filter((key): key is string => typeof key === 'string')
    }
  } catch (error) {
    logger.warn(SCOPE, 'Role lookup failed', error)
    return empty
  }
}

/**
 * The role's permissions with this person's own exceptions applied.
 *
 * The same precedence the database uses, worked out again here so the window
 * shows what the server will actually allow: an override wins over the role, in
 * both directions. A full-access role never reaches this — nothing overrides
 * everything.
 *
 * A failed read leaves the role's own answer standing. That is the honest
 * fallback: it is what this account had before anybody made an exception, and
 * the database is still the one deciding.
 */
async function applyOverrides(userId: string, fromRole: string[]): Promise<string[]> {
  try {
    const { data, error } = await getClient()
      .from('user_permissions')
      .select('permission_key, granted')
      .eq('user_id', userId)

    if (error) {
      logger.warn(SCOPE, 'Could not read this account’s own permissions', error)
      return fromRole
    }

    const rows = (data ?? []) as Array<{ permission_key?: unknown; granted?: unknown }>
    if (rows.length === 0) return fromRole

    const effective = new Set(fromRole)

    for (const row of rows) {
      if (typeof row.permission_key !== 'string') continue
      if (row.granted === true) effective.add(row.permission_key)
      else effective.delete(row.permission_key)
    }

    return [...effective]
  } catch (error) {
    logger.warn(SCOPE, 'Permission overrides lookup failed', error)
    return fromRole
  }
}

/**
 * Turns a `login` failure into something worth showing a user.
 *
 * The codes come from Nexus and are kept apart rather than collapsed, because
 * each one means something different to the person at the keyboard: a wrong
 * password, an account that no longer works here, or a wait. One flat "login
 * failed" would leave somebody retyping a password that was never the problem.
 */
function translateLoginError(
  code: string | undefined,
  status: number,
  retryAfter?: number
): AppError {
  switch (code) {
    case 'invalid_credentials':
      return new AppError(
        ERROR_CODES.AUTH_FAILED,
        'That email and password do not match an account.'
      )

    case 'inactive_user':
      return new AppError(
        ERROR_CODES.AUTH_FAILED,
        'This account is no longer active.',
        'Your workplace account has been closed. Speak to your administrator.'
      )

    case 'rate_limited': {
      const minutes = retryAfter ? Math.ceil(retryAfter / 60) : 15
      return new AppError(
        ERROR_CODES.AUTH_FAILED,
        'Too many failed attempts.',
        `Wait about ${minutes} minute${minutes === 1 ? '' : 's'} and try again.`
      )
    }

    case 'invalid_body':
      return new AppError(ERROR_CODES.AUTH_FAILED, 'Enter your email and password.')

    case 'not_configured':
      return new AppError(
        ERROR_CODES.AUTH_NOT_CONFIGURED,
        'Sign-in is not configured on the server.',
        'The login function has no NEXUS_API_KEY secret set.'
      )

    case 'upstream_unavailable':
    case 'upstream_invalid':
      return new AppError(
        ERROR_CODES.AUTH_FAILED,
        'The sign-in service is not responding.',
        'This is usually brief. Try again in a minute.'
      )

    case 'provisioning_failed':
    case 'session_failed':
      return new AppError(
        ERROR_CODES.AUTH_FAILED,
        'Your password was correct, but the session could not be created.',
        'Try again. If it keeps happening, the server log has the reason.'
      )

    default:
      return new AppError(
        ERROR_CODES.AUTH_FAILED,
        status === 401 ? 'That email and password do not match an account.' : 'Sign-in failed.'
      )
  }
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'Account'
}

/**
 * Turns a Supabase error into something worth showing a user.
 *
 * Its messages are already written for humans ("Invalid login credentials"), so
 * most are passed through; the few that would leave someone stuck get a hint.
 */
function translateAuthError(error: { message: string; status?: number }): AppError {
  const message = error.message || 'Authentication failed.'
  const lower = message.toLowerCase()

  if (lower.includes('email not confirmed')) {
    return new AppError(
      ERROR_CODES.AUTH_FAILED,
      'This email has not been confirmed yet.',
      'Open the confirmation link we sent you, then sign in again.'
    )
  }

  if (lower.includes('invalid login credentials')) {
    return new AppError(
      ERROR_CODES.AUTH_FAILED,
      'That email and password do not match an account.'
    )
  }

  if (lower.includes('rate limit') || error.status === 429) {
    return new AppError(
      ERROR_CODES.AUTH_FAILED,
      'Too many attempts. Wait a minute and try again.'
    )
  }

  return new AppError(ERROR_CODES.AUTH_FAILED, message)
}

/**
 * supabase-js rejects rather than returning an error when the request never
 * reaches the server, which would surface as a raw "fetch failed".
 */
function networkFailure(error: unknown): never {
  logger.warn(SCOPE, 'Auth request failed to reach the server', error)

  throw new AppError(
    ERROR_CODES.AUTH_FAILED,
    'Could not reach the server.',
    'Check your internet connection and try again.'
  )
}
