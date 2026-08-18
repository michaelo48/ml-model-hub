-- Follow-ups from code review of the Phase 1 schema.

-- ---------------------------------------------------------------------------
-- 1. Storage policies: migrations are the only source of truth.
--    Drop every storage.objects policy we did not author (dashboard templates
--    get random name suffixes, so matching by name is unreliable), then
--    recreate ours with explicit WITH CHECK on writes so a user can never
--    move an object into another user's folder or bucket.
-- ---------------------------------------------------------------------------
do $$
declare
  p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
  loop
    execute format('drop policy if exists %I on storage.objects', p.policyname);
  end loop;
end $$;

create policy "datasets: owner read" on storage.objects
  for select
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "datasets: owner insert" on storage.objects
  for insert
  with check (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "datasets: owner update" on storage.objects
  for update
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "datasets: owner delete" on storage.objects
  for delete
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "models: owner read" on storage.objects
  for select
  using (bucket_id = 'models' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 2. Deterministic queue order: tie-break on id so two jobs enqueued in the
--    same microsecond are always claimed in the same order.
-- ---------------------------------------------------------------------------
drop index if exists public.training_jobs_queue_idx;
create index training_jobs_queue_idx
  on public.training_jobs (created_at, id)
  where status = 'queued';

create or replace function public.claim_training_job(p_worker_id text)
returns setof public.training_jobs
language sql
security definer
set search_path = public
as $$
  update public.training_jobs j
     set status = 'claimed',
         claimed_by = p_worker_id,
         claimed_at = now(),
         heartbeat_at = now(),
         attempt = j.attempt + 1
   where j.id = (
     select id from public.training_jobs
      where status = 'queued'
      order by created_at, id
      limit 1
      for update skip locked
   )
  returning j.*;
$$;

-- create or replace preserves grants, but restate the intent explicitly.
revoke execute on function public.claim_training_job(text) from public, anon, authenticated;
