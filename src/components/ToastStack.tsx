import { useToast, type ToastTone } from '@/context/ToastContext'
import { cn } from '@/utils/cn'

const TONE_STYLES: Record<ToastTone, string> = {
  info: 'border-hairline bg-canvas-elevated text-ink',
  success: 'border-positive/40 bg-canvas-elevated text-ink',
  warning: 'border-warning/40 bg-canvas-elevated text-ink',
  error: 'border-record/50 bg-canvas-elevated text-ink'
}

const TONE_ACCENT: Record<ToastTone, string> = {
  info: 'bg-accent',
  success: 'bg-positive',
  warning: 'bg-warning',
  error: 'bg-record'
}

/** Fixed-position notification stack, rendered above every page. */
export function ToastStack(): React.JSX.Element {
  const { toasts, dismiss } = useToast()

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 flex-col gap-2"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto flex overflow-hidden rounded-xl border shadow-xl shadow-black/40',
            TONE_STYLES[toast.tone]
          )}
        >
          <span aria-hidden="true" className={cn('w-1 shrink-0', TONE_ACCENT[toast.tone])} />

          <div className="min-w-0 flex-1 p-3">
            <p className="text-xs font-semibold">{toast.title}</p>
            {toast.description && (
              <p className="mt-1 break-words text-xs leading-relaxed text-muted">
                {toast.description}
              </p>
            )}

            {toast.actions && toast.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3">
                {toast.actions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    onClick={() => {
                      action.onClick()
                      dismiss(toast.id)
                    }}
                    className="text-xs font-medium text-accent-strong hover:underline"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label="Dismiss notification"
            className="shrink-0 self-start p-2 text-faint transition-colors hover:text-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
              <path d="M6.3 5l3.7 3.7L13.7 5l1.3 1.3L11.3 10l3.7 3.7-1.3 1.3L10 11.3 6.3 15 5 13.7 8.7 10 5 6.3 6.3 5z" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}
