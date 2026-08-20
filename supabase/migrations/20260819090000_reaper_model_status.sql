-- The worker owns models.status while a job runs (training -> succeeded /
-- failed / queued). The one path where the worker is not alive to do that is
-- the reaper: a job with a dead worker was requeued or failed, but the model
-- stayed 'training' forever. Mirror the job transition onto the model here.
--
-- Guarded by a status check so a reaped-then-reclaimed job whose new worker
-- has already advanced the model is not regressed.

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
    select id, model_id, attempt from public.training_jobs
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
           started_at = null,
           finished_at = case when s.attempt >= p_max_attempts then now() else null end
      from stale s
     where j.id = s.id
    returning j.id, j.model_id, j.status
  ),
  upd_models as (
    update public.models m
       set status = case when u.status = 'failed' then 'failed'::public.model_status
                         else 'queued'::public.model_status end
      from upd u
     where m.id = u.model_id
       and m.status in ('queued', 'training')
    returning 1
  )
  select count(*) into n from upd;
  return n;
end;
$$;

revoke execute on function public.reap_stale_jobs(interval, integer) from public, anon, authenticated;
