import type {
  ActivityInterval,
  ActivitySegment,
  AppStretchRecord,
  AppUsageSummary,
  BrowserDaySummary,
  BrowserPage,
  BrowserVisitRecord
} from './types'

/**
 * Turning recorded rows into the summaries people read.
 *
 * Shared by both sides on purpose: the main process summarises a whole day
 * with these, and the screenshot viewer summarises the few minutes before one
 * capture with the very same functions — so a window and the day it sits in
 * can never disagree about what counts.
 */

/** Window titles kept per application in a summary. */
const TITLES_PER_APP = 8

/** Pages kept per site in a summary. */
const PAGES_PER_SITE = 10

const ms = (iso: string): number => Date.parse(iso)

/* -------------------------------------------------------------------------- */
/*                                  Clipping                                  */
/* -------------------------------------------------------------------------- */

/**
 * The part of each span that falls inside [from, to), with anything measured
 * per span scaled down by the share kept. A stretch from 9:58 to 10:03 seen
 * through a 10:00–10:10 window counts three minutes, and its titles three
 * fifths of their seconds.
 */
function clip<T extends { startedAt: string; endedAt: string }>(
  rows: T[],
  from: number,
  to: number,
  scale: (row: T, share: number) => T
): T[] {
  const kept: T[] = []

  for (const row of rows) {
    const start = ms(row.startedAt)
    const end = ms(row.endedAt)
    if (!(end > start)) continue

    const clippedStart = Math.max(start, from)
    const clippedEnd = Math.min(end, to)
    if (clippedEnd <= clippedStart) continue

    const share = (clippedEnd - clippedStart) / (end - start)
    kept.push({
      ...scale(row, share),
      startedAt: new Date(clippedStart).toISOString(),
      endedAt: new Date(clippedEnd).toISOString()
    })
  }

  return kept
}

export function appStretchesBetween(
  rows: AppStretchRecord[],
  from: number,
  to: number
): AppStretchRecord[] {
  return clip(rows, from, to, (row, share) => ({
    ...row,
    titles: row.titles.map((title) => ({ ...title, seconds: title.seconds * share }))
  }))
}

export function browserVisitsBetween(
  rows: BrowserVisitRecord[],
  from: number,
  to: number
): BrowserVisitRecord[] {
  return clip(rows, from, to, (row) => row)
}

export function segmentsBetween(rows: ActivitySegment[], from: number, to: number): ActivitySegment[] {
  return clip(rows, from, to, (row) => row)
}

/**
 * Key, click and scroll counts and active seconds inside [from, to).
 *
 * Counts are kept per window, not per keystroke, so a window only partly inside
 * contributes that share of its counts. Close enough to read, and labelled as
 * an estimate wherever it is shown.
 */
export function intervalsBetween(
  rows: ActivityInterval[],
  from: number,
  to: number
): ActivityInterval[] {
  return clip(rows, from, to, (row, share) => ({
    ...row,
    keyPresses: row.keyPresses * share,
    mouseClicks: row.mouseClicks * share,
    scrolls: row.scrolls * share,
    activeSeconds: row.activeSeconds * share
  }))
}

/* -------------------------------------------------------------------------- */
/*                                 Summaries                                  */
/* -------------------------------------------------------------------------- */

/**
 * Time per application, longest first, with the titles that made it up.
 *
 * Stretches are summed per application and their titles merged, so the answer
 * reads as "four hours in Chrome, mostly these pages" rather than as the
 * hundred stretches it was recorded in.
 */
export function summariseApps(rows: AppStretchRecord[]): AppUsageSummary[] {
  const byApp = new Map<string, { ms: number; titles: Map<string, number> }>()

  for (const row of rows) {
    const span = ms(row.endedAt) - ms(row.startedAt)
    if (!(span > 0)) continue

    const entry = byApp.get(row.app) ?? { ms: 0, titles: new Map<string, number>() }
    entry.ms += span

    for (const item of row.titles) {
      if (!item.title || !(item.seconds > 0)) continue
      entry.titles.set(item.title, (entry.titles.get(item.title) ?? 0) + item.seconds)
    }

    byApp.set(row.app, entry)
  }

  return [...byApp.entries()]
    .map(([name, entry]) => ({
      name,
      ms: entry.ms,
      titles: [...entry.titles.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, TITLES_PER_APP)
        .map(([title, seconds]) => ({ title, seconds: Math.round(seconds) }))
    }))
    .sort((a, b) => b.ms - a.ms)
}

/**
 * Time per site, longest first, with every search listed in order.
 *
 * A page is identified by its address, so the same page visited three times is
 * one line with the time added up. An excluded site has no address at all and
 * stays a single line of time.
 */
export function summariseBrowser(rows: BrowserVisitRecord[]): BrowserDaySummary {
  const bySite = new Map<string, { ms: number; excluded: boolean; pages: Map<string, BrowserPage> }>()
  const searches: BrowserDaySummary['searches'] = []

  for (const row of rows) {
    const span = ms(row.endedAt) - ms(row.startedAt)
    if (!(span > 0)) continue

    const site = bySite.get(row.domain) ?? { ms: 0, excluded: row.excluded, pages: new Map() }
    site.ms += span

    if (!row.excluded) {
      const key = row.url ?? row.title ?? ''
      const page = site.pages.get(key) ?? { title: row.title, url: row.url, ms: 0 }
      page.ms += span
      // The latest title wins: a page's title often settles after it loads.
      if (row.title) page.title = row.title
      site.pages.set(key, page)
    }

    bySite.set(row.domain, site)

    // One entry per search, not per stretch of reading its results.
    if (row.search) {
      const last = searches[searches.length - 1]
      if (!last || last.query !== row.search || last.domain !== row.domain) {
        searches.push({ at: row.startedAt, query: row.search, domain: row.domain })
      }
    }
  }

  return {
    sites: [...bySite.entries()]
      .map(([domain, site]) => ({
        domain,
        ms: site.ms,
        excluded: site.excluded,
        pages: [...site.pages.values()].sort((a, b) => b.ms - a.ms).slice(0, PAGES_PER_SITE)
      }))
      .sort((a, b) => b.ms - a.ms),
    searches
  }
}

/** Active and idle time across a set of segments. */
export function stateTotals(segments: ActivitySegment[]): { activeMs: number; idleMs: number } {
  let activeMs = 0
  let idleMs = 0

  for (const segment of segments) {
    const span = ms(segment.endedAt) - ms(segment.startedAt)
    if (!(span > 0)) continue
    if (segment.state === 'active') activeMs += span
    else idleMs += span
  }

  return { activeMs, idleMs }
}
