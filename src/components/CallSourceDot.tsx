import type { ScheduledCall } from '@shared/types'

interface CallSourceDotProps {
  call: ScheduledCall
  /** Email → colour, from the connected accounts. */
  colors: Map<string, string>
}

/**
 * Marks a call that came from a Google calendar, in that account's colour.
 *
 * Only imported calls get one. With three calendars merged into a single
 * schedule, "which of my addresses is this meeting on?" is otherwise
 * unanswerable without opening it — and the answer changes whether the user
 * expects the other attendees to be colleagues or family.
 *
 * Falls back to a neutral grey when the colour is not known yet: the accounts
 * load a moment after the calls do, and a dot that appears late is better than
 * one that flashes the wrong colour.
 */
export function CallSourceDot({ call, colors }: CallSourceDotProps): React.JSX.Element | null {
  const email = call.googleAccountEmail
  if (!email) return null

  return (
    <span
      title={`From ${email}`}
      aria-label={`Imported from ${email}`}
      className="size-2 shrink-0 rounded-full"
      style={{ backgroundColor: colors.get(email) ?? '#94a3b8' }}
    />
  )
}
