import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { log, unwrap } from '@/services/ipc'

interface NoteDialogProps {
  open: boolean
  /** Recording the note belongs to; `null` closes the dialog. */
  recordingId: string | null
  initialNote: string
  /** Shown under the title, e.g. the recording's timestamp. */
  subtitle?: string
  /** Copy tuned for the prompt shown right after a recording ends. */
  variant?: 'edit' | 'capture'
  onClose: () => void
  onSaved: (note: string) => void
}

const MAX_LENGTH = 2000

/**
 * Creates, edits and displays the note attached to a recording.
 *
 * Notes live in the library index next to the file rather than inside the MP4,
 * so saving one is instant and never re-encodes the video.
 */
export function NoteDialog({
  open,
  recordingId,
  initialNote,
  subtitle,
  variant = 'edit',
  onClose,
  onSaved
}: NoteDialogProps): React.JSX.Element {
  const [note, setNote] = useState(initialNote)
  const [saving, setSaving] = useState(false)

  // Re-seed whenever a different recording is opened.
  useEffect(() => {
    if (open) setNote(initialNote)
  }, [open, recordingId, initialNote])

  const save = async (): Promise<void> => {
    if (!recordingId) return

    setSaving(true)
    try {
      await unwrap(window.api.library.setNote(recordingId, note))
      onSaved(note.trim())
      onClose()
    } catch (error) {
      log.error('note-dialog', 'Could not save the note', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      title={variant === 'capture' ? 'Add a note' : 'Recording note'}
      {...(subtitle ? { description: subtitle } : {})}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {variant === 'capture' ? 'Skip' : 'Cancel'}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save note
          </Button>
        </>
      }
    >
      <p className="mb-2 text-xs leading-relaxed text-faint">
        {variant === 'capture'
          ? 'What was this recording about? You can read it later from the eye icon on the recording.'
          : 'This note is stored alongside the recording inside the app.'}
      </p>

      <textarea
        autoFocus
        rows={6}
        maxLength={MAX_LENGTH}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="e.g. Client call about the billing bug — fix agreed at 04:12"
        className="selectable w-full resize-y rounded-xl border border-hairline bg-surface px-3 py-2 text-sm leading-relaxed text-ink transition-colors hover:border-faint focus:border-accent"
        onKeyDown={(event) => {
          // Ctrl/Cmd+Enter saves, matching the usual comment-box convention.
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            void save()
          }
        }}
      />

      <p className="mt-1 text-right text-[11px] text-faint">
        {note.length} / {MAX_LENGTH}
      </p>
    </Modal>
  )
}
