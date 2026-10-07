-- ---------------------------------------------------------------------------
-- The uninstall password, changeable from Settings
--
-- An installer carries a hash of the password it was built with. To change it
-- without building and handing out a new installer, the current hash lives
-- here: the device admins set it from Settings, and every app copies it down
-- and keeps it (encrypted) for the moment its uninstaller asks — online or not.
--
-- Only a salted scrypt hash is ever stored or sent. The password is hashed on
-- the admin's own machine before it leaves it.
-- ---------------------------------------------------------------------------

create table if not exists public.uninstall_password (
  id         boolean primary key default true check (id),
  salt       text not null check (salt ~ '^[0-9a-f]{32}$'),
  hash       text not null check (hash ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.uninstall_password is
  'Salted scrypt hash of the uninstall password. One row. Set by device admins.';

alter table public.uninstall_password enable row level security;
-- No policies: read and written only through the functions below.

/* Every signed-in machine may read the hash: it is what its uninstaller checks against. */
create or replace function public.uninstall_password_hash()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not public.is_active_person(auth.uid()) then null
    else (select jsonb_build_object('salt', salt, 'hash', hash, 'updated_at', updated_at)
            from public.uninstall_password where id)
  end
$$;

/* Only the device admins may change it. When it was changed is all that comes back. */
create or replace function public.set_uninstall_password(p_salt text, p_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  changed timestamptz;
begin
  if not public.is_device_admin() then
    raise exception 'You cannot change the uninstall password' using errcode = 'insufficient_privilege';
  end if;

  insert into public.uninstall_password (id, salt, hash, updated_at, updated_by)
  values (true, lower(p_salt), lower(p_hash), now(), auth.uid())
  on conflict (id) do update
     set salt = excluded.salt, hash = excluded.hash,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning updated_at into changed;

  return changed;
end;
$$;

revoke execute on function public.uninstall_password_hash() from public, anon;
revoke execute on function public.set_uninstall_password(text, text) from public, anon;
grant execute on function public.uninstall_password_hash() to authenticated;
grant execute on function public.set_uninstall_password(text, text) to authenticated;
