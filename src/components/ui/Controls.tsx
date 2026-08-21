import type { SelectHTMLAttributes } from 'react'
import { cn } from '@/utils/cn'

/* -------------------------------------------------------------------------- */
/*                                   Select                                   */
/* -------------------------------------------------------------------------- */

export interface SelectOption<T extends string | number> {
  value: T
  label: string
  disabled?: boolean
}

interface SelectProps<T extends string | number>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'> {
  value: T
  options: ReadonlyArray<SelectOption<T>>
  onValueChange: (value: T) => void
}

/** Native select, restyled. Native keeps keyboard and screen-reader support. */
export function Select<T extends string | number>({
  value,
  options,
  onValueChange,
  className,
  ...rest
}: SelectProps<T>): React.JSX.Element {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(event) => {
          const raw = event.target.value
          const match = options.find((option) => String(option.value) === raw)
          if (match) onValueChange(match.value)
        }}
        className={cn(
          'h-10 w-full appearance-none rounded-xl border border-hairline bg-surface px-3 pr-9',
          'text-sm text-ink transition-colors hover:border-faint',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...rest}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-faint"
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
