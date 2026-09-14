import { app, BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { cpus } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '@shared/ipc'
import type {
  Transcript,
  TranscriptProgress,
  TranscriptSegment,
  TranscriptSpeaker,
  TranscriptStage,
  WhisperModelKey
} from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { resolveFfmpegPath } from './ffmpeg-locator'
import { settingsStore } from './settings-store'
import { hasVoiceTrack, voicePathFor } from './voice-track'
import { resolveWhisperPath } from './whisper-locator'
import { DEFAULT_MODEL, downloadModel, hasModel, modelPath } from './whisper-model'

const execFileAsync = promisify(execFile)
const SCOPE = 'transcribe'

/**
 * Turns audio into text, on this machine.
 *
 * Two sources, one pipeline. The app's own recordings arrive with the two sides
 * of the conversation already on separate channels — the mixer put the
 * microphone hard left and system sound hard right — so each is read on its own
 * and every line knows who said it. A file brought in from elsewhere is usually
 * one mixed stream, and there the honest answer about who spoke is that we
 * cannot tell.
 *
 * The transcript is always English, whatever was spoken. Whisper can either
 * write down what it hears or translate as it goes, and the second is what is
 * asked for here: recordings are in whatever language the people on them speak,
 * and one readable language afterwards is the point. It costs nothing extra —
 * the translation happens inside the same pass, not in a second one.
 *
 * Nothing leaves the computer.
 *
 * One job at a time, deliberately. whisper.cpp takes every core it is given and
 * this runs on the machine somebody is working on; two transcriptions racing
 * would not finish sooner, they would just make the rest of the desktop stutter
 * for twice as long.
 */

/** Threads left for everything else. Transcription is never the urgent task. */
const SPARE_CORES = 2

/**
 * Below this, a channel is treated as having nothing on it.
 *
 * Digital silence measures around -91 dB and a quiet room around -50; real
 * speech, even distant, sits well above both. Skipping a silent channel halves
 * the work on the common recording where only one side ever spoke.
 */
const SILENCE_DB = -50

/**
 * What whisper.cpp emits when it hears something that is not speech.
 *
 * It marks music and silence rather than staying quiet, which is the right
 * choice for a subtitle file and the wrong one for a conversation: a transcript
 * padded with a hundred `[Music]` lines buries the handful that are words.
 */
const NOT_SPEECH = /^[\s♪]*(\[[^\]]*\]|\([^)]*\))?[\s♪]*$/

interface Job {
  id: string
  model: WhisperModelKey
  cancelled: boolean
  child: ReturnType<typeof spawn> | null
}

/** One channel of audio, and who — if anyone — it can be attributed to. */
interface Side {
  speaker: TranscriptSpeaker
  wav: string
}

let active: Job | null = null

/* -------------------------------------------------------------------------- */

export function transcriptIsRunning(id?: string): boolean {
  if (!active) return false
  return id ? active.id === id : true
}

/** Stops the running job. The partial output is discarded, not saved. */
export function cancelTranscript(id: string): void {
  if (!active || active.id !== id) return

  active.cancelled = true
  active.child?.kill()
  logger.info(SCOPE, 'Transcription cancelled', { id })
}

/** A stable id for a file, so the same one is never transcribed twice. */
export function fileIdFor(path: string): string {
  // Size as well as path: a different file written over the same name is a
  // different recording, and should not inherit the old transcript.
  const size = existsSync(path) ? statSync(path).size : 0
  return createHash('sha1').update(`${path}:${size}`).digest('hex').slice(0, 24)
}

/**
 * The transcript for one of this app's own recordings.
 *
 * Every reason it cannot run is answered before work starts, because each has a
 * different thing for somebody to do about it — install the engine, wait for a
 * model, record with a microphone next time.
 */
export async function transcribeRecording(
  recordingId: string,
  model: WhisperModelKey = settingsStore.get().transcript?.model ?? DEFAULT_MODEL
): Promise<Transcript> {
  if (!hasVoiceTrack(recordingId)) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'This recording has no audio to transcribe.',
      'It was captured with the microphone and system sound switched off.'
    )
  }

  return run(recordingId, '', model, async (ffmpeg, job, scratch) => {
    report(job, 'splitting', null, 'Preparing the audio')

    /*
     * Always split, and always with both speakers named.
     *
     * The mixer recorded the microphone hard left and system sound hard right,
     * so attribution here is a fact about which channel the sound arrived on
     * rather than a guess about whose voice it is.
     */
    const { left, right } = await splitChannels(ffmpeg, voicePathFor(recordingId), scratch)

    return sidesWithSound(ffmpeg, [
      { speaker: 'me', wav: left },
      { speaker: 'them', wav: right }
    ])
  })
}

/**
 * The transcript for a file brought in from elsewhere.
 *
 * Anything FFmpeg can open — a video container or a bare audio file. The id
 * comes from the path and size rather than being random, so opening the same
 * file again finds the transcript already made instead of spending another
 * twenty minutes producing the same words.
 */
export async function transcribeFile(
  path: string,
  model: WhisperModelKey = settingsStore.get().transcript?.model ?? DEFAULT_MODEL
): Promise<Transcript> {
  if (!existsSync(path)) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'That file is no longer there.')
  }

  return run(fileIdFor(path), basename(path), model, async (ffmpeg, job, scratch) => {
    report(job, 'splitting', null, 'Extracting the audio')

    const audio = join(scratch, 'audio.wav')

    /*
     * Extracted at 16 kHz but with the channel count left alone, because
     * whether there are two independent channels is the next question and
     * folding them together here would destroy the answer.
     */
    try {
      await execFileAsync(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', path,
        '-vn', '-ar', '16000', '-c:a', 'pcm_s16le', audio
      ])
    } catch {
      throw new AppError(
        ERROR_CODES.UNKNOWN,
        'No audio could be read from that file.',
        'It may be a format FFmpeg cannot open, or a video with no sound in it.'
      )
    }

    /*
     * Two channels carrying different things means somebody already recorded
     * the speakers apart — some call recorders and conferencing tools do — and
     * that deserves the same treatment as our own captures.
     *
     * Everything else is one mixed stream, and `unknown` is the honest answer
     * there. Telling two voices apart in a mix takes acoustic diarization,
     * which is inference rather than measurement; a confident wrong label is
     * worse than no label.
     */
    if (await channelsAreIndependent(ffmpeg, audio)) {
      logger.info(SCOPE, 'This file keeps its speakers on separate channels', { path })

      const { left, right } = await splitChannels(ffmpeg, audio, scratch)
      return sidesWithSound(ffmpeg, [
        { speaker: 'me', wav: left },
        { speaker: 'them', wav: right }
      ])
    }

    const mono = join(scratch, 'mono.wav')
    await execFileAsync(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', audio, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', mono
    ])

    return sidesWithSound(ffmpeg, [{ speaker: 'unknown', wav: mono }])
  })
}

/* -------------------------------------------------------------------------- */

/**
 * The part both sources share: the queue, the model, and the reading.
 *
 * `prepare` is the only difference between them — where the audio comes from,
 * and how it divides into sides. Everything after that is identical, which is
 * why it is written once.
 */
async function run(
  id: string,
  sourceName: string,
  model: WhisperModelKey,
  prepare: (ffmpeg: string, job: Job, scratch: string) => Promise<Side[]>
): Promise<Transcript> {
  if (active) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'Something else is being transcribed.',
      'They run one at a time so the machine stays usable. Try again when it finishes.'
    )
  }

  const whisper = await resolveWhisperPath()
  if (!whisper) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'The speech engine is not installed.',
      'Reinstall the app — whisper.cpp ships with it.'
    )
  }

  const ffmpeg = await resolveFfmpegPath()
  if (!ffmpeg) throw new AppError(ERROR_CODES.UNKNOWN, 'FFmpeg is not available.')

  const job: Job = { id, model, cancelled: false, child: null }
  active = job

  const startedAt = Date.now()
  const scratch = join(app.getPath('temp'), 'screen-recorder', `transcribe-${id}`)
  mkdirSync(scratch, { recursive: true })

  try {
    if (!hasModel(model)) {
      await downloadModel(model, (received, total) => {
        report(
          job,
          'downloading-model',
          total ? (received / total) * 100 : null,
          'Fetching the speech model'
        )
      })
    }

    if (job.cancelled) throw cancelled()

    const sides = await prepare(ffmpeg, job, scratch)

    if (sides.length === 0) {
      throw new AppError(
        ERROR_CODES.UNKNOWN,
        'There is no speech in this audio.',
        'Every channel is silent.'
      )
    }

    const segments: TranscriptSegment[] = []
    let detected = ''

    for (const [index, side] of sides.entries()) {
      if (job.cancelled) throw cancelled()

      report(
        job,
        'transcribing',
        (index / sides.length) * 100,
        sides.length > 1
          ? `Reading ${side.speaker === 'me' ? 'your side' : 'the other side'}`
          : 'Reading the audio'
      )

      const read = await runWhisper(job, whisper, model, side)
      segments.push(...read.segments)
      // Whichever side spoke first and was recognised names the language; the
      // other is usually the same, and occasionally silent.
      if (!detected && read.language) detected = read.language
    }

    /*
     * The sides share one clock, so ordering them is all the merging there is
     * to do — no alignment, no drift, because they came from one file.
     */
    segments.sort((a, b) => a.startMs - b.startMs)

    const transcript: Transcript = {
      id,
      sourceName,
      model,
      detectedLanguage: detected,
      createdAt: Date.now(),
      tookMs: Date.now() - startedAt,
      segments
    }

    report(job, 'done', 100, `${segments.length} lines`)
    logger.info(SCOPE, 'Transcript ready', {
      id,
      sourceName,
      model,
      detected,
      lines: segments.length,
      sides: sides.length,
      tookMs: transcript.tookMs
    })

    return transcript
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed'
    report(job, 'failed', null, message)
    throw error
  } finally {
    active = null
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Separates a stereo file into two mono files, as whisper.cpp wants them.
 *
 * 16 kHz mono PCM is not a preference — it is what whisper.cpp reads without
 * resampling internally, and the rate the model was trained at.
 *
 * `-ac 1` is correct *here* and only here: the channels have already been
 * separated by `channelsplit`, so this picks one rather than folding two
 * together. Applied before the split it would mix the speakers back into each
 * other and undo the entire point of keeping them apart.
 */
async function splitChannels(
  ffmpeg: string,
  source: string,
  scratch: string
): Promise<{ left: string; right: string }> {
  const left = join(scratch, 'left.wav')
  const right = join(scratch, 'right.wav')

  await execFileAsync(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', source,
    '-filter_complex', 'channelsplit=channel_layout=stereo[L][R]',
    '-map', '[L]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', left,
    '-map', '[R]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', right
  ])

  if (!existsSync(left) || !existsSync(right)) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'The audio could not be prepared for transcription.')
  }

  return { left, right }
}

/**
 * Drops the sides that carry nothing.
 *
 * A recording where nobody on the far end spoke — or where system sound was off
 * — has one empty channel, and reading it costs a full pass to learn that it is
 * empty.
 */
async function sidesWithSound(ffmpeg: string, candidates: Side[]): Promise<Side[]> {
  const kept: Side[] = []

  for (const side of candidates) {
    if (await hasSound(ffmpeg, side.wav)) kept.push(side)
  }

  return kept
}

/**
 * Whether a stereo file's two channels carry different things.
 *
 * Measured, not assumed. Summing and differencing two signals says how alike
 * they are: identical channels cancel to near silence when subtracted while
 * doubling when added, so the two measurements land tens of decibels apart.
 * Independent ones combine the same way in both directions, and the two
 * measurements come out together.
 *
 * A mono file has no second channel to compare and FFmpeg fails the filter
 * rather than inventing one — which is the same answer, arrived at by throwing.
 */
async function channelsAreIndependent(ffmpeg: string, wav: string): Promise<boolean> {
  try {
    const difference = await meanVolume(ffmpeg, wav, '0.5*c0-0.5*c1')
    const sum = await meanVolume(ffmpeg, wav, '0.5*c0+0.5*c1')

    if (difference === null || sum === null) return false

    // Six decibels of headroom: comfortably past measurement noise, nowhere
    // near the fifty-odd that identical channels produce.
    return sum - difference < 6
  } catch {
    return false
  }
}

async function meanVolume(ffmpeg: string, wav: string, pan: string): Promise<number | null> {
  const { stderr } = await execFileAsync(ffmpeg, [
    '-hide_banner', '-i', wav, '-af', `pan=mono|c0=${pan},volumedetect`, '-f', 'null', '-'
  ])

  const found = /mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr)
  return found ? Number(found[1]) : null
}

/** Whether a channel has anything worth reading, by peak level. */
async function hasSound(ffmpeg: string, wav: string): Promise<boolean> {
  try {
    const { stderr } = await execFileAsync(ffmpeg, [
      '-hide_banner', '-i', wav, '-af', 'volumedetect', '-f', 'null', '-'
    ])

    const peak = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/.exec(stderr)
    if (!peak) return true // An unreadable measurement is not evidence of silence.

    return Number(peak[1]) > SILENCE_DB
  } catch {
    // A failed measurement should not silently drop half a conversation.
    return true
  }
}

/** Runs whisper.cpp over one channel and reads back what it heard. */
async function runWhisper(
  job: Job,
  whisper: string,
  model: WhisperModelKey,
  side: Side
): Promise<{ segments: TranscriptSegment[]; language: string }> {
  const output = side.wav.replace(/\.wav$/, '')

  const args = [
    '-m', modelPath(model),
    '-f', side.wav,
    '-oj', '-of', output,
    '--no-prints',
    /*
     * Detect whatever is spoken, then hand back English.
     *
     * `-l auto` rather than a language somebody picks: a wrong pick does not
     * fail loudly, it produces the right words in the wrong script. `-tr` is
     * what makes the output English whatever went in, and it is a no-op on
     * audio that was English to begin with.
     */
    '-l', 'auto',
    '-tr',
    // Leave the machine usable. whisper.cpp would otherwise take every core.
    '-t', String(Math.max(1, cpus().length - SPARE_CORES))
  ]

  await new Promise<void>((resolve, reject) => {
    const child = spawn(whisper, args, { windowsHide: true })
    job.child = child

    let stderrTail = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000)
    })

    child.on('error', reject)
    child.on('close', (code) => {
      job.child = null

      if (job.cancelled) {
        reject(cancelled())
        return
      }
      if (code !== 0) {
        reject(
          new AppError(
            ERROR_CODES.UNKNOWN,
            'The speech engine failed.',
            stderrTail.trim().slice(-300) || `It exited with code ${code}.`
          )
        )
        return
      }
      resolve()
    })
  })

  return parse(`${output}.json`, side.speaker)
}

/**
 * Reads whisper.cpp's JSON into segments, dropping what is not speech.
 *
 * `offsets` are already milliseconds from the start of the file, and the file
 * starts when the recording does — so these line up with the video with no
 * arithmetic at all.
 */
async function parse(
  path: string,
  speaker: TranscriptSpeaker
): Promise<{ segments: TranscriptSegment[]; language: string }> {
  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf8')
  } catch {
    logger.warn(SCOPE, 'The speech engine wrote no output', { path })
    return { segments: [], language: '' }
  }

  const parsed = JSON.parse(raw) as {
    result?: { language?: string }
    transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>
  }

  const segments: TranscriptSegment[] = []

  for (const entry of parsed.transcription ?? []) {
    const text = (entry.text ?? '').trim()
    if (!text || NOT_SPEECH.test(text)) continue

    segments.push({
      speaker,
      startMs: Math.max(0, Math.round(entry.offsets?.from ?? 0)),
      endMs: Math.max(0, Math.round(entry.offsets?.to ?? 0)),
      text
    })
  }

  return { segments, language: parsed.result?.language ?? '' }
}

function cancelled(): AppError {
  return new AppError(ERROR_CODES.UNKNOWN, 'Transcription was cancelled.')
}

function report(job: Job, stage: TranscriptStage, percent: number | null, detail: string): void {
  const progress: TranscriptProgress = { id: job.id, stage, percent, detail }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.EVENT_TRANSCRIPT_PROGRESS, progress)
  }
}
