import { randomUUID } from 'node:crypto'
import type {
  TaskBoard,
  TaskBoardDetail,
  TaskCard,
  TaskCardInput,
  TaskCardMove,
  TaskDueToday,
  TaskList,
  TaskNote,
  TaskPerson,
  TaskPriority
} from '@shared/types'
import { AppError, ERROR_CODES } from '../lib/errors'
import { logger } from '../lib/logger'
import { currentUser, getSupabase } from './auth'

const SCOPE = 'tasks'

/**
 * Task boards — the kanban module.
 *
 * Everything here runs as the signed-in account, so row level security is what
 * actually decides the answers: the boards this person is a member of, plus all
 * of them for a super admin. The checks in this file turn a refusal into a
 * sentence somebody can act on; they are not the protection.
 *
 * Cards and membership are keyed by Nexus id rather than by an app account, the
 * same identity `scheduled_call_assignees` and `kpi_note_recipients` use. A
 * board can be staffed before those people have ever opened the recorder.
 */

/* -------------------------------------------------------------------------- */
/*                                  Ordering                                  */
/* -------------------------------------------------------------------------- */

/**
 * The gap between two freshly numbered neighbours.
 *
 * Large enough that halving it repeatedly takes a long time to matter, small
 * enough that a list of thousands still fits comfortably inside a double.
 */
const STEP = 1024

/**
 * How close two positions may get before the midpoint between them stops being
 * a distinct number.
 *
 * Doubles have about 15 significant digits, so halving a gap of 1024 runs out
 * after roughly fifty drags into the same seam. Well before that, `rebalance`
 * spreads the list back out. This is the tripwire, not the limit.
 */
const MIN_GAP = 1e-6

interface BoardRow {
  id: string
  name: string
  created_by: string
  created_at: string
}

interface ListRow {
  id: string
  board_id: string
  name: string
  position: number
}

interface CardRow {
  id: string
  list_id: string
  board_id: string
  created_by: string
  title: string
  description: string
  position: number
  due_at: string | null
  priority: TaskPriority
  created_at: string
  updated_at: string
}

/* -------------------------------------------------------------------------- */
/*                                   Boards                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every board this account can see, newest first, without their contents.
 *
 * The counts and the membership are two extra reads rather than a nested query.
 * The count reads one narrow column — never the cards themselves — so a picker
 * showing ten boards costs the same whether they hold ten cards or a thousand.
 */
export async function listBoards(): Promise<TaskBoard[]> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('task_boards')
    .select('id, name, created_by, created_at')
    .order('created_at', { ascending: false })

  if (error) throw translate(error, 'read your projects')

  const rows = (data ?? []) as BoardRow[]
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const [members, counts] = await Promise.all([readBoardMembers(ids), countCards(ids)])

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    members: members.get(row.id) ?? [],
    cardCount: counts.get(row.id) ?? 0
  }))
}

/**
 * One board with everything on it.
 *
 * Three flat reads and a stitch in memory rather than nested selects. The
 * policies have already narrowed each table to this person's boards, so asking
 * for "the lists on this board" is a filter, not a permission question.
 */
export async function readBoard(boardId: string): Promise<TaskBoardDetail> {
  requireUser()
  const supabase = getSupabase()

  const { data: boardData, error: boardError } = await supabase
    .from('task_boards')
    .select('id, name, created_by, created_at')
    .eq('id', boardId)
    .maybeSingle()

  if (boardError) throw translate(boardError, 'open that project')
  if (!boardData) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'That project is not there any more.',
      'It may have been removed, or you may no longer be on it.'
    )
  }

  const board = boardData as BoardRow

  const [listResult, cardResult] = await Promise.all([
    supabase
      .from('task_lists')
      .select('id, board_id, name, position')
      .eq('board_id', boardId)
      .order('position'),
    supabase
      .from('task_cards')
      .select(
        'id, list_id, board_id, created_by, title, description, position, due_at, priority, created_at, updated_at'
      )
      .eq('board_id', boardId)
      .order('position')
  ])

  if (listResult.error) throw translate(listResult.error, 'read that board')
  if (cardResult.error) throw translate(cardResult.error, 'read that board')

  const lists = ((listResult.data ?? []) as ListRow[]).map(toTaskList)
  const cardRows = (cardResult.data ?? []) as CardRow[]

  const [assignees, notes, members] = await Promise.all([
    readCardAssignees(cardRows.map((row) => row.id)),
    countNotes(cardRows.map((row) => row.id)),
    readBoardMembers([boardId])
  ])

  return {
    board: {
      id: board.id,
      name: board.name,
      createdBy: board.created_by,
      createdAt: board.created_at,
      members: members.get(board.id) ?? [],
      cardCount: cardRows.length
    },
    lists,
    cards: cardRows.map((row) =>
      toTaskCard(row, assignees.get(row.id) ?? [], notes.get(row.id) ?? 0)
    )
  }
}

/**
 * Everything falling due today, wherever it lives.
 *
 * "Today" is the machine's own day, not the server's: somebody in India whose
 * task is due at 6pm should stop seeing it at midnight where they are, and a
 * `timestamptz` compared against a UTC day would move that boundary by five and
 * a half hours.
 *
 * Nothing here decides whose tasks these are — the same policy that shapes a
 * board shapes this. A member of staff gets their own; somebody holding
 * `tasks.view_all` gets the day across every project, which on a dashboard is
 * the point of holding it.
 */
export async function listTasksDueToday(): Promise<TaskDueToday[]> {
  requireUser()

  const from = new Date()
  from.setHours(0, 0, 0, 0)

  const to = new Date(from)
  to.setDate(to.getDate() + 1)

  const { data, error } = await getSupabase()
    .from('task_cards')
    .select(
      'id, list_id, board_id, created_by, title, description, position, due_at, priority, created_at, updated_at'
    )
    .gte('due_at', from.toISOString())
    // Half-open: a task due at exactly midnight belongs to tomorrow.
    .lt('due_at', to.toISOString())
    .order('due_at')

  if (error) throw translate(error, 'read what is due today')

  const rows = (data ?? []) as CardRow[]
  if (rows.length === 0) return []

  const [assignees, boards] = await Promise.all([
    readCardAssignees(rows.map((row) => row.id)),
    readBoardNames([...new Set(rows.map((row) => row.board_id))])
  ])

  return rows.map((row) => ({
    ...toTaskCard(row, assignees.get(row.id) ?? []),
    boardName: boards.get(row.board_id) ?? 'A project'
  }))
}

/**
 * Opens a board, and puts its author on it.
 *
 * The membership row is not a nicety: visibility runs through it, so a board
 * created without one would be invisible to the person who just made it — and
 * to everybody else, which is worse, because nobody could staff it either.
 *
 * Written in three steps, and the shape is forced by that ordering. Asking the
 * insert to hand the row back — `.insert(…).select()` — makes Postgres apply
 * the *read* policy to the new row before returning it, and at that instant the
 * board has no members, so it is not yet readable by the person creating it.
 * The whole statement is then refused as a policy violation. A super admin
 * never saw this, because they can read every board either way.
 *
 * So the id is chosen here, nothing is returned from the write, the membership
 * is added, and only then is the board read back — by which point it is a board
 * this person is on.
 */
export async function createBoard(name: string): Promise<TaskBoard> {
  const user = requireProjectCreator()
  const clean = text(name, 80, 'Give the project a name.', 'That project name is too long.')

  /*
   * Without a Nexus identity there is nobody to put on the board, and a board
   * with no members is one only a super admin can see. Refused here rather than
   * created and abandoned.
   */
  if (!user.nexusId) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'Your account is not linked to Nexus yet.',
      'Sign out and back in, then try again.'
    )
  }

  const supabase = getSupabase()
  const id = randomUUID()

  const { error } = await supabase
    .from('task_boards')
    .insert({ id, name: clean, created_by: user.id })

  if (error) throw translate(error, 'add that project')

  const { error: memberError } = await supabase
    .from('task_board_members')
    .insert({ board_id: id, nexus_id: user.nexusId })

  if (memberError) {
    // A board nobody can see is worse than no board: it cannot even be removed
    // through the app. Take it back out and say so.
    await supabase.from('task_boards').delete().eq('id', id)
    throw translate(memberError, 'put you on that project')
  }

  const { data, error: readError } = await supabase
    .from('task_boards')
    .select('id, name, created_by, created_at')
    .eq('id', id)
    .single()

  if (readError) throw translate(readError, 'open that project')

  const board = data as BoardRow

  logger.info(SCOPE, 'Project added', { id: board.id })

  const members = await readBoardMembers([board.id])

  return {
    id: board.id,
    name: board.name,
    createdBy: board.created_by,
    createdAt: board.created_at,
    members: members.get(board.id) ?? [],
    cardCount: 0
  }
}

export async function renameBoard(boardId: string, name: string): Promise<void> {
  requireUser()
  const clean = text(name, 80, 'Give the project a name.', 'That project name is too long.')

  const { data, error } = await getSupabase()
    .from('task_boards')
    .update({ name: clean })
    .eq('id', boardId)
    .select('id')

  if (error) throw translate(error, 'rename that project')
  if ((data ?? []).length === 0) throw refused('rename that project')
}

/** Takes the lists and cards with it — the foreign keys cascade. */
export async function deleteBoard(boardId: string): Promise<void> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('task_boards')
    .delete()
    .eq('id', boardId)
    .select('id')

  if (error) throw translate(error, 'remove that project')
  if ((data ?? []).length === 0) throw refused('remove that project')

  logger.info(SCOPE, 'Project removed', { id: boardId })
}

/**
 * Replaces who is on a board.
 *
 * Written as a difference rather than a delete-then-insert. Clearing the table
 * first would, for the moment between the two writes, make the board invisible
 * to everybody including the person doing the editing — and if the insert then
 * failed, permanently.
 */
export async function setBoardMembers(
  boardId: string,
  nexusIds: string[]
): Promise<TaskPerson[]> {
  requireUser()

  const wanted = new Set(nexusIds.filter((id) => typeof id === 'string' && id))
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('task_board_members')
    .select('nexus_id')
    .eq('board_id', boardId)

  if (error) throw translate(error, 'read who is on that project')

  const current = new Set(((data ?? []) as Array<{ nexus_id: string }>).map((r) => r.nexus_id))

  const added = [...wanted].filter((id) => !current.has(id))
  const removed = [...current].filter((id) => !wanted.has(id))

  if (added.length > 0) {
    const { error: addError } = await supabase
      .from('task_board_members')
      .insert(added.map((nexusId) => ({ board_id: boardId, nexus_id: nexusId })))

    if (addError) throw translate(addError, 'add somebody to that project')
  }

  if (removed.length > 0) {
    const { error: removeError } = await supabase
      .from('task_board_members')
      .delete()
      .eq('board_id', boardId)
      .in('nexus_id', removed)

    if (removeError) throw translate(removeError, 'take somebody off that project')
  }

  logger.info(SCOPE, 'Project membership set', {
    id: boardId,
    added: added.length,
    removed: removed.length
  })

  return (await readBoardMembers([boardId])).get(boardId) ?? []
}

/* -------------------------------------------------------------------------- */
/*                                    Lists                                   */
/* -------------------------------------------------------------------------- */

/** Adds a section at the right-hand end of the board. */
export async function createList(boardId: string, name: string): Promise<TaskList> {
  requireUser()
  const clean = text(name, 60, 'Give the section a name.', 'That section name is too long.')

  const supabase = getSupabase()

  const { data: last, error: lastError } = await supabase
    .from('task_lists')
    .select('position')
    .eq('board_id', boardId)
    .order('position', { ascending: false })
    .limit(1)

  if (lastError) throw translate(lastError, 'add that section')

  const tail = ((last ?? []) as Array<{ position: number }>)[0]

  const { data, error } = await supabase
    .from('task_lists')
    .insert({ board_id: boardId, name: clean, position: (tail?.position ?? 0) + STEP })
    .select('id, board_id, name, position')
    .single()

  if (error) throw translate(error, 'add that section')

  return toTaskList(data as ListRow)
}

export async function renameList(listId: string, name: string): Promise<void> {
  requireUser()
  const clean = text(name, 60, 'Give the section a name.', 'That section name is too long.')

  const { data, error } = await getSupabase()
    .from('task_lists')
    .update({ name: clean })
    .eq('id', listId)
    .select('id')

  if (error) throw translate(error, 'rename that section')
  if ((data ?? []).length === 0) throw refused('rename that section')
}

/** Takes the tasks in it with it. */
export async function deleteList(listId: string): Promise<void> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('task_lists')
    .delete()
    .eq('id', listId)
    .select('id')

  if (error) throw translate(error, 'remove that section')
  if ((data ?? []).length === 0) throw refused('remove that section')
}

/* -------------------------------------------------------------------------- */
/*                                    Cards                                   */
/* -------------------------------------------------------------------------- */

/** Adds a card at the bottom of a list. */
export async function createCard(listId: string, input: TaskCardInput): Promise<TaskCard> {
  const user = requireUser()
  const fields = validate(input)

  const supabase = getSupabase()

  const { data: listData, error: listError } = await supabase
    .from('task_lists')
    .select('id, board_id')
    .eq('id', listId)
    .maybeSingle()

  if (listError) throw translate(listError, 'add that card')
  if (!listData) {
    throw new AppError(ERROR_CODES.UNKNOWN, 'That section is not there any more.')
  }

  const list = listData as { id: string; board_id: string }

  const { data: last, error: lastError } = await supabase
    .from('task_cards')
    .select('position')
    .eq('list_id', listId)
    .order('position', { ascending: false })
    .limit(1)

  if (lastError) throw translate(lastError, 'add that card')

  const tail = ((last ?? []) as Array<{ position: number }>)[0]

  const { data, error } = await supabase
    .from('task_cards')
    .insert({
      list_id: listId,
      board_id: list.board_id,
      created_by: user.id,
      position: (tail?.position ?? 0) + STEP,
      ...fields
    })
    .select(
      'id, list_id, board_id, created_by, title, description, position, due_at, priority, created_at, updated_at'
    )
    .single()

  if (error) throw translate(error, 'add that card')

  const card = data as CardRow
  const assignees = await setAssignees(card.id, input.assigneeNexusIds)

  return toTaskCard(card, assignees)
}

/**
 * Changes a card. Only the fields actually given are touched.
 *
 * Passing `assigneeNexusIds` replaces the whole list; leaving it out leaves the
 * assignees alone. Clearing a due date is `null`, which is a value — leaving it
 * undefined means "do not touch", and the two must not be confused.
 */
export async function updateCard(cardId: string, input: TaskCardInput): Promise<TaskCard> {
  requireUser()

  const patch = validate(input, { partial: true })
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('task_cards')
    .update(patch)
    .eq('id', cardId)
    .select(
      'id, list_id, board_id, created_by, title, description, position, due_at, priority, created_at, updated_at'
    )
    .single()

  if (error) throw translate(error, 'change that task')

  const card = data as CardRow

  const assignees =
    input.assigneeNexusIds === undefined
      ? (await readCardAssignees([card.id])).get(card.id) ?? []
      : await setAssignees(card.id, input.assigneeNexusIds)

  return toTaskCard(card, assignees, await noteCountOf(card.id))
}

/**
 * Moves a card to where it was dropped.
 *
 * The window sends the two cards it landed between; the position it takes is
 * worked out here. That is deliberate — a renderer computing float positions
 * would be one stale board away from writing a number that lands the card
 * somewhere nobody dropped it.
 */
export async function moveCard(cardId: string, move: TaskCardMove): Promise<TaskCard> {
  requireUser()
  const supabase = getSupabase()

  const { data: listData, error: listError } = await supabase
    .from('task_lists')
    .select('id, board_id')
    .eq('id', move.toListId)
    .maybeSingle()

  if (listError) throw translate(listError, 'move that card')
  if (!listData) throw new AppError(ERROR_CODES.UNKNOWN, 'That section is not there any more.')

  const list = listData as { id: string; board_id: string }

  let position = await positionBetween(move.toListId, move.beforeCardId, move.afterCardId)

  // The seam has been halved into oblivion. Spread the list out and ask again.
  if (position === null) {
    await rebalance(move.toListId)
    position = await positionBetween(move.toListId, move.beforeCardId, move.afterCardId)
  }

  if (position === null) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'Could not work out where that card goes.',
      'Refresh the board and try the move again.'
    )
  }

  const { data, error } = await supabase
    .from('task_cards')
    .update({ list_id: move.toListId, board_id: list.board_id, position })
    .eq('id', cardId)
    .select(
      'id, list_id, board_id, created_by, title, description, position, due_at, priority, created_at, updated_at'
    )
    .single()

  if (error) throw translate(error, 'move that task')

  const card = data as CardRow
  const assignees = (await readCardAssignees([card.id])).get(card.id) ?? []

  return toTaskCard(card, assignees, await noteCountOf(card.id))
}

export async function deleteCard(cardId: string): Promise<void> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('task_cards')
    .delete()
    .eq('id', cardId)
    .select('id')

  if (error) throw translate(error, 'remove that task')
  if ((data ?? []).length === 0) throw refused('remove that task')
}

/* -------------------------------------------------------------------------- */
/*                                    Notes                                   */
/* -------------------------------------------------------------------------- */

interface NoteRow {
  id: string
  card_id: string
  author_id: string
  author_name: string
  body: string
  created_at: string
}

/**
 * The conversation on one task, oldest first.
 *
 * Oldest first because it is a conversation: read top to bottom, and the newest
 * thing is where the eye already is when the box to write in sits beneath it.
 */
export async function listCardNotes(cardId: string): Promise<TaskNote[]> {
  const user = requireUser()

  const { data, error } = await getSupabase()
    .from('task_card_notes')
    .select('id, card_id, author_id, author_name, body, created_at')
    .eq('card_id', cardId)
    .order('created_at')

  if (error) throw translate(error, 'read the notes on that task')

  const canRemoveAny = can('tasks.delete')

  return ((data ?? []) as NoteRow[]).map((row) => ({
    id: row.id,
    cardId: row.card_id,
    authorId: row.author_id,
    authorName: row.author_name || 'Somebody',
    body: row.body,
    createdAt: row.created_at,
    removable: row.author_id === user.id || canRemoveAny
  }))
}

/** Adds one note, under the writer's own name. */
export async function addCardNote(cardId: string, body: string): Promise<TaskNote> {
  const user = requireUser()

  const text = body.trim()
  if (!text) throw new AppError(ERROR_CODES.UNKNOWN, 'Write something first.')
  if (text.length > 4000) {
    throw new AppError(
      ERROR_CODES.UNKNOWN,
      'That note is too long.',
      'Keep it under 4000 characters.'
    )
  }

  if (!can('tasks.comment')) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'You cannot add notes to a task.',
      'The database refuses this regardless of what the window shows.'
    )
  }

  const { data, error } = await getSupabase()
    .from('task_card_notes')
    .insert({ card_id: cardId, author_id: user.id, author_name: user.name, body: text })
    .select('id, card_id, author_id, author_name, body, created_at')
    .single()

  if (error) throw translate(error, 'add that note')

  const row = data as NoteRow

  return {
    id: row.id,
    cardId: row.card_id,
    authorId: row.author_id,
    authorName: row.author_name || user.name,
    body: row.body,
    createdAt: row.created_at,
    removable: true
  }
}

export async function deleteCardNote(noteId: string): Promise<void> {
  requireUser()

  const { data, error } = await getSupabase()
    .from('task_card_notes')
    .delete()
    .eq('id', noteId)
    .select('id')

  if (error) throw translate(error, 'remove that note')
  if ((data ?? []).length === 0) throw refused('remove that note')
}

/**
 * How many notes one task carries.
 *
 * Needed because every write that hands a task back — an edit, a drag — rebuilds
 * it from the row, and a row does not know about its notes. Without this the
 * count on the tile vanished the moment anybody touched the task, and came back
 * only on the next full read of the board.
 */
async function noteCountOf(cardId: string): Promise<number> {
  return (await countNotes([cardId])).get(cardId) ?? 0
}

/**
 * How many notes each of the given tasks carries.
 *
 * One narrow column, counted here — never the notes themselves. A board with
 * forty tasks should not read four hundred messages to draw forty small numbers.
 */
async function countNotes(cardIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (cardIds.length === 0) return counts

  const { data, error } = await getSupabase()
    .from('task_card_notes')
    .select('card_id')
    .in('card_id', cardIds)

  if (error) {
    // A task is worth showing without knowing how much was said about it.
    logger.warn(SCOPE, 'Could not count the notes on the tasks', error)
    return counts
  }

  for (const row of (data ?? []) as Array<{ card_id: string }>) {
    counts.set(row.card_id, (counts.get(row.card_id) ?? 0) + 1)
  }

  return counts
}

/* -------------------------------------------------------------------------- */
/*                                  Positions                                 */
/* -------------------------------------------------------------------------- */

/**
 * The position a card should take between two neighbours.
 *
 * Null when the two are already so close that the midpoint between them is not
 * a distinct number — the caller's cue to spread the list out and ask again.
 *
 * The neighbours are read back from the database rather than trusted from the
 * window: a board that has been open for an hour may be describing a gap that
 * no longer exists.
 */
async function positionBetween(
  listId: string,
  beforeCardId: string | null,
  afterCardId: string | null
): Promise<number | null> {
  const supabase = getSupabase()

  const ids = [beforeCardId, afterCardId].filter((id): id is string => typeof id === 'string' && !!id)

  const positions = new Map<string, number>()

  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('task_cards')
      .select('id, position')
      .eq('list_id', listId)
      .in('id', ids)

    if (error) throw translate(error, 'move that card')

    for (const row of (data ?? []) as Array<{ id: string; position: number }>) {
      positions.set(row.id, row.position)
    }
  }

  const above = beforeCardId ? positions.get(beforeCardId) : undefined
  const below = afterCardId ? positions.get(afterCardId) : undefined

  // Between two cards.
  if (above !== undefined && below !== undefined) {
    return below - above < MIN_GAP ? null : (above + below) / 2
  }

  // Below the last card.
  if (above !== undefined) return above + STEP

  // Above the first card. Halving keeps it positive however often it happens.
  if (below !== undefined) return below < MIN_GAP ? null : below / 2

  /*
   * Neither neighbour is there. Either the list is empty, or the cards the
   * window named have moved on — in both cases the honest answer is the end of
   * the list as it stands now.
   */
  const { data, error } = await supabase
    .from('task_cards')
    .select('position')
    .eq('list_id', listId)
    .order('position', { ascending: false })
    .limit(1)

  if (error) throw translate(error, 'move that card')

  const tail = ((data ?? []) as Array<{ position: number }>)[0]

  return (tail?.position ?? 0) + STEP
}

/**
 * Spreads one list back out to `STEP`-sized gaps, keeping the order it has.
 *
 * The expensive path, and the reason the cheap one can stay cheap. It touches
 * one list, only after tens of drags into the same seam, and the order it
 * writes is the order already on screen — so nothing appears to move.
 */
async function rebalance(listId: string): Promise<void> {
  const supabase = getSupabase()

  const { data, error } = await supabase
    .from('task_cards')
    .select('id')
    .eq('list_id', listId)
    .order('position')

  if (error) throw translate(error, 'tidy up that section')

  const rows = (data ?? []) as Array<{ id: string }>

  for (const [index, row] of rows.entries()) {
    const { error: writeError } = await supabase
      .from('task_cards')
      .update({ position: (index + 1) * STEP })
      .eq('id', row.id)

    if (writeError) throw translate(writeError, 'tidy up that section')
  }

  logger.info(SCOPE, 'List positions rebalanced', { listId, cards: rows.length })
}

/* -------------------------------------------------------------------------- */
/*                                   People                                   */
/* -------------------------------------------------------------------------- */

/**
 * Replaces a card's assignees, and answers with who is on it afterwards.
 *
 * `undefined` means the caller did not mention them and they stay as they are.
 * An empty array means the caller cleared them, which is a different thing.
 */
async function setAssignees(
  cardId: string,
  nexusIds: string[] | undefined
): Promise<TaskPerson[]> {
  if (nexusIds === undefined) {
    return (await readCardAssignees([cardId])).get(cardId) ?? []
  }

  const supabase = getSupabase()
  const wanted = [...new Set(nexusIds.filter((id) => typeof id === 'string' && id))]

  const { error: clearError } = await supabase
    .from('task_card_assignees')
    .delete()
    .eq('card_id', cardId)

  if (clearError) throw translate(clearError, 'set who that card is for')

  if (wanted.length > 0) {
    const { error } = await supabase
      .from('task_card_assignees')
      .insert(wanted.map((nexusId) => ({ card_id: cardId, nexus_id: nexusId })))

    if (error) throw translate(error, 'set who that card is for')
  }

  return (await readCardAssignees([cardId])).get(cardId) ?? []
}

/** Who each of the given cards is for, as names. */
async function readCardAssignees(cardIds: string[]): Promise<Map<string, TaskPerson[]>> {
  const byCard = new Map<string, TaskPerson[]>()
  if (cardIds.length === 0) return byCard

  const { data, error } = await getSupabase()
    .from('task_card_assignees')
    .select('card_id, nexus_id')
    .in('card_id', cardIds)

  if (error) {
    // The cards are worth showing without their faces.
    logger.warn(SCOPE, 'Could not read who the cards are for', error)
    return byCard
  }

  const rows = (data ?? []) as Array<{ card_id: string; nexus_id: string }>
  if (rows.length === 0) return byCard

  const names = await readNames([...new Set(rows.map((row) => row.nexus_id))])

  for (const row of rows) {
    const list = byCard.get(row.card_id) ?? []
    list.push({ nexusId: row.nexus_id, name: names.get(row.nexus_id) ?? 'Unknown' })
    byCard.set(row.card_id, list)
  }

  for (const list of byCard.values()) list.sort((a, b) => a.name.localeCompare(b.name))

  return byCard
}

/**
 * How many cards each of the given boards holds.
 *
 * `board_id` alone, counted here. Postgres could group this in one pass, but
 * PostgREST has no grouped-count call worth the round trip, and one narrow
 * column is small enough that the difference is theoretical.
 */
async function countCards(boardIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (boardIds.length === 0) return counts

  const { data, error } = await getSupabase()
    .from('task_cards')
    .select('board_id')
    .in('board_id', boardIds)

  if (error) {
    // A board is worth listing without knowing how full it is.
    logger.warn(SCOPE, 'Could not count the cards on the boards', error)
    return counts
  }

  for (const row of (data ?? []) as Array<{ board_id: string }>) {
    counts.set(row.board_id, (counts.get(row.board_id) ?? 0) + 1)
  }

  return counts
}

/** The names of the given projects, for showing a task outside its own board. */
async function readBoardNames(boardIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (boardIds.length === 0) return names

  const { data, error } = await getSupabase()
    .from('task_boards')
    .select('id, name')
    .in('id', boardIds)

  if (error) {
    // A task is still worth showing without knowing which project it is on.
    logger.warn(SCOPE, 'Could not read the project names', error)
    return names
  }

  for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
    names.set(row.id, row.name)
  }

  return names
}

/** Who is on each of the given boards, as names. */
async function readBoardMembers(boardIds: string[]): Promise<Map<string, TaskPerson[]>> {
  const byBoard = new Map<string, TaskPerson[]>()
  if (boardIds.length === 0) return byBoard

  const { data, error } = await getSupabase()
    .from('task_board_members')
    .select('board_id, nexus_id')
    .in('board_id', boardIds)

  if (error) {
    logger.warn(SCOPE, 'Could not read who is on the boards', error)
    return byBoard
  }

  const rows = (data ?? []) as Array<{ board_id: string; nexus_id: string }>
  if (rows.length === 0) return byBoard

  const names = await readNames([...new Set(rows.map((row) => row.nexus_id))])

  for (const row of rows) {
    const list = byBoard.get(row.board_id) ?? []
    list.push({ nexusId: row.nexus_id, name: names.get(row.nexus_id) ?? 'Unknown' })
    byBoard.set(row.board_id, list)
  }

  for (const list of byBoard.values()) list.sort((a, b) => a.name.localeCompare(b.name))

  return byBoard
}

/**
 * Nexus names for the given ids.
 *
 * Read from the roster rather than from `profiles`, because that is what all of
 * this is keyed by — and because somebody can be on a board, and be given work,
 * without ever having opened this app to have a profile at all. Leavers stay in
 * the roster, so an old card keeps showing a name instead of a bare id.
 */
async function readNames(nexusIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (nexusIds.length === 0) return names

  const { data, error } = await getSupabase()
    .from('nexus_users')
    .select('nexus_id, name')
    .in('nexus_id', nexusIds)

  if (error) {
    logger.warn(SCOPE, 'Could not read the names behind a card', error)
    return names
  }

  for (const row of (data ?? []) as Array<{ nexus_id: string; name: string | null }>) {
    names.set(row.nexus_id, row.name?.trim() || 'Unknown')
  }

  return names
}

/* -------------------------------------------------------------------------- */
/*                                   Shaping                                  */
/* -------------------------------------------------------------------------- */

function toTaskList(row: ListRow): TaskList {
  return { id: row.id, boardId: row.board_id, name: row.name, position: row.position }
}

function toTaskCard(row: CardRow, assignees: TaskPerson[], noteCount = 0): TaskCard {
  return {
    noteCount,
    notesVisible: canSeeNotes(assignees),
    editable: canEditCard(),
    id: row.id,
    listId: row.list_id,
    boardId: row.board_id,
    title: row.title,
    description: row.description,
    position: row.position,
    dueAt: row.due_at,
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignees
  }
}

const PRIORITIES: ReadonlyArray<TaskPriority> = ['low', 'normal', 'high', 'urgent']

interface CardFields {
  title?: string
  description?: string
  due_at?: string | null
  priority?: TaskPriority
}

/**
 * Turns what the window sent into columns, refusing what the table would.
 *
 * `partial` is the difference between writing a card and changing one: on a new
 * card a missing title is a mistake, on an edit it means "leave the title
 * alone". A `dueAt` of `null` is a value in both — it clears the date.
 */
function validate(input: TaskCardInput, options: { partial?: boolean } = {}): CardFields {
  const fields: CardFields = {}

  if (input.title !== undefined || !options.partial) {
    fields.title = text(
      input.title ?? '',
      200,
      'Give the task a name.',
      'That name is too long — keep it under 200 characters.'
    )
  }

  if (input.description !== undefined) {
    const description = input.description.trim()
    if (description.length > 5000) {
      throw new AppError(
        ERROR_CODES.UNKNOWN,
        'That description is too long.',
        'Keep it under 5000 characters.'
      )
    }
    fields.description = description
  }

  if (input.dueAt !== undefined) {
    if (input.dueAt === null) {
      fields.due_at = null
    } else {
      const due = new Date(input.dueAt)
      if (Number.isNaN(due.getTime())) {
        throw new AppError(ERROR_CODES.UNKNOWN, 'That due date is not a date.')
      }
      fields.due_at = due.toISOString()
    }
  }

  if (input.priority !== undefined) {
    if (!PRIORITIES.includes(input.priority)) {
      throw new AppError(ERROR_CODES.UNKNOWN, 'That is not a priority this app knows.')
    }
    fields.priority = input.priority
  }

  return fields
}

function text(value: string, max: number, missing: string, tooLong: string): string {
  const clean = (value ?? '').trim()
  if (!clean) throw new AppError(ERROR_CODES.UNKNOWN, missing)
  if (clean.length > max) throw new AppError(ERROR_CODES.UNKNOWN, tooLong)
  return clean
}

/* -------------------------------------------------------------------------- */
/*                                    Access                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether the signed-in account may change this task.
 *
 * The same rule the policy states, asked here so the window can open a task
 * read-only rather than opening a form and then being refused. It is not the
 * protection — the database decides — but the two say the same thing, and they
 * have to be kept saying it.
 *
 * It does not ask whose task it is, and does not need to: a task somebody
 * cannot see never reaches this function, and what they can see is
 * `tasks.view_all`'s business.
 */
function canEditCard(): boolean {
  return can('tasks.edit')
}

/**
 * Whether the signed-in account may read this task's thread.
 *
 * The same rule the policy states — assigned to them, or able to see every task
 * — asked here so a chat icon is never offered on a conversation that would
 * come back empty.
 */
function canSeeNotes(assignees: TaskPerson[]): boolean {
  if (can('tasks.view_all')) return true

  const user = currentUser()
  if (!user?.nexusUserId) return false

  return assignees.some((person) => person.nexusId === user.nexusUserId)
}

/** What the signed-in account may do. A full-access role answers before the list. */
function can(permission: string): boolean {
  const user = currentUser()
  if (!user) return false
  return user.fullAccess || user.permissions.includes(permission)
}

function requireUser(): { id: string; name: string; nexusId: string | null } {
  const user = currentUser()
  if (!user) {
    throw new AppError(ERROR_CODES.AUTH_FAILED, 'Sign in to see your projects.')
  }
  return { id: user.id, name: user.name, nexusId: user.nexusUserId ?? null }
}

/**
 * Adding a project.
 *
 * Asked of the permission, not the role. It used to test for admin, which was
 * the same answer while only admins could do it — and the wrong one the moment
 * the policy started asking for `tasks.project.create`, because a role granted
 * it would have been refused here despite the database allowing it.
 */
function requireProjectCreator(): { id: string; name: string; nexusId: string | null } {
  const user = requireUser()

  if (!can('tasks.project.create')) {
    throw new AppError(
      ERROR_CODES.AUTH_FAILED,
      'You cannot add a project.',
      'The database refuses this regardless of what the window shows.'
    )
  }

  return user
}

function translate(error: { message: string; code?: string }, what: string): AppError {
  logger.warn(SCOPE, `Could not ${what}`, error)

  /*
   * `PGRST116` is a refusal wearing the wrong clothes.
   *
   * A write the policies do not allow does not raise: it simply matches no
   * rows. Asking for the changed row back then fails with "Cannot coerce the
   * result to a single JSON object", which is true, unhelpful, and says nothing
   * about the actual reason — that this person may not do this.
   */
  if (error.code === 'PGRST116') return refused(what)

  return new AppError(
    ERROR_CODES.UNKNOWN,
    `Could not ${what}.`,
    error.message || 'The server did not say why.'
  )
}

/**
 * A write the database would not carry out.
 *
 * Deletes and updates are the quiet ones: with no row matched they report
 * success having done nothing, so the window removes a task from the screen
 * that is still in the table and comes back on the next read. Every write that
 * can be refused therefore asks for what it changed, and calls this when the
 * answer is nothing.
 */
function refused(what: string): AppError {
  logger.info(SCOPE, `Refused: ${what}`)

  return new AppError(
    ERROR_CODES.AUTH_FAILED,
    `You cannot ${what}.`,
    'Your permissions may have changed since this window was opened.'
  )
}
