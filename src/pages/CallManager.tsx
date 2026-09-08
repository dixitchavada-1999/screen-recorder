import { useMemo, useState } from 'react'
import type { CallScope, ScheduledCall, ScheduledCallInput } from '@shared/types'
import { CallCalendar, dayKey } from '@/components/CallCalendar'
import { CallDayView } from '@/components/CallDayView'
import { CallDialog } from '@/components/CallDialog'
import { CallHoverCard } from '@/components/CallHoverCard'
import { CallSourceDot } from '@/components/CallSourceDot'
import { CallWeekView, startOfWeek, weekOf } from '@/components/CallWeekView'
import { CallStatusBadge } from '@/components/CallStatusBadge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { useGoogleAccounts } from '@/hooks/useGoogleAccounts'
import { useScheduledCalls } from '@/hooks/useScheduledCalls'
import { cn } from '@/utils/cn'

/**
 * Week is the default: "what is on this week" is the question people arrive
 * with. Day answers a narrower one, month a vaguer one.
 */
type View = 'day' | 'week' | 'month'

/**
 * The Call Manager.
 *
 * One selected date drives all three views, so switching between them never
 * loses the user's place — the day they were reading stays the day in front of
 * them, and the week around it is the week they were in.
 */
export function CallManager(): React.JSX.Element {
  const [view, setView] = useState<View>('week')
  /**
   * Whose calls are on screen.
   *
   * `assigned` is the schedule — what this person has to be at, whoever
   * arranged it. The second tab is the other question, and the only way back to
   * a call somebody set up for three colleagues: it does not belong in their own
   * day, but they still have to be able to move or cancel it.
   *
   * What that second question is depends on who is asking. An ordinary user may
   * ask about the calls they arranged — `scheduled-by-me`. Somebody who runs the
   * calls is asking about all of them, whoever arranged them, so for them the
   * same tab is `all`.
   */
  const [rawScope, setScope] = useState<CallScope>('assigned')
  const [selected, setSelected] = useState(() => new Date())
  const [editing, setEditing] = useState<ScheduledCall | null>(null)
  const [dialogStart, setDialogStart] = useState(() => new Date())
  const [dialogOpen, setDialogOpen] = useState(false)

  const month = useMemo(
    () => new Date(selected.getFullYear(), selected.getMonth(), 1),
    [selected]
  )

  /*
   * What to fetch, from the view rather than from the month.
   *
   * A week can straddle two months, so fetching a month would leave the days
   * on the far side of the boundary empty. The day view asks for its own month
   * anyway — moving day to day inside it then costs nothing.
   */
  const range = useMemo(() => {
    if (view === 'week') {
      const from = startOfWeek(selected)
      const to = new Date(from)
      to.setDate(to.getDate() + 7)
      return { from: from.toISOString(), to: to.toISOString() }
    }

    const from = new Date(month)
    const to = new Date(month.getFullYear(), month.getMonth() + 1, 1)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [view, selected, month])

  const { push } = useToast()
  const { user } = useAuth()

  /**
   * Whether this person runs the calls rather than only attends them.
   *
   * The same two roles the `is_call_manager` policy names, and the answer to
   * three questions at once: what the second tab asks, whether a call somebody
   * else arranged opens for editing, and whether it can be deleted.
   */
  const managesCalls = user?.role === 'super_admin' || user?.role === 'admin'

  /*
   * The second tab, read as the role that is asking means it.
   *
   * Derived from the role rather than stored, so a role that arrives after the
   * page is open — the profile loads a moment behind the session — cannot leave
   * a tab selected that is no longer offered.
   */
  const scope: CallScope = managesCalls && rawScope === 'scheduled-by-me' ? 'all' : rawScope

  const {
    calls,
    loading,
    error,
    busy,
    syncing,
    syncFailures,
    refresh,
    syncAndRefresh,
    create,
    update,
    remove
  } = useScheduledCalls(range, scope)

  // Email → colour, so an imported call can show which calendar it came from.
  const { accounts } = useGoogleAccounts()
  const accountColors = useMemo(
    () => new Map(accounts.map((account) => [account.email, account.color])),
    [accounts]
  )

  const selectedKey = dayKey(selected)
  const dayCalls = useMemo(
    () =>
      calls
        .filter((call) => dayKey(new Date(call.startsAt)) === selectedKey)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [calls, selectedKey]
  )

  /* ------------------------------- Actions ------------------------------- */

  const openNew = (start?: Date): void => {
    setEditing(null)
    setDialogStart(start ?? nextSensibleSlot(selected))
    setDialogOpen(true)
  }

  const openEdit = (call: ScheduledCall): void => {
    setEditing(call)
    setDialogOpen(true)
  }

  const handleSave = async (input: ScheduledCallInput): Promise<void> => {
    if (editing) {
      await update(editing.id, input)
      push({ tone: 'success', title: 'Call updated' })
    } else {
      await create(input)
      push({ tone: 'success', title: 'Call scheduled', description: input.title })
      // Follow the call if it landed on another day, so the result is visible.
      setSelected(new Date(input.startsAt))
    }
  }

  const handleDelete = async (): Promise<void> => {
    if (!editing) return
    await remove(editing.id)
    push({ tone: 'info', title: 'Call removed' })
  }

  /** The arrows step by whatever the current view shows. */
  const shift = (delta: number): void => {
    setSelected((current) => {
      const next = new Date(current)
      if (view === 'day') next.setDate(current.getDate() + delta)
      else if (view === 'week') next.setDate(current.getDate() + delta * 7)
      else next.setMonth(current.getMonth() + delta, 1)
      return next
    })
  }

  /* -------------------------------- Render ------------------------------- */

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Calendar"
        description={
          view === 'day'
            ? dayLabel(selected)
            : view === 'week'
              ? weekLabel(selected)
              : monthLabel(month)
        }
        actions={
          <>
            <ScopeTabs scope={scope} onChange={setScope} canSeeEveryone={managesCalls} />
            <ViewTabs view={view} onChange={setView} />

            <Button
              size="sm"
              variant="ghost"
              onClick={() => shift(-1)}
              aria-label={`Previous ${view}`}
            >
              ‹
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Date())}>
              Today
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => shift(1)}
              aria-label={`Next ${view}`}
            >
              ›
            </Button>

            {/* Pulls the connected Google calendars again for this month. */}
            <Button
              size="sm"
              variant="ghost"
              loading={syncing}
              onClick={() => void syncAndRefresh()}
              title="Check the connected calendars for changes"
            >
              Refresh
            </Button>

            <Button size="sm" variant="primary" onClick={() => openNew()}>
              Schedule call
            </Button>
          </>
        }
      >
        {/*
          One calendar failing is not a reason to hide the schedule: the rest of
          it is correct and still worth reading. The notice says which account
          is stale so nobody trusts an empty day that only looks empty.
        */}
        {syncFailures.length > 0 && (
          <div className="mb-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5">
            {syncFailures.map((failure) => (
              <p key={failure.email} className="text-xs leading-relaxed text-warning">
                <span className="font-medium">{failure.email}</span> — {failure.message}
              </p>
            ))}
          </div>
        )}

        {error ? (
          <ErrorNotice
            message={error.message}
            {...(error.hint ? { hint: error.hint } : {})}
            onRetry={() => void refresh()}
          />
        ) : view === 'week' ? (
          <CallWeekView
            anchor={selected}
            calls={calls}
            busy={busy}
            accountColors={accountColors}
            onOpen={openEdit}
            onSelectDay={(day) => {
              setSelected(day)
              setView('day')
            }}
            onSchedule={(start) => openNew(start)}
          />
        ) : view === 'day' ? (
          <CallDayView
            day={selected}
            calls={dayCalls}
            busy={busy}
            accountColors={accountColors}
            onOpen={openEdit}
            onSchedule={(start) => openNew(start)}
          />
        ) : (
          <CallCalendar
            month={month}
            selected={selected}
            calls={calls}
            onSelect={(day) => {
              setSelected(day)
              // Clicking a day in the month grid is a request to see that day.
              setView('day')
            }}
          />
        )}
      </Card>

      {/* The month view keeps a list underneath; the day view already is one. */}
      {view === 'month' && !error && (
        <Card
          title={dayLabel(selected)}
          description={
            loading
              ? 'Loading…'
              : dayCalls.length === 0
                ? 'Nothing scheduled'
                : `${dayCalls.length} ${dayCalls.length === 1 ? 'call' : 'calls'}`
          }
        >
          {dayCalls.length === 0 ? (
            <p className="text-xs leading-relaxed text-faint">
              Pick a day on the calendar and press Schedule call to put something on it.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {dayCalls.map((call) => (
                <li key={call.id}>
                  <CallHoverCard call={call}>
                    <button
                      type="button"
                      onClick={() => openEdit(call)}
                      disabled={busy}
                      className="block w-full rounded-xl border border-hairline bg-surface/60 px-3 py-2.5 text-left transition-colors hover:border-faint disabled:opacity-60"
                    >
                      {/* Title, its time, then who it is for - the same row
                          the day view draws. */}
                      <span className="flex items-center gap-2">
                        <CallSourceDot call={call} colors={accountColors} />
                        <span
                          className={cn(
                            'min-w-0 shrink truncate text-sm text-ink',
                            call.status === 'cancelled' && 'text-faint line-through'
                          )}
                        >
                          {call.title}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted">
                          ({timeLabel(call.startsAt)})
                        </span>

                        {call.assignees.length > 0 && (
                          <span className="min-w-0 shrink truncate text-xs text-muted">
                            {call.assignees.map((person) => person.name).join(', ')}
                          </span>
                        )}

                        <CallStatusBadge status={call.status} />
                      </span>

                      {call.notes && (
                        <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted">
                          <span className="text-faint">Note: </span>
                          {call.notes}
                        </span>
                      )}

                      {/* The calendar it came from, on the row rather than in a
                          tooltip - this list is scanned, not hovered. */}
                      {call.googleAccountEmail && (
                        <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted">
                          <span className="text-faint">Calendar: </span>
                          {call.googleAccountEmail}
                        </span>
                      )}
                    </button>
                  </CallHoverCard>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <CallDialog
        open={dialogOpen}
        call={editing}
        defaultStart={dialogStart}
        saving={busy}
        // A call can be changed by the person who arranged it or by whoever
        // runs the calls; anyone else on it may open it to read, not to edit. A
        // brand-new call (nothing being edited) is always editable.
        readOnly={editing !== null && !editing.scheduledByMe && !managesCalls}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
        onDelete={editing && (editing.scheduledByMe || managesCalls) ? handleDelete : null}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Whose calls are being looked at.
 *
 * Two different questions, deliberately not merged into one list. "My schedule"
 * is what this person has to be at. "Scheduled by me" is what they arranged for
 * other people — which belongs in those people's days, not in this one, but
 * still has to be reachable by whoever set it up.
 */
function ScopeTabs({
  scope,
  onChange,
  canSeeEveryone
}: {
  scope: CallScope
  onChange: (scope: CallScope) => void
  /**
   * True for an admin or a super admin. For them the second tab is everybody's
   * calls rather than the ones they happen to have arranged themselves — the
   * calls are theirs to run either way, and the narrower question is not the one
   * they are asking.
   */
  canSeeEveryone: boolean
}): React.JSX.Element {
  const options: Array<{ id: CallScope; label: string; hint: string }> = [
    { id: 'assigned', label: 'My schedule', hint: 'Calls you are on' },
    canSeeEveryone
      ? { id: 'all', label: 'All calls', hint: "Everybody's calls, whoever arranged them" }
      : {
          id: 'scheduled-by-me',
          label: 'Scheduled by me',
          hint: 'Calls you arranged for others'
        }
  ]

  return (
    <div
      role="tablist"
      aria-label="Which calls"
      className="mr-1 flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          title={option.hint}
          aria-selected={scope === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            scope === option.id ? 'bg-accent text-white' : 'text-muted hover:text-ink'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function ViewTabs({
  view,
  onChange
}: {
  view: View
  onChange: (view: View) => void
}): React.JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Calendar view"
      className="mr-1 flex items-center gap-0.5 rounded-lg border border-hairline bg-surface p-0.5"
    >
      {(['day', 'week', 'month'] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={view === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors',
            view === option ? 'bg-accent text-white' : 'text-muted hover:text-ink'
          )}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function ErrorNotice({
  message,
  hint,
  onRetry
}: {
  message: string
  hint?: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-record/40 bg-record/10 px-3 py-2.5 text-xs leading-relaxed text-record-strong">
      <p>{message}</p>
      {hint && <p className="mt-0.5 opacity-80">{hint}</p>}
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 font-medium underline-offset-2 hover:underline"
      >
        Try again
      </button>
    </div>
  )
}

/** The next whole hour on the chosen day, or 10:00 on any other day. */
function nextSensibleSlot(day: Date): Date {
  const now = new Date()
  const start = new Date(day)

  const isToday =
    now.getFullYear() === day.getFullYear() &&
    now.getMonth() === day.getMonth() &&
    now.getDate() === day.getDate()

  start.setHours(isToday ? now.getHours() + 1 : 10, 0, 0, 0)
  return start
}

/**
 * "10 – 16 August 2026", collapsing whatever the two ends share.
 *
 * A week can cross a month or a year, and repeating the parts that did not
 * change makes the common case harder to read for the sake of the rare one.
 */
function weekLabel(anchor: Date): string {
  const days = weekOf(anchor)
  const first = days[0]!
  const last = days[6]!

  const sameMonth = first.getMonth() === last.getMonth()
  const sameYear = first.getFullYear() === last.getFullYear()

  if (sameMonth && sameYear) {
    return `${first.getDate()} – ${last.toLocaleDateString([], {
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    })}`
  }

  const opening = first.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  })

  return `${opening} – ${last.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  })}`
}

function monthLabel(month: Date): string {
  return month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function dayLabel(day: Date): string {
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
