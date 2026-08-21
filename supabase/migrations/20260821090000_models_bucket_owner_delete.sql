-- deleteModel (apps/web/src/lib/models/actions.ts) removes a model's artifact
-- objects after the RLS-scoped row delete has succeeded. Until now the
-- 'models' bucket was read-only for users, so that removal had to reach for
-- the secret key inside a user-facing server action. Granting owners delete
-- on their own folder keeps the whole action under the user's session; the
-- worker still writes artifacts with the secret key and users still cannot
-- insert or update in this bucket.
--
-- Browser path only: the worker and inference route bypass storage RLS.

drop policy if exists "models: owner delete" on storage.objects;
create policy "models: owner delete" on storage.objects
  for delete using (bucket_id = 'models' and (storage.foldername(name))[1] = auth.uid()::text);
