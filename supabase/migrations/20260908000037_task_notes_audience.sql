-- ---------------------------------------------------------------------------
-- Who a task's notes are for
--
-- The thread arrived visible to everybody the task was visible to, which is a
-- wider audience than it should have: on a project without `tasks.view_all`, a
-- task is visible to whoever wrote it as well as to whoever it is for. So
-- somebody who set a piece of work down and handed it over went on reading the
-- conversation about it afterwards.
--
-- Narrowed to the two audiences that have a reason to be there:
--
--   * the people the task is assigned to — it is their work being discussed
--   * anybody holding `tasks.view_all` — admins and super admins, who can see
--     every project and every task already
--
-- Still a subset of who can see the task. A thread on a task somebody cannot
-- see is not reachable by widening this.
-- ---------------------------------------------------------------------------

create or replace function public.task_notes_visible(p_card uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.task_card_is_visible(p_card)
     and (
       public.has_permission(auth.uid(), 'tasks.view_all')
       or public.task_card_is_mine(p_card)
     );
$$;

comment on function public.task_notes_visible is
  'True when the signed-in person may read a task''s notes: it is assigned to them, or they can see every task.';

revoke execute on function public.task_notes_visible(uuid) from public, anon;
grant execute on function public.task_notes_visible(uuid) to authenticated;

/* --------------------------------------------------------------------------
   The three policies, against the narrower audience
   -------------------------------------------------------------------------- */

drop policy if exists "Notes on a task you can see" on public.task_card_notes;
create policy "Notes on a task you can see"
  on public.task_card_notes for select
  using (public.task_notes_visible(card_id));

drop policy if exists "Notes are written by their author" on public.task_card_notes;
create policy "Notes are written by their author"
  on public.task_card_notes for insert
  with check (
    public.task_notes_visible(card_id)
    and author_id = auth.uid()
    and public.has_permission(auth.uid(), 'tasks.comment')
  );

drop policy if exists "Notes are removed by their author" on public.task_card_notes;
create policy "Notes are removed by their author"
  on public.task_card_notes for delete
  using (
    public.task_notes_visible(card_id)
    and (author_id = auth.uid() or public.has_permission(auth.uid(), 'tasks.delete'))
  );

/* --------------------------------------------------------------------------
   Check after applying

   As somebody who wrote a task but is not on it, and holds no view_all:

     select count(*) from public.task_card_notes where card_id = '<their task>';
     -- 0

   As one of its assignees, or as an admin: the thread.
   -------------------------------------------------------------------------- */
