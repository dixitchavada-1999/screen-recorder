import { useCallback, useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/types'
import { log, unwrap } from '@/services/ipc'

const IDLE: UpdateStatus = {
  state: 'idle',
  version: null,
  progress: null,
  message: null,
  checkedAt: null
}

interface UseAppUpdateResult {
  status: UpdateStatus
  /** Asks the server again, for somebody who does not want to wait for the timer. */
  check: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
}

/**
 * Whether a newer version is waiting, and the three buttons that act on it.
 *
 * The state is the main process's, not this hook's: a download carries on with
 * the window closed to the tray, and reopening it has to show a download in
 * progress rather than start from nothing. So the hook asks for the state once
 * and then follows the events.
 */
export function useAppUpdate(): UseAppUpdateResult {
  const [status, setStatus] = useState<UpdateStatus>(IDLE)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const current = await unwrap(window.api.update.status())
        if (!cancelled) setStatus(current)
      } catch (error) {
        log.warn('update', 'Could not read the update status', error)
      }
    })()

    const unsubscribe = window.api.update.onStatus(setStatus)

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  /*
   * All three swallow their errors on purpose.
   *
   * Whatever goes wrong arrives as an `error` state on the status event, which
   * the banner already renders. Throwing here as well would make the button
   * report the same failure twice, in two different places.
   */
  const check = useCallback(async () => {
    try {
      setStatus(await unwrap(window.api.update.check()))
    } catch (error) {
      log.warn('update', 'Update check failed', error)
    }
  }, [])

  const download = useCallback(async () => {
    try {
      setStatus(await unwrap(window.api.update.download()))
    } catch (error) {
      log.warn('update', 'Update download failed', error)
    }
  }, [])

  const install = useCallback(async () => {
    try {
      await unwrap(window.api.update.install())
    } catch (error) {
      log.warn('update', 'Could not start the installer', error)
    }
  }, [])

  return { status, check, download, install }
}
