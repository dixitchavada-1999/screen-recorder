import type { PostgrestError } from '@supabase/supabase-js'
import type {
  CallAssignee,
  CallScope,
  RosterPerson,
  ScheduledCall,
  ScheduledCallInput,
  ScheduledCallRange,
  ScheduledCallStatus
} from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { currentNexusId, currentUser, getSupabase } from './auth'

const SCOPE = 'calls'

/** Postgres unique-violation. Expected when two syncs race, not an error here. */
const DUPLICATE_KEY = '23505'

/**
 * Columns the app reads, with the people a call is for embedded alongside.
 *
 * Listed explicitly so a schema change is visible here rather than silently
 * absent from every screen.
 */
const COLUMNS =
  'id, user_id, title, starts_at, duration_minutes, notes, status, created_at, ' +
  'google_event_id, google_account_email, ' +
  'scheduled_call_assignees ( nexus_id, is_primary, nexus_users ( name ) )'

/**
 * The Call Manager's data access.
 *
 * Row level security decides which calls come back — the ones this person is
 * on, plus the ones they arranged for other people. Which of those two a screen
 * wants is a separate question, and the `scope` argument below is where it is
 * answered; the database is not asked to guess.
 */

/** A row as Postgres returns it, before conversion to the app's shape. */
interface CallRow {
  id: string
  user_id: string
  title: string
  starts_at: string
  duration_minutes: number
  notes: string | null
  status: string
  created_at: string
  google_event_id: string | null
  google_account_email: string | null
  scheduled_call_assignees:
    | Array<{ nexus_id: string; is_primary: boolean; nexus_users: { name: string } | null }>
    | null
}

/**
 * The calls this person needs to see.
 *
 * `assigned` is their schedule — what they have to be at. `scheduled-by-me` is
 * the other question: what they have arranged for other people, which is the
 * only way to get back to a call they set up and now need to move. `all` is
 * everybody's, for the roles that run the calls.
 *
 * All three come from one read. Row level security has already narrowed the
 * rows to what this person may see — their own two sets, or every call if they
 * are an admin — and telling them apart is a matter of looking at who is on the
 * call rather than a second round trip.
 *
 * `all` is refused rather than trusted: an ordinary user who asks for it gets
 * their own schedule. The policies would not have handed over anybody else's
 * rows anyway, but the scope a screen sends is not the place to decide that.
 */
export async function listCalls(
  range?: ScheduledCallRange,
  scope: CallScope = 'assigned'
): Promise<ScheduledCall[]> {
  requireUser()

  const effective: CallScope = scope === 'all' && !canManageCalls() ? 'assigned' : scope

  let query = getSupabase().from('scheduled_calls').select(COLUMNS).order('starts_at')

  if (range) {
    // Half-open: a call at exactly `to` belongs to the next window, so a month
    // boundary cannot show the same call twice.
    query = query.gte('starts_at', range.from).lt('starts_at', range.to)
  }

  const { data, error } = await query
  if (error) throw translate(error, 'load your calls')

  const calls = (data as unknown as CallRow[]).map(toScheduledCall)

  if (effective === 'all') return calls

  return effective === 'assigned'
    ? calls.filter((call) => call.assignedToMe)
    : calls.filter((call) => call.scheduledByMe)
}

/**
 * Whether the signed-in person runs the calls.
 *
 * The same two roles the `is_call_manager` policy names. Kept in step with it
 * by hand: this decides what to ask for, the database decides what to hand
 * back, and the second is the one that has to be right.
 */
function canManageCalls(): boolean {
  const role = currentUser()?.role
  return role === 'admin' || role === 'super_admin'
}

export async function createCall(input: ScheduledCallInput): Promise<ScheduledCall> {
  const user = requireUser()
  const fields = validate(input)
  const assignees = resolveAssignees(input.assigneeNexusIds)

  const { data, error } = await getSupabase()
    .from('scheduled_calls')
    .insert({ ...fields, user_id: user.id })
    .select('id')
    .single()

  if (error) throw translate(error, 'save the call')

  const id = (data as unknown as { id: string }).id

  /*
   * The call and the people on it have to arrive together.
   *
   * A call with nobody on it is in nobody's schedule — it exists, reminds
   * nobody, and shows up only under "Scheduled by me". Rather than leave that
   * behind, the call is removed and the failure reported.
   */
  try {
    await writeAssignees(id, assignees)
  } catch (assigneeError) {
    await getSupabase().from('scheduled_calls').delete().eq('id', id)
    throw assigneeError
  }

  logger.info(SCOPE, 'Call scheduled', { startsAt: fields.starts_at, people: assignees.length })
  return await readCall(id)
}

export async function updateCall(
  id: string,
  input: ScheduledCallInput
): Promise<ScheduledCall> {
  requireUser()
  const fields = validate(input)

  const { error } = await getSupabase().from('scheduled_calls').update(fields).eq('id', id)
  if (error) throw translate(error, 'update the call')

  // Left alone when the caller did not say. Only a form that offers the picker
  // has an opinion about who is on the call; one that does not must not be read
  // as "remove everybody".
  if (input.assigneeNexusIds !== undefined) {
    await writeAssignees(id, resolveAssignees(input.assigneeNexusIds), { replace: true })
  }

  logger.info(SCOPE, 'Call updated', { id })
  return await readCall(id)
}

/* -------------------------------------------------------------------------- */
/*                                  Assignees                                 */
/* -------------------------------------------------------------------------- */

/**
 * Who a call is for, defaulting to whoever is arranging it.
 *
 * An empty list is the ordinary case — a call somebody schedules for themselves,
 * and every event imported from a Google calendar. The first id is the primary.
 */
function resolveAssignees(nexusIds: string[] | undefined): string[] {
  const chosen = (nexusIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  if (chosen.length > 0) return [...new Set(chosen)]

  const mine = currentNexusId()
  if (!mine) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'This account is not linked to Nexus yet.',
      'Sign out and sign in again; the link is made at sign-in.'
    )
  }

  return [mine]
}

async function writeAssignees(
  callId: string,
  nexusIds: string[],
  options: { replace?: boolean } = {}
): Promise<void> {
  if (options.replace) {
    const { error } = await getSupabase()
      .from('scheduled_call_assignees')
      .delete()
      .eq('call_id', callId)

    if (error) throw translate(error, 'update who the call is for')
  }

  const { error } = await getSupabase()
    .from('scheduled_call_assignees')
    .insert(
      nexusIds.map((nexusId, index) => ({
        call_id: callId,
        nexus_id: nexusId,
        is_primary: index === 0
      }))
    )

  if (error) throw translate(error, 'record who the call is for')
}

/** Re-reads one call with everything embedded, after a write that changed it. */
async function readCall(id: string): Promise<ScheduledCall> {
  const { data, error } = await getSupabase()
    .from('scheduled_calls')
    .select(COLUMNS)
    .eq('id', id)
    .single()

  if (error) throw translate(error, 'read the call back')
  return toScheduledCall(data as unknown as CallRow)
}

/* -------------------------------------------------------------------------- */
/*                                   Roster                                   */
/* -------------------------------------------------------------------------- */

/**
 * The people a call can be scheduled for.
 *
 * Read from this project's own cache of the Nexus roster, never from Nexus
 * itself: that API allows fifty reads a day and is refreshed once by the
 * `roster-sync` function. A picker that called it directly would exhaust the
 * quota by lunchtime.
 *
 * People who have left are still returned, marked inactive, because calls
 * already point at them and a name is better than a bare id.
 */
export async function listRoster(): Promise<RosterPerson[]> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('nexus_users')
    .select('nexus_id, name, active')
    .order('name')

  if (error) throw translate(error, 'load the list of people')

  return (data as unknown as Array<{ nexus_id: string; name: string; active: boolean }>).map(
    (row) => ({ nexusId: row.nexus_id, name: row.name, active: row.active })
  )
}

/**
 * How long after a call ends before it counts as missed.
 *
 * Long enough that someone still wrapping up is not recorded as having missed
 * it, short enough that the Call Manager settles the same day.
 */
const MISSED_GRACE_MS = 2 * 60 * 1000

/**
 * Moves calls that ended while still `scheduled` into `missed`.
 *
 * Returns the ones that changed, so the caller can see what it settled — the
 * status write is what keeps each one from being handled twice, on any machine,
 * even across a restart.
 *
 * "Ended" means start plus duration: a call is not missed the moment it begins,
 * only once the whole slot has gone by without anybody saying otherwise.
 */
export async function markMissedCalls(): Promise<ScheduledCall[]> {
  requireUser()

  const now = Date.now()

  // A day back is enough to catch an overnight or a closed laptop without
  // dragging up months of history someone never tidied.
  const { data, error } = await getSupabase()
    .from('scheduled_calls')
    .select(COLUMNS)
    .eq('status', 'scheduled')
    .gte('starts_at', new Date(now - 24 * 60 * 60 * 1000).toISOString())
    .lt('starts_at', new Date(now).toISOString())

  if (error) throw translate(error, 'check for missed calls')

  const ended = (data as unknown as CallRow[])
    .map(toScheduledCall)
    /*
     * Only calls this person was actually on.
     *
     * A call somebody arranged for three colleagues is not theirs to declare
     * missed — they were not at it and would not know. The machines of the
     * people it was for decide that, each for itself.
     */
    .filter((call) => call.assignedToMe)
    .filter((call) => {
      const endsAt = new Date(call.startsAt).getTime() + call.durationMinutes * 60_000
      return now - endsAt > MISSED_GRACE_MS
    })

  if (ended.length === 0) return []

  /*
   * One at a time, through the guarded single-call function.
   *
   * A single bulk update would be fewer round trips but could not run at all:
   * changing a row belongs to whoever arranged the call, and most of these were
   * arranged by somebody else. Each one is also conditional on still being
   * `scheduled`, so a call settled on another machine in the meantime keeps the
   * answer it was given there.
   */
  const marked: ScheduledCall[] = []

  for (const call of ended) {
    if (await markCallMissed(call.id)) marked.push({ ...call, status: 'missed' })
  }

  if (marked.length > 0) logger.info(SCOPE, 'Marked calls as missed', { count: marked.length })
  return marked
}

/* -------------------------------------------------------------------------- */
/*                            Imported (Google) calls                         */
/* -------------------------------------------------------------------------- */

/** One event as the calendar service hands it over, before it becomes a row. */
export interface ImportedCallFields {
  eventId: string
  title: string
  startsAt: string
  durationMinutes: number
  notes: string
}

export interface ApplyImportedResult {
  imported: number
  updated: number
  removed: number
}

/**
 * Makes one window of the schedule match one Google calendar.
 *
 * Written as read-then-decide rather than a blind upsert, because the two sides
 * do not own the same fields. Google owns what the meeting *is* — its title and
 * when it happens — and those are overwritten on every sync. The user owns what
 * they have decided about it: the status they set, the notes they wrote. An
 * upsert would erase both every time the calendar refreshed.
 *
 * Scoped to the window that was fetched: a call outside it was never looked at,
 * so nothing here may conclude it has disappeared.
 */
export async function applyImportedCalls(
  email: string,
  range: ScheduledCallRange,
  events: ImportedCallFields[]
): Promise<ApplyImportedResult> {
  const user = requireUser()

  const { data, error } = await getSupabase()
    .from('scheduled_calls')
    .select(COLUMNS)
    .eq('google_account_email', email)
    .gte('starts_at', range.from)
    .lt('starts_at', range.to)

  if (error) throw translate(error, 'read the imported calls')

  const existing = new Map(
    (data as unknown as CallRow[])
      .filter((row) => row.google_event_id !== null)
      .map((row) => [row.google_event_id as string, row])
  )

  const seen = new Set<string>()
  const result: ApplyImportedResult = { imported: 0, updated: 0, removed: 0 }

  const inserts: Array<Record<string, unknown>> = []

  for (const event of events) {
    seen.add(event.eventId)
    const row = existing.get(event.eventId)

    if (!row) {
      inserts.push({
        user_id: user.id,
        title: event.title.slice(0, 200),
        starts_at: event.startsAt,
        duration_minutes: event.durationMinutes,
        notes: event.notes || null,
        status: 'scheduled',
        google_event_id: event.eventId,
        google_account_email: email
      })
      continue
    }

    // Only the fields Google owns, and only when one of them actually moved —
    // an unchanged calendar should cost no writes at all.
    const changed =
      row.title !== event.title ||
      new Date(row.starts_at).getTime() !== new Date(event.startsAt).getTime() ||
      row.duration_minutes !== event.durationMinutes

    if (!changed) continue

    const { error: updateError } = await getSupabase()
      .from('scheduled_calls')
      .update({
        title: event.title.slice(0, 200),
        starts_at: event.startsAt,
        duration_minutes: event.durationMinutes
      })
      .eq('id', row.id)

    if (updateError) throw translate(updateError, 'update an imported call')
    result.updated += 1
  }

  if (inserts.length > 0) {
    const { data: inserted, error: insertError } = await getSupabase()
      .from('scheduled_calls')
      .insert(inserts)
      .select('id')

    /*
     * A duplicate here is the index doing its job, not a failure.
     *
     * Two syncs can overlap — a month change while the first is still running,
     * two windows open, the effect re-running — and both will have read "not
     * here yet" for the same event before either wrote. The loser hits the
     * unique index, and the row it wanted exists either way, which is all the
     * sync was after.
     *
     * Swallowed here rather than avoided with `on conflict do nothing`: the
     * index is partial (`where google_event_id is not null`), and Postgres
     * cannot infer a partial index from a conflict target alone — asking it to
     * fails with 42P10 before it ever reaches the duplicate.
     */
    if (insertError && insertError.code !== DUPLICATE_KEY) {
      throw translate(insertError, 'import the calls')
    }

    // Count what was really written, so "imported 2" cannot mean "tried 2".
    const rows = (inserted as unknown as Array<{ id: string }> | null) ?? []
    result.imported = rows.length

    /*
     * An imported event is a call this person is on.
     *
     * It came off their own calendar, so they are both who arranged it and who
     * it is for — and without the assignee row it would be in nobody's
     * schedule, which is precisely where it must not be.
     */
    for (const row of rows) {
      try {
        await writeAssignees(row.id, resolveAssignees(undefined))
      } catch (assigneeError) {
        logger.warn(SCOPE, 'Imported call could not be assigned', { id: row.id, assigneeError })
      }
    }

    if (insertError) {
      logger.debug(SCOPE, 'A concurrent sync had already imported these', {
        email,
        events: inserts.length
      })
    }
  }

  /*
   * Anything still on our side that the calendar no longer returned was deleted
   * or cancelled in Google. Removing it is the point of following a calendar —
   * a cancelled meeting that keeps reminding you is worse than no reminder.
   */
  const vanished = [...existing.keys()].filter((eventId) => !seen.has(eventId))

  if (vanished.length > 0) {
    const { error: deleteError } = await getSupabase()
      .from('scheduled_calls')
      .delete()
      .eq('google_account_email', email)
      .in('google_event_id', vanished)

    if (deleteError) throw translate(deleteError, 'remove cancelled calls')
    result.removed = vanished.length
  }

  return result
}

/**
 * Removes every call imported from one Google account.
 *
 * Called when that account is disconnected: the user asked to stop following
 * that calendar, and leaving its meetings behind would mean a schedule nothing
 * updates any more. Calls the user typed in are untouched — the `not is null`
 * filter is what separates them.
 */
export async function deleteCallsFromGoogleAccount(email: string): Promise<number> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('scheduled_calls')
    .delete()
    .eq('google_account_email', email)
    .not('google_event_id', 'is', null)
    .select('id')

  if (error) throw translate(error, 'remove the imported calls')

  const removed = (data as unknown as Array<{ id: string }>).length
  logger.info(SCOPE, 'Removed imported calls', { email, removed })
  return removed
}

/**
 * Sets only the status, leaving every other field alone.
 *
 * Separate from `updateCall` because a caller settling a call knows the answer
 * to one question and nothing else. Sending a whole call back would mean
 * inventing values for the title, notes and duration it never had, and quietly
 * overwriting the real ones.
 */
export async function setCallStatus(
  id: string,
  status: ScheduledCallStatus
): Promise<ScheduledCall> {
  requireUser()

  /*
   * Through a function rather than a plain update.
   *
   * Being on somebody else's call does not make its time yours to move, so the
   * update policy stays with whoever arranged it — and a policy chooses rows,
   * never columns. `set_call_status` is the one door wide enough for a person
   * to say whether they turned up and narrow enough to change nothing else.
   */
  const { error } = await getSupabase().rpc('set_call_status', {
    p_call: id,
    p_status: status
  })

  if (error) throw translate(error, 'update the call')

  logger.info(SCOPE, 'Call status set', { id, status })
  return await readCall(id)
}

/**
 * Marks one call missed, but only while it is still `scheduled`.
 *
 * The condition is the whole point: an answer already given is never overwritten
 * by the sweep. Whoever writes first wins — the user settling the call by hand,
 * this machine's sweep, or another machine's — and every later attempt updates
 * nothing and reports `false`.
 *
 * Resolves to whether this call was the one that changed it.
 */
export async function markCallMissed(id: string): Promise<boolean> {
  requireUser()

  const { data, error } = await getSupabase().rpc('set_call_status', {
    p_call: id,
    p_status: 'missed',
    p_only_if_scheduled: true
  })

  if (error) throw translate(error, 'record the missed call')

  // The function answers with nothing when the guard held — somebody had
  // already settled the call, and their answer beats this guess.
  const changed = data !== null
  if (changed) logger.info(SCOPE, 'Call marked missed', { id })
  return changed
}

export async function deleteCall(id: string): Promise<void> {
  requireUser()

  const { error } = await getSupabase().from('scheduled_calls').delete().eq('id', id)
  if (error) throw translate(error, 'delete the call')

  logger.info(SCOPE, 'Call deleted', { id })
}

/* -------------------------------------------------------------------------- */

function requireUser(): { id: string } {
  const user = currentUser()
  if (!user) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'Sign in to use the Call Manager.',
      'Your schedule is stored with your account.'
    )
  }
  return user
}

/**
 * Checks what the database checks, so a mistake is caught before a round trip
 * and comes back as a sentence rather than a constraint name.
 */
function validate(input: ScheduledCallInput): {
  title: string
  starts_at: string
  duration_minutes: number
  notes: string | null
  status: string
} {
  const title = input.title.trim()
  if (!title) throw new AppError(ERROR_CODES.UNKNOWN, 'Give the call a title.')
  if (title.length > 200) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'The title is longer than 200 characters.')
  }

  const startsAt = new Date(input.startsAt)
  if (Number.isNaN(startsAt.getTime())) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'That date and time could not be read.')
  }

  const duration = Math.round(input.durationMinutes)
  if (!Number.isFinite(duration) || duration < 1 || duration > 1440) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'Length must be between 1 minute and 24 hours.')
  }

  const notes = input.notes.trim()
  if (notes.length > 2000) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'The notes are longer than 2000 characters.')
  }

  return {
    title,
    starts_at: startsAt.toISOString(),
    duration_minutes: duration,
    notes: notes || null,
    status: input.status ?? 'scheduled'
  }
}

function toScheduledCall(row: CallRow): ScheduledCall {
  const me = currentUser()
  const myNexusId = currentNexusId()

  // Primary first: the person the call is for leads the list everywhere it is
  // shown, and the rest follow in whatever order they were added.
  const assignees: CallAssignee[] = (row.scheduled_call_assignees ?? [])
    .map((entry) => ({
      nexusId: entry.nexus_id,
      name: entry.nexus_users?.name ?? 'Unknown',
      isPrimary: entry.is_primary
    }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))

  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    durationMinutes: row.duration_minutes,
    notes: row.notes ?? '',
    status: isStatus(row.status) ? row.status : 'scheduled',
    createdAt: row.created_at,
    googleEventId: row.google_event_id,
    googleAccountEmail: row.google_account_email,
    assignees,
    scheduledByMe: me !== null && row.user_id === me.id,
    assignedToMe:
      myNexusId !== null && assignees.some((person) => person.nexusId === myNexusId)
  }
}

/**
 * `missed` belongs here as much as the rest: the sweep writes it, so a row read
 * back without it would be shown as still scheduled and the call would look
 * unattended-to all over again.
 */
function isStatus(value: string): value is ScheduledCall['status'] {
  return (
    value === 'scheduled' ||
    value === 'completed' ||
    value === 'cancelled' ||
    value === 'missed'
  )
}

/**
 * Turns a Postgres error into something actionable.
 *
 * The two worth naming are a missing table (the migration has not been run) and
 * a policy refusal — both look like "it just does not work" otherwise.
 */
function translate(error: PostgrestError, action: string): AppError {
  logger.error(SCOPE, `Could not ${action}`, error)

  if (error.code === 'PGRST205') {
    return new AppError(
      ERROR_CODES.UNKNOWN,
      'The Call Manager is not set up on the server yet.',
      'Run the scheduled_calls migration in the Supabase SQL editor.'
    )
  }

  if (error.code === '42501') {
    return new AppError(
      ERROR_CODES.AUTH_FAILED,
      'You do not have permission to change this call.'
    )
  }

  return new AppError(ERROR_CODES.UNKNOWN, `Could not ${action}.`, error.message)
}
