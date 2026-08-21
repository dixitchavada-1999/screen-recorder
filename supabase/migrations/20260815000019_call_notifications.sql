-- ---------------------------------------------------------------------------
-- Telling people about the calls they are on
--
-- Assignment without notification is half a feature: a call arrives in
-- somebody's app and gives them no reason to open it. Nexus will send a Slack
-- message to one of its people, into the same thread as their other Nexus
-- notifications, which is where they already look.
--
-- The whole difficulty is sending it once. Nexus does no de-duplication and
-- says so plainly — a retry is a second message — and the trigger for this is
-- every running copy of the app, so two machines can easily reach the same
-- unsent reminder in the same second.
--
-- So a reminder is *claimed* before it is sent. The claim is a conditional
-- update: whoever's statement returns the row has the job, everybody else gets
-- nothing and sends nothing. If the send then fails the claim is released and
-- the next pass tries again.
-- ---------------------------------------------------------------------------

alter table public.scheduled_call_assignees
  add column if not exists notify_error text;

comment on column public.scheduled_call_assignees.notified_at is
  'When this person was told. Claimed before sending, so two senders cannot race.';

comment on column public.scheduled_call_assignees.notify_error is
  'Why the last attempt failed. Left set when the failure is permanent.';

-- Every pass asks the same question: what is coming up and not yet sent.
create index if not exists scheduled_call_assignees_unsent_idx
  on public.scheduled_call_assignees (call_id) where notified_at is null;

/* --------------------------------------------------------------------------
   Claiming what is due

   Returns rows only to the caller that won them, and marks them in the same
   statement. A caller that gets an empty array has nothing to do — which,
   most of the time, is every caller.
   -------------------------------------------------------------------------- */

create or replace function public.claim_due_notifications(
  p_lead_minutes integer default 15,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed jsonb;
begin
  with due as (
    select a.call_id, a.nexus_id
      from public.scheduled_call_assignees a
      join public.scheduled_calls c on c.id = a.call_id
     where a.notified_at is null
       and c.status = 'scheduled'
       -- Coming up, and not already gone. A reminder for a call that started
       -- twenty minutes ago is worse than no reminder.
       and c.starts_at > now()
       and c.starts_at <= now() + make_interval(mins => p_lead_minutes)
     order by c.starts_at
     limit p_limit
     for update of a skip locked
  ),
  taken as (
    update public.scheduled_call_assignees a
       set notified_at = now(), notify_error = null
      from due
     where a.call_id = due.call_id
       and a.nexus_id = due.nexus_id
       and a.notified_at is null
    returning a.call_id, a.nexus_id
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'call_id', t.call_id,
               'nexus_id', t.nexus_id,
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

comment on function public.claim_due_notifications is
  'Claims and returns the reminders coming due. Claiming is what stops a double send.';

revoke execute on function public.claim_due_notifications(integer, integer) from public, anon, authenticated;

/* --------------------------------------------------------------------------
   Putting one back

   A send that failed for a reason that might not happen again — Slack having a
   bad minute, a rate limit — has its claim released so the next pass retries.
   A permanent failure keeps the claim and records why: somebody with no Slack
   account will not grow one because we asked twice.
   -------------------------------------------------------------------------- */

create or replace function public.release_notification(
  p_call uuid,
  p_nexus uuid,
  p_error text,
  p_retry boolean
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.scheduled_call_assignees
     set notified_at = case when p_retry then null else notified_at end,
         notify_error = p_error
   where call_id = p_call
     and nexus_id = p_nexus
$$;

revoke execute on function public.release_notification(uuid, uuid, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Check
--
--   select public.claim_due_notifications(15, 5);   -- as the service role
--
--   select c.title, a.notified_at, a.notify_error
--     from public.scheduled_call_assignees a
--     join public.scheduled_calls c on c.id = a.call_id
--    order by c.starts_at desc limit 10;
-- ---------------------------------------------------------------------------
