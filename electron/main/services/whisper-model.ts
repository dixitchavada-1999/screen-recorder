import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AppError, ERROR_CODES } from '../lib/errors'
import type { WhisperModelKey, WhisperModelStatus } from '@shared/types'
import { logger } from '../lib/logger'

const SCOPE = 'whisper-model'

/**
 * The speech models whisper.cpp reads, and getting them onto the machine.
 *
 * Downloaded on first use rather than shipped. The installer is already north
 * of a hundred megabytes, and the useful models run from sixty to five hundred
 * more — bundling one would double the download for everybody, including the
 * people who never transcribe anything. It also means the choice can change
 * without a release.
 *
 * Multilingual, and quantised. The English-only `.en` builds are better at
 * English for the same size, and useless for anything else — they answer a
 * Gujarati recording with "(singing in foreign language)" rather than words,
 * which is not a quality difference but a wall. Whichever language somebody
 * actually speaks has to work, so the multilingual weights it is.
 *
 * `q5_1` is about half the size of the full weights for a difference that does
 * not show up in a conversation.
 *
 * Worth knowing about the smaller models and the languages Whisper saw least
 * of: on Gujarati, `small` tends to answer in Devanagari — recognisably the
 * right sounds, the wrong script — where `medium` mostly does not. For those
 * languages the size difference is not a nicety.
 */

/** Where the weights come from — the project's own published models. */
const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

interface ModelDefinition {
  key: WhisperModelKey
  file: string
  label: string
  /** Roughly, for the download prompt. The real size comes from the server. */
  approxMb: number
  note: string
}

export const WHISPER_MODELS: ReadonlyArray<ModelDefinition> = [
  {
    key: 'base',
    file: 'ggml-base-q5_1.bin',
    label: 'Base',
    approxMb: 57,
    note: 'Fastest. Fine for clear English, weak on anything else.'
  },
  {
    key: 'small',
    file: 'ggml-small-q5_1.bin',
    label: 'Small',
    approxMb: 182,
    note: 'The balance most people want, and the default.'
  },
  {
    key: 'medium',
    file: 'ggml-medium-q5_0.bin',
    label: 'Medium',
    approxMb: 514,
    note: 'Several times slower, and the first one to get Indic languages right.'
  }
]

export const DEFAULT_MODEL: WhisperModelKey = 'small'

function definitionOf(key: WhisperModelKey): ModelDefinition {
  const found = WHISPER_MODELS.find((model) => model.key === key)
  if (!found) throw new AppError(ERROR_CODES.UNKNOWN, `Unknown speech model ${key}.`)
  return found
}

function modelDirectory(): string {
  const dir = join(app.getPath('userData'), 'Models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function modelPath(key: WhisperModelKey): string {
  return join(modelDirectory(), definitionOf(key).file)
}

/** A model counts as present only once it is whole — see `downloadModel`. */
export function hasModel(key: WhisperModelKey): boolean {
  try {
    return existsSync(modelPath(key)) && statSync(modelPath(key)).size > 0
  } catch {
    return false
  }
}

export function modelStatuses(): WhisperModelStatus[] {
  return WHISPER_MODELS.map((model) => ({
    key: model.key,
    label: model.label,
    note: model.note,
    approxMb: model.approxMb,
    installed: hasModel(model.key),
    sizeBytes: hasModel(model.key) ? statSync(modelPath(model.key)).size : 0
  }))
}

/* -------------------------------------------------------------------------- */

/** One download at a time, so two windows cannot fight over the same file. */
let inFlight: Map<WhisperModelKey, Promise<void>> = new Map()

/**
 * Fetches a model, reporting progress as it goes.
 *
 * Written to a `.part` file and renamed only once the whole thing has arrived,
 * because a half-downloaded model is worse than none: whisper.cpp would load it,
 * fail somewhere inside, and the failure would look like a bug in transcription
 * rather than an interrupted download. The rename is what makes a model exist.
 *
 * The expected size comes from the server rather than from a number written
 * here — a hard-coded length would go stale the day the models are rebuilt, and
 * `content-length` is the same source the browser would trust.
 */
export async function downloadModel(
  key: WhisperModelKey,
  onProgress?: (received: number, total: number) => void
): Promise<void> {
  if (hasModel(key)) return

  const running = inFlight.get(key)
  if (running) return running

  const task = run(key, onProgress).finally(() => inFlight.delete(key))
  inFlight.set(key, task)
  return task
}

async function run(
  key: WhisperModelKey,
  onProgress?: (received: number, total: number) => void
): Promise<void> {
  const definition = definitionOf(key)
  const destination = modelPath(key)
  const partial = `${destination}.part`
  const url = `${BASE_URL}/${definition.file}`

  logger.info(SCOPE, 'Downloading speech model', { key, url })

  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'The speech model could not be downloaded.',
      'Check the connection and try again.',
      { cause: error }
    )
  }

  if (!response.ok || !response.body) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      `The speech model could not be downloaded (${response.status}).`,
      'The model host may be temporarily unavailable.'
    )
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0

  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    received += chunk.byteLength
    onProgress?.(received, total)
  })

  try {
    await pipeline(body, createWriteStream(partial, { flags: 'w' }))

    /*
     * A short file means the connection dropped part-way. `pipeline` reports
     * that as success — the stream ended, after all — so the length is the only
     * thing that can tell a finished download from an interrupted one.
     */
    if (total > 0 && statSync(partial).size !== total) {
      throw new AppError(
        ERROR_CODES.UNKNOWN,
        'The speech model download was cut short.',
        'Try again — it will start over.'
      )
    }

    await fsp.rename(partial, destination)
    logger.info(SCOPE, 'Speech model ready', { key, mb: Math.round(received / 1_048_576) })
  } catch (error) {
    await fsp.unlink(partial).catch(() => undefined)
    if (error instanceof AppError) throw error
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'The speech model could not be saved.',
      'Check there is room on the disk, then try again.',
      { cause: error }
    )
  }
}

/** Removes a downloaded model, freeing its space. */
export async function deleteModel(key: WhisperModelKey): Promise<void> {
  await fsp.unlink(modelPath(key)).catch(() => undefined)
  logger.info(SCOPE, 'Speech model removed', { key })
}
