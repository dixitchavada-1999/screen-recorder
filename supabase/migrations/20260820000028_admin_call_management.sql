-- ---------------------------------------------------------------------------
-- An admin manages every call, and nothing else
--
-- The call policies used to name `is_super_admin`. They now name
-- `is_call_manager`, which is true for an admin as well — so an admin can see,
-- change, delete and add anyone's call, exactly as a super admin can.
--
-- Everything else is deliberately untouched. User activity, the OKR dashboard
-- and role changes still ask `is_super_admin`, so an admin has no more of those
-- than an ordinary user does.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   Who may run the calls: an admin or a super admin

   Text comparison rather than `= 'admin'::user_role`, so this reads a value the
   enum only just gained without waiting on the enum's own transaction.
   -------------------------------------------------------------------------- */

create or replace function public.is_call_manager(uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
     where id = uid and role::text in ('admin', 'super_admin')
  );
$$;

comment on function public.is_call_manager is
  'True for an admin or a super admin — the roles that may manage any call.';

revoke execute on function public.is_call_manager(uuid) from public;
grant execute on function public.is_call_manager(uuid) to anon, authenticated;

/* --------------------------------------------------------------------------
   scheduled_calls — see, change and remove any call
   -------------------------------------------------------------------------- */

drop policy if exists "Calls you are on, or ones you scheduled" on public.scheduled_calls;
create policy "Calls you are on, or ones you scheduled"
  on public.scheduled_calls for select
  using (
    public.is_active_person(auth.uid())
    and (
      auth.uid() = user_id
      or public.is_call_manager(auth.uid())
      or public.is_on_call(id)
    )
  );

drop policy if exists "Calls are updatable by their owner or a super admin" on public.scheduled_calls;
drop policy if exists "Calls are updatable by their owner or a call manager" on public.scheduled_calls;
create policy "Calls are updatable by their owner or a call manager"
  on public.scheduled_calls for update
  using (auth.uid() = user_id or public.is_call_manager(auth.uid()))
  with check (auth.uid() = user_id or public.is_call_manager(auth.uid()));

drop policy if exists "Calls are deletable by their owner or a super admin" on public.scheduled_calls;
drop policy if exists "Calls are deletable by their owner or a call manager" on public.scheduled_calls;
create policy "Calls are deletable by their owner or a call manager"
  on public.scheduled_calls for delete
  using (auth.uid() = user_id or public.is_call_manager(auth.uid()));

/* --------------------------------------------------------------------------
   scheduled_call_assignees — see and set who any call is for
   -------------------------------------------------------------------------- */

drop policy if exists "Assignees are visible with their call" on public.scheduled_call_assignees;
create policy "Assignees are visible with their call"
  on public.scheduled_call_assignees for select
  using (
    public.is_on_call(call_id)
    or public.scheduled_by_me(call_id)
    or public.is_call_manager(auth.uid())
  );

drop policy if exists "Only the scheduler sets who a call is for" on public.scheduled_call_assignees;
drop policy if exists "Only the scheduler or a call manager sets who a call is for" on public.scheduled_call_assignees;
create policy "Only the scheduler or a call manager sets who a call is for"
  on public.scheduled_call_assignees for insert
  with check (public.scheduled_by_me(call_id) or public.is_call_manager(auth.uid()));

drop policy if exists "Only the scheduler removes who a call is for" on public.scheduled_call_assignees;
drop policy if exists "Only the scheduler or a call manager removes who a call is for" on public.scheduled_call_assignees;
create policy "Only the scheduler or a call manager removes who a call is for"
  on public.scheduled_call_assignees for delete
  using (public.scheduled_by_me(call_id) or public.is_call_manager(auth.uid()));
