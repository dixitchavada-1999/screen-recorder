import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import type { TaskCard } from '@shared/types'
import { BoardMembersDialog } from '@/components/BoardMembersDialog'
import { TaskCardDialog } from '@/components/TaskCardDialog'
import type { TaskDialogTarget } from '@/components/TaskCardDialog'
import { TaskListColumn } from '@/components/TaskListColumn'
import { TaskNotesDialog } from '@/components/TaskNotesDialog'
import { TaskTilePreview } from '@/components/TaskCardTile'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/context/ToastContext'
import { useTaskBoard } from '@/hooks/useTaskBoard'
import { useTaskBoards } from '@/hooks/useTaskBoards'
import { toSerializedError } from '@/services/ipc'

/**
 * The task manager.
 *
 * Two screens in one: a list of the boards this person is on, and — once one is
 * picked — that board's columns. Kept in one component because moving between
 * them is a single piece of state rather than a route, and the recorder has no
 * router to give it one.
 */
export function TaskManager(): React.JSX.Element {
  const [openBoardId, setOpenBoardId] = useState<string | null>(null)

  const boards = useTaskBoards()
  const board = useTaskBoard(openBoardId)
  const { can } = useAuth()
  const { push } = useToast()

  /*
   * Asked of the permission, not the role. Two people can hold the same role
   * and need different answers here — which is the whole reason permissions
   * exist — and the same question is asked again by the database.
   */
  const canAddProject = can('tasks.project.create')
  const canAddTask = can('tasks.create')
  const canDeleteTask = can('tasks.delete')

  /*
   * One flag per thing that can be done, rather than one "manage" flag standing
   * for six. Somebody can be trusted to add a section without being trusted to
   * delete the project it is on.
   */
  const rights = {
    editProject: can('tasks.project.edit'),
    deleteProject: can('tasks.project.delete'),
    manageMembers: can('tasks.member.manage'),
    addSection: can('tasks.section.create'),
    editSection: can('tasks.section.edit'),
    deleteSection: can('tasks.section.delete')
  }

  const report = (caught: unknown): void => {
    const failure = toSerializedError(caught)
    push({
      tone: 'error',
      title: failure.message,
      ...(failure.hint ? { description: failure.hint } : {})
    })
  }

  return openBoardId === null ? (
    <BoardPicker
      boards={boards}
      canOpenBoards={canAddProject}
      onOpen={setOpenBoardId}
      onError={report}
    />
  ) : (
    <BoardView
      board={board}
      rights={rights}
      canAddTask={canAddTask}
      canDeleteTask={canDeleteTask}
      onBack={() => setOpenBoardId(null)}
      onDeleted={() => {
        setOpenBoardId(null)
        void boards.refresh()
      }}
      onError={report}
    />
  )
}

/* -------------------------------------------------------------------------- */
/*                                The board list                              */
/* -------------------------------------------------------------------------- */

function BoardPicker({
  boards,
  canOpenBoards,
  onOpen,
  onError
}: {
  boards: ReturnType<typeof useTaskBoards>
  canOpenBoards: boolean
  onOpen: (boardId: string) => void
  onError: (caught: unknown) => void
}): React.JSX.Element {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    const clean = name.trim()
    if (!clean) {
      setNaming(false)
      return
    }

    setBusy(true)
    try {
      const board = await boards.create(clean)
      setName('')
      setNaming(false)
      // Straight into it. Nobody opens a board in order to look at it in a list.
      onOpen(board.id)
    } catch (caught) {
      onError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Task Manager"
      description="Projects you are on. Open one to see what is on it."
      actions={
        <>
          <button
            type="button"
            onClick={() => void boards.refresh()}
            className="text-xs text-muted transition-colors hover:text-ink"
          >
            Refresh
          </button>

          {canOpenBoards && !naming && (
            <Button size="sm" variant="primary" onClick={() => setNaming(true)}>
              + Add project
            </Button>
          )}
        </>
      }
    >
      {naming && (
        <div className="mb-4 flex items-center gap-2">
          <input
            autoFocus
            value={name}
            maxLength={80}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
              if (event.key === 'Escape') {
                setName('')
                setNaming(false)
              }
            }}
            placeholder="What is this project for?"
            className="selectable min-w-0 flex-1 rounded-xl border border-accent bg-surface px-3 py-2 text-sm text-ink"
          />

          <Button size="sm" variant="primary" loading={busy} onClick={() => void create()}>
            Create
          </Button>
        </div>
      )}

      {boards.loading && <p className="text-xs text-faint">Loading boards…</p>}

      {!boards.loading && boards.error && (
        <p className="text-xs text-record-strong">{boards.error.message}</p>
      )}

      {!boards.loading && !boards.error && boards.boards.length === 0 && (
        <p className="text-xs leading-relaxed text-faint">
          {canOpenBoards
            ? 'No projects yet. Add one and put the people who work on it in.'
            : 'You are not on any projects yet. An admin can add you to one.'}
        </p>
      )}

      {boards.boards.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {boards.boards.map((board) => (
            <li key={board.id}>
              <button
                type="button"
                onClick={() => onOpen(board.id)}
                className="flex w-full flex-col gap-2 rounded-xl border border-hairline bg-surface px-4 py-3 text-left transition-colors hover:border-accent/50 hover:bg-canvas-elevated"
              >
                <span className="truncate text-sm font-medium text-ink">{board.name}</span>

                <span className="text-[11px] text-faint">
                  {board.cardCount} {board.cardCount === 1 ? 'task' : 'tasks'}
                  {board.members.length > 0 && ` · ${board.members.length} on it`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*                                  One board                                 */
/* -------------------------------------------------------------------------- */

function BoardView({
  board,
  rights,
  canAddTask,
  canDeleteTask,
  onBack,
  onDeleted,
  onError
}: {
  board: ReturnType<typeof useTaskBoard>
  /** What this account may do inside a project, one answer per action. */
  rights: {
    editProject: boolean
    deleteProject: boolean
    manageMembers: boolean
    addSection: boolean
    editSection: boolean
    deleteSection: boolean
  }
  /** Write a task. Separate: somebody can add work without running the project. */
  canAddTask: boolean
  /** Remove one. Separate again: editing a task is not the same as destroying it. */
  canDeleteTask: boolean
  onBack: () => void
  onDeleted: () => void
  onError: (caught: unknown) => void
}): React.JSX.Element {
  const [cardTarget, setCardTarget] = useState<TaskDialogTarget | null>(null)
  const [notesFor, setNotesFor] = useState<TaskCard | null>(null)
  const [membersOpen, setMembersOpen] = useState(false)
  const [addingList, setAddingList] = useState(false)
  const [listName, setListName] = useState('')
  const [dragging, setDragging] = useState<TaskCard | null>(null)
  const [confirmBoard, setConfirmBoard] = useState(false)
  /** The section waiting on an answer, with the count that makes the question real. */
  const [confirmSection, setConfirmSection] = useState<{ id: string; name: string; tasks: number } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const detail = board.detail

  /*
   * A few pixels of movement before a press counts as a drag.
   *
   * The card is a button as well as a draggable — it opens on a click — and
   * without this every attempt to open one starts a drag instead.
   */
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const cardsByList = useMemo(() => {
    const byList = new Map<string, TaskCard[]>()
    for (const card of detail?.cards ?? []) {
      const list = byList.get(card.listId) ?? []
      list.push(card)
      byList.set(card.listId, list)
    }
    for (const list of byList.values()) list.sort((a, b) => a.position - b.position)
    return byList
  }, [detail])

  const handleDragStart = (event: DragStartEvent): void => {
    setDragging(detail?.cards.find((card) => card.id === event.active.id) ?? null)
  }

  /**
   * Where the card landed, as the two cards it landed between.
   *
   * `dnd-kit` reports what is under the cursor — either a card or an empty
   * column. From that this works out the neighbours; the position they imply is
   * the server's to compute, because this window's idea of the board may be an
   * hour old.
   */
  const handleDragEnd = (event: DragEndEvent): void => {
    setDragging(null)

    const { active, over } = event
    if (!over || !detail) return

    const card = detail.cards.find((entry) => entry.id === active.id)
    if (!card) return

    const overCard = detail.cards.find((entry) => entry.id === over.id)
    const toListId = overCard ? overCard.listId : String(over.id)

    const target = (cardsByList.get(toListId) ?? []).filter((entry) => entry.id !== card.id)

    // Dropped onto the column itself rather than onto a card: the end of it.
    const index = overCard ? target.findIndex((entry) => entry.id === overCard.id) : target.length

    if (index === -1) return

    const beforeCardId = index > 0 ? target[index - 1]!.id : null
    const afterCardId = index < target.length ? target[index]!.id : null

    // Dropped exactly where it already was.
    if (card.listId === toListId && beforeCardId === null && afterCardId === null) return

    void board.moveCard(card.id, { toListId, beforeCardId, afterCardId }).catch(onError)
  }

  const addList = async (): Promise<void> => {
    const clean = listName.trim()
    setAddingList(false)
    setListName('')
    if (!clean) return

    try {
      await board.addList(clean)
    } catch (caught) {
      onError(caught)
    }
  }

  const removeBoard = async (): Promise<void> => {
    if (!detail) return

    setDeleting(true)
    try {
      await window.api.tasks.deleteBoard(detail.board.id)
      setConfirmBoard(false)
      onDeleted()
    } catch (caught) {
      onError(caught)
    } finally {
      setDeleting(false)
    }
  }

  const removeSection = async (): Promise<void> => {
    if (!confirmSection) return

    setDeleting(true)
    try {
      await board.removeList(confirmSection.id)
      setConfirmSection(null)
    } catch (caught) {
      onError(caught)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Card
      title={detail?.board.name ?? 'Board'}
      description={
        detail
          ? `${detail.cards.length} ${detail.cards.length === 1 ? 'task' : 'tasks'} · ${detail.board.members.length} on it`
          : ''
      }
      actions={
        <>
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-muted transition-colors hover:text-ink"
          >
            All projects
          </button>

          {rights.manageMembers && (
            <Button size="sm" variant="secondary" onClick={() => setMembersOpen(true)}>
              Members
            </Button>
          )}

          {/*
            Adding a section is a board action, so it sits with the other
            board actions. It was at the far right of the columns, which put it
            behind a sideways scroll on any board with four sections on it — the
            one moment you most want to add a fifth.
          */}
          {detail &&
            rights.addSection &&
            (addingList ? (
              <input
                autoFocus
                value={listName}
                maxLength={60}
                onChange={(event) => setListName(event.target.value)}
                onBlur={() => void addList()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void addList()
                  if (event.key === 'Escape') {
                    setListName('')
                    setAddingList(false)
                  }
                }}
                placeholder="Section name"
                className="selectable h-8 w-40 rounded-lg border border-accent bg-surface px-2.5 text-xs text-ink"
              />
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setAddingList(true)}>
                + Add section
              </Button>
            ))}

          {rights.deleteProject && (
            <Button size="sm" variant="danger" onClick={() => setConfirmBoard(true)}>
              Delete project
            </Button>
          )}
        </>
      }
    >
      {board.loading && <p className="text-xs text-faint">Loading board…</p>}

      {!board.loading && board.error && (
        <p className="text-xs text-record-strong">{board.error.message}</p>
      )}

      {detail && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          {/*
            The board scrolls sideways inside this strip. It must not widen the
            page — that would push the account sidebar off the window.
          */}
          <div className="flex items-start gap-3 overflow-x-auto pb-2">
            {detail.lists.map((list) => (
              <TaskListColumn
                key={list.id}
                list={list}
                cards={cardsByList.get(list.id) ?? []}
                canEditSection={rights.editSection}
                canDeleteSection={rights.deleteSection}
                canAddTask={canAddTask}
                onOpenCard={(card) => setCardTarget({ kind: 'edit', card })}
                onOpenNotes={setNotesFor}
                onAddCard={(listId) => setCardTarget({ kind: 'new', listId })}
                onRename={async (listId, name) => {
                  try {
                    await board.renameList(listId, name)
                  } catch (caught) {
                    onError(caught)
                  }
                }}
                onRemove={(listId) =>
                  setConfirmSection({
                    id: listId,
                    name: list.name,
                    tasks: (cardsByList.get(listId) ?? []).length
                  })
                }
              />
            ))}
          </div>

          {/*
            The card that follows the cursor.

            Portalled to the body, and that is not a detail. The overlay is
            positioned `fixed`, and `Card` — every panel on this screen — carries
            a `backdrop-blur`. A backdrop-filter makes an element the containing
            block for its fixed-position descendants, so left inside the panel
            the overlay measures from the panel's corner instead of the
            window's, and the card trails the cursor by exactly that offset.
          */}
          {createPortal(
            <DragOverlay>{dragging && <TaskTilePreview card={dragging} />}</DragOverlay>,
            document.body
          )}
        </DndContext>
      )}

      <TaskCardDialog
        target={cardTarget}
        canDelete={canDeleteTask}
        onClose={() => setCardTarget(null)}
        onCreate={board.addCard}
        onSave={board.saveCard}
        onDelete={board.removeCard}
      />

      {/* Re-read on every change so the tile's count follows the conversation. */}
      <TaskNotesDialog
        card={notesFor}
        onClose={() => setNotesFor(null)}
        onChanged={() => void board.refresh()}
      />

      <BoardMembersDialog
        open={membersOpen}
        members={detail?.board.members ?? []}
        onClose={() => setMembersOpen(false)}
        onSave={board.setMembers}
      />

      <ConfirmDialog
        open={confirmBoard}
        title="Delete this project?"
        description={
          detail
            ? `"${detail.board.name}", its sections and all ${detail.cards.length} ${detail.cards.length === 1 ? 'task' : 'tasks'} on it go for good, for everybody on it. This cannot be undone.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete project"
        busy={deleting}
        onConfirm={() => void removeBoard()}
        onClose={() => setConfirmBoard(false)}
      />

      <ConfirmDialog
        open={confirmSection !== null}
        title="Delete this section?"
        description={
          confirmSection
            ? confirmSection.tasks === 0
              ? `"${confirmSection.name}" is empty and will be removed.`
              : `"${confirmSection.name}" and the ${confirmSection.tasks} ${confirmSection.tasks === 1 ? 'task' : 'tasks'} in it go for good. This cannot be undone.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete section"
        busy={deleting}
        onConfirm={() => void removeSection()}
        onClose={() => setConfirmSection(null)}
      />
    </Card>
  )
}
