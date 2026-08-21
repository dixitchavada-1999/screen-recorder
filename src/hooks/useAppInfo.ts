import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/types'
import { log, unwrap } from '@/services/ipc'

/** Loads static environment information (versions, FFmpeg path) once. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const loaded = await unwrap(window.api.app.getInfo())
        if (!cancelled) setInfo(loaded)
      } catch (error) {
        log.error('app-info', 'Could not read application info', error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return info
}
