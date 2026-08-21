-- ---------------------------------------------------------------------------
-- What a session carries, and a record of every sign-in
--
-- The previous migration assumed the app would sign its own tokens and gave it
-- a session store to do it with. This project's JWT signing has already moved
-- to an asymmetric key whose private half Supabase does not hand out, and the
-- legacy shared secret is kept only to verify — so signing here would be built
-- on the one part of the platform that is explicitly on its way out.
--
-- The tokens are therefore issued by Supabase, and what this file does is make
-- them carry our facts instead of only its own: the role from `profiles`, and
-- the person's Nexus id. `app_sessions` goes, because GoTrue holds the refresh
-- token now, and is replaced by the thing it was actually useful for — a log of
-- who signed in, from which machine, and when.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The session store is no longer ours to keep
   -------------------------------------------------------------------------- */

-- Never carried a row: the refresh token belongs to GoTrue.
drop table if exists public.app_sessions;

/* --------------------------------------------------------------------------
   2. Sign-in log

   Not a session table. A session can be ended; this is the record that it
   happened at all, which is worth keeping afterwards — a person asking "was
   that me?" about a machine they do not recognise has nowhere else to look.
   -------------------------------------------------------------------------- */

create table if not exists public.login_events (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,

  at          timestamptz not null default now(),
  ip          text,
  app_version text
);

comment on table public.login_events is
  'One row per successful sign-in. Written only by the login function.';

create index if not exists login_events_user_at_idx
  on public.login_events (user_id, at desc);

alter table public.login_events enable row level security;

-- Reading only, and only your own — or everyone's, as an administrator.
-- Rows are written by the login function, which runs as the service role.
drop policy if exists "Own sign-ins, or a super admin's view" on public.login_events;
create policy "Own sign-ins, or a super admin's view"
  on public.login_events for select
  using (auth.uid() = user_id or public.is_super_admin(auth.uid()));

/* --------------------------------------------------------------------------
   3. Our claims inside Supabase's token

   Runs each time an access token is minted — at sign-in and at every refresh.
   Two claims, both read from `profiles`, which is where this application's
   idea of a person lives:

     app_role       what this app lets them do. Nothing to do with any role
                    Nexus may have; that system's administrators are not this
                    system's administrators.
     nexus_user_id  who they are upstream.

   Deliberately not here: the device. A token is refreshed for hours without
   anyone signing in again, so a device baked into it would go stale and start
   lying. The app learns its device id from the login response and writes it on
   the rows it files.
   -------------------------------------------------------------------------- */

create or replace function public.custom_access_token(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  found  record;
begin
  select p.role::text as role, p.nexus_user_id
    into found
    from public.profiles p
   where p.id = (event ->> 'user_id')::uuid;

  -- Least privilege on a miss. A profile that cannot be read is not a reason
  -- to hand somebody an administrator's token.
  claims := jsonb_set(claims, '{app_role}', to_jsonb(coalesce(found.role, 'user')));

  claims := jsonb_set(
    claims,
    '{nexus_user_id}',
    coalesce(to_jsonb(found.nexus_user_id), 'null'::jsonb)
  );

  return jsonb_set(event, '{claims}', claims);
end;
$$;

comment on function public.custom_access_token is
  'Custom Access Token hook. Adds app_role and nexus_user_id to every access token.';

/*
 * The hook runs as `supabase_auth_admin`, a role that has nothing in `public`
 * by default — and row level security still applies to it, so the grant alone
 * is not enough to read a profile.
 */
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token(jsonb) to supabase_auth_admin;
grant select on public.profiles to supabase_auth_admin;

drop policy if exists "The token hook may read profiles" on public.profiles;
create policy "The token hook may read profiles"
  on public.profiles for select
  to supabase_auth_admin
  using (true);

-- Nobody else may call it. It is not an API; it is something GoTrue invokes.
revoke execute on function public.custom_access_token(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- After running this: Dashboard → Authentication → Hooks →
--   "Customize Access Token (JWT) Claims" → enable → public.custom_access_token
--
-- Nothing takes effect until that switch is on.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Check
--
--   select proname from pg_proc where proname = 'custom_access_token';
--
--   -- and after signing in, decode the access token: it must contain
--   --   "app_role": "super_admin"  and  "nexus_user_id": "329d3eb4-…"
-- ---------------------------------------------------------------------------
