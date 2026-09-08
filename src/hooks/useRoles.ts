import { useCallback, useEffect, useState } from 'react'
import type { AppRole, PermissionInfo, SerializedError } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

export interface RolesHandle {
  roles: AppRole[]
  /** Everything the app knows how to gate, in the order the screen shows it. */
  catalogue: PermissionInfo[]
  loading: boolean
  error: SerializedError | null
  refresh: () => Promise<void>

  create: (label: string) => Promise<AppRole>
  rename: (key: string, label: string) => Promise<void>
  remove: (key: string) => Promise<void>
  setPermissions: (key: string, permissions: string[]) => Promise<void>
}

/**
 * The roles, and what each one may do.
 *
 * Both halves in one hook because the screen is useless with either alone: the
 * roles are rows, the catalogue is the columns, and they are read together and
 * always at the same moment.
 */
export function useRoles(): RolesHandle {
  const [roles, setRoles] = useState<AppRole[]>([])
  const [catalogue, setCatalogue] = useState<PermissionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [list, keys] = await Promise.all([
        unwrap(window.api.roles.list()),
        unwrap(window.api.roles.catalogue())
      ])
      setRoles(list)
      setCatalogue(keys)
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setRoles([])
      setCatalogue([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(async (label: string): Promise<AppRole> => {
    const role = await unwrap(window.api.roles.create(label))
    setRoles((current) => [...current, role])
    return role
  }, [])

  const rename = useCallback(async (key: string, label: string) => {
    await unwrap(window.api.roles.rename(key, label))
    setRoles((current) => current.map((role) => (role.key === key ? { ...role, label } : role)))
  }, [])

  const remove = useCallback(async (key: string) => {
    await unwrap(window.api.roles.remove(key))
    setRoles((current) => current.filter((role) => role.key !== key))
  }, [])

  const setPermissions = useCallback(async (key: string, permissions: string[]) => {
    const saved = await unwrap(window.api.roles.setPermissions(key, permissions))
    setRoles((current) =>
      current.map((role) => (role.key === key ? { ...role, permissions: saved } : role))
    )
  }, [])

  return { roles, catalogue, loading, error, refresh, create, rename, remove, setPermissions }
}
