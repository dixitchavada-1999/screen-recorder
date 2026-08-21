import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { AuthError, isValidEmail } from '@/services/auth'
import { cn } from '@/utils/cn'

interface AuthDialogProps {
  open: boolean
  onClose: () => void
}

interface FieldErrors {
  email?: string
  password?: string
}

/** A failure worth showing above the fields, with an optional second line. */
interface FormError {
  message: string
  hint?: string
}

/**
 * Signing in.
 *
 * One form and nothing else. Accounts are created in Nexus and passwords are
 * set there, so there is no second face to this dialog to switch to — and a
 * "Register" link that led somewhere this app cannot reach would be worse than
 * no link at all.
 */
export function AuthDialog({ open, onClose }: AuthDialogProps): React.JSX.Element {
  const { signIn } = useAuth()
  const { push } = useToast()
  const formId = useId()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  /** Failure from the auth service itself, shown above the fields. */
  const [formError, setFormError] = useState<FormError | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Reopening clears whatever was half-typed last time — a password left in a
  // field is a hazard.
  useEffect(() => {
    if (!open) return

    setEmail('')
    setPassword('')
    setShowPassword(false)
    setErrors({})
    setFormError(null)
  }, [open])

  /** Client-side checks only — Nexus remains the authority. */
  const validate = (): FieldErrors => {
    const found: FieldErrors = {}

    if (!email.trim()) found.email = 'Enter your email address.'
    else if (!isValidEmail(email)) found.email = 'That does not look like an email address.'

    if (!password) found.password = 'Enter your password.'

    return found
  }

  /*
   * Submitted once, never retried automatically.
   *
   * Nexus locks an address out after five failed attempts in fifteen minutes.
   * A form that retried on its own would spend somebody's whole budget on one
   * mistyped password and lock them out of their own workday.
   */
  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()

    const found = validate()
    setErrors(found)
    setFormError(null)
    if (Object.keys(found).length > 0) return

    setSubmitting(true)
    try {
      await signIn({ email: email.trim(), password })
      push({ tone: 'success', title: 'Signed in', description: email.trim() })
      onClose()
    } catch (error) {
      setFormError(
        error instanceof AuthError
          ? { message: error.message, ...(error.hint ? { hint: error.hint } : {}) }
          : { message: 'Something went wrong. Please try again.' }
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      title="Sign in"
      description="Use your workplace email and password."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {/* Lives outside the <form>, so it submits by id. */}
          <Button type="submit" form={formId} variant="primary" loading={submitting}>
            Sign in
          </Button>
        </>
      }
    >
      {formError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-record/40 bg-record/10 px-3 py-2 text-xs leading-relaxed text-record-strong"
        >
          <p>{formError.message}</p>
          {formError.hint && <p className="mt-0.5 opacity-80">{formError.hint}</p>}
        </div>
      )}

      <form id={formId} onSubmit={(event) => void handleSubmit(event)} className="grid gap-3">
        <TextField
          label="Email"
          type="email"
          value={email}
          autoComplete="email"
          placeholder="you@example.com"
          error={errors.email}
          onChange={setEmail}
          autoFocus
        />

        <TextField
          label="Password"
          type={showPassword ? 'text' : 'password'}
          value={password}
          autoComplete="current-password"
          placeholder="••••••••"
          error={errors.password}
          onChange={setPassword}
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((current) => !current)}
              className="text-[11px] font-medium text-muted transition-colors hover:text-ink"
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          }
        />
      </form>

      {/*
        Said plainly rather than offered as a link this app cannot honour.
        Accounts and passwords are managed where everything else about
        employment is, and a reset done there works here immediately.
      */}
      <p className="mt-4 text-center text-xs leading-relaxed text-faint">
        Accounts and passwords are managed in Nexus. Reset yours there and the new one works
        here straight away.
      </p>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */

interface TextFieldProps {
  label: string
  type: React.HTMLInputTypeAttribute
  value: string
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
  error?: string
  onChange: (value: string) => void
  /** Rendered inside the field on the right, e.g. a show/hide toggle. */
  trailing?: ReactNode
}

function TextField({
  label,
  type,
  value,
  placeholder,
  autoComplete,
  autoFocus,
  error,
  onChange,
  trailing
}: TextFieldProps): React.JSX.Element {
  const id = useId()

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          {...(error ? { 'aria-describedby': `${id}-error` } : {})}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            'selectable h-10 w-full rounded-xl border bg-surface px-3 text-sm text-ink',
            'transition-colors hover:border-faint focus:border-accent focus:outline-none',
            Boolean(trailing) && 'pr-14',
            error ? 'border-record/60' : 'border-hairline'
          )}
        />

        {trailing && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2">{trailing}</span>
        )}
      </div>

      {error && (
        <p id={`${id}-error`} className="mt-1 text-[11px] text-record-strong">
          {error}
        </p>
      )}
    </div>
  )
}

/** Circular initial used by the header chip and the account view. */
export function Avatar({
  name,
  size = 'sm'
}: {
  name: string
  size?: 'sm' | 'lg'
}): React.JSX.Element {
  const initial = name.trim().charAt(0).toUpperCase() || '?'

  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-accent/20 font-semibold text-accent-strong',
        size === 'lg' ? 'size-11 text-base' : 'size-6 text-[11px]'
      )}
    >
      {initial}
    </span>
  )
}
