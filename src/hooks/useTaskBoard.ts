import { useCallback, useEffect, useState } from 'react'
import type {
  SerializedError,
  TaskBoardDetail,
  TaskCard,
  TaskCardInput,
  TaskCardMove,
  TaskPerson
} from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

export interface TaskBoardHandle {
  detail: TaskBoardDetail | null
  loading: boolean
  error: SerializedError | null
  refresh: () => Promise<void>

  addList: (name: string) => Promise<void>
  renameList: (listId: string, name: string) => Promise<void>
  removeList: (listId: string) => Promise<void>

  addCard: (listId: string, input: TaskCardInput) => Promise<void>
  saveCard: (cardId: string, input: TaskCardInput) => Promise<void>
  removeCard: (cardId: string) => Promise<void>
  moveCard: (cardId: string, move: TaskCardMove) => Promise<void>

  setMembers: (nexusIds: string[]) => Promise<TaskPerson[]>
}

/**
 * One board — its lists, its cards, and everything that changes them.
 *
 * Read once when the board is opened and kept in step by hand from each write's
 * own answer, rather than re-read after every keystroke. The one exception is
 * the drag: the card is moved on screen immediately and the server asked
 * afterwards, because a card that waits for a round trip before it lands does
 * not feel like a card being dragged.
 */
export function useTaskBoard(boardId: string | null): TaskBoardHandle {
  const [detail, setDetail] = useState<TaskBoardDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async () => {
    if (!boardId) {
      setDetail(null)
      setLoading(false)
      return
    }

    try {
      setDetail(await unwrap(window.api.tasks.board(boardId)))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [boardId])

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  /* -------------------------------- Lists -------------------------------- */

  const addList = useCallback(
    async (name: string) => {
      if (!boardId) return
      const list = await unwrap(window.api.tasks.createList(boardId, name))
      setDetail((current) => (current ? { ...current, lists: [...current.lists, list] } : current))
    },
    [boardId]
  )

  const renameList = useCallback(async (listId: string, name: string) => {
    await unwrap(window.api.tasks.renameList(listId, name))
    setDetail((current) =>
      current
        ? {
            ...current,
            lists: current.lists.map((list) => (list.id === listId ? { ...list, name } : list))
          }
        : current
    )
  }, [])

  const removeList = useCallback(async (listId: string) => {
    await unwrap(window.api.tasks.deleteList(listId))
    // The cards went with it in the database; they have to go here too.
    setDetail((current) =>
      current
        ? {
            ...current,
            lists: current.lists.filter((list) => list.id !== listId),
            cards: current.cards.filter((card) => card.listId !== listId)
          }
        : current
    )
  }, [])

  /* -------------------------------- Cards -------------------------------- */

  const addCard = useCallback(async (listId: string, input: TaskCardInput) => {
    const card = await unwrap(window.api.tasks.createCard(listId, input))
    setDetail((current) => (current ? { ...current, cards: [...current.cards, card] } : current))
  }, [])

  const saveCard = useCallback(async (cardId: string, input: TaskCardInput) => {
    const card = await unwrap(window.api.tasks.updateCard(cardId, input))
    setDetail((current) => (current ? { ...current, cards: replace(current.cards, card) } : current))
  }, [])

  const removeCard = useCallback(async (cardId: string) => {
    await unwrap(window.api.tasks.deleteCard(cardId))
    setDetail((current) =>
      current ? { ...current, cards: current.cards.filter((card) => card.id !== cardId) } : current
    )
  }, [])

  /**
   * Moves a card, on screen first.
   *
   * The position written here is a guess — the server works out the real one
   * from the neighbours — but it only has to be good enough to keep the card
   * where it was dropped until the answer comes back, which then replaces it.
   * If the write fails the board is re-read, so nothing is left sitting
   * somewhere it was never actually put.
   */
  const moveCard = useCallback(
    async (cardId: string, move: TaskCardMove) => {
      setDetail((current) => (current ? { ...current, cards: guess(current.cards, cardId, move) } : current))

      try {
        const card = await unwrap(window.api.tasks.moveCard(cardId, move))
        setDetail((current) =>
          current ? { ...current, cards: replace(current.cards, card) } : current
        )
      } catch (caught) {
        await refresh()
        throw caught
      }
    },
    [refresh]
  )

  /* ------------------------------- Members ------------------------------- */

  const setMembers = useCallback(
    async (nexusIds: string[]): Promise<TaskPerson[]> => {
      if (!boardId) return []
      const members = await unwrap(window.api.tasks.setBoardMembers(boardId, nexusIds))
      setDetail((current) =>
        current ? { ...current, board: { ...current.board, members } } : current
      )
      return members
    },
    [boardId]
  )

  return {
    detail,
    loading,
    error,
    refresh,
    addList,
    renameList,
    removeList,
    addCard,
    saveCard,
    removeCard,
    moveCard,
    setMembers
  }
}

/* -------------------------------------------------------------------------- */

function replace(cards: TaskCard[], card: TaskCard): TaskCard[] {
  return cards.map((entry) => (entry.id === card.id ? card : entry))
}

/**
 * Where the card sits until the server answers.
 *
 * The same midpoint the server will work out, computed from what this window
 * currently believes. It can be wrong — somebody else may have moved a card in
 * between — and that is why the answer replaces it rather than confirming it.
 */
function guess(cards: TaskCard[], cardId: string, move: TaskCardMove): TaskCard[] {
  const above = move.beforeCardId ? cards.find((card) => card.id === move.beforeCardId) : undefined
  const below = move.afterCardId ? cards.find((card) => card.id === move.afterCardId) : undefined

  let position: number

  if (above && below) position = (above.position + below.position) / 2
  else if (above) position = above.position + 1024
  else if (below) position = below.position / 2
  else {
    const tail = cards
      .filter((card) => card.listId === move.toListId && card.id !== cardId)
      .reduce((max, card) => Math.max(max, card.position), 0)
    position = tail + 1024
  }

  return cards.map((card) =>
    card.id === cardId ? { ...card, listId: move.toListId, position } : card
  )
}
