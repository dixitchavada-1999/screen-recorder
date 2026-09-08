-- ---------------------------------------------------------------------------
-- Let a role actually be handed out
--
-- `20260803000003` revoked update on `profiles` from `authenticated` outright
-- and granted it back one column at a time — `full_name`, `avatar_url`, and
-- later the tracking switches and the reminder lead. `role` was never among
-- them, because until now a role was only ever changed by hand in the SQL
-- editor, which runs as the owner and is not subject to any of this.
--
-- The Roles screen changes that: `setUserRole` writes the column from the app,
-- as the signed-in person, and without this grant it is refused before row
-- level security is ever consulted — a bare "permission denied for table
-- profiles" that no policy could have prevented and no policy can explain.
--
-- The grant opens the column, not the decision. Two things still stand between
-- anybody and somebody else's role, and both were already here:
--
--   * `profiles_guard_role` raises unless `is_super_admin(auth.uid())`
--   * `profiles_role_fkey` refuses a role that does not exist
--
-- So this widens what can be attempted, not what can be done.
-- ---------------------------------------------------------------------------

grant update (role) on public.profiles to authenticated;

/* --------------------------------------------------------------------------
   Check after applying

   As a signed-in admin — not a super admin — this must still fail, and fail on
   the trigger rather than on the grant:

     update public.profiles set role = 'admin' where id = '<somebody>';
     -- ERROR: Only a super admin can change a role
   -------------------------------------------------------------------------- */
