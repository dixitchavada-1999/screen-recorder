-- ---------------------------------------------------------------------------
-- Scheduled calls
--
-- The Call Manager's own table. A row is a call the user intends to have — a
-- plan, not a recording. Recordings stay on the local machine and are catalogued
-- there; nothing in this table points at a file.
--
-- Times are `timestamptz`, so a call scheduled in one timezone still lands at
-- the right moment when the laptop travels. The UI converts to local time.
-- ---------------------------------------------------------------------------

create table if not exists public.scheduled_calls (
  id uuid primary key default gen_random_uuid(),

  -- Owner. Deleting the account takes their schedule with it.
  user_id uuid not null references auth.users (id) on delete cascade,

  title text not null check (length(btrim(title)) between 1 and 200),
  starts_at timestamptz not null,

  -- Kept as a duration rather than an end time: the UI edits "30 minutes", and
  -- storing both would leave two facts that can disagree.
  duration_minutes integer not null default 30
    check (duration_minutes between 1 and 1440),

  notes text check (notes is null or length(notes) <= 2000),

  -- Minutes of warning before `starts_at`. Null means no reminder.
  --
  -- The column exists now so the schema does not have to change when reminders
  -- are built; nothing reads it yet, and the UI does not offer the field until
  -- something actually fires.
  remind_minutes_before integer
    check (remind_minutes_before is null or remind_minutes_before between 0 and 10080),

  status text not null default 'scheduled'
    check (status in ('scheduled', 'completed', 'cancelled')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.scheduled_calls is
  'Calls a user has planned. Owned by the Call Manager; unrelated to local recordings.';

-- Every query the app makes is "my calls, in this date range", in that order.
create index if not exists scheduled_calls_user_starts_at_idx
  on public.scheduled_calls (user_id, starts_at);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Unlike profiles, this table is written by the client, so it needs insert and
-- delete policies as well. `with check` on insert is what stops a user from
-- filing a call under somebody else's id.
-- ---------------------------------------------------------------------------

alter table public.scheduled_calls enable row level security;

drop policy if exists "Calls are viewable by their owner" on public.scheduled_calls;
create policy "Calls are viewable by their owner"
  on public.scheduled_calls for select
  using (auth.uid() = user_id);

drop policy if exists "Calls are insertable by their owner" on public.scheduled_calls;
create policy "Calls are insertable by their owner"
  on public.scheduled_calls for insert
  with check (auth.uid() = user_id);

drop policy if exists "Calls are updatable by their owner" on public.scheduled_calls;
create policy "Calls are updatable by their owner"
  on public.scheduled_calls for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Calls are deletable by their owner" on public.scheduled_calls;
create policy "Calls are deletable by their owner"
  on public.scheduled_calls for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Keep updated_at honest
--
-- `public.touch_updated_at()` comes from the profiles migration; this recreates
-- it so either migration can be run first.
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scheduled_calls_touch_updated_at on public.scheduled_calls;
create trigger scheduled_calls_touch_updated_at
  before update on public.scheduled_calls
  for each row execute function public.touch_updated_at();
