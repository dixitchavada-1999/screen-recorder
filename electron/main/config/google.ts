/**
 * Google OAuth client and endpoints for the Calendar integration.
 *
 * These come from a "Desktop app" OAuth client in Google Cloud. Google itself
 * documents that a desktop client secret is not confidential — it ships inside
 * every copy of the app and cannot be protected. What actually secures the flow
 * is PKCE plus the loopback redirect: an authorisation code is useless without
 * the verifier this process generated and never sent anywhere.
 *
 * Read-only by design. The scope below cannot create, change or delete anything
 * in anyone's calendar; the app imports events and never writes back.
 *
 * As with `supabase.ts`, the environment variables are a developer convenience
 * only. A packaged build inherits no shell environment, so whatever ships has
 * to be the literal default — paste the client into the fallbacks below.
 */

export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ??
  '813532163887-1vu78f2f33dqga8cbplrc7aikb33ra2p.apps.googleusercontent.com'

export const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET ?? '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'

/**
 * One scope, deliberately.
 *
 * Asking for the address as well used to seem harmless, and it was the reason
 * connecting kept half-succeeding: Google puts a sensitive scope behind its own
 * tick box, so a user who presses Continue without noticing grants the harmless
 * one and not the one the feature needs — a valid token that can read nothing.
 *
 * With calendar access as the only thing requested there is no such half state.
 * The account's address comes from the primary calendar's id instead, which is
 * the same string and costs no extra permission.
 */
export const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly'

export function isGoogleConfigured(): boolean {
  return GOOGLE_CLIENT_ID.length > 0 && GOOGLE_CLIENT_SECRET.length > 0
}

/* -------------------------------------------------------------------------- */
/*                                  Endpoints                                 */
/* -------------------------------------------------------------------------- */

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
/** Revokes a refresh token, so disconnecting inside the app really disconnects. */
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3'

/**
 * The loopback address the browser is sent back to.
 *
 * Google requires a desktop client to use `http://127.0.0.1` with a port chosen
 * at request time — a fixed port would collide with whatever else is listening,
 * and `localhost` is explicitly discouraged because it can resolve to IPv6 on
 * some machines while the listener is bound to IPv4.
 */
export const GOOGLE_REDIRECT_HOST = '127.0.0.1'
/** Path the temporary server answers on; anything else gets a 404. */
export const GOOGLE_REDIRECT_PATH = '/oauth/google'

/**
 * How long the browser has to complete the consent screen before the temporary
 * listener gives up. Long enough to pick an account and type a password, short
 * enough that an abandoned attempt does not leave a port open all session.
 */
export const GOOGLE_AUTH_TIMEOUT_MS = 5 * 60 * 1000

/* -------------------------------------------------------------------------- */
/*                              Connected accounts                            */
/* -------------------------------------------------------------------------- */

/**
 * Colours handed out to connected accounts, in order.
 *
 * Several accounts can be connected at once, and their calls all land in the
 * same calendar — the colour is what tells them apart at a glance.
 */
export const ACCOUNT_COLORS = [
  '#38bdf8',
  '#f472b6',
  '#34d399',
  '#fbbf24',
  '#a78bfa',
  '#fb923c'
] as const

/** Cycles rather than running out, so a seventh account still gets a colour. */
export function accountColor(index: number): string {
  return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length] as string
}
