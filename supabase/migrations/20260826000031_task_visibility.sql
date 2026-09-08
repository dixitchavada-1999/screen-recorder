-- ---------------------------------------------------------------------------
-- Who sees which tasks
--
-- Two changes, and both are about what a person is shown rather than what they
-- may do.
--
-- An ordinary member of staff now sees only their own work: the projects they
-- have been put on, and inside those, only the tasks that are theirs. A project
-- is still a shared space — the sections are the same for everybody, so a task
-- can be handed over into one — but somebody else's task is not their business
-- and is no longer sent to their machine at all.
--
-- "Theirs" is deliberately two things: assigned to them, or written by them. An
-- author who has not put their own name on a task would otherwise write it and
-- watch it disappear, which is exactly what happens when the only test is the
-- assignee list.
--
-- An admin now sees everything, as a super admin already did. `is_manager`
-- replaces `is_super_admin` throughout for that reason: the two roles run the
-- work, and a project they were never added to was invisible to an admin until
-- now.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. Is this task mine?

   A definer function for the same reason every other one here is: it is asked
   from inside a policy on `task_cards`, and reading `task_card_assignees`
   through row level security would send it straight back into the policy it was
   called from.
   -------------------------------------------------------------------------- */

create or replace function public.task_card_is_mine(p_card uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.task_card_assignees
     where card_id = p_card
       and nexus_id = public.my_nexus_id()
  );
$$;

comment on function public.task_card_is_mine is
  'True when the given task is assigned to the signed-in person. Safe to call from policies.';

revoke execute on function public.task_card_is_mine(uuid) from public, anon;
grant execute on function public.task_card_is_mine(uuid) to authenticated;

/* --------------------------------------------------------------------------
   2. The same question, one level out

   Assignee rows hang off a task rather than off a project, so their policies
   have to ask about the task they belong to. Rewritten here to mean the new,
   narrower "visible" rather than the old "on a project you are on".
   -------------------------------------------------------------------------- */

create or replace function public.task_card_is_visible(p_card uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.task_cards c
     where c.id = p_card
       and (
         public.is_manager(auth.uid())
         or (
           public.board_is_mine(c.board_id)
           and (c.created_by = auth.uid() or public.task_card_is_mine(c.id))
         )
       )
  );
$$;

comment on function public.task_card_is_visible is
  'True when the signed-in person may see the given task: theirs, or anything at all for a manager.';

/* --------------------------------------------------------------------------
   3. Projects and sections

   Unchanged in shape — a member sees them — except that a manager now sees
   every one, not only a super admin.

   Sections stay whole: everybody on a project sees every section, including the
   ones holding nothing of theirs. They are where work is moved to, and a column
   that vanished when it emptied would be a column nothing could be moved into.
   -------------------------------------------------------------------------- */

drop policy if exists "Boards you are on" on public.task_boards;
create policy "Boards you are on"
  on public.task_boards for select
  using (
    public.is_active_person(auth.uid())
    and (public.board_is_mine(id) or public.is_manager(auth.uid()))
  );

drop policy if exists "Who else is on a board you are on" on public.task_board_members;
create policy "Who else is on a board you are on"
  on public.task_board_members for select
  using (public.board_is_mine(board_id) or public.is_manager(auth.uid()));

drop policy if exists "Lists on a board you are on" on public.task_lists;
create policy "Lists on a board you are on"
  on public.task_lists for select
  using (
    public.is_active_person(auth.uid())
    and (public.board_is_mine(board_id) or public.is_manager(auth.uid()))
  );

drop policy if exists "Members add lists" on public.task_lists;
create policy "Members add lists"
  on public.task_lists for insert
  with check (public.board_is_mine(board_id) or public.is_manager(auth.uid()));

drop policy if exists "Members change lists" on public.task_lists;
create policy "Members change lists"
  on public.task_lists for update
  using (public.board_is_mine(board_id) or public.is_manager(auth.uid()))
  with check (public.board_is_mine(board_id) or public.is_manager(auth.uid()));

drop policy if exists "Members remove lists" on public.task_lists;
create policy "Members remove lists"
  on public.task_lists for delete
  using (public.board_is_mine(board_id) or public.is_manager(auth.uid()));

/* --------------------------------------------------------------------------
   4. Tasks

   The narrowing that this migration exists for. Note it applies to reading
   only: writing is still "are you on this project", because a task cannot be
   changed without first being seen, and the read is what decides that.
   -------------------------------------------------------------------------- */

drop policy if exists "Cards on a board you are on" on public.task_cards;
create policy "Cards on a board you are on"
  on public.task_cards for select
  using (
    public.is_active_person(auth.uid())
    and (
      public.is_manager(auth.uid())
      or (
        public.board_is_mine(board_id)
        and (created_by = auth.uid() or public.task_card_is_mine(id))
      )
    )
  );

drop policy if exists "Members add cards" on public.task_cards;
create policy "Members add cards"
  on public.task_cards for insert
  with check (
    (public.board_is_mine(board_id) or public.is_manager(auth.uid()))
    and created_by = auth.uid()
  );

drop policy if exists "Members change cards" on public.task_cards;
create policy "Members change cards"
  on public.task_cards for update
  using (public.board_is_mine(board_id) or public.is_manager(auth.uid()))
  with check (public.board_is_mine(board_id) or public.is_manager(auth.uid()));

drop policy if exists "Members remove cards" on public.task_cards;
create policy "Members remove cards"
  on public.task_cards for delete
  using (public.board_is_mine(board_id) or public.is_manager(auth.uid()));
