-- ---------------------------------------------------------------------------
-- The permission catalogue, as it should have been
--
-- The first cut lumped things together that people want to hand out
-- separately. `tasks.project.manage` was renaming a project, deleting it,
-- staffing it and running its sections — four different amounts of trust in one
-- tick. `tasks.edit_own` and `tasks.edit_any` split editing by *whose* task it
-- is, which turned out to be the wrong axis: whose task somebody may see is
-- already decided by `tasks.view_all`, so the edit permission only had to say
-- whether they may edit at all.
--
-- So this splits them the way the work is actually divided:
--
--     Task Manager      open it · see everything · add, edit, delete a project
--     Inside a project  members · add, edit, delete a section
--                       add, edit, delete a task
--     Roles             open it · change roles · assign them to people
--
-- Every existing grant is carried across, so no role gains or loses anything
-- the moment this is applied. `tasks.project.manage` becomes the four it stood
-- for; `edit_own` or `edit_any` becomes edit-and-delete. A user who could only
-- change their own tasks still can — not because the edit permission says so,
-- but because they cannot see anybody else's to change.
--
-- The Roles module itself becomes gateable, which it was not: it was reachable
-- by a super admin and nobody else, in code. Now it is three permissions, and a
-- super admin still holds them all through `full_access`.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The new catalogue
   -------------------------------------------------------------------------- */

insert into public.permissions (key, module, label, description, sort) values
  -- Task Manager
  ('tasks.view',            'tasks', 'Open the Task Manager',
   'Without this the module is not offered at all.', 10),
  ('tasks.view_all',        'tasks', 'See every project and task',
   'Without it, only projects they are on and tasks that are theirs.', 20),
  ('tasks.project.create',  'tasks', 'Add a project',
   'Whoever adds one is put on it.', 30),
  ('tasks.project.edit',    'tasks', 'Edit a project', 'Rename it.', 40),
  ('tasks.project.delete',  'tasks', 'Delete a project',
   'Takes its sections and every task on them.', 50),

  -- Inside a project
  ('tasks.member.manage',   'project', 'Add and remove members',
   'Who can see the project, and everything on it.', 10),
  ('tasks.section.create',  'project', 'Add a section', '', 20),
  ('tasks.section.edit',    'project', 'Edit a section', 'Rename it.', 30),
  ('tasks.section.delete',  'project', 'Delete a section',
   'Takes the tasks in it.', 40),
  ('tasks.create',          'project', 'Add a task', '', 50),
  ('tasks.edit',            'project', 'Edit a task',
   'Any task they can see — which is what tasks.view_all decides.', 60),
  ('tasks.delete',          'project', 'Delete a task', '', 70),

  -- Roles
  ('roles.view',            'roles', 'Open the Roles module',
   'Read what each role may do.', 10),
  ('roles.manage',          'roles', 'Change roles and permissions',
   'Add a role, rename it, remove it, and tick what it carries.', 20),
  ('roles.assign',          'roles', 'Assign a role to somebody',
   'Move a person onto a different role from the Team screen.', 30)
on conflict (key) do update
  set module      = excluded.module,
      label       = excluded.label,
      description = excluded.description,
      sort        = excluded.sort;

/* --------------------------------------------------------------------------
   2. Carry every grant across

   Written as inserts from the old grants rather than as a fresh seed, so a role
   somebody has already made by hand keeps exactly what it was given.
   -------------------------------------------------------------------------- */

-- Managing a project was four things. It becomes four things.
insert into public.role_permissions (role_key, permission_key)
select rp.role_key, new_key
  from public.role_permissions rp
 cross join lateral (
   values ('tasks.project.edit'), ('tasks.project.delete'),
          ('tasks.member.manage'), ('tasks.section.create'),
          ('tasks.section.edit'), ('tasks.section.delete')
 ) as expanded(new_key)
 where rp.permission_key = 'tasks.project.manage'
on conflict do nothing;

-- Editing anything at all — own or any — becomes editing and deleting. What
-- they can reach is `tasks.view_all`'s business, not this one's.
insert into public.role_permissions (role_key, permission_key)
select distinct rp.role_key, new_key
  from public.role_permissions rp
 cross join lateral (values ('tasks.edit'), ('tasks.delete')) as expanded(new_key)
 where rp.permission_key in ('tasks.edit_own', 'tasks.edit_any')
on conflict do nothing;

/*
 * The Roles module was a super admin's alone, in code. Nobody else held it, so
 * nobody else is given it here — a super admin reaches it through `full_access`
 * as they reach everything, and anybody else is now a deliberate grant away.
 */

-- The ones that have been replaced. Their grants cascade away with them.
delete from public.permissions
 where key in ('tasks.project.manage', 'tasks.edit_own', 'tasks.edit_any');

/* --------------------------------------------------------------------------
   3. The task policies, split the same way
   -------------------------------------------------------------------------- */

drop policy if exists "A board is renamed by whoever opened it" on public.task_boards;
create policy "A board is renamed by whoever opened it"
  on public.task_boards for update
  using (public.task_board_in_reach(id) and public.has_permission(auth.uid(), 'tasks.project.edit'))
  with check (public.task_board_in_reach(id) and public.has_permission(auth.uid(), 'tasks.project.edit'));

drop policy if exists "A board is removed by whoever opened it" on public.task_boards;
create policy "A board is removed by whoever opened it"
  on public.task_boards for delete
  using (public.task_board_in_reach(id) and public.has_permission(auth.uid(), 'tasks.project.delete'));

drop policy if exists "Membership is set by whoever opened the board" on public.task_board_members;
create policy "Membership is set by whoever opened the board"
  on public.task_board_members for insert
  with check (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.member.manage')
  );

drop policy if exists "Membership is removed by whoever opened the board" on public.task_board_members;
create policy "Membership is removed by whoever opened the board"
  on public.task_board_members for delete
  using (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.member.manage')
  );

drop policy if exists "Members add lists" on public.task_lists;
create policy "Members add lists"
  on public.task_lists for insert
  with check (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.section.create')
  );

drop policy if exists "Members change lists" on public.task_lists;
create policy "Members change lists"
  on public.task_lists for update
  using (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.section.edit')
  )
  with check (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.section.edit')
  );

drop policy if exists "Members remove lists" on public.task_lists;
create policy "Members remove lists"
  on public.task_lists for delete
  using (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.section.delete')
  );

/*
 * Editing and deleting a task no longer ask whose it is. They do not need to:
 * the select policy above has already decided what this person can see, and a
 * task they cannot see is a task they cannot name.
 */
drop policy if exists "Members change cards" on public.task_cards;
create policy "Members change cards"
  on public.task_cards for update
  using (public.task_board_in_reach(board_id) and public.has_permission(auth.uid(), 'tasks.edit'))
  with check (public.task_board_in_reach(board_id));

drop policy if exists "Members remove cards" on public.task_cards;
create policy "Members remove cards"
  on public.task_cards for delete
  using (public.task_board_in_reach(board_id) and public.has_permission(auth.uid(), 'tasks.delete'));

/* --------------------------------------------------------------------------
   4. The Roles module, gated by its own permissions

   `is_super_admin` is replaced by `roles.manage`, which a super admin holds
   through `full_access` — so nothing changes for them, and it becomes possible
   to hand out without making somebody a super admin.
   -------------------------------------------------------------------------- */

drop policy if exists "Only a super admin adds a role" on public.app_roles;
create policy "Only a super admin adds a role"
  on public.app_roles for insert
  with check (public.has_permission(auth.uid(), 'roles.manage') and not full_access);

drop policy if exists "Only a super admin renames a role" on public.app_roles;
create policy "Only a super admin renames a role"
  on public.app_roles for update
  using (public.has_permission(auth.uid(), 'roles.manage') and not built_in)
  with check (public.has_permission(auth.uid(), 'roles.manage') and not built_in and not full_access);

drop policy if exists "Only a super admin removes a role" on public.app_roles;
create policy "Only a super admin removes a role"
  on public.app_roles for delete
  using (public.has_permission(auth.uid(), 'roles.manage') and not built_in);

drop policy if exists "Only a super admin grants a permission" on public.role_permissions;
create policy "Only a super admin grants a permission"
  on public.role_permissions for insert
  with check (public.has_permission(auth.uid(), 'roles.manage'));

drop policy if exists "Only a super admin revokes a permission" on public.role_permissions;
create policy "Only a super admin revokes a permission"
  on public.role_permissions for delete
  using (public.has_permission(auth.uid(), 'roles.manage'));

/*
 * Handing somebody a role is its own permission, separate from deciding what
 * the roles mean. The trigger is where that has always been enforced, and it
 * stays there — it fires whatever wrote the row.
 */
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    -- auth.uid() is null for the service role and for SQL run in the editor,
    -- which is exactly where a role change is supposed to be able to come from.
    if auth.uid() is not null and not public.has_permission(auth.uid(), 'roles.assign') then
      raise exception 'You do not have permission to change a role'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

/* --------------------------------------------------------------------------
   Check after applying

     select module, key, label from public.permissions order by module, sort;

     select role_key, string_agg(permission_key, ', ' order by permission_key)
       from public.role_permissions group by role_key;

   Admin should hold every task and project permission and no roles one; user
   should hold view, add task, edit task and delete task.
   -------------------------------------------------------------------------- */
