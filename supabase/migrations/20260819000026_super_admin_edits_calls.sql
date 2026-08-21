-- ---------------------------------------------------------------------------
-- A super admin can edit any call
--
-- Changing and removing a call was the owner's alone — the person who arranged
-- it. That is still true for everyone else: somebody merely on a call can read
-- it but not touch it. A super admin, though, has to be able to fix or cancel
-- any call in the organisation, the same way they already see every one.
--
-- Only update and delete change. Insert stays the owner's, and select was
-- already opened to assignees and super admins in an earlier migration.
-- ---------------------------------------------------------------------------

drop policy if exists "Calls are updatable by their owner" on public.scheduled_calls;
drop policy if exists "Calls are updatable by their owner or a super admin" on public.scheduled_calls;
create policy "Calls are updatable by their owner or a super admin"
  on public.scheduled_calls for update
  using (auth.uid() = user_id or public.is_super_admin(auth.uid()))
  with check (auth.uid() = user_id or public.is_super_admin(auth.uid()));

drop policy if exists "Calls are deletable by their owner" on public.scheduled_calls;
drop policy if exists "Calls are deletable by their owner or a super admin" on public.scheduled_calls;
create policy "Calls are deletable by their owner or a super admin"
  on public.scheduled_calls for delete
  using (auth.uid() = user_id or public.is_super_admin(auth.uid()));
