create extension if not exists "pgcrypto";

-- Datasets uploaded by users
create table if not exists public.datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  storage_path text not null,
  n_rows integer,
  n_features integer,
  target_column text,
  created_at timestamptz not null default now()
);

-- Training jobs
 do $$
begin
  create type job_status as enum ('queued', 'running', 'succeeded', 'failed');
exception
  when duplicate_object then null;
end $$;

create table if not exists public.training_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dataset_id uuid not null references public.datasets(id) on delete cascade,
  algorithm text not null,
  hyperparams jsonb not null default '{}',
  status job_status not null default 'queued',
  progress numeric not null default 0,
  metrics jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Per-epoch progress rows
create table if not exists public.job_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.training_jobs(id) on delete cascade,
  epoch integer,
  loss numeric,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Trained models
create table if not exists public.models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.training_jobs(id) on delete cascade,
  name text not null,
  version integer not null default 1,
  artifact_path text not null,
  input_schema jsonb,
  created_at timestamptz not null default now()
);

-- Row Level Security
alter table public.datasets enable row level security;
alter table public.training_jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.models enable row level security;

create policy "own datasets" on public.datasets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own jobs" on public.training_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own job events" on public.job_events
  for select using (
    exists (select 1 from public.training_jobs j
            where j.id = job_id and j.user_id = auth.uid())
  );

create policy "own models" on public.models
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Realtime
alter publication supabase_realtime add table public.training_jobs;
alter publication supabase_realtime add table public.job_events;
