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
  /**
   * Deletes several at once. Returns how many went, so the caller can say so.
   *
   * Never rejects: one recording refusing is not a reason to abandon the rest,
   * and the count is what the sentence afterwards is built from.
   */
  removeMany: (ids: readonly string[]) => Promise<{ deleted: number; failed: number }>
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

  /*
   * One at a time, deliberately.
   *
   * Every delete rewrites the catalogue file, and firing them together would
   * have the writes land on top of each other — the last one wins and the rest
   * of the deletions come back on the next refresh. Ten files is a moment's
   * work in sequence; correctness is worth more than the wait.
   *
   * Missing files need no special case: `deleteRecording` falls through to
   * dropping the entry when there is nothing on disk to bin.
   */
  const removeMany = useCallback(async (ids: readonly string[]) => {
    let deleted = 0
    let failed = 0
    const gone: string[] = []

    for (const id of ids) {
      setBusyId(id)
      try {
        await unwrap(window.api.library.remove(id))
        gone.push(id)
        deleted += 1
      } catch {
        failed += 1
      }
    }

    setBusyId(null)
    // One state write at the end, rather than a re-render per file.
    if (gone.length > 0) setRecordings((current) => current.filter((item) => !gone.includes(item.id)))

    return { deleted, failed }
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

  return { recordings, loading, error, busyId, refresh, remove, removeMany, forget, exportFile }
}
