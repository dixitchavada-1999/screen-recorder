import { useCallback, useEffect, useState } from 'react'
import type {
  CallScope,
  GoogleCalendarSyncResult,
  ScheduledCall,
  ScheduledCallInput,
  ScheduledCallRange,
  SerializedError
} from '@shared/types'
import { log, toSerializedError, unwrap } from '@/services/ipc'

interface UseScheduledCallsResult {
  calls: ScheduledCall[]
  loading: boolean
  error: SerializedError | null
  busy: boolean
  /** True while the connected Google calendars are being reconciled. */
  syncing: boolean
  /** Calendars that could not be read on the last sync. */
  syncFailures: GoogleCalendarSyncResult['failures']
  refresh: () => Promise<void>
  /** Pulls from Google, then reloads. Bound to the Refresh button. */
  syncAndRefresh: () => Promise<void>
  create: (input: ScheduledCallInput) => Promise<void>
  update: (id: string, input: ScheduledCallInput) => Promise<void>
  remove: (id: string) => Promise<void>
}

/**
 * The calls inside one window of time, from both sources.
 *
 * Takes an explicit range rather than a month because the views no longer agree
 * on what a page is: a week can straddle two months, and fetching by month
 * would leave the days either side of the boundary mysteriously empty.
 *
 * Google calendars are reconciled into the same range. Imported meetings are
 * ordinary rows by the time they get here, so nothing downstream — the
 * calendar, the day view, reminders — needs to know where a call came from.
 */
export function useScheduledCalls(
  range: ScheduledCallRange,
  /**
   * Which question the screen is asking.
   *
   * `assigned` is this person's schedule. `scheduled-by-me` is what they have
   * arranged for other people — the only way back to a call they set up and now
   * need to move, without it sitting in a day they are not part of. `all` is
   * everybody's, and the main process answers it only for an admin or a super
   * admin; anyone else asking gets their own schedule.
   */
  scope: CallScope = 'assigned'
): UseScheduledCallsResult {
  const [calls, setCalls] = useState<ScheduledCall[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncFailures, setSyncFailures] = useState<GoogleCalendarSyncResult['failures']>([])

  // Depended on as two strings rather than as the object: a caller building the
  // range inline would otherwise hand us a new identity on every render and
  // refetch forever.
  const { from, to } = range

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setCalls(await unwrap(window.api.calls.list({ from, to }, scope)))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setCalls([])
    } finally {
      setLoading(false)
    }
  }, [from, to, scope])

  /**
   * Reconciles the connected Google calendars into this range.
   *
   * Never throws: a calendar that cannot be read must not take the schedule
   * down with it. Whatever is already stored still lists, and the failure is
   * reported beside it. Resolves to `true` when anything actually changed, so
   * the caller can skip a pointless second fetch.
   */
  const sync = useCallback(async (): Promise<boolean> => {
    setSyncing(true)
    try {
      const result = await unwrap(window.api.google.sync({ from, to }))
      setSyncFailures(result.failures)
      return result.imported + result.updated + result.removed > 0
    } catch (caught) {
      log.warn('calls', 'Google calendar sync failed', caught)
      return false
    } finally {
      setSyncing(false)
    }
  }, [from, to])

  const syncAndRefresh = useCallback(async () => {
    const changed = await sync()
    if (changed) await refresh()
  }, [sync, refresh])

  /*
   * Draw what is stored, then reconcile in the background.
   *
   * The other way round the calendar would sit empty behind a network round
   * trip on every move — everything imported earlier is already on the server,
   * so there is nothing worth waiting for before showing it.
   */
  useEffect(() => {
    void (async () => {
      await refresh()
      if (await sync()) await refresh()
    })()
  }, [refresh, sync])

  const mutate = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const create = useCallback(
    (input: ScheduledCallInput) => mutate(() => unwrap(window.api.calls.create(input))),
    [mutate]
  )

  const update = useCallback(
    (id: string, input: ScheduledCallInput) =>
      mutate(() => unwrap(window.api.calls.update(id, input))),
    [mutate]
  )

  const remove = useCallback(
    (id: string) => mutate(() => unwrap(window.api.calls.remove(id))),
    [mutate]
  )

  return {
    calls,
    loading,
    error,
    busy,
    syncing,
    syncFailures,
    refresh,
    syncAndRefresh,
    create,
    update,
    remove
  }
}
