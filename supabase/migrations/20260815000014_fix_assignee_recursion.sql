-- ---------------------------------------------------------------------------
-- Breaking a circular policy
--
-- The previous migration gave `scheduled_calls` a policy that consults
-- `scheduled_call_assignees`, and gave the assignees a policy that consults
-- `scheduled_calls`. Each was written to avoid restating the other's rule; put
-- together they are a loop, and Postgres stops it with
--
--   42P17  infinite recursion detected in policy for relation ...
--
-- which makes both tables unreadable.
--
-- The fix is to reach across through `security definer` functions. Those run
-- with the definer's rights and so do not re-enter row level security, which
-- ends the recursion. Each answers a question only about the caller —
-- "am I on this call", "did I arrange it" — so neither can be used to learn
-- anything about anybody else.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The two questions, answered without re-entering the policies
   -------------------------------------------------------------------------- */

create or replace function public.is_on_call(p_call uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.scheduled_call_assignees a
     where a.call_id = p_call
       and a.nexus_id = public.my_nexus_id()
  )
$$;

comment on function public.is_on_call is
  'Whether the signed-in person is one of the people a call is for.';

create or replace function public.scheduled_by_me(p_call uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.scheduled_calls c
     where c.id = p_call
       and c.user_id = auth.uid()
  )
$$;

comment on function public.scheduled_by_me is
  'Whether the signed-in person arranged a call, whoever it turned out to be for.';

revoke execute on function public.is_on_call(uuid) from public, anon;
revoke execute on function public.scheduled_by_me(uuid) from public, anon;
grant execute on function public.is_on_call(uuid) to authenticated;
grant execute on function public.scheduled_by_me(uuid) to authenticated;

/* --------------------------------------------------------------------------
   2. The calls themselves

   Same three ways in as before — you arranged it, you are on it, or you are an
   administrator — with the middle one now going through the function.
   -------------------------------------------------------------------------- */

drop policy if exists "Calls you are on, or ones you scheduled" on public.scheduled_calls;
create policy "Calls you are on, or ones you scheduled"
  on public.scheduled_calls for select
  using (
    auth.uid() = user_id
    or public.is_super_admin(auth.uid())
    or public.is_on_call(id)
  );

/* --------------------------------------------------------------------------
   3. The assignee rows

   Spelled out rather than borrowed from the call's policy. Restating a rule is
   a real cost — the two can drift apart — but a loop that makes both tables
   unreadable is a larger one, and the three clauses below are the same three
   as above.
   -------------------------------------------------------------------------- */

drop policy if exists "Assignees are visible with their call" on public.scheduled_call_assignees;
create policy "Assignees are visible with their call"
  on public.scheduled_call_assignees for select
  using (
    -- Everyone on a call can see who else is on it: they are in a meeting
    -- together, and a list of people who is missing its own members is no use.
    public.is_on_call(call_id)
    or public.scheduled_by_me(call_id)
    or public.is_super_admin(auth.uid())
  );

drop policy if exists "Only the scheduler sets who a call is for" on public.scheduled_call_assignees;
create policy "Only the scheduler sets who a call is for"
  on public.scheduled_call_assignees for insert
  with check (public.scheduled_by_me(call_id) or public.is_super_admin(auth.uid()));

drop policy if exists "Only the scheduler removes who a call is for" on public.scheduled_call_assignees;
create policy "Only the scheduler removes who a call is for"
  on public.scheduled_call_assignees for delete
  using (public.scheduled_by_me(call_id) or public.is_super_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- Check
--
--   -- both of these must return rather than raise 42P17
--   select count(*) from public.scheduled_calls;
--   select count(*) from public.scheduled_call_assignees;
--
--   select count(*) from public.nexus_users;   -- at least 1, from the backfill
-- ---------------------------------------------------------------------------
