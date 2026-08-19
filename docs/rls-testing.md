# RLS testing

Every table in `public` has Row Level Security enabled. This document is the
manual test plan for confirming the policies do what they claim, and a record
of the last run.

## Access model

| Path | Key | RLS applies? | Who |
| --- | --- | --- | --- |
| Browser and Server Components / server actions | publishable + user JWT | yes | signed-in user |
| Worker | secret | no (bypasses) | trusted backend |
| Inference route (`/api/v1/models/:id/predict`) | secret | no (bypasses) | authenticated by API key, scoped in code |

Because the worker and inference route bypass RLS, the policies protect the
browser path only. Server code using the secret key must scope its own queries.

## What the policies say

| Table | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| `profiles` | own | trigger only | own | no |
| `datasets` | own | own | own | own |
| `models` | own | own, and dataset must be own | own | own |
| `training_jobs` | via own model | via own model, `status='queued'`, `claimed_by is null` | no (worker) | no (worker) |
| `training_metrics` | via own job -> model | no (worker) | no | no |
| `model_artifacts` | via own model | no (worker) | no | no |
| `api_keys` | own | own, and model must be own | own | own |
| `predictions_log` | via own model | no (server) | no | no |
| `app_limits` | all (authenticated) | no | no | no |
| `rate_limit_events` | no | no (trigger only) | no | no |

Storage:

| Bucket | user select | user insert/update/delete |
| --- | --- | --- |
| `datasets` | own folder (`<user_id>/...`) | own folder, and only the next expected object of one of the user's `datasets` rows: `<user_id>/<dataset_id>.csv` while `status = 'uploading'`, or `<user_id>/<dataset_id>.v<k+1>.csv` while `ready` where `k` is the version currently in `storage_path` |
| `models` | own folder | no (worker writes) |

Worker-only functions: `claim_training_job(text)`, `reap_stale_jobs(interval, int)`,
`assert_rate_limit(uuid, text, text, interval, text)`. `EXECUTE` is revoked from
`anon` and `authenticated`.

## Usage limits (`*_usage_limits.sql`)

Limits are enforced by `BEFORE` triggers running as `security definer`, so
they hold for any client using a user JWT. Sessions without `auth.uid()`
(worker, seed script) are exempt. Values live in `public.app_limits`:

| key | default | enforced on |
| --- | --- | --- |
| `max_datasets_per_user` | 3 | `datasets` insert: total rows per user, any status (uploads that fail validation are deleted, so they do not count) |
| `dataset_uploads_per_hour` | 10 | `datasets` insert: sliding 1 h window |
| `dataset_edits_per_hour` | 30 | `datasets` update of `storage_path` (missing-values rewrites) |
| `training_jobs_per_hour` | 10 | `training_jobs` insert, keyed by the model owner |

Change a limit with `update public.app_limits set value = 5 where key = 'max_datasets_per_user';`.
Rejections raise SQLSTATE `54000` with a user-readable message, e.g.
"Rate limit reached: at most 10 dataset uploads per hour. Try again later."; the
web app surfaces that message as-is and logs every other database error
server-side (`dbErrorMessage` in `apps/web/src/lib/limits.ts`). Windows are counted from `rate_limit_events`,
which users cannot read or delete, so create/delete churn does not reset them.
Concurrent requests are serialized per user with an advisory lock.

## Automated test

`pnpm test:rls` runs [apps/worker/test/rls.integration.test.ts](../apps/worker/test/rls.integration.test.ts)
against the linked project. It needs `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and
`SUPABASE_PUBLISHABLE_KEY` in `apps/worker/.env` and skips itself otherwise.
It creates two throwaway users, runs every check below, and deletes them.
Run it after any migration that touches policies or the worker functions.

## Manual test procedure

You need two users, A and B, and the secret key. The quickest way is a Node
script using `@supabase/supabase-js`:

1. Create A and B with `admin.auth.admin.createUser({ email_confirm: true })`.
2. Sign each in with `signInWithPassword` and build a client that sends that
   user's `access_token` as `Authorization: Bearer`.
3. As A: insert a dataset, a model on it, and a training job. All should succeed.
4. As B: try to insert a model on A's dataset, a job on A's model, an API key
   on A's model. All should fail (`new row violates row-level security`).
5. As B: select from `datasets`, `models`, `training_jobs`, `training_metrics`,
   `model_artifacts`, `predictions_log`. All should return zero rows.
6. As A: try to update the job's `status`. It should affect zero rows.
7. As A: call `rpc('claim_training_job')`. Expect `permission denied for function`.
8. As admin: call `claim_training_job` twice concurrently for one queued job.
   Exactly one call should return the row.
9. As admin: insert `training_metrics` for the job. A should read them; B should
   read none; A should not be able to insert one.
10. As admin: set `heartbeat_at` 10 minutes in the past, call
    `reap_stale_jobs('5 minutes', 3)`. Job returns to `queued`, `claimed_by` is
    null. Set `attempt = 3` and repeat: job becomes `failed` with an error message.
11. Storage, as A: upload to `datasets/<A>/x.csv` (ok). As B: upload to
    `datasets/<A>/y.csv` (fail), list `datasets/<A>` (empty). As A: upload to
    `models/<A>/x.json` (fail).
12. Delete both users with `admin.auth.admin.deleteUser`. Confirm their rows
    cascaded away.

## Last run

2026-08-18, `pnpm test:rls` against the linked project after
`20260818130000_review_fixes.sql`: 13 tests, 13 passed. Includes the check that a
user cannot move a storage object into another user's folder (UPDATE `WITH CHECK`).
