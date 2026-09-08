import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/utils/cn'

interface DatePickerProps {
  id?: string
  /** `YYYY-MM-DD`, or empty for no date. Local, never UTC. */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
}

/**
 * A date, chosen from a calendar the application drew itself.
 *
 * `<input type="date">` would be less code and is what this replaces. It is
 * also a hole in the middle of a dark dialog: the picker is the operating
 * system's, painted in the system's own colours, at the system's own size, with
 * a native scroll wheel for hours nobody asked for. On Windows it arrives white.
 *
 * The calendar floats over the form rather than pushing it down. In the flow it
 * sat inside one cell of a two-column row, which stretched the whole row and
 * left a dead rectangle beside it — and moved everything below out from under
 * the cursor on the way.
 *
 * `absolute`, and specifically not `fixed`. Every panel in this app is a `Card`,
 * and `Card` carries a `backdrop-blur`; a `backdrop-filter` makes an element the
 * containing block for its fixed-position descendants, so a fixed popover
 * measured itself from the panel's corner instead of the window's and left the
 * screen entirely. The drag overlay on the task board hit the same wall.
 *
 * Absolute has no such problem: its containing block is the wrapper right here,
 * which no ancestor's styling can move. Where the dialog is too short for it,
 * the dialog scrolls.
 */
export function DatePicker({
  id,
  value,
  onChange,
  disabled,
  placeholder = 'No due date'
}: DatePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState(() => firstOfMonth(parse(value) ?? new Date()))

  const wrapper = useRef<HTMLDivElement>(null)
  const calendar = useRef<HTMLDivElement>(null)

  const selected = parse(value)

  // Opening on the month of whatever is already chosen — not on this month,
  // which for a date set last quarter means arriving three clicks away from it.
  useEffect(() => {
    if (open) setMonth(firstOfMonth(parse(value) ?? new Date()))
  }, [open, value])

  /*
   * A calendar that opens below the fold looks like one that did not open.
   * `nearest` scrolls only when it has to, so one already in view does not make
   * the dialog jump.
   */
  useLayoutEffect(() => {
    if (open) calendar.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  useEffect(() => {
    if (!open) return

    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (wrapper.current?.contains(target)) return
      setOpen(false)
    }

    const onKey = (event: KeyboardEvent): void => {
      // Escape belongs to the calendar while it is down. Left alone, the
      // dialog's own handler would read one press as "throw all of this away".
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey, true)

    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const pick = (day: Date): void => {
    onChange(format(day))
    setOpen(false)
  }

  const todayKey = format(new Date())

  return (
    <div ref={wrapper} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2',
          'text-left text-sm transition-colors hover:border-faint',
          open && 'border-accent',
          selected ? 'text-ink' : 'text-faint',
          disabled && 'cursor-default opacity-60 hover:border-hairline'
        )}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4 shrink-0 text-faint">
          <path d="M6 2v2H4.5A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5v-10A1.5 1.5 0 0 0 15.5 4H14V2h-2v2H8V2H6zM4.5 8h11v7.5h-11V8z" />
        </svg>

        <span className="min-w-0 flex-1 truncate">{selected ? readable(selected) : placeholder}</span>

        {/* Clearing is the other half of choosing, and it belongs on the field. */}
        {selected && !disabled && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear the due date"
            onClick={(event) => {
              event.stopPropagation()
              onChange('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                event.stopPropagation()
                onChange('')
              }
            }}
            className="grid size-5 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-record/10 hover:text-record-strong"
          >
            <span aria-hidden="true" className="text-sm leading-none">
              ×
            </span>
          </span>
        )}
      </button>

      {open && (
        <div
          ref={calendar}
          className="absolute left-0 top-full z-30 mt-2 w-64 rounded-2xl border border-hairline bg-canvas-elevated p-3 shadow-2xl shadow-black/50"
        >
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous month"
              onClick={() => setMonth(shiftMonth(month, -1))}
              className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
                <path d="M13 4L7 10l6 6V4z" />
              </svg>
            </button>

            <span className="min-w-0 flex-1 text-center text-sm font-medium text-ink">
              {month.toLocaleDateString([], { month: 'long', year: 'numeric' })}
            </span>

            <button
              type="button"
              aria-label="Next month"
              onClick={() => setMonth(shiftMonth(month, 1))}
              className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
                <path d="M7 4l6 6-6 6V4z" />
              </svg>
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-0.5">
            {WEEKDAYS.map((day) => (
              <span key={day} className="text-center text-[10px] font-medium uppercase text-faint">
                {day}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {gridOf(month).map((day) => {
              const key = format(day)
              const outside = day.getMonth() !== month.getMonth()

              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => pick(day)}
                  className={cn(
                    'grid h-8 place-items-center rounded-lg text-xs transition-colors',
                    key === value
                      ? 'bg-accent font-medium text-white'
                      : key === todayKey
                        ? 'text-accent-strong ring-1 ring-inset ring-accent/50 hover:bg-surface'
                        : outside
                          ? 'text-faint hover:bg-surface hover:text-muted'
                          : 'text-ink hover:bg-surface'
                  )}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-hairline pt-2">
            <button
              type="button"
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className="rounded-lg px-2 py-1 text-[11px] text-muted transition-colors hover:text-ink"
            >
              Clear
            </button>

            <button
              type="button"
              onClick={() => pick(new Date())}
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-accent-strong transition-colors hover:text-accent"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const

/**
 * `YYYY-MM-DD` from a date, in local time.
 *
 * Not `toISOString().slice(0, 10)`, which looks like this and is not: that is
 * UTC, so an evening in India comes back as the day before.
 */
export function format(day: Date): string {
  const month = `${day.getMonth() + 1}`.padStart(2, '0')
  const date = `${day.getDate()}`.padStart(2, '0')
  return `${day.getFullYear()}-${month}-${date}`
}

function parse(value: string): Date | null {
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

function readable(day: Date): string {
  return day.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

function firstOfMonth(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), 1)
}

function shiftMonth(month: Date, by: number): Date {
  return new Date(month.getFullYear(), month.getMonth() + by, 1)
}

/** Six weeks from the Sunday on or before the first, so the grid never reflows. */
function gridOf(month: Date): Date[] {
  const start = new Date(month)
  start.setDate(1 - start.getDay())

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() + index)
    return day
  })
}
