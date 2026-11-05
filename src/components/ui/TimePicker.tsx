import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/utils/cn'

/**
 * A time field with a menu that is ours, not the browser's.
 *
 * Like the date and select controls, this replaces the platform widget — the
 * stepper and clock `<input type="time">` draws — with a themed dropdown of
 * quarter-hour slots. The value stays `HH:MM` in 24-hour form, which is what
 * `new Date("YYYY-MM-DDTHH:MM")` reads; only the labels are shown in 12-hour.
 */

const STEP_MINUTES = 15

export function TimePicker({
  value,
  onChange,
  disabled = false,
  id,
  className
}: {
  /** `HH:MM`, 24-hour. */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  id?: string
  className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const slots = useMemo(() => buildSlots(), [])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Bring the selected (or nearest) slot into view when the menu opens.
  useEffect(() => {
    if (!open || !list.current) return
    const active = list.current.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'center' })
  }, [open])

  const choose = (slot: string): void => {
    onChange(slot)
    setOpen(false)
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-hairline bg-surface px-3',
          'text-left text-sm text-ink transition-colors hover:border-faint',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-accent',
          className
        )}
      >
        <span className={cn('truncate', !value && 'text-faint')}>
          {value ? label12(value) : 'Pick a time'}
        </span>
        <svg className="size-4 shrink-0 text-faint" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm1 2h-2v5l4 2 1-1.7-3-1.5V6z" />
        </svg>
      </button>

      {open && (
        <ul
          ref={list}
          role="listbox"
          className="absolute inset-x-0 z-50 mt-1 max-h-60 overflow-auto rounded-xl border border-hairline bg-canvas-elevated p-1 shadow-xl shadow-black/40"
        >
          {slots.map((slot) => {
            const isSelected = slot === value
            return (
              <li key={slot} role="option" aria-selected={isSelected} data-active={isSelected}>
                <button
                  type="button"
                  onClick={() => choose(slot)}
                  className={cn(
                    'w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                    isSelected
                      ? 'bg-accent/15 font-medium text-accent-strong'
                      : 'text-ink hover:bg-accent/10'
                  )}
                >
                  {label12(slot)}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------- helpers ---------------------------------- */

function buildSlots(): string[] {
  const out: string[] = []
  for (let minutes = 0; minutes < 24 * 60; minutes += STEP_MINUTES) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
  return out
}

/** "13:00" → "1:00 PM". */
function label12(value: string): string {
  const [h, m] = value.split(':').map(Number)
  if (Number.isNaN(h) || Number.isNaN(m)) return value
  const period = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 || 12
  return `${hour}:${String(m).padStart(2, '0')} ${period}`
}
