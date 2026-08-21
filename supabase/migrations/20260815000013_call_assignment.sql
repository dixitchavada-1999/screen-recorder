-- ---------------------------------------------------------------------------
-- Calls are scheduled *for* people, not just *by* them
--
-- Until now a call belonged to whoever typed it in, and that person was the
-- only one who ever saw it. What is wanted is the opposite arrangement: one
-- person schedules a call for somebody else — a main person and any number
-- alongside them — and it appears in *their* day, not in the scheduler's.
--
-- So `scheduled_calls.user_id` keeps its column but changes its meaning. It is
-- now a record of who arranged the call. Who the call is *for* lives in
-- `scheduled_call_assignees`, and that is what every list is keyed by.
--
-- People are named by their Nexus id rather than by a profile, deliberately: a
-- call can be scheduled for somebody who has never opened this app, and will be
-- waiting for them when they first sign in.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The roster

   A cache of Nexus's staff list. Refreshed once a day at most — the partner API
   allows fifty reads in twenty-four hours and exists to be read on a schedule,
   not when a dropdown opens.
   -------------------------------------------------------------------------- */

create table if not exists public.nexus_users (
  nexus_id uuid primary key,
  name     text not null,

  /*
   * False once somebody stops appearing in the roster.
   *
   * Never deleted: calls already point at them, and a leaver's history is still
   * a record of what happened. They simply stop being offered in the picker.
   */
  active boolean not null default true,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table public.nexus_users is
  'Cached Nexus staff roster. Written only by the roster-sync function.';

create index if not exists nexus_users_active_name_idx
  on public.nexus_users (active, name);

alter table public.nexus_users enable row level security;

/*
 * Readable by anybody signed in.
 *
 * That is a direct consequence of the requirement: any person may schedule a
 * call for any other, so every person needs the picker, and the picker is this
 * table. Worth knowing that it is the whole staff list — it carries names and
 * ids and nothing else, which is all the partner API gives us.
 */
drop policy if exists "The roster is readable by anyone signed in" on public.nexus_users;
create policy "The roster is readable by anyone signed in"
  on public.nexus_users for select
  to authenticated
  using (true);

/* --------------------------------------------------------------------------
   2. When the roster was last pulled

   One row. The sync function reads it, decides whether the cache is stale, and
   claims the refresh by writing to it — which is also what stops several
   machines starting at nine o'clock from spending the day's quota at once.
   -------------------------------------------------------------------------- */

create table if not exists public.nexus_roster_state (
  id             boolean primary key default true check (id),
  last_synced_at timestamptz,
  last_count     integer,
  last_error     text
);

insert into public.nexus_roster_state (id) values (true) on conflict (id) do nothing;

-- Row level security on, no policy at all: this denies everybody. Only the
-- service role — the sync function — has any business here.
alter table public.nexus_roster_state enable row level security;

/* --------------------------------------------------------------------------
   3. Who a call is for
   -------------------------------------------------------------------------- */

comment on column public.scheduled_calls.user_id is
  'Who arranged the call. Who it is *for* is in scheduled_call_assignees.';

create table if not exists public.scheduled_call_assignees (
  call_id  uuid not null references public.scheduled_calls (id) on delete cascade,
  nexus_id uuid not null references public.nexus_users (nexus_id),

  /*
   * The person the call is really for, as opposed to the others on it.
   *
   * The difference is what the UI shows, not what anybody may do: everyone on a
   * call sees it and is reminded about it in exactly the same way.
   */
  is_primary boolean not null default false,

  -- Reserved for the Slack notification phase: when this person was told.
  notified_at timestamptz,

  primary key (call_id, nexus_id)
);

comment on table public.scheduled_call_assignees is
  'The people a call is for. One row per person; at most one of them primary.';

create unique index if not exists scheduled_call_one_primary
  on public.scheduled_call_assignees (call_id) where is_primary;

-- Every list starts from "what is on this person's plate".
create index if not exists scheduled_call_assignees_person_idx
  on public.scheduled_call_assignees (nexus_id);

/* --------------------------------------------------------------------------
   4. Which person is asking

   The Nexus id travels in the access token — the custom claim added by
   `custom_access_token` — so a policy can ask "is this call mine?" without
   joining back through profiles on every row.
   -------------------------------------------------------------------------- */

create or replace function public.my_nexus_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'nexus_user_id', '')::uuid
$$;

comment on function public.my_nexus_id is
  'The signed-in person''s Nexus id, from the access token. Null if unlinked.';

/* --------------------------------------------------------------------------
   5. Who sees a call

   Three ways in, and the old one — "you own it" — is now the weakest of them:
   it exists so a person can still find and correct something they arranged for
   somebody else. The app does not show those in the calendar; it lists them
   under "Scheduled by me", which is a different question from "what am I doing
   today".
   -------------------------------------------------------------------------- */

drop policy if exists "Calls are viewable by their owner" on public.scheduled_calls;
drop policy if exists "Calls you are on, or ones you scheduled" on public.scheduled_calls;
create policy "Calls you are on, or ones you scheduled"
  on public.scheduled_calls for select
  using (
    auth.uid() = user_id
    or public.is_super_admin(auth.uid())
    or exists (
      select 1 from public.scheduled_call_assignees a
       where a.call_id = id and a.nexus_id = public.my_nexus_id()
    )
  );

/*
 * Editing and deleting stay with whoever arranged it.
 *
 * Being on somebody's call does not make its time yours to move. The one thing
 * a person does need to change about their own call — whether they turned up —
 * goes through `set_call_status` below, which changes that and nothing else.
 */

/* --------------------------------------------------------------------------
   6. The assignee rows themselves
   -------------------------------------------------------------------------- */

alter table public.scheduled_call_assignees enable row level security;

/*
 * Readable exactly when the call is.
 *
 * The subquery is subject to `scheduled_calls`'s own policy, so this needs no
 * copy of the rule above — and cannot drift out of step with it.
 */
drop policy if exists "Assignees are visible with their call" on public.scheduled_call_assignees;
create policy "Assignees are visible with their call"
  on public.scheduled_call_assignees for select
  using (exists (select 1 from public.scheduled_calls c where c.id = call_id));

drop policy if exists "Only the scheduler sets who a call is for" on public.scheduled_call_assignees;
create policy "Only the scheduler sets who a call is for"
  on public.scheduled_call_assignees for insert
  with check (
    exists (
      select 1 from public.scheduled_calls c
       where c.id = call_id
         and (c.user_id = auth.uid() or public.is_super_admin(auth.uid()))
    )
  );

drop policy if exists "Only the scheduler removes who a call is for" on public.scheduled_call_assignees;
create policy "Only the scheduler removes who a call is for"
  on public.scheduled_call_assignees for delete
  using (
    exists (
      select 1 from public.scheduled_calls c
       where c.id = call_id
         and (c.user_id = auth.uid() or public.is_super_admin(auth.uid()))
    )
  );

/* --------------------------------------------------------------------------
   7. Marking a call done, missed or cancelled

   The one edit somebody on a call may make. A function rather than an update
   policy because policies choose rows, never columns — an update policy wide
   enough to let Raj say he attended would also let him move the call.
   -------------------------------------------------------------------------- */

create or replace function public.set_call_status(
  p_call uuid,
  p_status text,
  /*
   * When true the write only lands on a call that is still `scheduled`.
   *
   * That condition is what makes the join check announce a missed call exactly
   * once: whoever writes first wins — the person answering the prompt, this
   * machine's timer, or another machine's — and every later attempt changes
   * nothing and returns nothing.
   */
  p_only_if_scheduled boolean default false
)
returns public.scheduled_calls
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed boolean;
  result  public.scheduled_calls;
begin
  if p_status not in ('scheduled', 'completed', 'cancelled', 'missed') then
    raise exception 'Unknown status %', p_status using errcode = 'invalid_parameter_value';
  end if;

  select exists (
    select 1
      from public.scheduled_calls c
      left join public.scheduled_call_assignees a on a.call_id = c.id
     where c.id = p_call
       and (
         c.user_id = auth.uid()
         or public.is_super_admin(auth.uid())
         or a.nexus_id = public.my_nexus_id()
       )
  ) into allowed;

  if not allowed then
    raise exception 'That call is not yours to change'
      using errcode = 'insufficient_privilege';
  end if;

  update public.scheduled_calls
     set status = p_status
   where id = p_call
     and (not p_only_if_scheduled or status = 'scheduled')
  returning * into result;

  -- Null when the guard held: nothing changed, and the caller needs to know
  -- that rather than be told the write succeeded.
  return result;
end;
$$;

revoke execute on function public.set_call_status(uuid, text, boolean) from public, anon;
grant execute on function public.set_call_status(uuid, text, boolean) to authenticated;

/* --------------------------------------------------------------------------
   8. The calls that already exist

   Every one of them was scheduled by somebody for themselves, because that was
   the only thing the app could do. They become calls assigned to that person,
   which keeps them exactly where their owner has always seen them.

   The roster is seeded from the profiles first — the assignee rows point at it,
   and the first real sync has not run yet. Names here are provisional and the
   sync overwrites them.
   -------------------------------------------------------------------------- */

insert into public.nexus_users (nexus_id, name)
select p.nexus_user_id, coalesce(nullif(trim(p.full_name), ''), p.email)
  from public.profiles p
 where p.nexus_user_id is not null
on conflict (nexus_id) do nothing;

insert into public.scheduled_call_assignees (call_id, nexus_id, is_primary)
select c.id, p.nexus_user_id, true
  from public.scheduled_calls c
  join public.profiles p on p.id = c.user_id
 where p.nexus_user_id is not null
on conflict do nothing;

/* --------------------------------------------------------------------------
   9. Applying a roster

   The whole list arrives as one array and is settled in one statement, so a
   reader never catches the table midway through — with two statements there
   would be a moment where everybody looked like a leaver.

   An empty list is refused rather than applied. A partner API having a bad
   minute must not be able to retire the entire company.
   -------------------------------------------------------------------------- */

create or replace function public.sync_nexus_roster(p_users jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  seen integer;
begin
  create temporary table _roster (nexus_id uuid primary key, name text) on commit drop;

  insert into _roster (nexus_id, name)
  select (entry ->> 'id')::uuid,
         coalesce(nullif(trim(entry ->> 'name'), ''), '(unnamed)')
    from jsonb_array_elements(coalesce(p_users, '[]'::jsonb)) entry
   where entry ->> 'id' is not null
  on conflict (nexus_id) do nothing;

  select count(*) into seen from _roster;

  if seen = 0 then
    raise exception 'Refusing to apply an empty roster'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.nexus_users (nexus_id, name, active, last_seen_at)
  select nexus_id, name, true, now() from _roster
  on conflict (nexus_id) do update
     set name = excluded.name, active = true, last_seen_at = now();

  -- Anybody who has stopped appearing has left. The row stays: calls point at
  -- it, and what happened still happened.
  update public.nexus_users u
     set active = false
   where u.active
     and not exists (select 1 from _roster r where r.nexus_id = u.nexus_id);

  return seen;
end;
$$;

revoke execute on function public.sync_nexus_roster(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check
--
--   select count(*) from public.nexus_users;
--   select count(*) from public.scheduled_call_assignees;
--
--   -- calls that nobody is on: only possible for an owner with no Nexus link
--   select c.id, c.title from public.scheduled_calls c
--    where not exists (select 1 from public.scheduled_call_assignees a
--                       where a.call_id = c.id);
-- ---------------------------------------------------------------------------
