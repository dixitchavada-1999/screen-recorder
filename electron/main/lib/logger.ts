import { app } from 'electron'
import { createWriteStream, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WriteStream } from 'node:fs'
import type { LogLevel } from '@shared/types'

/**
 * Minimal dependency-free file logger with size-based rotation.
 *
 * Both processes funnel here: the main process calls it directly, the renderer
 * forwards entries over the `log:write` channel. Keeping one file makes crash
 * reports from users a single attachment.
 */

const MAX_BYTES = 2 * 1024 * 1024 // rotate at 2 MB
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

class Logger {
  private stream: WriteStream | null = null
  private directory = ''
  private filePath = ''
  private minLevel: LogLevel = app.isPackaged ? 'info' : 'debug'

  /** Must be called after the `ready` event, once `userData` is resolvable. */
  init(): void {
    try {
      this.directory = join(app.getPath('userData'), 'logs')
      mkdirSync(this.directory, { recursive: true })
      this.filePath = join(this.directory, 'main.log')
      this.rotateIfNeeded()
      this.stream = createWriteStream(this.filePath, { flags: 'a' })
      this.info('logger', 'Logging started', {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch
      })
    } catch (error) {
      // Logging must never take the app down.
      console.error('[logger] failed to initialise', error)
    }
  }

  getDirectory(): string {
    return this.directory
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) return
    try {
      if (statSync(this.filePath).size < MAX_BYTES) return
      renameSync(this.filePath, join(this.directory, 'main.previous.log'))
    } catch {
      /* rotation is best effort */
    }
  }

  private write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.minLevel]) return

    const timestamp = new Date().toISOString()
    let line = `${timestamp} [${level.toUpperCase().padEnd(5)}] [${scope}] ${message}`

    if (data !== undefined) {
      line += ` ${safeStringify(data)}`
    }

    if (!app.isPackaged) {
      const sink = level === 'error' ? console.error : console.log
      sink(line)
    }

    this.stream?.write(`${line}\n`)
  }

  debug = (scope: string, message: string, data?: unknown): void =>
    this.write('debug', scope, message, data)
  info = (scope: string, message: string, data?: unknown): void =>
    this.write('info', scope, message, data)
  warn = (scope: string, message: string, data?: unknown): void =>
    this.write('warn', scope, message, data)
  error = (scope: string, message: string, data?: unknown): void =>
    this.write('error', scope, message, data)

  log(level: LogLevel, scope: string, message: string, data?: unknown): void {
    this.write(level, scope, message, data)
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }
}

/** Serialises arbitrary values, tolerating circular references and Errors. */
function safeStringify(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({ name: value.name, message: value.message, stack: value.stack })
  }
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]'
        seen.add(val)
      }
      return val
    })
  } catch {
    return String(value)
  }
}

export const logger = new Logger()
