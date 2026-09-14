import { useEffect, useMemo, useRef, useState } from 'react'
import type { RecordingEntry } from '@shared/types'
import { FileTranscriptDialog } from '@/components/FileTranscriptDialog'
import { NoteDialog } from '@/components/NoteDialog'
import { TranscriptPanel } from '@/components/TranscriptPanel'
import { FilmIcon, RecordingTile, TileSkeletonGrid } from '@/components/RecordingTile'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
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
  const { recordings, loading, error, busyId, refresh, remove, removeMany, forget, exportFile } =
    useLibrary()
  const { push } = useToast()

  const [selectedId, setSelectedId] = useState<string | null>(initialRecordingId)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [noteId, setNoteId] = useState<string | null>(null)

  /*
   * The recordings ticked for deleting, which is a different thing from the one
   * loaded in the player above. Both are called "selected" in the UI and they
   * have to stay apart in the code, so this one is `chosen`.
   */
  /** The player, so a transcript line can move it. */
  const video = useRef<HTMLVideoElement>(null)

  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [fileTranscript, setFileTranscript] = useState(false)
  const [deleting, setDeleting] = useState(false)

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

  /*
   * A tick on something that is no longer there.
   *
   * The list changes underneath this — a delete from the player above, a new
   * recording, a Refresh that finds a file gone. Left alone, a stale id would
   * sit in the count and make the bar promise more than it can deliver.
   */
  useEffect(() => {
    setChosen((current) => {
      if (current.size === 0) return current
      const next = new Set([...current].filter((id) => recordings.some((r) => r.id === id)))
      return next.size === current.size ? current : next
    })
  }, [recordings])

  const selected = useMemo(
    () => recordings.find((item) => item.id === selectedId) ?? null,
    [recordings, selectedId]
  )

  const toggleChosen = (id: string, ticked: boolean): void => {
    setChosen((current) => {
      const next = new Set(current)
      if (ticked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const allChosen = recordings.length > 0 && chosen.size === recordings.length

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

  const handleDeleteChosen = async (): Promise<void> => {
    const ids = [...chosen]

    setDeleting(true)
    try {
      const { deleted, failed } = await removeMany(ids)

      setConfirmBulk(false)
      setChosen(new Set())

      if (deleted > 0) {
        push({
          tone: 'info',
          title: `${deleted} recording${deleted === 1 ? '' : 's'} deleted`,
          ...(failed > 0 ? { description: `${failed} could not be deleted.` } : {})
        })
      }

      // Nothing went. Saying "0 deleted" in an info toast would read as success.
      if (deleted === 0 && failed > 0) {
        push({
          tone: 'error',
          title: 'Nothing could be deleted',
          description: 'The files may be open in another application.'
        })
      }
    } finally {
      setDeleting(false)
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
              ref={video}
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

          {/*
            Under the player rather than beside it. A transcript is read in long
            lines, and a column narrow enough to sit alongside a 16:9 video turns
            every line into three.
          */}
          {selected.available && (
            <div className="mt-3 border-t border-hairline pt-3">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">
                Transcript
              </p>
              <TranscriptPanel
                recordingId={selected.id}
                onSeek={(seconds) => {
                  const player = video.current
                  if (!player) return
                  player.currentTime = seconds
                  void player.play().catch(() => undefined)
                }}
              />
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
            {/* Not a recording, so it does not belong in the list below — but
                this is where somebody already is when they want one read. */}
            <Button size="sm" variant="ghost" onClick={() => setFileTranscript(true)}>
              Transcribe a file…
            </Button>

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
          <>
            {/*
              Only once something is ticked.

              A bar that is always there spends a row of the card on buttons
              that do nothing yet, and the tick boxes already say the feature
              exists. Select all lives here rather than in the header so the
              whole of it appears and disappears as one thing.
            */}
            {chosen.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2">
                <span className="text-xs font-medium text-accent-strong">
                  {chosen.size} selected
                </span>

                <span className="flex-1" />

                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setChosen(allChosen ? new Set() : new Set(recordings.map((item) => item.id)))
                  }
                >
                  {allChosen ? 'Select none' : 'Select all'}
                </Button>

                <Button size="sm" variant="ghost" onClick={() => setChosen(new Set())}>
                  Clear
                </Button>

                <Button
                  size="sm"
                  variant="danger"
                  loading={deleting}
                  onClick={() => setConfirmBulk(true)}
                >
                  Delete
                </Button>
              </div>
            )}

            <div className="grid max-h-[26rem] grid-cols-2 gap-3 overflow-y-auto pr-1 lg:grid-cols-3 xl:grid-cols-4">
              {recordings.map((entry) => (
                <RecordingTile
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selectedId}
                  selectable
                  checked={chosen.has(entry.id)}
                  onCheckedChange={(ticked) => toggleChosen(entry.id, ticked)}
                  onPlay={() => setSelectedId(entry.id)}
                  onOpenNote={() => setNoteId(entry.id)}
                />
              ))}
            </div>
          </>
        )}
      </Card>

      <ConfirmDialog
        open={confirmBulk}
        title={`Delete ${chosen.size} recording${chosen.size === 1 ? '' : 's'}?`}
        description="They go to the recycle bin, along with their thumbnails and notes. Recordings whose file is already missing are dropped from the list."
        confirmLabel={`Delete ${chosen.size}`}
        busy={deleting}
        onConfirm={() => void handleDeleteChosen()}
        onClose={() => setConfirmBulk(false)}
      />

      <FileTranscriptDialog open={fileTranscript} onClose={() => setFileTranscript(false)} />

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
