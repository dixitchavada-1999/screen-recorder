import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { statSync } from 'node:fs'
import { QUALITIES, RESOLUTIONS, computeVideoBitrateKbps } from '@shared/presets'
import type { AppSettings, FinalizeRequest } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { listAvailableEncoders, resolveFfmpegPath } from './ffmpeg-locator'

const SCOPE = 'transcoder'

export interface TranscodeOptions {
  inputPath: string
  outputPath: string
  settings: AppSettings
  request: FinalizeRequest
  onProgress: (percent: number, detail: string) => void
}

export interface TranscodeOutcome {
  encoder: string
  usedFallbackEncoder: boolean
}

/**
 * Hardware encoders worth attempting per platform. VAAPI is deliberately
 * excluded: it needs an explicit render node and an hwupload filter chain,
 * which fails noisily on machines without a usable /dev/dri device.
 */
const HARDWARE_ENCODERS: Record<string, string[]> = {
  win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  linux: ['h264_nvenc', 'h264_qsv'],
  darwin: ['h264_videotoolbox']
}

/* -------------------------------------------------------------------------- */
/*                              Encoder selection                             */
/* -------------------------------------------------------------------------- */

/**
 * The renderer records H.264 whenever Chromium supports it. When the source is
 * already H.264 and no rescaling is requested, the video track is stream-copied
 * instead of re-encoded: near-instant finalisation, zero generation loss and
 * almost no CPU cost.
 */
function canStreamCopyVideo(request: FinalizeRequest, settings: AppSettings): boolean {
  const mime = request.mimeType.toLowerCase()
  const isH264 = mime.includes('h264') || mime.includes('avc1')
  if (!isH264) return false

  const target = RESOLUTIONS[settings.video.resolution]
  if (target.height === null) return true

  // Capture was already constrained to the target size by getUserMedia.
  return request.height <= target.height && request.width <= (target.width ?? request.width)
}

async function pickVideoEncoder(settings: AppSettings): Promise<string> {
  if (!settings.video.hardwareAcceleration) return 'libx264'

  const available = await listAvailableEncoders()
  const preferred = HARDWARE_ENCODERS[process.platform] ?? []

  for (const encoder of preferred) {
    if (available.has(encoder)) {
      logger.info(SCOPE, 'Hardware encoder available', { encoder })
      return encoder
    }
  }

  return 'libx264'
}

const isHardwareEncoder = (encoder: string): boolean => encoder !== 'libx264'

/* -------------------------------------------------------------------------- */
/*                              Argument building                             */
/* -------------------------------------------------------------------------- */

function buildArgs(options: TranscodeOptions, encoder: string, copyVideo: boolean): string[] {
  const { settings, request, inputPath, outputPath } = options
  const quality = QUALITIES[settings.video.quality]
  const target = RESOLUTIONS[settings.video.resolution]

  const args: string[] = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-nostats',
    // Machine-readable progress on stdout, so no ffprobe pass is needed.
    '-progress', 'pipe:1',
    // MediaRecorder output carries no container duration and can start with a
    // non-zero timestamp; regenerating presentation timestamps keeps A/V aligned.
    '-fflags', '+genpts',
    '-i', inputPath
  ]

  if (copyVideo) {
    args.push('-c:v', 'copy')
  } else {
    const bitrate = computeVideoBitrateKbps(
      settings.video.resolution,
      settings.video.fps,
      settings.video.quality
    )

    // Scale only when a fixed output size is requested. `-2` keeps the width
    // even (required by yuv420p) while preserving the source aspect ratio.
    if (target.height !== null) {
      args.push('-vf', `scale=-2:${target.height}:flags=bicubic`)
    }

    args.push('-c:v', encoder)

    if (isHardwareEncoder(encoder)) {
      // GPU encoders ignore CRF, so drive them with a VBR bitrate envelope.
      args.push(
        '-b:v', `${bitrate}k`,
        '-maxrate', `${Math.round(bitrate * 1.5)}k`,
        '-bufsize', `${bitrate * 2}k`
      )
    } else {
      args.push(
        '-preset', quality.x264Preset,
        '-crf', String(quality.crf),
        '-maxrate', `${Math.round(bitrate * 1.5)}k`,
        '-bufsize', `${bitrate * 2}k`
      )
    }

    args.push(
      // Normalise the variable-frame-rate capture to a constant output rate.
      '-r', String(settings.video.fps),
      // Required for playback in QuickTime, Windows Media Player and browsers.
      '-pix_fmt', 'yuv420p'
    )
  }

  if (request.hasAudio) {
    args.push('-c:a', 'aac', '-b:a', `${quality.audioKbps}k`, '-ar', '48000', '-ac', '2')
  } else {
    args.push('-an')
  }

  args.push(
    // Moves the MP4 index to the front so the file streams and previews well.
    '-movflags', '+faststart',
    outputPath
  )

  return args
}

/* -------------------------------------------------------------------------- */
/*                                  Execution                                 */
/* -------------------------------------------------------------------------- */

/** Tracks the running child so an app quit can terminate it cleanly. */
let activeChild: ChildProcessWithoutNullStreams | null = null

function runFfmpeg(
  binary: string,
  args: string[],
  durationMs: number,
  onProgress: (percent: number, detail: string) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    logger.debug(SCOPE, 'Spawning FFmpeg', { args })

    const child = spawn(binary, args, { windowsHide: true })
    activeChild = child

    let stderrTail = ''
    let stdoutBuffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk

      // `-progress` emits newline-delimited `key=value` pairs.
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const [key, value] = line.split('=')
        if (key !== 'out_time_us' || !value) continue

        const outMs = Number(value) / 1000
        if (!Number.isFinite(outMs) || durationMs <= 0) continue

        const percent = Math.min(99, Math.max(0, (outMs / durationMs) * 100))
        onProgress(percent, `Encoding ${formatClock(outMs)} of ${formatClock(durationMs)}`)
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Keep only the tail; a failing run can emit a lot of output.
      stderrTail = `${stderrTail}${chunk}`.slice(-4000)
    })

    child.on('error', (error) => {
      activeChild = null
      reject(
        new AppError(
          ERROR_CODES.FFMPEG_FAILED,
          `FFmpeg could not be started: ${error.message}`,
          'Verify the FFmpeg binary is present and executable.',
          { cause: error }
        )
      )
    })

    child.on('close', (code) => {
      activeChild = null
      if (code === 0) {
        resolve()
        return
      }
      reject(
        new AppError(
          ERROR_CODES.FFMPEG_FAILED,
          `FFmpeg exited with code ${code}: ${stderrTail.trim() || 'no error output'}`,
          'The raw recording was kept so the conversion can be retried.'
        )
      )
    })
  })
}

/**
 * Converts the intermediate capture file into a finished MP4.
 *
 * Falls back from a hardware encoder to libx264 automatically, because GPU
 * encoders can be advertised by FFmpeg yet fail at runtime (no driver, no free
 * encode session, headless machine).
 */
export async function transcodeToMp4(options: TranscodeOptions): Promise<TranscodeOutcome> {
  const binary = await resolveFfmpegPath()
  if (!binary) {
    throw new AppError(
      ERROR_CODES.FFMPEG_MISSING,
      'No FFmpeg binary was found.',
      process.platform === 'linux'
        ? 'Install it with: sudo apt install ffmpeg'
        : 'Reinstall the application, or set SCREEN_RECORDER_FFMPEG to an ffmpeg executable.'
    )
  }

  const sourceSize = statSync(options.inputPath).size
  if (sourceSize === 0) {
    throw new AppError(
      ERROR_CODES.SESSION_EMPTY,
      'The recording contains no data.',
      'This usually means capture permission was revoked before any frame arrived.'
    )
  }

  const copyVideo = canStreamCopyVideo(options.request, options.settings)
  const encoder = copyVideo ? 'copy' : await pickVideoEncoder(options.settings)

  logger.info(SCOPE, 'Starting conversion', {
    encoder,
    copyVideo,
    sourceSize,
    durationMs: options.request.durationMs
  })

  options.onProgress(1, copyVideo ? 'Remuxing to MP4' : `Encoding with ${encoder}`)

  try {
    await runFfmpeg(
      binary,
      buildArgs(options, encoder, copyVideo),
      options.request.durationMs,
      options.onProgress
    )
    return { encoder, usedFallbackEncoder: false }
  } catch (error) {
    // A hardware encoder failure is recoverable — retry on the CPU encoder.
    if (!copyVideo && isHardwareEncoder(encoder)) {
      logger.warn(SCOPE, 'Hardware encoder failed, retrying with libx264', error)
      options.onProgress(1, 'Hardware encoder unavailable, retrying on CPU')

      await runFfmpeg(
        binary,
        buildArgs(options, 'libx264', false),
        options.request.durationMs,
        options.onProgress
      )
      return { encoder: 'libx264', usedFallbackEncoder: true }
    }
    throw error
  }
}

/** Terminates a running conversion, e.g. when the user quits mid-encode. */
export function cancelActiveTranscode(): void {
  if (!activeChild) return
  logger.warn(SCOPE, 'Terminating active FFmpeg process')
  activeChild.kill('SIGKILL')
  activeChild = null
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}
