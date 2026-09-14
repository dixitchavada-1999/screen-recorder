import { app } from 'electron'
import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logger } from '../lib/logger'

const execFileAsync = promisify(execFile)
const SCOPE = 'whisper-locator'

/**
 * Finds the whisper.cpp executable that turns audio into text.
 *
 * Deliberately the same shape as `ffmpeg-locator`, because it is the same
 * problem: a native binary that has to be found whether the app is packaged or
 * running from source, overridable during development, and absent often enough
 * that "absent" has to be an ordinary answer rather than a crash.
 *
 * A spawned executable rather than a native Node addon, and that is the whole
 * reason this file exists. The npm bindings for whisper.cpp are compiled
 * against a particular Node ABI, which Electron does not share — they need
 * `electron-rebuild`, they cannot be loaded from inside an asar archive, and
 * they break on every Electron upgrade. FFmpeg has been spawned here since the
 * beginning and has never once needed any of that.
 */

/**
 * What the executable is called.
 *
 * whisper.cpp renamed its command from `main` to `whisper-cli` in 2024, and
 * both names are still in circulation — a build somebody downloaded last year
 * is not wrong, it is just older. Both are tried.
 */
function binaryNames(): string[] {
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return [`whisper-cli${suffix}`, `main${suffix}`]
}

let cachedPath: string | null | undefined

function isExecutable(path: string): boolean {
  try {
    // On Windows the execute bit is meaningless; existence is the real test.
    accessSync(path, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function candidatePaths(): string[] {
  const candidates: string[] = []

  const fromEnv = process.env.SCREEN_RECORDER_WHISPER
  if (fromEnv) candidates.push(fromEnv)

  // A `whisper/` folder beside the executable, exactly like `ffmpeg/`.
  const resourcesDir = app.isPackaged ? process.resourcesPath : app.getAppPath()

  for (const name of binaryNames()) {
    candidates.push(join(resourcesDir, 'whisper', name))
    candidates.push(join(app.getAppPath(), 'whisper', name))
  }

  return candidates
}

/** Returns the whisper.cpp path, or `null` when no usable binary exists. */
export async function resolveWhisperPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath

  for (const candidate of candidatePaths()) {
    if (isExecutable(candidate)) {
      cachedPath = candidate
      logger.info(SCOPE, 'Using bundled whisper.cpp', { path: candidate })
      return cachedPath
    }
  }

  // Last resort: somebody has it installed and on PATH.
  for (const name of binaryNames()) {
    try {
      await execFileAsync(name, ['--help'], { timeout: 5000 })
      cachedPath = name
      logger.info(SCOPE, 'Using whisper.cpp from PATH', { name })
      return cachedPath
    } catch {
      /* not on PATH under this name */
    }
  }

  cachedPath = null
  logger.info(SCOPE, 'No whisper.cpp binary is available, transcription is off')
  return null
}

/** Whether transcription can run at all on this machine. */
export async function whisperIsAvailable(): Promise<boolean> {
  return (await resolveWhisperPath()) !== null
}

export function resetWhisperCache(): void {
  cachedPath = undefined
}
