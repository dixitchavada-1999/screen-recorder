-- ---------------------------------------------------------------------------
-- Somebody leaving has to mean something
--
-- The roster already knows: a person who stops appearing in Nexus's staff list
-- is marked inactive here. Nothing read that. Their session stayed valid, they
-- kept appearing in pickers, and their machine kept taking screenshots — which
-- makes the tracking policy a statement of intent rather than a fact.
--
-- So the sync function stops counting and starts reporting. It returns who has
-- just gone and who has just come back, switches tracking off for the ones who
-- have gone, and leaves the rest to the function in front of it: ending a
-- session is an auth operation, not a SQL one.
--
-- Coming back does *not* switch tracking on again. Being employed here is
-- Nexus's answer; being tracked is an administrator's, and it is not restored
-- by the side effect of somebody being rehired.
-- ---------------------------------------------------------------------------

-- The return type changes, and Postgres will not replace a function across
-- that, so the old one goes first.
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
begin
  create temporary table _roster (nexus_id uuid primary key, name text) on commit drop;

  insert into _roster (nexus_id, name)
  select (entry ->> 'id')::uuid,
         coalesce(nullif(trim(entry ->> 'name'), ''), '(unnamed)')
    from jsonb_array_elements(coalesce(p_users, '[]'::jsonb)) entry
   where entry ->> 'id' is not null
  on conflict (nexus_id) do nothing;

  select count(*) into seen from _roster;

  /*
   * An empty list is refused, not applied.
   *
   * The partner API having a bad minute must not be able to retire the whole
   * company — which, now that leaving switches tracking off and ends sessions,
   * would lock every single person out at once.
   */
  if seen = 0 then
    raise exception 'Refusing to apply an empty roster'
      using errcode = 'invalid_parameter_value';
  end if;

  /* ---------------- Work out who moved, before moving them --------------- */

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

  /* ------------------------------ Apply it ------------------------------- */

  insert into public.nexus_users (nexus_id, name, active, last_seen_at)
  select nexus_id, name, true, now() from _roster
  on conflict (nexus_id) do update
     set name = excluded.name, active = true, last_seen_at = now();

  -- The row stays: calls point at it, and what happened still happened.
  update public.nexus_users u
     set active = false
   where u.active
     and not exists (select 1 from _roster r where r.nexus_id = u.nexus_id);

  /*
   * Nothing is recorded about somebody who no longer works here.
   *
   * Done in the same statement as the roster itself so there is no window where
   * the list says they have gone and their machine is still capturing.
   */
  update public.profiles p
     set tracking_enabled = false,
         screenshots_enabled = false
   where p.nexus_user_id in (
           select (entry ->> 'nexus_id')::uuid from jsonb_array_elements(departed) entry
         )
     and (p.tracking_enabled or p.screenshots_enabled);

  return jsonb_build_object('seen', seen, 'departed', departed, 'returned', returned);
end;
$$;

revoke execute on function public.sync_nexus_roster(jsonb) from public, anon, authenticated;

/* --------------------------------------------------------------------------
   Room to record what was done

   A count of how many people the last sync retired. Small, but it is the
   difference between "the roster ran" and "the roster ran and turned four
   people off", which is the sort of thing somebody will one day need to
   explain.
   -------------------------------------------------------------------------- */

alter table public.nexus_roster_state
  add column if not exists last_departed integer,
  add column if not exists last_returned integer;

-- ---------------------------------------------------------------------------
-- Check
--
--   select * from public.nexus_roster_state;
--   select name, active from public.nexus_users where not active;
--   select email, tracking_enabled from public.profiles;
-- ---------------------------------------------------------------------------
