-- ---------------------------------------------------------------------------
-- Who may write and read screenshot files
--
-- Run this AFTER creating the bucket in the dashboard:
--   Storage → New bucket → name `screenshots`, public OFF.
--
-- The bucket itself cannot be created from the SQL editor — `storage.buckets`
-- is owned by `supabase_storage_admin` and an insert fails with 42501. Policies
-- on `storage.objects` are a different matter and do belong here, because they
-- are the actual access rules and should live with the rest of the schema
-- rather than in a form somebody filled in once.
--
-- Paths are `{user_id}/{yyyy-mm-dd}/{epoch}.jpg`, so the first folder segment
-- is the owner — which is what every policy below checks.
-- ---------------------------------------------------------------------------

drop policy if exists "Upload into your own folder" on storage.objects;
create policy "Upload into your own folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'screenshots'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Read your own captures, or any as a super admin" on storage.objects;
create policy "Read your own captures, or any as a super admin"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'screenshots'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_super_admin(auth.uid())
    )
  );

-- Deliberately no update and no delete policy. A capture is a record of a
-- moment; nobody edits one afterwards, and deleting them is retention work for
-- a scheduled job with its own credentials, not something the app can do.

-- ---------------------------------------------------------------------------
-- Check
--
--   select policyname from pg_policies
--    where schemaname = 'storage' and tablename = 'objects';
-- ---------------------------------------------------------------------------
