-- ---------------------------------------------------------------------------
-- Task boards
--
-- The kanban module: a board holds lists, a list holds cards, and a card is a
-- piece of work with people on it. The Trello shape, kept inside this app so it
-- shares the accounts, the roster and the policies already here.
--
-- Who a card is for is a Nexus id, exactly as `scheduled_call_assignees` and
-- `kpi_note_recipients` already are — never a `profiles.id`. A board can be set
-- up and staffed before those people have ever opened the recorder, and the
-- work is waiting for them the first time they sign in. `my_nexus_id()` maps
-- the signed-in account onto that identity, and somebody unlinked matches
-- nothing.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. Boards
   -------------------------------------------------------------------------- */

create table if not exists public.task_boards (
  id uuid primary key default gen_random_uuid(),

  name text not null check (length(btrim(name)) between 1 and 80),

  /*
   * Whoever opened it. Keeps a board answerable to a person — they are the one
   * who may rename or delete it — and gives the members list an owner to fall
   * back on when the last member is removed.
   */
  created_by uuid not null references public.profiles (id) on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.task_boards is
  'A kanban board. Visible to the people in task_board_members, and to a super admin.';

drop trigger if exists task_boards_touch_updated_at on public.task_boards;
create trigger task_boards_touch_updated_at
  before update on public.task_boards
  for each row execute function public.touch_updated_at();

create table if not exists public.task_board_members (
  board_id uuid not null references public.task_boards (id) on delete cascade,
  nexus_id uuid not null references public.nexus_users (nexus_id),
  primary key (board_id, nexus_id)
);

comment on table public.task_board_members is
  'Who can see and work on a board, by their Nexus identity.';

-- The question every screen asks first: which boards are mine?
create index if not exists task_board_members_person_idx
  on public.task_board_members (nexus_id);

/* --------------------------------------------------------------------------
   2. Lists and cards

   `position` is a float, not an integer, and the reason is the drag: a card
   dropped between two others takes the midpoint of their positions, so moving
   it writes one row instead of renumbering the column. A forty-card list
   renumbered on every drag is forty writes and a visible stall.

   Midpoints do eventually run out of precision. The service watches the gap and
   renumbers that one list when it gets too small — see `tasks.ts`.
   -------------------------------------------------------------------------- */

create table if not exists public.task_lists (
  id uuid primary key default gen_random_uuid(),

  board_id uuid not null references public.task_boards (id) on delete cascade,

  name     text not null check (length(btrim(name)) between 1 and 60),
  position double precision not null,

  created_at timestamptz not null default now(),

  /*
   * Not redundant. It is what lets `task_cards` point at a list *and* a board
   * in one foreign key, which is what makes a card in the wrong board
   * impossible rather than merely unlikely.
   */
  unique (id, board_id)
);

comment on table public.task_lists is
  'One column on a board — "To do", "Doing", "Done". Ordered by position.';

create index if not exists task_lists_board_idx
  on public.task_lists (board_id, position);

create table if not exists public.task_cards (
  id uuid primary key default gen_random_uuid(),

  /*
   * The board is carried here as well as on the list, so every policy below
   * asks one direct question — is this board mine? — rather than joining
   * through `task_lists` for every row it considers.
   *
   * The pair is then locked to the list's own board by the composite foreign
   * key: a card whose list belongs to a different board cannot be written at
   * all, so the shortcut cannot drift from the truth.
   */
  list_id  uuid not null,
  board_id uuid not null,

  title       text not null check (length(btrim(title)) between 1 and 200),
  description text not null default '' check (length(description) <= 5000),

  position double precision not null,

  due_at   timestamptz,
  priority text not null default 'normal'
             check (priority in ('low', 'normal', 'high', 'urgent')),

  created_by uuid not null references public.profiles (id) on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (list_id, board_id)
    references public.task_lists (id, board_id) on delete cascade
);

comment on table public.task_cards is
  'A piece of work on a board. Moving it between lists is an update of list_id and position.';

create index if not exists task_cards_list_idx
  on public.task_cards (board_id, list_id, position);

drop trigger if exists task_cards_touch_updated_at on public.task_cards;
create trigger task_cards_touch_updated_at
  before update on public.task_cards
  for each row execute function public.touch_updated_at();

create table if not exists public.task_card_assignees (
  card_id  uuid not null references public.task_cards (id) on delete cascade,
  nexus_id uuid not null references public.nexus_users (nexus_id),
  primary key (card_id, nexus_id)
);

comment on table public.task_card_assignees is
  'Who each card is for, by Nexus identity. Removing the card removes these with it.';

-- "What is assigned to me", across every board.
create index if not exists task_card_assignees_person_idx
  on public.task_card_assignees (nexus_id);

/* --------------------------------------------------------------------------
   3. Asking the questions without recursion

   A board is readable because of a membership row, and a membership row is
   readable because of its board. Written as two plain policies those consult
   each other and Postgres refuses both — the same wall `fix_assignee_recursion`
   and `kpi_note_is_mine` hit, and the same way through it: a definer function,
   which does not re-enter row level security.
   -------------------------------------------------------------------------- */

create or replace function public.is_manager(uid uuid)
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

comment on function public.is_manager is
  'True for an admin or a super admin. The general form of is_call_manager, for features that are not calls.';

revoke execute on function public.is_manager(uuid) from public;
grant execute on function public.is_manager(uuid) to anon, authenticated;

create or replace function public.board_is_mine(p_board uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.task_board_members
     where board_id = p_board
       and nexus_id = public.my_nexus_id()
  );
$$;

comment on function public.board_is_mine is
  'True when the signed-in person is a member of the given board. Safe to call from policies.';

revoke execute on function public.board_is_mine(uuid) from public, anon;
grant execute on function public.board_is_mine(uuid) to authenticated;

/*
 * Renaming and deleting a board is the owner's to do, not every member's.
 * A super admin can always reach it, as everywhere else.
 */
create or replace function public.board_is_managed_by_me(p_board uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.task_boards
     where id = p_board
       and (created_by = auth.uid() or public.is_super_admin(auth.uid()))
  );
$$;

comment on function public.board_is_managed_by_me is
  'True when the signed-in person opened the given board, or is a super admin.';

revoke execute on function public.board_is_managed_by_me(uuid) from public, anon;
grant execute on function public.board_is_managed_by_me(uuid) to authenticated;

/*
 * Assignees hang off a card rather than off a board, so they need the board
 * question asked one level further out.
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
       and (public.board_is_mine(c.board_id) or public.is_super_admin(auth.uid()))
  );
$$;

comment on function public.task_card_is_visible is
  'True when the signed-in person may see the board the given card is on.';

revoke execute on function public.task_card_is_visible(uuid) from public, anon;
grant execute on function public.task_card_is_visible(uuid) to authenticated;

/* --------------------------------------------------------------------------
   4. Policies

   Members do everything inside a board they are on. Opening a board — and
   renaming or removing one — is narrower: an admin or a super admin opens it,
   and from then on it belongs to whoever opened it.
   -------------------------------------------------------------------------- */

alter table public.task_boards        enable row level security;
alter table public.task_board_members enable row level security;
alter table public.task_lists         enable row level security;
alter table public.task_cards         enable row level security;
alter table public.task_card_assignees enable row level security;

-- Boards -------------------------------------------------------------------

drop policy if exists "Boards you are on" on public.task_boards;
create policy "Boards you are on"
  on public.task_boards for select
  using (
    public.is_active_person(auth.uid())
    and (public.board_is_mine(id) or public.is_super_admin(auth.uid()))
  );

drop policy if exists "Only a manager opens a board" on public.task_boards;
create policy "Only a manager opens a board"
  on public.task_boards for insert
  with check (public.is_manager(auth.uid()) and created_by = auth.uid());

drop policy if exists "A board is renamed by whoever opened it" on public.task_boards;
create policy "A board is renamed by whoever opened it"
  on public.task_boards for update
  using (created_by = auth.uid() or public.is_super_admin(auth.uid()))
  with check (created_by = auth.uid() or public.is_super_admin(auth.uid()));

drop policy if exists "A board is removed by whoever opened it" on public.task_boards;
create policy "A board is removed by whoever opened it"
  on public.task_boards for delete
  using (created_by = auth.uid() or public.is_super_admin(auth.uid()));

-- Membership ---------------------------------------------------------------

drop policy if exists "Who else is on a board you are on" on public.task_board_members;
create policy "Who else is on a board you are on"
  on public.task_board_members for select
  using (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()));

drop policy if exists "Membership is set by whoever opened the board" on public.task_board_members;
create policy "Membership is set by whoever opened the board"
  on public.task_board_members for insert
  with check (public.board_is_managed_by_me(board_id));

drop policy if exists "Membership is removed by whoever opened the board" on public.task_board_members;
create policy "Membership is removed by whoever opened the board"
  on public.task_board_members for delete
  using (public.board_is_managed_by_me(board_id));

-- Lists --------------------------------------------------------------------

drop policy if exists "Lists on a board you are on" on public.task_lists;
create policy "Lists on a board you are on"
  on public.task_lists for select
  using (
    public.is_active_person(auth.uid())
    and (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()))
  );

drop policy if exists "Members add lists" on public.task_lists;
create policy "Members add lists"
  on public.task_lists for insert
  with check (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()));

drop policy if exists "Members change lists" on public.task_lists;
create policy "Members change lists"
  on public.task_lists for update
  using (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()))
  with check (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()));

drop policy if exists "Members remove lists" on public.task_lists;
create policy "Members remove lists"
  on public.task_lists for delete
  using (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()));

-- Cards --------------------------------------------------------------------

drop policy if exists "Cards on a board you are on" on public.task_cards;
create policy "Cards on a board you are on"
  on public.task_cards for select
  using (
    public.is_active_person(auth.uid())
    and (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()))
  );

drop policy if exists "Members add cards" on public.task_cards;
create policy "Members add cards"
  on public.task_cards for insert
  with check (
    (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()))
    and created_by = auth.uid()
  );

drop policy if exists "Members change cards" on public.task_cards;
create policy "Members change cards"
  on public.task_cards for update
  using (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()))
  with check (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()));

drop policy if exists "Members remove cards" on public.task_cards;
create policy "Members remove cards"
  on public.task_cards for delete
  using (public.board_is_mine(board_id) or public.is_super_admin(auth.uid()));

-- Assignees ----------------------------------------------------------------

drop policy if exists "Who a visible card is for" on public.task_card_assignees;
create policy "Who a visible card is for"
  on public.task_card_assignees for select
  using (public.task_card_is_visible(card_id));

drop policy if exists "Members assign cards" on public.task_card_assignees;
create policy "Members assign cards"
  on public.task_card_assignees for insert
  with check (public.task_card_is_visible(card_id));

drop policy if exists "Members unassign cards" on public.task_card_assignees;
create policy "Members unassign cards"
  on public.task_card_assignees for delete
  using (public.task_card_is_visible(card_id));
