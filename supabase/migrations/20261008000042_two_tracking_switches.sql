-- ---------------------------------------------------------------------------
-- Two switches: Activity and Screenshots, independent of each other
--
-- There were four — tracking, screenshots, apps, browser — with everything
-- hanging off tracking. What is wanted is two:
--
--   Activity     everything about how the machine is used: active and idle
--                time, key and click counts, applications, browser tabs.
--   Screenshots  pictures of the screen, and nothing else.
--
-- Either can be on without the other. `tracking_enabled` is Activity;
-- `apps_enabled` and `browser_enabled` stay as columns but now simply follow
-- it, so a machine still running the previous build reads the right answer.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The guard: screenshots no longer switch off with Activity, and the
      two followers are kept equal to it
   -------------------------------------------------------------------------- */

create or replace function public.guard_tracking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.tracking_enabled is distinct from old.tracking_enabled
      or new.screenshots_enabled is distinct from old.screenshots_enabled
      or new.apps_enabled is distinct from old.apps_enabled
      or new.browser_enabled is distinct from old.browser_enabled)
     and auth.uid() is not null
     and not public.has_permission(auth.uid(), 'team.manage') then
    raise exception 'You do not have permission to change the tracking policy'
      using errcode = 'insufficient_privilege';
  end if;

  -- Activity means all of it.
  new.apps_enabled := new.tracking_enabled;
  new.browser_enabled := new.tracking_enabled;

  return new;
end;
$$;

-- Bring every existing row into line: whoever has Activity on gets all of it.
update public.profiles
   set apps_enabled = tracking_enabled,
       browser_enabled = tracking_enabled
 where apps_enabled is distinct from tracking_enabled
    or browser_enabled is distinct from tracking_enabled;

/* --------------------------------------------------------------------------
   2. What the app asks
   -------------------------------------------------------------------------- */

create or replace function public.my_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'active', public.is_active_person(auth.uid()),
    'tracking_enabled', coalesce(p.tracking_enabled, false),
    -- On its own now: screenshots can run with Activity off.
    'screenshots_enabled', coalesce(p.screenshots_enabled, false),
    'apps_enabled', coalesce(p.tracking_enabled, false),
    'browser_enabled', coalesce(p.tracking_enabled, false),
    'screenshot_interval_minutes', s.screenshot_interval_minutes,
    'idle_after_seconds', s.idle_after_seconds,
    'excluded_domains', coalesce(to_jsonb(s.excluded_domains), '[]'::jsonb)
  )
    from public.profiles p
    left join public.tracking_schedule s on s.id
   where p.id = auth.uid()
$$;

grant execute on function public.my_status() to authenticated;

/* --------------------------------------------------------------------------
   Check after applying

     select tracking_enabled, screenshots_enabled, apps_enabled, browser_enabled
       from public.profiles;
   -------------------------------------------------------------------------- */
