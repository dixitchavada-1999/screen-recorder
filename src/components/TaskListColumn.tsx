import { useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { TaskCard, TaskList } from '@shared/types'
import { TaskCardTile } from '@/components/TaskCardTile'
import { HoverCard } from '@/components/ui/HoverCard'
import { cn } from '@/utils/cn'

interface TaskListColumnProps {
  list: TaskList
  cards: TaskCard[]
  /** Rename it. */
  canEditSection: boolean
  /** Remove it, and the tasks in it. */
  canDeleteSection: boolean
  /** Write a task into it. */
  canAddTask: boolean
  onOpenCard: (card: TaskCard) => void
  onOpenNotes: (card: TaskCard) => void
  onAddCard: (listId: string) => void
  onRename: (listId: string, name: string) => Promise<void>
  onRemove: (listId: string) => void
}

/**
 * One column on a board.
 *
 * A droppable in its own right as well as a sortable context: without that, a
 * column that has been emptied has nothing left to drop onto, and a card
 * dragged into it would spring back.
 */
export function TaskListColumn({
  list,
  cards,
  canEditSection,
  canDeleteSection,
  canAddTask,
  onOpenCard,
  onOpenNotes,
  onAddCard,
  onRename,
  onRemove
}: TaskListColumnProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(list.name)

  const { setNodeRef, isOver } = useDroppable({ id: list.id, data: { type: 'list' } })

  const rename = async (): Promise<void> => {
    const clean = name.trim()
    setRenaming(false)

    if (!clean || clean === list.name) {
      setName(list.name)
      return
    }

    await onRename(list.id, clean)
  }

  return (
    <section
      ref={setNodeRef}
      className={cn(
        /*
         * Sized as a share of the strip rather than a fixed width, so a window
         * shows whole sections instead of four and a sliver: three side by side
         * at the default size, five once the window is opened out. `gap-3` is
         * 0.75rem, hence two gaps subtracted for three columns and four for
         * five. Anything beyond that runs off the right and the strip scrolls.
         */
        'flex w-[calc((100%-1.5rem)/3)] shrink-0 flex-col xl:w-[calc((100%-3rem)/5)]',
        'rounded-2xl border bg-surface/60 transition-colors',
        isOver ? 'border-accent/50 bg-accent/5' : 'border-hairline'
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        {renaming && canEditSection ? (
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
              if (event.key === 'Escape') {
                setName(list.name)
                setRenaming(false)
              }
            }}
            className="selectable min-w-0 flex-1 rounded-lg border border-accent bg-canvas-elevated px-2 py-1 text-sm font-medium text-ink"
          />
        ) : (
          <HoverCard
            className="min-w-0 flex-1"
            card="Rename this section"
            disabled={!canEditSection}
          >
            <button
              type="button"
              disabled={!canEditSection}
              onClick={() => setRenaming(true)}
              className="w-full truncate text-left text-sm font-medium text-ink disabled:cursor-default"
            >
              {list.name}
            </button>
          </HoverCard>
        )}

        <span className="shrink-0 rounded-md bg-canvas-elevated px-1.5 py-0.5 text-[11px] text-faint">
          {cards.length}
        </span>

        {/*
          The same action as the button at the foot of the column, put where the
          hand already is when you are looking at the section rather than at what
          is in it.

          `HoverCard` rather than the CSS tooltip, and rather than the browser's
          own: the strip these sit in scrolls sideways, which makes it clip
          vertically too, so a bubble drawn below an empty section would be cut
          in half. `HoverCard` draws into the body and escapes that.
        */}
        {canAddTask && (
        <HoverCard className="shrink-0" card="Add task">
          <button
            type="button"
            onClick={() => onAddCard(list.id)}
            className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-canvas-elevated hover:text-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
              <path d="M9 4h2v5h5v2h-5v5H9v-5H4V9h5V4z" />
            </svg>
            <span className="sr-only">Add task</span>
          </button>
        </HoverCard>
        )}

        {canDeleteSection && (
        <HoverCard
          className="shrink-0"
          card={
            cards.length > 0
              ? `Remove this section and its ${cards.length} ${cards.length === 1 ? 'task' : 'tasks'}`
              : 'Remove this section'
          }
        >
          <button
            type="button"
            onClick={() => onRemove(list.id)}
            className="grid size-6 place-items-center rounded-md text-faint transition-colors hover:bg-record/10 hover:text-record-strong"
          >
            <span aria-hidden="true" className="text-base leading-none">
              ×
            </span>
            <span className="sr-only">Remove this section</span>
          </button>
        </HoverCard>
        )}
      </header>

      {/*
        The column scrolls, the board does not. A long list otherwise stretches
        the page and takes every other column's header off the top of it.
      */}
      <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex max-h-[calc(100vh-22rem)] min-h-2 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {cards.map((card) => (
            <TaskCardTile
              key={card.id}
              card={card}
              onOpen={onOpenCard}
              onOpenNotes={onOpenNotes}
            />
          ))}
        </ul>
      </SortableContext>

      {/*
        Opens the same dialog an existing task opens in. A one-line box here
        could only ever capture a title, so anything with a date, a priority or
        somebody's name on it meant writing it and then immediately opening it
        again to finish the job.
      */}
      {canAddTask && (
        <div className="px-2 pb-2">
          <button
            type="button"
            onClick={() => onAddCard(list.id)}
            className="w-full rounded-xl px-3 py-2 text-left text-xs text-muted transition-colors hover:bg-canvas-elevated hover:text-ink"
          >
            + Add task
          </button>
        </div>
      )}
    </section>
  )
}
