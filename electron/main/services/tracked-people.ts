import type { TrackedPerson, UserRole } from '@shared/types'
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
}

const COLUMNS = 'id, email, full_name, role, tracking_enabled, screenshots_enabled'

export async function listTrackedPeople(): Promise<TrackedPerson[]> {
  requireAdmin()

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
  patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean }
): Promise<TrackedPerson> {
  requireAdmin()

  const update: Record<string, boolean> = {}
  if (patch.trackingEnabled !== undefined) {
    update.tracking_enabled = patch.trackingEnabled
    if (!patch.trackingEnabled) update.screenshots_enabled = false
  }
  if (patch.screenshotsEnabled !== undefined) {
    update.screenshots_enabled = patch.screenshotsEnabled
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

function requireAdmin(): void {
  const user = currentUser()

  if (!user) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign in to manage tracking.')
  }

  if (user.role !== 'super_admin') {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'Only a super admin can manage tracking.',
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
    screenshotsEnabled: row.screenshots_enabled === true
  }
}

function translate(error: { code?: string; message: string }, action: string): AppError {
  logger.error(SCOPE, `Could not ${action}`, error)

  if (error.code === '42703') {
    return new AppError(
      ERROR_CODES.UNKNOWN,
      'Tracking is not set up on the server yet.',
      'Run the add_tracking_policy migration in the Supabase SQL editor.'
    )
  }

  return new AppError(ERROR_CODES.UNKNOWN, `Could not ${action}.`, error.message)
}
