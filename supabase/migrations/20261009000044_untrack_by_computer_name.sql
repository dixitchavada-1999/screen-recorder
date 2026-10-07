-- ---------------------------------------------------------------------------
-- Untracking a computer by its name
--
-- The name — LAPTOP-NG8LJRD8 — is what people see and type; the id is a long
-- string nobody reads. `add_untracked_device` now takes either. A name is
-- looked up among the computers people have signed in on, and every
-- installation that has reported that name is added: two installations on one
-- machine (the app reinstalled) both have to stop.
--
-- A name nobody has signed in from is refused rather than remembered: there is
-- no id to put on the list, and a name stored instead would be matched against
-- nothing.
-- ---------------------------------------------------------------------------

create or replace function public.add_untracked_device(p_machine text, p_label text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted text := lower(btrim(p_machine));
  found  integer;
begin
  if not public.is_device_admin() then
    raise exception 'You cannot manage untracked devices' using errcode = 'insufficient_privilege';
  end if;

  if wanted = '' then
    raise exception 'Give a device ID or a computer name' using errcode = 'invalid_parameter_value';
  end if;

  -- An id: added as it is, whether or not that computer has been seen yet.
  if wanted ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    insert into public.untracked_devices (machine_id, label, added_by)
    values (wanted, nullif(btrim(p_label), ''), auth.uid())
    on conflict (machine_id) do update set label = excluded.label;
    return;
  end if;

  -- A name: every installation that has reported it.
  insert into public.untracked_devices (machine_id, label, added_by)
  select distinct d.machine_id, coalesce(nullif(btrim(p_label), ''), d.hostname), auth.uid()
    from public.devices d
   where lower(d.hostname) = wanted
     and d.machine_id ~ '^[0-9a-f-]{36}$'
  on conflict (machine_id) do update set label = excluded.label;

  get diagnostics found = row_count;

  if found = 0 then
    raise exception 'No computer called "%" has signed in yet', btrim(p_machine)
      using errcode = 'no_data_found',
            hint = 'Check the name under Settings → This device on that computer, or use its device ID.';
  end if;
end;
$$;

revoke execute on function public.add_untracked_device(text, text) from public, anon;
grant execute on function public.add_untracked_device(text, text) to authenticated;
