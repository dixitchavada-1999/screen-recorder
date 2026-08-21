-- ---------------------------------------------------------------------------
-- Profiles
--
-- Supabase already stores accounts in `auth.users`, but that table is owned by
-- the auth service: it cannot be extended and application code should not read
-- from it directly. `public.profiles` is the application-side row for a user —
-- one per account, created automatically at sign-up, and the place any future
-- per-user field belongs.
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  -- Same id as the auth account. Deleting the account deletes the profile.
  id uuid primary key references auth.users (id) on delete cascade,

  -- Mirrored from auth.users so the app can show an address without querying
  -- the auth schema. Kept in sync by the trigger below.
  email text not null,

  full_name text,
  avatar_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile for each auth.users row. Created automatically on sign-up.';

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Without this every anon key holder could read every profile, and the anon key
-- ships inside the desktop app. These policies are the only thing standing
-- between one user and another user's row.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

drop policy if exists "Profiles are viewable by their owner" on public.profiles;
create policy "Profiles are viewable by their owner"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Profiles are updatable by their owner" on public.profiles;
create policy "Profiles are updatable by their owner"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- No insert or delete policy on purpose: rows are created by the sign-up
-- trigger below (which runs as definer) and removed by the cascade from
-- auth.users. The client never inserts or deletes a profile itself.

-- ---------------------------------------------------------------------------
-- Keep updated_at honest
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Create the profile at sign-up
--
-- `security definer` is required: the trigger runs in the auth service's
-- transaction, where the caller has no rights on public.profiles. `search_path`
-- is pinned for the same reason it always is on a definer function — an
-- attacker-controlled search_path would otherwise decide which `profiles` this
-- writes to.
--
-- The name comes from the metadata the client passes to signUp():
--   supabase.auth.signUp({ ..., options: { data: { full_name: 'Dixit' } } })
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Keep the mirrored email current
--
-- A user can change their address from the auth side; without this the profile
-- would keep showing the old one forever.
-- ---------------------------------------------------------------------------

create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = new.email where id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- ---------------------------------------------------------------------------
-- Backfill
--
-- Makes the migration safe to run on a project that already has accounts.
-- ---------------------------------------------------------------------------

insert into public.profiles (id, email, full_name)
select
  u.id,
  u.email,
  nullif(trim(coalesce(u.raw_user_meta_data ->> 'full_name', '')), '')
from auth.users u
on conflict (id) do nothing;
