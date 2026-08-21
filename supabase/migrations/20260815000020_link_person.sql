-- ---------------------------------------------------------------------------
-- Making somebody's first Nexus sign-in put their own house in order
--
-- Two things go wrong for a person the first time they sign in this way, and
-- both look like the application losing their data.
--
-- Their calls have nobody on them. Every call in the database predates
-- assignment and belongs to whoever typed it; the migration could only attach
-- the ones whose owner already had a Nexus id, which at the time was one
-- person. Everybody else opens the Call Manager to an empty week.
--
-- And somebody who joined the company today is in Nexus's roster but not yet in
-- our copy of it, which is refreshed once a day. Until it is, they cannot be
-- assigned a call at all — the foreign key has nothing to point at.
--
-- Both are fixed at the one moment we have just been told, authoritatively, who
-- this person is.
-- ---------------------------------------------------------------------------

create or replace function public.link_person(
  p_user uuid,
  p_nexus uuid,
  p_name text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  repaired integer := 0;
begin
  /*
   * Nexus has just answered for this person, so they work there — which makes
   * this the earliest and most reliable moment to know it. A daily roster pull
   * would find out eventually; somebody joining this morning should not have to
   * wait for it.
   *
   * `active = true` matters as much as the insert: this is also the path back
   * for somebody who left and was rehired.
   */
  insert into public.nexus_users (nexus_id, name, active, last_seen_at)
  values (p_nexus, coalesce(nullif(trim(p_name), ''), '(unnamed)'), true, now())
  on conflict (nexus_id) do update
     set name = excluded.name, active = true, last_seen_at = now();

  /*
   * Calls they arranged before any of this existed, which are on nobody's
   * schedule because assignment had not been invented yet.
   *
   * Only calls with no assignees at all. A call somebody deliberately scheduled
   * for other people is not missing anything, and adding its author to it would
   * put a meeting in the diary of somebody who is not going.
   */
  insert into public.scheduled_call_assignees (call_id, nexus_id, is_primary)
  select c.id, p_nexus, true
    from public.scheduled_calls c
   where c.user_id = p_user
     and not exists (
       select 1 from public.scheduled_call_assignees a where a.call_id = c.id
     )
  on conflict do nothing;

  get diagnostics repaired = row_count;
  return repaired;
end;
$$;

comment on function public.link_person is
  'Called at sign-in: records the person in the roster and adopts their orphaned calls.';

revoke execute on function public.link_person(uuid, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check
--
--   -- calls nobody is on. Should empty out as people sign in.
--   select count(*) from public.scheduled_calls c
--    where not exists (select 1 from public.scheduled_call_assignees a
--                       where a.call_id = c.id);
-- ---------------------------------------------------------------------------
