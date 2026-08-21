-- ---------------------------------------------------------------------------
-- How much was done in each window
--
-- One row per interval per person: key presses, clicks, scrolls, and the
-- seconds inside the window that counted as active. Together they turn "this
-- window was active" into "this window was worked steadily" or "barely
-- touched".
--
-- Counts only. No key codes, no coordinates, nothing from which anything typed
-- could be reconstructed — the columns below are the entire record, and they
-- are all integers.
-- ---------------------------------------------------------------------------

create table if not exists public.activity_intervals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  started_at timestamptz not null,
  ended_at timestamptz not null,

  key_presses integer not null default 0,
  mouse_clicks integer not null default 0,
  scrolls integer not null default 0,
  active_seconds integer not null default 0,

  /*
   * Null when this machine could not count at all — macOS with Input
   * Monitoring refused, or a Wayland session where no global hook exists.
   *
   * Deliberately not zero. A window nobody touched and a window nobody could
   * measure are different facts, and reading them as the same one would make
   * an unmeasurable machine look like an idle person.
   */
  input_available boolean,

  created_at timestamptz not null default now(),

  constraint activity_intervals_span_check check (ended_at > started_at)
);

comment on table public.activity_intervals is
  'Per-window input counts. Integers only — never what was typed.';

create index if not exists activity_intervals_user_started_idx
  on public.activity_intervals (user_id, started_at);

-- Retrying an upload must not double a window's counts.
create unique index if not exists activity_intervals_unique
  on public.activity_intervals (user_id, started_at);

/* --------------------------------------------------------------------------
   Row level security — the same shape as the other two tables.
   -------------------------------------------------------------------------- */

alter table public.activity_intervals enable row level security;

drop policy if exists "Own intervals, or a super admin's view" on public.activity_intervals;
create policy "Own intervals, or a super admin's view"
  on public.activity_intervals for select
  using (auth.uid() = user_id or public.is_super_admin(auth.uid()));

drop policy if exists "A machine files its own intervals" on public.activity_intervals;
create policy "A machine files its own intervals"
  on public.activity_intervals for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Check
--
--   select count(*) from public.activity_intervals;
-- ---------------------------------------------------------------------------
