-- ---------------------------------------------------------------------------
-- A session that outlives the job stops being worth anything
--
-- Two attempts at ending a departed colleague's session both failed against
-- this project: banning the account left the refresh token working, and
-- deleting the `auth.sessions` row left it working too. Rather than keep
-- guessing at another service's internals, this stops trying.
--
-- The token stays valid. What changes is that it stops carrying any authority:
-- somebody who no longer appears in Nexus's roster can read nothing, write
-- nothing, and upload nothing. Their app finds a policy that says do not
-- record, and every query it makes comes back empty.
--
-- That is a better boundary than the one it replaces, because it is checked on
-- every single statement by the database rather than once at the door — and
-- because it is ours. It does not depend on how GoTrue happens to store
-- sessions this month.
--
-- Their own profile row stays readable, deliberately. The app has to be able to
-- learn that this has happened, say so, and sign itself out; a person who
-- cannot even read their own row just sees an application that has broken.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. Does this person still work there?
   -------------------------------------------------------------------------- */

create or replace function public.is_active_person(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  /*
   * Denied only on evidence.
   *
   * Written as "not known to have left" rather than "known to be here" on
   * purpose: an account with no Nexus link yet — one that predates all of this
   * and has not signed in since — is unknown, not departed, and locking it out
   * would be a worse mistake than the one this is preventing. The link is made
   * at every sign-in, so unknown is a short-lived state.
   */
  select not exists (
    select 1
      from public.profiles p
      join public.nexus_users n on n.nexus_id = p.nexus_user_id
     where p.id = uid
       and not n.active
  )
$$;

comment on function public.is_active_person is
  'False once somebody has stopped appearing in Nexus''s roster. Null links count as active.';

grant execute on function public.is_active_person(uuid) to anon, authenticated;

/* --------------------------------------------------------------------------
   2. Nothing more gets recorded about them

   The important half. A leaver's machine may keep running for days before
   anybody collects it, and everything it files after their last day is a
   recording nobody has any business making.
   -------------------------------------------------------------------------- */

drop policy if exists "A machine files its own segments" on public.activity_segments;
create policy "A machine files its own segments"
  on public.activity_segments for insert
  with check (auth.uid() = user_id and public.is_active_person(auth.uid()));

drop policy if exists "A machine files its own intervals" on public.activity_intervals;
create policy "A machine files its own intervals"
  on public.activity_intervals for insert
  with check (auth.uid() = user_id and public.is_active_person(auth.uid()));

drop policy if exists "A machine files its own screenshots" on public.screenshots;
create policy "A machine files its own screenshots"
  on public.screenshots for insert
  with check (auth.uid() = user_id and public.is_active_person(auth.uid()));

drop policy if exists "Upload into your own folder" on storage.objects;
create policy "Upload into your own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_active_person(auth.uid())
  );

/* --------------------------------------------------------------------------
   3. And they stop seeing anybody's work, including their own
   -------------------------------------------------------------------------- */

drop policy if exists "Calls you are on, or ones you scheduled" on public.scheduled_calls;
create policy "Calls you are on, or ones you scheduled"
  on public.scheduled_calls for select
  using (
    public.is_active_person(auth.uid())
    and (
      auth.uid() = user_id
      or public.is_super_admin(auth.uid())
      or public.is_on_call(id)
    )
  );

drop policy if exists "Own segments, or a super admin's view" on public.activity_segments;
create policy "Own segments, or a super admin's view"
  on public.activity_segments for select
  using (
    public.is_active_person(auth.uid())
    and (auth.uid() = user_id or public.is_super_admin(auth.uid()))
  );

drop policy if exists "Own intervals, or a super admin's view" on public.activity_intervals;
create policy "Own intervals, or a super admin's view"
  on public.activity_intervals for select
  using (
    public.is_active_person(auth.uid())
    and (auth.uid() = user_id or public.is_super_admin(auth.uid()))
  );

drop policy if exists "Own screenshots, or a super admin's view" on public.screenshots;
create policy "Own screenshots, or a super admin's view"
  on public.screenshots for select
  using (
    public.is_active_person(auth.uid())
    and (auth.uid() = user_id or public.is_super_admin(auth.uid()))
  );

drop policy if exists "The roster is readable by anyone signed in" on public.nexus_users;
create policy "The roster is readable by anyone signed in"
  on public.nexus_users for select
  to authenticated
  using (public.is_active_person(auth.uid()));

/*
 * Their own profile row stays readable — see the note at the top. It is what
 * the app reads to discover it should stop, and it is how somebody is told
 * rather than left staring at an application that appears broken.
 */

/* --------------------------------------------------------------------------
   4. What the app asks

   One call instead of three: whether to record, whether to photograph, and
   whether this person still works there at all.
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
    -- Screenshots without tracking is not a state that means anything: the
    -- schedule they hang off is not running.
    'screenshots_enabled', coalesce(p.tracking_enabled and p.screenshots_enabled, false)
  )
    from public.profiles p
   where p.id = auth.uid()
$$;

comment on function public.my_status is
  'What this machine should be doing, and whether the person is still employed.';

grant execute on function public.my_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Check
--
--   select public.my_status();
--
--   -- as a departed person this must be false, and every read below empty
--   select public.is_active_person(auth.uid());
--   select count(*) from public.scheduled_calls;
-- ---------------------------------------------------------------------------
