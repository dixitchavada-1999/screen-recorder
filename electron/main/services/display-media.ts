import { desktopCapturer, session } from 'electron'
import { logger } from '../lib/logger'

const SCOPE = 'display-media'

/**
 * Source the renderer intends to capture on its next `getDisplayMedia()` call.
 *
 * The modern `getDisplayMedia` API does not let the page name a source — the
 * main process answers the request instead. The renderer therefore records its
 * choice here first. This path is the fallback used when the legacy
 * `chromeMediaSource` constraints are unavailable.
 */
let pendingSourceId: string | null = null
let pendingWantsLoopback = false

export function setPendingDisplayMediaSource(sourceId: string, wantsLoopback: boolean): void {
  pendingSourceId = sourceId
  pendingWantsLoopback = wantsLoopback
}

export function clearPendingDisplayMediaSource(): void {
  pendingSourceId = null
  pendingWantsLoopback = false
}

/**
 * Wires up media permissions for the app's own content.
 *
 * Only the packaged renderer origin is trusted; any other origin (which should
 * never occur, since external navigation is blocked) is denied.
 */
export function configureMediaAccess(): void {
  const defaultSession = session.defaultSession

  /**
   * Only the permissions this app genuinely needs are granted; everything else
   * (geolocation, notifications, MIDI, ...) is refused.
   *
   * `fullscreen` is required for the video player's own fullscreen button —
   * without it Chromium's `requestFullscreen()` promise never settles and the
   * control silently does nothing.
   */
  const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'fullscreen'])

  defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ALLOWED_PERMISSIONS.has(permission)
    if (!allowed) {
      logger.warn(SCOPE, 'Denied permission request', { permission })
    }
    callback(allowed)
  })

  // Synchronous permission checks use a narrower permission union than the
  // request handler above; screen capture surfaces here as 'media'.
  defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'fullscreen'
  })

  defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        try {
          const sources = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 0, height: 0 }
          })

          const chosen =
            sources.find((source) => source.id === pendingSourceId) ?? sources[0]

          if (!chosen) {
            logger.error(SCOPE, 'getDisplayMedia requested but no source is available')
            // Electron's typings require a stream; an empty object cancels it.
            callback({})
            return
          }

          logger.debug(SCOPE, 'Answering getDisplayMedia', {
            id: chosen.id,
            loopback: pendingWantsLoopback
          })

          callback({
            video: chosen,
            // 'loopback' captures system audio. Supported on Windows; on Linux
            // Chromium ignores it, which is why the renderer falls back to a
            // PulseAudio monitor input device there.
            ...(pendingWantsLoopback ? { audio: 'loopback' as const } : {})
          })
        } catch (error) {
          logger.error(SCOPE, 'Failed to answer getDisplayMedia', error)
          callback({})
        }
      })()
    },
    // The app renders its own source picker, so the OS picker stays disabled.
    { useSystemPicker: false }
  )

  logger.info(SCOPE, 'Media access handlers configured')
}
