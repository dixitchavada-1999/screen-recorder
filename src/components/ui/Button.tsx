import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/utils/cn'

export type ButtonVariant = 'primary' | 'record' | 'stop' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  loading?: boolean
  fullWidth?: boolean
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-white shadow-lg shadow-accent/25 hover:bg-accent-strong active:bg-accent',
  record:
    'bg-record text-white shadow-lg shadow-record/30 hover:bg-record-strong active:bg-record',
  stop: 'bg-surface text-ink border border-hairline hover:border-record hover:text-record-strong',
  secondary: 'bg-surface text-ink border border-hairline hover:bg-canvas-elevated',
  ghost: 'bg-transparent text-muted hover:bg-surface hover:text-ink',
  // Filled rather than outlined. A destructive action that looks like an empty
  // outline reads as secondary, and Sign out is the one thing the Profile card
  // is for — the tint gives it a shape to aim at without the shout of a solid
  // red, which on a list of Delete buttons would be all anybody could see.
  danger: 'bg-record/15 text-record-strong border border-record/40 hover:bg-record/25'
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-14 px-8 text-base gap-3 rounded-2xl font-semibold'
}

/** Shared button primitive used across every screen. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading = false,
  fullWidth = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  )
}

function Spinner(): React.JSX.Element {
  return (
    <svg
      className="size-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z"
      />
    </svg>
  )
}
