import type { RecordingEntry } from '@shared/types'
import { RecordingTile, TileSkeletonGrid, FilmIcon } from '@/components/RecordingTile'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'

/** How many tiles the recorder screen shows before "View all" is needed. */
export const RECENT_LIMIT = 6

interface RecentRecordingsProps {
  recordings: RecordingEntry[]
  loading: boolean
  onPlay: (entry: RecordingEntry) => void
  onOpenNote: (entry: RecordingEntry) => void
  onViewAll: () => void
  onRefresh: () => void
}

/**
 * The six most recent recordings, shown on the main screen in place of the
 * old capture-source grid.
 */
export function RecentRecordings({
  recordings,
  loading,
  onPlay,
  onOpenNote,
  onViewAll,
  onRefresh
}: RecentRecordingsProps): React.JSX.Element {
  const recent = recordings.slice(0, RECENT_LIMIT)

  return (
    <Card
      title="Recent recordings"
      description="Your latest captures. Click a tile to play it."
      actions={
        <>
          <Button size="sm" variant="ghost" loading={loading} onClick={onRefresh}>
            Refresh
          </Button>
          <Button size="sm" variant="ghost" onClick={onViewAll}>
            View all
          </Button>
        </>
      }
      className="flex min-h-0 flex-1 flex-col"
    >
      {loading && recordings.length === 0 ? (
        <TileSkeletonGrid />
      ) : recent.length === 0 ? (
        <div className="grid place-items-center rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
          <FilmIcon />
          <p className="mt-3 text-sm text-ink">No recordings yet</p>
          <p className="mt-1 max-w-sm text-xs text-faint">
            Press Start Recording — your captures will appear here.
          </p>
        </div>
      ) : (
        <div className="grid max-h-[19rem] grid-cols-2 gap-3 overflow-y-auto pr-1 lg:grid-cols-3">
          {recent.map((entry) => (
            <RecordingTile
              key={entry.id}
              entry={entry}
              onPlay={() => onPlay(entry)}
              onOpenNote={() => onOpenNote(entry)}
            />
          ))}
        </div>
      )}
    </Card>
  )
}
