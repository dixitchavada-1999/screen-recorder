import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface ModalProps {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  className?: string
}

/**
 * Centred dialog built on the native `<dialog>` element, which gives focus
 * trapping, the top layer and Escape-to-close for free.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  className
}: ModalProps): React.JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  // The native `cancel` event covers Escape; route it through our handler so
  // parent state stays in sync with the element.
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    const handleCancel = (event: Event): void => {
      event.preventDefault()
      onClose()
    }

    dialog.addEventListener('cancel', handleCancel)
    return () => dialog.removeEventListener('cancel', handleCancel)
  }, [onClose])

  return (
    <dialog
      ref={ref}
      onClick={(event) => {
        // Clicking the backdrop (i.e. the dialog itself, not its content).
        if (event.target === ref.current) onClose()
      }}
      className={cn(
        // `m-auto` is what centres a top-layer <dialog>. Tailwind's preflight
        // resets margins to 0, which otherwise pins it to the top-left corner.
        'm-auto w-[min(32rem,calc(100vw-3rem))] max-h-[85vh] overflow-y-auto',
        'rounded-2xl border border-hairline bg-canvas-elevated p-0 text-ink shadow-2xl shadow-black/50',
        'backdrop:bg-black/60 backdrop:backdrop-blur-sm',
        className
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 truncate text-xs text-faint">{description}</p>}
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="shrink-0 rounded p-1 text-faint transition-colors hover:text-ink"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4">
            <path d="M6.3 5l3.7 3.7L13.7 5l1.3 1.3L11.3 10l3.7 3.7-1.3 1.3L10 11.3 6.3 15 5 13.7 8.7 10 5 6.3 6.3 5z" />
          </svg>
        </button>
      </div>

      <div className="px-5 py-4">{children}</div>

      {footer && (
        <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3">{footer}</div>
      )}
    </dialog>
  )
}
