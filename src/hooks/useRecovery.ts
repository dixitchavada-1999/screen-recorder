import { useCallback, useEffect, useState } from 'react'
import type { FinalizeResult, OrphanRecording } from '@shared/types'
import { log, toSerializedError, unwrap } from '@/services/ipc'

interface UseRecoveryResult {
  orphans: OrphanRecording[]
  busySessionId: string | null
  restore: (sessionId: string) => Promise<FinalizeResult | null>
  discard: (sessionId: string) => Promise<void>
  refresh: () => Promise<void>
}

/**
 * Surfaces recordings left behind by a crash, a force-quit or a failed
 * conversion so the footage can still be salvaged.
 */
export function useRecovery(): UseRecoveryResult {
  const [orphans, setOrphans] = useState<OrphanRecording[]>([])
  const [busySessionId, setBusySessionId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setOrphans(await unwrap(window.api.recovery.list()))
    } catch (error) {
      log.warn('recovery', 'Could not list recoverable recordings', error)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const restore = useCallback(
    async (sessionId: string): Promise<FinalizeResult | null> => {
      setBusySessionId(sessionId)
      try {
        const result = await unwrap(window.api.recovery.restore(sessionId))
        await refresh()
        return result
      } catch (error) {
        log.error('recovery', 'Recovery failed', toSerializedError(error))
        throw error
      } finally {
        setBusySessionId(null)
      }
    },
    [refresh]
  )

  const discard = useCallback(
    async (sessionId: string) => {
      setBusySessionId(sessionId)
      try {
        await unwrap(window.api.recovery.discard(sessionId))
        await refresh()
      } finally {
        setBusySessionId(null)
      }
    },
    [refresh]
  )

  return { orphans, busySessionId, restore, discard, refresh }
}
