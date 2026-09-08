import type { UpdateStatus } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { cn } from '@/utils/cn'

interface UpdateBannerProps {
  status: UpdateStatus
  onDownload: () => void
  onInstall: () => void
}

/**
 * The one place this application asks to update itself.
 *
 * Renders nothing at all unless there is something to say — a version waiting,
 * a download running, or one finished. "You are up to date" is not news, and a
 * dashboard that carried that line permanently would be teaching people to look
 * past the very strip they are meant to notice.
 *
 * A failed check is also silence. The application still works, the user did not
 * ask for anything, and an unreachable server is not their problem to solve.
 */
export function UpdateBanner({
  status,
  onDownload,
  onInstall
}: UpdateBannerProps): React.JSX.Element | null {
  const { state, version, progress } = status

  if (state !== 'available' && state !== 'downloading' && state !== 'ready') return null

  const ready = state === 'ready'

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-4 py-3',
        ready ? 'border-positive/40 bg-positive/10' : 'border-accent/40 bg-accent/10'
      )}
    >
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-medium', ready ? 'text-positive' : 'text-accent-strong')}>
          {ready
            ? `Version ${version} is ready — restarting`
            : state === 'downloading'
              ? `Downloading version ${version}`
              : `Version ${version} is available`}
        </p>

        <p className="mt-0.5 text-xs leading-relaxed text-muted">
          {ready
            ? 'The window is about to close and open again. Nothing you have saved is affected.'
            : state === 'downloading'
              ? 'You can carry on working. The app restarts by itself once this finishes.'
              : 'Around 100 MB. It downloads, installs and restarts on its own from here.'}
        </p>

        {/* A download with no sense of progress reads as one that has stalled. */}
        {state === 'downloading' && (
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
        )}
      </div>

      {state === 'available' && (
        <Button size="sm" variant="primary" onClick={onDownload}>
          Upgrade
        </Button>
      )}

      {state === 'downloading' && (
        <span className="shrink-0 font-mono text-xs text-muted">{progress ?? 0}%</span>
      )}

      {/* The restart follows on its own — this is the way out if it does not. */}
      {ready && (
        <Button size="sm" variant="ghost" onClick={onInstall}>
          Restart now
        </Button>
      )}
    </div>
  )
}
