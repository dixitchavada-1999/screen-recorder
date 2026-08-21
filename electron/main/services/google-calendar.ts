import type { GoogleCalendarSyncResult, ScheduledCallRange } from '@shared/types'
import { GOOGLE_CALENDAR_API } from '../config/google'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { applyImportedCalls } from './calls'
import { connectedEmails, getAccessToken } from './google-accounts'

const SCOPE = 'google-calendar'

/**
 * Reading calendars from the connected Google accounts.
 *
 * One direction only: events become rows in `scheduled_calls`, and nothing the
 * user does in the app is ever sent back to Google. Once imported, a call is
 * indistinguishable from one typed in — reminders, the missed-call sweep and
 * the calendar all treat it the same way.
 */

/** An event, reduced to the fields a call is made of. */
export interface ImportedEvent {
  eventId: string
  title: string
  /** ISO 8601 instant. */
  startsAt: string
  durationMinutes: number
  /** Google's description, used as the initial note. May be empty. */
  notes: string
}

/** The shape Google returns, narrowed to what is read. */
interface CalendarEvent {
  id?: string
  status?: string
  summary?: string
  description?: string
  location?: string
  hangoutLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

/** Falls back to half an hour, which is what the app itself defaults to. */
const DEFAULT_DURATION_MINUTES = 30
/** The notes column stops at 2000; leave room rather than have Postgres refuse. */
const MAX_NOTE_LENGTH = 1800
/** Google's own ceiling per page. Pagination handles anything beyond it. */
const PAGE_SIZE = 250

/* -------------------------------------------------------------------------- */
/*                                   Syncing                                  */
/* -------------------------------------------------------------------------- */

/**
 * Brings one window of the schedule in line with every connected calendar.
 *
 * Accounts are handled independently and a failure in one is reported rather
 * than thrown: three calendars are connected precisely so that losing one — a
 * revoked grant, an offline moment — still leaves the other two working.
 */
export async function syncGoogleCalendars(
  range: ScheduledCallRange
): Promise<GoogleCalendarSyncResult> {
  const emails = await connectedEmails()

  const result: GoogleCalendarSyncResult = {
    imported: 0,
    updated: 0,
    removed: 0,
    failures: []
  }

  if (emails.length === 0) return result

  for (const email of emails) {
    try {
      const events = await fetchEvents(email, range)
      const applied = await applyImportedCalls(email, range, events)

      result.imported += applied.imported
      result.updated += applied.updated
      result.removed += applied.removed
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : 'That calendar could not be read.'

      logger.warn(SCOPE, 'Calendar sync failed for one account', { email, error })
      result.failures.push({ email, message })
    }
  }

  logger.info(SCOPE, 'Calendar sync finished', {
    accounts: emails.length,
    ...result,
    failures: result.failures.length
  })

  return result
}

/* -------------------------------------------------------------------------- */
/*                                  Fetching                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every timed event in the window, from that account's primary calendar.
 *
 * `singleEvents` expands a recurring meeting into its individual occurrences,
 * which is what the calendar actually needs — the alternative is one row for
 * "every Monday" that no reminder could ever fire on.
 */
export async function fetchEvents(
  email: string,
  range: ScheduledCallRange
): Promise<ImportedEvent[]> {
  const token = await getAccessToken(email)

  const events: ImportedEvent[] = []
  let pageToken: string | undefined

  do {
    const url = new URL(`${GOOGLE_CALENDAR_API}/calendars/primary/events`)
    url.search = new URLSearchParams({
      timeMin: range.from,
      timeMax: range.to,
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {})
    }).toString()

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` }
    })

    if (!response.ok) throw await describeApiError(response, email)

    const payload = (await response.json()) as {
      items?: CalendarEvent[]
      nextPageToken?: string
    }

    for (const item of payload.items ?? []) {
      const event = toImportedEvent(item)
      if (event) events.push(event)
    }

    pageToken = payload.nextPageToken
  } while (pageToken)

  logger.debug(SCOPE, 'Fetched calendar events', { email, count: events.length })
  return events
}

/**
 * Converts one Google event, or `null` when it is not a call.
 *
 * Two kinds are dropped. All-day entries (`start.date` rather than
 * `start.dateTime`) are holidays, birthdays and out-of-office markers — they
 * have no time to remind anyone about and would fill the day view with things
 * nobody is going to record. Cancelled events are dropped so the sweep below
 * removes any row previously imported for them.
 */
function toImportedEvent(item: CalendarEvent): ImportedEvent | null {
  if (!item.id || item.status === 'cancelled') return null

  const start = item.start?.dateTime
  if (!start) return null

  const startsAt = new Date(start)
  if (Number.isNaN(startsAt.getTime())) return null

  const end = item.end?.dateTime ? new Date(item.end.dateTime) : null
  const spanMinutes =
    end && !Number.isNaN(end.getTime())
      ? Math.round((end.getTime() - startsAt.getTime()) / 60_000)
      : DEFAULT_DURATION_MINUTES

  return {
    eventId: item.id,
    title: (item.summary ?? '').trim() || 'Untitled event',
    startsAt: startsAt.toISOString(),
    // The column accepts 1 minute to 24 hours; a malformed or multi-day event
    // is clamped rather than rejected by the database.
    durationMinutes: Math.min(1440, Math.max(1, spanMinutes)),
    notes: buildNotes(item)
  }
}

/**
 * The initial note: the joining details, then the description.
 *
 * Written only when the row is created — a re-sync never overwrites notes,
 * because by then they may be the user's own.
 */
function buildNotes(item: CalendarEvent): string {
  const parts: string[] = []

  if (item.hangoutLink) parts.push(item.hangoutLink)
  if (item.location) parts.push(item.location)
  if (item.description) parts.push(item.description.trim())

  return parts.join('\n\n').slice(0, MAX_NOTE_LENGTH)
}

/* -------------------------------------------------------------------------- */

/** Turns an API failure into something that names the fix. */
async function describeApiError(response: Response, email: string): Promise<AppError> {
  const body = await response.text().catch(() => '')
  logger.error(SCOPE, 'Google Calendar API refused the request', {
    email,
    status: response.status,
    body
  })

  /*
   * A token that exists but carries no calendar scope is its own failure.
   *
   * Google puts sensitive permissions behind a tick box on the consent screen,
   * and pressing Continue without ticking it still produces a perfectly valid
   * sign-in — one that can read the address and nothing else. Telling that
   * apart from a revoked grant matters, because the fix is different: tick the
   * box, rather than wonder what broke.
   */
  if (body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
    return new AppError(
      ERROR_CODES.AUTH_FAILED,
      `${email} was connected without calendar permission.`,
      'Disconnect it, connect again, and tick "See and download any calendar…" on the Google consent screen.'
    )
  }

  if (response.status === 401 || response.status === 403) {
    return new AppError(
      ERROR_CODES.AUTH_FAILED,
      `Google will not let the app read ${email}'s calendar.`,
      'Disconnect the account under Calendars and connect it again.'
    )
  }

  if (response.status === 429) {
    return new AppError(
      ERROR_CODES.UNKNOWN,
      'Google is rate limiting the calendar requests.',
      'Wait a minute and refresh again.'
    )
  }

  return new AppError(
    ERROR_CODES.UNKNOWN,
    `Google Calendar returned an error for ${email}.`,
    `HTTP ${response.status}`
  )
}
