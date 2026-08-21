import type { OrphanRecording } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { formatBytes, formatTimestamp } from '@/utils/format'

interface RecoveryBannerProps {
  orphans: OrphanRecording[]
  busySessionId: string | null
  onRestore: (sessionId: string) => void
  onDiscard: (sessionId: string) => void
}

/**
 * Offers to salvage recordings whose conversion never completed — a crash, a
 * force-quit, or an FFmpeg failure. The raw capture is always kept on disk in
 * those cases, so nothing is lost until the user says so.
 */
export function RecoveryBanner({
  orphans,
  busySessionId,
  onRestore,
  onDiscard
}: RecoveryBannerProps): React.JSX.Element | null {
  if (orphans.length === 0) return null

  return (
    <div className="rounded-2xl border border-warning/30 bg-warning/5 p-4">
      <div className="flex items-start gap-3">
        <WarningIcon />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-warning">
            {orphans.length === 1
              ? 'An unfinished recording was found'
              : `${orphans.length} unfinished recordings were found`}
          </h2>
          <p className="mt-0.5 text-xs text-muted">
            These were captured but never converted. Recover them to MP4, or discard them to
            free the disk space.
          </p>

          <ul className="mt-3 flex flex-col gap-2">
            {orphans.map((orphan) => (
              <li
                key={orphan.sessionId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-xs text-ink">{formatTimestamp(orphan.createdAt)}</p>
                  <p className="text-[11px] text-faint">{formatBytes(orphan.sizeBytes)}</p>
                </div>

                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busySessionId === orphan.sessionId}
                    onClick={() => onRestore(orphan.sessionId)}
                  >
                    Recover
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busySessionId === orphan.sessionId}
                    onClick={() => onDiscard(orphan.sessionId)}
                  >
                    Discard
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

const WarningIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="mt-0.5 size-5 shrink-0 text-warning"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 9v4m0 4h.01M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"
    />
  </svg>
)
