import { useCallback, useEffect, useState } from 'react'
import type { RecordingEntry, SerializedError } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

interface UseLibraryResult {
  recordings: RecordingEntry[]
  loading: boolean
  error: SerializedError | null
  /** Id of the recording currently being deleted or exported. */
  busyId: string | null
  refresh: () => Promise<void>
  remove: (id: string) => Promise<void>
  /** Drops a missing recording from the list without touching the disk. */
  forget: (id: string) => Promise<void>
  /** Returns the chosen destination, or null when the dialog was cancelled. */
  exportFile: (id: string) => Promise<string | null>
}

/** Loads and mutates the app-managed recordings library. */
export function useLibrary(): UseLibraryResult {
  const [recordings, setRecordings] = useState<RecordingEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setRecordings(await unwrap(window.api.library.list()))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const remove = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      await unwrap(window.api.library.remove(id))
      // Drop it locally straight away rather than waiting for a re-list.
      setRecordings((current) => current.filter((item) => item.id !== id))
    } finally {
      setBusyId(null)
    }
  }, [])

  const forget = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      await unwrap(window.api.library.forget(id))
      setRecordings((current) => current.filter((item) => item.id !== id))
    } finally {
      setBusyId(null)
    }
  }, [])

  const exportFile = useCallback(async (id: string): Promise<string | null> => {
    setBusyId(id)
    try {
      return await unwrap(window.api.library.export(id))
    } finally {
      setBusyId(null)
    }
  }, [])

  return { recordings, loading, error, busyId, refresh, remove, forget, exportFile }
}
