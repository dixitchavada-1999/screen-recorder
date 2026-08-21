-- ---------------------------------------------------------------------------
-- A third role: admin
--
-- Between an ordinary user and a super admin sits an admin. They run the calls
-- — everybody's, not just their own — but the activity tracking, the OKRs and
-- who else is an administrator all stay a super admin's alone.
--
-- Only the enum value is added here. It has to be committed before anything can
-- compare against it, so the helper and the policies that use it live in the
-- next migration.
-- ---------------------------------------------------------------------------

alter type public.user_role add value if not exists 'admin';
