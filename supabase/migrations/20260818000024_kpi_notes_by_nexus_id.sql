-- ---------------------------------------------------------------------------
-- KPI notes are addressed to Nexus people, not to app accounts
--
-- The first version keyed the audience by `profiles.id`, which is the account
-- somebody has in *this* app. That is the wrong identity. It means a KPI can
-- only be set for people who have already installed the recorder and signed in,
-- and the whole point is the opposite: an administrator sets a target for a
-- member of staff, and it is waiting for them the first time they open it.
--
-- So the audience moves to the Nexus id, exactly as `scheduled_call_assignees`
-- already does. `my_nexus_id()` maps the signed-in account onto that identity,
-- and somebody with no Nexus link simply matches nothing.
--
-- The table is recreated rather than altered. There is no sensible conversion
-- between the two identities for rows already stored, and at the time of
-- writing there are none to convert.
-- ---------------------------------------------------------------------------

drop table if exists public.kpi_note_recipients;

create table public.kpi_note_recipients (
  note_id  uuid not null references public.kpi_notes (id) on delete cascade,
  nexus_id uuid not null references public.nexus_users (nexus_id),
  primary key (note_id, nexus_id)
);

comment on table public.kpi_note_recipients is
  'Which Nexus people each KPI note is addressed to. Removing the note removes these with it.';

-- The dashboard asks one question, once per launch: what is addressed to me?
create index if not exists kpi_note_recipients_person_idx
  on public.kpi_note_recipients (nexus_id);

-- ---------------------------------------------------------------------------
-- The same question, asked of the new identity
--
-- Still a definer function, and still for the reason the last one was: a note
-- is readable because of a recipient row, and a recipient row is readable
-- because of its note. Asked through here, neither policy re-enters the other.
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
       and nexus_id = public.my_nexus_id()
  );
$$;

comment on function public.kpi_note_is_mine is
  'True when the given KPI note is addressed to the signed-in person. Safe to call from policies.';

revoke execute on function public.kpi_note_is_mine(uuid) from public, anon;
grant execute on function public.kpi_note_is_mine(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
--
-- Recreating the table dropped its own; the ones on `kpi_notes` still stand and
-- now go through the rewritten function above.
-- ---------------------------------------------------------------------------

alter table public.kpi_note_recipients enable row level security;

drop policy if exists "Your own row, or any as a super admin" on public.kpi_note_recipients;
create policy "Your own row, or any as a super admin"
  on public.kpi_note_recipients for select
  using (nexus_id = public.my_nexus_id() or public.is_super_admin(auth.uid()));

drop policy if exists "Only a super admin names the audience" on public.kpi_note_recipients;
create policy "Only a super admin names the audience"
  on public.kpi_note_recipients for insert
  with check (public.is_super_admin(auth.uid()));

drop policy if exists "Only a super admin changes the audience" on public.kpi_note_recipients;
create policy "Only a super admin changes the audience"
  on public.kpi_note_recipients for delete
  using (public.is_super_admin(auth.uid()));
