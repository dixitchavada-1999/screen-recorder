import type { KpiNote, KpiRecipient } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'

const SCOPE = 'kpi'

/**
 * KPI notes: what somebody who sets OKRs has put on a dashboard.
 *
 * Everything here runs as the signed-in account, so row level security is what
 * actually decides the answers — every note for whoever holds `okr.manage`,
 * only the ones addressed to you for anybody else. The checks below turn a
 * refusal into a sentence somebody can act on; they are not the protection.
 */

interface NoteRow {
  id: string
  body: string
  author_name: string | null
  created_at: string
}

/**
 * Every note this account is allowed to see, newest first.
 *
 * The audience is fetched separately rather than embedded in the query. It is
 * an administrator's detail — a recipient can read only their own row and would
 * get a list of one, which reads like the whole audience and is not — so it is
 * asked for only when there is somebody to show it to.
 */
export async function listKpiNotes(): Promise<KpiNote[]> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('kpi_notes')
    .select('id, body, author_name, created_at')
    .order('created_at', { ascending: false })

  if (error) throw translate(error, 'read the KPI notes')

  const rows = (data ?? []) as NoteRow[]
  if (rows.length === 0) return []

  const audiences = managesOkrs() ? await readAudiences(rows.map((row) => row.id)) : new Map()

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    authorName: row.author_name ?? '',
    createdAt: row.created_at,
    recipients: audiences.get(row.id) ?? []
  }))
}

/**
 * Writes one note and addresses it to the people given.
 *
 * The audience is written straight after the note, and a failure there takes
 * the note with it: a note addressed to nobody would sit in the table forever,
 * invisible to every dashboard including the admin's own idea of what they
 * sent.
 */
export async function createKpiNote(body: string, nexusIds: string[]): Promise<KpiNote> {
  const user = requireOkrManager()

  const text = body.trim()
  if (!text) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'Write the note before saving it.')
  }
  if (text.length > 2000) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'That note is too long.', 'Keep it under 2000 characters.')
  }

  // Duplicates would violate the primary key and fail the whole insert, and a
  // list that repeats somebody is a UI slip rather than a reason to refuse.
  const recipients = [...new Set(nexusIds.filter((id) => typeof id === 'string' && id))]
  if (recipients.length === 0) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'Choose at least one person for this note.')
  }

  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('kpi_notes')
    .insert({ body: text, created_by: user.id, author_name: user.name })
    .select('id, body, author_name, created_at')
    .single()

  if (error) throw translate(error, 'save the note')

  const note = data as NoteRow

  const { error: audienceError } = await supabase
    .from('kpi_note_recipients')
    .insert(recipients.map((nexusId) => ({ note_id: note.id, nexus_id: nexusId })))

  if (audienceError) {
    // Best effort. If this also fails the note is readable by its author alone,
    // which is visible and fixable, unlike a silent half-write.
    await supabase.from('kpi_notes').delete().eq('id', note.id)
    throw translate(audienceError, 'choose who the note is for')
  }

  logger.info(SCOPE, 'KPI note written', { id: note.id, people: recipients.length })

  const audiences = await readAudiences([note.id])

  return {
    id: note.id,
    body: note.body,
    authorName: note.author_name ?? '',
    createdAt: note.created_at,
    recipients: audiences.get(note.id) ?? []
  }
}

/** Removes a note from every dashboard it was on. The audience goes with it. */
export async function deleteKpiNote(id: string): Promise<void> {
  requireOkrManager()

  const { error } = await getSupabase().from('kpi_notes').delete().eq('id', id)
  if (error) throw translate(error, 'remove the note')

  logger.info(SCOPE, 'KPI note removed', { id })
}

/* -------------------------------------------------------------------------- */

interface RecipientRow {
  note_id: string
  nexus_id: string
}

/**
 * Who each of the given notes went to, as names.
 *
 * Two reads rather than a join: the audience lives in one table and the names
 * in another, and only a super admin can see the audience in full, so there is
 * no arrangement in which this is worth a nested query.
 */
async function readAudiences(noteIds: string[]): Promise<Map<string, KpiRecipient[]>> {
  const supabase = getSupabase()
  const byNote = new Map<string, KpiRecipient[]>()

  const { data, error } = await supabase
    .from('kpi_note_recipients')
    .select('note_id, nexus_id')
    .in('note_id', noteIds)

  if (error) {
    // The notes themselves are worth showing without it.
    logger.warn(SCOPE, 'Could not read who the notes were for', error)
    return byNote
  }

  const rows = (data ?? []) as RecipientRow[]
  if (rows.length === 0) return byNote

  const names = await readNames([...new Set(rows.map((row) => row.nexus_id))])

  for (const row of rows) {
    const list = byNote.get(row.note_id) ?? []
    list.push({ nexusId: row.nexus_id, name: names.get(row.nexus_id) ?? 'Unknown' })
    byNote.set(row.note_id, list)
  }

  for (const list of byNote.values()) list.sort((a, b) => a.name.localeCompare(b.name))

  return byNote
}

/**
 * Nexus names for the given ids.
 *
 * Read from the roster rather than from `profiles`, because that is what the
 * audience is keyed by — and because somebody can be on the roster, and so be
 * given a KPI, without ever having opened this app to have a profile at all.
 *
 * Leavers are still in the roster, so a note written before somebody left keeps
 * showing their name instead of a bare id.
 */
async function readNames(nexusIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()

  const { data, error } = await getSupabase()
    .from('nexus_users')
    .select('nexus_id, name')
    .in('nexus_id', nexusIds)

  if (error) {
    logger.warn(SCOPE, 'Could not read the names behind a note', error)
    return names
  }

  for (const row of (data ?? []) as Array<{ nexus_id: string; name: string | null }>) {
    names.set(row.nexus_id, row.name?.trim() || 'Unknown')
  }

  return names
}

function requireUser(): { id: string; name: string } {
  const user = currentUser()
  if (!user) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign in to see your KPIs.')
  }
  return { id: user.id, name: user.name }
}

function requireOkrManager(): { id: string; name: string } {
  const user = requireUser()

  if (!managesOkrs()) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'You cannot set an OKR for somebody else.',
      'The database refuses this regardless of what the window shows.'
    )
  }

  return user
}

/**
 * Whether this account sets OKRs for other people.
 *
 * Asked of the permission rather than the role, because the policies now do —
 * a check here that still asked for `super_admin` would refuse something the
 * database allows the moment somebody is granted it.
 */
function managesOkrs(): boolean {
  const user = currentUser()
  if (!user) return false
  return user.fullAccess || user.permissions.includes('okr.manage')
}

function translate(error: { message: string; code?: string }, what: string): AppError {
  logger.warn(SCOPE, `Could not ${what}`, error)

  return new AppError(
    ERROR_CODES.UNKNOWN,
    `Could not ${what}.`,
    error.message || 'The server did not say why.'
  )
}
