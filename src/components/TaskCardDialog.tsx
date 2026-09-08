import { useEffect, useState } from 'react'
import type { TaskCard, TaskCardInput, TaskPerson, TaskPriority } from '@shared/types'
import { PeoplePicker } from '@/components/PeoplePicker'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { DatePicker, format as formatDay } from '@/components/ui/DatePicker'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/context/ToastContext'
import { toSerializedError } from '@/services/ipc'
import { cn } from '@/utils/cn'

const PRIORITIES: ReadonlyArray<{ id: TaskPriority; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'normal', label: 'Normal' },
  { id: 'high', label: 'High' },
  { id: 'urgent', label: 'Urgent' }
]

/**
 * What the dialog is open for: an existing task, or a new one in a given list.
 */
export type TaskDialogTarget =
  | { kind: 'edit'; card: TaskCard }
  | { kind: 'new'; listId: string }

interface TaskCardDialogProps {
  /** What is being worked on. Null closes the dialog. */
  target: TaskDialogTarget | null
  /**
   * Whether this account may destroy a task at all.
   *
   * Its own answer, not a corollary of being able to edit one: the database
   * asks for `tasks.delete` separately, and a Delete button that is refused on
   * being pressed is worse than one that was never offered.
   */
  canDelete: boolean
  /**
   * Who is on the project, and so who this task can be given to.
   *
   * Not the whole staff roster: somebody who is not on the project cannot see
   * it, so assigning them a task on it would hand them work they cannot open.
   * The database already refuses to show it to them; this stops the window
   * offering it in the first place.
   */
  members: TaskPerson[]
  onClose: () => void
  onCreate: (listId: string, input: TaskCardInput) => Promise<void>
  onSave: (cardId: string, input: TaskCardInput) => Promise<void>
  onDelete: (cardId: string) => Promise<void>
}

/**
 * One card, opened.
 *
 * Everything about a card is edited here rather than in place on the board: a
 * column is three hundred pixels wide, and a description, a date and an
 * audience do not fit into one without becoming a form nobody can read.
 *
 * Saved as a whole on the way out, not field by field. A card is a sentence
 * somebody is in the middle of writing, and writing every keystroke to the
 * server would put half-finished titles onto other people's boards.
 */
export function TaskCardDialog({
  target,
  canDelete,
  members,
  onClose,
  onCreate,
  onSave,
  onDelete
}: TaskCardDialogProps): React.JSX.Element {
  const card = target?.kind === 'edit' ? target.card : null
  const creating = target?.kind === 'new'

  /*
   * A task somebody may read but not change opens as a page rather than a form.
   * Offering fields that cannot be saved, and finding out only on pressing
   * Save, is worse than not offering them.
   */
  const readOnly = card !== null && !card.editable

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('normal')
  const [assignees, setAssignees] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const { push } = useToast()

  /*
   * Filled from whatever the dialog was opened for, every time it opens.
   *
   * A new task starts empty and an existing one starts as it is. Carrying the
   * last one's text over would be a way to overwrite one task with another's —
   * or to write a new one that is quietly a copy of the last thing looked at.
   */
  useEffect(() => {
    /*
     * Cleared first, and outside the guard below, because this is what closes
     * the confirmation. `showModal()` makes the rest of the document inert
     * until `close()` is called, and this dialog stays mounted with its parent
     * — so a confirmation left open after the task it was about had gone took
     * every click on the board with it, invisibly.
     */
    setConfirming(false)

    if (!target) return

    if (target.kind === 'new') {
      setTitle('')
      setDescription('')
      setDueAt('')
      setPriority('normal')
      setAssignees([])
    } else {
      const open = target.card
      setTitle(open.title)
      setDescription(open.description)
      setDueAt(toDay(open.dueAt))
      setPriority(open.priority)
      setAssignees(open.assignees.map((person) => person.nexusId))
    }
  }, [target])

  const save = async (): Promise<void> => {
    if (!target || !title.trim()) return

    const input = {
      title: title.trim(),
      description,
      // An empty box means "no due date", which is a value the server has to
      // be told about — leaving it out would mean "do not touch".
      dueAt: dueAt ? endOfDay(dueAt) : null,
      priority,
      assigneeNexusIds: assignees
    }

    setSaving(true)
    try {
      if (target.kind === 'new') await onCreate(target.listId, input)
      else await onSave(target.card.id, input)
      onClose()
    } catch (caught) {
      const failure = toSerializedError(caught)
      push({
        tone: 'error',
        title: failure.message,
        ...(failure.hint ? { description: failure.hint } : {})
      })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!card) return

    setSaving(true)
    try {
      await onDelete(card.id)
      setConfirming(false)
      onClose()
    } catch (caught) {
      const failure = toSerializedError(caught)
      push({ tone: 'error', title: failure.message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={target !== null}
      title={creating ? 'New task' : readOnly ? 'Task (read only)' : 'Task'}
      description={
        card ? `Added ${new Date(card.createdAt).toLocaleDateString()}` : 'It goes to the bottom of the section.'
      }
      onClose={onClose}
      className="w-[min(38rem,calc(100vw-3rem))]"
      footer={
        <>
          {/*
            Absent while writing a new one: there is nothing yet to delete, and
            Cancel already covers changing your mind.
          */}
          {!creating && !readOnly && canDelete && (
            <Button variant="ghost" disabled={saving} onClick={() => setConfirming(true)}>
              Delete
            </Button>
          )}

          <span className="flex-1" />

          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>

          {!readOnly && (
            <Button
              variant="primary"
              loading={saving}
              disabled={!title.trim()}
              onClick={() => void save()}
            >
              {creating ? 'Add task' : 'Save'}
            </Button>
          )}
        </>
      }
    >
      <label htmlFor="task-title" className="mb-1.5 block text-xs font-medium text-muted">
        Task name
      </label>

      <input
        id="task-title"
        value={title}
        readOnly={readOnly}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
        className="selectable w-full rounded-xl border border-hairline bg-surface px-3 py-2 text-sm text-ink transition-colors hover:border-faint focus:border-accent"
      />

      <label htmlFor="task-description" className="mb-1.5 mt-4 block text-xs font-medium text-muted">
        Task description
      </label>

      <textarea
        id="task-description"
        rows={4}
        readOnly={readOnly}
        maxLength={5000}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="Anything the person picking this up needs to know."
        className="selectable w-full resize-y rounded-xl border border-hairline bg-surface px-3 py-2 text-sm leading-relaxed text-ink transition-colors hover:border-faint focus:border-accent"
      />

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="task-due" className="mb-1.5 block text-xs font-medium text-muted">
            Due
          </label>

          <DatePicker id="task-due" value={dueAt} onChange={setDueAt} disabled={readOnly} />
        </div>

        <div>
          <span className="mb-1.5 block text-xs font-medium text-muted">Priority</span>

          <div
            role="radiogroup"
            aria-label="Priority"
            className="flex items-center gap-0.5 rounded-xl border border-hairline bg-surface p-0.5"
          >
            {PRIORITIES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                disabled={readOnly}
                aria-checked={priority === option.id}
                onClick={() => setPriority(option.id)}
                className={cn(
                  'flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
                  priority === option.id ? 'bg-accent text-white' : 'text-muted hover:text-ink'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        {readOnly ? (
          <>
            <p className="mb-1.5 text-xs font-medium text-muted">Who is doing this?</p>
            {card && card.assignees.length > 0 ? (
              <ul className="flex flex-wrap gap-1">
                {card.assignees.map((person) => (
                  <li
                    key={person.nexusId}
                    className="rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-[11px] text-accent-strong"
                  >
                    {person.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">Nobody yet.</p>
            )}
          </>
        ) : (
          <PeoplePicker
            // Fresh state per task: the roster left open on one should not be
            // open on the next one somebody looks at.
            key={card?.id ?? 'new'}
            id="task-assignees"
            label="Who is doing this?"
            selected={assignees}
            onChange={setAssignees}
            placeholder="Search by name"
            emptyLabel="unassigned"
            collapsible
            people={members}
          />
        )}
      </div>

      {/*
        Stacked over this dialog rather than replacing the Delete button with a
        second one. A button that changes into a more dangerous button under a
        cursor that is already there is a task lost to one extra click, and
        there is no undo.
      */}
      <ConfirmDialog
        open={confirming}
        title="Delete this task?"
        description={
          card
            ? `"${card.title}" and everything on it goes for good. This cannot be undone.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete task"
        busy={saving}
        onConfirm={() => void remove()}
        onClose={() => setConfirming(false)}
      />
    </Modal>
  )
}

/** The stored instant as the day it falls on, locally. */
function toDay(iso: string | null): string {
  if (!iso) return ''

  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  return formatDay(date)
}

/**
 * A chosen day, stored as the last moment of it.
 *
 * A due date is a day, not an instant — but the column holds an instant, so one
 * has to be picked. The end of the day is the only one that means what people
 * mean: stored at midnight, a task due today would be overdue from the moment
 * it was written.
 */
function endOfDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, 23, 59, 59, 999).toISOString()
}
