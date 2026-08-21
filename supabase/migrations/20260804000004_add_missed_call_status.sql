-- ---------------------------------------------------------------------------
-- Missed calls
--
-- A fourth status. `scheduled` means "still ahead of us"; once a call has ended
-- without anyone saying what happened to it, leaving it as `scheduled` would be
-- a lie the calendar keeps telling.
--
-- The app sweeps for these and moves them to `missed` itself — which is also
-- what makes the notification fire exactly once. The status *is* the record of
-- having noticed, so there is no separate "already told them" flag to keep.
-- ---------------------------------------------------------------------------

alter table public.scheduled_calls
  drop constraint if exists scheduled_calls_status_check;

alter table public.scheduled_calls
  add constraint scheduled_calls_status_check
  check (status in ('scheduled', 'completed', 'cancelled', 'missed'));

comment on column public.scheduled_calls.status is
  'scheduled = ahead; completed / cancelled = decided by the user; missed = ended while still scheduled.';

-- Finding what has just been missed is "my scheduled calls, oldest first",
-- which the existing (user_id, starts_at) index already serves.
