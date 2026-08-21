import { useMemo } from 'react'
import type { ScheduledCall } from '@shared/types'
import { DayHoverCard } from '@/components/CallHoverCard'
import { cn } from '@/utils/cn'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

interface CallCalendarProps {
  /** Any date inside the month being shown. */
  month: Date
  selected: Date
  calls: ScheduledCall[]
  onSelect: (day: Date) => void
}

/**
 * A month grid, built from `Date` rather than a calendar library.
 *
 * Laid out as a table: ruled cells, each one saying how many calls it holds.
 * Hovering a cell lays that day out in full — the grid answers "which days",
 * the card answers "which calls", and neither has to shout over the other.
 *
 * Weeks start on Monday and the grid always holds six rows, so the panel does
 * not change height as the user moves between months.
 */
export function CallCalendar({
  month,
  selected,
  calls,
  onSelect
}: CallCalendarProps): React.JSX.Element {
  const days = useMemo(() => buildGrid(month), [month])

  /*
   * Each day's calls, keyed by local date rather than by the stored instant — a
   * call at 00:30 belongs to the day the user sees it on.
   *
   * Sorted by time within the day, because a cell that listed the first three
   * calls in whatever order they arrived would be lying about which three.
   */
  const byDay = useMemo(() => {
    const map = new Map<string, ScheduledCall[]>()

    for (const call of calls) {
      const key = dayKey(new Date(call.startsAt))
      const existing = map.get(key)
      if (existing) existing.push(call)
      else map.set(key, [call])
    }

    for (const day of map.values()) day.sort((a, b) => a.startsAt.localeCompare(b.startsAt))

    return map
  }, [calls])

  const todayKey = dayKey(new Date())
  const selectedKey = dayKey(selected)
  const shownMonth = month.getMonth()

  return (
    <div className="overflow-hidden rounded-xl border border-hairline">
      <div className="grid grid-cols-7 border-b border-hairline bg-surface/40">
        {WEEKDAYS.map((label) => (
          <div
            key={label}
            className="border-l border-hairline py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-faint first:border-l-0"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((day, index) => {
          const key = dayKey(day)
          const dayCalls = byDay.get(key) ?? []
          const outside = day.getMonth() !== shownMonth

          return (
            /* The cell says how many; hovering it says which. */
            <DayHoverCard
              key={key}
              day={day}
              calls={dayCalls}
              className={cn(
                'relative min-h-[4.5rem] p-1.5',
                // Ruled like a table: every cell draws its own left and top
                // edge, and the panel's border closes the outside.
                'border-l border-t border-hairline',
                index % 7 === 0 && 'border-l-0',
                index < 7 && 'border-t-0',
                outside && 'bg-canvas/40',
                key === selectedKey && 'bg-accent/10'
              )}
            >
              {/* The whole cell opens the day, from behind what it says. */}
              <button
                type="button"
                onClick={() => onSelect(day)}
                aria-label={`Open ${dayLabel(day)}`}
                className="absolute inset-0 transition-colors hover:bg-surface/50"
              />

              {/* The date at one corner, how busy the day is at the other. */}
              <div className="relative flex items-start justify-between gap-1">
                <span
                  className={cn(
                    'pointer-events-none flex size-5 items-center justify-center rounded-full text-xs tabular-nums',
                    outside ? 'text-faint' : 'text-ink',
                    key === todayKey && 'bg-accent font-semibold text-white',
                    key === selectedKey && key !== todayKey && 'font-semibold text-accent-strong'
                  )}
                >
                  {day.getDate()}
                </span>

                {dayCalls.length > 0 && (
                  <span className="pointer-events-none rounded-md bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium leading-tight text-accent-strong">
                    {dayCalls.length} {dayCalls.length === 1 ? 'call' : 'calls'}
                  </span>
                )}
              </div>
            </DayHoverCard>
          )
        })}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Six weeks starting on the Monday on or before the first of the month.
 *
 * Fixed at 42 cells: a month that fits in five rows still gets six, which keeps
 * the layout from jumping.
 */
function buildGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)

  // getDay() is Sunday-based; shift so Monday is 0.
  const offset = (first.getDay() + 6) % 7
  const start = new Date(first)
  start.setDate(first.getDate() - offset)

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
}

/** Local `YYYY-MM-DD`, used as the identity of a day throughout the module. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dayLabel(day: Date): string {
  return day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}
