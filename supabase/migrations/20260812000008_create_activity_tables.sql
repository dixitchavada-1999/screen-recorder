-- ---------------------------------------------------------------------------
-- Where a tracked day is recorded
--
-- Two tables and one storage bucket. Images never go in the database — the
-- bucket holds those and the row holds the path, which is what keeps a month of
-- captures from turning every query into a download.
--
-- Both tables carry the machine's own idea of when things happened, not the
-- server's. A laptop that was offline all afternoon uploads that afternoon
-- later, and it has to land in the afternoon it belongs to.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   Activity segments
   -------------------------------------------------------------------------- */

create table if not exists public.activity_segments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  started_at timestamptz not null,
  ended_at timestamptz not null,
  state text not null check (state in ('active', 'idle')),

  created_at timestamptz not null default now(),

  -- A stretch that ends before it starts is a clock that moved, not a fact.
  constraint activity_segments_span_check check (ended_at > started_at)
);

comment on table public.activity_segments is
  'Stretches of active or idle time, as reported by a tracked machine.';

-- Every read is "this person, this day", in that order.
create index if not exists activity_segments_user_started_idx
  on public.activity_segments (user_id, started_at);

/*
 * Uploading the same file twice must not double the day.
 *
 * The uploader deletes its local copy only after the server confirms, so a
 * crash in between means a retry — and this is what makes that retry harmless.
 */
create unique index if not exists activity_segments_unique
  on public.activity_segments (user_id, started_at, state);

/* --------------------------------------------------------------------------
   Screenshots
   -------------------------------------------------------------------------- */

create table if not exists public.screenshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,

  captured_at timestamptz not null,
  -- Path inside the `screenshots` bucket. The image itself is never here.
  storage_path text not null,

  width integer,
  height integer,
  bytes integer,

  created_at timestamptz not null default now()
);

comment on table public.screenshots is
  'One row per capture. The image lives in the screenshots storage bucket.';

create index if not exists screenshots_user_captured_idx
  on public.screenshots (user_id, captured_at);

-- The capture time is the identity: one machine cannot take two pictures at the
-- same millisecond, and a retry of the same upload lands on the same row.
create unique index if not exists screenshots_unique
  on public.screenshots (user_id, captured_at);

/* --------------------------------------------------------------------------
   Row level security

   The same shape as everything else here: your own rows, plus a super admin's
   view of everybody. Nobody may edit a record of their own day after the fact —
   there is no update policy at all, deliberately.
   -------------------------------------------------------------------------- */

alter table public.activity_segments enable row level security;
alter table public.screenshots enable row level security;

drop policy if exists "Own segments, or a super admin's view" on public.activity_segments;
create policy "Own segments, or a super admin's view"
  on public.activity_segments for select
  using (auth.uid() = user_id or public.is_super_admin(auth.uid()));

drop policy if exists "A machine files its own segments" on public.activity_segments;
create policy "A machine files its own segments"
  on public.activity_segments for insert
  with check (auth.uid() = user_id);

drop policy if exists "Own screenshots, or a super admin's view" on public.screenshots;
create policy "Own screenshots, or a super admin's view"
  on public.screenshots for select
  using (auth.uid() = user_id or public.is_super_admin(auth.uid()));

drop policy if exists "A machine files its own screenshots" on public.screenshots;
create policy "A machine files its own screenshots"
  on public.screenshots for insert
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- The bucket is not created here
--
-- `storage.buckets` belongs to `supabase_storage_admin`, and the SQL editor
-- runs as `postgres`, so inserting into it fails with "must be owner of table
-- buckets" — and takes the whole transaction, tables included, down with it.
--
-- Make it once in the dashboard instead: Storage → New bucket → name
-- `screenshots`, public **off**. Its policies are in the file alongside this
-- one, which is run afterwards.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Check
--
--   select count(*) from public.activity_segments;
--   select count(*) from public.screenshots;
-- ---------------------------------------------------------------------------
