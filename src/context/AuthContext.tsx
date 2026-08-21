import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useToast } from '@/context/ToastContext'
import type { AuthUser, SignInInput } from '@/services/auth'
import * as auth from '@/services/auth'
import { log } from '@/services/ipc'

interface AuthContextValue {
  /** The signed-in account, or `null` when nobody is signed in. */
  user: AuthUser | null
  /** True until the stored session (if any) has been checked on startup. */
  loading: boolean
  /**
   * Checks the credentials with Nexus and starts a session.
   *
   * There is nothing beside it: accounts and passwords are Nexus's, so this
   * app can neither create one nor change one.
   */
  signIn: (input: SignInInput) => Promise<void>
  signOut: () => Promise<void>
  /** Signs out here and everywhere else the account is open. */
  signOutEverywhere: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Holds the signed-in account for the whole renderer.
 *
 * The state lives in React rather than in a module-level store because nothing
 * outside the UI needs it — the recording pipeline and the tray work exactly the
 * same signed in or out.
 */
export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  const { push } = useToast()

  // Restore a previous session before the first paint of the account controls,
  // so a signed-in user never sees "Log in" flash on startup.
  useEffect(() => {
    let cancelled = false

    void auth
      .restoreSession()
      .then((restored) => {
        if (!cancelled) setUser(restored)
      })
      .catch((error: unknown) => {
        log.warn('auth', 'Could not restore the session', error)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  // A confirmation link opened in the browser signs the user in out here, with
  // no form involved — the main process pushes the result in.
  useEffect(() => {
    return window.api.auth.onChanged((next) => {
      log.info('auth', 'Signed in from an email link', { email: next.email })
      setUser(next)
      push({ tone: 'success', title: 'Email confirmed', description: next.email })
    })
  }, [push])

  // The same link failing — expired, or already used once.
  useEffect(() => {
    return window.api.auth.onError((failure) => {
      log.warn('auth', 'Email link could not be completed', failure)
      push({
        tone: 'error',
        title: failure.message,
        ...(failure.hint ? { description: failure.hint } : {})
      })
    })
  }, [push])

  const signIn = useCallback(async (input: SignInInput) => {
    setUser(await auth.signIn(input))
  }, [])

  const signOut = useCallback(async () => {
    try {
      await auth.signOut()
    } finally {
      // Whatever the backend says, the local session is over — leaving the user
      // signed in after they asked to leave is the worse failure.
      setUser(null)
    }
  }, [])

  const signOutEverywhere = useCallback(async () => {
    try {
      await auth.signOutEverywhere()
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, signOutEverywhere }),
    [user, loading, signIn, signOut, signOutEverywhere]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}
