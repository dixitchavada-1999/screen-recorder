import { useEffect, useMemo, useState } from 'react'
import type { RecordingEntry } from '@shared/types'
import { NoteDialog } from '@/components/NoteDialog'
import { FilmIcon, RecordingTile, TileSkeletonGrid } from '@/components/RecordingTile'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useToast } from '@/context/ToastContext'
import { useLibrary } from '@/hooks/useLibrary'
import { toSerializedError, unwrap } from '@/services/ipc'
import { formatBytes, formatDuration, formatTimestamp } from '@/utils/format'

/**
 * The recordings library.
 *
 * The list comes from the catalog, so it spans every folder the app has ever
 * written to: play in place, save a copy elsewhere, delete, or drop an entry
 * whose file has gone missing.
 */
interface RecordingsPageProps {
  /** Recording to open on arrival, e.g. after clicking a tile on the recorder. */
  initialRecordingId?: string | null
}

export function RecordingsPage({
  initialRecordingId = null
}: RecordingsPageProps): React.JSX.Element {
  const { recordings, loading, error, busyId, refresh, remove, forget, exportFile } = useLibrary()
  const { push } = useToast()

  const [selectedId, setSelectedId] = useState<string | null>(initialRecordingId)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [noteId, setNoteId] = useState<string | null>(null)

  // Follow the caller's choice when navigating in from another page.
  useEffect(() => {
    if (initialRecordingId) setSelectedId(initialRecordingId)
  }, [initialRecordingId])

  // Keep the selection valid as the list changes (deletes, new recordings).
  useEffect(() => {
    if (recordings.length === 0) {
      setSelectedId(null)
      return
    }
    if (!recordings.some((item) => item.id === selectedId)) {
      setSelectedId(recordings[0]?.id ?? null)
    }
  }, [recordings, selectedId])

  const selected = useMemo(
    () => recordings.find((item) => item.id === selectedId) ?? null,
    [recordings, selectedId]
  )

  const totalBytes = useMemo(
    () => recordings.reduce((sum, item) => sum + item.sizeBytes, 0),
    [recordings]
  )

  const handleExport = async (entry: RecordingEntry): Promise<void> => {
    try {
      const destination = await exportFile(entry.id)
      if (!destination) return

      push({
        tone: 'success',
        title: 'Recording saved',
        description: destination,
        actions: [
          {
            label: 'Show in folder',
            onClick: () => void unwrap(window.api.shell.revealItem(destination))
          }
        ]
      })
    } catch (caught) {
      push({ tone: 'error', title: 'Could not save', description: toSerializedError(caught).message })
    }
  }

  const handleDelete = async (entry: RecordingEntry): Promise<void> => {
    try {
      await remove(entry.id)
      setConfirmDelete(null)
      push({ tone: 'info', title: 'Recording deleted', description: entry.fileName })
    } catch (caught) {
      push({
        tone: 'error',
        title: 'Could not delete',
        description: toSerializedError(caught).message
      })
    }
  }

  const handleForget = async (entry: RecordingEntry): Promise<void> => {
    try {
      await forget(entry.id)
      push({
        tone: 'info',
        title: 'Removed from the list',
        description: 'The file itself was not touched.'
      })
    } catch (caught) {
      push({
        tone: 'error',
        title: 'Could not remove the entry',
        description: toSerializedError(caught).message
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* -------------------------------- Player ------------------------------- */}
      {selected && (
        <Card
          title={selected.fileName}
          description={[
            formatTimestamp(selected.createdAt),
            selected.durationMs ? formatDuration(selected.durationMs) : null,
            selected.width && selected.height ? `${selected.width} × ${selected.height}` : null,
            selected.available ? formatBytes(selected.sizeBytes) : 'File missing',
            selected.filePath
          ]
            .filter(Boolean)
            .join('  •  ')}
          actions={
            confirmDelete === selected.id ? (
              <>
                <span className="text-[11px] text-record-strong">Delete permanently?</span>
                <Button
                  size="sm"
                  variant="danger"
                  loading={busyId === selected.id}
                  onClick={() => void handleDelete(selected)}
                >
                  Delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant={selected.note ? 'primary' : 'ghost'}
                  onClick={() => setNoteId(selected.id)}
                >
                  {selected.note ? 'View note' : 'Add note'}
                </Button>

                {selected.available ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busyId === selected.id}
                      onClick={() => void handleExport(selected)}
                    >
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void unwrap(window.api.shell.revealItem(selected.filePath))}
                    >
                      Show in folder
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(selected.id)}>
                      Delete
                    </Button>
                  </>
                ) : (
                  // Nothing to download, reveal or delete — only the entry is left.
                  <Button
                    size="sm"
                    variant="danger"
                    loading={busyId === selected.id}
                    onClick={() => void handleForget(selected)}
                  >
                    Remove from list
                  </Button>
                )}
              </>
            )
          }
        >
          {selected.available ? (
            /*
              `key` forces a fresh element per recording — reusing one <video>
              across sources leaves the previous frame on screen while buffering.
            */
            <video
              key={selected.id}
              src={selected.playbackUrl}
              controls
              preload="metadata"
              className="aspect-video w-full rounded-xl bg-black"
            />
          ) : (
            <div className="grid aspect-video w-full place-items-center rounded-xl border border-dashed border-record/40 bg-record/5 px-6 text-center">
              <div>
                <p className="text-sm text-ink">This file is no longer on disk</p>
                <p className="selectable mt-1 break-all text-xs text-faint">{selected.filePath}</p>
                <p className="mt-2 text-xs text-muted">
                  It was moved, renamed or deleted outside the app. Put it back and press
                  Refresh, or remove the entry from the list.
                </p>
              </div>
            </div>
          )}

          {selected.note && (
            <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-accent-strong">
                Note
              </p>
              <p className="selectable mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted">
                {selected.note}
              </p>
            </div>
          )}
        </Card>
      )}

      {/* -------------------------------- List --------------------------------- */}
      <Card
        title="All recordings"
        description={
          recordings.length === 0
            ? 'Recordings you make will appear here.'
            : `${recordings.length} recording${recordings.length === 1 ? '' : 's'} • ${formatBytes(totalBytes)}`
        }
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void unwrap(window.api.library.openFolder())}
            >
              Open folder
            </Button>
            <Button size="sm" variant="ghost" loading={loading} onClick={() => void refresh()}>
              Refresh
            </Button>
          </>
        }
      >
        {error ? (
          <EmptyState title={error.message} description={error.hint} />
        ) : loading && recordings.length === 0 ? (
          <TileSkeletonGrid count={9} />
        ) : recordings.length === 0 ? (
          <EmptyState
            title="No recordings yet"
            description="Head to the Recorder tab and press Start Recording."
          />
        ) : (
          <div className="grid max-h-[26rem] grid-cols-2 gap-3 overflow-y-auto pr-1 lg:grid-cols-3 xl:grid-cols-4">
            {recordings.map((entry) => (
              <RecordingTile
                key={entry.id}
                entry={entry}
                selected={entry.id === selectedId}
                onPlay={() => setSelectedId(entry.id)}
                onOpenNote={() => setNoteId(entry.id)}
              />
            ))}
          </div>
        )}
      </Card>

      <NoteDialog
        open={noteId !== null}
        recordingId={noteId}
        initialNote={recordings.find((item) => item.id === noteId)?.note ?? ''}
        subtitle={recordings.find((item) => item.id === noteId)?.fileName ?? ''}
        onClose={() => setNoteId(null)}
        onSaved={() => {
          void refresh()
          push({ tone: 'success', title: 'Note saved' })
        }}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function EmptyState({
  title,
  description
}: {
  title: string
  description?: string
}): React.JSX.Element {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
      <FilmIcon />
      <p className="mt-3 text-sm text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-xs text-faint">{description}</p>}
    </div>
  )
}
