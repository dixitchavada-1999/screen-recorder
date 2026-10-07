import { useEffect, useMemo, useRef } from 'react'
import type { ActivityDay, ActivityScreenshot } from '@shared/types'
import {
  appStretchesBetween,
  browserVisitsBetween,
  intervalsBetween,
  segmentsBetween,
  stateTotals,
  summariseApps,
  summariseBrowser
} from '@shared/activity-summary'
import { cn } from '@/utils/cn'

interface ScreenshotViewerProps {
  /** The whole day, so the minutes before a capture can be told apart. */
  day: ActivityDay | null
  /** Whether Activity is switched on for the person; explains an empty panel. */
  activityEnabled: boolean
  /** The capture on screen, or null when the viewer is closed. */
  index: number | null
  onIndexChange: (index: number) => void
  onClose: () => void
}

/** A window longer than this is not "the minutes before" anything. */
const MAX_WINDOW_MS = 60 * 60_000

/**
 * A day's screenshots, one at a time and full size, with what was happening.
 *
 * The picture on the left; on the right, the minutes leading up to it — from
 * the previous capture to this one: how much of it was at the keyboard, the
 * key and click counts, the applications in front and the sites visited. The
 * screen shows the end of that stretch, the panel how it got there.
 *
 * Its own native `<dialog>` rather than `Modal`: it opens on top of the day's
 * dialog, and the browser stacks the two and sends Escape to the top one only.
 */
export function ScreenshotViewer({
  day,
  activityEnabled,
  index,
  onIndexChange,
  onClose
}: ScreenshotViewerProps): React.JSX.Element | null {
  const ref = useRef<HTMLDialogElement>(null)
  const shots = useMemo(() => day?.screenshots ?? [], [day])
  const open = index !== null && index >= 0 && index < shots.length

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    else if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    const handleCancel = (event: Event): void => {
      event.preventDefault()
      onClose()
    }

    dialog.addEventListener('cancel', handleCancel)
    return () => dialog.removeEventListener('cancel', handleCancel)
  }, [onClose])

  /** Where in the day the open capture is; meaningless while closed. */
  const position = open ? index : 0
  const previous = open && position > 0 ? position - 1 : null
  const next = open && position < shots.length - 1 ? position + 1 : null

  useEffect(() => {
    if (!open) return

    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft' && previous !== null) {
        event.preventDefault()
        onIndexChange(previous)
      } else if (event.key === 'ArrowRight' && next !== null) {
        event.preventDefault()
        onIndexChange(next)
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, previous, next, onIndexChange])

  const shot = open ? shots[position] : null
  const window_ = useMemo(
    () => (open && shot ? captureWindow(shots, position) : null),
    [open, shot, shots, position]
  )

  return (
    <dialog
      ref={ref}
      aria-label="Screenshot"
      onClick={(event) => {
        // The backdrop and the empty space around the content both close it.
        if (event.target === event.currentTarget || (event.target as HTMLElement).dataset.backdrop) {
          onClose()
        }
      }}
      className="m-0 h-screen max-h-none w-screen max-w-none bg-transparent p-0 text-ink backdrop:bg-black/85"
    >
      {shot && window_ && (
        <div data-backdrop="true" className="flex h-full w-full flex-col gap-3 p-5">
          {/* Top bar: when it was taken, where in the day, and the way out. */}
          <div className="flex items-center justify-between gap-4 text-xs">
            <span className="font-mono text-white/80">
              {timeLabel(shot.capturedAt)}
              <span className="ml-3 text-white/50">
                {position + 1} of {shots.length}
              </span>
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-5">
                <path d="M6.3 5l3.7 3.7L13.7 5l1.3 1.3L11.3 10l3.7 3.7-1.3 1.3L10 11.3 6.3 15 5 13.7 8.7 10 5 6.3 6.3 5z" />
              </svg>
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
            {/* --------------------------- The picture --------------------------- */}
            <div
              data-backdrop="true"
              className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center"
            >
              <StepButton
                side="left"
                disabled={previous === null}
                onClick={() => previous !== null && onIndexChange(previous)}
              />

              {shot.url ? (
                <img
                  key={shot.capturedAt}
                  src={shot.url}
                  alt={`Screen at ${timeLabel(shot.capturedAt)}`}
                  className="max-h-full max-w-full rounded-lg object-contain shadow-2xl shadow-black/60"
                />
              ) : (
                // Signed links expire after an hour; reopening the day signs them again.
                <div className="grid aspect-video w-full max-w-3xl place-items-center rounded-lg border border-white/10 bg-white/5 text-sm text-white/60">
                  This link has expired — close and reopen the day to see it.
                </div>
              )}

              <StepButton
                side="right"
                disabled={next === null}
                onClick={() => next !== null && onIndexChange(next)}
              />
            </div>

            {/* --------------------- What led up to it --------------------- */}
            {day && (
              <ActivityPanel
                day={day}
                from={window_.from}
                to={window_.to}
                activityEnabled={activityEnabled}
              />
            )}
          </div>

          {/* Neighbours, so stepping through does not wait on each download. */}
          <div className="hidden" aria-hidden="true">
            {[previous, next].map((neighbour) =>
              neighbour !== null && shots[neighbour]?.url ? (
                <img key={neighbour} src={shots[neighbour].url ?? undefined} alt="" />
              ) : null
            )}
          </div>
        </div>
      )}
    </dialog>
  )
}

/* -------------------------------------------------------------------------- */
/*                                   Window                                   */
/* -------------------------------------------------------------------------- */

/**
 * The stretch a capture stands for: from the one before it to this one.
 *
 * The first of the day has no "before", so it takes the day's usual gap. A
 * long gap — the machine was off, tracking was paused — is cut to the usual
 * one too, so a capture after lunch does not claim the whole morning.
 */
function captureWindow(shots: ActivityScreenshot[], position: number): { from: number; to: number } {
  const to = Date.parse(shots[position]!.capturedAt)
  const usual = usualGap(shots)
  const previousAt = position > 0 ? Date.parse(shots[position - 1]!.capturedAt) : -Infinity

  return { from: Math.max(previousAt, to - Math.min(usual * 1.5, MAX_WINDOW_MS)), to }
}

/** The middle gap between the day's captures, or ten minutes with too few to tell. */
function usualGap(shots: ActivityScreenshot[]): number {
  const gaps: number[] = []
  for (let i = 1; i < shots.length; i += 1) {
    const gap = Date.parse(shots[i]!.capturedAt) - Date.parse(shots[i - 1]!.capturedAt)
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return 10 * 60_000
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)]!
}

/* -------------------------------------------------------------------------- */
/*                                    Panel                                   */
/* -------------------------------------------------------------------------- */

function ActivityPanel({
  day,
  from,
  to,
  activityEnabled
}: {
  day: ActivityDay
  from: number
  to: number
  activityEnabled: boolean
}): React.JSX.Element {
  const summary = useMemo(() => {
    const segments = segmentsBetween(day.segments, from, to)
    const intervals = intervalsBetween(day.intervals, from, to)

    return {
      states: stateTotals(segments),
      intervals,
      keys: intervals.reduce((sum, i) => sum + i.keyPresses, 0),
      clicks: intervals.reduce((sum, i) => sum + i.mouseClicks, 0),
      scrolls: intervals.reduce((sum, i) => sum + i.scrolls, 0),
      activeSeconds: intervals.reduce((sum, i) => sum + i.activeSeconds, 0),
      measuredMs: intervals.reduce((sum, i) => sum + (Date.parse(i.endedAt) - Date.parse(i.startedAt)), 0),
      apps: summariseApps(appStretchesBetween(day.appStretches, from, to)),
      browser: summariseBrowser(browserVisitsBetween(day.browserVisits, from, to))
    }
  }, [day, from, to])

  const { states, intervals, apps, browser } = summary
  const recorded = states.activeMs + states.idleMs
  const noInput = intervals.length > 0 && intervals.every((i) => i.inputAvailable === false)
  const nothing =
    recorded === 0 && intervals.length === 0 && apps.length === 0 && browser.sites.length === 0

  const activePercent =
    summary.measuredMs > 0
      ? Math.min(100, Math.round((summary.activeSeconds * 1000 * 100) / summary.measuredMs))
      : recorded > 0
        ? Math.round((states.activeMs * 100) / recorded)
        : null

  const longestApp = apps[0]?.ms ?? 0
  const longestSite = browser.sites[0]?.ms ?? 0

  return (
    <aside className="flex max-h-[40vh] w-full shrink-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-white/10 bg-canvas-elevated p-4 lg:max-h-none lg:w-[24rem]">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Activity in this window</p>
        <p className="mt-0.5 font-mono text-sm text-ink">
          {timeLabel(new Date(from).toISOString())} – {timeLabel(new Date(to).toISOString())}
          <span className="ml-2 text-xs text-faint">{duration(to - from)}</span>
        </p>
      </div>

      {nothing ? (
        <p className="rounded-xl border border-hairline bg-surface px-3 py-2.5 text-xs leading-relaxed text-muted">
          {activityEnabled
            ? 'Nothing recorded in these minutes. The machine may have been asleep, or the numbers have not been uploaded yet.'
            : 'Activity is switched off for this person, so only the screenshot is recorded.'}
        </p>
      ) : (
        <>
          {/* ------------------------- Active and idle ------------------------- */}
          <section className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <h4 className="text-xs font-medium text-ink">Time</h4>
              {activePercent !== null && (
                <span className="font-mono text-xs text-positive">{activePercent}% active</span>
              )}
            </div>
            {recorded > 0 && (
              <div className="flex h-2 overflow-hidden rounded-full bg-canvas">
                <span className="bg-positive/70" style={{ width: `${(states.activeMs / recorded) * 100}%` }} />
                <span className="bg-warning/35" style={{ width: `${(states.idleMs / recorded) * 100}%` }} />
              </div>
            )}
            <div className="flex gap-4 text-[11px] text-muted">
              <span>
                Active <span className="font-mono text-ink">{duration(states.activeMs)}</span>
              </span>
              <span>
                Idle <span className="font-mono text-ink">{duration(states.idleMs)}</span>
              </span>
            </div>
          </section>

          {/* ------------------------------ Events ----------------------------- */}
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-ink">Input</h4>
            <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-hairline bg-hairline">
              {[
                ['Keys', summary.keys],
                ['Clicks', summary.clicks],
                ['Scrolls', summary.scrolls]
              ].map(([label, value]) => (
                <div key={label as string} className="bg-surface px-3 py-2">
                  <p className="text-[10px] text-faint">{label}</p>
                  <p className="font-mono text-sm tabular-nums text-ink">
                    {intervals.length === 0 || noInput ? '—' : Math.round(value as number)}
                  </p>
                </div>
              ))}
            </div>
            {noInput && (
              <p className="text-[11px] text-faint">This machine cannot count keys and clicks.</p>
            )}
          </section>

          {/* --------------------------- Applications -------------------------- */}
          <section className="flex flex-col gap-2">
            <h4 className="text-xs font-medium text-ink">Applications</h4>
            {apps.length === 0 ? (
              <p className="text-[11px] text-faint">None recorded.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {apps.map((item) => (
                  <li key={item.name} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs text-ink" title={item.name}>
                        {item.name}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
                        {duration(item.ms)}
                      </span>
                    </div>
                    <span className="h-1 overflow-hidden rounded-full bg-canvas">
                      <span
                        className="block h-full rounded-full bg-positive/70"
                        style={{ width: `${longestApp > 0 ? Math.max(3, (item.ms / longestApp) * 100) : 0}%` }}
                      />
                    </span>
                    {item.titles.slice(0, 3).map((entry) => (
                      <span
                        key={entry.title}
                        className="truncate pl-2 text-[11px] text-faint"
                        title={entry.title}
                      >
                        {entry.title}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ------------------------------ Browser ---------------------------- */}
          {(browser.sites.length > 0 || browser.searches.length > 0) && (
            <section className="flex flex-col gap-2">
              <h4 className="text-xs font-medium text-ink">Browser</h4>
              <ul className="flex flex-col gap-2">
                {browser.sites.slice(0, 6).map((site) => (
                  <li key={site.domain} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn('min-w-0 flex-1 truncate text-xs', site.excluded ? 'text-faint' : 'text-ink')}
                        title={site.domain}
                      >
                        {site.domain === 'newtab' ? 'New tab' : site.domain}
                        {site.excluded && ' (excluded)'}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">
                        {duration(site.ms)}
                      </span>
                    </div>
                    <span className="h-1 overflow-hidden rounded-full bg-canvas">
                      <span
                        className="block h-full rounded-full bg-accent/70"
                        style={{ width: `${longestSite > 0 ? Math.max(3, (site.ms / longestSite) * 100) : 0}%` }}
                      />
                    </span>
                  </li>
                ))}
              </ul>
              {browser.searches.length > 0 && (
                <ul className="mt-1 flex flex-col gap-1">
                  {browser.searches.map((search) => (
                    <li key={`${search.at}-${search.query}`} className="flex gap-2 text-[11px]">
                      <span className="shrink-0 font-mono text-faint">{timeLabel(search.at)}</span>
                      <span className="min-w-0 flex-1 truncate text-ink" title={search.query}>
                        {search.query}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <p className="text-[10px] leading-relaxed text-faint">
            Key and click counts are recorded per window and shared out by time where a window
            only partly overlaps these minutes.
          </p>
        </>
      )}
    </aside>
  )
}

/* -------------------------------------------------------------------------- */

function StepButton({
  side,
  disabled,
  onClick
}: {
  side: 'left' | 'right'
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? 'Previous screenshot' : 'Next screenshot'}
      className={cn(
        'absolute top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full',
        'bg-black/50 text-white/80 transition-colors hover:bg-black/70 hover:text-white',
        'disabled:pointer-events-none disabled:opacity-0',
        side === 'left' ? 'left-2' : 'right-2'
      )}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-5">
        {side === 'left' ? (
          <path d="M12.7 4.3 7 10l5.7 5.7-1.4 1.4L4.2 10l7.1-7.1 1.4 1.4z" />
        ) : (
          <path d="M7.3 15.7 13 10 7.3 4.3l1.4-1.4L15.8 10l-7.1 7.1-1.4-1.4z" />
        )}
      </svg>
    </button>
  )
}

const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** 8m 20s, 1h 05m, 40s. */
function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}
