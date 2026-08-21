-- ---------------------------------------------------------------------------
-- A warning whose moment had already gone is not sent at all
--
-- Somebody scheduling a call for four minutes' time was about to get three
-- Slack messages at once. Their thirty, fifteen and five minute warnings all
-- became due the instant the call existed, because all three moments were
-- already in the past — so all three fired together, one after another, saying
-- almost the same thing.
--
-- Three messages arriving at once is not three warnings. It is one warning and
-- two pieces of noise, and it spends three of the day's three hundred.
--
-- So a warning only fires if there was still time for it when the call was
-- made. A call arranged at short notice gets the warnings that still fit, and a
-- call arranged next week gets all of them.
-- ---------------------------------------------------------------------------

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
        * begins. Passes are five minutes apart, so with a narrower grace one
        * running four minutes late would miss it entirely.
        */
       and c.starts_at > now() - interval '6 minutes'
       and c.starts_at <= now() + make_interval(mins => lead.minutes)
       /*
        * And the warning has to have been possible when the call was made.
        *
        * Without this a call scheduled four minutes ahead sends every warning
        * at once — thirty, fifteen and five minutes' notice all delivered
        * together, four minutes before the thing starts. The same six minute
        * grace applies, so a warning that was only just missed still goes.
        */
       and c.starts_at - make_interval(mins => lead.minutes)
             >= c.created_at - interval '6 minutes'
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

-- ---------------------------------------------------------------------------
-- Check
--
--   -- a call four minutes out should claim one warning, not three
--   select public.claim_due_notifications(50);
-- ---------------------------------------------------------------------------
