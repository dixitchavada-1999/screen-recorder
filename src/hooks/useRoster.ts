import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RosterPerson, SerializedError } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

interface UseRosterResult {
  /** Everybody who currently works there, by name. */
  people: RosterPerson[]
  /** Everybody, leavers included — for showing a name against an old call. */
  all: RosterPerson[]
  loading: boolean
  error: SerializedError | null
  /** Looks up a name by Nexus id, falling back to the id itself. */
  nameOf: (nexusId: string) => string
  refresh: () => Promise<void>
}

/**
 * The people a call can be scheduled for.
 *
 * Read from this app's own cached copy of the Nexus staff roster. Nothing here
 * ever calls the partner API: that allows fifty roster reads in a day and is
 * refreshed once by the server, which is exactly why the cache exists.
 *
 * Leavers stay in `all` and drop out of `people`. Calls already point at them,
 * and a name against an old call is worth more than a bare id — but nobody
 * should be able to schedule anything new for somebody who has gone.
 */
export function useRoster(): UseRosterResult {
  const [all, setAll] = useState<RosterPerson[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setAll(await unwrap(window.api.roster.list()))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setAll([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const people = useMemo(() => all.filter((person) => person.active), [all])

  const names = useMemo(
    () => new Map(all.map((person) => [person.nexusId, person.name])),
    [all]
  )

  const nameOf = useCallback((nexusId: string) => names.get(nexusId) ?? nexusId, [names])

  return { people, all, loading, error, nameOf, refresh }
}
