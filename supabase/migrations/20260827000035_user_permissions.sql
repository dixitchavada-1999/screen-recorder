-- ---------------------------------------------------------------------------
-- Permissions for one person
--
-- Roles answer "what does somebody like this get?". They cannot answer "what
-- does *this* person get?", and every real organisation eventually has one:
-- somebody on the ordinary user role who is trusted to write tasks, or an admin
-- who should be able to do everything except delete a project.
--
-- Making a role for each of those works, and is the right answer when the
-- exception is a pattern — five people who all need the same thing. It is the
-- wrong answer when it is one person, because a role per exception ends as
-- twenty roles nobody can tell apart.
--
-- So a role stays the base, and an override sits on top of it:
--
--     full_access        yes, before anything is read
--     user_permissions   this person's own answer, allow or deny
--     role_permissions   what their role says
--
-- `granted` is a boolean rather than a row meaning "allowed", because taking
-- one thing away from somebody is as common as adding one. An admin who should
-- not delete projects is a single deny, not a whole new role.
--
-- The precedence is the point: an override beats the role, in both directions,
-- and nothing beats full access — which is what keeps a super admin able to
-- undo any of this.
-- ---------------------------------------------------------------------------

create table if not exists public.user_permissions (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,

  /* True adds it on top of the role, false takes it away despite the role. */
  granted boolean not null,

  created_at timestamptz not null default now(),

  primary key (user_id, permission_key)
);

comment on table public.user_permissions is
  'Exceptions to what somebody''s role gives them. Beats role_permissions, in both directions.';

create index if not exists user_permissions_user_idx
  on public.user_permissions (user_id);

/* --------------------------------------------------------------------------
   The check, with the middle step added

   `coalesce` over three selects, in order, is the whole precedence: the first
   one that has an answer wins. A role's grant is only consulted when the person
   has nothing of their own to say about that permission.
   -------------------------------------------------------------------------- */

create or replace function public.has_permission(uid uuid, p_key text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    /* 1. Full access answers before anything is read. */
    (
      select true
        from public.profiles p
        join public.app_roles r on r.key = p.role
       where p.id = uid
         and r.full_access
    ),

    /* 2. This person's own answer, if they have one. Allow or deny. */
    (
      select up.granted
        from public.user_permissions up
       where up.user_id = uid
         and up.permission_key = p_key
    ),

    /* 3. Otherwise what their role carries. */
    (
      select exists (
        select 1
          from public.profiles p
          join public.role_permissions rp on rp.role_key = p.role
         where p.id = uid
           and rp.permission_key = p_key
      )
    )
  );
$$;

comment on function public.has_permission is
  'True when the account may do the named thing. Full access, then their own overrides, then their role.';

/* --------------------------------------------------------------------------
   Who may see and set an override

   Readable by the person it is about — an app that cannot tell somebody why a
   button is missing is an app nobody trusts — and by whoever hands permissions
   out. Set by the latter alone, which is the same permission that decides
   somebody's role, because both answer the same question about a person.
   -------------------------------------------------------------------------- */

alter table public.user_permissions enable row level security;

drop policy if exists "Your own overrides, or anybody's if you set them" on public.user_permissions;
create policy "Your own overrides, or anybody's if you set them"
  on public.user_permissions for select
  using (user_id = auth.uid() or public.has_permission(auth.uid(), 'roles.assign'));

drop policy if exists "Overrides are given by whoever assigns roles" on public.user_permissions;
create policy "Overrides are given by whoever assigns roles"
  on public.user_permissions for insert
  with check (public.has_permission(auth.uid(), 'roles.assign'));

drop policy if exists "Overrides are changed by whoever assigns roles" on public.user_permissions;
create policy "Overrides are changed by whoever assigns roles"
  on public.user_permissions for update
  using (public.has_permission(auth.uid(), 'roles.assign'))
  with check (public.has_permission(auth.uid(), 'roles.assign'));

drop policy if exists "Overrides are removed by whoever assigns roles" on public.user_permissions;
create policy "Overrides are removed by whoever assigns roles"
  on public.user_permissions for delete
  using (public.has_permission(auth.uid(), 'roles.assign'));

/* --------------------------------------------------------------------------
   Check after applying

   Nothing is overridden yet, so every answer must be exactly what it was:

     select p.email, p.role,
            public.has_permission(p.id, 'tasks.create') as may_add_task
       from public.profiles p order by p.role, p.email;

   Then one person, one exception:

     insert into public.user_permissions (user_id, permission_key, granted)
     values ('<user id>', 'tasks.create', true);
   -------------------------------------------------------------------------- */
