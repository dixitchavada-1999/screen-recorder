-- ---------------------------------------------------------------------------
-- Tracking schedule on the server, and which applications were in use
--
-- Two things, both about what a tracked machine does:
--
-- 1. How often a screenshot is taken and when a machine counts as idle used to
--    be local settings. The Team screen offered to change them, but what it
--    changed was the administrator's own machine — everybody else kept their
--    own numbers. They now live in one row here, read by every machine with the
--    rest of its policy.
--
-- 2. Which application was in front, and the title of its window. Off unless an
--    administrator switches it on for a person, like screenshots. Only the
--    application's name and window titles are kept — never what was typed and
--    never the contents of a page.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The schedule, one row for the whole organisation
   -------------------------------------------------------------------------- */

create table if not exists public.tracking_schedule (
  id boolean primary key default true check (id),
  screenshot_interval_minutes integer not null default 10
    check (screenshot_interval_minutes between 1 and 240),
  idle_after_seconds integer not null default 300
    check (idle_after_seconds between 30 and 3600),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.tracking_schedule is
  'How often tracked machines take a screenshot and when they count as idle. One row.';

insert into public.tracking_schedule (id) values (true) on conflict (id) do nothing;

alter table public.tracking_schedule enable row level security;

-- Everybody tracked is entitled to know the schedule they are tracked on.
drop policy if exists "Anyone signed in reads the schedule" on public.tracking_schedule;
create policy "Anyone signed in reads the schedule"
  on public.tracking_schedule for select
  to authenticated
  using (public.is_active_person(auth.uid()));

drop policy if exists "Team managers change the schedule" on public.tracking_schedule;
create policy "Team managers change the schedule"
  on public.tracking_schedule for update
  to authenticated
  using (public.has_permission(auth.uid(), 'team.manage'))
  with check (public.has_permission(auth.uid(), 'team.manage'));

grant select on public.tracking_schedule to authenticated;
grant update (screenshot_interval_minutes, idle_after_seconds) on public.tracking_schedule to authenticated;

create or replace function public.stamp_tracking_schedule()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists tracking_schedule_stamp on public.tracking_schedule;
create trigger tracking_schedule_stamp
  before update on public.tracking_schedule
  for each row execute function public.stamp_tracking_schedule();

/* --------------------------------------------------------------------------
   2. The per-person switch for applications
   -------------------------------------------------------------------------- */

alter table public.profiles
  add column if not exists apps_enabled boolean not null default false;

comment on column public.profiles.apps_enabled is
  'Whether the application in front and its window title are recorded. Ignored when tracking_enabled is false.';

grant update (apps_enabled) on public.profiles to authenticated;

/*
 * The same guard as the other two switches, now covering the third.
 *
 * Restated whole because a trigger function cannot be extended in place. The
 * body is the one from module_permissions with `apps_enabled` added.
 */
create or replace function public.guard_tracking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.tracking_enabled is distinct from old.tracking_enabled
      or new.screenshots_enabled is distinct from old.screenshots_enabled
      or new.apps_enabled is distinct from old.apps_enabled)
     and auth.uid() is not null
     and not public.has_permission(auth.uid(), 'team.manage') then
    raise exception 'You do not have permission to change the tracking policy'
      using errcode = 'insufficient_privilege';
  end if;

  /* Screenshots and applications hang off tracking; with tracking off there is no schedule. */
  if not new.tracking_enabled then
    new.screenshots_enabled := false;
    new.apps_enabled := false;
  end if;

  return new;
end;
$$;

/* --------------------------------------------------------------------------
   3. What the app asks, now with the schedule and the third switch
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
    'screenshots_enabled', coalesce(p.tracking_enabled and p.screenshots_enabled, false),
    'apps_enabled', coalesce(p.tracking_enabled and p.apps_enabled, false),
    'screenshot_interval_minutes', s.screenshot_interval_minutes,
    'idle_after_seconds', s.idle_after_seconds
  )
    from public.profiles p
    left join public.tracking_schedule s on s.id
   where p.id = auth.uid()
$$;

grant execute on function public.my_status() to authenticated;

/* --------------------------------------------------------------------------
   4. Applications in use
   -------------------------------------------------------------------------- */

create table if not exists public.app_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  -- The application, as the operating system names it: "Google Chrome", "Code".
  app_name text not null check (length(app_name) between 1 and 200),
  /*
   * The window titles seen during the stretch, with seconds on each:
   * [{ "title": "...", "seconds": 120 }]. At most a handful, longest first.
   * Titles of private browsing windows never arrive here — the app replaces
   * them before writing anything.
   */
  titles jsonb not null default '[]'::jsonb check (jsonb_typeof(titles) = 'array'),
  created_at timestamptz not null default now(),
  constraint app_usage_span_check check (ended_at > started_at)
);

comment on table public.app_usage is
  'Which application was in front, in stretches, with its window titles. Never what was typed.';

create index if not exists app_usage_user_started_idx
  on public.app_usage (user_id, started_at);

-- A retried upload must not double the day; same shape as the other tables.
create unique index if not exists app_usage_unique
  on public.app_usage (user_id, device_id, started_at) nulls not distinct;

alter table public.app_usage enable row level security;

drop policy if exists "Own app usage, or a super admin's view" on public.app_usage;
create policy "Own app usage, or a super admin's view"
  on public.app_usage for select
  using (
    public.is_active_person(auth.uid())
    and (auth.uid() = user_id or public.is_super_admin(auth.uid()))
  );

drop policy if exists "A machine files its own app usage" on public.app_usage;
create policy "A machine files its own app usage"
  on public.app_usage for insert
  with check (auth.uid() = user_id and public.is_active_person(auth.uid()));

grant select, insert on public.app_usage to authenticated;

/* --------------------------------------------------------------------------
   Check after applying

     select * from public.tracking_schedule;
     select public.my_status();
   -------------------------------------------------------------------------- */
