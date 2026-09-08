import { useEffect, useRef, useState } from 'react'
import type { TaskCard, TaskNote } from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { toSerializedError, unwrap } from '@/services/ipc'
import { cn } from '@/utils/cn'

interface TaskNotesDialogProps {
  /** The task being talked about. Null closes the dialog. */
  card: TaskCard | null
  onClose: () => void
  /** Told after every change, so the tile's count can follow along. */
  onChanged: () => void
}

/**
 * The conversation on one task.
 *
 * Read as a chat rather than as a list of records, because that is what it is:
 * short things, in the order they were said, by people who know each other. Own
 * notes on the right in the accent colour, everybody else's on the left — the
 * arrangement everybody already knows, which means nobody has to be told that
 * the right-hand side is them.
 *
 * A note cannot be edited, only taken back. The database has no update policy
 * for this table at all: a record of a conversation that can be rewritten after
 * the fact is not a record of it.
 */
/**
 * The day a note was written, as somebody would say it.
 *
 * "Today" and "Yesterday" rather than a date, because those are the two days a
 * thread is usually read on and a date there is something to work out rather
 * than something to read.
 */
function dayLabel(at: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (at.toDateString() === today.toDateString()) return 'Today'
  if (at.toDateString() === yesterday.toDateString()) return 'Yesterday'

  return at.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })
}

export function TaskNotesDialog({
  card,
  onClose,
  onChanged
}: TaskNotesDialogProps): React.JSX.Element {
  const { user, can } = useAuth()
  const { push } = useToast()

  const [notes, setNotes] = useState<TaskNote[]>([])
  const [loading, setLoading] = useState(false)
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  const foot = useRef<HTMLDivElement>(null)
  const canWrite = can('tasks.comment')

  const report = (caught: unknown): void => {
    const failure = toSerializedError(caught)
    push({
      tone: 'error',
      title: failure.message,
      ...(failure.hint ? { description: failure.hint } : {})
    })
  }

  useEffect(() => {
    if (!card) return

    let cancelled = false
    setLoading(true)
    setBody('')

    /*
     * Emptied before the read, not after it.
     *
     * Left alone, the previous task's thread stayed on screen for the length of
     * the round trip and then swapped — so opening one task showed somebody
     * else's conversation first, which is worse than showing nothing.
     */
    setNotes([])

    void unwrap(window.api.tasks.notes(card.id))
      .then((loaded) => {
        if (!cancelled) setNotes(loaded)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        report(caught)
        setNotes([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card])

  // The newest note is the one worth seeing, and it is at the bottom.
  useEffect(() => {
    foot.current?.scrollIntoView({ block: 'nearest' })
  }, [notes])

  const send = async (): Promise<void> => {
    if (!card) return

    const text = body.trim()
    if (!text) return

    setSending(true)
    try {
      const note = await unwrap(window.api.tasks.addNote(card.id, text))
      setNotes((current) => [...current, note])
      setBody('')
      onChanged()
    } catch (caught) {
      report(caught)
    } finally {
      setSending(false)
    }
  }

  const remove = async (note: TaskNote): Promise<void> => {
    try {
      await unwrap(window.api.tasks.deleteNote(note.id))
      setNotes((current) => current.filter((entry) => entry.id !== note.id))
      onChanged()
    } catch (caught) {
      report(caught)
    }
  }

  return (
    <Modal
      open={card !== null}
      title="Notes"
      description={card?.title ?? ''}
      onClose={onClose}
      className="w-[min(36rem,calc(100vw-3rem))]"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex max-h-[50vh] min-h-[8rem] flex-col gap-3 overflow-y-auto pr-1">
        {loading && <p className="text-xs text-faint">Loading…</p>}

        {!loading && notes.length === 0 && (
          <p className="text-xs leading-relaxed text-faint">
            Nothing said yet. Anything written here stays on the task, so whoever
            picks it up next can see how it got here.
          </p>
        )}

        {!loading &&
          notes.map((note, index) => {
            const mine = note.authorId === user?.id
            const at = new Date(note.createdAt)

            // A separator whenever the day changes, and before the first note.
            const previous = index > 0 ? new Date(notes[index - 1]!.createdAt) : null
            const newDay = !previous || previous.toDateString() !== at.toDateString()

            return (
              <div key={note.id}>
                {newDay && (
                  <div className="mb-3 flex justify-center">
                    <span className="rounded-full bg-surface px-2.5 py-1 text-[10px] text-faint">
                      {dayLabel(at)}
                    </span>
                  </div>
                )}

                <div className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                  {/* The name only on somebody else's — on your own it is you. */}
                  {!mine && (
                    <span className="mb-0.5 px-1 text-[11px] text-faint">{note.authorName}</span>
                  )}

                  {/*
                    Deleting sits outside the bubble, and appears on hover.
                    Inside it would either push the text around or fight the
                    timestamp for the corner; a row of visible Delete buttons
                    down a conversation reads as a list of things to remove.
                  */}
                  <div
                    className={cn(
                      'group/note flex max-w-[85%] items-center gap-2',
                      mine ? 'flex-row' : 'flex-row-reverse'
                    )}
                  >
                    {note.removable && (
                      <button
                        type="button"
                        onClick={() => void remove(note)}
                        aria-label="Delete this note"
                        className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-opacity hover:text-record-strong group-hover/note:opacity-100"
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 20 20"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          className="size-3.5"
                        >
                          <path d="M6 6l8 8M14 6l-8 8" />
                        </svg>
                      </button>
                    )}

                    <div
                      className={cn(
                        'relative min-w-0 rounded-2xl px-3 py-2',
                        mine
                          ? 'rounded-br-sm bg-accent text-white'
                          : 'rounded-bl-sm border border-hairline bg-surface text-ink'
                      )}
                    >
                      {/*
                        The message, with a hole reserved at the end of its last
                        line for the time to sit in.

                        This is how every chat app does it, and the reason is
                        that a timestamp on its own line wastes a whole line on
                        four characters. The spacer is inline, so a short note
                        keeps the clock beside it and a long one pushes it to a
                        line of its own — without either being decided in
                        advance.
                      */}
                      <p className="selectable whitespace-pre-wrap break-words text-sm leading-relaxed">
                        {note.body}
                        <span aria-hidden="true" className="inline-block w-12" />
                      </p>

                      <span
                        className={cn(
                          'absolute bottom-1.5 right-3 text-[10px] leading-none',
                          mine ? 'text-white/70' : 'text-faint'
                        )}
                      >
                        {at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}

        <div ref={foot} />
      </div>

      {canWrite ? (
        <div className="mt-3 flex items-end gap-2 border-t border-hairline pt-3">
          <textarea
            rows={2}
            value={body}
            maxLength={4000}
            disabled={sending}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the chat convention,
              // and the one people's hands already do.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="Write a note…"
            className="selectable min-w-0 flex-1 resize-none rounded-xl border border-hairline bg-surface px-3 py-2 text-sm leading-relaxed text-ink transition-colors hover:border-faint focus:border-accent"
          />

          <Button variant="primary" loading={sending} disabled={!body.trim()} onClick={() => void send()}>
            Send
          </Button>
        </div>
      ) : (
        <p className="mt-3 border-t border-hairline pt-3 text-xs text-faint">
          You can read this, but not add to it.
        </p>
      )}
    </Modal>
  )
}
