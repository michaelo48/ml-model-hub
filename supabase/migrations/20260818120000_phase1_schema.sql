-- ============================================================================
-- ModelForge Phase 1 schema (CLAUDE.md §4)
--
-- Replaces the early 4-table prototype (datasets / training_jobs / job_events /
-- models) with the full model. Those tables were empty; dropping them is safe.
--
-- Access model, in one paragraph:
--   * The browser talks to Postgres with the publishable key plus the user's
--     JWT. Every table below has RLS enabled, and the policies restrict rows
--     to the owning user. A table with RLS and no policy denies everything.
--   * The training worker and the inference route use the secret key, which
--     bypasses RLS entirely. RLS is therefore the browser-path guard, not the
--     only guard: server code must still scope its own queries correctly.
--   * Two SECURITY DEFINER functions (claim_training_job, reap_stale_jobs)
--     exist for the worker. EXECUTE is revoked from anon/authenticated so a
--     browser session cannot call them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Drop the prototype schema
-- ---------------------------------------------------------------------------
drop table if exists public.job_events cascade;
drop table if exists public.models cascade;
drop table if exists public.training_jobs cascade;
drop table if exists public.datasets cascade;
drop type if exists public.job_status;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------
create type public.dataset_status as enum ('uploading', 'ready', 'invalid');
create type public.model_task as enum ('regression', 'binary_classification');
create type public.model_algorithm as enum ('linear_regression', 'logistic_regression');
create type public.model_status as enum ('draft', 'queued', 'training', 'succeeded', 'failed');
create type public.job_status as enum ('queued', 'claimed', 'running', 'succeeded', 'failed');

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- Uploaded CSVs. The file lives in the 'datasets' storage bucket at
-- storage_path = '<user_id>/<dataset_id>.csv'; this row is its metadata.
create table public.datasets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 120),
  storage_path  text not null unique,
  size_bytes    bigint,
  row_count     integer,
  -- [{ "name": "sqft", "type": "number" | "string" | "boolean", "sample": [...] }, ...]
  columns       jsonb,
  status        public.dataset_status not null default 'uploading',
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index datasets_user_id_idx on public.datasets (user_id, created_at desc);

-- A model definition: which dataset, which columns, which algorithm and
-- hyperparameters. Training produces model_artifacts; this row is the config.
create table public.models (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  dataset_id       uuid not null references public.datasets(id) on delete restrict,
  name             text not null check (char_length(name) between 1 and 120),
  task             public.model_task not null,
  algorithm        public.model_algorithm not null,
  target_column    text not null,
  feature_columns  text[] not null check (cardinality(feature_columns) >= 1),
  -- { optimizer: 'ols'|'sgd'|'batch_gd'|'adam', learning_rate, epochs, batch_size, l2 }
  hyperparameters  jsonb not null default '{}'::jsonb,
  status           public.model_status not null default 'draft',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index models_user_id_idx on public.models (user_id, created_at desc);
create index models_dataset_id_idx on public.models (dataset_id);

-- The job queue. A row is enqueued by the web app (as the user, under RLS)
-- and claimed/updated by the worker (secret key). heartbeat_at is bumped by
-- the worker while running so reap_stale_jobs can detect a dead worker.
create table public.training_jobs (
  id             uuid primary key default gen_random_uuid(),
  model_id       uuid not null references public.models(id) on delete cascade,
  status         public.job_status not null default 'queued',
  claimed_by     text,
  claimed_at     timestamptz,
  started_at     timestamptz,
  finished_at    timestamptz,
  heartbeat_at   timestamptz,
  error_message  text,
  attempt        integer not null default 0,
  created_at     timestamptz not null default now()
);
-- Queue scan: "oldest queued job first".
create index training_jobs_queue_idx on public.training_jobs (created_at) where status = 'queued';
create index training_jobs_model_id_idx on public.training_jobs (model_id, created_at desc);

-- One row per epoch, inserted by the worker, streamed to the browser via
-- Realtime. This is what drives the live loss curve.
create table public.training_metrics (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references public.training_jobs(id) on delete cascade,
  epoch       integer not null,
  loss        double precision not null,
  val_loss    double precision,
  elapsed_ms  integer,
  created_at  timestamptz not null default now(),
  unique (job_id, epoch)
);

-- A trained, versioned artifact. The JSON file in the 'models' bucket holds
-- weights, normalization stats and column order; metrics are the final
-- evaluation numbers. Predictions use the highest version by default.
create table public.model_artifacts (
  id            uuid primary key default gen_random_uuid(),
  model_id      uuid not null references public.models(id) on delete cascade,
  job_id        uuid not null references public.training_jobs(id) on delete cascade,
  version       integer not null,
  storage_path  text not null unique,
  metrics       jsonb,
  created_at    timestamptz not null default now(),
  unique (model_id, version)
);

-- Per-model API keys for the inference endpoint. Only a SHA-256 hash of the
-- key is stored; key_prefix is shown in the UI so users can tell keys apart.
create table public.api_keys (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  model_id      uuid not null references public.models(id) on delete cascade,
  name          text check (name is null or char_length(name) <= 60),
  key_prefix    text not null check (char_length(key_prefix) = 8),
  key_hash      text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index api_keys_model_id_idx on public.api_keys (model_id, created_at desc);

-- One row per inference request. No request bodies, by design.
create table public.predictions_log (
  id               bigint generated always as identity primary key,
  model_id         uuid not null references public.models(id) on delete cascade,
  api_key_id       uuid references public.api_keys(id) on delete set null,
  created_at       timestamptz not null default now(),
  latency_ms       integer not null,
  input_row_count  integer not null,
  status_code      integer not null
);
create index predictions_log_model_idx on public.predictions_log (model_id, created_at desc);

-- updated_at maintenance (set_updated_at() was created in the profiles migration).
create trigger datasets_set_updated_at before update on public.datasets
  for each row execute function public.set_updated_at();
create trigger models_set_updated_at before update on public.models
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Row Level Security
--    Enabled on every table. Policies express "the signed-in user owns this
--    row" either directly (user_id) or transitively via the owning model.
-- ---------------------------------------------------------------------------
alter table public.datasets          enable row level security;
alter table public.models            enable row level security;
alter table public.training_jobs     enable row level security;
alter table public.training_metrics  enable row level security;
alter table public.model_artifacts   enable row level security;
alter table public.api_keys          enable row level security;
alter table public.predictions_log   enable row level security;

-- Helper: does the current user own model $1? Used by the transitive policies
-- below so the ownership rule is written once. STABLE + security invoker so
-- it runs under the caller's RLS context.
create or replace function public.owns_model(p_model_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.models m
    where m.id = p_model_id and m.user_id = auth.uid()
  );
$$;

-- datasets: full CRUD on own rows.
create policy "datasets: owner all" on public.datasets
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- models: full CRUD on own rows. The dataset must also be the user's own
-- (a user cannot point a model at someone else's dataset).
create policy "models: owner select" on public.models
  for select using (auth.uid() = user_id);
create policy "models: owner insert" on public.models
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.datasets d where d.id = dataset_id and d.user_id = auth.uid())
  );
create policy "models: owner update" on public.models
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "models: owner delete" on public.models
  for delete using (auth.uid() = user_id);

-- training_jobs: the user can see jobs for their models and enqueue new ones.
-- Only the worker (secret key, bypasses RLS) may update or delete jobs.
create policy "training_jobs: owner select" on public.training_jobs
  for select using (public.owns_model(model_id));
create policy "training_jobs: owner insert" on public.training_jobs
  for insert with check (
    public.owns_model(model_id)
    and status = 'queued'
    and claimed_by is null
  );

-- training_metrics: read-only for the model owner. Required for Realtime
-- subscriptions to deliver rows to the browser under RLS. Only the worker inserts.
create policy "training_metrics: owner select" on public.training_metrics
  for select using (
    exists (
      select 1 from public.training_jobs j
      where j.id = job_id and public.owns_model(j.model_id)
    )
  );

-- model_artifacts: read-only for the owner. Only the worker inserts.
create policy "model_artifacts: owner select" on public.model_artifacts
  for select using (public.owns_model(model_id));

-- api_keys: the owner can create, list and revoke keys for their own models.
-- key_hash is written by the server action that generates the key.
create policy "api_keys: owner select" on public.api_keys
  for select using (auth.uid() = user_id);
create policy "api_keys: owner insert" on public.api_keys
  for insert with check (auth.uid() = user_id and public.owns_model(model_id));
create policy "api_keys: owner update" on public.api_keys
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "api_keys: owner delete" on public.api_keys
  for delete using (auth.uid() = user_id);

-- predictions_log: read-only for the model owner. The inference route inserts
-- with the secret key.
create policy "predictions_log: owner select" on public.predictions_log
  for select using (public.owns_model(model_id));

-- ---------------------------------------------------------------------------
-- 4. Worker functions
-- ---------------------------------------------------------------------------

-- Atomically claim the oldest queued job. Multiple workers can call this
-- concurrently; FOR UPDATE SKIP LOCKED guarantees each job is handed out once.
-- Returns zero rows when the queue is empty.
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
      order by created_at
      limit 1
      for update skip locked
   )
  returning j.*;
$$;

-- Reset jobs whose worker went silent. A claimed/running job with no
-- heartbeat for p_stale_after goes back to 'queued' unless it has already
-- used p_max_attempts, in which case it is failed for good.
-- Returns the number of jobs touched.
create or replace function public.reap_stale_jobs(
  p_stale_after interval default interval '5 minutes',
  p_max_attempts integer default 3
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  with stale as (
    select id, attempt from public.training_jobs
     where status in ('claimed', 'running')
       and coalesce(heartbeat_at, claimed_at, created_at) < now() - p_stale_after
     for update skip locked
  ),
  upd as (
    update public.training_jobs j
       set status = case when s.attempt >= p_max_attempts then 'failed'::public.job_status
                         else 'queued'::public.job_status end,
           error_message = case when s.attempt >= p_max_attempts
                                then 'worker stopped responding after ' || s.attempt || ' attempts'
                                else null end,
           claimed_by = null,
           claimed_at = null,
           heartbeat_at = null,
           finished_at = case when s.attempt >= p_max_attempts then now() else null end
      from stale s
     where j.id = s.id
    returning 1
  )
  select count(*) into n from upd;
  return n;
end;
$$;

-- These are worker-only. Browser sessions must not be able to call them.
revoke execute on function public.claim_training_job(text) from public, anon, authenticated;
revoke execute on function public.reap_stale_jobs(interval, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Realtime
--    The browser subscribes to training_metrics (loss curve) and to
--    training_jobs / models (status transitions). RLS still applies.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['training_metrics', 'training_jobs', 'models'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Storage
--    'datasets': user uploads, path '<user_id>/<dataset_id>.csv', 25 MB cap.
--    'models':   artifacts written by the worker, path '<user_id>/<model_id>/v<version>.json'.
--    Both private. Users may read their own folder in both; write only in datasets.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('datasets', 'datasets', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = 26214400;

insert into storage.buckets (id, name, public)
values ('models', 'models', false)
on conflict (id) do update set public = false;

-- storage.objects already has RLS enabled by Supabase.
-- (storage.foldername(name))[1] is the first path segment, i.e. the user id.
drop policy if exists "datasets: owner read"   on storage.objects;
drop policy if exists "datasets: owner insert" on storage.objects;
drop policy if exists "datasets: owner update" on storage.objects;
drop policy if exists "datasets: owner delete" on storage.objects;
drop policy if exists "models: owner read"     on storage.objects;

create policy "datasets: owner read" on storage.objects
  for select using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "datasets: owner insert" on storage.objects
  for insert with check (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "datasets: owner update" on storage.objects
  for update using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "datasets: owner delete" on storage.objects
  for delete using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "models: owner read" on storage.objects
  for select using (bucket_id = 'models' and (storage.foldername(name))[1] = auth.uid()::text);
