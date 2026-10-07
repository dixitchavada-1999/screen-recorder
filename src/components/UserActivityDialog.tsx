import { useEffect, useState } from 'react'
import type {
  ActivityDay,
  ActivityInterval,
  AppUsageSummary,
  BrowserDaySummary,
  SerializedError,
  TrackedPerson
} from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ScreenshotViewer } from '@/components/ScreenshotViewer'
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
  /** The screenshot open full size, by its place in the day's list. */
  const [shotIndex, setShotIndex] = useState<number | null>(null)

  // Another person or another day means another set of pictures.
  useEffect(() => setShotIndex(null), [person, day])

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

        {/* ----------------------------- Applications ---------------------- */}
        <AppsSection apps={data.apps} enabled={person.trackingEnabled} />

        {/* ------------------------------- Browser ------------------------- */}
        <BrowserSection browser={data.browser} enabled={person.trackingEnabled} />

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
              {data.screenshots.map((shot, index) => (
                <li
                  key={shot.capturedAt}
                  className="overflow-hidden rounded-lg border border-hairline bg-surface"
                >
                  {/* Links are signed and expire; a tile that says so beats a
                      broken image icon. Opens here, not in the browser. */}
                  {shot.url ? (
                    <button
                      type="button"
                      onClick={() => setShotIndex(index)}
                      aria-label={`View the screenshot from ${timeLabel(shot.capturedAt)}`}
                      className="block w-full cursor-zoom-in transition-opacity hover:opacity-85"
                    >
                      <img
                        src={shot.url}
                        alt={`Screen at ${timeLabel(shot.capturedAt)}`}
                        loading="lazy"
                        className="aspect-video w-full bg-canvas object-cover"
                      />
                    </button>
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

      <ScreenshotViewer
        day={data}
        activityEnabled={person.trackingEnabled}
        index={shotIndex}
        onIndexChange={setShotIndex}
        onClose={() => setShotIndex(null)}
      />
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */

/** Applications shown before the rest are folded away. */
const APPS_SHOWN = 8

/**
 * Where the day's active time went, by application.
 *
 * A bar per application against the longest one, so the shape reads at a
 * glance; each row opens onto the window titles that made it up — in a browser
 * that is the pages, in an editor the files.
 */
function AppsSection({
  apps,
  enabled
}: {
  apps: AppUsageSummary[]
  enabled: boolean
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const total = apps.reduce((sum, item) => sum + item.ms, 0)
  const longest = apps[0]?.ms ?? 0
  const shown = showAll ? apps : apps.slice(0, APPS_SHOWN)

  /*
    Collapsed by default, like the activity track above it: the summary line
    already says how many applications and how long, and the list is the
    detail somebody opens when that raises a question.
  */
  return (
    <details className="group/apps rounded-xl border border-hairline bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wide text-faint">Applications</span>
        <span className="text-[11px] text-faint">
          {apps.length === 0
            ? 'none'
            : `${apps.length} ${apps.length === 1 ? 'application' : 'applications'} · ${formatDuration(total)} active`}
        </span>
        <span
          aria-hidden="true"
          className="ml-auto font-mono text-[11px] text-faint transition-transform group-open/apps:rotate-90"
        >
          ›
        </span>
      </summary>

      <div className="flex flex-col gap-2 border-t border-hairline">
        {apps.length === 0 ? (
          <p className="px-3 py-2.5 text-xs leading-relaxed text-muted">
            {enabled
              ? 'No applications recorded on this day. Only time at the keyboard is counted, so an idle or switched-off machine records none.'
              : 'Activity is switched off for this person. Turn on "Activity" in the list to record which applications they use.'}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-hairline/60">
            {shown.map((item) => (
              <li key={item.name}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2">
                    <span className="w-40 min-w-0 shrink-0 truncate text-xs text-ink" title={item.name}>
                      {item.name}
                    </span>
                    <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-canvas">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-positive/70"
                        style={{ width: `${longest > 0 ? Math.max(2, (item.ms / longest) * 100) : 0}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink">
                      {formatDuration(item.ms)}
                    </span>
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
                      {total > 0 ? `${Math.round((item.ms / total) * 100)}%` : '—'}
                    </span>
                    <span
                      aria-hidden="true"
                      className="font-mono text-[11px] text-faint transition-transform group-open:rotate-90"
                    >
                      ›
                    </span>
                  </summary>

                  {item.titles.length === 0 ? (
                    <p className="px-3 pb-2.5 text-[11px] text-faint">No window titles recorded.</p>
                  ) : (
                    <ul className="flex flex-col gap-1 px-3 pb-2.5">
                      {item.titles.map((entry) => (
                        <li key={entry.title} className="flex items-center gap-3 text-[11px]">
                          <span className="min-w-0 flex-1 truncate text-muted" title={entry.title}>
                            {entry.title}
                          </span>
                          <span className="shrink-0 font-mono tabular-nums text-faint">
                            {formatDuration(entry.seconds * 1000)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}

        {apps.length > APPS_SHOWN && (
          <Button
            size="sm"
            variant="ghost"
            className="mb-2 ml-1 self-start"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? 'Show fewer' : `Show all ${apps.length} applications`}
          </Button>
        )}
      </div>
    </details>
  )
}

/** Sites shown before the rest are folded away. */
const SITES_SHOWN = 8

/** Searches shown before the rest are folded away. */
const SEARCHES_SHOWN = 15

/**
 * Where the day's browsing went, from the browser extension.
 *
 * Sites the same way as applications — a bar each, opening onto the pages —
 * and then the searches in the order they were made, because "what were they
 * looking for" is a different question from "where did the time go".
 */
function BrowserSection({
  browser,
  enabled
}: {
  browser: BrowserDaySummary
  enabled: boolean
}): React.JSX.Element {
  const [allSites, setAllSites] = useState(false)
  const [allSearches, setAllSearches] = useState(false)

  const { sites, searches } = browser
  const total = sites.reduce((sum, site) => sum + site.ms, 0)
  const longest = sites[0]?.ms ?? 0
  const shownSites = allSites ? sites : sites.slice(0, SITES_SHOWN)
  const shownSearches = allSearches ? searches : searches.slice(0, SEARCHES_SHOWN)

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-faint">Browser</h3>
        {sites.length > 0 && (
          <span className="font-mono text-[11px] text-faint">
            {formatDuration(total)} · {searches.length}{' '}
            {searches.length === 1 ? 'search' : 'searches'}
          </span>
        )}
      </div>

      {sites.length === 0 ? (
        <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
          {enabled
            ? 'No browsing recorded on this day. The browser extension has to be installed in Chrome or Edge, and only time at the keyboard is counted.'
            : 'Activity is switched off for this person. Turn on "Activity" in the list to record browser tabs and searches.'}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-hairline/60 rounded-xl border border-hairline bg-surface">
            {shownSites.map((site) => (
              <li key={site.domain}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2">
                    <span
                      className={cn(
                        'w-40 min-w-0 shrink-0 truncate text-xs',
                        site.excluded ? 'text-faint' : 'text-ink'
                      )}
                      title={site.domain}
                    >
                      {site.domain === 'newtab' ? 'New tab' : site.domain}
                    </span>
                    <span className="relative h-2 flex-1 overflow-hidden rounded-full bg-canvas">
                      <span
                        className={cn(
                          'absolute inset-y-0 left-0 rounded-full',
                          site.excluded ? 'bg-faint/50' : 'bg-accent/70'
                        )}
                        style={{ width: `${longest > 0 ? Math.max(2, (site.ms / longest) * 100) : 0}%` }}
                      />
                    </span>
                    <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink">
                      {formatDuration(site.ms)}
                    </span>
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-faint">
                      {total > 0 ? `${Math.round((site.ms / total) * 100)}%` : '—'}
                    </span>
                    <span
                      aria-hidden="true"
                      className="font-mono text-[11px] text-faint transition-transform group-open:rotate-90"
                    >
                      ›
                    </span>
                  </summary>

                  {site.excluded ? (
                    <p className="px-3 pb-2.5 text-[11px] text-faint">
                      On the excluded list: only the time spent is recorded.
                    </p>
                  ) : site.pages.length === 0 ? (
                    <p className="px-3 pb-2.5 text-[11px] text-faint">No pages recorded.</p>
                  ) : (
                    <ul className="flex flex-col gap-1 px-3 pb-2.5">
                      {site.pages.map((page) => (
                        <li
                          key={page.url ?? page.title ?? ''}
                          className="flex items-center gap-3 text-[11px]"
                        >
                          <span
                            className="min-w-0 flex-1 truncate text-muted"
                            title={page.url ?? page.title ?? ''}
                          >
                            {page.title ?? page.url ?? '(untitled)'}
                          </span>
                          <span className="shrink-0 font-mono tabular-nums text-faint">
                            {formatDuration(page.ms)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </li>
            ))}
          </ul>

          {sites.length > SITES_SHOWN && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setAllSites(!allSites)}
            >
              {allSites ? 'Show fewer' : `Show all ${sites.length} sites`}
            </Button>
          )}
        </>
      )}

      {searches.length > 0 && (
        <div className="flex flex-col gap-1 rounded-xl border border-hairline bg-surface px-3 py-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Searches</p>
          <ul className="flex flex-col gap-1">
            {shownSearches.map((search) => (
              <li key={`${search.at}-${search.query}`} className="flex items-center gap-3 text-[11px]">
                <span className="w-12 shrink-0 font-mono tabular-nums text-faint">
                  {timeLabel(search.at)}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink" title={search.query}>
                  {search.query}
                </span>
                <span className="shrink-0 truncate text-faint">{search.domain}</span>
              </li>
            ))}
          </ul>
          {searches.length > SEARCHES_SHOWN && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() => setAllSearches(!allSearches)}
            >
              {allSearches ? 'Show fewer' : `Show all ${searches.length} searches`}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

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
