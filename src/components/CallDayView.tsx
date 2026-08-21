import { useMemo } from 'react'
import type { ScheduledCall } from '@shared/types'
import { CallHoverCard } from '@/components/CallHoverCard'
import { CallSourceDot } from '@/components/CallSourceDot'
import { CallStatusBadge } from '@/components/CallStatusBadge'
import { cn } from '@/utils/cn'

/** Hours always shown, even on an empty day. Extended to fit anything outside. */
const DEFAULT_FIRST_HOUR = 8
const DEFAULT_LAST_HOUR = 20

interface CallDayViewProps {
  day: Date
  calls: ScheduledCall[]
  busy: boolean
  /** Colour per connected Google account, for the source dot. */
  accountColors: Map<string, string>
  onOpen: (call: ScheduledCall) => void
  /** Clicking an empty hour schedules a call there. */
  onSchedule: (start: Date) => void
}

/**
 * One day as an hour rail.
 *
 * A row per hour rather than a proportional timeline: calls here are minutes
 * long against a day that is hours long, so drawing them to scale would leave
 * slivers no one can read or click.
 */
export function CallDayView({
  day,
  calls,
  busy,
  accountColors,
  onOpen,
  onSchedule
}: CallDayViewProps): React.JSX.Element {
  const byHour = useMemo(() => {
    const map = new Map<number, ScheduledCall[]>()

    for (const call of calls) {
      const hour = new Date(call.startsAt).getHours()
      const existing = map.get(hour)
      if (existing) existing.push(call)
      else map.set(hour, [call])
    }

    for (const list of map.values()) list.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    return map
  }, [calls])

  // Widen the rail so an early or late call is never hidden.
  const hours = useMemo(() => {
    const scheduled = [...byHour.keys()]
    const first = Math.min(DEFAULT_FIRST_HOUR, ...scheduled)
    const last = Math.max(DEFAULT_LAST_HOUR, ...scheduled)

    return Array.from({ length: last - first + 1 }, (_, index) => first + index)
  }, [byHour])

  const now = new Date()
  const isToday = sameDay(now, day)

  return (
    <ul className="flex flex-col">
      {hours.map((hour) => {
        const hourCalls = byHour.get(hour) ?? []
        const current = isToday && now.getHours() === hour

        return (
          <li key={hour} className="flex gap-3 border-t border-hairline first:border-t-0">
            <span
              className={cn(
                'w-14 shrink-0 pt-2.5 text-right font-mono text-[11px]',
                current ? 'font-semibold text-accent-strong' : 'text-faint'
              )}
            >
              {hourLabel(hour)}
            </span>

            <div className="min-w-0 flex-1 py-1.5">
              {hourCalls.length === 0 ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSchedule(atHour(day, hour))}
                  aria-label={`Schedule a call at ${hourLabel(hour)}`}
                  className="h-9 w-full rounded-lg border border-dashed border-transparent text-left text-xs text-transparent transition-colors hover:border-hairline hover:text-faint disabled:cursor-not-allowed"
                >
                  <span className="pl-2">Schedule</span>
                </button>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {hourCalls.map((call) => (
                    <CallHoverCard key={call.id} call={call} className="w-full">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onOpen(call)}
                        className={cn(
                          'block w-full rounded-lg border-l-2 bg-surface/70 px-3 py-2 text-left transition-colors',
                          'hover:bg-surface disabled:opacity-60',
                          // The stripe carries the state at a glance, before any
                          // text is read.
                          call.status === 'cancelled'
                            ? 'border-l-faint'
                            : call.status === 'completed'
                              ? 'border-l-positive'
                              : call.status === 'missed'
                                ? 'border-l-warning'
                                : 'border-l-accent'
                        )}
                      >
                        {/* Title, its time, then who it is for - read as one
                            sentence rather than as two ends of a wide row. */}
                        <span className="flex items-center gap-2">
                          <CallSourceDot call={call} colors={accountColors} />
                          <span
                            className={cn(
                              'min-w-0 shrink truncate text-sm text-ink',
                              call.status === 'cancelled' && 'text-faint line-through',
                              call.status === 'completed' && 'text-muted'
                            )}
                          >
                            {call.title}
                          </span>
                          <span className="shrink-0 font-mono text-xs text-muted">
                            ({timeLabel(call.startsAt)})
                          </span>

                          {/*
                            Left out when the call is simply this person's own:
                            a schedule that repeated your own name against every
                            entry would be noise.
                          */}
                          {!(call.assignedToMe && call.assignees.length === 1) &&
                            call.assignees.length > 0 && (
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

                        {/*
                          Which calendar this came from, spelled out. The dot
                          alone answers "not the same as that one", but with
                          three addresses merged into one day the question is
                          usually "which one?", and hovering to find out is a
                          poor way to ask it.
                        */}
                        {call.googleAccountEmail && (
                          <span className="mt-0.5 block truncate text-[11px] leading-snug text-muted">
                            <span className="text-faint">Calendar: </span>
                            {call.googleAccountEmail}
                          </span>
                        )}
                      </button>
                    </CallHoverCard>
                  ))}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/* -------------------------------------------------------------------------- */

function atHour(day: Date, hour: number): Date {
  const start = new Date(day)
  start.setHours(hour, 0, 0, 0)
  return start
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** Uses the viewer's own clock convention, 12- or 24-hour. */
function hourLabel(hour: number): string {
  const date = new Date()
  date.setHours(hour, 0, 0, 0)
  return date.toLocaleTimeString([], { hour: 'numeric' })
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
