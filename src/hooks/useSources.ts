import { useCallback, useEffect, useState } from 'react'
import type { CaptureSource, SerializedError } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

interface UseSourcesResult {
  sources: CaptureSource[]
  loading: boolean
  error: SerializedError | null
  refresh: () => Promise<void>
}

/**
 * The last source list this session fetched.
 *
 * `desktopCapturer.getSources` costs a few hundred milliseconds each call, and
 * the Recorder page unmounts when you leave it — so without this, returning to
 * it re-runs that call and the picker flashes "Looking for screens…" every
 * time. Seeded from here, the picker shows the previous list instantly while a
 * fresh read updates it in the background.
 */
let cachedSources: CaptureSource[] = []

/**
 * Loads the list of capturable screens and windows.
 *
 * Thumbnails are regenerated on every refresh, which is why this is an explicit
 * action rather than a polling loop — capturing previews of every open window
 * is not free.
 *
 * On Wayland the entries come back as `placeholder` sources, so this runs
 * without raising the compositor's share prompt; the recording controller
 * resolves the chosen one when it starts.
 */
export function useSources(): UseSourcesResult {
  const [sources, setSources] = useState<CaptureSource[]>(cachedSources)
  const [loading, setLoading] = useState(cachedSources.length === 0)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async () => {
    // Only the first-ever fetch shows a loading state; later ones refresh the
    // already-visible list in place.
    if (cachedSources.length === 0) setLoading(true)
    try {
      // No thumbnails: the picker is a dropdown, so generating a capture of
      // every screen just to throw it away would be pure waste.
      const next = await unwrap(window.api.sources.list({ thumbnailWidth: 0 }))
      cachedSources = next
      setSources(next)
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setSources([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { sources, loading, error, refresh }
}
