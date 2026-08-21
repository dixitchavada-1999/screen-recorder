import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { AppSettings } from '@shared/types'
import type { DeepPartial } from '@shared/api'
import { log, unwrap } from '@/services/ipc'

const SCOPE = 'settings-context'

interface SettingsContextValue {
  settings: AppSettings | null
  /** True until the first load from the main process completes. */
  loading: boolean
  updateSettings: (patch: DeepPartial<AppSettings>) => Promise<void>
  resetSettings: () => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

/**
 * Holds the single copy of application settings in the renderer.
 *
 * The main process remains the source of truth; this provider mirrors it and
 * re-syncs whenever the store broadcasts a change, so multiple windows (and
 * future tray controls) never drift apart.
 */
export function SettingsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const loaded = await unwrap(window.api.settings.get())
        if (!cancelled) setSettings(loaded)
      } catch (error) {
        log.error(SCOPE, 'Could not load settings', error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    const unsubscribe = window.api.settings.onChanged((next) => {
      if (!cancelled) setSettings(next)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const updateSettings = useCallback(async (patch: DeepPartial<AppSettings>) => {
    try {
      // Optimistic: the broadcast from the main process confirms shortly after.
      const next = await unwrap(window.api.settings.update(patch))
      setSettings(next)
    } catch (error) {
      log.error(SCOPE, 'Could not update settings', error)
    }
  }, [])

  const resetSettings = useCallback(async () => {
    try {
      setSettings(await unwrap(window.api.settings.reset()))
    } catch (error) {
      log.error(SCOPE, 'Could not reset settings', error)
    }
  }, [])

  const value = useMemo(
    () => ({ settings, loading, updateSettings, resetSettings }),
    [settings, loading, updateSettings, resetSettings]
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const context = useContext(SettingsContext)
  if (!context) throw new Error('useSettings must be used inside <SettingsProvider>')
  return context
}
