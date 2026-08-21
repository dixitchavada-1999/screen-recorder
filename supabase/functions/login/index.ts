import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Signing in.
 *
 * Nexus answers one question — is this password right? — and hands back an id
 * and a name. Everything after that is this project's: the account row, the
 * device, the role, the session. Nothing about a person's authorisation here is
 * read from there, because the two systems' administrators are different people
 * with different jobs.
 *
 * The Nexus API key exists only inside this function. It is set with
 *
 *   supabase secrets set NEXUS_API_KEY=...
 *
 * and must never reach the desktop app: anyone holding it can attempt logins
 * against Nexus staff, read the entire staff roster and send Slack messages to
 * their team. An Electron bundle is not a place a secret can be kept.
 */

/* -------------------------------------------------------------------------- */
/*                                   Config                                   */
/* -------------------------------------------------------------------------- */

const NEXUS_BASE =
  Deno.env.get('NEXUS_BASE_URL') ??
  'https://zdsuioopciesnfmhmvhi.supabase.co/functions/v1/partner-api'

const NEXUS_KEY = Deno.env.get('NEXUS_API_KEY') ?? ''

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

/**
 * Bypasses row level security. Used for exactly three things: finding or
 * creating the account, registering the device, and writing the sign-in log.
 */
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

/**
 * A separate, unprivileged client for the one call that must not run as the
 * service role. `verifyOtp` sets the session on whichever client makes it —
 * doing that on `admin` would swap its credentials mid-request.
 */
const anon = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
})

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

interface DeviceInput {
  machineId?: string
  hostname?: string
  platform?: string
  appVersion?: string
}

interface LoginBody {
  email?: string
  password?: string
  device?: DeviceInput
}

/* -------------------------------------------------------------------------- */
/*                                  Handler                                   */
/* -------------------------------------------------------------------------- */

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405)
  }

  if (!NEXUS_KEY) {
    console.error('NEXUS_API_KEY is not set')
    return json({ ok: false, error: 'not_configured' }, 500)
  }

  let body: LoginBody
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_body' }, 400)
  }

  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!email || !password) return json({ ok: false, error: 'invalid_body' }, 400)

  /* ----------------------------- 1. Ask Nexus ----------------------------- */

  const verified = await verifyWithNexus(email, password)
  if (!verified.ok) return json({ ok: false, ...verified.body }, verified.status)

  const nexusUserId = verified.userId
  const nexusName = verified.name

  /* -------------------- 2. Find or create the account --------------------- */

  let profile: ProfileRow
  try {
    profile = await resolveProfile(nexusUserId, nexusName, email)
  } catch (error) {
    console.error('Could not provision the account', error)
    return json({ ok: false, error: 'provisioning_failed', detail: describe(error) }, 500)
  }

  /* ------------------- 3. Put their own house in order -------------------- */

  /*
   * Records them in the roster and adopts any calls of theirs that predate
   * assignment. Both are one-time repairs that only this moment can make: it is
   * the first point at which Nexus has confirmed, for this person, who they are.
   *
   * Not fatal. A failure here costs an empty week until the next sign-in, which
   * is worth a log line and not worth refusing to let somebody in over.
   */
  const { data: repaired, error: linkError } = await admin.rpc('link_person', {
    p_user: profile.id,
    p_nexus: nexusUserId,
    p_name: nexusName
  })

  if (linkError) console.error('Could not link the person', describe(linkError))
  else if ((repaired as number) > 0) {
    console.info('Adopted calls that had nobody on them', { count: repaired })
  }

  /* --------------------------- 4. The machine ----------------------------- */

  // A failure here must not block the sign-in. Losing the device row costs one
  // row of provenance; refusing the login costs somebody their working day.
  const deviceId = await registerDevice(profile.id, body.device).catch((error) => {
    console.error('Device registration failed', error)
    return null
  })

  /* ---------------------------- 5. The session ---------------------------- */

  let session: { access_token: string; refresh_token: string; expires_at?: number }
  try {
    session = await issueSession(profile.auth_email)
  } catch (error) {
    console.error('Could not issue a session', error)
    return json({ ok: false, error: 'session_failed', detail: describe(error) }, 500)
  }

  /* ------------------------------ 6. The log ------------------------------ */

  await admin
    .from('login_events')
    .insert({
      user_id: profile.id,
      device_id: deviceId,
      ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
      app_version: body.device?.appVersion ?? null
    })
    .then(({ error }) => {
      if (error) console.error('Could not record the sign-in', error)
    })

  return json({
    ok: true,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at ?? null,
    user: {
      id: profile.id,
      email: profile.email,
      name: profile.full_name ?? nexusName,
      role: profile.role,
      nexus_user_id: nexusUserId
    },
    device_id: deviceId
  })
})

/* -------------------------------------------------------------------------- */
/*                                   Nexus                                    */
/* -------------------------------------------------------------------------- */

type Verified =
  | { ok: true; userId: string; name: string }
  | { ok: false; status: number; body: Record<string, unknown> }

/**
 * The credential check.
 *
 * Every failure Nexus reports is passed through with its own status and code,
 * because each one means something different to the person at the keyboard: a
 * wrong password, an account that no longer works here, or a wait. Collapsing
 * them into one "login failed" would leave somebody retrying a password that
 * was never the problem.
 *
 * The password goes no further than this call. It is not logged, not stored and
 * not kept in any row.
 */
async function verifyWithNexus(email: string, password: string): Promise<Verified> {
  let response: Response
  try {
    response = await fetch(`${NEXUS_BASE}/verify-user`, {
      method: 'POST',
      headers: { 'x-api-key': NEXUS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
  } catch (error) {
    console.error('Nexus could not be reached', error)
    return { ok: false, status: 503, body: { error: 'upstream_unavailable' } }
  }

  let payload: Record<string, unknown>
  try {
    payload = await response.json()
  } catch {
    payload = {}
  }

  if (!response.ok || payload.ok !== true) {
    return {
      ok: false,
      status: response.status,
      body: {
        error: typeof payload.error === 'string' ? payload.error : 'invalid_credentials',
        // Present on 429. The form needs it to say how long the wait is.
        ...(payload.retry_after !== undefined ? { retry_after: payload.retry_after } : {})
      }
    }
  }

  const user = payload.user as { id?: string; name?: string } | undefined
  if (!user?.id) {
    console.error('Nexus returned no user id')
    return { ok: false, status: 502, body: { error: 'upstream_invalid' } }
  }

  return { ok: true, userId: user.id, name: user.name ?? '' }
}

/* -------------------------------------------------------------------------- */
/*                                  Accounts                                  */
/* -------------------------------------------------------------------------- */

interface ProfileRow {
  id: string
  email: string
  full_name: string | null
  role: string
  /** The address on the `auth.users` row, which is not the person's own. */
  auth_email: string
}

/**
 * The address the Supabase account carries.
 *
 * Deliberately not the person's real one. Supabase will send a password reset
 * to any address that has an account, and anyone can ask it to — so a shadow
 * account holding a real inbox would be a way to get a session for somebody
 * without ever passing Nexus. `.invalid` is reserved by the RFCs and can never
 * resolve, so that path leads nowhere.
 *
 * The real address lives in `profiles.email`, which is what the app displays.
 */
function shadowEmail(nexusUserId: string): string {
  return `${nexusUserId}@nexus.invalid`
}

/**
 * The address the Supabase account actually carries, moved to the shadow one
 * where the instance will allow it.
 *
 * Checked rather than assumed, on every path: an account can arrive here already
 * linked to a Nexus id without having passed through this function — the
 * migration backfilled the first one directly in SQL — and that account still
 * holds its original address.
 *
 * The move is hardening, not correctness. Some instances refuse an address at a
 * domain that cannot exist, and refusing to sign somebody in over a defence in
 * depth would be the wrong trade: the reason is logged, the real address is
 * used, and the account still cannot be reached without a Nexus password. What
 * is returned is whatever the account really has, because that is what the link
 * below has to be minted for.
 *
 * Idempotent: after a successful move this is one lookup and no write.
 */
async function ensureShadowEmail(userId: string, nexusUserId: string): Promise<string> {
  const wanted = shadowEmail(nexusUserId)

  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error || !data.user) {
    throw error ?? new Error(`no auth account behind profile ${userId}`)
  }

  const account = data.user as { email?: string; banned_until?: string | null }

  /*
   * Rehired.
   *
   * Roster sync bans people who stop appearing in Nexus's staff list — that is
   * what stops a departed colleague's session running for another fortnight.
   * Nexus has just answered for this person, so a ban still in place means they
   * are back, and waiting up to a day for the next roster pull to notice would
   * lock them out of their first morning.
   */
  if (account.banned_until) {
    const { error: unbanError } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: 'none'
    })

    if (unbanError) {
      console.error('Could not lift a ban', { userId, reason: describe(unbanError) })
    } else {
      console.info('Lifted a ban — Nexus says this person works here again', { userId })
    }
  }

  const current = account.email ?? ''
  if (current.toLowerCase() === wanted.toLowerCase()) return wanted

  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    email: wanted,
    email_confirm: true
  })

  if (!updateError) {
    console.info('Moved an account to its shadow address', { userId })
    return wanted
  }

  console.warn('Could not move the account to its shadow address', {
    userId,
    reason: describe(updateError)
  })

  if (!current) throw new Error(`account ${userId} has no usable address`)
  return current
}

/**
 * Finds this person's account, creating it the first time they sign in.
 *
 * Three cases, in order:
 *
 *  1. Known Nexus id — the ordinary case.
 *  2. No Nexus id, but a profile with this email and none linked yet. That is
 *     an account from before Nexus: it is adopted rather than duplicated, which
 *     is what keeps its role, its calls and its recorded days attached to the
 *     person they belong to.
 *  3. Nobody — a new account.
 */
async function resolveProfile(
  nexusUserId: string,
  nexusName: string,
  realEmail: string
): Promise<ProfileRow> {
  const columns = 'id, email, full_name, role'

  const { data: linked, error: linkedError } = await admin
    .from('profiles')
    .select(columns)
    .eq('nexus_user_id', nexusUserId)
    .maybeSingle()

  if (linkedError) throw linkedError

  if (linked) {
    const row = linked as Omit<ProfileRow, 'auth_email'>
    const authEmail = await ensureShadowEmail(row.id, nexusUserId)
    return await refresh(row, authEmail, nexusUserId, nexusName, realEmail)
  }

  /* ---------------------- 2. An account from before ----------------------- */

  const { data: legacy, error: legacyError } = await admin
    .from('profiles')
    .select(columns)
    .ilike('email', realEmail)
    .is('nexus_user_id', null)
    .maybeSingle()

  if (legacyError) throw legacyError

  if (legacy) {
    const row = legacy as Omit<ProfileRow, 'auth_email'>

    // Its Supabase account still carries the person's real address, which is
    // the reset-email hole described above. This closes it for accounts that
    // predate Nexus too, where the instance allows it.
    const authEmail = await ensureShadowEmail(row.id, nexusUserId)

    return await refresh(row, authEmail, nexusUserId, nexusName, realEmail)
  }

  /* --------------------------- 3. A new account --------------------------- */

  /*
   * The shadow address first, the real one as a fallback.
   *
   * Same trade as the move above: an instance that refuses an address at a
   * domain which cannot exist should cost this account a defence in depth, not
   * cost the person their sign-in.
   */
  const account = {
    // Nexus has already proved who this is; there is nothing left to confirm.
    email_confirm: true,
    // Never used. Sign-in goes through Nexus.
    password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    user_metadata: { full_name: nexusName, nexus_user_id: nexusUserId }
  }

  let authEmail = shadowEmail(nexusUserId)
  let { data: created, error: createError } = await admin.auth.admin.createUser({
    ...account,
    email: authEmail
  })

  if (createError) {
    console.warn('Could not create the account at its shadow address', {
      reason: describe(createError)
    })

    authEmail = realEmail
    ;({ data: created, error: createError } = await admin.auth.admin.createUser({
      ...account,
      email: authEmail
    }))
  }

  if (createError || !created.user) throw createError ?? new Error('no user created')

  /*
   * The profile row is written here rather than by a trigger. The trigger that
   * used to do it hung off `auth.users`, which nothing signs up to any more.
   *
   * `role`, `tracking_enabled` and `screenshots_enabled` are left to their
   * column defaults — 'user', false, false. Nobody arrives with a role.
   */
  const { data: inserted, error: insertError } = await admin
    .from('profiles')
    .insert({
      id: created.user.id,
      email: realEmail,
      full_name: nexusName || null,
      nexus_user_id: nexusUserId
    })
    .select(columns)
    .single()

  if (insertError) throw insertError

  return { ...(inserted as Omit<ProfileRow, 'auth_email'>), auth_email: authEmail }
}

/**
 * Brings the stored name and address back in step with Nexus.
 *
 * Nexus is the authority on both — a rename there should show here at the next
 * sign-in without anybody retyping it. `role` and the tracking switches are
 * pointedly absent: those are this system's, and nothing upstream may move
 * them.
 */
async function refresh(
  row: Omit<ProfileRow, 'auth_email'>,
  authEmail: string,
  nexusUserId: string,
  nexusName: string,
  realEmail: string
): Promise<ProfileRow> {
  const patch: Record<string, unknown> = { nexus_user_id: nexusUserId, email: realEmail }
  if (nexusName) patch.full_name = nexusName

  const { data, error } = await admin
    .from('profiles')
    .update(patch)
    .eq('id', row.id)
    .select('id, email, full_name, role')
    .single()

  if (error) throw error

  return { ...(data as Omit<ProfileRow, 'auth_email'>), auth_email: authEmail }
}

/* -------------------------------------------------------------------------- */
/*                                  Devices                                   */
/* -------------------------------------------------------------------------- */

/**
 * Records the machine this sign-in came from.
 *
 * `machine_id` is generated once by the app and kept in its own data directory.
 * The same installation signing in again updates its row rather than adding
 * another, so a person with a desk machine and a laptop has two rows for as
 * long as they have two machines.
 */
async function registerDevice(userId: string, device?: DeviceInput): Promise<string | null> {
  const machineId = typeof device?.machineId === 'string' ? device.machineId.trim() : ''
  if (!machineId) return null

  const { data, error } = await admin
    .from('devices')
    .upsert(
      {
        user_id: userId,
        machine_id: machineId,
        hostname: device?.hostname ?? null,
        platform: device?.platform ?? null,
        app_version: device?.appVersion ?? null,
        last_seen_at: new Date().toISOString()
      },
      { onConflict: 'user_id,machine_id' }
    )
    .select('id')
    .single()

  if (error) throw error
  return (data as { id: string }).id
}

/* -------------------------------------------------------------------------- */
/*                                  Sessions                                  */
/* -------------------------------------------------------------------------- */

/**
 * A real Supabase session, without a password.
 *
 * `generateLink` mints a one-time token for the account and hands it back
 * instead of emailing it — which is the whole point, since the address it would
 * be emailed to does not exist. Redeeming it immediately turns it into an
 * access and refresh token pair, signed by the project's own key.
 *
 * Doing it this way is what keeps every hard part of a session — expiry,
 * rotation, refresh, revocation — Supabase's problem rather than ours.
 */
async function issueSession(
  authEmail: string
): Promise<{ access_token: string; refresh_token: string; expires_at?: number }> {
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: authEmail
  })

  if (linkError || !link.properties?.hashed_token) {
    throw linkError ?? new Error('no link token')
  }

  const { data, error } = await anon.auth.verifyOtp({
    token_hash: link.properties.hashed_token,
    type: 'magiclink'
  })

  if (error || !data.session) throw error ?? new Error('no session')

  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    ...(data.session.expires_at !== undefined ? { expires_at: data.session.expires_at } : {})
  }
}

/* -------------------------------------------------------------------------- */

/**
 * No CORS headers, on purpose — the same stance Nexus takes.
 *
 * This is called by the desktop app's main process, which is not a browser and
 * is not subject to them. A page that could call it would be a page that could
 * try passwords against Nexus staff.
 */
/**
 * A one-line reason for a failure on our own side, returned with the 500.
 *
 * Only ever our own errors — Postgres and GoTrue messages, which name a
 * constraint or a permission and are what makes one of these diagnosable
 * without hunting through logs. Nothing from the credential path passes through
 * here, so nothing about a password or the Nexus key can reach it.
 */
function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const shaped = error as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown }
    return [shaped.code, shaped.message, shaped.details, shaped.hint]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(' · ')
  }

  return String(error)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
