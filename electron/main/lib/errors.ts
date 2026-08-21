import { ERROR_CODES, type ErrorCode } from '@shared/ipc'
import type { IpcResult, SerializedError } from '@shared/types'
import { logger } from './logger'

/**
 * Error type carrying a stable machine-readable code plus an optional hint the
 * UI can show verbatim (e.g. "install ffmpeg with apt").
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly hint: string | undefined

  constructor(code: ErrorCode, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions)
    this.name = 'AppError'
    this.code = code
    this.hint = hint
  }

  toSerialized(): SerializedError {
    return this.hint === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, hint: this.hint }
  }
}

export function toSerializedError(error: unknown): SerializedError {
  if (error instanceof AppError) return error.toSerialized()
  if (error instanceof Error) return { code: ERROR_CODES.UNKNOWN, message: error.message }
  return { code: ERROR_CODES.UNKNOWN, message: String(error) }
}

/**
 * Wraps an IPC handler so it always resolves to a serialisable `IpcResult`.
 * Rejected promises would otherwise reach the renderer as opaque
 * "Error invoking remote method" strings with the original code stripped.
 */
export function handled<TArgs extends unknown[], TReturn>(
  scope: string,
  fn: (...args: TArgs) => Promise<TReturn> | TReturn
): (...args: TArgs) => Promise<IpcResult<TReturn>> {
  return async (...args: TArgs): Promise<IpcResult<TReturn>> => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (error) {
      const serialized = toSerializedError(error)
      logger.error(scope, serialized.message, error)
      return { ok: false, error: serialized }
    }
  }
}

export { ERROR_CODES }
