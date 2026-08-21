import { ERROR_CODES } from '@shared/ipc'
import type { IpcResult, LogLevel, SerializedError } from '@shared/types'

/**
 * Renderer-side error carrying the code produced by the main process.
 *
 * IPC results cross the context bridge as plain objects (custom Error fields do
 * not survive structured cloning), so they are re-inflated here.
 */
export class IpcError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(serialized: SerializedError) {
    super(serialized.message)
    this.name = 'IpcError'
    this.code = serialized.code
    this.hint = serialized.hint
  }
}

/** Unwraps an `IpcResult`, throwing a typed `IpcError` on failure. */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise

  if (!result) {
    throw new IpcError({
      code: ERROR_CODES.UNKNOWN,
      message: 'The background process did not respond.'
    })
  }

  if (!result.ok) throw new IpcError(result.error)
  return result.data
}

/** Normalises any thrown value into a `SerializedError` for display. */
export function toSerializedError(error: unknown): SerializedError {
  if (error instanceof IpcError) {
    return error.hint === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, hint: error.hint }
  }
  if (error instanceof Error) {
    return { code: ERROR_CODES.UNKNOWN, message: error.message }
  }
  return { code: ERROR_CODES.UNKNOWN, message: String(error) }
}

/**
 * Forwards renderer logs to the main process log file so a bug report contains
 * both sides of the story.
 */
export const log = {
  write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    try {
      window.api.log.write({ level, scope, message, data: serialisable(data) })
    } catch {
      /* logging must never break the UI */
    }
  },
  debug: (scope: string, message: string, data?: unknown): void =>
    log.write('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown): void =>
    log.write('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown): void =>
    log.write('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown): void =>
    log.write('error', scope, message, data)
}

/**
 * `postMessage` cannot clone Errors or DOM objects; flatten them first so a
 * log call never throws a DataCloneError.
 */
function serialisable(data: unknown): unknown {
  if (data === undefined || data === null) return data
  if (data instanceof Error) {
    return { name: data.name, message: data.message, stack: data.stack }
  }
  if (typeof data === 'object') {
    try {
      return JSON.parse(JSON.stringify(data))
    } catch {
      return String(data)
    }
  }
  return data
}
