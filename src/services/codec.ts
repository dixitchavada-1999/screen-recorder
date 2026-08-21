import { log } from './ipc'

const SCOPE = 'codec'

export interface CodecChoice {
  mimeType: string
  /**
   * True when the container holds H.264 video, which lets the main process
   * stream-copy the video track into MP4 instead of re-encoding it.
   */
  h264: boolean
  label: string
}

/**
 * Candidate containers in preference order.
 *
 * H.264 is preferred over VP9 for one reason: MP4 output. An H.264 capture is
 * remuxed in a second with no quality loss and almost no CPU, whereas VP9 must
 * be fully transcoded. VP9/VP8 remain as fallbacks for builds of Chromium
 * without an H.264 encoder.
 */
const CANDIDATES: ReadonlyArray<{ mimeType: string; h264: boolean; label: string }> = [
  { mimeType: 'video/x-matroska;codecs=avc1,opus', h264: true, label: 'H.264 / Opus (Matroska)' },
  { mimeType: 'video/x-matroska;codecs=h264,opus', h264: true, label: 'H.264 / Opus (Matroska)' },
  { mimeType: 'video/webm;codecs=h264,opus', h264: true, label: 'H.264 / Opus (WebM)' },
  { mimeType: 'video/webm;codecs=vp9,opus', h264: false, label: 'VP9 / Opus (WebM)' },
  { mimeType: 'video/webm;codecs=vp8,opus', h264: false, label: 'VP8 / Opus (WebM)' },
  { mimeType: 'video/webm', h264: false, label: 'WebM (browser default)' }
]

let cached: CodecChoice | null = null

/** Returns the best container this Chromium build can actually record. */
export function pickRecordingCodec(): CodecChoice {
  if (cached) return cached

  for (const candidate of CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      cached = candidate
      log.info(SCOPE, 'Selected recording codec', candidate)
      return cached
    }
  }

  // Every known candidate was rejected; let MediaRecorder choose for itself.
  cached = { mimeType: '', h264: false, label: 'Browser default' }
  log.warn(SCOPE, 'No known codec supported, falling back to the default')
  return cached
}

/**
 * Bitrate handed to MediaRecorder for the intermediate capture.
 *
 * It is deliberately generous: this file is an intermediate, and starving it
 * would bake compression artefacts in before FFmpeg ever runs. When the capture
 * is H.264 the same bitrate carries straight through to the MP4.
 */
export function computeCaptureBitrate(
  width: number,
  height: number,
  fps: number,
  quality: 'low' | 'balanced' | 'high' | 'ultra'
): number {
  const pixels = Math.max(width * height, 1280 * 720)
  const factor = { low: 0.06, balanced: 0.1, high: 0.15, ultra: 0.22 }[quality]

  // bits/second ≈ pixels × fps × bits-per-pixel factor
  const bitsPerSecond = pixels * fps * factor

  // Clamp into a sane band so a 4K/60 capture cannot request 200 Mbps.
  return Math.round(Math.min(Math.max(bitsPerSecond, 1_500_000), 60_000_000))
}
