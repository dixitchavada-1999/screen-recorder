import type { ReactNode } from 'react'
import { cn } from '@/utils/cn'

interface CardProps {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
}

/** Standard panel used to group related controls. */
export function Card({
  title,
  description,
  actions,
  children,
  className
}: CardProps): React.JSX.Element {
  return (
    <section
      className={cn(
        'rounded-2xl border border-hairline bg-canvas-elevated/70 backdrop-blur-sm',
        className
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
          </div>
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
