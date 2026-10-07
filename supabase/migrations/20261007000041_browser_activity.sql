-- ---------------------------------------------------------------------------
-- Browser activity, from the browser extension
--
-- The window title the application tracker reads says which tab was in front,
-- but not where it was, and it misses anything shown for less than a sample.
-- The extension reports every tab as it is visited: the address, the title,
-- and — when the page is a search — what was searched for.
--
-- A fourth per-person switch, off unless an administrator turns it on, and an
-- organisation-wide list of sites that are never recorded beyond their name and
-- the time spent (a bank, a doctor). The extension applies the list before
-- anything leaves the browser.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The switch
   -------------------------------------------------------------------------- */

alter table public.profiles
  add column if not exists browser_enabled boolean not null default false;

comment on column public.profiles.browser_enabled is
  'Whether browser tabs, addresses and searches are recorded. Ignored when tracking_enabled is false.';

grant update (browser_enabled) on public.profiles to authenticated;

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

  /* Everything else hangs off tracking; with tracking off there is no schedule. */
  if not new.tracking_enabled then
    new.screenshots_enabled := false;
    new.apps_enabled := false;
    new.browser_enabled := false;
  end if;

  return new;
end;
$$;

/* --------------------------------------------------------------------------
   2. Sites that are never recorded in detail
   -------------------------------------------------------------------------- */

alter table public.tracking_schedule
  add column if not exists excluded_domains text[] not null default '{}'
    check (cardinality(excluded_domains) <= 200);

comment on column public.tracking_schedule.excluded_domains is
  'Sites recorded only as "excluded" and the time spent: no address, title or search. Subdomains included.';

grant update (excluded_domains) on public.tracking_schedule to authenticated;

/* --------------------------------------------------------------------------
   3. What the app asks
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
    'browser_enabled', coalesce(p.tracking_enabled and p.browser_enabled, false),
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
   4. The visits
   -------------------------------------------------------------------------- */

create table if not exists public.browser_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  -- "chrome" or "edge".
  browser text not null check (browser in ('chrome', 'edge', 'other')),
  -- The host without "www.", or "newtab" for a new tab page.
  domain text not null check (length(domain) between 1 and 255),
  -- Null for an excluded site.
  url text check (url is null or length(url) <= 2048),
  title text check (title is null or length(title) <= 500),
  -- What was searched for, when the page was a search results page.
  search_query text check (search_query is null or length(search_query) <= 500),
  excluded boolean not null default false,
  created_at timestamptz not null default now(),
  constraint browser_activity_span_check check (ended_at > started_at)
);

comment on table public.browser_activity is
  'Browser tabs as they were visited, from the extension. Never form contents or page text.';

create index if not exists browser_activity_user_started_idx
  on public.browser_activity (user_id, started_at);

create unique index if not exists browser_activity_unique
  on public.browser_activity (user_id, device_id, started_at, browser) nulls not distinct;

alter table public.browser_activity enable row level security;

drop policy if exists "Own browser activity, or a super admin's view" on public.browser_activity;
create policy "Own browser activity, or a super admin's view"
  on public.browser_activity for select
  using (
    public.is_active_person(auth.uid())
    and (auth.uid() = user_id or public.is_super_admin(auth.uid()))
  );

drop policy if exists "A machine files its own browser activity" on public.browser_activity;
create policy "A machine files its own browser activity"
  on public.browser_activity for insert
  with check (auth.uid() = user_id and public.is_active_person(auth.uid()));

grant select, insert on public.browser_activity to authenticated;

/* --------------------------------------------------------------------------
   Check after applying

     select public.my_status();
     select excluded_domains from public.tracking_schedule;
   -------------------------------------------------------------------------- */
