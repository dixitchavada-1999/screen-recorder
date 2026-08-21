import { RESOLUTIONS } from '@shared/presets'
import { ERROR_CODES } from '@shared/ipc'
import type { AppSettings, CaptureSource } from '@shared/types'
import { IpcError, log } from './ipc'
import { screenCaptureBlockedHint } from './platform'

const SCOPE = 'screen-capture'

/**
 * Electron's desktop capture constraints predate the standard
 * `getDisplayMedia` API and are not described by the DOM typings, so they are
 * modelled here rather than cast away at each call site.
 */
interface DesktopVideoConstraints {
  mandatory: {
    chromeMediaSource: 'desktop'
    chromeMediaSourceId: string
    maxWidth?: number
    maxHeight?: number
    maxFrameRate?: number
  }
}

interface DesktopAudioConstraints {
  mandatory: { chromeMediaSource: 'desktop' }
}

export interface ScreenCaptureResult {
  /** Video-only stream; audio is mixed separately and attached later. */
  videoStream: MediaStream
  /** Loopback track captured alongside the screen, when the platform allows. */
  loopbackTrack: MediaStreamTrack | null
  /** Actual capture dimensions reported by the video track. */
  width: number
  height: number
  /** Actual frame rate the compositor granted. */
  frameRate: number
}

/**
 * Captures the chosen screen or window.
 *
 * On Windows the same `getUserMedia` call also yields the desktop loopback
 * (system audio) track. Chromium only supports desktop loopback on Windows, so
 * elsewhere the request is made video-only and system audio is sourced from an
 * input device instead — a PulseAudio/PipeWire monitor on Linux, a virtual
 * device such as BlackHole on macOS. See `audio-devices.ts`.
 */
export async function captureScreen(
  source: CaptureSource,
  settings: AppSettings,
  options: { withLoopback: boolean }
): Promise<ScreenCaptureResult> {
  const target = RESOLUTIONS[settings.video.resolution]

  const videoConstraints: DesktopVideoConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: source.id,
      maxFrameRate: settings.video.fps,
      // Constraining at capture time is far cheaper than rescaling in FFmpeg:
      // the compositor downsamples on the GPU before frames ever reach us.
      ...(target.width !== null && target.height !== null
        ? { maxWidth: target.width, maxHeight: target.height }
        : {})
    }
  }

  const audioConstraints: DesktopAudioConstraints = {
    mandatory: { chromeMediaSource: 'desktop' }
  }

  let stream: MediaStream | null = null

  if (options.withLoopback) {
    try {
      stream = await requestStream(videoConstraints, audioConstraints)
      log.info(SCOPE, 'Captured screen with desktop loopback audio')
    } catch (error) {
      // Very common on Linux and on Windows machines with no active render
      // endpoint. Falling back keeps the recording alive without audio.
      log.warn(SCOPE, 'Desktop loopback capture unavailable, retrying video only', error)
      stream = null
    }
  }

  if (!stream) {
    stream = await requestStream(videoConstraints, null)
  }

  const [videoTrack] = stream.getVideoTracks()
  if (!videoTrack) {
    stopStream(stream)
    throw new IpcError({
      code: ERROR_CODES.CAPTURE_FAILED,
      message: 'The capture source produced no video track.',
      hint: 'Try selecting a different screen or window.'
    })
  }

  // Detach loopback audio from the video stream so the mixer owns all audio.
  const loopbackTrack = stream.getAudioTracks()[0] ?? null
  if (loopbackTrack) stream.removeTrack(loopbackTrack)

  const trackSettings = videoTrack.getSettings()

  return {
    videoStream: stream,
    loopbackTrack,
    width: trackSettings.width ?? target.width ?? 1920,
    height: trackSettings.height ?? target.height ?? 1080,
    frameRate: Math.round(trackSettings.frameRate ?? settings.video.fps)
  }
}

async function requestStream(
  video: DesktopVideoConstraints,
  audio: DesktopAudioConstraints | null
): Promise<MediaStream> {
  try {
    // The legacy constraint dictionary is intentionally not part of
    // MediaTrackConstraints; Electron reads it before Chromium validates.
    return await navigator.mediaDevices.getUserMedia({
      video,
      audio: audio ?? false
    } as unknown as MediaStreamConstraints)
  } catch (error) {
    throw translateCaptureError(error)
  }
}

function translateCaptureError(error: unknown): IpcError {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return new IpcError({
      code: ERROR_CODES.PERMISSION_DENIED,
      message: 'Screen recording permission was denied.',
      // Each platform refuses differently: macOS needs a switch in System
      // Settings and a restart, Wayland shows this for a dismissed portal
      // dialog, Windows for a policy-blocked capture.
      hint: screenCaptureBlockedHint()
    })
  }

  if (name === 'NotFoundError' || name === 'NotReadableError') {
    return new IpcError({
      code: ERROR_CODES.CAPTURE_FAILED,
      message: 'The selected source could no longer be captured.',
      hint: 'The window may have been closed. Refresh the source list.'
    })
  }

  return new IpcError({
    code: ERROR_CODES.CAPTURE_FAILED,
    message: `Screen capture failed: ${message}`
  })
}

/**
 * Opens desktop loopback (system audio) on its own, for the audio test.
 *
 * Chromium only grants desktop audio when a video track is requested in the
 * same call, so a deliberately tiny video track is taken and immediately
 * discarded. That keeps the probe cheap — no full-resolution capture pipeline
 * is spun up just to draw a level meter.
 */
export async function openDesktopLoopbackAudio(sourceId: string): Promise<MediaStream> {
  const stream = await requestStream(
    {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 160,
        maxHeight: 90,
        maxFrameRate: 1
      }
    },
    { mandatory: { chromeMediaSource: 'desktop' } }
  )

  for (const track of stream.getVideoTracks()) {
    stream.removeTrack(track)
    track.stop()
  }

  if (stream.getAudioTracks().length === 0) {
    stopStream(stream)
    throw new IpcError({
      code: ERROR_CODES.CAPTURE_FAILED,
      message: 'This machine did not provide a system-audio loopback stream.'
    })
  }

  return stream
}

/** Stops every track on a stream. Safe to call more than once. */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      /* already stopped */
    }
  }
}
