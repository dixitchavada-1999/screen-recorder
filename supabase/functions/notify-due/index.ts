import { createClient } from 'jsr:@supabase/supabase-js@2'

/**
 * Sends the Slack reminders that have come due.
 *
 * Nexus delivers the message, into the same thread as its own notifications,
 * and does no de-duplication whatsoever: a retry is a second message in
 * somebody's Slack. Since every running copy of the app calls this, two
 * machines can reach the same unsent reminder in the same second — so the
 * database hands out each one to exactly one caller before anything is sent.
 * See `claim_due_notifications`.
 *
 * Nothing here decides *whether* somebody should be told. That was decided when
 * the call was scheduled for them; this only notices that the time has come.
 */

const NEXUS_BASE =
  Deno.env.get('NEXUS_BASE_URL') ??
  'https://zdsuioopciesnfmhmvhi.supabase.co/functions/v1/partner-api'

const NEXUS_KEY = Deno.env.get('NEXUS_API_KEY') ?? ''

/**
 * Sent per pass.
 *
 * Nexus allows 300 messages a day and 60 requests a minute. Fifty is under the
 * per-minute ceiling with room to spare, and a backlog larger than that is a
 * sign something is wrong rather than something to push through.
 */
const BATCH = 50

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

interface Due {
  call_id: string
  nexus_id: string
  /** Which of this person's chosen warnings this is. Zero means "at the start". */
  lead_minutes: number
  title: string
  starts_at: string
  minutes_away: number
  /** The note left on the call, or null. */
  notes: string | null
  /** Everybody on the call, by name, comma-joined. Empty when nobody is named. */
  attendees: string
}

/**
 * Where the times are shown from.
 *
 * A reminder that said 8:30 when the call is at 2:00 would be worse than no
 * time at all, so the clock is pinned to the deployment's timezone rather than
 * left to the server's UTC. Change this to move the whole product's clock.
 */
const TIME_ZONE = 'Asia/Kolkata'

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
  if (!NEXUS_KEY) return json({ ok: false, error: 'not_configured' }, 500)

  const { data, error } = await admin.rpc('claim_due_notifications', { p_limit: BATCH })

  if (error) {
    console.error('Could not claim reminders', error)
    return json({ ok: false, error: 'claim_failed', detail: describe(error) }, 500)
  }

  const due = (data ?? []) as Due[]
  if (due.length === 0) return json({ ok: true, sent: 0, failed: 0 })

  let sent = 0
  const failures: Array<{ title: string; error: string }> = []

  for (const reminder of due) {
    const outcome = await notify(reminder)

    if (outcome.ok) {
      sent += 1
      continue
    }

    failures.push({ title: reminder.title, error: outcome.error })

    /*
     * A claim is only put back when trying again could work.
     *
     * Somebody with no Slack account on that workspace will not grow one
     * because we asked a second time, so that claim stays and the reason is
     * recorded against it — which is also what lets the app show the person who
     * arranged the call that it did not arrive.
     */
    await admin.rpc('release_notification', {
      p_call: reminder.call_id,
      p_nexus: reminder.nexus_id,
      p_lead: reminder.lead_minutes,
      p_error: outcome.error,
      p_retry: outcome.retry
    })
  }

  console.info('Reminders sent', { sent, failed: failures.length, failures })

  return json({ ok: true, sent, failed: failures.length, failures })
})

/* -------------------------------------------------------------------------- */

/**
 * The reminder people read.
 *
 * Nexus prints "📞 Call Reminder ·" ahead of whatever this returns, so the body
 * starts with the call itself and builds down: when it is, who is on it, the
 * note, and last the countdown — which is worded from the clock, not the
 * setting, so a thirty-minute warning that arrives four minutes late says
 * "starts in 26 minutes" rather than repeating what was asked for.
 *
 * Every middle line is dropped when it is empty, so a bare call is a bare line
 * and not a run of empty ones.
 */
function buildMessage(reminder: Due): string {
  const start = new Date(reminder.starts_at)

  const time = start.toLocaleTimeString('en-US', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit'
  })

  const lines: string[] = [
    reminder.title.slice(0, 200),
    `${dayLabel(start)} at ${time}`
  ]

  if (reminder.attendees) lines.push(`👤 ${reminder.attendees.slice(0, 300)}`)

  const note = reminder.notes?.trim()
  if (note) lines.push(`📝 ${note.length > 300 ? `${note.slice(0, 297)}…` : note}`)

  lines.push(
    '',
    reminder.minutes_away <= 1
      ? 'Starting now'
      : `Starts in ${reminder.minutes_away} minutes`
  )

  return lines.join('\n')
}

/** "Today" / "Tomorrow" / "Mon, 25 Aug", in the deployment's timezone. */
function dayLabel(start: Date): string {
  const day = (d: Date): string =>
    d.toLocaleDateString('en-CA', { timeZone: TIME_ZONE }) // YYYY-MM-DD, stable to compare

  const startDay = day(start)
  const today = day(new Date())
  const tomorrow = day(new Date(Date.now() + 86_400_000))

  if (startDay === today) return 'Today'
  if (startDay === tomorrow) return 'Tomorrow'

  return start.toLocaleDateString('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

type Outcome = { ok: true } | { ok: false; error: string; retry: boolean }

/**
 * One Slack message.
 *
 * Kept to a line. Nexus prefixes it with its own "📞 Call Reminder ·", and the
 * guide asks for plain text and one or two lines — this is a nudge, not an
 * agenda.
 */
async function notify(reminder: Due): Promise<Outcome> {
  /*
   * Worded from the clock, not from the setting.
   *
   * A thirty-minute warning that fires four minutes late should say what is
   * true — "starts in 26 minutes" — rather than repeat what was asked for.
   */
  const message = buildMessage(reminder)

  let response: Response
  try {
    response = await fetch(`${NEXUS_BASE}/notify`, {
      method: 'POST',
      headers: { 'x-api-key': NEXUS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: reminder.nexus_id, message })
    })
  } catch (error) {
    console.error('Nexus could not be reached', error)
    return { ok: false, error: 'upstream_unavailable', retry: true }
  }

  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }

  if (response.ok && payload.ok === true) return { ok: true }

  const code = typeof payload.error === 'string' ? payload.error : `http_${response.status}`

  /*
   * Which failures are worth another attempt.
   *
   * Slack refusing once, a rate limit, or their side being briefly unwell will
   * all pass. Somebody having left, not existing, or having no Slack account
   * will not — and retrying those every five minutes for the rest of the day
   * would spend the message budget on messages that cannot be delivered.
   */
  const retry =
    code === 'slack_post_failed' ||
    code === 'rate_limited' ||
    code === 'temporarily_unavailable' ||
    response.status >= 500

  return { ok: false, error: code, retry }
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
