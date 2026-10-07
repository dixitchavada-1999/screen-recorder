import { app } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { BRIDGE_PORT, allowedOrigins } from '../config/browser-extension'
import { logger } from '../lib/logger'
import { currentPolicy } from './tracking-policy'

const SCOPE = 'browser-bridge'

/**
 * Where the browser extension hands over what it recorded.
 *
 * A small HTTP server on 127.0.0.1, separate from the MCP one: different
 * caller, different rules. The extension asks for its instructions and posts
 * visits; this decides whether they are kept, against the same policy as the
 * rest of tracking, and writes them beside the other activity files for the
 * upload queue to send. The extension never reaches the network itself.
 *
 * Only extension pages are answered. A web page cannot forge its `Origin`, so
 * no site open in the browser can post here; once the store ids are configured,
 * only this extension can.
 */

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_VISITS_PER_REQUEST = 1000

let server: Server | null = null
let warnedOpenOrigins = false

export function startBrowserBridge(): void {
  if (server) return

  server = createServer((req, res) => void handle(req, res))
  server.on('error', (error) => logger.error(SCOPE, 'Browser bridge failed to start', error))
  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    logger.info(SCOPE, 'Browser bridge listening', { port: BRIDGE_PORT })
  })
}

export function stopBrowserBridge(): void {
  if (!server) return
  server.close()
  server = null
}

/* -------------------------------------------------------------------------- */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin ?? ''

  if (!originAllowed(origin)) {
    send(res, 403, { ok: false, error: 'forbidden' })
    return
  }

  try {
    if (req.method === 'GET' && req.url === '/v1/config') {
      const policy = currentPolicy()
      send(res, 200, {
        enabled: policy.browserEnabled,
        excludedDomains: policy.excludedDomains,
        idleAfterSeconds: policy.idleAfterSeconds
      })
      return
    }

    if (req.method === 'POST' && req.url === '/v1/visits') {
      const body = (await readJson(req)) as { visits?: unknown }
      const accepted = await accept(Array.isArray(body.visits) ? body.visits : [])
      send(res, 200, { ok: true, accepted })
      return
    }

    send(res, 404, { ok: false, error: 'not_found' })
  } catch (error) {
    logger.warn(SCOPE, 'Browser bridge request failed', error)
    send(res, 400, { ok: false, error: 'bad_request' })
  }
}

function originAllowed(origin: string): boolean {
  const allowed = allowedOrigins()

  if (allowed.length === 0) {
    if (!warnedOpenOrigins) {
      warnedOpenOrigins = true
      logger.warn(SCOPE, 'No extension ids configured; accepting any extension (testing only)')
    }
    return /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
  }

  return allowed.includes(origin)
}

/* -------------------------------------------------------------------------- */
/*                                  Visits                                    */
/* -------------------------------------------------------------------------- */

/** One visit as it is written to disk and later uploaded. */
export interface BrowserVisit {
  startedAt: string
  endedAt: string
  browser: 'chrome' | 'edge' | 'other'
  domain: string
  url: string | null
  title: string | null
  search: string | null
  excluded: boolean
}

/**
 * Keeps what the policy allows and drops the rest.
 *
 * Accepting and dropping both count as delivered: the extension holds visits
 * only until the app has them, and a visit the policy refuses is one it should
 * forget, not retry. Exclusions are applied again here, so a list changed since
 * the extension last asked still holds.
 */
async function accept(raw: unknown[]): Promise<number> {
  const policy = currentPolicy()
  if (!policy.browserEnabled) return 0

  const visits = raw
    .slice(0, MAX_VISITS_PER_REQUEST)
    .map((item) => toVisit(item, policy.excludedDomains))
    .filter((visit): visit is BrowserVisit => visit !== null)

  // Grouped by the day each began, one file per day like the other activity.
  const byDay = new Map<string, string[]>()
  for (const visit of visits) {
    const day = dayName(visit.startedAt)
    const lines = byDay.get(day) ?? []
    lines.push(JSON.stringify(visit))
    byDay.set(day, lines)
  }

  const directory = join(app.getPath('userData'), 'activity')
  await mkdir(directory, { recursive: true })

  for (const [day, lines] of byDay) {
    await appendFile(join(directory, `browser-${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
  }

  if (visits.length > 0) logger.debug(SCOPE, 'Browser visits recorded', { count: visits.length })
  return visits.length
}

function toVisit(item: unknown, excludedDomains: string[]): BrowserVisit | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as Record<string, unknown>

  const startedAt = Date.parse(String(raw.startedAt))
  const endedAt = Date.parse(String(raw.endedAt))
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) return null
  // Nothing from the future, and nothing absurdly long — a visit is cut at five minutes.
  if (endedAt > Date.now() + 60_000 || endedAt - startedAt > 60 * 60_000) return null

  const domain = text(raw.domain, 255)?.toLowerCase()
  if (!domain) return null

  const browser = raw.browser === 'chrome' || raw.browser === 'edge' ? raw.browser : 'other'

  const excluded =
    raw.excluded === true ||
    excludedDomains.some((entry) => domain === entry || domain.endsWith(`.${entry}`))

  return {
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    browser,
    domain,
    url: excluded ? null : text(raw.url, 2048),
    title: excluded ? null : text(raw.title, 500),
    search: excluded ? null : text(raw.search, 500),
    excluded
  }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  return clean ? clean.slice(0, max) : null
}

function dayName(iso: string): string {
  const day = new Date(iso)
  return [
    day.getFullYear(),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0')
  ].join('-')
}

/* -------------------------------------------------------------------------- */

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}
