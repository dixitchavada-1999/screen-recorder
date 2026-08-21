import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type { GoogleAccount } from '@shared/types'
import {
  GOOGLE_AUTH_ENDPOINT,
  GOOGLE_AUTH_TIMEOUT_MS,
  GOOGLE_CALENDAR_API,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_HOST,
  GOOGLE_REDIRECT_PATH,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  accountColor,
  isGoogleConfigured
} from '../config/google'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { showMainWindow } from '../window'

const SCOPE = 'google-accounts'

/**
 * Connected Google accounts and their tokens.
 *
 * Several accounts are connected at once by design — a person with a work and
 * two personal addresses wants all three calendars in one place — so everything
 * here is keyed by email rather than assuming a single session.
 *
 * Refresh tokens never leave this process and never reach Supabase. They are
 * written to disk encrypted with `safeStorage`, exactly as the Supabase session
 * is: the OS keychain holds the key, and where there is no keychain the tokens
 * are simply not persisted, costing a reconnect per launch instead of leaving
 * long-lived credentials in a readable file.
 *
 * The integration is read-only. Nothing here can write to anyone's calendar —
 * the granted scope does not allow it.
 */

/** Encrypted JSON array of `StoredAccount`. Not readable without the keychain. */
const ACCOUNTS_FILE = 'google-accounts.bin'

interface StoredAccount {
  email: string
  refreshToken: string
  connectedAt: string
}

/**
 * Loaded accounts, in connection order.
 *
 * Order is meaningful: it decides the colour each account's calls are drawn in,
 * so it stays stable across restarts and only changes when one is removed.
 */
let accounts: StoredAccount[] | null = null

/** Short-lived access tokens, kept in memory only. */
const accessTokens = new Map<string, { token: string; expiresAt: number }>()

/**
 * Accounts whose refresh token Google has stopped honouring.
 *
 * In memory rather than on disk on purpose: the only way to find out is to be
 * refused, so a restart should try once more before declaring the connection
 * dead — the previous refusal may have been a bad network rather than a dead
 * grant.
 */
const expired = new Set<string>()

/** One consent flow at a time; two would fight over the browser and the store. */
let connecting = false

function accountsPath(): string {
  return join(app.getPath('userData'), ACCOUNTS_FILE)
}

/* -------------------------------------------------------------------------- */
/*                                 Persistence                                */
/* -------------------------------------------------------------------------- */

async function load(): Promise<StoredAccount[]> {
  if (accounts) return accounts

  if (!safeStorage.isEncryptionAvailable()) {
    logger.warn(SCOPE, 'No OS keychain available; connected accounts will not persist')
    accounts = []
    return accounts
  }

  try {
    const encrypted = await readFile(accountsPath())
    const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted))
    accounts = Array.isArray(parsed) ? (parsed as StoredAccount[]) : []
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing file is the normal "nothing connected yet" case.
    if (code !== 'ENOENT') {
      logger.warn(SCOPE, 'Stored Google accounts could not be read', error)
    }
    accounts = []
  }

  return accounts
}

async function save(): Promise<void> {
  const current = accounts ?? []

  if (!safeStorage.isEncryptionAvailable()) return

  try {
    if (current.length === 0) {
      await unlink(accountsPath()).catch(() => undefined)
      return
    }
    await writeFile(accountsPath(), safeStorage.encryptString(JSON.stringify(current)))
  } catch (error) {
    logger.warn(SCOPE, 'Could not store connected Google accounts', error)
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Public                                   */
/* -------------------------------------------------------------------------- */

/** The connected accounts, as the UI sees them — no tokens. */
export async function listGoogleAccounts(): Promise<GoogleAccount[]> {
  const stored = await load()
  return stored.map((account, index) => ({
    email: account.email,
    color: accountColor(index),
    connectedAt: account.connectedAt,
    expired: expired.has(account.email)
  }))
}

/** Emails only, for callers that just need to iterate the connected calendars. */
export async function connectedEmails(): Promise<string[]> {
  return (await load()).map((account) => account.email)
}

/**
 * Runs the consent flow and stores the resulting account.
 *
 * Reconnecting an address that is already present replaces its token rather
 * than adding a second entry — that is how an expired or revoked grant is
 * repaired, and it keeps the account's colour where it was.
 */
export async function connectGoogleAccount(reconnecting?: string): Promise<GoogleAccount> {
  requireConfigured()

  if (connecting) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'A Google sign-in is already in progress.',
      'Finish or close the browser window that just opened.'
    )
  }

  connecting = true
  try {
    const { refreshToken, accessToken, email } = await runConsentFlow(reconnecting)

    // Whatever was wrong with the old grant, this is a new one.
    expired.delete(email)

    const stored = await load()
    const existing = stored.findIndex((account) => account.email === email)

    if (existing >= 0) {
      stored[existing] = { email, refreshToken, connectedAt: stored[existing]!.connectedAt }
      logger.info(SCOPE, 'Google account reconnected', { email })
    } else {
      stored.push({ email, refreshToken, connectedAt: new Date().toISOString() })
      logger.info(SCOPE, 'Google account connected', { email })
    }

    await save()

    // The token just issued is good for an hour; keeping it saves the first
    // sync an immediate refresh round trip.
    cacheAccessToken(email, accessToken, 3600)

    const index = stored.findIndex((account) => account.email === email)
    return {
      email,
      color: accountColor(index),
      connectedAt: stored[index]!.connectedAt,
      expired: false
    }
  } finally {
    connecting = false
  }
}

/**
 * Forgets an account and tells Google to invalidate the grant.
 *
 * Revocation is attempted but not required to succeed: if the token is already
 * dead, or the machine is offline, forgetting it locally is still the right
 * outcome — the alternative is an account the user cannot get rid of.
 */
export async function disconnectGoogleAccount(email: string): Promise<void> {
  const stored = await load()
  const index = stored.findIndex((account) => account.email === email)
  if (index < 0) return

  const [removed] = stored.splice(index, 1)
  accessTokens.delete(email)
  await save()

  try {
    await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: removed!.refreshToken })
    })
  } catch (error) {
    logger.warn(SCOPE, 'Could not revoke the Google token', { email, error })
  }

  logger.info(SCOPE, 'Google account disconnected', { email })
}

/**
 * A usable access token for one account, refreshing it when necessary.
 *
 * Throws when the grant is gone — the user revoked it in their Google settings,
 * or changed their password. That is not recoverable here, so the message says
 * to reconnect rather than pretending a retry might help.
 */
export async function getAccessToken(email: string): Promise<string> {
  requireConfigured()

  const cached = accessTokens.get(email)
  // A minute of headroom: a token that expires mid-request is a failed request.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token

  const stored = await load()
  const account = stored.find((entry) => entry.email === email)
  if (!account) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, `${email} is not connected.`)
  }

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token'
    })
  })

  if (!response.ok) {
    logger.error(SCOPE, 'Refreshing the Google token failed', {
      email,
      status: response.status,
      body: await response.text().catch(() => '')
    })

    /*
     * A refused refresh is the end of the road for this grant.
     *
     * There is nothing to retry with: the refresh token *is* the credential,
     * and Google only issues another one to a browser the user is sitting in
     * front of. Recording it here is what lets the Calendars list show the
     * account as needing attention instead of the app quietly not syncing.
     */
    expired.add(email)

    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      `Google access for ${email} has expired.`,
      'Open Calendars and press Reconnect — it takes one click.'
    )
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number }
  if (!payload.access_token) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, `Google returned no access token for ${email}.`)
  }

  cacheAccessToken(email, payload.access_token, payload.expires_in ?? 3600)
  return payload.access_token
}

function cacheAccessToken(email: string, token: string, expiresInSeconds: number): void {
  accessTokens.set(email, { token, expiresAt: Date.now() + expiresInSeconds * 1000 })
}

function requireConfigured(): void {
  if (isGoogleConfigured()) return

  throw new AppError(
    ERROR_CODES.AUTH_NOT_CONFIGURED,
    'Google Calendar is not available in this build.',
    'No Google OAuth client was configured when the app was packaged.'
  )
}

/* -------------------------------------------------------------------------- */
/*                                 Consent flow                               */
/* -------------------------------------------------------------------------- */

interface ConsentResult {
  email: string
  refreshToken: string
  accessToken: string
}

/**
 * The full PKCE authorisation-code flow against a loopback listener.
 *
 * The listener is started first so the port can go into the redirect URI, and
 * it is torn down on every path out of here — a consent screen the user simply
 * abandons must not leave a socket open for the rest of the session.
 */
async function runConsentFlow(reconnecting?: string): Promise<ConsentResult> {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  const state = base64Url(randomBytes(16))

  const { server, port } = await startLoopbackServer()
  const redirectUri = `http://${GOOGLE_REDIRECT_HOST}:${port}${GOOGLE_REDIRECT_PATH}`

  try {
    const authUrl = new URL(GOOGLE_AUTH_ENDPOINT)
    authUrl.search = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      // Without offline access Google issues no refresh token, and the
      // integration would stop working an hour after it was set up.
      access_type: 'offline',
      /*
       * `select_account` is what makes connecting a *second* address possible:
       * without it Google silently reuses whoever is already signed in, and the
       * user ends up connecting the same account three times. `consent` forces
       * a refresh token to be issued even for an account seen before.
       *
       * Renewing an account that already exists is the opposite case — which
       * address is wanted is not in question, so the chooser is skipped and
       * Google is pointed straight at it.
       */
      ...(reconnecting
        ? { prompt: 'consent', login_hint: reconnecting }
        : { prompt: 'select_account consent' })
    }).toString()

    await shell.openExternal(authUrl.toString())
    logger.info(SCOPE, 'Waiting for Google consent', { port })

    const code = await waitForCode(server, state)
    return await exchangeCode(code, verifier, redirectUri)
  } finally {
    server.close()
  }
}

function startLoopbackServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()

    server.once('error', reject)

    // Port 0 asks the OS for a free one. A fixed port would collide with
    // whatever else the machine happens to be running.
    server.listen(0, GOOGLE_REDIRECT_HOST, () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new AppError(ERROR_CODES.UNKNOWN, 'Could not open a local port for Google sign-in.'))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

/** Resolves with the authorisation code, or rejects with something explainable. */
function waitForCode(server: Server, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish()
      reject(
        new AppError(
          ERROR_CODES.AUTH_FAILED,
          'The Google sign-in timed out.',
          'The browser window was left open too long. Try connecting again.'
        )
      )
    }, GOOGLE_AUTH_TIMEOUT_MS)

    function finish(): void {
      clearTimeout(timer)
      server.removeAllListeners('request')
    }

    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', `http://${GOOGLE_REDIRECT_HOST}`)

      if (url.pathname !== GOOGLE_REDIRECT_PATH) {
        response.writeHead(404).end()
        return
      }

      /*
       * The browser has handed control back, so bring the window with it.
       *
       * Done here rather than after the token exchange because this is the
       * moment the user is finished in the browser — whether they consented or
       * refused. Leaving them staring at a "return to the app" page and making
       * them find it themselves is a step the app can simply take for them.
       *
       * The timeout path deliberately does not do this: stealing focus five
       * minutes after someone wandered off would be an ambush, not a courtesy.
       */
      showMainWindow()

      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')

      if (error) {
        respond(response, 'Sign-in cancelled', 'You can close this tab and return to the app.')
        finish()
        reject(
          new AppError(
            ERROR_CODES.AUTH_FAILED,
            error === 'access_denied'
              ? 'Access to the calendar was not granted.'
              : `Google refused the sign-in: ${error}`
          )
        )
        return
      }

      // The state check is what stops another page on this machine from
      // completing somebody else's flow at our loopback listener.
      if (!code || !state || !matches(state, expectedState)) {
        respond(response, 'Sign-in failed', 'The response did not match this request.')
        finish()
        reject(new AppError(ERROR_CODES.AUTH_FAILED, 'The Google sign-in response was rejected.'))
        return
      }

      respond(response, 'Account connected', 'You can close this tab and return to the app.')
      finish()
      resolve(code)
    })
  })
}

/** Constant-time compare, so the state cannot be guessed a character at a time. */
function matches(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string
): Promise<ConsentResult> {
  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })
  })

  if (!response.ok) {
    logger.error(SCOPE, 'Google token exchange failed', {
      status: response.status,
      body: await response.text().catch(() => '')
    })
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'Google would not complete the sign-in.',
      'Check that the OAuth client is a "Desktop app" client and try again.'
    )
  }

  const payload = (await response.json()) as {
    access_token?: string
    refresh_token?: string
    scope?: string
  }

  /*
   * Check what was actually granted, not what was asked for.
   *
   * Google hands back HTTP 200 and a perfectly valid token even when it has
   * quietly dropped a scope — an unverified sensitive scope, or a consent
   * checkbox the user left unticked. Storing that account would look like a
   * success and then fail on every sync afterwards with a message about the
   * calendar, hours away from the moment that actually caused it.
   */
  const granted = payload.scope ?? ''
  logger.info(SCOPE, 'Google granted scopes', { granted })

  if (!granted.includes('calendar.readonly')) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'Google did not grant access to the calendar.',
      'On the consent screen, tick "See and download any calendar…" before continuing.'
    )
  }

  if (!payload.refresh_token) {
    // Happens when the account was connected before and Google decided a second
    // refresh token was unnecessary. `prompt=consent` is meant to prevent it.
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'Google did not return a long-lived token.',
      'Remove this app at myaccount.google.com/permissions, then connect again.'
    )
  }

  if (!payload.access_token) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Google returned no access token.')
  }

  const email = await readAccountEmail(payload.access_token)

  return {
    email,
    refreshToken: payload.refresh_token,
    accessToken: payload.access_token
  }
}

/**
 * The address of the account that just consented.
 *
 * Read from the calendar rather than from a profile scope: a person's primary
 * calendar is identified by their own address, so the answer is already inside
 * the permission they granted. Asking for `userinfo.email` on top would add a
 * second tick box to the consent screen for something already known.
 */
async function readAccountEmail(accessToken: string): Promise<string> {
  const response = await fetch(`${GOOGLE_CALENDAR_API}/calendars/primary`, {
    headers: { authorization: `Bearer ${accessToken}` }
  })

  if (!response.ok) {
    logger.error(SCOPE, 'Could not read the primary calendar', {
      status: response.status,
      body: await response.text().catch(() => '')
    })

    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'Google would not say which calendar was connected.',
      'Try connecting the account again.'
    )
  }

  const calendar = (await response.json()) as { id?: unknown; summary?: unknown }

  // `id` is the address for a personal calendar. `summary` is the fallback for
  // the rare account whose primary calendar is named something else.
  const id = typeof calendar.id === 'string' ? calendar.id : null
  const summary = typeof calendar.summary === 'string' ? calendar.summary : null
  const email = id ?? summary

  if (!email) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Google did not name the connected calendar.')
  }

  return email
}

/* -------------------------------------------------------------------------- */

const base64Url = (buffer: Buffer): string => buffer.toString('base64url')

/** The page the user is left looking at once the browser comes back. */
function respond(
  response: import('node:http').ServerResponse,
  title: string,
  message: string
): void {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
    `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #0b1020; color: #e6e9f5; }
  div { text-align: center; padding: 2rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .35rem; }
  p { margin: 0; color: #9aa3bd; font-size: .9rem; }
</style>
<div><h1>${title}</h1><p>${message}</p></div>`
  )
}
