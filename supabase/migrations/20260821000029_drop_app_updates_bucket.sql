-- ---------------------------------------------------------------------------
-- The update bucket's policy goes again
--
-- Updates were briefly going to be served from Supabase Storage, because the
-- source repository was private. They are served from GitHub releases instead —
-- the repository is public, which is what a token-free updater needs — so the
-- bucket has nothing left to hold.
--
-- Only the policy is dropped here. Supabase refuses to let SQL delete from the
-- storage tables directly; the bucket itself is removed through the Storage
-- API, which is what the release notes for this change describe.
-- ---------------------------------------------------------------------------

drop policy if exists "App updates are public to read" on storage.objects;
