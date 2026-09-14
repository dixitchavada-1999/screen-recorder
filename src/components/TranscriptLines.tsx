import type { TranscriptSegment } from '@shared/types'
import { useToast } from '@/context/ToastContext'
import { cn } from '@/utils/cn'

interface TranscriptLinesProps {
  segments: TranscriptSegment[]
  /**
   * Jumps a player to a moment, in seconds.
   *
   * Absent where there is nothing to jump — a file transcribed from disk has no
   * player beside it — and then the timestamp is shown but not offered as a
   * control, rather than pretending to be a button that does nothing.
   */
  onSeek?: (seconds: number) => void
  className?: string
}

/**
 * The lines of a transcript, wherever they came from.
 *
 * Shared by the recording panel and the file dialog so the two cannot drift:
 * one way of showing a line, and one way of turning lines into text somebody
 * can paste.
 */
export function TranscriptLines({
  segments,
  onSeek,
  className
}: TranscriptLinesProps): React.JSX.Element {
  const { push } = useToast()

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      push({ tone: 'success', title: 'Line copied' })
    } catch {
      push({ tone: 'error', title: 'Could not copy', description: 'The clipboard refused.' })
    }
  }

  return (
    <ul className={cn('space-y-1 overflow-y-auto pr-1', className)}>
      {segments.map((segment, index) => (
        <li
          key={`${segment.startMs}-${index}`}
          className="group/line flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface"
        >
          {onSeek ? (
            <button
              type="button"
              onClick={() => onSeek(segment.startMs / 1000)}
              title="Jump to this moment"
              className="shrink-0 pt-0.5 font-mono text-[11px] text-faint transition-colors hover:text-accent-strong"
            >
              {clock(segment.startMs)}
            </button>
          ) : (
            <span className="shrink-0 pt-0.5 font-mono text-[11px] text-faint">
              {clock(segment.startMs)}
            </span>
          )}

          {/* No label at all when the speaker is unknown: an empty column is
              quieter than a column of "Unknown" repeated down the page. */}
          {segment.speaker !== 'unknown' && (
            <span
              className={cn(
                'shrink-0 pt-0.5 text-[11px] font-medium',
                segment.speaker === 'me' ? 'text-accent-strong' : 'text-muted'
              )}
            >
              {segment.speaker === 'me' ? 'You' : 'Them'}
            </span>
          )}

          <p className="selectable min-w-0 flex-1 text-xs leading-relaxed text-ink">
            {segment.text}
          </p>

          {/* One line on its own, for quoting. Hidden until the row is under the
              cursor, so the column does not become a wall of buttons. */}
          <button
            type="button"
            onClick={() => void copy(segment.text)}
            aria-label="Copy this line"
            className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 group-hover/line:opacity-100"
          >
            <CopyIcon />
          </button>
        </li>
      ))}
    </ul>
  )
}

/**
 * The transcript as text somebody can paste.
 *
 * Timestamps are optional because the two uses pull in opposite directions:
 * pasted into notes they are clutter, but quoted back alongside the recording
 * they are the only way to find the moment again.
 */
export function transcriptAsText(segments: TranscriptSegment[], withTimes: boolean): string {
  return segments
    .map((segment) => {
      const at = withTimes ? `[${clock(segment.startMs)}] ` : ''
      const who = segment.speaker === 'unknown' ? '' : `${segment.speaker === 'me' ? 'You' : 'Them'}: `
      return `${at}${who}${segment.text}`
    })
    .join('\n')
}

/** `mm:ss`, or `h:mm:ss` once a recording is long enough to need the hour. */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)

  if (hours === 0) return `${minutes}:${seconds}`
  return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
}

const CopyIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-3.5"
  >
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
)
