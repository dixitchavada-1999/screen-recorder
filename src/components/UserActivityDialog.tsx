import { useEffect, useState } from 'react'
import type {
  ActivityDay,
  ActivityInterval,
  SerializedError,
  TrackedPerson
} from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { toSerializedError, unwrap } from '@/services/ipc'
import { cn } from '@/utils/cn'
import { formatDuration } from '@/utils/format'

interface UserActivityDialogProps {
  person: TrackedPerson | null
  onClose: () => void
}

/** The rail the day is drawn against. Outside these hours nothing is plotted. */
const FIRST_HOUR = 8
const LAST_HOUR = 19

/**
 * One person's tracked day, for an administrator.
 *
 * The timeline comes first and the captures second, because the question being
 * asked is almost always "what did this day look like" rather than "show me
 * every picture". The strip is readable at a glance; the grid is there when the
 * answer needs more than a shape.
 */
export function UserActivityDialog({
  person,
  onClose
}: UserActivityDialogProps): React.JSX.Element | null {
  const [day, setDay] = useState(() => startOfToday())
  const [data, setData] = useState<ActivityDay | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<SerializedError | null>(null)

  /*
   * Reloads whenever the person or the date changes.
   *
   * `cancelled` guards the case where somebody arrows through several days
   * faster than the queries come back: without it a slow answer for Tuesday
   * could land after Wednesday's and overwrite it.
   */
  useEffect(() => {
    if (!person) return

    let cancelled = false
    setLoading(true)

    void (async () => {
      try {
        const from = new Date(day)
        const to = new Date(day)
        to.setDate(to.getDate() + 1)

        const result = await unwrap(
          window.api.tracking.day(person.id, from.toISOString(), to.toISOString())
        )

        if (cancelled) return
        setData(result)
        setError(null)
      } catch (caught) {
        if (cancelled) return
        setError(toSerializedError(caught))
        setData(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [person, day])

  if (!person) return null

  const isToday = day.toDateString() === new Date().toDateString()

  return (
    <Modal
      open={person !== null}
      title={person.name}
      description={person.email}
      onClose={onClose}
      className="w-[min(52rem,calc(100vw-3rem))]"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-5">

        {/* ------------------------------ Day picker ----------------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-ink">{dayLabel(day)}</p>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setDay(shift(day, -1))} aria-label="Previous day">‹</Button>
            <Button size="sm" variant="ghost" onClick={() => setDay(startOfToday())} disabled={isToday}>Today</Button>
            <Button size="sm" variant="ghost" onClick={() => setDay(shift(day, 1))} disabled={isToday} aria-label="Next day">›</Button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-record/40 bg-record/10 px-3 py-2.5">
            <p className="text-xs font-medium text-record-strong">{error.message}</p>
            {error.hint && <p className="mt-0.5 text-xs text-muted">{error.hint}</p>}
          </div>
        )}

        {loading && !data && <p className="text-xs text-faint">Loading…</p>}

        {data && data.segments.length === 0 && data.screenshots.length === 0 && (
          <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
            Nothing recorded on this day. Either the machine was off, or tracking was not
            switched on for this person yet.
          </p>
        )}

        {data && (
        <>
        {/* -------------------------------- Totals ------------------------- */}
        <div className="grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-3 lg:grid-cols-4">
          <Stat label="Machine on" value={formatDuration(data.trackedMs)} tone="default" />
          <Stat
            label="Activity"
            value={data.activePercent === null ? '—' : `${data.activePercent}%`}
            tone={data.activePercent === null ? 'muted' : 'positive'}
          />
          <Stat label="Active" value={formatDuration(data.activeMs)} tone="positive" />
          <Stat label="Idle" value={formatDuration(data.idleMs)} tone="muted" />
          <Stat
            label="Keys"
            value={countLabel(data.keyPresses, data.intervals)}
            tone={data.keyPresses > 0 ? 'default' : 'muted'}
          />
          <Stat
            label="Clicks"
            value={countLabel(data.mouseClicks, data.intervals)}
            tone={data.mouseClicks > 0 ? 'default' : 'muted'}
          />
          <Stat
            label="Screenshots"
            value={
              data.screenshots.length > 0
                ? String(data.screenshots.length)
                : person.screenshotsEnabled
                  ? 'None'
                  : 'Off'
            }
            tone={data.screenshots.length > 0 ? 'default' : 'muted'}
          />
        </div>

        {/* Only worth saying when it is actually the case. */}
        {data.intervals.length > 0 && data.intervals.every((i) => i.inputAvailable === false) && (
          <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
            This machine cannot count keys and clicks — either Input Monitoring was refused, or
            it runs a Wayland session, where no application can. The timeline and screenshots
            are unaffected.
          </p>
        )}

        {/* ------------------------------- Timeline ------------------------ */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-faint">Timeline</h3>

          <div className="rounded-xl border border-hairline bg-surface p-3">
            <div className="relative h-9 overflow-hidden rounded-md bg-canvas">
              {data.segments.map((segment) => {
                const left = position(segment.startedAt)
                const right = position(segment.endedAt)
                if (right <= left) return null

                return (
                  <span
                    key={segment.startedAt}
                    title={`${segment.state} · ${timeLabel(segment.startedAt)} – ${timeLabel(segment.endedAt)}`}
                    className={cn(
                      'absolute inset-y-0',
                      segment.state === 'active' ? 'bg-positive/70' : 'bg-warning/35'
                    )}
                    style={{ left: `${left}%`, width: `${right - left}%` }}
                  />
                )
              })}

              {/* Capture marks sit on top of the states they happened during. */}
              {data.screenshots.map((shot) => (
                  <span
                    key={shot.capturedAt}
                    title={`Screenshot · ${timeLabel(shot.capturedAt)}`}
                    className="absolute top-0 h-2 w-px bg-ink/50"
                    style={{ left: `${position(shot.capturedAt)}%` }}
                  />
              ))}
            </div>

            <div className="mt-1.5 flex justify-between font-mono text-[10px] text-faint">
              {hourTicks().map((hour) => (
                <span key={hour}>{String(hour).padStart(2, '0')}</span>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap gap-4 text-[11px] text-muted">
              <Key className="bg-positive/70" label="Active" />
              <Key className="bg-warning/35" label="Idle" />
              {data.screenshots.length > 0 && <Key className="bg-ink/50" label="Screenshot" />}
            </div>
          </div>
        </section>

        {/* ------------------------------- Windows ------------------------- */}
        {data.intervals.length > 0 && (
          /*
            Collapsed by default. The summary row above already answers the
            usual question; this is the detail somebody opens when the totals
            raise one, and a long table between the timeline and the
            screenshots pushes both out of reach the rest of the time.
          */
          <details className="group rounded-xl border border-hairline bg-surface">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
              <span className="text-xs font-medium uppercase tracking-wide text-faint">
                Activity track
              </span>
              <span className="text-[11px] text-faint">
                {data.intervals.length} {data.intervals.length === 1 ? 'window' : 'windows'}
              </span>
              <span
                aria-hidden="true"
                className="ml-auto font-mono text-[11px] text-faint transition-transform group-open:rotate-90"
              >
                ›
              </span>
            </summary>

            <div className="overflow-x-auto border-t border-hairline">
              <table className="w-full min-w-[26rem] text-xs">
                <thead>
                  <tr className="border-b border-hairline text-left text-faint">
                    <th className="px-3 py-2 font-medium">Window</th>
                    <th className="px-3 py-2 text-right font-medium">Keys</th>
                    <th className="px-3 py-2 text-right font-medium">Clicks</th>
                    <th className="px-3 py-2 text-right font-medium">Scrolls</th>
                    <th className="px-3 py-2 text-right font-medium">Active</th>
                    <th className="px-3 py-2 text-right font-medium">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {data.intervals.map((interval) => (
                    <tr key={interval.startedAt} className="border-b border-hairline/60 last:border-0">
                      <td className="px-3 py-1.5 font-mono text-muted">
                        {timeLabel(interval.startedAt)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">
                        {interval.inputAvailable === false ? '—' : interval.keyPresses}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">
                        {interval.inputAvailable === false ? '—' : interval.mouseClicks}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-ink">
                        {interval.inputAvailable === false ? '—' : interval.scrolls}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">
                        {Math.round(interval.activeSeconds / 60)}m
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums text-muted">
                        {sharePercent(interval)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        {/* ------------------------------ Screenshots ---------------------- */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-faint">Screenshots</h3>

          {data.screenshots.length === 0 ? (
            <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
              {person.screenshotsEnabled
                ? 'No captures on this day. Tracking may have been switched on partway through, or the machine was off.'
                : 'Screenshots are switched off for this person, so only their activity is recorded.'}
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {data.screenshots.map((shot) => (
                <li
                  key={shot.capturedAt}
                  className="overflow-hidden rounded-lg border border-hairline bg-surface"
                >
                  {/* Links are signed and expire; a tile that says so beats a
                      broken image icon. */}
                  {shot.url ? (
                    <a href={shot.url} target="_blank" rel="noreferrer">
                      <img
                        src={shot.url}
                        alt={`Screen at ${timeLabel(shot.capturedAt)}`}
                        loading="lazy"
                        className="aspect-video w-full bg-canvas object-cover"
                      />
                    </a>
                  ) : (
                    <div className="grid aspect-video place-items-center bg-canvas text-[10px] text-faint">
                      link expired
                    </div>
                  )}
                  <p className="px-2 py-1.5 font-mono text-[10px] text-muted">
                    {timeLabel(shot.capturedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        </>
        )}
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone: 'default' | 'muted' | 'positive'
}): React.JSX.Element {
  return (
    <div className="bg-surface px-3 py-2.5">
      <p className="text-[11px] text-faint">{label}</p>
      <p
        className={cn(
          'font-mono text-lg tabular-nums',
          tone === 'positive' && 'text-positive',
          tone === 'muted' && 'text-muted',
          tone === 'default' && 'text-ink'
        )}
      >
        {value}
      </p>
    </div>
  )
}

const Key = ({ className, label }: { className: string; label: string }): React.JSX.Element => (
  <span className="flex items-center gap-1.5">
    <span aria-hidden="true" className={cn('size-2 rounded-sm', className)} />
    {label}
  </span>
)

/**
 * How much of one window was spent at the keyboard.
 *
 * Each window is measured against its own length rather than the nominal
 * interval: a window cut short by a sleep, or stretched by one, would otherwise
 * read as far less busy than it was.
 */
function sharePercent(interval: ActivityInterval): string {
  const span = Date.parse(interval.endedAt) - Date.parse(interval.startedAt)
  if (span <= 0) return '—'
  return `${Math.min(100, Math.round((interval.activeSeconds * 1000 * 100) / span))}%`
}

/**
 * A total, or a dash where the machine could not measure.
 *
 * Zero and "unmeasurable" look identical as numbers and mean opposite things,
 * so a day with no usable counts says so rather than reporting nothing done.
 */
function countLabel(total: number, intervals: ActivityInterval[]): string {
  if (intervals.length === 0) return '—'
  if (intervals.every((interval) => interval.inputAvailable === false)) return 'n/a'
  return String(total)
}

/** Where an instant falls across the rail, as a percentage. */
function position(iso: string): number {
  const at = new Date(iso)
  const hours = at.getHours() + at.getMinutes() / 60
  const span = LAST_HOUR - FIRST_HOUR
  return Math.min(100, Math.max(0, ((hours - FIRST_HOUR) / span) * 100))
}

function hourTicks(): number[] {
  const ticks: number[] = []
  for (let hour = FIRST_HOUR; hour <= LAST_HOUR; hour += 2) ticks.push(hour)
  return ticks
}

const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const dayLabel = (day: Date): string =>
  day.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })

function startOfToday(): Date {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return today
}

function shift(day: Date, delta: number): Date {
  const next = new Date(day)
  next.setDate(next.getDate() + delta)
  return next
}
