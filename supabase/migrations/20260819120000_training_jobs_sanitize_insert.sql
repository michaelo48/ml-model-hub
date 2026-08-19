-- Browser inserts into training_jobs are the enqueue path. The insert policy
-- pins status = 'queued' and claimed_by is null, but every other column was
-- client-writable: a user could send created_at = '1970-01-01' and have all
-- their jobs claimed ahead of everyone else's (claim_training_job orders by
-- created_at), or attempt = -1000 for unlimited retries, or attempt = 3 to
-- have the reaper fail the job on its first stall.
--
-- Fix at the trigger level, like the usage-limits trigger: when the insert
-- comes from an authenticated session (auth.uid() is not null) the server
-- decides created_at and attempt and blanks every worker-owned timestamp and
-- the error message. status and claimed_by stay with the policy's WITH CHECK
-- so a client that sends them gets a loud rejection rather than a silent
-- correction. The worker uses the secret key (auth.uid() is null) and is
-- untouched; that is what lets tests backdate rows as admin while proving
-- users cannot.

create or replace function public.training_jobs_sanitize_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  new.created_at    := now();
  new.attempt       := 0;
  new.claimed_at    := null;
  new.started_at    := null;
  new.finished_at   := null;
  new.heartbeat_at  := null;
  new.error_message := null;
  return new;
end;
$$;

drop trigger if exists training_jobs_0_sanitize_insert on public.training_jobs;
-- Named to sort before training_jobs_enforce_limits (triggers fire in name
-- order); the rate limit then sees the sanitized row.
create trigger training_jobs_0_sanitize_insert
  before insert on public.training_jobs
  for each row execute function public.training_jobs_sanitize_insert();

-- Browser sessions cannot update training_jobs at all (no update policy), so
-- insert is the only path that needed sanitizing.
