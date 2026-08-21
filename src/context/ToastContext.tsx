import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastTone = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: number
  tone: ToastTone
  title: string
  description?: string
  /**
   * Inline actions, e.g. "Open folder", or the two halves of a question.
   *
   * A plural: a toast that asks something needs both answers on it, and
   * sending the user off to find the second one elsewhere defeats the point of
   * asking here at all.
   */
  actions?: Array<{ label: string; onClick: () => void }>
}

interface ToastContextValue {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'>, durationMs?: number) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const DEFAULT_DURATION_MS = 6000

/** Lightweight transient notifications, scoped to the renderer. */
export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))

    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (toast: Omit<Toast, 'id'>, durationMs = DEFAULT_DURATION_MS) => {
      const id = nextId.current
      nextId.current += 1

      setToasts((current) => [...current, { ...toast, id }])

      // Errors stay until dismissed — they usually need an action from the user.
      if (toast.tone !== 'error') {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), durationMs)
        )
      }
    },
    [dismiss]
  )

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss])

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside <ToastProvider>')
  return context
}
