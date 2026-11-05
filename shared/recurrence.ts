/**
 * Call recurrence — the rule, and how it expands into occurrences.
 *
 * The Call Manager materialises a recurring call as real `scheduled_calls` rows,
 * one per occurrence, so reminders, status, missed-marking and assignees all
 * work per row with no special cases. This module is the one place that knows
 * how a rule turns into those dates, shared by the renderer (to preview and to
 * label the picker) and the main process (to generate the rows).
 *
 * All date maths is done in local wall-clock time: "weekly on Wednesday at
 * 3:30pm" means 3:30pm each Wednesday on the user's own clock, which is what a
 * person expects across a daylight-saving change. The anchor's ISO string is
 * read into a local Date, stepped by calendar units, and written back out.
 */

export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly' | 'yearly'

/** Monthly can repeat on the same date (the 4th) or the same weekday (first Wednesday). */
export type MonthlyMode = 'date' | 'weekday'

export type RecurrenceEnd =
  | { type: 'never' }
  | { type: 'until'; until: string } // inclusive local date, YYYY-MM-DD
  | { type: 'count'; count: number } // total occurrences, including the first

export interface RecurrenceRule {
  freq: RecurrenceFreq
  /** Every N units. 1 = every day/week/month/year. */
  interval: number
  /**
   * Weekdays the call falls on, 0 = Sunday … 6 = Saturday. Weekly only.
   * Empty/undefined means "the anchor's own weekday". "Every weekday" is
   * `[1,2,3,4,5]`.
   */
  byWeekday?: number[]
  /** Monthly only: by the date of the month, or by the weekday-of-month. */
  monthlyMode?: MonthlyMode
  end: RecurrenceEnd
}

/* -------------------------------------------------------------------------- */
/*                                   Presets                                  */
/* -------------------------------------------------------------------------- */

export type RecurrencePreset =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'weekdays'
  | 'custom'

/** The rule a preset stands for, anchored at `start`. `none`/`custom` return null. */
export function presetRule(preset: RecurrencePreset, start: Date): RecurrenceRule | null {
  switch (preset) {
    case 'daily':
      return { freq: 'daily', interval: 1, end: { type: 'never' } }
    case 'weekly':
      return { freq: 'weekly', interval: 1, byWeekday: [start.getDay()], end: { type: 'never' } }
    case 'monthly':
      return { freq: 'monthly', interval: 1, monthlyMode: 'weekday', end: { type: 'never' } }
    case 'yearly':
      return { freq: 'yearly', interval: 1, end: { type: 'never' } }
    case 'weekdays':
      return { freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5], end: { type: 'never' } }
    default:
      return null // 'none' and 'custom'
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Labelling                                 */
/* -------------------------------------------------------------------------- */

const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORDINAL = ['first', 'second', 'third', 'fourth', 'last']

/** "Weekly on Wednesday", "Monthly on the first Wednesday", "Every weekday", … */
export function describeRule(rule: RecurrenceRule, start: Date): string {
  const every = rule.interval > 1 ? ` ${rule.interval}` : ''
  const plural = rule.interval > 1 ? 's' : ''

  switch (rule.freq) {
    case 'daily':
      return rule.interval > 1 ? `Every ${rule.interval} days` : 'Daily'

    case 'weekly': {
      const days = (rule.byWeekday?.length ? rule.byWeekday : [start.getDay()])
        .slice()
        .sort((a, b) => a - b)
      if (isWeekdaysSet(days) && rule.interval === 1) return 'Every weekday (Monday to Friday)'
      const names = days.map((d) => WEEKDAY_LONG[d]).join(', ')
      return `Every${every} week${plural} on ${names}`
    }

    case 'monthly': {
      if (rule.monthlyMode === 'weekday') {
        const nth = ORDINAL[Math.min(Math.ceil(start.getDate() / 7), 5) - 1]
        return `Every${every} month${plural} on the ${nth} ${WEEKDAY_LONG[start.getDay()]}`
      }
      return `Every${every} month${plural} on day ${start.getDate()}`
    }

    case 'yearly':
      return rule.interval > 1 ? `Every ${rule.interval} years` : 'Annually'
  }
}

function isWeekdaysSet(days: number[]): boolean {
  return days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))
}

/* -------------------------------------------------------------------------- */
/*                                  Expansion                                 */
/* -------------------------------------------------------------------------- */

export interface ExpandOptions {
  /** Do not generate occurrences starting after this moment. */
  horizonEnd: Date
  /** Hard cap on how many to return, whatever the rule says. */
  limit?: number
}

/**
 * Every occurrence start, from the anchor forward, within the bounds.
 *
 * The anchor itself is always the first occurrence (it is the call the user
 * actually scheduled). Stepping stops at the earliest of: the rule's own end
 * (an until-date or a count), the horizon, or the limit.
 */
export function expandOccurrences(
  anchorIso: string,
  rule: RecurrenceRule,
  options: ExpandOptions
): string[] {
  const anchor = new Date(anchorIso)
  if (Number.isNaN(anchor.getTime())) return []

  const limit = options.limit ?? 1000
  const horizon = options.horizonEnd.getTime()
  const until = rule.end.type === 'until' ? endOfLocalDay(rule.end.until) : Infinity
  const maxCount = rule.end.type === 'count' ? Math.max(1, Math.floor(rule.end.count)) : Infinity
  const interval = Math.max(1, Math.floor(rule.interval))

  const out: string[] = []
  const push = (d: Date): boolean => {
    const t = d.getTime()
    if (t < anchor.getTime()) return true // before the series starts; skip, keep going
    if (t > horizon || t > until) return false // past every bound; stop
    out.push(d.toISOString())
    return out.length < maxCount && out.length < limit
  }

  if (rule.freq === 'daily') {
    for (let d = new Date(anchor); ; d = addDays(d, interval)) {
      if (!push(d)) break
      if (d.getTime() > horizon || d.getTime() > until) break
    }
  } else if (rule.freq === 'weekly') {
    const days = (rule.byWeekday?.length ? rule.byWeekday : [anchor.getDay()])
      .slice()
      .sort((a, b) => a - b)
    // Walk week by week from the Sunday of the anchor's week, emitting each
    // chosen weekday at the anchor's time. `interval` skips whole weeks.
    let weekStart = startOfWeek(anchor)
    outer: while (weekStart.getTime() <= horizon && weekStart.getTime() <= until) {
      for (const wd of days) {
        const occ = atTime(addDays(weekStart, wd), anchor)
        if (!push(occ)) break outer
      }
      weekStart = addDays(weekStart, 7 * interval)
    }
  } else if (rule.freq === 'monthly') {
    const mode: MonthlyMode = rule.monthlyMode ?? 'date'
    const wd = anchor.getDay()
    const nth = Math.ceil(anchor.getDate() / 7) // 1..5, which weekday-of-month the anchor is
    let cursor = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    while (cursor.getTime() <= horizon && cursor.getTime() <= until) {
      const y = cursor.getFullYear()
      const m = cursor.getMonth()
      const occ =
        mode === 'weekday'
          ? nthWeekdayOfMonth(y, m, wd, nth, anchor)
          : dayOfMonth(y, m, anchor.getDate(), anchor)
      if (occ && !push(occ)) break
      cursor = new Date(y, m + interval, 1)
    }
  } else {
    // yearly
    for (let y = anchor.getFullYear(); ; y += interval) {
      const occ = dayOfMonth(y, anchor.getMonth(), anchor.getDate(), anchor)
      if (occ && !push(occ)) break
      if (new Date(y, anchor.getMonth(), 1).getTime() > horizon) break
      if (new Date(y, anchor.getMonth(), 1).getTime() > until) break
    }
  }

  // A count-ended rule can list occurrences in a non-monotonic order for a
  // multi-day weekly rule; sort and re-cap to be safe.
  out.sort()
  return maxCount === Infinity ? out : out.slice(0, maxCount)
}

/* ------------------------------- date helpers ----------------------------- */

function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

/** The Sunday of `d`'s week, at `d`'s time. */
function startOfWeek(d: Date): Date {
  return addDays(d, -d.getDay())
}

/** `base`'s date with `time`'s hours/minutes/seconds. */
function atTime(base: Date, time: Date): Date {
  const out = new Date(base)
  out.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), time.getMilliseconds())
  return out
}

/** The given day of a month, or null when that month is too short (e.g. the 31st). */
function dayOfMonth(year: number, month: number, day: number, time: Date): Date | null {
  const d = new Date(year, month, day, time.getHours(), time.getMinutes(), time.getSeconds())
  // `new Date(2026, 1, 31)` rolls into March; reject anything that moved month.
  return d.getMonth() === ((month % 12) + 12) % 12 && d.getDate() === day ? d : null
}

/** The nth (1..5) weekday of a month, or null when it has no such (e.g. a 5th Monday). */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  nth: number,
  time: Date
): Date | null {
  const first = new Date(year, month, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  const day = 1 + offset + (nth - 1) * 7
  return dayOfMonth(year, month, day, time)
}

/** End of the local day named YYYY-MM-DD, as a timestamp. */
function endOfLocalDay(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return Infinity
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}
