import type { CaptureSource, RecordingState } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { ProgressBar, Select } from '@/components/ui/Controls'
import { cn } from '@/utils/cn'
import { formatBytes, formatDuration } from '@/utils/format'
import type { RecorderSnapshot } from '@/services/recording-controller'

interface StatusPanelProps {
  snapshot: RecorderSnapshot
  canStart: boolean
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  /** Opens the recordings library. */
  onViewAll: () => void
  /** Capturable screens and windows, for the compact source selector. */
  sources: CaptureSource[]
  selectedSourceId: string | null
  onSelectSource: (id: string) => void
}

const STATUS_LABEL: Record<RecordingState, string> = {
  idle: 'Idle',
  preparing: 'Preparing',
  recording: 'Recording',
  paused: 'Paused',
  stopping: 'Stopping',
  processing: 'Processing',
  error: 'Error'
}

/**
 * The hero panel: current status, the timer, and the primary transport
 * controls. Everything the core workflow needs is reachable from here.
 */
export function StatusPanel({
  snapshot,
  canStart,
  onStart,
  onStop,
  onPause,
  onResume,
  onCancel,
  onViewAll,
  sources,
  selectedSourceId,
  onSelectSource
}: StatusPanelProps): React.JSX.Element {
  const { state } = snapshot
  const isLive = state === 'recording' || state === 'paused'
  // Wayland only names its screens up front; the compositor asks which one to
  // share when the recording starts, so the hint below says so.
  const askedAtStart = sources.some(
    (source) => source.id === selectedSourceId && source.placeholder
  )
  const isStopping = state === 'stopping'
  const isTransitioning = state === 'preparing' || isStopping || state === 'processing'

  // The stop button stays on screen while the recorder winds down, so the user
  // sees the action they triggered complete rather than the UI snapping back.
  const showTransportControls = isLive || isStopping

  return (
    <section className="rounded-2xl border border-hairline bg-gradient-to-br from-canvas-elevated to-canvas p-6">
      <div className="flex flex-wrap items-center justify-between gap-6">
        {/* Status + timer */}
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusBadge state={state} />
            {/* Entry point to the library — the recordings live inside the app. */}
            <Button size="sm" variant="ghost" onClick={onViewAll} icon={<LibraryIcon />}>
              View all
            </Button>
          </div>

          <div
            className={cn(
              'mt-3 font-mono text-6xl font-semibold tabular-nums tracking-tight transition-colors',
              state === 'recording' ? 'text-ink' : 'text-muted'
            )}
            aria-live="off"
          >
            {formatDuration(snapshot.elapsedMs)}
          </div>

          {/*
            Compact replacement for the old source grid: still allows picking a
            monitor or window, without occupying half the screen.
          */}
          <div className="mt-3 max-w-sm">
            <Select
              value={selectedSourceId ?? ''}
              disabled={showTransportControls || sources.length === 0}
              onValueChange={onSelectSource}
              aria-label="Capture source"
              options={
                sources.length === 0
                  ? [{ value: '', label: 'Looking for screens…' }]
                  : sources.map((source) => ({
                      value: source.id,
                      label: source.name
                    }))
              }
            />
          </div>

          <p className="mt-2 text-xs text-faint">
            {isLive ? (
              <>
                {snapshot.sourceName ?? 'Screen'}
                {snapshot.codecLabel ? ` • ${snapshot.codecLabel}` : ''}
                {snapshot.bytesWritten > 0
                  ? ` • ${formatBytes(snapshot.bytesWritten)} written`
                  : ''}
              </>
            ) : askedAtStart ? (
              'Start recording, then confirm the screen in the system prompt.'
            ) : (
              'Select a source, then start recording.'
            )}
          </p>
        </div>

        {/* Transport controls */}
        <div className="flex items-center gap-3">
          {!showTransportControls ? (
            <Button
              variant="record"
              size="lg"
              onClick={onStart}
              disabled={!canStart || isTransitioning}
              loading={state === 'preparing'}
              icon={state === 'preparing' ? undefined : <RecordDot />}
            >
              Start Recording
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="lg"
                disabled={isStopping}
                onClick={state === 'paused' ? onResume : onPause}
                icon={state === 'paused' ? <PlayIcon /> : <PauseIcon />}
              >
                {state === 'paused' ? 'Resume' : 'Pause'}
              </Button>

              <Button
                variant="record"
                size="lg"
                onClick={onStop}
                loading={isStopping}
                icon={isStopping ? undefined : <StopIcon />}
              >
                Stop Recording
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Conversion progress */}
      {(state === 'processing' || snapshot.progress) && (
        <div className="mt-6 rounded-xl border border-hairline bg-surface/60 p-4">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium text-ink">
              {snapshot.progress?.detail ?? 'Converting to MP4'}
            </span>
            {snapshot.progress && snapshot.progress.percent > 0 && (
              <span className="font-mono text-muted">
                {Math.round(snapshot.progress.percent)}%
              </span>
            )}
          </div>
          <ProgressBar
            percent={
              snapshot.progress && snapshot.progress.percent > 0
                ? snapshot.progress.percent
                : null
            }
          />
        </div>
      )}

      {isLive && (
        <div className="mt-4 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Discard recording
          </Button>
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

function StatusBadge({ state }: { state: RecordingState }): React.JSX.Element {
  const tone =
    state === 'recording'
      ? 'border-record/40 bg-record/10 text-record-strong'
      : state === 'paused'
        ? 'border-warning/40 bg-warning/10 text-warning'
        : state === 'error'
          ? 'border-record/40 bg-record/10 text-record-strong'
          : state === 'idle'
            ? 'border-hairline bg-surface text-muted'
            : 'border-accent/40 bg-accent/10 text-accent-strong'

  return (
    <span
      role="status"
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
        tone
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-2 rounded-full bg-current',
          state === 'recording' && 'animate-recording'
        )}
      />
      {STATUS_LABEL[state]}
    </span>
  )
}

/* --------------------------------- Icons ---------------------------------- */

const RecordDot = (): React.JSX.Element => (
  <span aria-hidden="true" className="size-3 rounded-full bg-white" />
)

const StopIcon = (): React.JSX.Element => (
  <span aria-hidden="true" className="size-3 rounded-[3px] bg-white" />
)

const PauseIcon = (): React.JSX.Element => (
  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4">
    <path d="M6 4h3v12H6V4zm5 0h3v12h-3V4z" />
  </svg>
)

const PlayIcon = (): React.JSX.Element => (
  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4">
    <path d="M6 4l10 6-10 6V4z" />
  </svg>
)

const LibraryIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    className="size-3.5"
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M10 9.5l5 2.5-5 2.5v-5z" fill="currentColor" stroke="none" />
  </svg>
)
