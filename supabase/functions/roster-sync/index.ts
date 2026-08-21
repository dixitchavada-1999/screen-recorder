import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Keeps the local copy of the Nexus staff roster current.
 *
 * The partner API allows fifty roster reads in twenty-four hours and says
 * plainly what it is for: read it on a schedule, store it, and render pickers
 * from your own copy. So this is the only thing that ever calls `/users`, and
 * it refuses to do so more than once a day.
 *
 * Deliberately not a cron job. The app calls this on launch; the check below is
 * what turns "every machine, every morning" into "once, by whichever machine
 * asked first". That keeps the whole arrangement inside the app rather than
 * depending on a scheduler somebody has to remember exists.
 *
 * It is also where somebody leaving becomes a fact rather than a note. A person
 * who stops appearing in the roster has their tracking switched off and their
 * account banned, which ends a session that would otherwise keep working for
 * weeks — sign-in was closed to them the moment Nexus started answering `403`,
 * but a token issued last Tuesday does not ask Nexus anything.
 */

const NEXUS_BASE =
  Deno.env.get('NEXUS_BASE_URL') ??
  'https://zdsuioopciesnfmhmvhi.supabase.co/functions/v1/partner-api'

const NEXUS_KEY = Deno.env.get('NEXUS_API_KEY') ?? ''

/** How stale the cache has to be before Nexus is asked again. */
const MAX_AGE_HOURS = 24

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
  if (!NEXUS_KEY) return json({ ok: false, error: 'not_configured' }, 500)

  const force = new URL(request.url).searchParams.get('force') === '1'

  /* ------------------------- 1. Is a refresh due? ------------------------- */

  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600_000).toISOString()

  /*
   * Claimed by writing the timestamp first, and only if it was already stale.
   *
   * Several machines starting at nine o'clock would otherwise each see a stale
   * cache and each spend one of the day's fifty reads. Whoever's update returns
   * a row has the job; everybody else is told the cache is fresh, which by then
   * it is about to be.
   */
  let claim = admin
    .from('nexus_roster_state')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('id', true)

  if (!force) claim = claim.or(`last_synced_at.is.null,last_synced_at.lt.${cutoff}`)

  const { data: claimed, error: claimError } = await claim.select('last_synced_at')

  if (claimError) {
    console.error('Could not read the roster state', claimError)
    return json({ ok: false, error: 'state_unavailable', detail: describe(claimError) }, 500)
  }

  if (!claimed || claimed.length === 0) {
    const { data: current } = await admin
      .from('nexus_roster_state')
      .select('last_synced_at, last_count')
      .eq('id', true)
      .maybeSingle()

    return json({
      ok: true,
      skipped: 'fresh',
      last_synced_at: current?.last_synced_at ?? null,
      count: current?.last_count ?? null
    })
  }

  /* ---------------------------- 2. Ask Nexus ------------------------------ */

  let users: Array<{ id?: string; name?: string }>
  try {
    const response = await fetch(`${NEXUS_BASE}/users`, {
      method: 'POST',
      headers: { 'x-api-key': NEXUS_KEY, 'Content-Type': 'application/json' },
      body: '{}'
    })

    const payload = await response.json().catch(() => ({}))

    if (!response.ok || payload.ok !== true) {
      // The claim already moved the timestamp forward, so a failure here means
      // the next attempt waits a day. Put it back, and say why in the row.
      await release(typeof payload.error === 'string' ? payload.error : `http_${response.status}`)
      return json(
        { ok: false, error: typeof payload.error === 'string' ? payload.error : 'upstream_failed' },
        response.status
      )
    }

    users = Array.isArray(payload.users) ? payload.users : []
  } catch (error) {
    console.error('Nexus could not be reached', error)
    await release('unreachable')
    return json({ ok: false, error: 'upstream_unavailable' }, 503)
  }

  /* --------------------------- 3. Apply it -------------------------------- */

  const { data: applied, error: applyError } = await admin.rpc('sync_nexus_roster', {
    p_users: users
  })

  if (applyError) {
    console.error('Could not apply the roster', applyError)
    await release(describe(applyError))
    return json({ ok: false, error: 'apply_failed', detail: describe(applyError) }, 500)
  }

  const result = applied as {
    seen: number
    departed: Moved[]
    returned: Moved[]
    /** Sessions actually ended. The ban alone never did this — see migration 17. */
    revoked: number
  }

  /* ------------------- 4. Act on who has come and gone -------------------- */

  const banned = await setAccess(result.departed, 'block')
  const unbanned = await setAccess(result.returned, 'restore')

  await admin
    .from('nexus_roster_state')
    .update({
      last_count: result.seen,
      last_departed: result.departed.length,
      last_returned: result.returned.length,
      last_revoked: result.revoked,
      last_error: null
    })
    .eq('id', true)

  if (result.departed.length > 0) {
    console.info('People who have left', {
      names: result.departed.map((person) => person.name),
      // Two different things: sessions ended already, in the same transaction
      // as the roster; the ban is what stops a new sign-in afterwards.
      sessionsEnded: result.revoked,
      accountsBanned: banned
    })
  }

  if (result.returned.length > 0) {
    console.info('People who are back', {
      names: result.returned.map((person) => person.name),
      accessRestored: unbanned
    })
  }

  console.info('Roster synced', { count: result.seen })

  return json({
    ok: true,
    synced: true,
    count: result.seen,
    departed: result.departed.length,
    returned: result.returned.length,
    revoked: result.revoked
  })
})

interface Moved {
  nexus_id: string
  /** Null for somebody who has never signed into this app — nothing to end. */
  user_id: string | null
  name: string
}

/**
 * Ends or restores somebody's access to this app.
 *
 * Banning rather than deleting: the account is the anchor for their recorded
 * days, their calls and everything filed under them, and a leaver's history is
 * exactly the part worth keeping.
 *
 * A ban does **not** end a session that is already running — tested, and it
 * does not: a banned account's refresh token still returns a fresh hour of
 * access. Ending the session is done in SQL, inside the same transaction as the
 * roster itself. What the ban adds is the other half: it stops a new sign-in
 * from starting, which matters if this app ever learns another way in.
 *
 * Restoring on return undoes only the ban. Tracking stays off: whether somebody
 * is watched is an administrator's decision, and it should not come back as a
 * side effect of a rehire.
 *
 * Failures are counted and logged, never thrown. One account that cannot be
 * banned must not stop the other nine from being.
 */
async function setAccess(people: Moved[], action: 'block' | 'restore'): Promise<number> {
  let changed = 0

  for (const person of people) {
    if (!person.user_id) continue

    // A hundred years, which is how this API spells "until somebody says
    // otherwise" — it has no unbounded form.
    const { error } = await admin.auth.admin.updateUserById(person.user_id, {
      ban_duration: action === 'block' ? '876000h' : 'none'
    })

    if (error) {
      console.error(`Could not ${action} an account`, { name: person.name, error: describe(error) })
      continue
    }

    changed += 1
  }

  return changed
}

/**
 * Undoes the claim so the next caller tries again rather than waiting a day for
 * a refresh that never happened.
 */
async function release(reason: string): Promise<void> {
  await admin
    .from('nexus_roster_state')
    .update({ last_synced_at: null, last_error: reason })
    .eq('id', true)
}

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const shaped = error as { message?: unknown; code?: unknown; details?: unknown }
    return [shaped.code, shaped.message, shaped.details]
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
