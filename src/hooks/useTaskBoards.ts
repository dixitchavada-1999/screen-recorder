import { useCallback, useEffect, useState } from 'react'
import type { SerializedError, TaskBoard } from '@shared/types'
import { toSerializedError, unwrap } from '@/services/ipc'

export interface TaskBoardsHandle {
  boards: TaskBoard[]
  loading: boolean
  error: SerializedError | null
  refresh: () => Promise<void>
  create: (name: string) => Promise<TaskBoard>
  rename: (boardId: string, name: string) => Promise<void>
  remove: (boardId: string) => Promise<void>
}

/**
 * The boards this account can see.
 *
 * One call for everybody — row level security decides what that means: the
 * boards this person is a member of, and every board for a super admin. Nothing
 * here branches on the role.
 */
export function useTaskBoards(): TaskBoardsHandle {
  const [boards, setBoards] = useState<TaskBoard[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<SerializedError | null>(null)

  const refresh = useCallback(async () => {
    try {
      setBoards(await unwrap(window.api.tasks.boards()))
      setError(null)
    } catch (caught) {
      setError(toSerializedError(caught))
      setBoards([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(async (name: string): Promise<TaskBoard> => {
    const board = await unwrap(window.api.tasks.createBoard(name))
    // Straight onto the top of the list from the server's own answer, rather
    // than a re-read: the board is already exactly as it was stored.
    setBoards((current) => [board, ...current])
    return board
  }, [])

  const rename = useCallback(async (boardId: string, name: string) => {
    await unwrap(window.api.tasks.renameBoard(boardId, name))
    setBoards((current) =>
      current.map((board) => (board.id === boardId ? { ...board, name } : board))
    )
  }, [])

  const remove = useCallback(async (boardId: string) => {
    await unwrap(window.api.tasks.deleteBoard(boardId))
    setBoards((current) => current.filter((board) => board.id !== boardId))
  }, [])

  return { boards, loading, error, refresh, create, rename, remove }
}
