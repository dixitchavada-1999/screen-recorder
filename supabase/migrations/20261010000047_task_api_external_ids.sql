-- ---------------------------------------------------------------------------
-- External ids for the Tasks API
--
-- The API is called by other systems — among them an AI agent that sits in on
-- client calls and files the action items it hears. Such callers retry, and a
-- retried "create" must not file the same task twice. Each project and task can
-- now carry the caller's own id for it; creating with an id already used
-- returns the existing row instead of a duplicate.
--
-- `source` records where a task came from (a call, a meeting), for people
-- reading it later. Neither column is used by the app itself.
-- ---------------------------------------------------------------------------

alter table public.task_boards
  add column if not exists external_id text
    check (external_id is null or length(external_id) between 1 and 200);

alter table public.task_cards
  add column if not exists external_id text
    check (external_id is null or length(external_id) between 1 and 200),
  add column if not exists source text
    check (source is null or length(source) <= 500);

comment on column public.task_boards.external_id is
  'The calling system''s own id for this project. Unique. Set through the Tasks API.';
comment on column public.task_cards.external_id is
  'The calling system''s own id for this task. Unique within its project. Makes API creates safe to retry.';
comment on column public.task_cards.source is
  'Where the task came from, as the calling system describes it — a call, a meeting.';

create unique index if not exists task_boards_external_id_key
  on public.task_boards (external_id) where external_id is not null;

create unique index if not exists task_cards_external_id_key
  on public.task_cards (board_id, external_id) where external_id is not null;
