import { shell, systemPreferences } from 'electron'
import type { MediaPermissionState, MediaPermissions, PermissionKind } from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'

const SCOPE = 'permissions'

/**
 * macOS media permissions.
 *
 * Windows and Linux do not gate screen capture per application: on Windows the
 * desktop is simply capturable, and on Linux the compositor asks at capture
 * time (the Wayland portal dialog) rather than storing a per-app grant. macOS
 * is the outlier — it refuses silently, handing back black frames or an empty
 * source list, until the app is ticked in System Settings. Everything here
 * exists to turn that silent refusal into something the user can act on.
 */

const gated = process.platform === 'darwin'

/** Deep links into the exact privacy pane, so nobody has to go hunting. */
const PRIVACY_PANES: Record<PermissionKind, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
}

function read(kind: 'screen' | 'microphone'): MediaPermissionState {
  if (!gated) return 'not-required'

  try {
    return systemPreferences.getMediaAccessStatus(kind) as MediaPermissionState
  } catch (error) {
    logger.warn(SCOPE, 'Could not read media access status', { kind, error })
    return 'unknown'
  }
}

/**
 * Whether macOS trusts this app to see input in other applications.
 *
 * Not a media permission, and not readable through `getMediaAccessStatus` —
 * Accessibility is its own thing, with only two states as far as this app is
 * concerned: trusted, or not. There is no "not yet decided" to distinguish,
 * because macOS never asks on its own.
 *
 * `false` is passed so that merely reading it does not raise the system prompt.
 * Asking is `requestAccessibilityAccess`, and it happens when somebody presses
 * a button.
 */
function readAccessibility(): MediaPermissionState {
  if (!gated) return 'not-required'

  try {
    return systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied'
  } catch (error) {
    logger.warn(SCOPE, 'Could not read accessibility trust', error)
    return 'unknown'
  }
}

export function getMediaPermissions(): MediaPermissions {
  return {
    screen: read('screen'),
    microphone: read('microphone'),
    accessibility: readAccessibility()
  }
}

/**
 * Raises the macOS prompt that offers to open Accessibility settings.
 *
 * The prompt is the only one macOS provides here, and it does not grant
 * anything — it points at System Settings, where the switch is. Granting also
 * requires the app to be restarted before the hook starts receiving events,
 * which is macOS's behaviour and not something this app can work around.
 */
export function requestAccessibilityAccess(): MediaPermissions {
  if (gated && readAccessibility() !== 'granted') {
    try {
      systemPreferences.isTrustedAccessibilityClient(true)
      logger.info(SCOPE, 'Accessibility prompt raised')
    } catch (error) {
      logger.warn(SCOPE, 'Accessibility prompt failed', error)
    }
  }

  return getMediaPermissions()
}

/**
 * Shows the microphone prompt the first time, then reports the outcome.
 *
 * Once the user has answered, macOS never prompts again — the only way back is
 * System Settings — so an already-decided permission is returned untouched
 * rather than being asked for a second time.
 */
export async function requestMicrophoneAccess(): Promise<MediaPermissions> {
  if (gated && read('microphone') === 'not-determined') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      logger.info(SCOPE, 'Microphone prompt answered', { granted })
    } catch (error) {
      logger.warn(SCOPE, 'Microphone prompt failed', error)
    }
  }

  return getMediaPermissions()
}

export async function openPrivacySettings(kind: PermissionKind): Promise<void> {
  if (!gated) {
    logger.debug(SCOPE, 'No privacy pane to open on this platform', { kind })
    return
  }

  await shell.openExternal(PRIVACY_PANES[kind])
  logger.info(SCOPE, 'Opened privacy settings', { kind })
}

/**
 * Fails early when macOS has refused screen recording.
 *
 * `not-determined` is deliberately let through: the very next `desktopCapturer`
 * call is what makes macOS raise its prompt, and blocking here would mean the
 * user is never asked at all.
 */
export function assertScreenCaptureAllowed(): void {
  const status = read('screen')
  if (status !== 'denied' && status !== 'restricted') return

  throw new AppError(
    ERROR_CODES.PERMISSION_DENIED,
    'macOS is blocking screen recording for this app.',
    'Open System Settings → Privacy & Security → Screen Recording, switch Screen Recorder on, then quit and reopen the app.'
  )
}

/** Platform-appropriate advice for a capture that produced nothing. */
export function captureTroubleshootingHint(): string | undefined {
  switch (process.platform) {
    case 'darwin':
      return 'Check System Settings → Privacy & Security → Screen Recording, then restart the app.'
    case 'linux':
      return 'On Wayland, screen sharing requires the xdg-desktop-portal package.'
    default:
      return undefined
  }
}
