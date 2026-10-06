-- ---------------------------------------------------------------------------
-- One call per Google event, however many people connect that calendar
--
-- Until now every person who connected a Google account got their own copy of
-- each of its meetings: three people on one shared calendar meant three rows
-- for the same meeting, three statuses that could disagree, and the same
-- meeting three times over in the "all calls" view.
--
-- Now the Google account is a thing of its own, people are linked to it, and a
-- meeting is one row whose assignees are everybody linked to its calendar. The
-- status is shared with it — marking a meeting done marks it done for everyone
-- on it, exactly as it already does for a call typed into the app.
--
-- Writes to imported calls no longer go through the table policies. Somebody
-- who did not create a row still has to be able to move it when Google moves
-- the meeting, and a policy wide enough for that would let them move anything.
-- The functions below each check one thing instead — "is this person linked to
-- this calendar?" — and do only what a sync or a disconnect needs.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. Google accounts, and who is linked to them
   -------------------------------------------------------------------------- */

create table if not exists public.google_accounts (
  id         uuid primary key default gen_random_uuid(),
  -- Always lower case: Google treats the address case-insensitively, and two
  -- spellings of one address must never become two calendars.
  email      text not null unique check (email = lower(email) and length(email) between 3 and 320),
  created_at timestamptz not null default now()
);

comment on table public.google_accounts is
  'A Google calendar somebody has connected. Tokens never come here — they stay on each machine.';

create table if not exists public.user_google_accounts (
  user_id           uuid not null references auth.users (id) on delete cascade,
  google_account_id uuid not null references public.google_accounts (id) on delete cascade,
  linked_at         timestamptz not null default now(),
  primary key (user_id, google_account_id)
);

comment on table public.user_google_accounts is
  'Who has connected which Google calendar. Written only by the google-link function and unlink_google_account.';

create index if not exists user_google_accounts_account_idx
  on public.user_google_accounts (google_account_id);

alter table public.google_accounts enable row level security;
alter table public.user_google_accounts enable row level security;

/*
 * Readable, never writable, from the app.
 *
 * A link is proof that this person holds a token for that calendar — the
 * google-link function checks the token with Google before writing one. Letting
 * the app insert rows directly would let anybody type in anybody's address and
 * be handed that person's meetings.
 */
drop policy if exists "Your own links" on public.user_google_accounts;
create policy "Your own links"
  on public.user_google_accounts for select
  using (user_id = auth.uid());

drop policy if exists "Accounts you are linked to" on public.google_accounts;
create policy "Accounts you are linked to"
  on public.google_accounts for select
  using (
    exists (
      select 1 from public.user_google_accounts l
       where l.google_account_id = id and l.user_id = auth.uid()
    )
  );

/* --------------------------------------------------------------------------
   2. Calls point at the account
   -------------------------------------------------------------------------- */

alter table public.scheduled_calls
  add column if not exists google_account_id uuid
    references public.google_accounts (id) on delete cascade;

comment on column public.scheduled_calls.google_account_id is
  'The Google calendar this call was imported from. Null for calls created in the app.';

/* --------------------------------------------------------------------------
   3. Bringing what already exists across
   -------------------------------------------------------------------------- */

-- Every address that has imported anything becomes an account.
insert into public.google_accounts (email)
select distinct lower(google_account_email)
  from public.scheduled_calls
 where google_account_email is not null
on conflict (email) do nothing;

update public.scheduled_calls c
   set google_account_id = g.id,
       google_account_email = g.email
  from public.google_accounts g
 where c.google_account_email is not null
   and g.email = lower(c.google_account_email)
   and c.google_account_id is distinct from g.id;

-- Whoever imported from it had connected it, through the OAuth flow, so the
-- link is already proven for them.
insert into public.user_google_accounts (user_id, google_account_id)
select distinct c.user_id, c.google_account_id
  from public.scheduled_calls c
 where c.google_account_id is not null
on conflict do nothing;

/*
 * Folding the copies into one.
 *
 * The survivor is a copy somebody had already settled, if there is one — a
 * "completed" should not be lost to an untouched "scheduled" — and otherwise
 * the oldest. Everybody on the other copies moves onto it before they go.
 */
-- Written as a view of the duplicates rather than a temporary table, so the
-- file behaves the same pasted into the SQL editor (one transaction per
-- statement) as it does under the migration runner.
create or replace view pg_temp.google_merge as
select id, keeper
  from (
    select c.id,
           first_value(c.id) over (
             partition by c.google_account_id, c.google_event_id
             order by (c.status = 'scheduled'), c.created_at, c.id
           ) as keeper
      from public.scheduled_calls c
     where c.google_account_id is not null
       and c.google_event_id is not null
  ) ranked
 where id <> keeper;

insert into public.scheduled_call_assignees (call_id, nexus_id, is_primary)
select distinct m.keeper, a.nexus_id, false
  from pg_temp.google_merge m
  join public.scheduled_call_assignees a on a.call_id = m.id
on conflict do nothing;

delete from public.scheduled_calls c
 using pg_temp.google_merge m
 where c.id = m.id;

/* --------------------------------------------------------------------------
   4. One row per event, per account — no longer per person
   -------------------------------------------------------------------------- */

drop index if exists public.scheduled_calls_google_event_key;

create unique index if not exists scheduled_calls_google_event_key
  on public.scheduled_calls (google_account_id, google_event_id)
  where google_event_id is not null;

alter table public.scheduled_calls
  drop constraint if exists scheduled_calls_google_account_check;

alter table public.scheduled_calls
  add constraint scheduled_calls_google_account_check
  check ((google_event_id is null) = (google_account_id is null));

/* --------------------------------------------------------------------------
   5. Linking — called by the google-link function only
   -------------------------------------------------------------------------- */

/*
 * Links a person to a calendar and puts them on every meeting already imported
 * from it.
 *
 * Service role only: the function that calls this has just asked Google whose
 * calendar the token opens, which is the whole of the proof. Returns the
 * account's id.
 */
create or replace function public.link_google_account(p_user uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  account uuid;
  person  uuid;
begin
  insert into public.google_accounts (email)
  values (lower(btrim(p_email)))
  on conflict (email) do update set email = excluded.email
  returning id into account;

  insert into public.user_google_accounts (user_id, google_account_id)
  values (p_user, account)
  on conflict do nothing;

  select p.nexus_user_id into person
    from public.profiles p
    join public.nexus_users n on n.nexus_id = p.nexus_user_id
   where p.id = p_user;

  if person is not null then
    insert into public.scheduled_call_assignees (call_id, nexus_id, is_primary)
    select c.id, person, false
      from public.scheduled_calls c
     where c.google_account_id = account
    on conflict (call_id, nexus_id) do nothing;
  end if;

  return account;
end;
$$;

revoke execute on function public.link_google_account(uuid, text) from public, anon, authenticated;

/* --------------------------------------------------------------------------
   6. Syncing — any linked person may bring the shared rows up to date
   -------------------------------------------------------------------------- */

/*
 * Makes one window of the schedule match one Google calendar.
 *
 * `p_events` is an array of { event_id, title, starts_at, duration_minutes,
 * notes }. Google owns what a meeting is — its title and time — and those are
 * overwritten. What people decided about it — the status, the notes — is never
 * touched once the row exists.
 *
 * Only the window is judged: a meeting outside it was not looked at, so it
 * cannot be concluded to have gone.
 *
 * Returns { imported, updated, removed }. Raises `not_linked` (P0002) when the
 * caller has not been linked to this calendar yet, so the app can link and try
 * again.
 */
create or replace function public.apply_google_events(
  p_email  text,
  p_from   timestamptz,
  p_to     timestamptz,
  p_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  me        uuid := auth.uid();
  account   uuid;
  imported  integer := 0;
  updated   integer := 0;
  removed   integer := 0;
begin
  if me is null or not public.is_active_person(me) then
    raise exception 'Sign in to sync a calendar' using errcode = 'insufficient_privilege';
  end if;

  if not public.has_permission(me, 'calendar.create') then
    raise exception 'You do not have permission to import calls' using errcode = 'insufficient_privilege';
  end if;

  select g.id into account
    from public.google_accounts g
    join public.user_google_accounts l on l.google_account_id = g.id and l.user_id = me
   where g.email = lower(btrim(p_email));

  if account is null then
    raise exception 'not_linked' using errcode = 'P0002';
  end if;

  -- Dropped first so two calls in one transaction cannot collide.
  drop table if exists pg_temp._events;
  create temporary table _events on commit drop as
  select distinct on (e ->> 'event_id')
         e ->> 'event_id' as event_id,
         left(coalesce(nullif(btrim(e ->> 'title'), ''), 'Untitled event'), 200) as title,
         (e ->> 'starts_at')::timestamptz as starts_at,
         least(1440, greatest(1, coalesce((e ->> 'duration_minutes')::integer, 30))) as duration_minutes,
         nullif(left(coalesce(e ->> 'notes', ''), 2000), '') as notes
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
   where nullif(e ->> 'event_id', '') is not null
     and e ->> 'starts_at' is not null;

  -- What Google moved or renamed. Only rows that actually differ are written.
  with changed as (
    update public.scheduled_calls c
       set title = e.title,
           starts_at = e.starts_at,
           duration_minutes = e.duration_minutes
      from _events e
     where c.google_account_id = account
       and c.google_event_id = e.event_id
       and (c.title, c.starts_at, c.duration_minutes)
           is distinct from (e.title, e.starts_at, e.duration_minutes)
    returning 1
  )
  select count(*) into updated from changed;

  -- What is new. The first person to import a meeting is recorded as having
  -- arranged it; that only decides who may edit it in the app, and Google is
  -- what really owns it.
  with added as (
    insert into public.scheduled_calls
      (user_id, title, starts_at, duration_minutes, notes, status,
       google_event_id, google_account_id, google_account_email)
    select me, e.title, e.starts_at, e.duration_minutes, e.notes, 'scheduled',
           e.event_id, account, lower(btrim(p_email))
      from _events e
    on conflict (google_account_id, google_event_id) where google_event_id is not null
      do nothing
    returning 1
  )
  select count(*) into imported from added;

  -- Everybody linked to the calendar is on every meeting in the window. Covers
  -- new rows and anybody linked since a row was made.
  insert into public.scheduled_call_assignees (call_id, nexus_id, is_primary)
  select c.id, p.nexus_user_id, (p.id = c.user_id)
    from public.scheduled_calls c
    join public.user_google_accounts l on l.google_account_id = c.google_account_id
    join public.profiles p on p.id = l.user_id
    join public.nexus_users n on n.nexus_id = p.nexus_user_id
   where c.google_account_id = account
     and c.starts_at >= p_from
     and c.starts_at < p_to
  on conflict do nothing;

  -- Deleted or cancelled in Google.
  with gone as (
    delete from public.scheduled_calls c
     where c.google_account_id = account
       and c.starts_at >= p_from
       and c.starts_at < p_to
       and not exists (select 1 from _events e where e.event_id = c.google_event_id)
    returning 1
  )
  select count(*) into removed from gone;

  return jsonb_build_object('imported', imported, 'updated', updated, 'removed', removed);
end;
$$;

revoke execute on function public.apply_google_events(text, timestamptz, timestamptz, jsonb) from public, anon;
grant execute on function public.apply_google_events(text, timestamptz, timestamptz, jsonb) to authenticated;

/* --------------------------------------------------------------------------
   7. Disconnecting
   -------------------------------------------------------------------------- */

/*
 * Unlinks the caller from a calendar.
 *
 * They come off its meetings; the meetings themselves stay for everybody still
 * linked. Only when nobody is left does the calendar go, and its meetings with
 * it — nobody would be keeping them up to date any more.
 *
 * Returns how many meetings were deleted outright.
 */
create or replace function public.unlink_google_account(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  me      uuid := auth.uid();
  account uuid;
  person  uuid;
  removed integer := 0;
begin
  if me is null then
    raise exception 'Sign in to disconnect a calendar' using errcode = 'insufficient_privilege';
  end if;

  select id into account from public.google_accounts where email = lower(btrim(p_email));
  if account is null then return 0; end if;

  delete from public.user_google_accounts
   where user_id = me and google_account_id = account;

  if not found then return 0; end if;

  select nexus_user_id into person from public.profiles where id = me;

  if person is not null then
    delete from public.scheduled_call_assignees a
     using public.scheduled_calls c
     where a.call_id = c.id
       and c.google_account_id = account
       and a.nexus_id = person;
  end if;

  if not exists (select 1 from public.user_google_accounts where google_account_id = account) then
    select count(*) into removed from public.scheduled_calls where google_account_id = account;
    -- Cascades to its calls, and from them to their assignees.
    delete from public.google_accounts where id = account;
  end if;

  return removed;
end;
$$;

revoke execute on function public.unlink_google_account(text) from public, anon;
grant execute on function public.unlink_google_account(text) to authenticated;

/* --------------------------------------------------------------------------
   Check after applying

     -- No meeting should appear more than once per calendar:
     select google_account_id, google_event_id, count(*)
       from public.scheduled_calls
      where google_event_id is not null
      group by 1, 2 having count(*) > 1;

     -- Who is linked to what:
     select g.email, l.user_id from public.user_google_accounts l
       join public.google_accounts g on g.id = l.google_account_id;
   -------------------------------------------------------------------------- */
