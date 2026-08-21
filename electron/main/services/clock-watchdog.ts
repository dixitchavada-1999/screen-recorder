import { EventEmitter } from 'node:events'
import { logger } from '../lib/logger'

const SCOPE = 'clock-watchdog'

/**
 * Notices when this machine stopped running, by measuring rather than by asking.
 *
 * Everything that records time has the same problem: `setInterval` does not run
 * while the machine is asleep. A ten-minute window that spans a nap comes back
 * as twenty-two minutes of "machine on", and the person inside it looks like
 * they worked half as hard as they did.
 *
 * The obvious fix is `powerMonitor`'s `suspend` and `resume`, and it is the
 * wrong one. Windows Modern Standby — every recent laptop — drops in and out of
 * sleep without reliably emitting either, so the events arrive for some naps and
 * not others. Code that trusts them is correct only when it is lucky.
 *
 * So this trusts nothing but the clock. A tick every few seconds, and if two
 * ticks are further apart than they could legitimately be, the time between them
 * is a gap: the machine slept, hibernated, or was wedged. Sleep is not a special
 * case here — it is simply the most common reason the ticks stop.
 *
 * What the gap *means* is left to the listener. This only reports it.
 */

/** How often the clock is checked. */
const TICK_INTERVAL_MS = 5_000

/**
 * How far past the interval a tick may land before it counts as a gap.
 *
 * Generous on purpose. A busy machine can be late by a second or two without
 * having stopped, and calling that a nap would chop the day into confetti.
 * Twenty seconds is far beyond ordinary lateness and far below any real sleep.
 */
const GAP_TOLERANCE_MS = TICK_INTERVAL_MS * 4

export interface ClockGap {
  /** The last moment this process was known to be running. */
  stoppedAt: number
  /** The moment it was found running again. */
  resumedAt: number
}

/** Emits `gap` with a {@link ClockGap} each time the ticks stop and restart. */
export const clockWatchdog = new EventEmitter()

let timer: NodeJS.Timeout | null = null
let lastTickAt = 0

export function startClockWatchdog(): void {
  if (timer !== null) return

  lastTickAt = Date.now()
  timer = setInterval(tick, TICK_INTERVAL_MS)

  logger.info(SCOPE, 'Watching the clock', { tickMs: TICK_INTERVAL_MS })
}

export function stopClockWatchdog(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

function tick(): void {
  const now = Date.now()
  const previous = lastTickAt
  lastTickAt = now

  // A clock moved backwards — an NTP correction, or someone changing the
  // system time — subtracts to a negative and is not a gap.
  if (previous === 0 || now - previous <= GAP_TOLERANCE_MS) return

  /*
   * The last moment anything was known to be true is one tick past the last
   * tick, not the moment of waking. Claiming the wake time would hand every
   * listener the whole nap as if it had been running throughout, which is the
   * bug this exists to prevent.
   */
  const gap: ClockGap = { stoppedAt: previous + TICK_INTERVAL_MS, resumedAt: now }

  logger.info(SCOPE, 'The machine stopped running', {
    minutes: Math.round((gap.resumedAt - gap.stoppedAt) / 60_000),
    stoppedAt: new Date(gap.stoppedAt).toISOString()
  })

  clockWatchdog.emit('gap', gap)
}
