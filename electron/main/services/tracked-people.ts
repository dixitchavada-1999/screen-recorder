import type { TrackedPerson, TrackingSchedule, UserRole } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'

const SCOPE = 'tracked-people'

/**
 * The people an administrator can see and set a policy for.
 *
 * Every statement here is subject to the same row level security the app uses
 * everywhere else: a non-admin asking for the list gets their own row, and a
 * non-admin trying to write somebody's policy gets nothing updated. The checks
 * below exist to turn that silence into a sentence, not to be the protection.
 */

interface ProfileRow {
  id: string
  email: string | null
  full_name: string | null
  role: string
  tracking_enabled: boolean | null
  screenshots_enabled: boolean | null
  apps_enabled: boolean | null
}

const COLUMNS = 'id, email, full_name, role, tracking_enabled, screenshots_enabled, apps_enabled'

export async function listTrackedPeople(): Promise<TrackedPerson[]> {
  requirePermission('team.view', 'see the team')

  const { data, error } = await getSupabase()
    .from('profiles')
    .select(COLUMNS)
    .order('email')

  if (error) throw translate(error, 'read the list of people')

  return (data as unknown as ProfileRow[]).map(toPerson)
}

/**
 * Sets one switch for one person.
 *
 * Screenshots are meaningless without tracking, so switching tracking off
 * switches them off with it rather than leaving a flag set that nothing can
 * act on — and which would quietly resume capturing the day tracking came back.
 */
export async function setTrackingPolicyFor(
  userId: string,
  patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean; appsEnabled?: boolean }
): Promise<TrackedPerson> {
  requirePermission('team.manage', 'change the tracking policy')

  const update: Record<string, boolean> = {}
  if (patch.trackingEnabled !== undefined) {
    update.tracking_enabled = patch.trackingEnabled
    if (!patch.trackingEnabled) {
      update.screenshots_enabled = false
      update.apps_enabled = false
    }
  }
  if (patch.screenshotsEnabled !== undefined) {
    update.screenshots_enabled = patch.screenshotsEnabled
  }
  if (patch.appsEnabled !== undefined) {
    update.apps_enabled = patch.appsEnabled
  }

  const { data, error } = await getSupabase()
    .from('profiles')
    .update(update)
    .eq('id', userId)
    .select(COLUMNS)
    .single()

  if (error) throw translate(error, 'change the tracking policy')

  logger.info(SCOPE, 'Tracking policy changed', { userId, ...patch })
  return toPerson(data as unknown as ProfileRow)
}

/* -------------------------------------------------------------------------- */

/**
 * The gate in front of the Team screen.
 *
 * Two permissions and not one, because reading the list and changing what it
 * records are different acts: `team.view` is what the screen is, `team.manage`
 * is what it does. The policies draw the same line, and a check here that drew
 * a coarser one would refuse something the database allows.
 */
/* -------------------------------------------------------------------------- */
/*                                  Schedule                                  */
/* -------------------------------------------------------------------------- */

/**
 * The schedule every tracked machine runs on.
 *
 * One row on the server. Readable by anybody signed in — a person being
 * tracked is entitled to know how often — and written only with `team.manage`.
 */
export async function readTrackingSchedule(): Promise<TrackingSchedule> {
  requirePermission('team.view', 'see the tracking schedule')

  const { data, error } = await getSupabase()
    .from('tracking_schedule')
    .select('screenshot_interval_minutes, idle_after_seconds')
    .eq('id', true)
    .single()

  if (error) throw translate(error, 'read the tracking schedule')
  return toSchedule(data as ScheduleRow)
}

export async function setTrackingSchedule(patch: Partial<TrackingSchedule>): Promise<TrackingSchedule> {
  requirePermission('team.manage', 'change the tracking schedule')

  const update: Partial<ScheduleRow> = {}
  if (patch.screenshotIntervalMinutes !== undefined) {
    update.screenshot_interval_minutes = Math.round(Number(patch.screenshotIntervalMinutes))
  }
  if (patch.idleAfterSeconds !== undefined) {
    update.idle_after_seconds = Math.round(Number(patch.idleAfterSeconds))
  }

  const { data, error } = await getSupabase()
    .from('tracking_schedule')
    .update(update)
    .eq('id', true)
    .select('screenshot_interval_minutes, idle_after_seconds')
    .single()

  if (error) throw translate(error, 'change the tracking schedule')

  logger.info(SCOPE, 'Tracking schedule changed', patch)
  return toSchedule(data as ScheduleRow)
}

interface ScheduleRow {
  screenshot_interval_minutes: number
  idle_after_seconds: number
}

function toSchedule(row: ScheduleRow): TrackingSchedule {
  return {
    screenshotIntervalMinutes: row.screenshot_interval_minutes,
    idleAfterSeconds: row.idle_after_seconds
  }
}

function requirePermission(permission: string, what: string): void {
  const user = currentUser()

  if (!user) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, `Sign in to ${what}.`)
  }

  if (!user.fullAccess && !user.permissions.includes(permission)) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      `You cannot ${what}.`,
      'The database refuses this regardless of what the window shows.'
    )
  }
}

function toPerson(row: ProfileRow): TrackedPerson {
  const email = row.email ?? ''

  return {
    id: row.id,
    email,
    // Falls back to the address rather than showing an empty row: somebody who
    // never set a name still has to be findable in the list.
    name: row.full_name?.trim() || email || 'Unnamed account',
    role: (row.role === 'super_admin' ? 'super_admin' : 'user') satisfies UserRole,
    roleKey: row.role,
    trackingEnabled: row.tracking_enabled === true,
    screenshotsEnabled: row.screenshots_enabled === true,
    appsEnabled: row.apps_enabled === true
  }
}

function translate(error: { code?: string; message: string }, action: string): AppError {
  logger.error(SCOPE, `Could not ${action}`, error)

  if (error.code === '42703' || error.code === 'PGRST205' || error.code === '42P01') {
    return new AppError(
      ERROR_CODES.UNKNOWN,
      'Tracking is not set up on the server yet.',
      'Apply the latest migrations to the Supabase project.'
    )
  }

  return new AppError(ERROR_CODES.UNKNOWN, `Could not ${action}.`, error.message)
}
