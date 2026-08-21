-- ---------------------------------------------------------------------------
-- KPI notes
--
-- A super admin writes one note, picks who it is for, and it appears on
-- exactly those people's dashboards and nowhere else.
--
-- Two tables rather than one row per person. A note is written once and read by
-- several people, so storing the audience inside the note would mean either the
-- same text repeated five times — five things to correct when it is wrong — or
-- an array that nothing can join against.
-- ---------------------------------------------------------------------------

create table if not exists public.kpi_notes (
  id uuid primary key default gen_random_uuid(),

  body text not null check (length(btrim(body)) between 1 and 2000),

  created_by uuid not null references public.profiles (id) on delete cascade,

  /*
   * The author's name, copied in at the time of writing.
   *
   * Deliberately not read back through `profiles`. A recipient may read their
   * own profile row and no other, so resolving the author would either show
   * them nothing or need a policy opening every administrator's row to every
   * member of staff. Copying the name costs one column and asks for nothing.
   *
   * It is the name as it was when the note was written, which is also the more
   * honest answer: a note is a thing somebody said on a day.
   */
  author_name text not null default '',

  created_at timestamptz not null default now()
);

comment on table public.kpi_notes is
  'A KPI or note written by a super admin, shown to the people in kpi_note_recipients.';

create table if not exists public.kpi_note_recipients (
  note_id uuid not null references public.kpi_notes (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  primary key (note_id, user_id)
);

comment on table public.kpi_note_recipients is
  'Who each KPI note is addressed to. Removing the note removes these with it.';

-- The dashboard asks one question, once per launch: what is addressed to me?
create index if not exists kpi_note_recipients_user_idx
  on public.kpi_note_recipients (user_id);

-- ---------------------------------------------------------------------------
-- Reaching across without recursion
--
-- A note is readable because of a row in the recipients table, and a recipient
-- row is readable because of the note it hangs off. Written as two plain
-- policies those consult each other and Postgres refuses both — the same wall
-- `fix_assignee_recursion` hit, and the same way through it: ask a definer
-- function, which does not re-enter row level security.
--
-- It answers only about the caller — "is this note addressed to me" — so it
-- cannot be used to find out who else is on one.
-- ---------------------------------------------------------------------------

create or replace function public.kpi_note_is_mine(p_note uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.kpi_note_recipients
     where note_id = p_note
       and user_id = auth.uid()
  );
$$;

comment on function public.kpi_note_is_mine is
  'True when the given KPI note is addressed to the caller. Safe to call from policies.';

revoke execute on function public.kpi_note_is_mine(uuid) from public;
grant execute on function public.kpi_note_is_mine(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Writing is a super admin's alone, on both tables. Reading is the person the
-- note names, and nobody else — which is the whole point of the feature.
-- ---------------------------------------------------------------------------

alter table public.kpi_notes enable row level security;
alter table public.kpi_note_recipients enable row level security;

drop policy if exists "Notes addressed to you, or any as a super admin" on public.kpi_notes;
create policy "Notes addressed to you, or any as a super admin"
  on public.kpi_notes for select
  using (public.is_super_admin(auth.uid()) or public.kpi_note_is_mine(id));

drop policy if exists "Only a super admin writes a note" on public.kpi_notes;
create policy "Only a super admin writes a note"
  on public.kpi_notes for insert
  with check (public.is_super_admin(auth.uid()) and created_by = auth.uid());

drop policy if exists "Only a super admin removes a note" on public.kpi_notes;
create policy "Only a super admin removes a note"
  on public.kpi_notes for delete
  using (public.is_super_admin(auth.uid()));

/*
 * No update policy, on purpose.
 *
 * A note is something that was said to a group of people. Editing it after they
 * have read it would change what they were told without their knowing, so a
 * wrong one is removed and a right one written.
 */

drop policy if exists "Your own row, or any as a super admin" on public.kpi_note_recipients;
create policy "Your own row, or any as a super admin"
  on public.kpi_note_recipients for select
  using (user_id = auth.uid() or public.is_super_admin(auth.uid()));

drop policy if exists "Only a super admin names the audience" on public.kpi_note_recipients;
create policy "Only a super admin names the audience"
  on public.kpi_note_recipients for insert
  with check (public.is_super_admin(auth.uid()));

drop policy if exists "Only a super admin changes the audience" on public.kpi_note_recipients;
create policy "Only a super admin changes the audience"
  on public.kpi_note_recipients for delete
  using (public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Check
--
--   -- as a super admin: every note
--   select id, author_name, body from public.kpi_notes;
--
--   -- as anybody else: only the ones addressed to them
--   select count(*) from public.kpi_notes;
-- ---------------------------------------------------------------------------
