import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  InputError,
  LIMITS,
  type TaskInput,
  UUID,
  cleanText,
  externalId,
  priority,
  projectName,
  taskInput,
  uuid
} from './normalize.ts'

/**
 * Projects and tasks for other systems, without signing in.
 *
 * The app's Task Manager works on the tables as a signed-in person, under row
 * level security. Another system — chiefly an AI agent that joins client calls
 * and files the action items it hears — has nobody to sign in as, so this
 * function stands in: it checks an API key, then works on the tables with the
 * service role. The key is therefore a password for the whole Task Manager.
 *
 * Built so a caller cannot easily break it, or be broken by it:
 *   - every create can carry the caller's own `external_id`, and repeating it
 *     returns what was made the first time instead of a duplicate;
 *   - a project can be named instead of identified, and made on the spot;
 *   - input that is approximately right is accepted and reported in `warnings`;
 *   - every answer, including every failure, is JSON with a `request_id`;
 *   - routes are versioned (`/v1/…`), and two keys can be valid at once, so the
 *     key can be changed without a moment where callers are locked out.
 *
 * Secrets:
 *   TASKS_API_KEYS   one or more keys, comma-separated (TASKS_API_KEY also read)
 *   TASKS_API_OWNER  profile id recorded as the creator of everything made here
 *
 * Deploy: supabase functions deploy tasks-api --no-verify-jwt
 */

const VERSION = '1.0.0'

const KEYS = [Deno.env.get('TASKS_API_KEYS') ?? '', Deno.env.get('TASKS_API_KEY') ?? '']
  .join(',')
  .split(',')
  .map((key) => key.trim())
  .filter((key) => key.length >= 32)

const OWNER = Deno.env.get('TASKS_API_OWNER') ?? ''

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

/** Gap left between positions, so items can be put between others later. */
const STEP = 1024
const MAX_LIMIT = 200
const MAX_BATCH = 50
const MAX_BODY_BYTES = 1024 * 1024
const DUPLICATE = '23505'

const PROJECT_COLUMNS = 'id, name, external_id, created_at, updated_at'
const TASK_COLUMNS =
  'id, board_id, list_id, title, description, due_at, priority, position, external_id, source, created_at, updated_at'

/* -------------------------------------------------------------------------- */
/*                                   Routing                                  */
/* -------------------------------------------------------------------------- */

Deno.serve(async (request) => {
  const requestId = crypto.randomUUID()

  try {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    let path = parts.slice(parts.indexOf('tasks-api') + 1)
    // `/v1/...` is the documented form; the bare form is accepted as v1 too.
    if (path[0] === 'v1') path = path.slice(1)
    const [resource, id, child] = path
    const method = request.method

    if (resource === 'health' && method === 'GET') {
      return reply(requestId, 200, { ok: KEYS.length > 0 && OWNER !== '', version: VERSION })
    }

    if (KEYS.length === 0 || !OWNER) {
      throw new ApiError(503, 'not_configured', 'The API is not set up on the server yet.')
    }
    if (!KEYS.some((key) => sameKey(request.headers.get('x-api-key') ?? '', key))) {
      throw new ApiError(401, 'unauthorized', 'Missing or wrong x-api-key header.')
    }

    const length = Number(request.headers.get('content-length') ?? 0)
    if (length > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', 'The body is larger than 1 MB.')

    if (resource === 'projects') {
      if (id === undefined) {
        if (method === 'GET') return reply(requestId, 200, await listProjects(url))
        if (method === 'POST') return await createProjectRoute(requestId, await body(request))
        throw notAllowed('GET, POST')
      }
      const projectId = pathId(id, 'project')
      if (child === 'tasks') {
        if (method === 'GET') return reply(requestId, 200, await listTasks(url, projectId))
        throw notAllowed('GET')
      }
      if (child !== undefined) throw routeNotFound()
      if (method === 'GET') return reply(requestId, 200, await getProject(projectId))
      if (method === 'PATCH') return reply(requestId, 200, await updateProject(projectId, await body(request)))
      if (method === 'DELETE') return reply(requestId, 200, await deleteProject(projectId))
      throw notAllowed('GET, PATCH, DELETE')
    }

    if (resource === 'tasks') {
      if (id === 'batch') {
        if (method === 'POST') return reply(requestId, 200, await createTasksBatch(await body(request)))
        throw notAllowed('POST')
      }
      if (id === undefined) {
        if (method === 'GET') return reply(requestId, 200, await listTasks(url, null))
        if (method === 'POST') return await createTaskRoute(requestId, await body(request))
        throw notAllowed('GET, POST')
      }
      if (child !== undefined) throw routeNotFound()
      const taskId = pathId(id, 'task')
      if (method === 'GET') return reply(requestId, 200, await getTask(taskId))
      if (method === 'PATCH') return reply(requestId, 200, await updateTask(taskId, await body(request)))
      if (method === 'DELETE') return reply(requestId, 200, await deleteTask(taskId))
      throw notAllowed('GET, PATCH, DELETE')
    }

    throw routeNotFound()
  } catch (error) {
    if (error instanceof ApiError) {
      return reply(requestId, error.status, {
        error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }
      }, error.allow)
    }
    if (error instanceof InputError) {
      return reply(requestId, 400, { error: { code: 'invalid_input', message: error.message, field: error.field } })
    }
    console.error(`[${requestId}] tasks-api failed`, error)
    return reply(requestId, 500, { error: { code: 'server_error', message: 'Something went wrong. Safe to retry.' } })
  }
})

/* -------------------------------------------------------------------------- */
/*                                  Projects                                  */
/* -------------------------------------------------------------------------- */

interface ProjectRow {
  id: string
  name: string
  external_id: string | null
  created_at: string
  updated_at: string
}

async function listProjects(url: URL) {
  const { limit, offset } = paging(url)

  let query = admin.from('task_boards').select(PROJECT_COLUMNS, { count: 'exact' })

  const name = cleanText(url.searchParams.get('name'))
  if (name) query = query.ilike('name', escapeLike(name))

  const external = externalId(url.searchParams.get('external_id') ?? undefined)
  if (external) query = query.eq('external_id', external)

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) throw database(error)
  return { data: (data as ProjectRow[]).map(toProject), total: count ?? data.length, limit, offset }
}

async function getProject(id: string) {
  const project = await readProject(id)

  const [sections, tasks] = await Promise.all([
    admin.from('task_lists').select('id, name, position').eq('board_id', id).order('position'),
    admin.from('task_cards').select('id', { count: 'exact', head: true }).eq('board_id', id)
  ])

  if (sections.error) throw database(sections.error)
  if (tasks.error) throw database(tasks.error)

  return { ...toProject(project), sections: sections.data, task_count: tasks.count ?? 0 }
}

async function createProjectRoute(requestId: string, input: Record<string, unknown>): Promise<Response> {
  const warnings: string[] = []
  const name = projectName(input.name, warnings)
  const external = externalId(input.external_id)

  const { project, created } = await findOrCreateProject({ name, externalId: external })
  return reply(requestId, created ? 201 : 200, { ...(await getProject(project.id)), created, warnings })
}

async function updateProject(id: string, input: Record<string, unknown>) {
  await readProject(id)
  const warnings: string[] = []
  const patch: Record<string, unknown> = {}

  if (input.name !== undefined) patch.name = projectName(input.name, warnings)
  if (input.external_id !== undefined) patch.external_id = externalId(input.external_id) ?? null

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, 'nothing_to_change', 'Send "name" and/or "external_id".')
  }

  const { data, error } = await admin.from('task_boards').update(patch).eq('id', id).select(PROJECT_COLUMNS).single()

  if (error) {
    if (error.code === DUPLICATE) {
      throw new ApiError(409, 'external_id_taken', 'Another project already has that external_id.', 'external_id')
    }
    throw database(error)
  }

  return { ...toProject(data as ProjectRow), warnings }
}

async function deleteProject(id: string) {
  const { data, error } = await admin.from('task_boards').delete().eq('id', id).select('id')
  if (error) throw database(error)
  if (data.length === 0) throw notFound('project')
  return { deleted: true, id }
}

async function readProject(id: string): Promise<ProjectRow> {
  const { data, error } = await admin.from('task_boards').select(PROJECT_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw database(error)
  if (!data) throw notFound('project')
  return data as ProjectRow
}

/**
 * The project a request means, found by id, external id or name — or made, if
 * the caller asked for that and none matches.
 */
async function resolveProject(
  input: Record<string, unknown>,
  warnings: string[]
): Promise<{ project: ProjectRow; created: boolean }> {
  const id = uuid(input.project_id, 'project_id')
  if (id) return { project: await readProject(id), created: false }

  const external = externalId(input.project_external_id, 'project_external_id')
  const rawName = input.project_name
  const name = rawName === undefined ? undefined : projectName(rawName, warnings, 'project_name')
  const createIfMissing = input.create_project_if_missing === true

  if (!external && !name) {
    throw new InputError('project_id', 'Say which project: "project_id", "project_external_id" or "project_name".')
  }

  if (external) {
    const { data, error } = await admin.from('task_boards').select(PROJECT_COLUMNS).eq('external_id', external).maybeSingle()
    if (error) throw database(error)
    if (data) return { project: data as ProjectRow, created: false }
    if (!createIfMissing) throw notFound('project with that project_external_id')
    return findOrCreateProject({ name: name ?? external.slice(0, LIMITS.projectName), externalId: external })
  }

  const { data, error } = await admin.from('task_boards').select(PROJECT_COLUMNS).ilike('name', escapeLike(name!)).limit(2)
  if (error) throw database(error)
  if (data.length > 1) {
    throw new ApiError(409, 'ambiguous_project', `More than one project is called "${name}". Use its project_id.`, 'project_name')
  }
  if (data.length === 1) return { project: data[0] as ProjectRow, created: false }
  if (!createIfMissing) throw notFound('project with that project_name')
  return findOrCreateProject({ name: name! })
}

/**
 * Makes a project with a "To do" section to put tasks in. With an external id
 * the same call twice — or two at once — ends with one project.
 */
async function findOrCreateProject(args: { name: string; externalId?: string }): Promise<{ project: ProjectRow; created: boolean }> {
  if (args.externalId) {
    const existing = await projectByExternalId(args.externalId)
    if (existing) return { project: existing, created: false }
  }

  const { data, error } = await admin
    .from('task_boards')
    .insert({ name: args.name, external_id: args.externalId ?? null, created_by: OWNER })
    .select(PROJECT_COLUMNS)
    .single()

  if (error) {
    if (error.code === DUPLICATE && args.externalId) {
      const existing = await projectByExternalId(args.externalId)
      if (existing) return { project: existing, created: false }
    }
    throw database(error)
  }

  const project = data as ProjectRow
  const { error: sectionError } = await admin.from('task_lists').insert({ board_id: project.id, name: 'To do', position: STEP })

  if (sectionError) {
    await admin.from('task_boards').delete().eq('id', project.id)
    throw database(sectionError)
  }

  return { project, created: true }
}

async function projectByExternalId(external: string): Promise<ProjectRow | null> {
  const { data, error } = await admin.from('task_boards').select(PROJECT_COLUMNS).eq('external_id', external).maybeSingle()
  if (error) throw database(error)
  return (data as ProjectRow | null) ?? null
}

function toProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    external_id: row.external_id,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/* -------------------------------------------------------------------------- */
/*                                    Tasks                                   */
/* -------------------------------------------------------------------------- */

interface TaskRow {
  id: string
  board_id: string
  list_id: string
  title: string
  description: string
  due_at: string | null
  priority: string
  position: number
  external_id: string | null
  source: string | null
  created_at: string
  updated_at: string
}

async function listTasks(url: URL, projectFromPath: string | null) {
  const { limit, offset } = paging(url)
  let projectId = projectFromPath

  if (!projectId) {
    const warnings: string[] = []
    const params = Object.fromEntries(url.searchParams)
    if (!params.project_id && !params.project_external_id && !params.project_name) {
      throw new InputError('project_id', 'Say which project: "project_id", "project_external_id" or "project_name".')
    }
    projectId = (await resolveProject(params, warnings)).project.id
  } else {
    await readProject(projectId)
  }

  let query = admin.from('task_cards').select(TASK_COLUMNS, { count: 'exact' }).eq('board_id', projectId)

  const sectionId = uuid(url.searchParams.get('section_id') ?? undefined, 'section_id')
  if (sectionId) query = query.eq('list_id', sectionId)

  const level = url.searchParams.get('priority')
  if (level) query = query.eq('priority', priority(level, []) ?? 'normal')

  const external = externalId(url.searchParams.get('external_id') ?? undefined)
  if (external) query = query.eq('external_id', external)

  const since = url.searchParams.get('updated_since')
  if (since) {
    const time = new Date(since)
    if (Number.isNaN(time.getTime())) throw new InputError('updated_since', '"updated_since" must be an ISO 8601 time.')
    query = query.gt('updated_at', time.toISOString())
  }

  const { data, error, count } = await query.order('position').range(offset, offset + limit - 1)
  if (error) throw database(error)

  return { data: (data as TaskRow[]).map(toTask), total: count ?? data.length, limit, offset }
}

async function getTask(id: string) {
  const { data, error } = await admin.from('task_cards').select(TASK_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw database(error)
  if (!data) throw notFound('task')
  return toTask(data as TaskRow)
}

async function createTaskRoute(requestId: string, input: Record<string, unknown>): Promise<Response> {
  const result = await createOneTask(input)
  return reply(requestId, result.created ? 201 : 200, result)
}

/** One task, with everything a single create or a batch item needs. */
async function createOneTask(input: Record<string, unknown>) {
  const { value: fields, warnings } = taskInput(input, { creating: true })
  const { project, created: projectCreated } = await resolveProject(input, warnings)

  // Asked for before: return what was made then.
  if (fields.external_id) {
    const existing = await taskByExternalId(project.id, fields.external_id)
    if (existing) {
      return { ...toTask(existing), created: false, project_created: projectCreated, warnings }
    }
  }

  const sectionId = await sectionFor(project.id, input, warnings)

  const { data, error } = await admin
    .from('task_cards')
    .insert({
      ...withoutUndefined(fields),
      board_id: project.id,
      list_id: sectionId,
      position: await bottomOf(sectionId),
      created_by: OWNER
    })
    .select(TASK_COLUMNS)
    .single()

  if (error) {
    // Two creates with one external id at the same moment: the other one won.
    if (error.code === DUPLICATE && fields.external_id) {
      const existing = await taskByExternalId(project.id, fields.external_id)
      if (existing) return { ...toTask(existing), created: false, project_created: projectCreated, warnings }
    }
    throw database(error)
  }

  return { ...toTask(data as TaskRow), created: true, project_created: projectCreated, warnings }
}

/**
 * Several tasks in one request — what an agent has after a call.
 *
 * Each is created on its own: one that fails does not stop the others, and the
 * answer says, item by item and in order, what became of each. The top level
 * may name the project once for all of them; an item can name its own.
 */
async function createTasksBatch(input: Record<string, unknown>) {
  if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
    throw new InputError('tasks', '"tasks" must be a non-empty array.')
  }
  if (input.tasks.length > MAX_BATCH) {
    throw new InputError('tasks', `At most ${MAX_BATCH} tasks per request.`)
  }

  const shared: Record<string, unknown> = {}
  for (const key of ['project_id', 'project_external_id', 'project_name', 'create_project_if_missing', 'source']) {
    if (input[key] !== undefined) shared[key] = input[key]
  }

  const results = []
  for (const [index, item] of (input.tasks as unknown[]).entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      results.push({ index, status: 'error', error: { code: 'invalid_input', message: 'Each task must be an object.' } })
      continue
    }

    try {
      const task = await createOneTask({ ...shared, ...(item as Record<string, unknown>) })
      results.push({ index, status: task.created ? 'created' : 'exists', task })
    } catch (error) {
      results.push({ index, status: 'error', error: describe(error) })
    }
  }

  return {
    created: results.filter((r) => r.status === 'created').length,
    existing: results.filter((r) => r.status === 'exists').length,
    failed: results.filter((r) => r.status === 'error').length,
    results
  }
}

async function updateTask(id: string, input: Record<string, unknown>) {
  const { data: current, error: readError } = await admin.from('task_cards').select('id, board_id, list_id').eq('id', id).maybeSingle()
  if (readError) throw database(readError)
  if (!current) throw notFound('task')

  const { value: fields, warnings } = taskInput(input, { creating: false })
  const patch: Record<string, unknown> = withoutUndefined(fields)
  if ('external_id' in input && fields.external_id === undefined) patch.external_id = null

  if (input.section_id !== undefined || input.section_name !== undefined) {
    const sectionId = await sectionFor(current.board_id, input, warnings)
    if (sectionId !== current.list_id) {
      patch.list_id = sectionId
      patch.position = await bottomOf(sectionId)
    }
  }

  if (Object.keys(patch).length === 0) {
    throw new ApiError(400, 'nothing_to_change', 'Send at least one field to change.')
  }

  const { data, error } = await admin.from('task_cards').update(patch).eq('id', id).select(TASK_COLUMNS).single()

  if (error) {
    if (error.code === DUPLICATE) {
      throw new ApiError(409, 'external_id_taken', 'Another task in this project already has that external_id.', 'external_id')
    }
    throw database(error)
  }

  return { ...toTask(data as TaskRow), warnings }
}

async function deleteTask(id: string) {
  const { data, error } = await admin.from('task_cards').delete().eq('id', id).select('id')
  if (error) throw database(error)
  if (data.length === 0) throw notFound('task')
  return { deleted: true, id }
}

async function taskByExternalId(projectId: string, external: string): Promise<TaskRow | null> {
  const { data, error } = await admin
    .from('task_cards')
    .select(TASK_COLUMNS)
    .eq('board_id', projectId)
    .eq('external_id', external)
    .maybeSingle()
  if (error) throw database(error)
  return (data as TaskRow | null) ?? null
}

/**
 * The section a task goes in: by id (must be on the project), by name (one
 * that exists), or otherwise the project's first — made if it has none.
 */
async function sectionFor(projectId: string, input: Record<string, unknown>, warnings: string[]): Promise<string> {
  const id = uuid(input.section_id, 'section_id')
  if (id) {
    const { data, error } = await admin.from('task_lists').select('id').eq('id', id).eq('board_id', projectId).maybeSingle()
    if (error) throw database(error)
    if (!data) throw new InputError('section_id', '"section_id" is not a section of this project.')
    return data.id
  }

  const { data: sections, error } = await admin.from('task_lists').select('id, name').eq('board_id', projectId).order('position')
  if (error) throw database(error)

  const name = cleanText(input.section_name)
  if (name) {
    const match = sections.find((section) => section.name.toLowerCase() === name.toLowerCase())
    if (match) return match.id
    warnings.push(`no section called "${name}"; used "${sections[0]?.name ?? 'To do'}"`)
  }

  if (sections.length > 0) return sections[0].id

  const { data: created, error: createError } = await admin
    .from('task_lists')
    .insert({ board_id: projectId, name: 'To do', position: STEP })
    .select('id')
    .single()

  if (createError) throw database(createError)
  return created.id
}

async function bottomOf(sectionId: string): Promise<number> {
  const { data, error } = await admin
    .from('task_cards')
    .select('position')
    .eq('list_id', sectionId)
    .order('position', { ascending: false })
    .limit(1)
  if (error) throw database(error)
  return (data[0]?.position ?? 0) + STEP
}

function toTask(row: TaskRow) {
  return {
    id: row.id,
    project_id: row.board_id,
    section_id: row.list_id,
    title: row.title,
    description: row.description,
    due_at: row.due_at,
    priority: row.priority,
    position: row.position,
    external_id: row.external_id,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly field?: string,
    readonly allow?: string
  ) {
    super(message)
  }
}

const notFound = (what: string): ApiError => new ApiError(404, 'not_found', `No such ${what}.`)
const routeNotFound = (): ApiError => new ApiError(404, 'route_not_found', 'No such endpoint. See /v1/health.')
const notAllowed = (allow: string): ApiError =>
  new ApiError(405, 'method_not_allowed', `Use ${allow} here.`, undefined, allow)

function pathId(id: string, what: string): string {
  if (!UUID.test(id)) throw notFound(what)
  return id.toLowerCase()
}

function paging(url: URL): { limit: number; offset: number } {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(url.searchParams.get('limit') ?? 50)) || 50))
  const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset') ?? 0)) || 0)
  return { limit, offset }
}

/** `%` and `_` in a name are letters, not wildcards. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function withoutUndefined(input: TaskInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

async function body(request: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw new ApiError(400, 'invalid_json', 'The body could not be read.')
  }
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', 'The body is larger than 1 MB.')
  if (text.trim() === '') return {}

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new ApiError(400, 'invalid_json', 'The body must be a JSON object.')
  }
}

/** A database refusal, as something a caller can act on. */
function database(error: { code?: string; message: string }): ApiError {
  console.error('database error', error)
  if (error.code === '23514') return new ApiError(400, 'invalid_input', 'A value breaks a rule of the table.')
  if (error.code === '23503') return new ApiError(404, 'not_found', 'Something it refers to does not exist.')
  return new ApiError(503, 'database_unavailable', 'The database could not do that right now. Safe to retry.')
}

function describe(error: unknown): { code: string; message: string; field?: string } {
  if (error instanceof ApiError) return { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) }
  if (error instanceof InputError) return { code: 'invalid_input', message: error.message, field: error.field }
  console.error('batch item failed', error)
  return { code: 'server_error', message: 'Something went wrong with this task. Safe to retry.' }
}

/** Constant-time, so a key cannot be guessed a character at a time. */
function sameKey(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function reply(requestId: string, status: number, payload: unknown, allow?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
    'X-Api-Version': VERSION
  }
  if (allow) headers.Allow = allow
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), request_id: requestId }
    : payload
  return new Response(JSON.stringify(body), { status, headers })
}
