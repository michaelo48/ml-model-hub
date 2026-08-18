-- NOTE: superseded by 20260818130000_review_fixes.sql, which drops all non-migration
-- storage policies dynamically. Kept because it has already been applied.
-- Remove storage policies that were created from the dashboard template before
-- the migrations took over. They duplicated the 'datasets' rules and, more
-- importantly, let users write to the 'models' bucket, which must be
-- worker-only (artifacts are produced by the worker with the secret key).
-- After this, the storage policies in 20260818120000_phase1_schema.sql are the
-- only ones in effect.
drop policy if exists "users can access models 1hcrz3e_0" on storage.objects;
drop policy if exists "users can access models 1hcrz3e_1" on storage.objects;
drop policy if exists "users can access models 1hcrz3e_2" on storage.objects;
drop policy if exists "users can access models 1hcrz3e_3" on storage.objects;
drop policy if exists "users can access their own datasets tlpdrv_0" on storage.objects;
drop policy if exists "users can access their own datasets tlpdrv_1" on storage.objects;
drop policy if exists "users can access their own datasets tlpdrv_2" on storage.objects;
drop policy if exists "users can access their own datasets tlpdrv_3" on storage.objects;
