import { useCallback, useEffect, useState } from 'react'
import type { GoogleAccount } from '@shared/types'
import { log, unwrap } from '@/services/ipc'

export interface GoogleAccountsHandle {
  accounts: GoogleAccount[]
  loading: boolean
  /** Email currently being connected or disconnected, for per-row spinners. */
  busy: string | null
  refresh: () => Promise<void>
  /**
   * Resolves with the connected account, or throws so the caller can report.
   * Pass an existing email to renew that account rather than add a new one.
   */
  connect: (reconnecting?: string) => Promise<GoogleAccount>
  disconnect: (email: string) => Promise<void>
}

/** The connected Google accounts and the actions that change that list. */
export function useGoogleAccounts(): GoogleAccountsHandle {
  const [accounts, setAccounts] = useState<GoogleAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setAccounts(await unwrap(window.api.google.accounts()))
    } catch (error) {
      log.warn('google', 'Could not list connected accounts', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connect = useCallback(
    async (reconnecting?: string) => {
      // Renewing marks that account's own row busy; a brand new connection has
      // no email to key on yet, so it uses a placeholder.
      setBusy(reconnecting ?? '__connecting__')
      try {
        const account = await unwrap(window.api.google.connect(reconnecting))
        await refresh()
        return account
      } finally {
        setBusy(null)
      }
    },
    [refresh]
  )

  const disconnect = useCallback(
    async (email: string) => {
      setBusy(email)
      try {
        await unwrap(window.api.google.disconnect(email))
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [refresh]
  )

  return { accounts, loading, busy, refresh, connect, disconnect }
}
