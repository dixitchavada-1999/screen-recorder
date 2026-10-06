import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Links the signed-in person to a Google calendar, once Google has vouched for it.
 *
 * A link is what puts somebody on every meeting imported from that calendar,
 * so it cannot be something the app just asserts: anybody could type in their
 * manager's address. Instead the app sends the access token it was just given,
 * and this asks Google two things — was the token issued to *this* app, and
 * whose calendar does it open? Only the answer to the second is ever written.
 *
 * The token is used for those two requests and then forgotten. Nothing about
 * it is stored here or anywhere else on the server.
 */

/** The desktop OAuth client. Public by nature — it ships inside every copy of the app. */
const GOOGLE_CLIENT_ID =
  Deno.env.get('GOOGLE_CLIENT_ID') ??
  '813532163887-1vu78f2f33dqga8cbplrc7aikb33ra2p.apps.googleusercontent.com'

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)

  /* ----------------------------- 1. Who is asking ----------------------------- */

  const jwt = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: auth, error: authError } = await admin.auth.getUser(jwt)

  if (authError || !auth?.user) return json({ ok: false, error: 'not_signed_in' }, 401)

  const body = (await request.json().catch(() => ({}))) as { google_token?: unknown }
  const token = typeof body.google_token === 'string' ? body.google_token : ''
  if (!token) return json({ ok: false, error: 'missing_token' }, 400)

  /* ---------------------- 2. Was the token issued to us ---------------------- */

  /*
   * A token issued to some other app would still open the calendar, but it
   * would mean the app had not really run the consent flow — refused, so the
   * only way to a link is the one the person saw and agreed to.
   */
  const info = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`
  )
  const tokenInfo = (await info.json().catch(() => ({}))) as { aud?: string; scope?: string }

  if (!info.ok || tokenInfo.aud !== GOOGLE_CLIENT_ID) {
    return json({ ok: false, error: 'token_rejected' }, 403)
  }

  if (!(tokenInfo.scope ?? '').split(' ').includes(CALENDAR_SCOPE)) {
    return json({ ok: false, error: 'missing_calendar_scope' }, 403)
  }

  /* ------------------------ 3. Whose calendar it opens ----------------------- */

  // The primary calendar's id is the account's address — the same way the app
  // learns it, and it needs no permission beyond the calendar one.
  const calendar = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary', {
    headers: { authorization: `Bearer ${token}` }
  })
  const primary = (await calendar.json().catch(() => ({}))) as { id?: string }

  if (!calendar.ok || !primary.id || !primary.id.includes('@')) {
    return json({ ok: false, error: 'calendar_unreadable' }, 403)
  }

  const email = primary.id.trim().toLowerCase()

  /* --------------------------------- 4. Link --------------------------------- */

  const { error: linkError } = await admin.rpc('link_google_account', {
    p_user: auth.user.id,
    p_email: email
  })

  if (linkError) {
    console.error('Could not link a Google account', linkError)
    return json({ ok: false, error: 'link_failed' }, 500)
  }

  console.info('Google account linked', { user: auth.user.id, email })
  return json({ ok: true, email })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
