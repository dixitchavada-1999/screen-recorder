import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface CardProps {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  /**
   * Folds the body away behind the header, which then opens and closes it.
   * For sections somebody visits once and then leaves alone.
   */
  collapsible?: boolean
  /** Whether a collapsible card starts open. Closed by default. */
  defaultOpen?: boolean
}

/** Standard panel used to group related controls. */
export function Card({
  title,
  description,
  actions,
  children,
  className,
  collapsible = false,
  defaultOpen = false
}: CardProps): React.JSX.Element {
  const frame = cn(
    'rounded-2xl border border-hairline bg-canvas-elevated/70 backdrop-blur-sm',
    className
  )

  const heading = (
    <div className="min-w-0">
      {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
      {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
    </div>
  )

  if (collapsible) {
    return (
      <details open={defaultOpen} className={cn('group/card', frame)}>
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-5 py-4 group-open/card:border-b group-open/card:border-hairline">
          {heading}
          <div className="flex shrink-0 items-center gap-2">
            {/* A button in the header does its job without also folding the card. */}
            {actions && (
              <div className="flex items-center gap-2" onClick={(event) => event.preventDefault()}>
                {actions}
              </div>
            )}
            <span
              aria-hidden="true"
              className="mt-0.5 font-mono text-sm text-faint transition-transform group-open/card:rotate-90"
            >
              ›
            </span>
          </div>
        </summary>
        <div className="p-5">{children}</div>
      </details>
    )
  }

  return (
    <section className={frame}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          {heading}
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  )
}

interface FieldProps {
  label: string
  hint?: string
  htmlFor?: string
  children: ReactNode
  className?: string
}

/** Label + control + hint, the repeating unit of the settings page. */
export function Field({
  label,
  hint,
  htmlFor,
  children,
  className
}: FieldProps): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-faint">{hint}</p>}
    </div>
  )
}
