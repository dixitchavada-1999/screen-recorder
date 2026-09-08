import type { AppRole, PermissionInfo, UserPermission } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'

const SCOPE = 'roles'

/**
 * Roles, and what each one may do.
 *
 * The module that turns access from something written in code into something
 * kept in a table. A role is a bag of permissions; a new role is a row.
 *
 * Everything here runs as the signed-in account, so row level security is what
 * actually decides the answers — reading is open to anybody signed in, because
 * the window has to know what it may offer, and writing belongs to a super
 * admin alone. The checks below turn a refusal into a sentence somebody can
 * act on; they are not the protection.
 *
 * One rule is deliberately not editable from here: `full_access`. It is the
 * short circuit that lets a super admin reach this screen at all, and a
 * checkbox that could switch it off is a way to lock everybody out of the room
 * whose door it locks.
 */

interface RoleRow {
  key: string
  label: string
  full_access: boolean
  built_in: boolean
  role_permissions: Array<{ permission_key: string }> | null
}

interface PermissionRow {
  key: string
  module: string
  label: string
  description: string
}

/** Every role, with the permissions it carries. Built-ins first, then by name. */
export async function listRoles(): Promise<AppRole[]> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('app_roles')
    .select('key, label, full_access, built_in, role_permissions(permission_key)')
    .order('built_in', { ascending: false })
    .order('label')

  if (error) throw translate(error, 'read the roles')

  return ((data ?? []) as RoleRow[]).map((row) => ({
    key: row.key,
    label: row.label,
    fullAccess: row.full_access,
    builtIn: row.built_in,
    permissions: (row.role_permissions ?? []).map((grant) => grant.permission_key)
  }))
}

/**
 * Everything the app knows how to gate.
 *
 * A catalogue rather than a setting: rows arrive with the migrations that add
 * the features they describe, so this only ever grows, and the screen renders
 * whatever is in it without knowing the names in advance.
 */
export async function listPermissions(): Promise<PermissionInfo[]> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('permissions')
    .select('key, module, label, description')
    .order('module')
    .order('sort')

  if (error) throw translate(error, 'read the permissions')

  return ((data ?? []) as PermissionRow[]).map((row) => ({
    key: row.key,
    module: row.module,
    label: row.label,
    description: row.description
  }))
}

/**
 * Adds a role, carrying nothing.
 *
 * Empty on purpose. A new role that started as a copy of something would be a
 * way to hand out powers by accident; this way the first tick is deliberate.
 */
export async function createRole(label: string): Promise<AppRole> {
  requireRoleManager()

  const clean = text(label, 60, 'Give the role a name.', 'That role name is too long.')
  const key = toKey(clean)

  if (!key) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'That name cannot be used.',
      'Use letters and numbers — the role is stored under a short version of its name.'
    )
  }

  const { error } = await getSupabase()
    .from('app_roles')
    .insert({ key, label: clean, full_access: false, built_in: false })

  if (error) {
    if (error.code === '23505') {
      throw new AppError(ERROR_CODES.UNKNOWN, `There is already a role called ${clean}.`)
    }
    throw translate(error, 'add that role')
  }

  logger.info(SCOPE, 'Role added', { key })

  return { key, label: clean, fullAccess: false, builtIn: false, permissions: [] }
}

export async function renameRole(key: string, label: string): Promise<void> {
  requireRoleManager()

  const clean = text(label, 60, 'Give the role a name.', 'That role name is too long.')

  const { error } = await getSupabase().from('app_roles').update({ label: clean }).eq('key', key)
  if (error) throw translate(error, 'rename that role')
}

/**
 * Removes a role, once nobody holds it.
 *
 * Checked here rather than left to the foreign key, because the database's own
 * answer to this is a constraint name and a number. Somebody has to be moved
 * off it first, and that is worth saying plainly.
 */
export async function deleteRole(key: string): Promise<void> {
  requireRoleManager()

  const supabase = getSupabase()

  const { count, error: countError } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', key)

  if (countError) throw translate(countError, 'remove that role')

  if ((count ?? 0) > 0) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      `${count} ${count === 1 ? 'person is' : 'people are'} still on this role.`,
      'Move them to another role first, then remove it.'
    )
  }

  const { error } = await supabase.from('app_roles').delete().eq('key', key)
  if (error) throw translate(error, 'remove that role')

  logger.info(SCOPE, 'Role removed', { key })
}

/**
 * Replaces what a role carries.
 *
 * Written as a difference rather than a clear-and-refill: for the moment
 * between the two writes, a role emptied and not yet refilled is a role that
 * can do nothing — and if the second write failed, permanently.
 */
export async function setRolePermissions(roleKey: string, keys: string[]): Promise<string[]> {
  requireRoleManager()

  const wanted = new Set(keys.filter((key) => typeof key === 'string' && key))
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('role_permissions')
    .select('permission_key')
    .eq('role_key', roleKey)

  if (error) throw translate(error, 'read what that role can do')

  const current = new Set(
    ((data ?? []) as Array<{ permission_key: string }>).map((row) => row.permission_key)
  )

  const added = [...wanted].filter((key) => !current.has(key))
  const removed = [...current].filter((key) => !wanted.has(key))

  if (added.length > 0) {
    const { error: addError } = await supabase
      .from('role_permissions')
      .insert(added.map((key) => ({ role_key: roleKey, permission_key: key })))

    if (addError) throw translate(addError, 'grant that permission')
  }

  if (removed.length > 0) {
    const { error: removeError } = await supabase
      .from('role_permissions')
      .delete()
      .eq('role_key', roleKey)
      .in('permission_key', removed)

    if (removeError) throw translate(removeError, 'take that permission away')
  }

  logger.info(SCOPE, 'Role permissions set', {
    role: roleKey,
    granted: added.length,
    revoked: removed.length
  })

  return [...wanted]
}

/**
 * Moves somebody onto a different role.
 *
 * The `profiles_guard_role` trigger asks for `roles.assign` and would refuse
 * this whatever this file did.
 */
export async function setUserRole(userId: string, roleKey: string): Promise<void> {
  const admin = requireAssigner()

  if (userId === admin.id) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'You cannot change your own role.',
      'Ask another super admin to do it — this is what stops the last one locking themselves out.'
    )
  }

  const { error } = await getSupabase().from('profiles').update({ role: roleKey }).eq('id', userId)
  if (error) throw translate(error, 'change that role')

  logger.info(SCOPE, 'Role assigned', { userId, roleKey })
}

/* -------------------------------------------------------------------------- */
/*                          One person's exceptions                           */
/* -------------------------------------------------------------------------- */

/**
 * What somebody has been given or refused on top of their role.
 *
 * Only the exceptions — anything not listed here follows the role, and saying
 * so by omission is what keeps a role change meaningful for everybody who has
 * no exception at all.
 */
export async function listUserPermissions(userId: string): Promise<UserPermission[]> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('user_permissions')
    .select('permission_key, granted')
    .eq('user_id', userId)

  if (error) throw translate(error, 'read that person’s permissions')

  return ((data ?? []) as Array<{ permission_key: string; granted: boolean }>).map((row) => ({
    permissionKey: row.permission_key,
    granted: row.granted
  }))
}

/**
 * Replaces somebody's exceptions outright.
 *
 * Written as a difference — added, flipped, dropped — rather than cleared and
 * refilled. For the moment between two writes, somebody stripped of their
 * exceptions is somebody who has quietly lost access, and if the second write
 * failed, permanently.
 *
 * An empty list is a real answer: it puts them back exactly on their role.
 */
export async function setUserPermissions(
  userId: string,
  overrides: UserPermission[]
): Promise<UserPermission[]> {
  requireAssigner()

  const wanted = new Map<string, boolean>()
  for (const entry of overrides) {
    if (typeof entry?.permissionKey === 'string' && typeof entry?.granted === 'boolean') {
      wanted.set(entry.permissionKey, entry.granted)
    }
  }

  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('user_permissions')
    .select('permission_key, granted')
    .eq('user_id', userId)

  if (error) throw translate(error, 'read that person’s permissions')

  const current = new Map(
    ((data ?? []) as Array<{ permission_key: string; granted: boolean }>).map((row) => [
      row.permission_key,
      row.granted
    ])
  )

  const added = [...wanted].filter(([key]) => !current.has(key))
  const flipped = [...wanted].filter(([key, granted]) => current.has(key) && current.get(key) !== granted)
  const dropped = [...current.keys()].filter((key) => !wanted.has(key))

  if (added.length > 0 || flipped.length > 0) {
    const { error: writeError } = await supabase.from('user_permissions').upsert(
      [...added, ...flipped].map(([key, granted]) => ({
        user_id: userId,
        permission_key: key,
        granted
      })),
      { onConflict: 'user_id,permission_key' }
    )

    if (writeError) throw translate(writeError, 'set that person’s permissions')
  }

  if (dropped.length > 0) {
    const { error: dropError } = await supabase
      .from('user_permissions')
      .delete()
      .eq('user_id', userId)
      .in('permission_key', dropped)

    if (dropError) throw translate(dropError, 'set that person’s permissions')
  }

  logger.info(SCOPE, 'Overrides set', {
    userId,
    added: added.length,
    flipped: flipped.length,
    dropped: dropped.length
  })

  return [...wanted].map(([permissionKey, granted]) => ({ permissionKey, granted }))
}

/* -------------------------------------------------------------------------- */

/**
 * A storable key from a readable name.
 *
 * "Project Viewer" becomes `project_viewer`. The key is what policies and rows
 * point at, so it has to be plain; the label is what people read.
 */
function toKey(label: string): string {
  const key = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 39)

  return /^[a-z][a-z0-9_]{1,38}$/.test(key) ? key : ''
}

function text(value: string, max: number, missing: string, tooLong: string): string {
  const clean = (value ?? '').trim()
  if (!clean) throw new AppError(ERROR_CODES.UNKNOWN, missing)
  if (clean.length > max) throw new AppError(ERROR_CODES.UNKNOWN, tooLong)
  return clean
}

function requireUser(): { id: string } {
  const user = currentUser()
  if (!user) throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign in to see the roles.')
  return { id: user.id }
}

/**
 * Deciding what the roles mean.
 *
 * Asked of the permission rather than of the role, and for the reason this
 * whole module exists: it is now possible to be trusted with this without being
 * a super admin, and the policies were changed to say so. A check here that
 * still asked for the role would refuse something the database allows.
 */
function requireRoleManager(): { id: string } {
  const user = requireUser()

  if (!holds('roles.manage')) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'You cannot change roles and permissions.',
      'The database refuses this regardless of what the window shows.'
    )
  }

  return user
}

/** Whether the signed-in account holds a permission. Full access holds them all. */
function holds(permission: string): boolean {
  const account = currentUser()
  if (!account) return false
  return account.fullAccess || account.permissions.includes(permission)
}

/**
 * Handing something to a person — a role, or an exception — is one permission.
 *
 * Separate from `roles.manage`, which is about what the roles *mean*. Somebody
 * can be trusted to put people on existing roles without being trusted to
 * redefine what those roles carry.
 */
function requireAssigner(): { id: string } {
  const user = requireUser()

  if (!holds('roles.assign')) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'You cannot change what somebody else may do.',
      'The database refuses this regardless of what the window shows.'
    )
  }

  return user
}

function translate(error: { message: string; code?: string }, what: string): AppError {
  logger.warn(SCOPE, `Could not ${what}`, error)

  return new AppError(
    ERROR_CODES.UNKNOWN,
    `Could not ${what}.`,
    error.message || 'The server did not say why.'
  )
}
