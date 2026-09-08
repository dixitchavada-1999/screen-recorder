-- ---------------------------------------------------------------------------
-- The rest of the app, under the same permissions
--
-- The Task Manager and the Roles screen ask `has_permission`. Everything else
-- still asks what role somebody holds — `is_call_manager` for the Calendar,
-- `is_super_admin` for the Team screen and for OKRs. So the Roles screen could
-- not hand out any of it: the permissions simply did not exist.
--
-- This adds them and rewrites those policies to ask the same question the rest
-- of the app asks.
--
-- Nothing changes on the day it is applied. The grants below reproduce exactly
-- what each role can do now: an admin runs the calls, a super admin runs the
-- Team screen and the OKRs, and everybody can open the Calendar and schedule
-- their own. What changes is that from here it can be handed out.
--
-- One rule kept deliberately: **a call's owner can always change their own**,
-- with or without the new permission. `calendar.manage` is about everybody
-- else's. Collapsing the two would take from every member of staff the ability
-- to move a meeting they arranged themselves.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The catalogue
   -------------------------------------------------------------------------- */

insert into public.permissions (key, module, label, description, sort) values
  -- Calendar
  ('calendar.view',     'calendar', 'Open the Calendar',
   'Without this the module is not offered at all.', 10),
  ('calendar.view_all', 'calendar', 'See everybody''s calls',
   'Without it, only calls they are on or arranged themselves.', 20),
  ('calendar.create',   'calendar', 'Schedule a call', '', 30),
  ('calendar.manage',   'calendar', 'Change anybody''s call',
   'Their own calls are always theirs to change; this is everybody else''s.', 40),

  -- Team
  ('team.view',   'team', 'Open the Team screen',
   'Who is tracked, and what their day looked like.', 10),
  ('team.manage', 'team', 'Turn tracking and screenshots on or off',
   'Writes to the person''s account; their machine picks it up within minutes.', 20),

  -- OKR
  ('okr.manage',  'okr', 'Set OKRs for other people',
   'Reading the ones addressed to you comes with having an account.', 10)
on conflict (key) do update
  set module      = excluded.module,
      label       = excluded.label,
      description = excluded.description,
      sort        = excluded.sort;

/* --------------------------------------------------------------------------
   2. The grants that keep today working

   Written from what the old role tests meant:

     is_call_manager  = admin or super_admin  → the Calendar's four
     is_super_admin   = super_admin           → Team and OKR

   A super admin needs no rows at all: `full_access` answers before any lookup.
   -------------------------------------------------------------------------- */

insert into public.role_permissions (role_key, permission_key) values
  -- An admin ran the calls, and still does.
  ('admin', 'calendar.view'),
  ('admin', 'calendar.view_all'),
  ('admin', 'calendar.create'),
  ('admin', 'calendar.manage'),

  -- Everybody could open the Calendar and arrange their own.
  ('user', 'calendar.view'),
  ('user', 'calendar.create')
on conflict do nothing;

/* Team and OKR were a super admin's alone, so nobody else is given them. */

/* --------------------------------------------------------------------------
   3. Calendar
   -------------------------------------------------------------------------- */

drop policy if exists "Calls you are on, or ones you scheduled" on public.scheduled_calls;
create policy "Calls you are on, or ones you scheduled"
  on public.scheduled_calls for select
  using (
    public.is_active_person(auth.uid())
    and (
      auth.uid() = user_id
      or public.has_permission(auth.uid(), 'calendar.view_all')
      or public.is_on_call(id)
    )
  );

drop policy if exists "Calls are insertable by their owner" on public.scheduled_calls;
create policy "Calls are insertable by their owner"
  on public.scheduled_calls for insert
  with check (
    auth.uid() = user_id
    and public.has_permission(auth.uid(), 'calendar.create')
  );

drop policy if exists "Calls are updatable by their owner or a call manager" on public.scheduled_calls;
create policy "Calls are updatable by their owner or a call manager"
  on public.scheduled_calls for update
  using (auth.uid() = user_id or public.has_permission(auth.uid(), 'calendar.manage'))
  with check (auth.uid() = user_id or public.has_permission(auth.uid(), 'calendar.manage'));

drop policy if exists "Calls are deletable by their owner or a call manager" on public.scheduled_calls;
create policy "Calls are deletable by their owner or a call manager"
  on public.scheduled_calls for delete
  using (auth.uid() = user_id or public.has_permission(auth.uid(), 'calendar.manage'));

/* --------------------------------------------------------------------------
   4. Team

   Two different things, and they were one before: reading everybody's profile
   is what the screen is, and writing the tracking switches is what it does.
   -------------------------------------------------------------------------- */

drop policy if exists "Super admins can read every profile" on public.profiles;
create policy "Super admins can read every profile"
  on public.profiles for select
  using (auth.uid() = id or public.has_permission(auth.uid(), 'team.view'));

drop policy if exists "Super admins can set the tracking policy" on public.profiles;
create policy "Super admins can set the tracking policy"
  on public.profiles for update
  using (public.has_permission(auth.uid(), 'team.manage'))
  with check (public.has_permission(auth.uid(), 'team.manage'));

/*
 * The trigger that guards the switches themselves, so a column grant cannot be
 * turned into a way around the policy.
 */
create or replace function public.guard_tracking_policy()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.tracking_enabled is distinct from old.tracking_enabled
      or new.screenshots_enabled is distinct from old.screenshots_enabled)
     and auth.uid() is not null
     and not public.has_permission(auth.uid(), 'team.manage') then
    raise exception 'You do not have permission to change the tracking policy'
      using errcode = 'insufficient_privilege';
  end if;

  /* Screenshots hang off tracking; with tracking off there is no schedule. */
  if not new.tracking_enabled then
    new.screenshots_enabled := false;
  end if;

  return new;
end;
$$;

/* --------------------------------------------------------------------------
   5. OKR
   -------------------------------------------------------------------------- */

drop policy if exists "Notes addressed to you, or any as a super admin" on public.kpi_notes;
create policy "Notes addressed to you, or any as a super admin"
  on public.kpi_notes for select
  using (public.has_permission(auth.uid(), 'okr.manage') or public.kpi_note_is_mine(id));

drop policy if exists "Only a super admin writes a note" on public.kpi_notes;
create policy "Only a super admin writes a note"
  on public.kpi_notes for insert
  with check (public.has_permission(auth.uid(), 'okr.manage'));

drop policy if exists "Only a super admin removes a note" on public.kpi_notes;
create policy "Only a super admin removes a note"
  on public.kpi_notes for delete
  using (public.has_permission(auth.uid(), 'okr.manage'));

drop policy if exists "Your own row, or any as a super admin" on public.kpi_note_recipients;
create policy "Your own row, or any as a super admin"
  on public.kpi_note_recipients for select
  using (nexus_id = public.my_nexus_id() or public.has_permission(auth.uid(), 'okr.manage'));

drop policy if exists "Only a super admin names the audience" on public.kpi_note_recipients;
create policy "Only a super admin names the audience"
  on public.kpi_note_recipients for insert
  with check (public.has_permission(auth.uid(), 'okr.manage'));

drop policy if exists "Only a super admin changes the audience" on public.kpi_note_recipients;
create policy "Only a super admin changes the audience"
  on public.kpi_note_recipients for delete
  using (public.has_permission(auth.uid(), 'okr.manage'));

/* --------------------------------------------------------------------------
   Check after applying

     select module, key, label from public.permissions order by module, sort;

     select role_key, string_agg(permission_key, ', ' order by permission_key)
       from public.role_permissions group by role_key;

   Admin should have gained the four calendar ones and nothing else; user should
   have gained calendar.view and calendar.create.
   -------------------------------------------------------------------------- */
