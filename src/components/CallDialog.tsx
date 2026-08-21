import { useEffect, useId, useMemo, useState } from 'react'
import type {
  RosterPerson,
  ScheduledCall,
  ScheduledCallInput,
  ScheduledCallStatus
} from '@shared/types'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Controls'
import { useAuth } from '@/context/AuthContext'
import { useRoster } from '@/hooks/useRoster'
import { cn } from '@/utils/cn'

/** Offered lengths. Anything else is possible through the API, not the UI. */

/** What a call lasts when nothing says otherwise. Never shown, never asked. */
const DEFAULT_MINUTES = 30

interface CallDialogProps {
  open: boolean
  /** Existing call to edit, or `null` to create a new one. */
  call: ScheduledCall | null
  /** Exact start a new call opens on. Ignored when editing. */
  defaultStart: Date
  saving: boolean
  onClose: () => void
  onSave: (input: ScheduledCallInput) => Promise<void>
  onDelete: (() => Promise<void>) | null
  /**
   * Open for reading only. Somebody on a call who did not arrange it — and is
   * not a super admin — may look at its details but change nothing, so the
   * fields are disabled and the save and delete are gone.
   */
  readOnly?: boolean
}

/** Creates or edits one scheduled call. */
export function CallDialog({
  open,
  call,
  defaultStart,
  saving,
  onClose,
  onSave,
  onDelete,
  readOnly = false
}: CallDialogProps): React.JSX.Element {
  const formId = useId()

  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  /*
   * Carried rather than chosen.
   *
   * Nobody sets a length any more - a call is a time in the diary, not a block
   * of one. The value still has to exist: the week grid draws a call as tall as
   * it lasts, and an imported Google event brings its real length with it,
   * which editing the title here must not quietly throw away.
   */
  const [duration, setDuration] = useState<number>(DEFAULT_MINUTES)
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState<ScheduledCallStatus>('scheduled')
  /**
   * Whose call it is, by Nexus id.
   *
   * Separate from everybody else on it because they are different questions:
   * one person owns the call, any number join it. Empty means the person
   * arranging it.
   */
  const [owner, setOwner] = useState('')
  /** Everybody else on the call. Never contains the owner. */
  const [joining, setJoining] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const roster = useRoster()
  const { user } = useAuth()

  // Re-seed each time the dialog opens, from the call being edited or from the
  // slot that was clicked.
  useEffect(() => {
    if (!open) return

    const start = call ? new Date(call.startsAt) : defaultStart

    setTitle(call?.title ?? '')
    setDate(toDateInput(start))
    setTime(toTimeInput(start))
    setDuration(call?.durationMinutes ?? DEFAULT_MINUTES)
    setNotes(call?.notes ?? '')
    setStatus(call?.status ?? 'scheduled')

    // The server marks one assignee primary; that is the owner, and everybody
    // else is joining.
    setOwner(call?.assignees.find((person) => person.isPrimary)?.nexusId ?? '')
    setJoining(
      call?.assignees.filter((person) => !person.isPrimary).map((person) => person.nexusId) ?? []
    )

    setError(null)
  }, [open, call, defaultStart])

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setError(null)

    if (!title.trim()) {
      setError('Give the call a title.')
      return
    }

    // `datetime-local` semantics: the two inputs describe a wall-clock time in
    // the user's own timezone, which `new Date` reads exactly that way.
    const startsAt = new Date(`${date}T${time}`)
    if (Number.isNaN(startsAt.getTime())) {
      setError('Pick a valid date and time.')
      return
    }

    try {
      await onSave({
        title: title.trim(),
        startsAt: startsAt.toISOString(),
        durationMinutes: duration,
        notes: notes.trim(),
        status,
        /*
         * Owner first, then everybody joining — the order is what tells the
         * server which one is primary.
         *
         * An unset owner means the person arranging the call. Their own Nexus
         * id is used when anybody else is joining, because the list has to name
         * them explicitly; with nobody joining the list is left empty and the
         * server fills it in, which is also what happens on a machine whose
         * account has not been linked yet.
         */
        assigneeNexusIds: buildAssignees(owner || user?.nexusUserId || '', joining)
      })
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the call.')
    }
  }

  return (
    <Modal
      open={open}
      title={readOnly ? 'Call details' : call ? 'Edit call' : 'Schedule a call'}
      onClose={onClose}
      footer={
        readOnly ? (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            {onDelete && (
              <Button
                variant="danger"
                disabled={saving}
                onClick={() => void onDelete().then(onClose)}
                className="mr-auto"
              >
                Delete
              </Button>
            )}
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" form={formId} variant="primary" loading={saving}>
              {call ? 'Save changes' : 'Schedule'}
            </Button>
          </>
        )
      }
    >
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-xl border border-record/40 bg-record/10 px-3 py-2 text-xs leading-relaxed text-record-strong"
        >
          {error}
        </p>
      )}

      <form id={formId} onSubmit={(event) => void handleSubmit(event)}>
        <fieldset disabled={readOnly} className="grid gap-3 border-0 p-0 disabled:opacity-100">
        <LabelledField label="Title">
          <input
            type="text"
            value={title}
            autoFocus
            placeholder="Client call — billing"
            onChange={(event) => setTitle(event.target.value)}
            className={inputClass}
          />
        </LabelledField>

        <LabelledField label="Whose call">
          <Select
            value={owner}
            onValueChange={setOwner}
            options={ownerOptions(roster.people, roster.all, owner, user?.name ?? 'You')}
          />
        </LabelledField>

        <div>
          <span className="mb-1 block text-xs font-medium text-muted">Also joining</span>
          <PeoplePicker
            people={roster.people}
            all={roster.all}
            loading={roster.loading}
            exclude={owner}
            selected={joining}
            onChange={setJoining}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <LabelledField label="Date">
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className={inputClass}
            />
          </LabelledField>

          <LabelledField label="Time">
            <input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className={inputClass}
            />
          </LabelledField>
        </div>

        {/*
          Only offered on an existing call: a new one is scheduled by
          definition, and the three outcomes are answers to "what happened",
          which nothing has yet.
        */}
        {call && (
          <LabelledField label="Outcome">
            <StatusPicker value={status} onChange={setStatus} />
          </LabelledField>
        )}

        <LabelledField label="Notes">
          <textarea
            rows={3}
            value={notes}
            maxLength={2000}
            placeholder="Agenda, dial-in details, anything to remember"
            onChange={(event) => setNotes(event.target.value)}
            className={cn(inputClass, 'h-auto resize-y py-2 leading-relaxed')}
          />
        </LabelledField>
        </fieldset>
      </form>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * The list the owner is chosen from.
 *
 * "You" leads it and carries no id — an unset owner means the person arranging
 * the call, which is the ordinary case and should not require a choice.
 *
 * Somebody who has left is dropped from the list, except when they own the call
 * being edited: removing their name from under an existing call would silently
 * reassign it on the next save.
 */
function ownerOptions(
  people: RosterPerson[],
  all: RosterPerson[],
  current: string,
  me: string
): Array<{ value: string; label: string }> {
  const options = [
    { value: '', label: `${me} (you)` },
    ...people.map((person) => ({ value: person.nexusId, label: person.name }))
  ]

  if (current && !people.some((person) => person.nexusId === current)) {
    const departed = all.find((person) => person.nexusId === current)
    options.push({
      value: current,
      label: departed ? `${departed.name} (no longer here)` : current
    })
  }

  return options
}

/** Owner first, then everybody joining, with nobody named twice. */
function buildAssignees(owner: string, joining: string[]): string[] {
  if (!owner) return [...new Set(joining)]
  return [...new Set([owner, ...joining])]
}

/**
 * Everybody else on the call.
 *
 * Separate from the owner because they answer different questions — one person
 * owns a call, any number join it — and because a single list made the
 * difference a matter of which chip happened to be first.
 *
 * Everybody listed here sees the call and is reminded about it in exactly the
 * same way as the owner. The distinction is what the schedule shows, not what
 * anybody may do.
 */
function PeoplePicker({
  people,
  all,
  loading,
  exclude,
  selected,
  onChange
}: {
  people: RosterPerson[]
  all: RosterPerson[]
  loading: boolean
  /** The owner, who cannot also be listed as joining their own call. */
  exclude: string
  selected: string[]
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  /** Whether the list is open. Closed is the resting state. */
  const [open, setOpen] = useState(false)

  const names = useMemo(
    () => new Map(all.map((person) => [person.nexusId, person.name])),
    [all]
  )

  /*
   * Nothing is offered until it is asked for.
   *
   * This used to show the first six people whenever the box was empty, which
   * read as a suggestion and was not one — they were simply first in the
   * alphabet. Opening the box shows everybody, scrollable, which is a list;
   * typing narrows it.
   */
  const matches = useMemo(() => {
    if (!open) return []

    const term = search.trim().toLowerCase()
    const available = people.filter(
      (person) => person.nexusId !== exclude && !selected.includes(person.nexusId)
    )

    return term
      ? available.filter((person) => person.name.toLowerCase().includes(term))
      : available
  }, [open, people, selected, search, exclude])

  const add = (nexusId: string): void => {
    onChange([...selected, nexusId])
    // Cleared but left open: adding three people in a row should not mean
    // reopening the list three times.
    setSearch('')
  }

  const remove = (nexusId: string): void =>
    onChange(selected.filter((id) => id !== nexusId))

  return (
    <div className="rounded-xl border border-hairline bg-surface p-2">
      {selected.length === 0 ? (
        <p className="px-1 py-1 text-xs text-faint">
          Nobody else — just the person whose call it is.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5 px-1 pb-2">
          {selected.map((nexusId) => (
            <li key={nexusId}>
              <span className="flex items-center gap-1.5 rounded-lg border border-hairline bg-canvas-elevated px-2 py-1 text-xs text-ink">
                <span className="max-w-[10rem] truncate">{names.get(nexusId) ?? nexusId}</span>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => remove(nexusId)}
                  className="text-faint transition-colors hover:text-record-strong"
                >
                  ×
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        value={search}
        placeholder={loading ? 'Loading people…' : 'Add someone…'}
        disabled={loading}
        onFocus={() => setOpen(true)}
        // Closed on the way out, but not before a click on the list below has
        // had time to land.
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          setSearch(event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false)
        }}
        className="h-8 w-full rounded-lg border border-hairline bg-canvas-elevated px-2 text-xs text-ink transition-colors focus:border-accent focus:outline-none"
      />

      {matches.length > 0 && (
        <ul className="mt-1.5 max-h-40 overflow-y-auto">
          {matches.map((person) => (
            <li key={person.nexusId}>
              <button
                type="button"
                onClick={() => add(person.nexusId)}
                className="w-full truncate rounded-lg px-2 py-1.5 text-left text-xs text-ink transition-colors hover:bg-accent/15 hover:text-accent-strong"
              >
                {person.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {open && search.trim() && matches.length === 0 && (
        <p className="mt-1.5 px-2 text-[11px] text-faint">Nobody by that name.</p>
      )}

      {!loading && people.length === 0 && (
        <p className="mt-1.5 px-1 text-[11px] leading-relaxed text-faint">
          The list of people has not been fetched yet. It refreshes once a day; sign out and in
          again if it stays empty.
        </p>
      )}
    </div>
  )
}

/**
 * Marks what became of a call.
 *
 * `missed` is offered here too, even though the app applies it on its own: it
 * can only ever guess from "nobody said otherwise", so the user has to be able
 * to both correct it and set it deliberately.
 */
function StatusPicker({
  value,
  onChange
}: {
  value: ScheduledCallStatus
  onChange: (status: ScheduledCallStatus) => void
}): React.JSX.Element {
  const options: Array<{ id: ScheduledCallStatus; label: string; tone: string }> = [
    { id: 'scheduled', label: 'Scheduled', tone: 'border-accent bg-accent/15 text-accent-strong' },
    { id: 'completed', label: 'Completed', tone: 'border-positive/50 bg-positive/15 text-positive' },
    { id: 'missed', label: 'Missed', tone: 'border-warning/50 bg-warning/15 text-warning' },
    {
      id: 'cancelled',
      label: 'Cancelled',
      tone: 'border-record/50 bg-record/15 text-record-strong'
    }
  ]

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors',
            value === option.id
              ? option.tone
              : 'border-hairline bg-surface text-muted hover:text-ink'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

const inputClass =
  'selectable h-10 w-full rounded-xl border border-hairline bg-surface px-3 text-sm text-ink transition-colors hover:border-faint focus:border-accent focus:outline-none'

function LabelledField({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}

/** `YYYY-MM-DD` in local time — `toISOString` would shift the day. */
function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function toTimeInput(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
