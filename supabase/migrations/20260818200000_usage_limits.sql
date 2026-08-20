-- Usage limits and rate limiting.
--
-- Everything here is enforced in Postgres so it holds no matter how the client
-- reaches Supabase (our server actions, a script with a user's JWT, curl).
--
--   * public.app_limits        one row per tunable limit; change with an UPDATE
--   * public.rate_limit_events append-only log used for sliding-window limits.
--                              Users cannot read or delete it, so creating and
--                              deleting rows in a loop does not reset a window.
--   * triggers on datasets / training_jobs that raise SQLSTATE 54000
--     (program_limit_exceeded) with a user-readable message
--   * storage.objects insert/update policies for the 'datasets' bucket now
--     require the object to be exactly the next expected file of one of the
--     caller's datasets, so a user cannot write arbitrary objects into their
--     folder without going through the dataset limits.
--
-- The worker and seed scripts use the secret key (auth.uid() is null); limits
-- are only applied to authenticated user sessions.
--
-- Privilege model: the trigger functions and assert_rate_limit are
-- SECURITY DEFINER because they must read/write rate_limit_events, which no
-- user role may touch. limit_value and is_own_dataset_object are plain
-- SECURITY INVOKER: the first reads app_limits (readable by authenticated),
-- the second reads datasets under the caller's own RLS, which is exactly the
-- scoping we want.

-- ---------------------------------------------------------------------------
-- 1. Tunable limits
-- ---------------------------------------------------------------------------
create table if not exists public.app_limits (
  key         text primary key,
  value       integer not null check (value >= 0),
  description text not null,
  updated_at  timestamptz not null default now()
);

alter table public.app_limits enable row level security;

-- Anyone signed in may read limits (the UI shows "2 of 3 datasets").
-- Nobody writes through the API; change values with SQL / a migration.
drop policy if exists "app_limits: authenticated read" on public.app_limits;
create policy "app_limits: authenticated read" on public.app_limits
  for select to authenticated using (true);

insert into public.app_limits (key, value, description) values
  ('max_datasets_per_user',    3,  'Datasets a user may have at once (any status). Delete one to upload another.'),
  ('dataset_uploads_per_hour', 10, 'Dataset rows a user may create per rolling hour.'),
  ('dataset_edits_per_hour',   30, 'Missing-value edits (CSV rewrites) a user may make per rolling hour.'),
  ('training_jobs_per_hour',   10, 'Training jobs a user may enqueue per rolling hour.')
on conflict (key) do nothing;

create or replace function public.limit_value(p_key text)
returns integer
language sql
stable
set search_path = public
as $$
  select value from public.app_limits where key = p_key
$$;

-- ---------------------------------------------------------------------------
-- 2. Rate-limit event log
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  action     text not null,
  created_at timestamptz not null default now()
);
create index if not exists rate_limit_events_lookup_idx
  on public.rate_limit_events (user_id, action, created_at desc);

-- RLS on with no policies: users can neither read nor write. Only the
-- security-definer function below (and the service role) touch this table.
alter table public.rate_limit_events enable row level security;

-- Sliding-window check: raises if p_user has already performed p_action
-- limit_value(p_limit_key) times within p_window, otherwise records the event.
-- p_window_label is the human word for the window ('hour') used in the error
-- message; interval::text would render as '01:00:00'.
-- Serialized per (user, action) with an advisory lock so concurrent requests
-- cannot both slip under the limit.
drop function if exists public.assert_rate_limit(uuid, text, text, interval);
create or replace function public.assert_rate_limit(
  p_user         uuid,
  p_action_label text,
  p_limit_key    text,
  p_window       interval,
  p_window_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer;
  v_count integer;
begin
  v_limit := public.limit_value(p_limit_key);
  if v_limit is null then
    raise exception 'assert_rate_limit: unknown limit key %', p_limit_key;
  end if;

  perform pg_advisory_xact_lock(hashtext('rate_limit:' || p_user::text || ':' || p_limit_key));

  -- Opportunistic cleanup of this user's expired events (keeps the table small).
  delete from public.rate_limit_events
   where user_id = p_user and action = p_limit_key and created_at < now() - p_window;

  select count(*) into v_count
    from public.rate_limit_events
   where user_id = p_user and action = p_limit_key and created_at >= now() - p_window;

  if v_count >= v_limit then
    raise exception using
      errcode = '54000',
      message = format('Rate limit reached: at most %s %s per %s. Try again later.',
                       v_limit, p_action_label, p_window_label),
      hint = p_limit_key;
  end if;

  insert into public.rate_limit_events (user_id, action) values (p_user, p_limit_key);
end;
$$;
revoke execute on function public.assert_rate_limit(uuid, text, text, interval, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------

-- datasets: cap on total rows per user + upload rate limit.
create or replace function public.datasets_enforce_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max   integer;
  v_count integer;
begin
  -- Only user sessions are limited; the worker / seed use the secret key.
  if auth.uid() is null then
    return new;
  end if;

  v_max := public.limit_value('max_datasets_per_user');
  -- Serialize per user so two concurrent inserts cannot both pass the count.
  perform pg_advisory_xact_lock(hashtext('datasets:' || new.user_id::text));

  select count(*) into v_count from public.datasets where user_id = new.user_id;
  if v_count >= v_max then
    raise exception using
      errcode = '54000',
      message = format('Dataset limit reached: you can keep at most %s dataset%s. Delete one to upload another.',
                       v_max, case when v_max = 1 then '' else 's' end),
      hint = 'max_datasets_per_user';
  end if;

  perform public.assert_rate_limit(new.user_id, 'dataset uploads', 'dataset_uploads_per_hour', interval '1 hour', 'hour');
  return new;
end;
$$;

drop trigger if exists datasets_enforce_limits on public.datasets;
create trigger datasets_enforce_limits
  before insert on public.datasets
  for each row execute function public.datasets_enforce_limits();

-- datasets: each CSV rewrite (missing-values editor) repoints storage_path.
create or replace function public.datasets_enforce_edit_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or new.storage_path is not distinct from old.storage_path then
    return new;
  end if;
  perform public.assert_rate_limit(new.user_id, 'dataset edits', 'dataset_edits_per_hour', interval '1 hour', 'hour');
  return new;
end;
$$;

drop trigger if exists datasets_enforce_edit_rate on public.datasets;
create trigger datasets_enforce_edit_rate
  before update of storage_path on public.datasets
  for each row execute function public.datasets_enforce_edit_rate();

-- training_jobs: enqueue rate limit (each job runs the worker).
create or replace function public.training_jobs_enforce_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
begin
  if auth.uid() is null then
    return new;
  end if;
  select user_id into v_user from public.models where id = new.model_id;
  if v_user is null then
    return new; -- FK will reject; nothing to rate limit
  end if;
  perform public.assert_rate_limit(v_user, 'training jobs', 'training_jobs_per_hour', interval '1 hour', 'hour');
  return new;
end;
$$;

drop trigger if exists training_jobs_enforce_limits on public.training_jobs;
create trigger training_jobs_enforce_limits
  before insert on public.training_jobs
  for each row execute function public.training_jobs_enforce_limits();

-- ---------------------------------------------------------------------------
-- 4. Storage: an object in 'datasets' must be the next expected file of one
--    of the caller's datasets. For dataset <id> owned by the caller, exactly
--    one name is writable at any time:
--      <uid>/<id>.csv          while status = 'uploading' (the reserved upload)
--      <uid>/<id>.v<k+1>.csv   while status = 'ready', where k is the version
--                              currently in storage_path (0 for the original)
--    So each dataset row admits one object per successful edit, and edits are
--    themselves rate-limited by the storage_path trigger above.
--    SECURITY INVOKER on purpose: it reads public.datasets under the caller's
--    own RLS, so it can only ever match rows the caller owns.
-- ---------------------------------------------------------------------------
create or replace function public.is_own_dataset_object(p_name text)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.datasets d
     where d.user_id = auth.uid()
       and p_name = case d.status
             when 'uploading' then d.user_id::text || '/' || d.id::text || '.csv'
             when 'ready'     then d.user_id::text || '/' || d.id::text || '.v'
                                   || (coalesce(substring(d.storage_path from '\.v(\d+)\.csv$')::int, 0) + 1)::text
                                   || '.csv'
           end
  )
$$;
revoke execute on function public.is_own_dataset_object(text) from public, anon;
grant  execute on function public.is_own_dataset_object(text) to authenticated;

drop policy if exists "datasets: owner insert" on storage.objects;
create policy "datasets: owner insert" on storage.objects
  for insert
  with check (
    bucket_id = 'datasets'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_own_dataset_object(name)
  );

drop policy if exists "datasets: owner update" on storage.objects;
create policy "datasets: owner update" on storage.objects
  for update
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (
    bucket_id = 'datasets'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_own_dataset_object(name)
  );
