import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import type { Transcript } from '@shared/types'
import { logger } from '../lib/logger'

const SCOPE = 'transcript-store'

/**
 * Where a finished transcript is kept.
 *
 * On disk beside the recording's other derived data, as one JSON file per
 * recording. A local file and not the database, because transcribing was chosen
 * to run locally: sending the audio nowhere and then posting every word of it to
 * a server would give back exactly what that choice was protecting.
 *
 * Small enough for this to be the obvious answer — an hour of conversation is a
 * few tens of kilobytes of text, against the gigabytes of video it describes.
 * Deleted with the recording, like the thumbnail and the voice track.
 */

function transcriptDirectory(): string {
  const dir = join(app.getPath('userData'), 'Transcripts')
  mkdirSync(dir, { recursive: true })
  return dir
}

function transcriptPathFor(id: string): string {
  return join(transcriptDirectory(), `${id}.json`)
}

export function hasTranscript(id: string): boolean {
  return existsSync(transcriptPathFor(id))
}

/** Returns the stored transcript, or null when there is none to return. */
export async function readTranscript(id: string): Promise<Transcript | null> {
  try {
    const raw = await fsp.readFile(transcriptPathFor(id), 'utf8')
    return JSON.parse(raw) as Transcript
  } catch {
    // Missing is the ordinary case; unreadable is rare and answered the same
    // way — offer to transcribe it again.
    return null
  }
}

export async function writeTranscript(transcript: Transcript): Promise<void> {
  const path = transcriptPathFor(transcript.id)
  await fsp.writeFile(path, JSON.stringify(transcript, null, 2), 'utf8')

  logger.info(SCOPE, 'Transcript saved', {
    id: transcript.id,
    lines: transcript.segments.length
  })
}

export async function deleteTranscript(id: string): Promise<void> {
  await fsp.unlink(transcriptPathFor(id)).catch(() => undefined)
}
