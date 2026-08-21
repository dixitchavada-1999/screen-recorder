import { useCallback, useEffect, useState } from 'react'
import type { KpiNote, SerializedError } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

export interface KpiNotesHandle {
  notes: KpiNote[]
  loading: boolean
  error: SerializedError | null
  refresh: () => Promise<void>
  create: (body: string, nexusIds: string[]) => Promise<void>
  remove: (id: string) => Promise<void>
}

/**
 * The KPI notes on this account's dashboard.
 *
 * One call for everybody — row level security decides what "my dashboard"
 * means, so a super admin gets every note and everybody else gets the ones
 * addressed to them. Nothing here branches on the role.
 */
export function useKpiNotes(): KpiNotesHandle {
  const [notes, setNotes] = useState<KpiNote[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async () => {
    try {
      setNotes(await unwrap(window.api.kpi.list()))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setNotes([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(async (body: string, nexusIds: string[]) => {
    const created = await unwrap(window.api.kpi.create(body, nexusIds))
    // Straight onto the top of the list from the server's own answer, rather
    // than a re-read: the note is already exactly as it was stored.
    setNotes((current) => [created, ...current])
  }, [])

  const remove = useCallback(async (id: string) => {
    await unwrap(window.api.kpi.remove(id))
    setNotes((current) => current.filter((note) => note.id !== id))
  }, [])

  return { notes, loading, error, refresh, create, remove }
}
