import type { ScheduledCall } from '@shared/types'
import { CallStatusBadge } from '@/components/CallStatusBadge'
import { HoverCard } from '@/components/ui/HoverCard'
import { cn } from '@/utils/cn'

/**
 * Everything about one call, on hover.
 *
 * A tile in the week grid has room for a title and little else. This is where
 * the rest of it goes: when it starts, who it is for, what the notes say, and
 * which calendar it came from.
 */
export function CallHoverCard({
  call,
  className,
  style,
  children
}: {
  call: ScheduledCall
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <HoverCard className={className} style={style} card={<CallDetail call={call} />}>
      {children}
    </HoverCard>
  )
}

/**
 * A whole day's calls, on hover, as a table.
 *
 * A month cell has room for a line or two per call, and drops the rest. This is
 * the day laid out in full - a column each for the time, the call, who it is
 * for and what the notes say, so a busy day can be read down rather than
 * deciphered.
 */
export function DayHoverCard({
  day,
  calls,
  className,
  children
}: {
  day: Date
  /** This day's calls, in the order they should be read. */
  calls: ScheduledCall[]
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  // A column nobody has anything to put in is a column of empty cells.
  const anyNotes = calls.some((call) => call.notes)

  return (
    <HoverCard
      className={className}
      wide
      // An empty day has nothing to say, and a card saying "nothing" on every
      // blank square of the month would be in the way rather than useful.
      disabled={calls.length === 0}
      card={
        <>
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
            {dayLabel(day)}
          </p>

          <table className="mt-2 w-full border-collapse text-left text-[11px] leading-snug">
            <thead>
              <tr className="text-faint">
                <th className="pb-1 pr-4 font-medium">Time</th>
                <th className="pb-1 pr-4 font-medium">Call</th>
                <th className="pb-1 pr-4 font-medium">For</th>
                {anyNotes && <th className="pb-1 font-medium">Note</th>}
              </tr>
            </thead>

            <tbody>
              {calls.map((call) => (
                <tr key={call.id} className="border-t border-hairline align-top">
                  <td className="whitespace-nowrap py-1 pr-4 font-mono text-muted">
                    {timeLabel(call.startsAt)}
                  </td>

                  <td className="py-1 pr-4">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'text-ink',
                          call.status === 'cancelled' && 'text-faint line-through'
                        )}
                      >
                        {call.title}
                      </span>
                      <CallStatusBadge status={call.status} />
                    </span>
                  </td>

                  <td className="py-1 pr-4 text-muted">
                    {call.assignees.map((person) => person.name).join(', ') || '-'}
                  </td>

                  {anyNotes && (
                    <td className="whitespace-pre-wrap break-words py-1 text-muted">
                      {call.notes || '-'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      }
    >
      {children}
    </HoverCard>
  )
}

/* -------------------------------------------------------------------------- */

function CallDetail({ call }: { call: ScheduledCall }): React.JSX.Element {
  const people = call.assignees.map((person) => person.name).join(', ')

  return (
    <>
      {/* Title and time on one line: they are the two things being looked up,
          and stacking them would make the card taller for no gain. */}
      <div className="flex items-baseline gap-6">
        <span
          className={cn(
            'min-w-0 flex-1 text-sm font-medium leading-snug text-ink',
            call.status === 'cancelled' && 'text-faint line-through'
          )}
        >
          {call.title}
        </span>
        <CallStatusBadge status={call.status} />
        <span className="shrink-0 font-mono text-[11px] text-muted">
          {timeLabel(call.startsAt)}
        </span>
      </div>

      {/*
        Everybody, rather than the "Raj +2" the tile had room for. The tile
        already said that much; this is where somebody comes to find out who the
        other two are.
      */}
      {people && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          <span className="text-faint">For: </span>
          {people}
        </p>
      )}

      {call.notes && (
        <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug text-muted">
          <span className="text-faint">Note: </span>
          {call.notes}
        </p>
      )}

      {/* Which calendar it was imported from, when it was imported. */}
      {call.googleAccountEmail && (
        <p className="mt-1 truncate text-[11px] leading-snug text-muted">
          <span className="text-faint">Calendar: </span>
          {call.googleAccountEmail}
        </p>
      )}
    </>
  )
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dayLabel(day: Date): string {
  return day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}
