import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from '../config/supabase'
import { logger } from '../lib/logger'
import { currentUser } from './auth'

const SCOPE = 'roster'

/**
 * Keeping this machine's copy of the staff roster current.
 *
 * The list itself is read straight from the `nexus_users` table, like any other
 * data; this module is only about asking the server to go and refresh it. That
 * refresh is a partner API call with a hard budget — fifty a day — so it never
 * happens here. The `roster-sync` function decides whether the cache is stale
 * and, if several machines ask at once, only one of them does the work.
 *
 * Which means this can afford to be naive: ask on sign-in, ask once a day after
 * that, and let the server say no.
 */

/** How often this machine bothers asking. The server has the real limit. */
const ASK_INTERVAL_MS = 6 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null

export function startRosterSync(): void {
  if (timer !== null) return

  timer = setInterval(() => void requestRosterSync(), ASK_INTERVAL_MS)
  void requestRosterSync()

  logger.info(SCOPE, 'Roster refresh scheduled', { everyMs: ASK_INTERVAL_MS })
}

export function stopRosterSync(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

/**
 * Asks the server to refresh the roster.
 *
 * Never throws. Nothing depends on this succeeding: the picker renders from
 * whatever is cached, and a stale roster is a list missing last week's joiner —
 * not a broken app.
 */
export async function requestRosterSync(): Promise<void> {
  if (!isSupabaseConfigured() || !currentUser()) return

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/roster-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      },
      body: '{}'
    })

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      skipped?: string
      synced?: boolean
      count?: number
      error?: string
    }

    if (!response.ok || payload.ok !== true) {
      logger.warn(SCOPE, 'Roster refresh was refused', { status: response.status, ...payload })
      return
    }

    if (payload.synced) logger.info(SCOPE, 'Roster refreshed', { count: payload.count })
    else logger.debug(SCOPE, 'Roster already fresh', { count: payload.count })
  } catch (error) {
    logger.warn(SCOPE, 'Could not ask for a roster refresh', error)
  }
}
