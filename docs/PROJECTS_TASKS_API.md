# Projects & Tasks API — v1

A REST API for other systems — including AI agents — to create, read, update
and delete **projects** and **tasks** in the Screen Recorder Task Manager,
without signing in. One API key authorises every call.

Projects and tasks made here appear in the app's Task Manager like any others.
Nothing is assigned to anybody.

| | |
|---|---|
| **Base URL** | `https://xnppcykubshfkrxvchgt.supabase.co/functions/v1/tasks-api/v1` |
| **Authentication** | `x-api-key: <API key>` on every request (except `/health`) |
| **Format** | JSON in and out — `Content-Type: application/json` |
| **Times** | ISO 8601. Returned in UTC |
| **IDs** | UUIDs, plus your own `external_id` if you send one |

Written for the case it was built for: an AI agent sits in on a client call,
hears the action items, and files them as tasks under the right project. The
sections on [retries](#safe-retries-external_id), [naming a
project](#saying-which-project) and [batches](#create-several-tasks) are the
ones that make that reliable.

---

## Contents

- [Authentication](#authentication)
- [How responses look](#how-responses-look)
- [Safe retries: `external_id`](#safe-retries-external_id)
- [Saying which project](#saying-which-project)
- [Input the API adjusts for you](#input-the-api-adjusts-for-you)
- **Projects:** [List](#list-projects) · [Get](#get-a-project) · [Create](#create-a-project) · [Update](#update-a-project) · [Delete](#delete-a-project)
- **Tasks:** [List](#list-tasks) · [Get](#get-a-task) · [Create](#create-a-task) · [Create several](#create-several-tasks) · [Update](#update-a-task) · [Delete](#delete-a-task)
- [Health](#health)
- [Errors](#errors)
- [Using it from an AI agent](#using-it-from-an-ai-agent)
- [Example](#example)
- [Notes](#notes)

---

## Authentication

```http
x-api-key: <API key>
```

A missing or wrong key returns `401 unauthorized`.

**The key can read and change every project and task.** Keep it on the server
of the calling system — in its secret store or environment, never in a browser,
a mobile app, a prompt the model can repeat, or a repository. A new key can be
issued at any time; the old and new can work side by side while the caller
switches, then the old one is withdrawn.

---

## How responses look

- Every response is JSON and carries a **`request_id`**, also sent as the
  `X-Request-Id` header. Quote it when reporting a problem.
- Create and update responses carry **`warnings`**: a list of things the API
  adjusted (see [below](#input-the-api-adjusts-for-you)). Empty when nothing was.
- Lists are `{ "data": [ … ], "total": n, "limit": n, "offset": n }`.
- Errors are `{ "error": { "code": "…", "message": "…", "field": "…" } }` — see
  [Errors](#errors).

---

## Safe retries: `external_id`

A caller that times out cannot tell whether its create went through. Send your
own id for the thing — a call id plus the item's number works well:

```json
{ "project_name": "Gesher Distribution", "title": "Send the revised quote", "external_id": "call-7f3a-item-2" }
```

- First time: the task is created — **`201`**, `"created": true`.
- Same `external_id` again in that project: nothing new is made — **`200`**,
  `"created": false`, and the task made the first time is returned.

Projects take an `external_id` the same way (your client or account id). A
task's `external_id` is unique within its project; a project's is unique
overall. Up to 200 characters, text or a number.

**Always send one from an agent.** It is what makes retrying safe.

---

## Saying which project

Wherever a task needs a project, give **one** of:

| Field | Matches |
|---|---|
| `project_id` | The project's UUID |
| `project_external_id` | The `external_id` you gave the project |
| `project_name` | The project's name, ignoring upper/lower case |

Add **`"create_project_if_missing": true`** to have the project made when none
matches (named `project_name`, or the external id if no name was given). Without
it, no match is `404`.

If two projects share a name, `project_name` is `409 ambiguous_project` — use the
id instead.

---

## Input the API adjusts for you

Agents produce input that is nearly right. Rather than refuse it, the API
adjusts it and says what it did in `warnings`:

| You send | It becomes |
|---|---|
| `priority`: `"Medium"`, `"moderate"`, `"P2"` | `"normal"` |
| `priority`: `"critical"`, `"ASAP"`, `"blocker"`, `"P0"` | `"urgent"` |
| `priority`: `"important"`, `"major"`, `"P1"` | `"high"` |
| `priority`: `"minor"`, `"trivial"`, `"P3"` | `"low"` |
| `priority`: anything else | `"normal"`, with a warning |
| `due_at`: `"2026-10-10"` (a date alone) | 23:59 that day, India time |
| `due_at`: unreadable (`"next Friday"`) | No due date, with a warning — the task is still created |
| No `title`, but a `description` | Title = the description's first line |
| `title` over 200 characters | Shortened with `…`; the full text goes to the top of the description |
| `description` over 5000 characters | Shortened |
| `description` that is an object or list | Stored as JSON text |
| `section_name` that does not exist | The project's first section, with a warning |
| Fields the API does not know | Ignored |

**Refused** (`400 invalid_input`, with `field`): no title and no description; a
malformed id; an `external_id` over 200 characters.

---

## Projects

### List projects

```http
GET /projects
```

| Query | |
|---|---|
| `name` | Exact name, ignoring case |
| `external_id` | Your external id |
| `limit` | 1–200, default 50 |
| `offset` | Default 0 |

**200**

```json
{
  "data": [
    {
      "id": "8c1e5a3b-2f4d-4b6a-9c7e-1d2f3a4b5c6d",
      "name": "Gesher Distribution",
      "external_id": "client-1042",
      "created_at": "2026-10-06T10:00:00+00:00",
      "updated_at": "2026-10-06T10:00:00+00:00"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0,
  "request_id": "0b9c…"
}
```

Newest first.

### Get a project

```http
GET /projects/{project_id}
```

**200** — the project, its sections and its number of tasks:

```json
{
  "id": "8c1e5a3b-2f4d-4b6a-9c7e-1d2f3a4b5c6d",
  "name": "Gesher Distribution",
  "external_id": "client-1042",
  "created_at": "2026-10-06T10:00:00+00:00",
  "updated_at": "2026-10-06T10:00:00+00:00",
  "sections": [
    { "id": "f02b…", "name": "To do", "position": 1024 }
  ],
  "task_count": 3,
  "request_id": "…"
}
```

**404** if there is no such project.

### Create a project

```http
POST /projects

{ "name": "Gesher Distribution", "external_id": "client-1042" }
```

| Field | Required | |
|---|---|---|
| `name` | yes | 1–80 characters (longer is shortened) |
| `external_id` | no | Your id for it. Repeating it returns the existing project |

**201** — new: the project as in [Get a project](#get-a-project), plus
`"created": true` and `warnings`. It comes with one section, **To do**.
**200** — a project with that `external_id` already existed: that one, with
`"created": false`.

### Update a project

```http
PATCH /projects/{project_id}

{ "name": "Gesher Distribution — 2026" }
```

| Field | |
|---|---|
| `name` | 1–80 characters |
| `external_id` | Your id; `null` removes it |

**200** — the project, with `warnings`. **404** if missing. **409
`external_id_taken`** if another project has that external id.

### Delete a project

```http
DELETE /projects/{project_id}
```

**200** — `{ "deleted": true, "id": "…" }`. **Deletes all its tasks.** Cannot be
undone. **404** if missing.

---

## Tasks

### List tasks

```http
GET /projects/{project_id}/tasks
```

or by any project reference:

```http
GET /tasks?project_name=Gesher%20Distribution
GET /tasks?project_external_id=client-1042
```

| Query | |
|---|---|
| `section_id` | Only that section |
| `priority` | `low`, `normal`, `high`, `urgent` (synonyms accepted) |
| `external_id` | The task with that external id |
| `updated_since` | ISO time — only tasks changed after it |
| `limit` / `offset` | 1–200 (default 50) / default 0 |

**200** — `{ "data": [ task, … ], "total", "limit", "offset" }`, in board order.

### Get a task

```http
GET /tasks/{task_id}
```

**200** — a [task](#task-object). **404** if missing.

### Create a task

```http
POST /tasks

{
  "project_name": "Gesher Distribution",
  "create_project_if_missing": true,
  "title": "Send the revised quote",
  "description": "Client asked for the quote with the new freight rates by Friday.",
  "due_at": "2026-10-10",
  "priority": "high",
  "external_id": "call-7f3a-item-2",
  "source": "Client call with Gesher, 6 Oct 2026"
}
```

| Field | Required | |
|---|---|---|
| a [project reference](#saying-which-project) | yes | `project_id`, `project_external_id` or `project_name` |
| `create_project_if_missing` | no | `true` to make the project if none matches |
| `title` | yes* | 1–200 characters. *Or a `description` to take it from |
| `description` | no | Up to 5000 characters |
| `due_at` | no | ISO time, a date, or `null` |
| `priority` | no | `low`, `normal` (default), `high`, `urgent` — synonyms accepted |
| `external_id` | recommended | Your id for it; makes retries safe |
| `source` | no | Where it came from, up to 500 characters |
| `section_id` or `section_name` | no | Default: the project's first section |

**201** — created:

```json
{
  "id": "5b1f0c7e-2d6a-4c0b-9a51-7e3c2f9d1a11",
  "project_id": "8c1e5a3b-2f4d-4b6a-9c7e-1d2f3a4b5c6d",
  "section_id": "f02b…",
  "title": "Send the revised quote",
  "description": "Client asked for the quote with the new freight rates by Friday.",
  "due_at": "2026-10-10T18:29:00+00:00",
  "priority": "high",
  "position": 2048,
  "external_id": "call-7f3a-item-2",
  "source": "Client call with Gesher, 6 Oct 2026",
  "created_at": "2026-10-06T11:40:00+00:00",
  "updated_at": "2026-10-06T11:40:00+00:00",
  "created": true,
  "project_created": false,
  "warnings": [],
  "request_id": "…"
}
```

**200** — a task with that `external_id` already existed in the project:
that task, `"created": false`.

### Create several tasks

Everything from one call in one request — up to **50** tasks.

```http
POST /tasks/batch

{
  "project_name": "Gesher Distribution",
  "create_project_if_missing": true,
  "source": "Client call with Gesher, 6 Oct 2026",
  "tasks": [
    { "title": "Send the revised quote", "priority": "high", "due_at": "2026-10-10", "external_id": "call-7f3a-item-1" },
    { "title": "Book the inspection slot", "external_id": "call-7f3a-item-2" },
    { "description": "Check whether GDC 2 can hold 40 extra pallets", "external_id": "call-7f3a-item-3" }
  ]
}
```

The project reference, `create_project_if_missing` and `source` at the top
apply to every task; a task can set its own.

**200** — always, with the outcome of each task in order:

```json
{
  "created": 2,
  "existing": 1,
  "failed": 0,
  "results": [
    { "index": 0, "status": "created", "task": { "id": "…", "title": "Send the revised quote", "created": true, "warnings": [] } },
    { "index": 1, "status": "exists",  "task": { "id": "…", "title": "Book the inspection slot", "created": false, "warnings": [] } },
    { "index": 2, "status": "created", "task": { "id": "…", "title": "Check whether GDC 2 can hold 40 extra pallets", "warnings": ["no title given; used the first line of the description"] } }
  ],
  "request_id": "…"
}
```

`status` is `created`, `exists` (already made with that external id) or `error`
(with an `error` object as in [Errors](#errors)). **One task failing does not
stop the others.** Retrying the whole batch with the same external ids is safe:
the ones already made come back as `exists`.

### Update a task

Only the fields that change:

```http
PATCH /tasks/{task_id}

{ "title": "Send the revised quote (v2)", "priority": "urgent", "due_at": null }
```

| Field | |
|---|---|
| `title` | 1–200 characters; cannot be empty |
| `description` | Up to 5000; `null` empties it |
| `due_at` | ISO time or date; `null` removes it |
| `priority` | as above |
| `source` | `null` removes it |
| `external_id` | Your id; `null` removes it |
| `section_id` / `section_name` | Move to that section of the same project, at the bottom |

**200** — the [task](#task-object), with `warnings`. **404** if missing.
**409 `external_id_taken`** if another task in the project has that external id.
The project of a task cannot be changed.

### Delete a task

```http
DELETE /tasks/{task_id}
```

**200** — `{ "deleted": true, "id": "…" }`. Cannot be undone. **404** if missing.

---

### Task object

| Field | Type | |
|---|---|---|
| `id` | UUID | |
| `project_id` | UUID | |
| `section_id` | UUID | Column it is in |
| `title` | string | |
| `description` | string | May be empty |
| `due_at` | time or `null` | |
| `priority` | string | `low`, `normal`, `high`, `urgent` |
| `position` | number | Order in its section, lower first |
| `external_id` | string or `null` | Yours |
| `source` | string or `null` | Yours |
| `created_at`, `updated_at` | time | |

Create responses add `created`, `project_created` and `warnings`.

---

## Health

```http
GET /health
```

No key needed. **200** — `{ "ok": true, "version": "1.0.0" }`. `ok: false`
means the API is reachable but not yet configured on the server.

---

## Errors

```json
{ "error": { "code": "invalid_input", "message": "\"title\" is required.", "field": "title" }, "request_id": "…" }
```

| Status | `code` | Meaning | Retry? |
|---|---|---|---|
| 400 | `invalid_input` | A field is missing or unusable — `field` says which | No — fix the input |
| 400 | `invalid_json` | The body is not a JSON object | No |
| 400 | `nothing_to_change` | An update with no fields | No |
| 401 | `unauthorized` | `x-api-key` missing or wrong | No |
| 404 | `not_found` | No such project or task | No |
| 404 | `route_not_found` | No such endpoint | No |
| 405 | `method_not_allowed` | Wrong method; the `Allow` header lists the right ones | No |
| 409 | `ambiguous_project` | Two projects have that name — use `project_id` | No |
| 409 | `external_id_taken` | Another item already has that external id | No |
| 413 | `too_large` | Body over 1 MB | No |
| 500 | `server_error` | Unexpected failure | Yes |
| 503 | `database_unavailable` | The database did not answer | Yes, after a pause |
| 503 | `not_configured` | Not set up on the server yet | No |

**Retrying:** `500` and `503`, and network failures, with a growing pause (1 s,
2 s, 4 s…, up to 5 tries). With `external_id` on every create, a retry never
makes a duplicate.

---

## Using it from an AI agent

### Recommended flow after a call

1. Pick the project reference — ideally `project_external_id` (your client id),
   otherwise `project_name` — and set `create_project_if_missing: true` if new
   clients should get a project automatically.
2. Collect the action items. For each: a short `title` (one line), the detail in
   `description`, a `due_at` if a date was said, a `priority`, and an
   `external_id` of `<call id>-item-<n>`.
3. Send them in **one** `POST /tasks/batch`, with `source` describing the call.
4. Retry the whole batch on `500`/`503`/network errors — the external ids keep
   it from duplicating. Report any `status: "error"` items rather than resending
   them unchanged.

### Tool definitions

For agent frameworks that take JSON-schema tool definitions (OpenAI, Anthropic,
LangChain and similar). The agent's code adds the base URL and `x-api-key`; the
model never sees the key.

```json
[
  {
    "name": "create_tasks",
    "description": "File action items from a client call as tasks in the Task Manager, under one project. Safe to retry: tasks with an external_id already filed are not duplicated.",
    "input_schema": {
      "type": "object",
      "properties": {
        "project_name": { "type": "string", "description": "The client's project name." },
        "project_external_id": { "type": "string", "description": "The client's id in the calling system, if known. Preferred over the name." },
        "create_project_if_missing": { "type": "boolean", "description": "Create the project if it does not exist yet." },
        "source": { "type": "string", "description": "Which call these came from, e.g. 'Client call with Gesher, 6 Oct 2026'." },
        "tasks": {
          "type": "array",
          "maxItems": 50,
          "items": {
            "type": "object",
            "properties": {
              "title": { "type": "string", "description": "One-line summary of the action item, under 200 characters." },
              "description": { "type": "string", "description": "Details: what was asked, by whom, any numbers or names." },
              "due_at": { "type": "string", "description": "Deadline as YYYY-MM-DD or an ISO 8601 time, only if one was stated." },
              "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"] },
              "external_id": { "type": "string", "description": "Unique per item: '<call id>-item-<n>'." }
            },
            "required": ["title", "external_id"]
          }
        }
      },
      "required": ["tasks"]
    }
  },
  {
    "name": "list_tasks",
    "description": "List the tasks of a project, to avoid filing something already there.",
    "input_schema": {
      "type": "object",
      "properties": {
        "project_name": { "type": "string" },
        "project_external_id": { "type": "string" },
        "updated_since": { "type": "string", "description": "ISO 8601; only tasks changed after it." }
      }
    }
  },
  {
    "name": "update_task",
    "description": "Change a task already filed — its title, details, deadline or priority.",
    "input_schema": {
      "type": "object",
      "properties": {
        "task_id": { "type": "string" },
        "title": { "type": "string" },
        "description": { "type": "string" },
        "due_at": { "type": ["string", "null"] },
        "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"] }
      },
      "required": ["task_id"]
    }
  }
]
```

Map them to: `create_tasks` → `POST /tasks/batch` (pass the arguments as the
body); `list_tasks` → `GET /tasks?…`; `update_task` → `PATCH /tasks/{task_id}`
(the rest as the body). Give the model `delete_task` only if it should be able
to delete — usually it should not.

---

## Example

```bash
API=https://xnppcykubshfkrxvchgt.supabase.co/functions/v1/tasks-api/v1
KEY='<API key>'
H=(-H "x-api-key: $KEY" -H "Content-Type: application/json")

curl -s "$API/health"

# Several tasks from a call; the project is made if needed
curl -s "$API/tasks/batch" "${H[@]}" -d '{
  "project_name": "API test",
  "create_project_if_missing": true,
  "source": "Test call",
  "tasks": [
    { "title": "First task", "priority": "Medium", "external_id": "test-call-1-item-1" },
    { "title": "Second task", "due_at": "2026-12-31", "external_id": "test-call-1-item-2" }
  ]
}'

# The same again: nothing new is created ("existing": 2)
curl -s "$API/tasks/batch" "${H[@]}" -d '{ "project_name": "API test", "tasks": [
  { "title": "First task", "external_id": "test-call-1-item-1" },
  { "title": "Second task", "external_id": "test-call-1-item-2" } ] }'

# Read, change, delete
PROJECT=$(curl -s "$API/projects?name=API%20test" "${H[@]}" | jq -r '.data[0].id')
TASK=$(curl -s "$API/projects/$PROJECT/tasks" "${H[@]}" | jq -r '.data[0].id')
curl -s -X PATCH "$API/tasks/$TASK" "${H[@]}" -d '{"priority":"urgent"}'
curl -s -X DELETE "$API/tasks/$TASK" "${H[@]}"
curl -s -X DELETE "$API/projects/$PROJECT" "${H[@]}"
```

---

## Notes

- **Nobody is assigned.** No members or assignees are set. In the app, projects
  made here are seen by Admins and Super admins (who see every project); add
  members in the app if others should see one.
- **Creator.** Everything made here is recorded as created by one fixed account,
  set on the server.
- **Deleting a project deletes all its tasks.**
- **Syncing:** keep the time of your last sync and ask for
  `?updated_since=<that time>`. Deleted tasks do not appear in that list.
- **Versioning:** the `/v1` paths will not change in ways that break callers.
  New optional fields may be added to responses — ignore the ones you do not use.
