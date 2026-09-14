import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { logger } from '../lib/logger'

const SCOPE = 'voice-track'

/**
 * The hard-panned audio kept beside a recording, for transcribing it later.
 *
 * Written by the mixer's second output: microphone fully left, system audio
 * fully right. Once those two are mixed there is no separating them again, so
 * the moment to keep them apart is while they still are — and knowing which
 * side of a conversation said what is most of what makes a transcript worth
 * reading.
 *
 * Derived data, and treated as such. It lives in `userData` rather than beside
 * the video, keyed by the recording's catalogue id, exactly like a thumbnail —
 * so it is never something a person finds in their Documents folder wondering
 * what wrote it, and it goes when the recording goes.
 *
 * Small enough not to argue about: audio-only Opus is around half a megabyte a
 * minute, against roughly forty-four for the video it sits next to.
 */

/** Marks the scratch file so the orphan scan can tell it from a real capture. */
export const VOICE_TEMP_SUFFIX = '.voice.webm'

function voiceCacheDirectory(): string {
  const dir = join(app.getPath('userData'), 'Voice')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Where a finished recording's voice track lives, by catalogue id. */
export function voicePathFor(recordingId: string): string {
  return join(voiceCacheDirectory(), `${recordingId}.webm`)
}

export function hasVoiceTrack(recordingId: string): boolean {
  const path = voicePathFor(recordingId)
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

/**
 * Moves the scratch file into the cache under the recording's id.
 *
 * Answers whether there is now a voice track to transcribe. A recording with no
 * audio at all never produced one, and that is an ordinary outcome rather than
 * a failure — a silent screen capture has nothing to say.
 *
 * Never throws. Losing the voice track costs a transcript; letting that failure
 * escape would cost the recording, which is the thing that actually matters.
 */
export async function adoptVoiceTrack(
  tempPath: string | null,
  recordingId: string
): Promise<boolean> {
  if (!tempPath || !existsSync(tempPath)) return false

  try {
    if (statSync(tempPath).size === 0) {
      await fsp.unlink(tempPath).catch(() => undefined)
      return false
    }

    const destination = voicePathFor(recordingId)

    try {
      await fsp.rename(tempPath, destination)
    } catch {
      // `rename` cannot cross a device boundary, and the scratch directory is
      // not always on the same volume as `userData`.
      await fsp.copyFile(tempPath, destination)
      await fsp.unlink(tempPath).catch(() => undefined)
    }

    logger.info(SCOPE, 'Voice track kept', {
      recordingId,
      kb: Math.round(statSync(destination).size / 1024)
    })
    return true
  } catch (error) {
    logger.warn(SCOPE, 'Voice track could not be kept', { recordingId, error })
    await fsp.unlink(tempPath).catch(() => undefined)
    return false
  }
}

/** Drops a recording's voice track. Silent when there was never one. */
export async function deleteVoiceTrack(recordingId: string): Promise<void> {
  await fsp.unlink(voicePathFor(recordingId)).catch(() => undefined)
}
