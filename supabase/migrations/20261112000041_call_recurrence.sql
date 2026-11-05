-- ---------------------------------------------------------------------------
-- Recurring calls
--
-- A recurring call is materialised, not computed: each occurrence is a real
-- `scheduled_calls` row, so reminders, status, missed-marking and assignees all
-- keep working per row with no special case. The rows of one series share a
-- `series_id`, and the rule that made them lives in `call_series` so the series
-- can be extended (a "never"-ending rule rolls forward over time) and edited or
-- deleted as a whole.
--
-- The occurrence dates themselves are worked out in the app (the recurrence
-- maths is intricate and shared with the picker's preview); the functions here
-- only take a list of start times and write the rows atomically, under row
-- level security, so a half-created series can never be left behind.
-- ---------------------------------------------------------------------------

create table if not exists public.call_series (
  id uuid primary key default gen_random_uuid(),

  -- Who arranged the series. Every occurrence row carries the same owner.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- The template each occurrence is stamped from.
  title text not null check (length(btrim(title)) between 1 and 200),
  duration_minutes integer not null default 30 check (duration_minutes between 1 and 1440),
  notes text check (notes is null or length(notes) <= 2000),

  -- The recurrence rule (frequency, interval, weekdays, end) as the app models it.
  rule jsonb not null,
  -- The first occurrence's start — the rule's anchor.
  anchor_at timestamptz not null,
  -- Who the occurrences are for: [{ "nexus_id": "...", "is_primary": true }, ...].
  assignees jsonb not null default '[]'::jsonb,

  -- How far occurrences have been generated. The roll-forward extends from here.
  generated_until timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.call_series is
  'The rule behind a set of recurring scheduled_calls. Occurrences are real rows keyed by series_id.';

alter table public.scheduled_calls
  add column if not exists series_id uuid references public.call_series (id) on delete cascade;

create index if not exists scheduled_calls_series_idx
  on public.scheduled_calls (series_id, starts_at);

/* --------------------------------------------------------------------------
   Row level security — a series is its owner's, same as a call.
   -------------------------------------------------------------------------- */

alter table public.call_series enable row level security;

drop policy if exists "Own series are viewable" on public.call_series;
create policy "Own series are viewable"
  on public.call_series for select using (auth.uid() = user_id);

drop policy if exists "Own series are updatable" on public.call_series;
create policy "Own series are updatable"
  on public.call_series for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Own series are deletable" on public.call_series;
create policy "Own series are deletable"
  on public.call_series for delete using (auth.uid() = user_id);

drop trigger if exists call_series_touch_updated_at on public.call_series;
create trigger call_series_touch_updated_at
  before update on public.call_series
  for each row execute function public.touch_updated_at();

/* --------------------------------------------------------------------------
   Create a series and its first batch of occurrences, in one transaction.

   Runs as definer but files everything under auth.uid(), so a caller can only
   ever create a series for themselves — the same boundary the table policies
   draw. Each occurrence gets the same assignees; the first assignee is primary.
   Returns the new series id.
   -------------------------------------------------------------------------- */

create or replace function public.create_call_series(
  p_title text,
  p_duration_minutes integer,
  p_notes text,
  p_rule jsonb,
  p_anchor timestamptz,
  p_assignees jsonb,
  p_occurrences timestamptz[],
  p_generated_until timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_series uuid;
  v_call uuid;
  v_start timestamptz;
  v_assignee jsonb;
  v_idx integer;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if coalesce(array_length(p_occurrences, 1), 0) = 0 then
    raise exception 'a recurring call needs at least one occurrence';
  end if;

  insert into public.call_series (
    user_id, title, duration_minutes, notes, rule, anchor_at, assignees, generated_until
  ) values (
    v_uid, btrim(p_title), p_duration_minutes, nullif(btrim(coalesce(p_notes, '')), ''),
    p_rule, p_anchor, coalesce(p_assignees, '[]'::jsonb), p_generated_until
  )
  returning id into v_series;

  foreach v_start in array p_occurrences loop
    insert into public.scheduled_calls (user_id, title, starts_at, duration_minutes, notes, series_id)
    values (v_uid, btrim(p_title), v_start, p_duration_minutes,
            nullif(btrim(coalesce(p_notes, '')), ''), v_series)
    returning id into v_call;

    v_idx := 0;
    for v_assignee in select * from jsonb_array_elements(coalesce(p_assignees, '[]'::jsonb)) loop
      insert into public.scheduled_call_assignees (call_id, nexus_id, is_primary)
      values (v_call, (v_assignee->>'nexus_id')::uuid, coalesce((v_assignee->>'is_primary')::boolean, v_idx = 0));
      v_idx := v_idx + 1;
    end loop;
  end loop;

  return v_series;
end;
$$;

/* --------------------------------------------------------------------------
   Extend a series forward with more occurrences (the roll-forward).

   Only the owner's series, and only occurrences after what exists — a start
   that already has a row is skipped, so a double extend cannot duplicate. Bumps
   generated_until. Returns how many rows were added.
   -------------------------------------------------------------------------- */

create or replace function public.extend_call_series(
  p_series uuid,
  p_occurrences timestamptz[],
  p_generated_until timestamptz
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_series public.call_series;
  v_call uuid;
  v_start timestamptz;
  v_assignee jsonb;
  v_idx integer;
  v_added integer := 0;
begin
  select * into v_series from public.call_series where id = p_series and user_id = v_uid;
  if not found then
    raise exception 'unknown series' using errcode = '42501';
  end if;

  foreach v_start in array coalesce(p_occurrences, '{}'::timestamptz[]) loop
    if exists (select 1 from public.scheduled_calls where series_id = p_series and starts_at = v_start) then
      continue;
    end if;

    insert into public.scheduled_calls (user_id, title, starts_at, duration_minutes, notes, series_id)
    values (v_uid, v_series.title, v_start, v_series.duration_minutes, v_series.notes, p_series)
    returning id into v_call;

    v_idx := 0;
    for v_assignee in select * from jsonb_array_elements(v_series.assignees) loop
      insert into public.scheduled_call_assignees (call_id, nexus_id, is_primary)
      values (v_call, (v_assignee->>'nexus_id')::uuid, coalesce((v_assignee->>'is_primary')::boolean, v_idx = 0));
      v_idx := v_idx + 1;
    end loop;

    v_added := v_added + 1;
  end loop;

  update public.call_series
    set generated_until = greatest(generated_until, p_generated_until)
    where id = p_series;

  return v_added;
end;
$$;

grant execute on function
  public.create_call_series(text, integer, text, jsonb, timestamptz, jsonb, timestamptz[], timestamptz)
  to authenticated;
grant execute on function
  public.extend_call_series(uuid, timestamptz[], timestamptz)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Check
--   select count(*) from public.call_series;
--   select id, title, starts_at, series_id from public.scheduled_calls where series_id is not null
--     order by starts_at limit 10;
-- ---------------------------------------------------------------------------
