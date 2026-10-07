/**
 * Turning what a caller sent into what the tables accept.
 *
 * The main caller is an AI agent, and an agent's output is approximately right
 * more often than exactly right: "Medium" for a priority, "2026-10-10" for a
 * due date, a title that runs to a paragraph. Refusing those would make the API
 * fragile in exactly the way it must not be. So whatever can be understood is
 * understood, and anything that had to be adjusted is reported back as a
 * warning rather than silently changed. Only what cannot be understood at all —
 * no title, an id that is not an id — is refused.
 *
 * Pure functions, no Deno or database: tested on their own.
 */

export const LIMITS = {
  projectName: 80,
  sectionName: 60,
  title: 200,
  description: 5000,
  source: 500,
  externalId: 200
} as const

export type Priority = 'low' | 'normal' | 'high' | 'urgent'

/** The words a caller might use, and which priority each means. */
const PRIORITY_WORDS: Record<string, Priority> = {
  low: 'low', lowest: 'low', minor: 'low', trivial: 'low', p3: 'low', p4: 'low',
  normal: 'normal', medium: 'normal', med: 'normal', moderate: 'normal', default: 'normal',
  regular: 'normal', standard: 'normal', p2: 'normal',
  high: 'high', important: 'high', major: 'high', p1: 'high',
  urgent: 'urgent', critical: 'urgent', highest: 'urgent', blocker: 'urgent', asap: 'urgent',
  immediate: 'urgent', emergency: 'urgent', p0: 'urgent'
}

/** Date-only due dates land at the end of that day in the organisation's time zone. */
const TIME_ZONE_OFFSET = '+05:30'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A request the caller has to fix; everything else is adjusted and warned about. */
export class InputError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
  }
}

export interface Normalised<T> {
  value: T
  warnings: string[]
}

/** Collapses runs of whitespace; `undefined` for nothing at all. */
export function cleanText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined
  if (text === undefined) return undefined
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 0 ? clean : undefined
}

export function priority(value: unknown, warnings: string[]): Priority | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return 'normal'

  const key = String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  const mapped = PRIORITY_WORDS[key]
  if (mapped) {
    if (key !== mapped) warnings.push(`priority "${value}" read as "${mapped}"`)
    return mapped
  }

  warnings.push(`priority "${value}" not understood; used "normal"`)
  return 'normal'
}

/**
 * An ISO time, a date alone, or null. A date alone is the end of that day.
 * Anything unreadable is dropped with a warning rather than failing the task.
 */
export function dueAt(value: unknown, warnings: string[]): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null

  if (typeof value !== 'string' && typeof value !== 'number') {
    warnings.push('due_at not understood; left without a due date')
    return null
  }

  const text = String(value).trim()

  const time = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T23:59:00${TIME_ZONE_OFFSET}`)
    : new Date(text)

  // Outside these years it is a misreading, not a deadline.
  if (Number.isNaN(time.getTime()) || time.getUTCFullYear() < 2000 || time.getUTCFullYear() > 2200) {
    warnings.push(`due_at "${text}" not understood; left without a due date`)
    return null
  }

  return time.toISOString()
}

/** A caller's own id: text or a number, 1–200 characters once trimmed. */
export function externalId(value: unknown, field = 'external_id'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new InputError(field, `"${field}" must be text or a number.`)
  }
  const id = String(value).trim()
  if (id.length === 0) return undefined
  if (id.length > LIMITS.externalId) {
    throw new InputError(field, `"${field}" is longer than ${LIMITS.externalId} characters.`)
  }
  return id
}

export function uuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !UUID.test(value.trim())) {
    throw new InputError(field, `"${field}" is not a valid id.`)
  }
  return value.trim().toLowerCase()
}

/** Truncates to `max` characters, ending with an ellipsis, and says so. */
export function fit(text: string, max: number, field: string, warnings: string[]): string {
  if (text.length <= max) return text
  warnings.push(`${field} was longer than ${max} characters and was shortened`)
  return `${text.slice(0, max - 1).trimEnd()}…`
}

export interface TaskInput {
  title?: string
  description?: string
  due_at?: string | null
  priority?: Priority
  source?: string | null
  external_id?: string
}

/**
 * A task's fields from a request body.
 *
 * On create a title is required — but an agent that sent only a description
 * still gets a task, titled from its first line. A title too long for the table
 * is shortened, and the full text kept at the top of the description so nothing
 * said is lost.
 */
export function taskInput(body: Record<string, unknown>, options: { creating: boolean }): Normalised<TaskInput> {
  const warnings: string[] = []
  const input: TaskInput = {}

  let description: string | undefined
  if (body.description !== undefined) {
    if (body.description === null) description = ''
    else if (typeof body.description === 'string') description = body.description.trim()
    else {
      description = JSON.stringify(body.description)
      warnings.push('description was not text and was stored as JSON')
    }
  }

  let title = cleanText(body.title)

  if (!title && options.creating && description) {
    title = cleanText(description.split('\n')[0])
    if (title) warnings.push('no title given; used the first line of the description')
  }

  if (options.creating && !title) {
    throw new InputError('title', '"title" is required.')
  }
  if (!options.creating && body.title !== undefined && !title) {
    throw new InputError('title', '"title" cannot be empty.')
  }

  if (title) {
    if (title.length > LIMITS.title) {
      description = description ? `${title}\n\n${description}` : title
    }
    input.title = fit(title, LIMITS.title, 'title', warnings)
  }

  if (description !== undefined) {
    input.description = fit(description, LIMITS.description, 'description', warnings)
  }

  const due = dueAt(body.due_at, warnings)
  if (due !== undefined) input.due_at = due

  const level = priority(body.priority, warnings)
  if (level !== undefined) input.priority = level

  if (body.source !== undefined) {
    const source = cleanText(body.source)
    input.source = source ? fit(source, LIMITS.source, 'source', warnings) : null
  }

  const id = externalId(body.external_id)
  if (id !== undefined) input.external_id = id

  return { value: input, warnings }
}

/** A project name: required where given, shortened if too long. */
export function projectName(value: unknown, warnings: string[], field = 'name'): string {
  const name = cleanText(value)
  if (!name) throw new InputError(field, `"${field}" is required.`)
  return fit(name, LIMITS.projectName, field, warnings)
}
