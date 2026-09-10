import type { RecordingEntry } from '@shared/types'
import { cn } from '@/utils/cn'
import { formatDuration, formatTimestamp } from '@/utils/format'

interface RecordingTileProps {
  entry: RecordingEntry
  /** Highlights the tile currently loaded in the player. */
  selected?: boolean
  /**
   * Shows the tick box, for screens that delete in batches.
   *
   * Off by default, so the recorder's "Recent recordings" strip — where there
   * is nothing to do in bulk — keeps the plain tile it had.
   */
  selectable?: boolean
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  onPlay: () => void
  onOpenNote: () => void
}

/**
 * A single recording presented as a poster-frame card.
 *
 * Shared by the recorder screen's "Recent recordings" strip and the full
 * library, so the two never drift apart visually.
 */
export function RecordingTile({
  entry,
  selected = false,
  selectable = false,
  checked = false,
  onCheckedChange,
  onPlay,
  onOpenNote
}: RecordingTileProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border transition-colors',
        checked
          ? 'border-accent bg-accent/15 ring-1 ring-accent'
          : selected
            ? 'border-accent bg-accent/10 ring-1 ring-accent'
            : 'border-hairline bg-surface hover:border-faint'
      )}
    >
      <button type="button" onClick={onPlay} className="block w-full text-left">
        <span
          className={cn(
            'relative block aspect-video w-full overflow-hidden bg-canvas',
            !entry.available && 'opacity-40 grayscale'
          )}
        >
          {entry.thumbnailUrl ? (
            <img
              src={entry.thumbnailUrl}
              alt=""
              draggable={false}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center">
              <FilmIcon />
            </span>
          )}

          {/* Play affordance, revealed on hover over the tile. */}
          {entry.available && (
            <span className="absolute inset-0 grid place-items-center bg-black/0 transition-colors group-hover:bg-black/35">
              <span className="grid size-9 place-items-center rounded-full bg-white/0 text-white opacity-0 transition-all group-hover:bg-accent group-hover:opacity-100">
                <PlayIcon />
              </span>
            </span>
          )}

          {entry.durationMs && (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] text-white">
              {formatDuration(entry.durationMs)}
            </span>
          )}
        </span>

        {/* The file is gone from disk; the entry stays so it can be removed. */}
        {!entry.available && (
          <span
            className={cn(
              'absolute top-2 rounded bg-record/90 px-1.5 py-0.5 text-[10px] font-medium text-white',
              // Out of the tick box's corner rather than under it.
              selectable ? 'left-10' : 'left-2'
            )}
          >
            File missing
          </span>
        )}

        <span
          className="block truncate px-3 pb-2 pt-2 text-[11px] text-ink"
          title={`${entry.fileName}\n${entry.filePath}`}
        >
          {formatTimestamp(entry.createdAt)}
        </span>
      </button>

      {/*
        A sibling of the play button, not a child of it.

        Nesting one button inside another is invalid, and the click would reach
        the outer one on its way up — ticking a tile would start playing it.
      */}
      {selectable && (
        <label
          className="absolute left-2 top-2 z-10 grid size-6 cursor-pointer place-items-center"
          title={checked ? 'Deselect this recording' : 'Select this recording'}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onCheckedChange?.(event.target.checked)}
            aria-label={`Select ${entry.fileName}`}
            className="peer sr-only"
          />
          <span
            className={cn(
              'grid size-5 place-items-center rounded-md border transition-colors',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-accent',
              checked
                ? 'border-accent bg-accent text-white'
                : // Legible over a bright poster frame as well as a dark one.
                  'border-white/70 bg-black/45 text-transparent hover:border-white'
            )}
          >
            <TickIcon />
          </span>
        </label>
      )}

      {/*
        Sits where the capture-source tick used to. Hidden until the tile is
        hovered (or the button is keyboard-focused), keeping the grid clean.
      */}
      <button
        type="button"
        onClick={onOpenNote}
        title={entry.note ? 'View note' : 'Add a note'}
        aria-label={entry.note ? `View note for ${entry.fileName}` : `Add a note to ${entry.fileName}`}
        className={cn(
          'absolute right-2 top-2 grid size-7 place-items-center rounded-full opacity-0 transition-opacity',
          'focus-visible:opacity-100 group-hover:opacity-100',
          // Colour still distinguishes "has a note" once revealed.
          entry.note ? 'bg-accent text-white' : 'bg-canvas/85 text-muted hover:text-ink'
        )}
      >
        <EyeIcon />
      </button>
    </div>
  )
}

/** Placeholder grid shown while thumbnails are still being generated. */
export function TileSkeletonGrid({ count = 6 }: { count?: number }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className="aspect-video animate-pulse rounded-xl border border-hairline bg-surface"
        />
      ))}
    </div>
  )
}

const TickIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-3"
  >
    <path d="M4 10.5l4 4 8-9" />
  </svg>
)

const PlayIcon = (): React.JSX.Element => (
  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-4">
    <path d="M6 4l10 6-10 6V4z" />
  </svg>
)

const EyeIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="size-3.5"
  >
    <path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export const FilmIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    className="size-8 text-faint"
  >
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M2 12h20" />
  </svg>
)
