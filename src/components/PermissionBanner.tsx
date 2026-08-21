import type { MediaPermissions, PermissionKind } from '@shared/types'
import { Button } from '@/components/ui/Button'

interface PermissionBannerProps {
  permissions: MediaPermissions | null
  /** True when the user has asked for microphone audio in Settings. */
  microphoneWanted: boolean
  onOpenSettings: (kind: PermissionKind) => void
  onRecheck: () => void
}

/**
 * Explains a capture permission the OS is currently withholding.
 *
 * This only ever appears on macOS: Windows does not gate screen capture per
 * application, and Linux asks at capture time instead of storing a grant, so
 * both report `not-required` and nothing is rendered. Without it a blocked Mac
 * shows an empty source list and no reason for it — the failure looks like a
 * bug in the app rather than a switch waiting to be flipped.
 */
export function PermissionBanner({
  permissions,
  microphoneWanted,
  onOpenSettings,
  onRecheck
}: PermissionBannerProps): React.JSX.Element | null {
  if (!permissions) return null

  const screenBlocked = isBlocked(permissions.screen)
  const microphoneBlocked = microphoneWanted && isBlocked(permissions.microphone)

  if (!screenBlocked && !microphoneBlocked) return null

  // Screen capture is the one that stops a recording outright, so when both are
  // blocked it is the one to lead with.
  const kind: PermissionKind = screenBlocked ? 'screen' : 'microphone'

  return (
    <div className="rounded-2xl border border-record/40 bg-record/5 p-4">
      <div className="flex items-start gap-3">
        <LockIcon />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-record-strong">
            {screenBlocked
              ? 'macOS is blocking screen recording'
              : 'macOS is blocking the microphone'}
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            {screenBlocked
              ? 'Open System Settings → Privacy & Security → Screen Recording and switch Screen Recorder on. macOS only applies the change after the app is quit and reopened.'
              : 'Open System Settings → Privacy & Security → Microphone and switch Screen Recorder on. Recordings will otherwise have no narration.'}
          </p>

          {screenBlocked && microphoneBlocked && (
            <p className="mt-1 text-[11px] text-faint">
              The microphone is blocked too — the same Privacy &amp; Security screen has it.
            </p>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => onOpenSettings(kind)}>
              Open System Settings
            </Button>
            <Button size="sm" variant="ghost" onClick={onRecheck}>
              Check again
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * `not-determined` is deliberately not treated as blocked: the OS prompt has
 * simply not been raised yet, and it appears the moment capture is attempted.
 * Warning about it beforehand would be noise on a perfectly healthy machine.
 */
function isBlocked(state: MediaPermissions['screen']): boolean {
  return state === 'denied' || state === 'restricted'
}

const LockIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="mt-0.5 size-5 shrink-0 text-record"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M7 10V7a5 5 0 0 1 10 0v3M6 10h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"
    />
  </svg>
)
