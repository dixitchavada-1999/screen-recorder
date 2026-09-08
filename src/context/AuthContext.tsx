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
  /**
   * Whether the signed-in account holds a permission.
   *
   * The one question every screen should ask before offering something —
   * never the role, which two people can share while needing different powers.
   *
   * This decides what is *drawn*. It is not the protection: the database
   * refuses what it refuses whatever the window shows, and both have to agree
   * for a capability to be real.
   */
  can: (permission: string) => boolean
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

  /*
   * Re-read the account whenever the window comes back to the person.
   *
   * Permissions are resolved at sign-in and then cached, so somebody whose role
   * or grants changed goes on seeing their old buttons — and is refused by the
   * database when they press one, which reads as the app being broken rather
   * than as a permission having changed. It is worth catching up often.
   *
   * Two moments, because one was not enough: the window being raised from the
   * tray, and the window simply being focused again. A window that never went to
   * the tray never fired the first, so an app left open all afternoon kept a
   * snapshot from the morning.
   *
   * The same call refreshes the main process, which resolves permissions from
   * the same profile read — so the two halves cannot drift apart.
   */
  useEffect(() => {
    const refresh = (): void => {
      void auth
        .refreshAccount()
        .then((current) => setUser(current))
        .catch(() => {
          // A failed refresh says nothing about the session. Keep what we have
          // rather than signing somebody out because the network blinked.
        })
    }

    const unsubscribeShown = window.api.window.onShown(refresh)
    window.addEventListener('focus', refresh)

    /*
     * And the case neither of those catches: a window left open on a second
     * monitor, untouched, while somebody's access is changed elsewhere. The
     * main process notices within the minute and pushes the new answer.
     */
    const unsubscribeAccess = window.api.auth.onAccessChanged((account) => setUser(account))

    return () => {
      unsubscribeShown()
      unsubscribeAccess()
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const can = useCallback(
    (permission: string): boolean => {
      if (!user) return false
      // A full-access role answers before the list is consulted, exactly as the
      // database does — so the two can never disagree about a super admin.
      return user.fullAccess || user.permissions.includes(permission)
    },
    [user]
  )

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, signOutEverywhere, can }),
    [user, loading, signIn, signOut, signOutEverywhere, can]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>')
  return context
}
