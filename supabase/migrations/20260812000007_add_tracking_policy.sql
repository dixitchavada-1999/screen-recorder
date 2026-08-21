-- ---------------------------------------------------------------------------
-- Tracking policy, per person
--
-- Both switches move from the machine to the account. A setting stored locally
-- is the tracked person's to change and invisible to everyone else, which makes
-- it useless as a policy: an administrator cannot turn tracking on for somebody
-- else's laptop, and cannot tell whether it is on.
--
-- Two booleans rather than one, because they answer different questions:
-- whether this person's time is recorded at all, and whether their screen is
-- photographed while it is. Screenshots without tracking is not a state that
-- makes sense, so the app treats the second as conditional on the first.
--
-- Both default to false. Deploying this changes nothing about anybody until
-- somebody deliberately switches it on.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists tracking_enabled boolean not null default false,
  add column if not exists screenshots_enabled boolean not null default false;

comment on column public.profiles.tracking_enabled is
  'Whether this person''s machine records activity. Set by a super admin.';

comment on column public.profiles.screenshots_enabled is
  'Whether screenshots are taken while tracking runs. Ignored when tracking_enabled is false.';

-- ---------------------------------------------------------------------------
-- Who may change them
--
-- The same shape the `role` column already uses: UPDATE is granted column by
-- column, so a crafted PATCH cannot reach a column that was never granted.
-- Adding these two to the grant would let anybody switch off their own
-- tracking, so they are deliberately left out — only the service role and the
-- SQL editor can write them directly, and the policy below is what lets a
-- super admin do it through the app.
-- ---------------------------------------------------------------------------

drop policy if exists "Super admins can set the tracking policy" on public.profiles;
create policy "Super admins can set the tracking policy"
  on public.profiles for update
  using (public.is_super_admin(auth.uid()))
  with check (public.is_super_admin(auth.uid()));

-- The grant has to name the columns as well; the policy decides *which rows*,
-- never *which columns*.
grant update (tracking_enabled, screenshots_enabled) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Who may read them
--
-- Everybody reads their own profile already, which is how a machine learns
-- what it is meant to be doing. A super admin reads everyone's, which is what
-- the admin panel lists.
-- ---------------------------------------------------------------------------

drop policy if exists "Super admins can read every profile" on public.profiles;
create policy "Super admins can read every profile"
  on public.profiles for select
  using (auth.uid() = id or public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Check
--
--   select email, role, tracking_enabled, screenshots_enabled
--     from public.profiles order by email;
-- ---------------------------------------------------------------------------
