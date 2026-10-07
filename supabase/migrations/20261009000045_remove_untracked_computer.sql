-- ---------------------------------------------------------------------------
-- Removing an untracked computer removes all of it, and says what it removed
--
-- Adding a computer by name adds every installation that has reported that
-- name — the app reinstalled leaves a second one behind. Removing went one
-- installation at a time, so a computer added by name came off the list half
-- way and still showed under the same name; and the function returned nothing,
-- so the app reported success whether anything was deleted or not.
--
-- `remove_untracked_devices` takes every id of the computer being removed and
-- returns how many it deleted. The single-id function stays for older builds.
-- ---------------------------------------------------------------------------

create or replace function public.remove_untracked_devices(p_machines text[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  if not public.is_device_admin() then
    raise exception 'You cannot manage untracked devices' using errcode = 'insufficient_privilege';
  end if;

  delete from public.untracked_devices
   where machine_id = any (select lower(btrim(m)) from unnest(coalesce(p_machines, '{}')) m);

  get diagnostics removed = row_count;
  return removed;
end;
$$;

revoke execute on function public.remove_untracked_devices(text[]) from public, anon;
grant execute on function public.remove_untracked_devices(text[]) to authenticated;
