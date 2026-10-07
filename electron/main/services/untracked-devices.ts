import { hostname } from 'node:os'
import type { ThisDevice, UntrackedDevice } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'
import { getMachineId } from './device'
import { refreshPolicy } from './tracking-policy'

const SCOPE = 'untracked-devices'

/**
 * Installations that record nothing, whoever signs in on them.
 *
 * The list lives on the server and only the people on `device_admins` may see
 * or change it — the functions there check, so hiding the screen is a courtesy
 * and not the boundary. Each machine learns whether it is on the list from
 * `my_status`, along with the rest of its policy.
 */

/** This installation, as shown on its Settings screen to be copied elsewhere. */
export async function thisDevice(): Promise<ThisDevice> {
  return { machineId: await getMachineId(), hostname: safeHostname() }
}

/** Whether the signed-in person may manage the list. Never throws. */
export async function canManageUntrackedDevices(): Promise<boolean> {
  if (!currentUser()) return false

  const { data, error } = await getSupabase().rpc('is_device_admin')
  if (error) {
    // A server without the function yet simply means nobody can.
    logger.debug(SCOPE, 'Could not ask whether this account manages devices', error)
    return false
  }
  return data === true
}

export async function listUntrackedDevices(): Promise<UntrackedDevice[]> {
  requireUser()

  const { data, error } = await getSupabase().rpc('list_untracked_devices')
  if (error) throw translate(error, 'read the untracked devices')

  return (data as Array<{
    machine_id: string
    label: string | null
    added_at: string
    hostname: string | null
    platform: string | null
    people: string | null
    last_seen_at: string | null
  }>).map((row) => ({
    machineId: row.machine_id,
    label: row.label,
    addedAt: row.added_at,
    hostname: row.hostname,
    platform: row.platform,
    people: row.people,
    lastSeenAt: row.last_seen_at
  }))
}

export async function addUntrackedDevice(machineId: string, label: string | null): Promise<void> {
  requireUser()

  // A device ID or a computer name; the server tells them apart and looks a
  // name up among the computers people have signed in on.
  const wanted = String(machineId).trim()
  if (!wanted) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'Give a device ID or a computer name.')
  }

  const { error } = await getSupabase().rpc('add_untracked_device', {
    p_machine: wanted,
    p_label: label?.trim() || null
  })
  if (error) throw translate(error, 'add the device')

  logger.info(SCOPE, 'Device added to the untracked list')
  // In case it is this one: stop now rather than at the next poll.
  void refreshPolicy()
}

/**
 * Takes a computer off the list — every installation of it at once, since one
 * computer added by name can be several. Returns how many were removed, and
 * refuses to call it done when the answer is none.
 */
export async function removeUntrackedDevices(machineIds: string[]): Promise<number> {
  requireUser()

  const ids = [...new Set(machineIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean))]
  if (ids.length === 0) throw new AppError(ERROR_CODES.UNKNOWN, 'Nothing to remove.')

  let removed: number
  const { data, error } = await getSupabase().rpc('remove_untracked_devices', { p_machines: ids })

  if (error && (error.code === 'PGRST202' || error.code === '42883')) {
    // A server without the newer function: one at a time, without a count.
    for (const id of ids) {
      const single = await getSupabase().rpc('remove_untracked_device', { p_machine: id })
      if (single.error) throw translate(single.error, 'remove the device')
    }
    removed = ids.length
  } else if (error) {
    throw translate(error, 'remove the device')
  } else {
    removed = typeof data === 'number' ? data : 0
  }

  logger.info(SCOPE, 'Removed from the untracked list', {
    asked: ids.map((id) => id.slice(0, 8)),
    removed
  })

  if (removed === 0) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'That computer was not on the list any more.',
      'Somebody may have removed it already; the list has been reloaded.'
    )
  }

  // In case it is this one: start again now rather than at the next poll.
  void refreshPolicy()
  return removed
}

/* -------------------------------------------------------------------------- */

function requireUser(): void {
  if (!currentUser()) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign in to manage devices.')
  }
}

function safeHostname(): string {
  try {
    return hostname()
  } catch {
    return 'This computer'
  }
}

function translate(error: { code?: string; message: string }, action: string): AppError {
  logger.error(SCOPE, `Could not ${action}`, error)

  if (error.code === '42501') {
    return new AppError(ERROR_CODES.AUTH_FAILED, 'This account cannot manage untracked devices.')
  }
  // The server's own sentence says which name it could not find, and what to do.
  if (error.code === 'P0002') {
    const hint = (error as { hint?: string }).hint
    return new AppError(ERROR_CODES.UNKNOWN, error.message, hint || undefined)
  }
  if (error.code === 'PGRST202' || error.code === '42883') {
    return new AppError(
      ERROR_CODES.UNKNOWN,
      'Untracked devices are not set up on the server yet.',
      'Apply the untracked_devices migration to the Supabase project.'
    )
  }

  return new AppError(ERROR_CODES.UNKNOWN, `Could not ${action}.`, error.message)
}
