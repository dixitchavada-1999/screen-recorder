import { useEffect, useMemo, useRef } from 'react'
import type { ScheduledCall } from '@shared/types'
import { CallHoverCard } from '@/components/CallHoverCard'
import { CallSourceDot } from '@/components/CallSourceDot'
import { dayKey } from '@/components/CallCalendar'
import { cn } from '@/utils/cn'

interface CallWeekViewProps {
  /** Any day inside the week to show. */
  anchor: Date
  calls: ScheduledCall[]
  busy: boolean
  /** Colour per connected Google account, for the source dot. */
  accountColors: Map<string, string>
  onOpen: (call: ScheduledCall) => void
  /** Clicking a day heading opens that day. */
  onSelectDay: (day: Date) => void
  onSchedule: (start: Date) => void
}

/** Pixels per hour. Tall enough that a half-hour call is still a real target. */
const HOUR_HEIGHT = 48

/** Where the grid scrolls to on open — the working day, not midnight. */
const OPENING_HOUR = 8

/** Shortest a call can be drawn, whatever its duration says. */
const MIN_EVENT_HEIGHT = 18

/**
 * The week as a time grid.
 *
 * Hours down the side, seven columns across, and every call drawn where it
 * actually falls — the shape people already know from every calendar they use,
 * and the one that answers "when am I free" without reading a single row.
 *
 * Overlapping calls are split into side-by-side columns rather than stacked, so
 * a double booking is visible as one instead of hiding behind whichever was
 * drawn last.
 */
export function CallWeekView({
  anchor,
  calls,
  busy,
  accountColors,
  onOpen,
  onSelectDay,
  onSchedule
}: CallWeekViewProps): React.JSX.Element {
  const days = useMemo(() => weekOf(anchor), [anchor])
  const scroller = useRef<HTMLDivElement>(null)

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduledCall[]>()

    for (const call of calls) {
      const key = dayKey(new Date(call.startsAt))
      const existing = map.get(key)
      if (existing) existing.push(call)
      else map.set(key, [call])
    }

    return map
  }, [calls])

  /*
   * Opening on midnight would put an empty six hours in front of everybody.
   *
   * Deferred a frame: on mount the grid has not been laid out yet, so setting
   * `scrollTop` immediately is clamped to zero by a container that is still
   * zero pixels tall — the scroll silently does nothing.
   */
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (scroller.current) scroller.current.scrollTop = OPENING_HOUR * HOUR_HEIGHT
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const todayKey = dayKey(new Date())

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-surface/40">
      {/* ------------------------------- Headings ----------------------------- */}
      <div className="flex border-b border-hairline">
        {/* Matches the hour gutter below so the columns line up. */}
        <div className="w-14 shrink-0" />

        {days.map((day) => {
          const key = dayKey(day)
          const isToday = key === todayKey

          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelectDay(day)}
              title="Open this day"
              className="flex flex-1 basis-0 flex-col items-center gap-0.5 border-l border-hairline py-2 transition-colors hover:bg-surface"
            >
              <span className="text-[10px] uppercase tracking-wide text-faint">
                {day.toLocaleDateString([], { weekday: 'short' })}
              </span>
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full text-xs font-medium',
                  isToday ? 'bg-accent text-white' : 'text-ink'
                )}
              >
                {day.getDate()}
              </span>
            </button>
          )
        })}
      </div>

      {/* --------------------------------- Grid ------------------------------- */}
      {/*
        Grows with the window rather than sitting at a fixed height: maximised,
        the old ceiling left the bottom half of the screen empty. Clamped at
        both ends so a short window still shows a usable stretch of the day and
        a very tall one does not stretch the hours apart.
      */}
      <div
        ref={scroller}
        className="h-[clamp(18rem,calc(100vh-21rem),52rem)] overflow-y-auto"
      >
        <div className="flex" style={{ height: 24 * HOUR_HEIGHT }}>
          {/* Hour labels. Sat on the line they name, like every other calendar. */}
          <div className="w-14 shrink-0">
            {HOURS.map((hour) => (
              <div
                key={hour}
                style={{ height: HOUR_HEIGHT }}
                className="relative pr-2 text-right"
              >
                {hour > 0 && (
                  <span className="absolute right-2 -top-1.5 font-mono text-[10px] text-faint">
                    {hourLabel(hour)}
                  </span>
                )}
              </div>
            ))}
          </div>

          {days.map((day) => (
            <DayColumn
              key={dayKey(day)}
              day={day}
              calls={byDay.get(dayKey(day)) ?? []}
              busy={busy}
              accountColors={accountColors}
              onOpen={onOpen}
              onSchedule={onSchedule}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*                                 One column                                 */
/* -------------------------------------------------------------------------- */

function DayColumn({
  day,
  calls,
  busy,
  accountColors,
  onOpen,
  onSchedule
}: {
  day: Date
  calls: ScheduledCall[]
  busy: boolean
  accountColors: Map<string, string>
  onOpen: (call: ScheduledCall) => void
  onSchedule: (start: Date) => void
}): React.JSX.Element {
  const laid = useMemo(() => layOut(calls), [calls])

  return (
    <div className="relative flex-1 basis-0 border-l border-hairline">
      {/* Hour lines, and the empty space that schedules a call when clicked. */}
      {HOURS.map((hour) => (
        <button
          key={hour}
          type="button"
          disabled={busy}
          onClick={() => onSchedule(at(day, hour))}
          title={`Schedule at ${hourLabel(hour)}`}
          style={{ height: HOUR_HEIGHT }}
          className="block w-full border-t border-hairline/50 transition-colors first:border-t-0 hover:bg-accent/5 disabled:cursor-not-allowed"
        />
      ))}

      {laid.map(({ call, column, columns }) => {
        const start = new Date(call.startsAt)
        const top = (start.getHours() + start.getMinutes() / 60) * HOUR_HEIGHT
        const height = Math.max(
          MIN_EVENT_HEIGHT,
          (call.durationMinutes / 60) * HOUR_HEIGHT
        )

        // Side by side within whatever cluster this call belongs to.
        const width = 100 / columns
        const left = column * width

        return (
          /*
            Hovering is where somebody goes when the tile did not tell them
            enough, so the whole call - everybody on it, the notes, the
            calendar it came from - goes on a card rather than into a `title`.
          */
          <CallHoverCard
            key={call.id}
            call={call}
            className="absolute"
            style={{
              top,
              height,
              left: `calc(${left}% + 2px)`,
              width: `calc(${width}% - 4px)`
            }}
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => onOpen(call)}
              className={cn(
                'h-full w-full overflow-hidden rounded-md border-l-2 px-1.5 py-0.5 text-left',
                'bg-accent/20 transition-colors hover:bg-accent/30 disabled:opacity-60',
                call.status === 'cancelled'
                  ? 'border-l-faint bg-surface'
                  : call.status === 'completed'
                    ? 'border-l-positive bg-positive/15'
                    : call.status === 'missed'
                      ? 'border-l-warning bg-warning/15'
                      : 'border-l-accent'
              )}
            >
              <span className="flex items-center gap-1">
                <CallSourceDot call={call} colors={accountColors} />
                <span
                  className={cn(
                    'truncate text-[11px] font-medium leading-tight text-ink',
                    call.status === 'cancelled' && 'text-faint line-through'
                  )}
                >
                  {call.title}
                </span>
              </span>

              {/* Only when there is room for it; a 30-minute box is one line. */}
              {height >= 34 && (
                <span className="block truncate font-mono text-[10px] text-muted">
                  {timeLabel(call.startsAt)}
                </span>
              )}

              {/*
                Who it is for, when the box is tall enough and the answer is not
                simply "you". Repeating your own name down a week of your own
                calendar would be noise; "Raj +2" is the thing worth the line.
              */}
              {height >= 50 &&
                call.assignees.length > 0 &&
                !(call.assignedToMe && call.assignees.length === 1) && (
                  <span className="block truncate text-[10px] leading-tight text-muted">
                    For {call.assignees[0]?.name}
                    {call.assignees.length > 1 && ` +${call.assignees.length - 1}`}
                  </span>
                )}
            </button>
          </CallHoverCard>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*                                   Layout                                   */
/* -------------------------------------------------------------------------- */

interface Placed {
  call: ScheduledCall
  column: number
  columns: number
}

/**
 * Splits overlapping calls into side-by-side columns.
 *
 * Walks the day in order, keeping a cluster of calls that overlap each other.
 * Every call in a cluster is drawn at the same width, so a cluster of two takes
 * half the column each and the pair reads as a clash rather than as one call
 * with something hidden underneath.
 */
function layOut(calls: ScheduledCall[]): Placed[] {
  const ordered = [...calls].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  const placed: Placed[] = []

  let cluster: ScheduledCall[] = []
  let clusterEnd = 0

  const flush = (): void => {
    // Column assignment inside the cluster: the first free one, which keeps
    // non-overlapping neighbours from being pushed needlessly narrow.
    const columnEnds: number[] = []

    for (const call of cluster) {
      const start = Date.parse(call.startsAt)
      const end = start + call.durationMinutes * 60_000

      let column = columnEnds.findIndex((freeAt) => freeAt <= start)
      if (column === -1) column = columnEnds.length

      columnEnds[column] = end
      placed.push({ call, column, columns: 0 })
    }

    // Every call in the cluster shares the widest count, so the boxes line up.
    const width = Math.max(1, columnEnds.length)
    for (let index = placed.length - cluster.length; index < placed.length; index += 1) {
      placed[index]!.columns = width
    }

    cluster = []
  }

  for (const call of ordered) {
    const start = Date.parse(call.startsAt)
    const end = start + call.durationMinutes * 60_000

    if (cluster.length > 0 && start >= clusterEnd) flush()

    cluster.push(call)
    clusterEnd = Math.max(clusterEnd, end)
  }

  if (cluster.length > 0) flush()
  return placed
}

/* -------------------------------------------------------------------------- */

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

/**
 * The seven days of the week the anchor falls in, Monday first.
 *
 * Monday rather than Sunday because this is a working calendar, and a week that
 * splits the weekend across two screens is harder to read for it.
 */
export function weekOf(anchor: Date): Date[] {
  const start = startOfWeek(anchor)

  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
}

export function startOfWeek(anchor: Date): Date {
  const start = new Date(anchor)
  start.setHours(0, 0, 0, 0)

  // getDay() is 0 for Sunday, which has to wrap round to the end of the week.
  const offset = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - offset)
  return start
}

function at(day: Date, hour: number): Date {
  const when = new Date(day)
  when.setHours(hour, 0, 0, 0)
  return when
}

const hourLabel = (hour: number): string =>
  new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' })

const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
