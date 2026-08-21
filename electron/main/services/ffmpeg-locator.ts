import { app } from 'electron'
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logger } from '../lib/logger'

const SCOPE = 'ffmpeg-locator'
const execFileAsync = promisify(execFile)

/**
 * Resolves the FFmpeg binary to use, in priority order:
 *
 *  1. `SCREEN_RECORDER_FFMPEG` environment variable (explicit operator override)
 *  2. A binary dropped into the app's `ffmpeg/` folder (portable installs)
 *  3. The `ffmpeg-static` package, rewritten to its asar-unpacked location
 *  4. `ffmpeg` on the system PATH (typical on Ubuntu after `apt install ffmpeg`)
 *
 * The result is cached because probing spawns a process.
 */

let cachedPath: string | null | undefined
let cachedVersion: string | null = null

const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'

function isExecutable(candidate: string): boolean {
  try {
    if (!existsSync(candidate)) return false
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Files inside `app.asar` cannot be spawned. electron-builder is configured to
 * unpack `ffmpeg-static`, so the real binary lives in `app.asar.unpacked`.
 */
function unpackedPath(original: string): string {
  return original.includes('app.asar')
    ? original.replace('app.asar', 'app.asar.unpacked')
    : original
}

function candidatePaths(): string[] {
  const candidates: string[] = []

  const fromEnv = process.env.SCREEN_RECORDER_FFMPEG
  if (fromEnv) candidates.push(fromEnv)

  // Portable / side-loaded binary directory shipped with the app.
  const resourcesDir = app.isPackaged ? process.resourcesPath : app.getAppPath()
  candidates.push(join(resourcesDir, 'ffmpeg', binaryName))
  candidates.push(join(app.getAppPath(), 'ffmpeg', binaryName))

  try {
    // `ffmpeg-static` default-exports the absolute path to its bundled binary.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const staticPath = require('ffmpeg-static') as string | null
    if (staticPath) candidates.push(unpackedPath(staticPath))
  } catch (error) {
    logger.warn(SCOPE, 'ffmpeg-static is not installed', error)
  }

  return candidates
}

/** Returns the FFmpeg path, or `null` when no usable binary exists. */
export async function resolveFfmpegPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath

  for (const candidate of candidatePaths()) {
    if (isExecutable(candidate)) {
      cachedPath = candidate
      logger.info(SCOPE, 'Using bundled FFmpeg', { path: candidate })
      return cachedPath
    }
  }

  // Last resort: rely on PATH lookup.
  try {
    const { stdout } = await execFileAsync(binaryName, ['-version'], { timeout: 5000 })
    if (stdout.includes('ffmpeg version')) {
      cachedPath = binaryName
      logger.info(SCOPE, 'Using system FFmpeg from PATH')
      return cachedPath
    }
  } catch {
    /* not on PATH */
  }

  cachedPath = null
  logger.error(SCOPE, 'No FFmpeg binary could be located')
  return null
}

/** Human readable FFmpeg version string, for the About/Settings panel. */
export async function getFfmpegVersion(): Promise<string | null> {
  if (cachedVersion) return cachedVersion

  const binary = await resolveFfmpegPath()
  if (!binary) return null

  try {
    const { stdout } = await execFileAsync(binary, ['-version'], { timeout: 5000 })
    cachedVersion = stdout.split('\n')[0]?.trim() ?? null
    return cachedVersion
  } catch (error) {
    logger.warn(SCOPE, 'Could not read FFmpeg version', error)
    return null
  }
}

/**
 * Lists the encoder names FFmpeg was compiled with, used to pick a hardware
 * encoder when one is available.
 */
export async function listAvailableEncoders(): Promise<Set<string>> {
  const binary = await resolveFfmpegPath()
  if (!binary) return new Set()

  try {
    const { stdout } = await execFileAsync(binary, ['-hide_banner', '-encoders'], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024
    })

    const names = new Set<string>()
    for (const line of stdout.split('\n')) {
      // Format: " V....D h264_nvenc  NVIDIA NVENC H.264 encoder"
      const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line)
      if (match?.[1]) names.add(match[1])
    }
    return names
  } catch (error) {
    logger.warn(SCOPE, 'Could not enumerate encoders', error)
    return new Set()
  }
}

/** Clears the cache — used by tests and after a settings-driven path change. */
export function resetFfmpegCache(): void {
  cachedPath = undefined
  cachedVersion = null
}
