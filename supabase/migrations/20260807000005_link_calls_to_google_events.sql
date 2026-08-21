-- ---------------------------------------------------------------------------
-- Google Calendar as a source of calls
--
-- Events pulled from a connected Google account become ordinary rows in this
-- table rather than living in a parallel structure. Everything already built on
-- top of `scheduled_calls` — reminders, the missed-call sweep, the calendar
-- view — then works on an imported call without knowing where it came from.
--
-- The link is deliberately one-way: the app reads Google and never writes back.
-- These columns record where a row came from so a re-sync can find it again.
-- ---------------------------------------------------------------------------

alter table public.scheduled_calls
  add column if not exists google_event_id text,
  add column if not exists google_account_email text;

comment on column public.scheduled_calls.google_event_id is
  'Google Calendar event id this call was imported from. Null for calls created in the app.';

comment on column public.scheduled_calls.google_account_email is
  'Which connected Google account the event came from. Null for calls created in the app.';

-- ---------------------------------------------------------------------------
-- Both or neither
--
-- An event id without the account it belongs to cannot be re-synced (the same
-- id can exist under two accounts), and an account without an id identifies
-- nothing. Half a link is never useful, so the constraint refuses it.
-- ---------------------------------------------------------------------------

alter table public.scheduled_calls
  drop constraint if exists scheduled_calls_google_link_check;

alter table public.scheduled_calls
  add constraint scheduled_calls_google_link_check
  check (
    (google_event_id is null and google_account_email is null)
    or (google_event_id is not null and google_account_email is not null)
  );

-- ---------------------------------------------------------------------------
-- One row per event, per account, per user
--
-- This is what makes the sync idempotent: re-importing the same month upserts
-- onto the existing row instead of stacking duplicates. Partial, so the many
-- app-created calls — all null on both columns — are not forced to be unique
-- against each other.
--
-- `user_id` is part of the key because two people can be invited to the same
-- meeting, and each is entitled to their own copy.
-- ---------------------------------------------------------------------------

create unique index if not exists scheduled_calls_google_event_key
  on public.scheduled_calls (user_id, google_account_email, google_event_id)
  where google_event_id is not null;

-- Disconnecting an account deletes its imported calls, which is "this user's
-- rows for that email" — served by the index above.
