-- ---------------------------------------------------------------------------
-- Roles
--
-- Adds a role to every profile. New accounts are ordinary users; elevating one
-- is a deliberate act performed here, in SQL, by somebody with database access.
--
-- The hard part is not the column — it is making sure a user cannot hand
-- themselves the role. Three things stand in the way, in order:
--
--   1. `handle_new_user` never reads a role from sign-up metadata, so passing
--      {"role": "super_admin"} to signUp() achieves nothing.
--   2. UPDATE is granted column by column, so a request that touches `role`
--      is refused before any policy is consulted.
--   3. A trigger refuses the change anyway, covering any future path that
--      forgets the grant.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('user', 'super_admin');
  end if;
end
$$;

alter table public.profiles
  add column if not exists role public.user_role not null default 'user';

comment on column public.profiles.role is
  'Authorisation level. Changed only through SQL by a database administrator.';

-- ---------------------------------------------------------------------------
-- The first super admin
--
-- Matched by email rather than by a hard-coded id so this migration works on a
-- fresh project too. Case-insensitive: addresses are not case sensitive in
-- practice and Supabase stores them as typed.
-- ---------------------------------------------------------------------------

update public.profiles
   set role = 'super_admin'
 where lower(email) = lower('dixit.openmalo@gmail.com');

-- ---------------------------------------------------------------------------
-- Column-level UPDATE
--
-- Supabase grants ALL on new public tables to the `authenticated` role, which
-- includes every column. Narrowing it is what actually stops a crafted PATCH
-- from setting `role` — row level security decides *which rows* may be touched,
-- never *which columns*.
-- ---------------------------------------------------------------------------

revoke update on public.profiles from authenticated, anon;
grant update (full_name, avatar_url) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Belt and braces
--
-- `security definer` so the check can read profiles without tripping over the
-- row level security it is protecting.
-- ---------------------------------------------------------------------------

create or replace function public.is_super_admin(uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = uid and role = 'super_admin'
  );
$$;

comment on function public.is_super_admin is
  'True when the given account holds the super_admin role. Safe to call from policies.';

create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    -- auth.uid() is null for the service role and for SQL run in the editor,
    -- which is exactly where a role change is supposed to come from.
    if auth.uid() is not null and not public.is_super_admin(auth.uid()) then
      raise exception 'Only a super admin can change a role'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ---------------------------------------------------------------------------
-- Check
--
-- Run after applying: one super_admin, everyone else a user.
--
--   select email, role from public.profiles order by role, email;
-- ---------------------------------------------------------------------------
