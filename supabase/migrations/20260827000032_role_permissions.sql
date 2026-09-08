-- ---------------------------------------------------------------------------
-- Roles and permissions
--
-- Until now every access rule in this database was a role test written into a
-- policy: is_super_admin, is_manager, role in ('admin', 'super_admin'). Which
-- means the answer to "may this person do this?" lived in code, and changing it
-- meant a migration and a release.
--
-- That has run out. Two people holding the same role need different powers —
-- one member of staff who writes tasks and one who only reads them, one admin
-- who runs projects and one who only watches. A role test cannot say that,
-- because both people hold the same value.
--
-- So the question moves onto a permission, and permissions become data:
--
--     permissions       what can be done — a catalogue, added by migrations
--     app_roles         who somebody can be — added by people, in the app
--     role_permissions  the grants, which is what the whole module turns on
--
-- A super admin never asks. `full_access` short-circuits every check before any
-- lookup happens, so whoever administers permissions cannot lock themselves out
-- of the screen that administers them. Everybody else, admin included, is
-- answered from role_permissions.
--
-- Nothing changes on the day this is applied: the seeded grants reproduce
-- exactly what each of the three roles can do today.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. What can be done
   -------------------------------------------------------------------------- */

create table if not exists public.permissions (
  key         text primary key,
  /* Which part of the app it belongs to, so the screen can group them. */
  module      text not null,
  label       text not null,
  description text not null default '',
  /* Display order within a module. Grouped by meaning, not alphabetically. */
  sort        integer not null default 0
);

comment on table public.permissions is
  'Everything the app knows how to gate. Rows are added by migrations as features arrive, never by users.';

/* --------------------------------------------------------------------------
   2. Who somebody can be

   The table that makes this dynamic. A fourth role is a row here plus some
   ticks in role_permissions — not an `alter type` and a release.
   -------------------------------------------------------------------------- */

create table if not exists public.app_roles (
  key   text primary key check (key ~ '^[a-z][a-z0-9_]{1,38}$'),
  label text not null check (length(btrim(label)) between 1 and 60),

  /*
   * The short circuit. True for super_admin alone, and deliberately not a
   * permission: a permission can be un-ticked, and un-ticking this one would
   * leave nobody able to tick it back.
   */
  full_access boolean not null default false,

  /*
   * The three the code and this migration name by hand. They can be given
   * different permissions, but renaming or removing one would break something
   * that expects it to exist.
   */
  built_in boolean not null default false,

  created_at timestamptz not null default now()
);

comment on table public.app_roles is
  'The roles a person can hold. Built-in ones cannot be renamed or removed; anything else is the app''s to manage.';

insert into public.app_roles (key, label, full_access, built_in) values
  ('super_admin', 'Super admin', true,  true),
  ('admin',       'Admin',       false, true),
  ('user',        'User',        false, true)
on conflict (key) do update
  set label    = excluded.label,
      built_in = excluded.built_in;

/* --------------------------------------------------------------------------
   3. The grants
   -------------------------------------------------------------------------- */

create table if not exists public.role_permissions (
  role_key       text not null references public.app_roles (key) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

comment on table public.role_permissions is
  'Which permissions each role carries. The table the permission check reads.';

create index if not exists role_permissions_role_idx
  on public.role_permissions (role_key);

/* --------------------------------------------------------------------------
   4. profiles.role: enum -> text

   A dynamic role cannot live in a Postgres enum; adding one would mean
   `alter type` in a migration, which is the thing this module exists to avoid.

   Smaller than it looks. Everything that reads this column already treats it as
   text — `custom_access_token` casts with `role::text`, `is_manager` compares
   `role::text in (…)`, `is_super_admin` compares against a string literal, and
   `guard_profile_role` only asks whether it changed. None of them need
   rewriting, and `guard_profile_role` goes on doing its job: a role is a super
   admin's to hand out.
   -------------------------------------------------------------------------- */

alter table public.profiles
  alter column role drop default;

alter table public.profiles
  alter column role type text using role::text;

alter table public.profiles
  alter column role set default 'user';

/*
 * The foreign key is what stops a typo becoming a person with no permissions
 * at all — and, with `on update cascade`, lets a role key be corrected later
 * without orphaning everybody holding it.
 */
alter table public.profiles
  drop constraint if exists profiles_role_fkey;

alter table public.profiles
  add constraint profiles_role_fkey
  foreign key (role) references public.app_roles (key)
  on update cascade;

drop type if exists public.user_role;

/* --------------------------------------------------------------------------
   5. The check

   The diagram, in ten lines: find the person's role, answer yes at once if it
   carries full access, otherwise look for the grant.

   `security definer` because it reads `profiles` and `role_permissions` from
   inside policies on other tables — through row level security it would need
   every caller to be able to read both, which is the opposite of the point.
   -------------------------------------------------------------------------- */

create or replace function public.has_permission(uid uuid, p_key text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.profiles p
      join public.app_roles r on r.key = p.role
     where p.id = uid
       and (
         r.full_access
         or exists (
           select 1
             from public.role_permissions rp
            where rp.role_key = r.key
              and rp.permission_key = p_key
         )
       )
  );
$$;

comment on function public.has_permission is
  'True when the given account''s role carries the named permission. A full-access role carries every one. Safe to call from policies.';

revoke execute on function public.has_permission(uuid, text) from public, anon;
grant execute on function public.has_permission(uuid, text) to authenticated;

/* --------------------------------------------------------------------------
   6. The catalogue, and the grants that keep today working

   The seed reproduces exactly what each role can do right now. The module
   arrives invisible; the first thing that changes is something somebody
   changes on purpose.
   -------------------------------------------------------------------------- */

insert into public.permissions (key, module, label, description, sort) values
  ('tasks.view',           'tasks', 'Open the Task Manager',
   'Without this the module is not offered at all.', 10),
  ('tasks.view_all',       'tasks', 'See every project and task',
   'Without it, only projects they are on and tasks that are theirs.', 20),
  ('tasks.project.create', 'tasks', 'Add a project',
   'Whoever adds one is put on it and owns it.', 30),
  ('tasks.project.manage', 'tasks', 'Manage projects',
   'Rename or delete a project, and manage its sections and members.', 40),
  ('tasks.create',         'tasks', 'Create tasks', '', 50),
  ('tasks.edit_own',       'tasks', 'Change their own tasks',
   'Tasks they wrote, or that are assigned to them.', 60),
  ('tasks.edit_any',       'tasks', 'Change anybody''s task', '', 70)
on conflict (key) do update
  set module      = excluded.module,
      label       = excluded.label,
      description = excluded.description,
      sort        = excluded.sort;

/* An admin, as an admin is today: everything except being a super admin. */
insert into public.role_permissions (role_key, permission_key)
select 'admin', key from public.permissions where module = 'tasks'
on conflict do nothing;

/* A user, as a user is today: their own work, and they may write more of it. */
insert into public.role_permissions (role_key, permission_key) values
  ('user', 'tasks.view'),
  ('user', 'tasks.create'),
  ('user', 'tasks.edit_own')
on conflict do nothing;

/* Nothing for super_admin: full_access answers before the lookup happens. */

/* --------------------------------------------------------------------------
   7. Who may read and change all of this

   Readable by anybody signed in — the window has to know what it may offer
   before it can offer it, and a list of capability names is not a secret.
   Writable by a super admin alone.
   -------------------------------------------------------------------------- */

alter table public.permissions      enable row level security;
alter table public.app_roles        enable row level security;
alter table public.role_permissions enable row level security;

drop policy if exists "Anybody signed in may read the catalogue" on public.permissions;
create policy "Anybody signed in may read the catalogue"
  on public.permissions for select
  using (auth.uid() is not null);

drop policy if exists "Anybody signed in may read the roles" on public.app_roles;
create policy "Anybody signed in may read the roles"
  on public.app_roles for select
  using (auth.uid() is not null);

drop policy if exists "Anybody signed in may read the grants" on public.role_permissions;
create policy "Anybody signed in may read the grants"
  on public.role_permissions for select
  using (auth.uid() is not null);

drop policy if exists "Only a super admin adds a role" on public.app_roles;
create policy "Only a super admin adds a role"
  on public.app_roles for insert
  with check (public.is_super_admin(auth.uid()) and not full_access);

/*
 * Built-in roles keep their names, and no role may be handed full access from
 * the app — that flag is this migration's to give and nobody else's.
 */
drop policy if exists "Only a super admin renames a role" on public.app_roles;
create policy "Only a super admin renames a role"
  on public.app_roles for update
  using (public.is_super_admin(auth.uid()) and not built_in)
  with check (public.is_super_admin(auth.uid()) and not built_in and not full_access);

drop policy if exists "Only a super admin removes a role" on public.app_roles;
create policy "Only a super admin removes a role"
  on public.app_roles for delete
  using (public.is_super_admin(auth.uid()) and not built_in);

drop policy if exists "Only a super admin grants a permission" on public.role_permissions;
create policy "Only a super admin grants a permission"
  on public.role_permissions for insert
  with check (public.is_super_admin(auth.uid()));

drop policy if exists "Only a super admin revokes a permission" on public.role_permissions;
create policy "Only a super admin revokes a permission"
  on public.role_permissions for delete
  using (public.is_super_admin(auth.uid()));

/* --------------------------------------------------------------------------
   8. The task policies, restated as permissions

   Same rules as `20260826000031_task_visibility.sql` produced, asked a
   different way. `board_is_mine` and `task_card_is_mine` are unchanged and
   reused; `is_manager` is no longer consulted here, and stays for the Calendar.
   -------------------------------------------------------------------------- */

/*
 * Which projects are within reach at all: every one, or the ones they are on.
 * The first half of every task policy below.
 */
create or replace function public.task_board_in_reach(p_board uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select public.has_permission(auth.uid(), 'tasks.view_all')
      or public.board_is_mine(p_board);
$$;

comment on function public.task_board_in_reach is
  'True when the signed-in person may reach the given project — all of them, or the ones they are on.';

revoke execute on function public.task_board_in_reach(uuid) from public, anon;
grant execute on function public.task_board_in_reach(uuid) to authenticated;

/*
 * Assignee rows hang off a task, so their policies ask about the task. Restated
 * to match the card policy below rather than the role test it used to make.
 */
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
       and public.task_board_in_reach(c.board_id)
       and (
         public.has_permission(auth.uid(), 'tasks.view_all')
         or c.created_by = auth.uid()
         or public.task_card_is_mine(c.id)
       )
  );
$$;

-- Projects ------------------------------------------------------------------

drop policy if exists "Boards you are on" on public.task_boards;
create policy "Boards you are on"
  on public.task_boards for select
  using (public.is_active_person(auth.uid()) and public.task_board_in_reach(id));

drop policy if exists "Only a manager opens a board" on public.task_boards;
create policy "Only a manager opens a board"
  on public.task_boards for insert
  with check (
    public.has_permission(auth.uid(), 'tasks.project.create')
    and created_by = auth.uid()
  );

drop policy if exists "A board is renamed by whoever opened it" on public.task_boards;
create policy "A board is renamed by whoever opened it"
  on public.task_boards for update
  using (public.task_board_in_reach(id) and public.has_permission(auth.uid(), 'tasks.project.manage'))
  with check (public.task_board_in_reach(id) and public.has_permission(auth.uid(), 'tasks.project.manage'));

drop policy if exists "A board is removed by whoever opened it" on public.task_boards;
create policy "A board is removed by whoever opened it"
  on public.task_boards for delete
  using (public.task_board_in_reach(id) and public.has_permission(auth.uid(), 'tasks.project.manage'));

-- Membership ----------------------------------------------------------------

drop policy if exists "Who else is on a board you are on" on public.task_board_members;
create policy "Who else is on a board you are on"
  on public.task_board_members for select
  using (public.task_board_in_reach(board_id));

drop policy if exists "Membership is set by whoever opened the board" on public.task_board_members;
create policy "Membership is set by whoever opened the board"
  on public.task_board_members for insert
  with check (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.project.manage')
  );

drop policy if exists "Membership is removed by whoever opened the board" on public.task_board_members;
create policy "Membership is removed by whoever opened the board"
  on public.task_board_members for delete
  using (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.project.manage')
  );

-- Sections ------------------------------------------------------------------

drop policy if exists "Lists on a board you are on" on public.task_lists;
create policy "Lists on a board you are on"
  on public.task_lists for select
  using (public.is_active_person(auth.uid()) and public.task_board_in_reach(board_id));

drop policy if exists "Members add lists" on public.task_lists;
create policy "Members add lists"
  on public.task_lists for insert
  with check (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.project.manage')
  );

drop policy if exists "Members change lists" on public.task_lists;
create policy "Members change lists"
  on public.task_lists for update
  using (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.project.manage')
  )
  with check (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.project.manage')
  );

drop policy if exists "Members remove lists" on public.task_lists;
create policy "Members remove lists"
  on public.task_lists for delete
  using (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.project.manage')
  );

-- Tasks ---------------------------------------------------------------------

/*
 * `created_by = auth.uid()` is not decoration. `createCard` writes the task and
 * asks for it back in one statement, and Postgres applies this policy to the
 * row it hands over — a task written by somebody who did not put their own name
 * on it would fail at the moment of creation. `createBoard` was rewritten once
 * for exactly this.
 */
drop policy if exists "Cards on a board you are on" on public.task_cards;
create policy "Cards on a board you are on"
  on public.task_cards for select
  using (
    public.is_active_person(auth.uid())
    and public.task_board_in_reach(board_id)
    and (
      public.has_permission(auth.uid(), 'tasks.view_all')
      or created_by = auth.uid()
      or public.task_card_is_mine(id)
    )
  );

drop policy if exists "Members add cards" on public.task_cards;
create policy "Members add cards"
  on public.task_cards for insert
  with check (
    public.task_board_in_reach(board_id)
    and public.has_permission(auth.uid(), 'tasks.create')
    and created_by = auth.uid()
  );

drop policy if exists "Members change cards" on public.task_cards;
create policy "Members change cards"
  on public.task_cards for update
  using (
    public.task_board_in_reach(board_id)
    and (
      public.has_permission(auth.uid(), 'tasks.edit_any')
      or (
        public.has_permission(auth.uid(), 'tasks.edit_own')
        and (created_by = auth.uid() or public.task_card_is_mine(id))
      )
    )
  )
  with check (public.task_board_in_reach(board_id));

drop policy if exists "Members remove cards" on public.task_cards;
create policy "Members remove cards"
  on public.task_cards for delete
  using (
    public.task_board_in_reach(board_id)
    and (
      public.has_permission(auth.uid(), 'tasks.edit_any')
      or (
        public.has_permission(auth.uid(), 'tasks.edit_own')
        and (created_by = auth.uid() or public.task_card_is_mine(id))
      )
    )
  );

/* --------------------------------------------------------------------------
   Check after applying
   --------------------------------------------------------------------------

   -- Everybody's role still resolves, and still points at a real role:
   select p.email, p.role, r.label, r.full_access
     from public.profiles p join public.app_roles r on r.key = p.role
    order by p.role, p.email;

   -- What each role can do:
   select role_key, string_agg(permission_key, ', ' order by permission_key)
     from public.role_permissions group by role_key;
*/
