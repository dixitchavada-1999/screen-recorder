import { useEffect, useRef, useState } from 'react'
import { cn } from '@/utils/cn'

/* -------------------------------------------------------------------------- */
/*                                   Select                                   */
/* -------------------------------------------------------------------------- */

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

interface SelectProps<T extends string | number> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onValueChange: (value: T) => void
  className?: string
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

/**
 * A select that is ours, not the operating system's.
 *
 * The native `<select>` draws its menu with a platform widget — the bright
 * system-blue list that ignores the theme and can spill past the window. This
 * renders the menu itself, so it matches everything else and stays inside the
 * dialog. The same `value`/`options`/`onValueChange` API as before, so every
 * caller is unchanged.
 */
export function Select<T extends string | number>({
  value,
  options,
  onValueChange,
  className,
  disabled = false,
  id,
  'aria-label': ariaLabel
}: SelectProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const selected = options.find((option) => String(option.value) === String(value))

  // Close when the pointer goes down anywhere outside.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = (option: SelectOption<T>): void => {
    if (option.disabled) return
    onValueChange(option.value)
    setOpen(false)
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
          else if ((event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') && !open) {
            event.preventDefault()
            setOpen(true)
          }
        }}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-hairline bg-surface px-3',
          'text-left text-sm text-ink transition-colors hover:border-faint',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-accent',
          className
        )}
      >
        <span className="truncate">{selected?.label ?? ''}</span>
        <svg
          className={cn('size-4 shrink-0 text-faint transition-transform', open && 'rotate-180')}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.2 7.2a1 1 0 0 1 1.4 0L10 10.6l3.4-3.4a1 1 0 1 1 1.4 1.4l-4.1 4.1a1 1 0 0 1-1.4 0L5.2 8.6a1 1 0 0 1 0-1.4z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className={cn(
            'absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-hairline',
            'bg-canvas-elevated p-1 shadow-xl shadow-black/40'
          )}
        >
          {options.map((option) => {
            const isSelected = String(option.value) === String(value)
            return (
              <li key={String(option.value)} role="option" aria-selected={isSelected}>
                <button
                  type="button"
                  disabled={option.disabled}
                  onClick={() => choose(option)}
                  className={cn(
                    'w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                    isSelected
                      ? 'bg-accent/15 font-medium text-accent-strong'
                      : 'text-ink hover:bg-accent/10',
                    option.disabled && 'cursor-not-allowed opacity-40'
                  )}
                >
                  {option.label}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*                                   Toggle                                   */
/* -------------------------------------------------------------------------- */

interface ToggleProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  description?: string
  disabled?: boolean
}

/** Accessible switch built on a real checkbox input. */
export function Toggle({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false
}: ToggleProps): React.JSX.Element {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start justify-between gap-4 rounded-xl px-1 py-1.5',
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {description && (
          <span className="mt-0.5 block text-xs leading-relaxed text-faint">{description}</span>
        )}
      </span>

      <span className="relative mt-0.5 shrink-0">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onCheckedChange(event.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden="true"
          className={cn(
            'block h-6 w-11 rounded-full border transition-colors duration-200',
            checked ? 'border-accent bg-accent' : 'border-hairline bg-surface',
            'peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent-strong peer-focus-visible:outline-offset-2'
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-1 size-4 rounded-full bg-white transition-transform duration-200',
            checked ? 'translate-x-6' : 'translate-x-1'
          )}
        />
      </span>
    </label>
  )
}

/* -------------------------------------------------------------------------- */
/*                                   Slider                                   */
/* -------------------------------------------------------------------------- */

interface SliderProps {
  value: number
  min: number
  max: number
  step: number
  onValueChange: (value: number) => void
  disabled?: boolean
  /** Formats the value shown beside the track. */
  format?: (value: number) => string
  id?: string
}

export function Slider({
  value,
  min,
  max,
  step,
  onValueChange,
  disabled = false,
  format,
  id
}: SliderProps): React.JSX.Element {
  const percent = ((value - min) / (max - min)) * 100

  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(Number(event.target.value))}
        className={cn(
          'h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface',
          'disabled:cursor-not-allowed disabled:opacity-50',
          '[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none',
          '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent-strong',
          '[&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:transition-transform',
          'hover:[&::-webkit-slider-thumb]:scale-110'
        )}
        style={{
          background: `linear-gradient(to right, var(--color-accent) ${percent}%, var(--color-surface) ${percent}%)`
        }}
      />
      {format && (
        <span className="w-12 shrink-0 text-right font-mono text-xs text-muted">
          {format(value)}
        </span>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*                                 ProgressBar                                */
/* -------------------------------------------------------------------------- */

interface ProgressBarProps {
  /** 0–100, or `null` for an indeterminate bar. */
  percent: number | null
  className?: string
}

export function ProgressBar({ percent, className }: ProgressBarProps): React.JSX.Element {
  const indeterminate = percent === null

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? {} : { 'aria-valuenow': Math.round(percent) })}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface', className)}
    >
      {indeterminate ? (
        <div className="animate-indeterminate h-full w-1/3 rounded-full bg-accent" />
      ) : (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      )}
    </div>
  )
}
