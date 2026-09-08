import { useCallback, useEffect, useState } from 'react'
import type { SerializedError, TaskDueToday } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

export interface TasksDueTodayHandle {
  tasks: TaskDueToday[]
  loading: boolean
  error: SerializedError | null
  refresh: () => Promise<void>
}

/**
 * What is due today, for the dashboard.
 *
 * Read once when the dashboard opens. Nothing polls it: a due date is a thing
 * somebody set, not a thing that moves, and the day it belongs to only changes
 * at midnight — by which point the window has almost certainly been away and
 * come back, which re-reads it anyway.
 *
 * A day with nothing due shows nothing. A day that could not be read says so —
 * the two are not the same, and treating them the same once cost an afternoon:
 * the call was failing outright and the dashboard looked exactly like a quiet
 * Tuesday.
 */
export function useTasksDueToday(): TasksDueTodayHandle {
  const [tasks, setTasks] = useState<TaskDueToday[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async () => {
    try {
      setTasks(await unwrap(window.api.tasks.dueToday()))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setTasks([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { tasks, loading, error, refresh }
}
