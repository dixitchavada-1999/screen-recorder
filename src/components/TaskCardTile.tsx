import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { TaskCard, TaskPriority } from '@shared/types'
import { HoverCard } from '@/components/ui/HoverCard'
import { cn } from '@/utils/cn'

interface TaskCardTileProps {
  card: TaskCard
  onOpen: (card: TaskCard) => void
  /** Opens the conversation on this task. */
  onOpenNotes: (card: TaskCard) => void
  /** True while this tile is the one being dragged under the cursor. */
  dragging?: boolean
}

/** Only three of the four are worth a colour. "Normal" is the absence of one. */
const PRIORITY_STYLES: Record<TaskPriority, string | null> = {
  low: 'border-hairline text-faint',
  normal: null,
  high: 'border-warning/40 bg-warning/10 text-warning',
  urgent: 'border-record/40 bg-record/10 text-record-strong'
}

/**
 * One task on a board.
 *
 * Draggable and clickable at once, which is the whole difficulty: a press that
 * turns into a drag must not also count as a click. `dnd-kit`'s pointer sensor
 * is given a small distance threshold in `TaskManager`, so a tap is a tap and a
 * movement of a few pixels is a drag.
 *
 * Two different clicks live here, and they are deliberately not the same one.
 * Clicking a name that has been cut short unrolls it in place — the thing you
 * wanted was to read it, not to open a form over the board. Opening the task
 * itself is the arrow, which is always in the same corner.
 */
export function TaskCardTile({
  card,
  onOpen,
  onOpenNotes,
  dragging
}: TaskCardTileProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    // Moving a task between sections is changing it. Somebody who may only read
    // it should not be able to pick it up and find the drop refused.
    disabled: !card.editable,
    data: { type: 'card', listId: card.listId }
  })

  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)
  const nameRef = useRef<HTMLParagraphElement>(null)

  /*
   * Whether the name is actually being cut short.
   *
   * Measured rather than guessed at from its length: a column is a different
   * width on a maximised window than on a small one, so the same name is three
   * lines in one and two in the other. Without this a short name would still
   * offer a click that visibly does nothing.
   *
   * Re-measured when the column resizes, which is what `ResizeObserver` is for.
   */
  useEffect(() => {
    const element = nameRef.current
    if (!element) return

    const measure = (): void => {
      if (expanded) return
      setClamped(element.scrollHeight > element.clientHeight + 1)
    }

    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [card.title, expanded])

  const unrollable = clamped || expanded

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      /*
       * The drag handle is the whole tile, not one element inside it —
       * otherwise the strip of badges along the bottom would be dead to the
       * pointer, and a task is most easily picked up by whatever part of it is
       * under the cursor.
       */
      {...listeners}
      className={cn(
        'rounded-xl border border-hairline bg-canvas-elevated transition-colors hover:border-faint',
        card.editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        // The original keeps its place as a hole while the copy follows the
        // cursor — without this the column collapses and re-expands under the
        // pointer, and the drop target moves out from under the card.
        isDragging && 'opacity-40',
        dragging && 'rotate-2 shadow-2xl shadow-black/50'
      )}
    >
      {/*
        One click, two meanings, decided by whether there is anything hidden: a
        name that has been cut short unrolls, and a name already shown in full
        opens the task. Neither leaves a click that does nothing, which is what
        a name short enough to fit used to give.
      */}
      <button
        type="button"
        onClick={() => (unrollable ? setExpanded((open) => !open) : onOpen(card))}
        {...attributes}
        className="w-full px-3 pt-2.5 text-left"
      >
        <p
          ref={nameRef}
          className={cn(
            // `break-words` is for the unbroken strings people paste in — a
            // ticket reference or a URL would otherwise widen the tile past its
            // column.
            'break-words text-sm leading-snug text-ink',
            !expanded && 'line-clamp-3'
          )}
        >
          {card.title}
        </p>

        {unrollable && (
          <span className="mt-0.5 inline-block text-[10px] text-faint">
            {expanded ? 'Show less' : 'Show more'}
          </span>
        )}
      </button>

      {/*
        The whole strip opens the task, not only the arrow. The arrow says where
        to aim and keeps the action reachable from a keyboard; the rest of the
        row is the larger target the pointer actually goes for.
      */}
      <div
        onClick={() => onOpen(card)}
        className="flex cursor-pointer flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-2"
      >
        <TaskBadges card={card} />

        {/*
          The thread. Carries its count, so a task with a conversation on it says
          so from the board — the reason to open one is usually that somebody
          has already said something.

          Absent for anybody the notes are not for: they belong to the people the
          task is assigned to, and to whoever can see every task.
        */}
        {card.notesVisible && (
        <HoverCard
          className="ml-auto shrink-0"
          card={
            card.noteCount === 0
              ? 'Add a note'
              : `${card.noteCount} ${card.noteCount === 1 ? 'note' : 'notes'}`
          }
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onOpenNotes(card)
            }}
            className={cn(
              'flex h-5 items-center gap-1 rounded-md px-1 transition-colors hover:bg-surface hover:text-ink',
              card.noteCount > 0 ? 'text-muted' : 'text-faint'
            )}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
              <path d="M4 3h12a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 16 14H8.7l-3.4 2.8A.75.75 0 0 1 4 16.2V14a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 4 3z" />
            </svg>
            {card.noteCount > 0 && <span className="text-[10px]">{card.noteCount}</span>}
            <span className="sr-only">Notes on this task</span>
          </button>
        </HoverCard>
        )}

        {/* Always in the same corner, so opening a task is one place to aim at. */}
        <HoverCard className={cn('shrink-0', !card.notesVisible && 'ml-auto')} card="Open this task">
          <button
            type="button"
            onClick={(event) => {
              // The row behind it opens the task too; without this the click
              // counts twice.
              event.stopPropagation()
              onOpen(card)
            }}
            className="grid size-5 place-items-center rounded-md text-faint transition-colors hover:bg-surface hover:text-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
              <path d="M7 3h10v10h-2V6.4L5.7 15.7 4.3 14.3 13.6 5H7V3z" />
            </svg>
            <span className="sr-only">Open this task</span>
          </button>
        </HoverCard>
      </div>
    </li>
  )
}

/**
 * The task's badges: how urgent, when it is due, who is on it.
 *
 * Its own component because the card that follows the cursor while dragging
 * wears the same ones. A drag preview that showed only the name looked like a
 * different, emptier task than the one being picked up.
 */
function TaskBadges({
  card,
  interactive = true
}: {
  card: TaskCard
  /** False inside the drag preview, where nothing can be hovered anyway. */
  interactive?: boolean
}): React.JSX.Element {
  const due = card.dueAt ? new Date(card.dueAt) : null
  const overdue = due !== null && due.getTime() < Date.now()
  const priority = PRIORITY_STYLES[card.priority]

  const eye = (
    <span className="flex items-center gap-1 rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-muted transition-colors hover:border-faint hover:text-ink">
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3">
        <path d="M10 4c-3.5 0-6.4 2.2-7.8 5.3a1.7 1.7 0 0 0 0 1.4C3.6 13.8 6.5 16 10 16s6.4-2.2 7.8-5.3a1.7 1.7 0 0 0 0-1.4C16.4 6.2 13.5 4 10 4zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
      </svg>
      {card.assignees.length > 1 && card.assignees.length}
      <span className="sr-only">
        Assigned to {card.assignees.map((person) => person.name).join(', ')}
      </span>
    </span>
  )

  return (
    <>
        {priority && (
          <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] capitalize', priority)}>
            {card.priority}
          </span>
        )}

        {due && (
          <HoverCard
            card={`${overdue ? 'Was due' : 'Due'} ${due.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })}`}
          >
            <span
              className={cn(
                'rounded-md border px-1.5 py-0.5 text-[10px]',
                overdue
                  ? 'border-record/40 bg-record/10 text-record-strong'
                  : 'border-hairline text-muted'
              )}
            >
              {due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </span>
          </HoverCard>
        )}

        {/*
          One eye rather than a row of initials. Three sets of initials tell you
          there are three people and which three only if you already know
          everybody's; the names themselves are a hover away, and a column read
          at a glance stays readable.

          `HoverCard` draws into the body, which is what keeps the names out of
          the column's own scroll box.
        */}
        {card.assignees.length > 0 &&
          (interactive ? (
            <HoverCard
              className="inline-flex"
              card={
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wide text-faint">Assigned to</p>
                  <ul className="flex flex-col gap-0.5">
                    {card.assignees.map((person) => (
                      <li key={person.nexusId} className="whitespace-nowrap text-xs text-ink">
                        {person.name}
                      </li>
                    ))}
                  </ul>
                </div>
              }
            >
              {eye}
            </HoverCard>
          ) : (
            eye
          ))}
    </>
  )
}

/**
 * The copy that follows the cursor while a task is being dragged.
 *
 * The whole tile, badges and all — `DragOverlay` measures the tile being
 * dragged and sizes this to match, so `h-full w-full` makes it the same shape
 * rather than a guess at one.
 */
export function TaskTilePreview({ card }: { card: TaskCard }): React.JSX.Element {
  return (
    <div className="h-full w-full rotate-2 rounded-xl border border-accent/50 bg-canvas-elevated shadow-2xl shadow-black/50">
      <div className="px-3 pt-2.5">
        <p className="line-clamp-3 break-words text-sm leading-snug text-ink">{card.title}</p>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2.5 pt-2">
        <TaskBadges card={card} interactive={false} />
      </div>
    </div>
  )
}
