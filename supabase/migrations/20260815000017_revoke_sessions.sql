-- ---------------------------------------------------------------------------
-- Banning somebody does not end their session
--
-- The previous migration assumed it did. It does not: a banned account's
-- refresh token still exchanges for a new access token, and because refreshing
-- rotates the token, a session started before the ban runs indefinitely. Tested
-- against this project — ban applied, refresh returned 200 and a fresh hour of
-- access.
--
-- Which made the whole of the leaver work a gesture. Sign-in was already closed
-- to a departed colleague the moment Nexus began answering 403; the session
-- issued last Tuesday was always the thing that needed ending, and the ban did
-- not touch it.
--
-- So the sessions are removed directly. GoTrue keeps them in `auth.sessions`,
-- and deleting a row there takes its refresh tokens with it. That is reaching
-- into another service's storage, which is worth being uncomfortable about —
-- but the alternative is a policy that says people lose access when they leave
-- and an implementation where they do not.
--
-- The ban stays alongside it. The two answer different questions: the ban stops
-- a new sign-in, this stops an old one continuing.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. Ending sessions
   -------------------------------------------------------------------------- */

create or replace function public.revoke_sessions(p_user_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer := 0;
begin
  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return 0;
  end if;

  delete from auth.sessions where user_id = any(p_user_ids);
  get diagnostics removed = row_count;

  /*
   * Older rows can predate session tracking and hang off no session at all, so
   * they would survive the delete above. `auth.refresh_tokens.user_id` is text
   * rather than uuid, which is why the cast is here rather than in the array.
   */
  begin
    delete from auth.refresh_tokens
     where user_id = any (select id::text from unnest(p_user_ids) as id);
  exception
    when undefined_table or insufficient_privilege then
      raise notice 'Could not reach auth.refresh_tokens; sessions removed anyway';
  end;

  return removed;
end;
$$;

comment on function public.revoke_sessions is
  'Ends every session belonging to the given accounts. Used when somebody leaves.';

revoke execute on function public.revoke_sessions(uuid[]) from public, anon, authenticated;

/* --------------------------------------------------------------------------
   2. The sync does it as part of the same transaction

   Tracking off, sessions gone, roster updated — one statement. Anything less
   leaves a window where the list says somebody has left and their machine is
   still filing screenshots.
   -------------------------------------------------------------------------- */

drop function if exists public.sync_nexus_roster(jsonb);

create or replace function public.sync_nexus_roster(p_users jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  seen     integer;
  departed jsonb;
  returned jsonb;
  revoked  integer := 0;
begin
  create temporary table _roster (nexus_id uuid primary key, name text) on commit drop;

  insert into _roster (nexus_id, name)
  select (entry ->> 'id')::uuid,
         coalesce(nullif(trim(entry ->> 'name'), ''), '(unnamed)')
    from jsonb_array_elements(coalesce(p_users, '[]'::jsonb)) entry
   where entry ->> 'id' is not null
  on conflict (nexus_id) do nothing;

  select count(*) into seen from _roster;

  -- A partner API having a bad minute must not be able to retire the company.
  if seen = 0 then
    raise exception 'Refusing to apply an empty roster'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(
           jsonb_agg(jsonb_build_object('nexus_id', u.nexus_id, 'user_id', p.id, 'name', u.name)),
           '[]'::jsonb
         )
    into departed
    from public.nexus_users u
    left join public.profiles p on p.nexus_user_id = u.nexus_id
   where u.active
     and not exists (select 1 from _roster r where r.nexus_id = u.nexus_id);

  select coalesce(
           jsonb_agg(jsonb_build_object('nexus_id', u.nexus_id, 'user_id', p.id, 'name', u.name)),
           '[]'::jsonb
         )
    into returned
    from public.nexus_users u
    left join public.profiles p on p.nexus_user_id = u.nexus_id
   where not u.active
     and exists (select 1 from _roster r where r.nexus_id = u.nexus_id);

  insert into public.nexus_users (nexus_id, name, active, last_seen_at)
  select nexus_id, name, true, now() from _roster
  on conflict (nexus_id) do update
     set name = excluded.name, active = true, last_seen_at = now();

  update public.nexus_users u
     set active = false
   where u.active
     and not exists (select 1 from _roster r where r.nexus_id = u.nexus_id);

  update public.profiles p
     set tracking_enabled = false,
         screenshots_enabled = false
   where p.nexus_user_id in (
           select (entry ->> 'nexus_id')::uuid from jsonb_array_elements(departed) entry
         )
     and (p.tracking_enabled or p.screenshots_enabled);

  -- And the part the ban never did.
  select public.revoke_sessions(
           array(
             select (entry ->> 'user_id')::uuid
               from jsonb_array_elements(departed) entry
              where entry ->> 'user_id' is not null
           )
         )
    into revoked;

  return jsonb_build_object(
    'seen', seen,
    'departed', departed,
    'returned', returned,
    'revoked', revoked
  );
end;
$$;

revoke execute on function public.sync_nexus_roster(jsonb) from public, anon, authenticated;

alter table public.nexus_roster_state
  add column if not exists last_revoked integer;

-- ---------------------------------------------------------------------------
-- Check
--
--   -- ends every session for one account; its refresh token must then fail
--   select public.revoke_sessions(array['<a profile id>'::uuid]);
--
--   select * from public.nexus_roster_state;
-- ---------------------------------------------------------------------------
