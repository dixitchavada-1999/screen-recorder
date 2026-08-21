import { desktopCapturer, screen } from 'electron'
import type { CaptureSource } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { assertScreenCaptureAllowed, captureTroubleshootingHint } from './permissions'

const SCOPE = 'sources'

/** Id prefix of the display placeholders handed out on Wayland. */
const PLACEHOLDER_PREFIX = 'display:'

/**
 * True when screen capture has to go through xdg-desktop-portal.
 *
 * On a Wayland session nothing may read the screen directly: every capture
 * request — including merely *enumerating* the sources — opens a portal
 * session, and the compositor (GNOME Shell) puts up its own "Share Screen"
 * consent dialog for it. That prompt cannot be suppressed from inside the app,
 * so the aim is to trigger it exactly once, when the user actually starts a
 * recording, instead of every time the app wants to know what screens exist.
 */
export function usesPortalCapture(): boolean {
  if (process.platform !== 'linux') return false
  return process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)
}

export interface ListSourcesOptions {
  /**
   * Thumbnail width in pixels; height follows the source aspect ratio.
   * Pass `0` to skip thumbnail generation entirely, which is much cheaper —
   * every thumbnail is a real capture of that surface.
   */
  thumbnailWidth?: number
  /** Include individual windows alongside whole screens. Off by default. */
  includeWindows?: boolean
}

/**
 * Returns the list the source picker is built from.
 *
 * On Wayland this deliberately avoids `desktopCapturer`: the display list is
 * enough to name the screens, and asking the portal would cost a consent
 * dialog before the user has done anything. See `usesPortalCapture()`.
 */
export async function listCaptureSources(
  options: ListSourcesOptions = {}
): Promise<CaptureSource[]> {
  // Windows can only be enumerated by a real capture session, so an explicit
  // request for them still goes through the portal.
  if (usesPortalCapture() && !options.includeWindows) {
    const placeholders = listDisplayPlaceholders()
    if (placeholders.length > 0) return placeholders

    logger.warn(SCOPE, 'No displays reported, falling back to portal enumeration')
  }

  return enumerateCaptureSources(options)
}

/**
 * Names the screens from the display list rather than from a capture session.
 *
 * These entries carry no usable `chromeMediaSourceId` — `resolveCaptureSource`
 * exchanges the chosen one for a real source when recording starts.
 */
function listDisplayPlaceholders(): CaptureSource[] {
  const displays = screen.getAllDisplays()

  return displays.map((display, index) => ({
    id: `${PLACEHOLDER_PREFIX}${display.id}`,
    name: friendlyName(`Screen ${index + 1}`, 'screen', String(display.id), displays),
    kind: 'screen' as const,
    thumbnail: null,
    displayId: String(display.id),
    placeholder: true
  }))
}

/**
 * Exchanges a picked entry for a source `getUserMedia` can open.
 *
 * On Wayland this is the first and only time the portal is touched, so the
 * consent dialog appears here — at the start of a recording. On every other
 * platform the selection is already a real source and this is a cheap
 * revalidation, which also catches a window that was closed and reopened.
 */
export async function resolveCaptureSource(sourceId: string): Promise<CaptureSource> {
  const isPlaceholder = sourceId.startsWith(PLACEHOLDER_PREFIX)

  const sources = await enumerateCaptureSources({
    thumbnailWidth: 0,
    // A placeholder always stands for a whole screen, and enumerating windows
    // costs a capture each — so only ask for them when one was picked.
    includeWindows: !isPlaceholder
  })

  const exact = sources.find((source) => source.id === sourceId)
  if (exact) return exact

  const wantedDisplayId = isPlaceholder ? sourceId.slice(PLACEHOLDER_PREFIX.length) : null
  const byDisplay = wantedDisplayId
    ? sources.find((source) => source.kind === 'screen' && source.displayId === wantedDisplayId)
    : undefined
  if (byDisplay) return byDisplay

  // Wayland hands back whatever the user chose in the portal dialog, and that
  // source may carry no display id at all — the compositor's pick wins there.
  const fallback = sources.find((source) => source.kind === 'screen') ?? sources[0]
  if (fallback) {
    logger.warn(SCOPE, 'Picked source was unavailable, using another', {
      requested: sourceId,
      using: fallback.id
    })
    return fallback
  }

  throw new AppError(
    ERROR_CODES.NO_CAPTURE_SOURCE,
    'The selected screen is no longer available.',
    'Pick a source again, then start the recording.'
  )
}

/**
 * Enumerates capturable screens and windows.
 *
 * `desktopCapturer` is main-process only by design — exposing it to the
 * renderer would let page content enumerate the user's windows. The renderer
 * receives ids and thumbnails and passes the chosen id back through
 * `getUserMedia`.
 */
async function enumerateCaptureSources(
  options: ListSourcesOptions = {}
): Promise<CaptureSource[]> {
  const thumbnailWidth = options.thumbnailWidth ?? 0
  const thumbnailHeight = Math.round((thumbnailWidth * 9) / 16)

  // macOS answers a refused capture with an empty list rather than an error,
  // which would surface as "no screens found" and send the user looking in the
  // wrong place. Checking first names the real cause.
  assertScreenCaptureAllowed()

  try {
    const raw = await desktopCapturer.getSources({
      // Whole screens only unless windows are explicitly requested: the UI
      // records a monitor, and enumerating windows costs a capture each.
      types: options.includeWindows ? ['screen', 'window'] : ['screen'],
      thumbnailSize: { width: thumbnailWidth, height: thumbnailHeight },
      fetchWindowIcons: false
    })

    const displays = screen.getAllDisplays()

    const sources: CaptureSource[] = raw
      // Skip the recorder's own window so users cannot create a hall of mirrors.
      .filter((source) => !source.name.startsWith('Screen Recorder'))
      .map((source) => {
        const kind = source.id.startsWith('screen:') ? 'screen' : 'window'
        const displayId = source.display_id || null

        return {
          id: source.id,
          name: friendlyName(source.name, kind, displayId, displays),
          kind,
          thumbnail: source.thumbnail.isEmpty() ? null : source.thumbnail.toDataURL(),
          displayId
        } satisfies CaptureSource
      })

    if (sources.length === 0) {
      throw new AppError(
        ERROR_CODES.NO_CAPTURE_SOURCE,
        'No capturable screens or windows were found.',
        captureTroubleshootingHint()
      )
    }

    // Screens first, then windows, each alphabetically.
    return sources.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'screen' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  } catch (error) {
    if (error instanceof AppError) throw error

    logger.error(SCOPE, 'Failed to enumerate capture sources', error)
    throw new AppError(
      ERROR_CODES.NO_CAPTURE_SOURCE,
      'Could not read the list of capturable sources.',
      process.platform === 'linux'
        ? 'Install xdg-desktop-portal and xdg-desktop-portal-gtk, then restart the app.'
        : (captureTroubleshootingHint() ??
          'Check that screen recording permission is granted to this application.'),
      { cause: error }
    )
  }
}

/**
 * Electron reports screens as "Screen 1"/"Entire screen". Annotating them with
 * the real resolution makes multi-monitor setups far easier to tell apart.
 */
function friendlyName(
  name: string,
  kind: 'screen' | 'window',
  displayId: string | null,
  displays: Electron.Display[]
): string {
  if (kind !== 'screen') return name

  const display = displays.find((item) => String(item.id) === displayId)
  if (!display) return name

  const { width, height } = display.size
  const primary = display.id === screen.getPrimaryDisplay().id ? ' • Primary' : ''
  return `${name} (${width} × ${height})${primary}`
}
