-- ---------------------------------------------------------------------------
-- Devices that are never tracked
--
-- One person can be signed in on several machines with Activity and
-- Screenshots switched on, and still want one of those machines left alone —
-- a home computer, a shared one. A device on this list records nothing, whoever
-- signs in on it and whatever their switches say.
--
-- A device is an installation of the app: the random id it generated the first
-- time it ran (`devices.machine_id`), shown on its Settings screen to be copied.
--
-- Only the people on `device_admins` can see or change the list. That is
-- checked here, in the functions, not by the screen that offers the button.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. Who may manage the list
   -------------------------------------------------------------------------- */

create table if not exists public.device_admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

comment on table public.device_admins is
  'People who may add and remove untracked devices. Changed only here, in SQL.';

alter table public.device_admins enable row level security;
-- No policies: read and written only through the functions below.

insert into public.device_admins (user_id)
select p.id from public.profiles p where lower(p.email) = 'dixit.openmalo@gmail.com'
on conflict do nothing;

create or replace function public.is_device_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.device_admins where user_id = auth.uid())
    and public.is_active_person(auth.uid())
$$;

revoke execute on function public.is_device_admin() from public, anon;
grant execute on function public.is_device_admin() to authenticated;

/* --------------------------------------------------------------------------
   2. The list
   -------------------------------------------------------------------------- */

create table if not exists public.untracked_devices (
  machine_id text primary key check (machine_id ~ '^[0-9a-f-]{36}$'),
  label      text check (label is null or length(label) <= 100),
  added_by   uuid references auth.users (id) on delete set null,
  added_at   timestamptz not null default now()
);

comment on table public.untracked_devices is
  'Installations that record nothing, whoever is signed in. Managed by device_admins.';

alter table public.untracked_devices enable row level security;
-- No policies: the functions below are the only way in.

/*
 * The list, with what is known about each machine from the people who have
 * signed in on it — its name, who used it, when it was last seen.
 */
create or replace function public.list_untracked_devices()
returns table (
  machine_id   text,
  label        text,
  added_at     timestamptz,
  hostname     text,
  platform     text,
  people       text,
  last_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_device_admin() then
    raise exception 'You cannot manage untracked devices' using errcode = 'insufficient_privilege';
  end if;

  return query
  select u.machine_id,
         u.label,
         u.added_at,
         (select d.hostname from public.devices d where d.machine_id = u.machine_id
           order by d.last_seen_at desc limit 1),
         (select d.platform from public.devices d where d.machine_id = u.machine_id
           order by d.last_seen_at desc limit 1),
         (select string_agg(distinct coalesce(nullif(p.full_name, ''), p.email), ', ')
            from public.devices d join public.profiles p on p.id = d.user_id
           where d.machine_id = u.machine_id),
         (select max(d.last_seen_at) from public.devices d where d.machine_id = u.machine_id)
    from public.untracked_devices u
   order by u.added_at desc;
end;
$$;

create or replace function public.add_untracked_device(p_machine text, p_label text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_device_admin() then
    raise exception 'You cannot manage untracked devices' using errcode = 'insufficient_privilege';
  end if;

  insert into public.untracked_devices (machine_id, label, added_by)
  values (lower(btrim(p_machine)), nullif(btrim(p_label), ''), auth.uid())
  on conflict (machine_id) do update set label = excluded.label;
end;
$$;

create or replace function public.remove_untracked_device(p_machine text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_device_admin() then
    raise exception 'You cannot manage untracked devices' using errcode = 'insufficient_privilege';
  end if;

  delete from public.untracked_devices where machine_id = lower(btrim(p_machine));
end;
$$;

revoke execute on function public.list_untracked_devices() from public, anon;
revoke execute on function public.add_untracked_device(text, text) from public, anon;
revoke execute on function public.remove_untracked_device(text) from public, anon;
grant execute on function public.list_untracked_devices() to authenticated;
grant execute on function public.add_untracked_device(text, text) to authenticated;
grant execute on function public.remove_untracked_device(text) to authenticated;

/* --------------------------------------------------------------------------
   3. What the app asks, now told which machine is asking
   -------------------------------------------------------------------------- */

/*
 * Replaced rather than overloaded: two `my_status` functions, one with an
 * optional argument, would leave a call without arguments ambiguous. An older
 * build that sends no machine id gets the default and the answer it always had.
 */
drop function if exists public.my_status();

create or replace function public.my_status(p_machine text default null)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with this_device as (
    select exists (
      select 1 from public.untracked_devices u where u.machine_id = lower(btrim(p_machine))
    ) as untracked
  )
  select jsonb_build_object(
    'active', public.is_active_person(auth.uid()),
    'device_untracked', t.untracked,
    -- On an untracked device every switch reads off.
    'tracking_enabled', coalesce(p.tracking_enabled, false) and not t.untracked,
    'screenshots_enabled', coalesce(p.screenshots_enabled, false) and not t.untracked,
    'apps_enabled', coalesce(p.tracking_enabled, false) and not t.untracked,
    'browser_enabled', coalesce(p.tracking_enabled, false) and not t.untracked,
    'screenshot_interval_minutes', s.screenshot_interval_minutes,
    'idle_after_seconds', s.idle_after_seconds,
    'excluded_domains', coalesce(to_jsonb(s.excluded_domains), '[]'::jsonb)
  )
    from public.profiles p
    cross join this_device t
    left join public.tracking_schedule s on s.id
   where p.id = auth.uid()
$$;

revoke execute on function public.my_status(text) from public, anon;
grant execute on function public.my_status(text) to authenticated;

/* --------------------------------------------------------------------------
   Check after applying

     select * from public.device_admins;   -- one row: dixit.openmalo@gmail.com
   -------------------------------------------------------------------------- */
