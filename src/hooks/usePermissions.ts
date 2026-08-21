import { useCallback, useEffect, useState } from 'react'
import type { MediaPermissions, PermissionKind } from '@shared/types'
import { log, unwrap } from '@/services/ipc'

export interface PermissionsHandle {
  /** `null` until the first read completes. */
  permissions: MediaPermissions | null
  refresh: () => Promise<void>
  openSettings: (kind: PermissionKind) => Promise<void>
  requestMicrophone: () => Promise<void>
}

/**
 * Tracks the OS capture permissions.
 *
 * Re-read whenever the window regains focus, because granting screen recording
 * happens outside the app entirely — the user leaves for System Settings and
 * comes back — and nothing would otherwise tell the UI that the answer changed.
 */
export function usePermissions(): PermissionsHandle {
  const [permissions, setPermissions] = useState<MediaPermissions | null>(null)

  const refresh = useCallback(async () => {
    try {
      setPermissions(await unwrap(window.api.permissions.current()))
    } catch (error) {
      log.warn('permissions', 'Could not read media permissions', error)
    }
  }, [])

  useEffect(() => {
    void refresh()

    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const openSettings = useCallback(async (kind: PermissionKind) => {
    try {
      await unwrap(window.api.permissions.openSettings(kind))
    } catch (error) {
      log.warn('permissions', 'Could not open privacy settings', error)
    }
  }, [])

  const requestMicrophone = useCallback(async () => {
    try {
      setPermissions(await unwrap(window.api.permissions.requestMicrophone()))
    } catch (error) {
      log.warn('permissions', 'Microphone request failed', error)
    }
  }, [])

  return { permissions, refresh, openSettings, requestMicrophone }
}
