import { useCallback, useEffect, useState } from 'react'
import type { SerializedError, TrackedPerson } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

export interface TrackedPeopleHandle {
  people: TrackedPerson[]
  loading: boolean
  error: SerializedError | null
  /** Id of the row currently being written, for a per-row spinner. */
  busy: string | null
  refresh: () => Promise<void>
  setPolicy: (
    userId: string,
    patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean }
  ) => Promise<void>
}

/**
 * Everyone an administrator can set a policy for.
 *
 * Reads and writes go through the main process to the same table the tracking
 * machines read, so a switch flipped here reaches that machine on its own —
 * within one policy refresh, without anybody restarting anything.
 */
export function useTrackedPeople(): TrackedPeopleHandle {
  const [people, setPeople] = useState<TrackedPerson[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setPeople(await unwrap(window.api.tracking.people()))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setPeople([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setPolicy = useCallback(
    async (
      userId: string,
      patch: { trackingEnabled?: boolean; screenshotsEnabled?: boolean }
    ) => {
      setBusy(userId)
      try {
        const updated = await unwrap(window.api.tracking.setPolicy(userId, patch))
        // Replace the one row from the server's answer rather than re-reading
        // the list: switching tracking off also clears screenshots, and the
        // returned row already reflects that.
        setPeople((current) =>
          current.map((person) => (person.id === updated.id ? updated : person))
        )
      } finally {
        setBusy(null)
      }
    },
    []
  )

  return { people, loading, error, busy, refresh, setPolicy }
}
