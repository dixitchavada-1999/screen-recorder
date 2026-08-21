-- ---------------------------------------------------------------------------
-- Richer Slack reminders
--
-- The reminder used to carry only the call's title and how long away it was.
-- The message people actually want also says who is on the call and whatever
-- note was left on it — an agenda, a dial-in, a thing to remember. Both already
-- exist on the row and the assignees; this just hands them to the sender.
--
-- Only the returned shape changes. The claiming, the de-duplication and the
-- six-minute grace are exactly as they were.
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
      left join public.profiles p on p.nexus_user_id = a.nexus_id
      cross join lateral unnest(coalesce(p.reminder_lead_minutes, '{15}')) as lead(minutes)
     where c.status = 'scheduled'
       and c.starts_at > now() - interval '6 minutes'
       and c.starts_at <= now() + make_interval(mins => lead.minutes)
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
               'minutes_away', greatest(0, round(extract(epoch from (c.starts_at - now())) / 60)),
               -- The note left on the call, if any. Trimmed so an empty string
               -- reads as "no note" rather than an empty line in the message.
               'notes', nullif(btrim(coalesce(c.notes, '')), ''),
               -- Everybody on the call, by name, alphabetical. Read here rather
               -- than joined so the message has the whole audience, not just the
               -- one person being told.
               'attendees', (
                 select coalesce(string_agg(nu.name, ', ' order by nu.name), '')
                   from public.scheduled_call_assignees sa
                   join public.nexus_users nu on nu.nexus_id = sa.nexus_id
                  where sa.call_id = c.id
               )
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
