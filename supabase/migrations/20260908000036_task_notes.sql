-- ---------------------------------------------------------------------------
-- Notes on a task
--
-- A task says what has to happen. It does not say what happened while somebody
-- was doing it — the question that was asked, the answer, the reason it stalled
-- for two days. That conversation currently happens somewhere else entirely,
-- and the task ends up being the one place it is not recorded.
--
-- So each task gets a thread. Written the way a chat is written: short, in
-- order, attributed, and never edited into by somebody else.
--
-- Who may read a thread is not decided here. `task_card_is_visible` already
-- answers "may this person see this task", and a note is part of the task — so
-- the thread is visible exactly when the task is, and there is no second rule
-- to keep in step with the first.
-- ---------------------------------------------------------------------------

create table if not exists public.task_card_notes (
  id      uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.task_cards (id) on delete cascade,

  author_id uuid not null references public.profiles (id) on delete cascade,

  /*
   * The author's name, copied in at the time of writing.
   *
   * Deliberately not read back through `profiles`: somebody may read their own
   * profile row and no other, so resolving an author would either show them
   * nothing or need a policy opening every colleague's row to everybody. Copying
   * the name costs one column and asks for nothing.
   *
   * It is also the more honest answer. A note is a thing somebody said on a day,
   * under the name they had then.
   */
  author_name text not null default '',

  body text not null check (length(btrim(body)) between 1 and 4000),

  created_at timestamptz not null default now()
);

comment on table public.task_card_notes is
  'The conversation on one task. Visible to exactly the people the task is visible to.';

-- The only question ever asked of this table: everything on one task, in order.
create index if not exists task_card_notes_card_idx
  on public.task_card_notes (card_id, created_at);

/* --------------------------------------------------------------------------
   Permission

   Its own, because reading a task and adding to its record are different
   amounts of trust — somebody watching a project should not necessarily be able
   to write into it. Granted to admin and user on the way in, so nobody who can
   see a task today loses the ability to say something about it.
   -------------------------------------------------------------------------- */

insert into public.permissions (key, module, label, description, sort) values
  ('tasks.comment', 'project', 'Add notes to a task',
   'Write on the thread. Reading it comes with being able to see the task.', 55)
on conflict (key) do update
  set module      = excluded.module,
      label       = excluded.label,
      description = excluded.description,
      sort        = excluded.sort;

insert into public.role_permissions (role_key, permission_key)
select key, 'tasks.comment' from public.app_roles where key in ('admin', 'user')
on conflict do nothing;

/* --------------------------------------------------------------------------
   Policies
   -------------------------------------------------------------------------- */

alter table public.task_card_notes enable row level security;

drop policy if exists "Notes on a task you can see" on public.task_card_notes;
create policy "Notes on a task you can see"
  on public.task_card_notes for select
  using (public.task_card_is_visible(card_id));

/*
 * `author_id = auth.uid()` is not a formality: without it somebody could write
 * a note under a colleague's name, and a thread nobody can trust the
 * attribution of is worse than no thread.
 */
drop policy if exists "Notes are written by their author" on public.task_card_notes;
create policy "Notes are written by their author"
  on public.task_card_notes for insert
  with check (
    public.task_card_is_visible(card_id)
    and author_id = auth.uid()
    and public.has_permission(auth.uid(), 'tasks.comment')
  );

/*
 * Your own, always — taking back something you just said is part of saying it.
 * Anybody else's only with the permission that deletes the task itself, because
 * removing what somebody said is the same kind of act.
 */
drop policy if exists "Notes are removed by their author" on public.task_card_notes;
create policy "Notes are removed by their author"
  on public.task_card_notes for delete
  using (
    public.task_card_is_visible(card_id)
    and (author_id = auth.uid() or public.has_permission(auth.uid(), 'tasks.delete'))
  );

/*
 * No update policy, so there is none: a note cannot be edited after the fact.
 * A record of a conversation that can be rewritten is not a record of it.
 */
