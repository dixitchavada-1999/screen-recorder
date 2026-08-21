-- ---------------------------------------------------------------------------
-- Slack reminders follow the same warnings the app does
--
-- The app already lets somebody choose how much warning they want — thirty
-- minutes, fifteen, five, at the start — and fires one desktop notification per
-- choice. The Slack message ignored all of it and went out at a fixed fifteen,
-- so a person who asked for half an hour got half an hour on their screen and
-- fifteen minutes in Slack.
--
-- The reason was structural rather than an oversight: the setting lives in a
-- file on that person's computer, and the server sending the Slack message
-- cannot see it. A call is for Raj, so it is Raj's preference that matters —
-- and Raj's preference was on Raj's laptop.
--
-- So the preference is mirrored onto the profile. The app remains the only
-- thing that writes it; the server only ever reads it.
--
-- And one timestamp per person per call is no longer enough to say what has
-- been sent. Three warnings need three records, which is what the table below
-- is for — and inserting a row *is* the claim, so two senders racing for the
-- same warning is settled by the primary key rather than by a lock.
-- ---------------------------------------------------------------------------

/* --------------------------------------------------------------------------
   1. The preference, where the server can see it
   -------------------------------------------------------------------------- */

alter table public.profiles
  add column if not exists reminder_lead_minutes integer[] not null default '{15}';

comment on column public.profiles.reminder_lead_minutes is
  'Minutes of warning this person wants. Mirrored from their app; read for Slack.';

/*
 * Four at most, and each one a sane number of minutes.
 *
 * Every entry is another Slack message per call per person, and the partner API
 * allows three hundred a day across the whole company. Somebody who wants eight
 * warnings is not expressing a preference, they are spending everybody's budget.
 */
alter table public.profiles
  drop constraint if exists profiles_reminder_leads_check;

alter table public.profiles
  add constraint profiles_reminder_leads_check check (
    array_length(reminder_lead_minutes, 1) is null
    or (
      array_length(reminder_lead_minutes, 1) <= 4
      and reminder_lead_minutes <@ array[0, 5, 10, 15, 30, 60, 120, 1440]
    )
  );

-- Column-level, like every other writable column here: a grant is what decides
-- which columns a crafted request can reach, and a policy never does.
grant update (reminder_lead_minutes) on public.profiles to authenticated;

/* --------------------------------------------------------------------------
   2. One record per warning

   Replaces the single `notified_at`, which could only say whether somebody had
   been told at all — not which of their three warnings had gone.
   -------------------------------------------------------------------------- */

create table if not exists public.call_notifications (
  call_id      uuid not null references public.scheduled_calls (id) on delete cascade,
  nexus_id     uuid not null references public.nexus_users (nexus_id),
  lead_minutes integer not null,

  sent_at timestamptz not null default now(),
  error   text,

  primary key (call_id, nexus_id, lead_minutes)
);

comment on table public.call_notifications is
  'One row per Slack warning sent. The insert is the claim: the primary key settles a race.';

alter table public.call_notifications enable row level security;

-- Written and read by the sender alone. Nothing in the app needs these rows;
-- what it needs is on the assignee, and that is already visible.
-- Row level security on with no policy denies everybody but the service role.

/* --------------------------------------------------------------------------
   3. Claiming, by inserting

   The previous version claimed with a conditional update and a `skip locked`
   dance. Inserting into a table whose primary key is exactly "this warning, to
   this person, for this call" says the same thing in less: the second sender's
   insert conflicts and returns nothing, so it sends nothing.
   -------------------------------------------------------------------------- */

drop function if exists public.claim_due_notifications(integer, integer);

create or replace function public.claim_due_notifications(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed jsonb;
begin
  with candidates as (
    select c.id as call_id, a.nexus_id, lead.minutes
      from public.scheduled_call_assignees a
      join public.scheduled_calls c on c.id = a.call_id
      -- Left, and defaulted: somebody who has never opened the app has no
      -- profile and no preference, and should still be told.
      left join public.profiles p on p.nexus_user_id = a.nexus_id
      cross join lateral unnest(coalesce(p.reminder_lead_minutes, '{15}')) as lead(minutes)
     where c.status = 'scheduled'
       /*
        * The grace has to be wider than the gap between passes.
        *
        * A zero-minute warning — "at start time" — has no window of its own:
        * its only chance is a pass that happens to run in the moment the call
        * begins. Passes are five minutes apart, so with a two minute grace one
        * running four minutes late would miss it entirely and the person would
        * never be told. Six covers the gap with a minute to spare.
        *
        * The cost is that a warning can arrive slightly after the call started.
        * The message reads the clock rather than the setting, so it says so.
        */
       and c.starts_at > now() - interval '6 minutes'
       and c.starts_at <= now() + make_interval(mins => lead.minutes)
     order by c.starts_at
     limit p_limit
  ),
  taken as (
    insert into public.call_notifications (call_id, nexus_id, lead_minutes)
    select call_id, nexus_id, minutes from candidates
    on conflict do nothing
    returning call_id, nexus_id, lead_minutes
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'call_id', t.call_id,
               'nexus_id', t.nexus_id,
               'lead_minutes', t.lead_minutes,
               'title', c.title,
               'starts_at', c.starts_at,
               'minutes_away', greatest(0, round(extract(epoch from (c.starts_at - now())) / 60))
             )
           ),
           '[]'::jsonb
         )
    into claimed
    from taken t
    join public.scheduled_calls c on c.id = t.call_id;

  return claimed;
end;
$$;

revoke execute on function public.claim_due_notifications(integer) from public, anon, authenticated;

/* --------------------------------------------------------------------------
   4. Putting one back
   -------------------------------------------------------------------------- */

drop function if exists public.release_notification(uuid, uuid, text, boolean);

create or replace function public.release_notification(
  p_call uuid,
  p_nexus uuid,
  p_lead integer,
  p_error text,
  p_retry boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_retry then
    -- The claim was the row, so releasing it is removing the row.
    delete from public.call_notifications
     where call_id = p_call and nexus_id = p_nexus and lead_minutes = p_lead;
  else
    -- Permanent: kept, with the reason, so nobody is asked twice about
    -- somebody who has no Slack account to be messaged on.
    update public.call_notifications
       set error = p_error
     where call_id = p_call and nexus_id = p_nexus and lead_minutes = p_lead;
  end if;
end;
$$;

revoke execute on function public.release_notification(uuid, uuid, integer, text, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check
--
--   select email, reminder_lead_minutes from public.profiles;
--
--   select c.title, n.lead_minutes, n.sent_at, n.error
--     from public.call_notifications n
--     join public.scheduled_calls c on c.id = n.call_id
--    order by n.sent_at desc limit 10;
-- ---------------------------------------------------------------------------
