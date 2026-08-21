-- ---------------------------------------------------------------------------
-- Authentication moves to Nexus; sessions stay here
--
-- The Nexus partner API answers exactly one question — "is this password
-- right?" — and hands back an id and a name. Nothing else about a session comes
-- from there: no token, no expiry, no role. All of that is issued and owned by
-- this database and the functions in front of it.
--
-- Which means Supabase's own auth service is no longer in the path at all, and
-- this migration cuts the schema loose from `auth.users`, gives the application
-- its own session store, and finally makes the schema aware that one person can
-- work on more than one machine.
--
-- Nothing here trusts a client. `app_sessions` has row level security on and no
-- policy at all, so only the service role — the `login` and `refresh` functions
-- — can see or write a session.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The Nexus identity
   -------------------------------------------------------------------------- */

-- The one durable link between a person here and the same person in Nexus.
-- Their email can change; this cannot, so every lookup is keyed by it.
alter table public.profiles
  add column if not exists nexus_user_id uuid;

create unique index if not exists profiles_nexus_user_id_idx
  on public.profiles (nexus_user_id);

comment on column public.profiles.nexus_user_id is
  'The person''s id in Nexus. Stable for life; the key `login` matches on.';

-- `id` used to be borrowed from auth.users. Nothing hands one over now, so the
-- table generates its own.
alter table public.profiles
  alter column id set default gen_random_uuid();

/* --------------------------------------------------------------------------
   2. Cut loose from auth.users

   The rows in `auth.users` are not deleted — they simply stop being consulted.
   Leaving them costs nothing and keeps this migration reversible.
   -------------------------------------------------------------------------- */

-- Sign-up happens in Nexus, so nothing arrives in auth.users to react to. The
-- `login` function creates the profile row instead.
drop trigger if exists on_auth_user_created       on auth.users;
drop trigger if exists on_auth_user_email_changed on auth.users;

drop function if exists public.handle_new_user();
drop function if exists public.handle_user_email_change();

-- Every foreign key that pointed at an account that is no longer created here.
alter table public.profiles           drop constraint if exists profiles_id_fkey;
alter table public.scheduled_calls    drop constraint if exists scheduled_calls_user_id_fkey;
alter table public.activity_segments  drop constraint if exists activity_segments_user_id_fkey;
alter table public.screenshots        drop constraint if exists screenshots_user_id_fkey;
alter table public.activity_intervals drop constraint if exists activity_intervals_user_id_fkey;

/*
 * Re-pointed at `profiles`, which is now the account table.
 *
 * Existing rows are safe: `profiles.id` was already the same uuid as
 * `auth.users.id`, and migration 1 backfilled a profile for every account. If
 * one of these fails with 23503 there is orphaned data — find it with
 *
 *   select distinct user_id from public.activity_segments
 *   where user_id not in (select id from public.profiles);
 */
alter table public.scheduled_calls
  add constraint scheduled_calls_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete cascade;

alter table public.activity_segments
  add constraint activity_segments_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete cascade;

alter table public.screenshots
  add constraint screenshots_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete cascade;

alter table public.activity_intervals
  add constraint activity_intervals_user_id_fkey
  foreign key (user_id) references public.profiles (id) on delete cascade;

/* --------------------------------------------------------------------------
   3. Devices

   One person, several machines — a desk and a laptop is the ordinary case, not
   the exception. Until now every row was filed under a person alone, which
   quietly assumed there was only ever one machine behind them.
   -------------------------------------------------------------------------- */

create table if not exists public.devices (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,

  -- Generated once by the app and kept in its own data directory. Opaque on
  -- purpose: it identifies an installation, and says nothing about the hardware.
  machine_id text not null,

  hostname    text,
  platform    text,
  app_version text,

  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

comment on table public.devices is
  'One row per machine a person has signed in from. Written only by the login function.';

-- The same installation signing in again is the same device, not a new one.
create unique index if not exists devices_user_machine_idx
  on public.devices (user_id, machine_id);

alter table public.devices enable row level security;

-- Reading only. Registration happens in `login`, which runs as the service role
-- and is not subject to any of this.
drop policy if exists "Own devices, or a super admin's view" on public.devices;
create policy "Own devices, or a super admin's view"
  on public.devices for select
  using (auth.uid() = user_id or public.is_super_admin(auth.uid()));

/* --------------------------------------------------------------------------
   4. Sessions

   What replaces GoTrue's refresh token. The access token is a short-lived JWT
   that is never stored anywhere — this table is the long half, and it is what
   makes a session something we can actually end.
   -------------------------------------------------------------------------- */

create table if not exists public.app_sessions (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles (id) on delete cascade,

  -- Which machine holds it. A session is bound to the device it was issued to,
  -- so one laptop being signed out does not touch the other.
  device_id uuid references public.devices (id) on delete set null,

  /*
   * SHA-256 of the refresh token, never the token.
   *
   * The token itself exists in exactly two places: the app's encrypted store
   * and the response that delivered it. A leaked dump of this table cannot be
   * used to sign in as anybody.
   */
  refresh_token_hash text not null,

  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_used_at timestamptz,

  -- Set instead of deleting the row: "this session was ended, and when" is
  -- worth keeping, and a deleted row cannot say it.
  revoked_at timestamptz
);

comment on table public.app_sessions is
  'Refresh-token records. Written and read only by the login and refresh functions.';

create unique index if not exists app_sessions_token_idx
  on public.app_sessions (refresh_token_hash);

-- Revoking everything for one person, which is what a leaver needs.
create index if not exists app_sessions_user_idx
  on public.app_sessions (user_id) where revoked_at is null;

/*
 * Row level security on, and deliberately no policy.
 *
 * That combination denies everybody. The service role bypasses it, which is
 * exactly the access these rows should have: the two functions that issue and
 * rotate sessions, and nothing else. A signed-in app cannot read its own
 * session row, and does not need to.
 */
alter table public.app_sessions enable row level security;

/* --------------------------------------------------------------------------
   5. Activity becomes device-aware

   This is a correctness fix as much as a feature. The unique indexes below
   used to be `(user_id, started_at)`; two machines working the same minutes
   would collide on them, and the uploader sends with `ignoreDuplicates`, so
   the second machine's day was silently thrown away.
   -------------------------------------------------------------------------- */

alter table public.activity_segments
  add column if not exists device_id uuid references public.devices (id) on delete set null;

alter table public.activity_intervals
  add column if not exists device_id uuid references public.devices (id) on delete set null;

alter table public.screenshots
  add column if not exists device_id uuid references public.devices (id) on delete set null;

/*
 * `nulls not distinct` matters here.
 *
 * A machine that recorded before it managed to register — a first run with no
 * network — files rows with a null device. Postgres treats nulls as distinct by
 * default, which would turn every retry of those rows into a new row and undo
 * the whole point of the index.
 */
drop index if exists public.activity_segments_unique;
create unique index activity_segments_unique
  on public.activity_segments (user_id, device_id, started_at, state) nulls not distinct;

drop index if exists public.activity_intervals_unique;
create unique index activity_intervals_unique
  on public.activity_intervals (user_id, device_id, started_at) nulls not distinct;

drop index if exists public.screenshots_unique;
create unique index screenshots_unique
  on public.screenshots (user_id, device_id, captured_at) nulls not distinct;

/* --------------------------------------------------------------------------
   6. Nobody switches off their own tracking

   `20260812000007` grants UPDATE on the two tracking columns to `authenticated`
   so a super admin can set them through the app — but the owner-update policy
   from migration 1 is still in force, so the grant also reaches the tracked
   person's own row. That migration's own comment says these columns were
   "deliberately left out" of the grant; the trigger below is what actually
   makes that true.

   Same shape as `guard_profile_role`: a null `auth.uid()` is the service role
   or the SQL editor, which is where a deliberate change is supposed to come
   from.
   -------------------------------------------------------------------------- */

create or replace function public.guard_tracking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.tracking_enabled    is distinct from old.tracking_enabled
   or new.screenshots_enabled is distinct from old.screenshots_enabled)
     and auth.uid() is not null
     and not public.is_super_admin(auth.uid()) then
    raise exception 'Only a super admin can change the tracking policy'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_tracking on public.profiles;
create trigger profiles_guard_tracking
  before update on public.profiles
  for each row execute function public.guard_tracking_policy();

/* --------------------------------------------------------------------------
   7. Link the accounts that already exist

   Every profile here predates Nexus and has no `nexus_user_id`, so the first
   Nexus sign-in would find no match and create a second, empty account —
   taking the super admin's role and their whole history with it.

   `login` handles this in general by falling back to an email match and
   backfilling the id. This statement does the one account that must not be
   left to chance.
   -------------------------------------------------------------------------- */

update public.profiles
   set nexus_user_id = '329d3eb4-38ab-4f49-a513-3921fe86ce89'
 where lower(email) = lower('dixit.openmalo@gmail.com')
   and nexus_user_id is null;

-- ---------------------------------------------------------------------------
-- Check
--
--   select email, role, nexus_user_id from public.profiles order by email;
--   select count(*) from public.devices;
--   select count(*) from public.app_sessions where revoked_at is null;
--
--   -- the tracking guard: as an ordinary user this must fail
--   update public.profiles set tracking_enabled = false where id = auth.uid();
-- ---------------------------------------------------------------------------
