import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { join } from 'node:path'
import { app } from 'electron'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { McpServerStatus } from '@shared/types'
import { AppError } from '../lib/errors'
import { logger } from '../lib/logger'
import { createCall, listCalls, setCallStatus } from './calls'
import { refreshReminders } from './reminders'

const SCOPE = 'mcp'

/**
 * Fixed rather than ephemeral, so the `.mcp.json` snippet an employee copies
 * once out of Settings keeps working across restarts.
 */
const PORT = 39217
const PATH = '/mcp'
const TOKEN_FILE = 'mcp-token.txt'

/** A request body larger than this cannot be a real tool call. */
const MAX_BODY_BYTES = 1024 * 1024

let httpServer: HttpServer | null = null
let token = ''

/**
 * A local MCP server, run inside this already-signed-in main process.
 *
 * Every tool below is a thin wrapper around `calls.ts` — the same functions
 * the Call Manager UI calls over IPC. Auth is whatever this process is
 * already signed in as: `createCall`/`listCalls`/`setCallStatus` call
 * `requireUser()` themselves, so a machine nobody has signed into simply
 * answers every tool call with "sign in to use the Call Manager" instead of
 * touching the database.
 *
 * Bound to loopback only and gated by a bearer token generated on first run,
 * because this listens on the network stack even though only this machine's
 * own Claude can reach it.
 */
export function startMcpServer(): void {
  if (httpServer) return

  token = loadOrCreateToken()

  httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res)
  })

  httpServer.on('error', (error) => {
    logger.error(SCOPE, 'Local MCP server failed to start', error)
  })

  httpServer.listen(PORT, '127.0.0.1', () => {
    logger.info(SCOPE, 'Local MCP server listening', { port: PORT })
  })
}

export function stopMcpServer(): void {
  if (!httpServer) return
  httpServer.close()
  httpServer = null
  logger.info(SCOPE, 'Local MCP server stopped')
}

export function getStatus(): McpServerStatus {
  return {
    running: httpServer !== null,
    url: `http://127.0.0.1:${PORT}${PATH}`,
    port: PORT,
    token
  }
}

/** Rotates the token, invalidating any `.mcp.json` already pasted elsewhere. */
export function regenerateToken(): string {
  token = randomBytes(24).toString('hex')
  persistToken(token)
  logger.info(SCOPE, 'MCP token regenerated')
  return token
}

/* -------------------------------------------------------------------------- */
/*                                    HTTP                                    */
/* -------------------------------------------------------------------------- */

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST' || req.url !== PATH) {
    sendJsonRpcError(res, 404, -32000, 'Not found')
    return
  }

  if (req.headers.authorization !== `Bearer ${token}`) {
    sendJsonRpcError(res, 401, -32001, 'Unauthorized')
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (error) {
    logger.warn(SCOPE, 'Could not read the request body', error)
    sendJsonRpcError(res, 400, -32700, 'Parse error')
    return
  }

  // Stateless: a fresh server and transport per call. There is no session to
  // keep between requests — each tool call reaches straight into `calls.ts`
  // and is done.
  const server = buildToolServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (error) {
    logger.error(SCOPE, 'MCP request failed', error)
    if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal server error')
  }
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }))
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(error)
      }
    })

    req.on('error', reject)
  })
}

/* -------------------------------------------------------------------------- */
/*                                    Tools                                   */
/* -------------------------------------------------------------------------- */

function buildToolServer(): McpServer {
  const server = new McpServer({ name: 'screen-recorder-call-manager', version: app.getVersion() })

  server.registerTool(
    'schedule_call',
    {
      description: "Schedules a call on the signed-in employee's own schedule.",
      inputSchema: {
        title: z.string().min(1).describe('What the call is about'),
        startsAt: z.string().describe('When the call starts, as an ISO 8601 date-time with offset'),
        durationMinutes: z
          .number()
          .int()
          .min(1)
          .max(1440)
          .describe('Length of the call in minutes'),
        notes: z.string().optional().describe('Optional notes about the call')
      }
    },
    async ({ title, startsAt, durationMinutes, notes }) => {
      try {
        const call = await createCall({ title, startsAt, durationMinutes, notes: notes ?? '' })
        void refreshReminders()
        return textResult(
          `Scheduled "${call.title}" at ${call.startsAt} (${call.durationMinutes} min). id: ${call.id}`
        )
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'list_calls',
    {
      description: "Lists the signed-in employee's calls in a date range.",
      inputSchema: {
        from: z.string().optional().describe('Start of the range, ISO 8601 (default: now)'),
        to: z
          .string()
          .optional()
          .describe('End of the range, ISO 8601 (default: 7 days from now)'),
        scope: z
          .enum(['assigned', 'scheduled-by-me'])
          .optional()
          .describe(
            "'assigned' (default) is the employee's own schedule; 'scheduled-by-me' is calls they arranged for other people"
          )
      }
    },
    async ({ from, to, scope }) => {
      try {
        const range = {
          from: from ?? new Date().toISOString(),
          to: to ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        }
        const calls = await listCalls(range, scope ?? 'assigned')
        if (calls.length === 0) return textResult('No calls in that range.')

        const lines = calls.map(
          (call) => `- ${call.id} | ${call.title} | ${call.startsAt} | ${call.durationMinutes} min | ${call.status}`
        )
        return textResult(lines.join('\n'))
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'cancel_call',
    {
      description: "Cancels one of the employee's calls by id. Get the id from list_calls first.",
      inputSchema: {
        callId: z.string().min(1).describe('The call id, from list_calls')
      }
    },
    async ({ callId }) => {
      try {
        const call = await setCallStatus(callId, 'cancelled')
        void refreshReminders()
        return textResult(`Cancelled "${call.title}" (${call.startsAt}).`)
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  return server
}

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function errorResult(error: unknown): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  const message =
    error instanceof AppError ? error.message : error instanceof Error ? error.message : String(error)
  logger.warn(SCOPE, 'Tool call failed', error)
  return { content: [{ type: 'text', text: message }], isError: true }
}

/* -------------------------------------------------------------------------- */
/*                                   Token                                    */
/* -------------------------------------------------------------------------- */

function tokenPath(): string {
  return join(app.getPath('userData'), TOKEN_FILE)
}

function loadOrCreateToken(): string {
  try {
    const existing = readFileSync(tokenPath(), 'utf8').trim()
    if (existing) return existing
  } catch {
    // First run on this machine — nothing stored yet.
  }
  return regenerateToken()
}

function persistToken(value: string): void {
  try {
    writeFileSync(tokenPath(), value, 'utf8')
  } catch (error) {
    logger.warn(SCOPE, 'Could not persist the MCP token', error)
  }
}
