# Project Spec: ModelForge — Mini ML Model Serving Platform

> **Handoff note for Claude Code:** This is a greenfield project. Read this entire spec before writing code. Follow the phase order — do not build Phase 2+ features until Phase 1 is working end-to-end. Ask clarifying questions before making architectural decisions not covered here.

---

## 1. Overview

ModelForge is a web platform where a user uploads a tabular dataset (CSV), configures and trains a machine learning model as a background job with live training progress, and then gets a hosted REST inference endpoint for the trained model. Think "mini SageMaker" scoped to classical ML on small tabular datasets.

**Why this project exists:** It is a resume/portfolio project for a CS graduate student who has already implemented OLS, batch gradient descent, SGD, and Adam from scratch in TypeScript (in a prior project, "ML Playground"). This project converts that from-scratch ML work into systems engineering: job orchestration, background workers, artifact storage, model versioning, API key auth, and deployment. The training algorithms are intentionally simple; the infrastructure around them is the point.

**Guiding principle:** One core workflow (upload → train → predict) working end-to-end, deployed, and demo-able. Scope ruthlessly.

## 2. Tech Stack (fixed — do not substitute)

- **Framework:** Next.js 15+ (App Router, TypeScript, Server Components where sensible)
- **Backend:** Supabase (Postgres, Auth, Row Level Security, Storage, Realtime)
- **Training worker:** A separate long-running Node.js + TypeScript service (deployed on Fly.io or Railway). Training math is implemented from scratch in TypeScript — no TensorFlow/ONNX/Python. The author will port/adapt his existing optimizer implementations.
- **Styling:** Tailwind CSS
- **Charts:** Custom SVG or Recharts (author has strong SVG/viz experience — the live loss curve should be custom SVG)
- **Validation:** Zod on all API inputs and form submissions
- **CSV parsing:** papaparse (client preview) and a streaming parser in the worker
- **Deployment target:** Vercel (frontend) + Supabase cloud + Fly.io/Railway (worker)
- **Package manager:** pnpm, monorepo with two packages: `apps/web` and `apps/worker`, shared `packages/ml` for the training/inference math

**Supabase key usage (important):**
- Use the **new key format**: `sb_publishable_...` in client code (env var `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`); `sb_secret_...` only in server-side code — Next.js route handlers and the worker (env var `SUPABASE_SECRET_KEY`, never prefixed `NEXT_PUBLIC_`).
- The worker authenticates to Supabase with the secret key; it is a trusted backend service.
- Provide a `.env.example` in both apps with placeholder values and comments.
- **RLS must be enabled on every table in the public schema. No exceptions.** Tables without policies deny all access by default.

## 3. Users & Auth

Single role: a signed-in user who owns datasets, models, and API keys. No teams, no sharing, no admin role in v1. Email/password auth via Supabase Auth (magic link optional). Public marketing/landing page; everything else behind auth.

Inference endpoints are authenticated differently: per-model API keys (see §5), because callers are external programs, not browser sessions.

## 4. Data Model

Design the schema in SQL migration files (`supabase/migrations/`). Suggested starting point — refine as needed but keep it normalized:

- `profiles` — 1:1 with `auth.users` (display name). Created via trigger on signup.
- `datasets` — owner user_id, name, storage_path (Supabase Storage), size_bytes, row_count, column metadata JSONB (name, inferred type, sample values), status (`uploading` | `ready` | `invalid`), created_at.
- `models` — owner user_id, dataset_id, name, task (`regression` | `binary_classification`), algorithm (`linear_regression` | `logistic_regression`), target_column, feature_columns text[], hyperparameters JSONB (optimizer: `ols` | `sgd` | `batch_gd` | `adam`; learning_rate; epochs; batch_size; l2), status (`draft` | `queued` | `training` | `succeeded` | `failed`), created_at.
- `training_jobs` — model_id, status (`queued` | `claimed` | `running` | `succeeded` | `failed`), claimed_by (worker instance id), claimed_at, started_at, finished_at, error_message, attempt count.
- `training_metrics` — job_id, epoch, loss, val_loss, elapsed_ms. Inserted by the worker; streamed to the UI via Supabase Realtime.
- `model_artifacts` — model_id, version, storage_path (JSON artifact: weights, feature normalization stats, column order), metrics JSONB (final train/val loss, R² or accuracy/AUC), created_at. A model can be retrained, producing a new version; predictions use the latest version by default.
- `api_keys` — owner user_id, model_id, key_prefix (first 8 chars, displayed), key_hash (SHA-256 of full key — never store plaintext), created_at, revoked_at nullable.
- `predictions_log` — model_id, api_key_id, created_at, latency_ms, input_row_count, status_code. For the usage dashboard; no request bodies stored.

**Job queue mechanics:** The queue is the `training_jobs` table. The worker polls (or subscribes via Realtime) for `queued` jobs and claims one atomically with `UPDATE ... SET status = 'claimed', claimed_by = $1 WHERE id = (SELECT id FROM training_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. Include a stale-job reaper: claimed/running jobs with no heartbeat for N minutes get reset to `queued` (bounded retries, then `failed`).

**RLS policy requirements (showcase piece — write carefully, comment intent):**
- Users can read/write only their own datasets, models, jobs, metrics, keys, and logs.
- The worker uses the secret key (bypasses RLS) — RLS protects the browser path only; document this distinction in the SQL comments.
- `training_metrics` must be readable by the model owner so Realtime subscriptions work under RLS.

## 5. Features by Phase

### Phase 1 — Core loop (must be fully working and deployed before anything else)
1. Auth + profile creation.
2. Dataset upload: client-side CSV preview (first 50 rows, inferred column types) → upload to Supabase Storage → server validates and writes column metadata. Limits: ≤ 25 MB, ≤ 100k rows, enforced server-side.
3. Model builder: pick dataset → task → target column → feature columns → algorithm + hyperparameters (form defaults must be sensible). Creates model in `draft`, "Train" enqueues a job.
4. Worker: claims job, streams the CSV from Storage, normalizes features, trains with the selected optimizer, writes a `training_metrics` row per epoch, uploads the artifact, marks job `succeeded`. Handles bad data (non-numeric features, missing values → fail with a clear error message in v1).
5. Training page: live loss curve updating via Realtime as epochs complete, status transitions, error display on failure.
6. Model detail page: final metrics, hyperparameters, artifact versions.
7. Inference endpoint: `POST /api/v1/models/:id/predict` on the Next.js app. Auth via `Authorization: Bearer <api_key>`; validates the hashed key, loads the latest artifact (cache in memory with LRU), applies stored normalization, returns predictions. Accepts a JSON array of feature objects (≤ 100 rows per request).
8. API key management UI: generate (show full key once), list by prefix, revoke.
9. Deployed: web on Vercel, worker on Fly.io/Railway, live URL in README.

### Phase 2 — Usability & depth
1. Train/validation split (user-configurable %, seeded shuffle) with val_loss on the live chart.
2. Model versioning UI: retrain, compare versions' metrics side by side, pin the serving version.
3. Usage dashboard: requests over time, latency p50/p95, per-key breakdown (from `predictions_log`).
4. A "Try it" panel on the model page: build a request from the feature schema, send it against the real endpoint, show the curl equivalent.
5. Copyable code snippets (curl, Python, JS) for the inference endpoint.

### Phase 3 — Stretch (only if 1–2 are solid)
1. k-means as a third algorithm (unsupervised path: no target column; artifact stores centroids; predict returns cluster assignment).
2. Basic input-drift stat on the dashboard: compare recent prediction input distributions to training distributions per feature (simple mean/std shift, no ML).
3. Rate limiting on the inference endpoint (per key, token bucket in Postgres or Upstash).
4. Playwright e2e test of the core loop with a tiny fixture CSV.

## 6. Non-Goals (do not build)

- Deep learning, GPU anything, Python runtimes, ONNX
- Large datasets (> 25 MB), streaming/online training
- AutoML, hyperparameter search
- Teams, sharing, public model galleries
- Payments or quotas beyond basic rate limiting
- Fine-grained IAM — one user role only

## 7. Architecture & Code Conventions

- Monorepo layout: `apps/web`, `apps/worker`, `packages/ml` (pure functions: fit/predict per algorithm, normalization, metrics; fully unit-tested — this package is the author's from-scratch ML showcase and must have no Supabase imports).
- Web reads: Supabase client under RLS from Server Components. Web writes: server actions / route handlers with Zod validation. Inference route and worker use the secret key.
- Worker: single entry point, graceful shutdown, heartbeat updates on running jobs, structured JSON logging.
- Every server action returns a typed result (`{ ok: true, data } | { ok: false, error }`); surface errors with toasts.
- No `any` types. Strict TypeScript. Unit tests required for `packages/ml` (compare against known closed-form solutions, e.g. OLS on a fixture).
- Seed script: demo account with one sample dataset (e.g. a small housing CSV committed as a fixture) and one trained model so the deployed demo has content.
- README with: project description, architecture diagram (Mermaid: browser → Next.js → Supabase ← worker), local setup for both apps, env var tables, deployed URL, and a curl example against the live inference endpoint.

## 8. UI & Design Direction

**Act as a senior product designer, not a template generator.** Every visual decision should be deliberate and defensible. The design system should be the most minimal system possible that still scales: a small set of tokens (spacing scale, type scale, 2–3 neutrals, one accent, semantic success/warning/danger) defined once in Tailwind config / CSS variables, and reused everywhere. If a component or token isn't needed by an actual screen in this spec, don't create it.

### Core direction
- Clean, dense, dashboard-style. Utilitarian and confident, like internal tooling built by people with taste (think Linear's restraint, not its aesthetic).
- Typography does the heavy lifting: a strong type hierarchy with weight and size, not decoration. Pick one distinctive typeface with real character (a good serif or humanist sans is fine) — see banned list below for what not to use. A monospace face is appropriate for metrics, keys, and code snippets.
- Color is functional, not decorative: neutrals for structure, the single accent for primary actions and focus, semantic colors only for meaning (job status, errors).
- The training page is the most important UI in the app: the live loss curve should feel immediate and precise — clean axes, direct labeling, no clipped labels, sensible tick spacing.
- Tables (datasets, versions, API keys, usage) should be dense, aligned, and scannable.

### Banned design patterns (do not use any of these)
This project must not look AI-generated. The following are explicitly prohibited:

- Harsh or multi-stop gradients; rainbow coloring; neon colors; basic pastel palettes; purple-and-black color schemes
- Radial glow orbs, dot-grid backgrounds, "liquid glass" / glassmorphism effects
- Drop shadows as the default elevation strategy (use borders and background shifts instead)
- Pure white (#FFFFFF) page backgrounds — use a warm or cool off-white / near-black instead
- Lucide icons, sparkle icons, animated arrows, hover animations beyond simple color/opacity state changes
- Emojis anywhere in the UI
- Em dashes in UI copy — use periods, commas, or parentheses
- The "It's not X, it's Y" copywriting formula anywhere in marketing or empty-state text
- Checkmark bullet lists as a layout device
- Three-feature-cards-in-a-row layouts; bento grids; colored left-stripe cards
- Decorative terminal windows / fake code screenshots (real, functional code snippets in §5 Phase 2 are fine)
- Soft/large corner radii everywhere (keep radii small and consistent, e.g. 2–6px, or square)
- Skeleton loaders (use subtle inline spinners or instant optimistic UI instead)
- Inter, Geist, and Space Grotesk fonts

When in doubt, remove the element rather than style it. Whitespace, alignment, and hierarchy should carry the design.

## 9. Definition of Done (per phase)

- Builds with zero TypeScript errors and zero ESLint warnings; `packages/ml` unit tests pass.
- All tables have RLS enabled with policies; verify with a manual test (document steps in `docs/rls-testing.md`).
- The full loop works on the deployed environment: upload a CSV, train, watch live metrics, call the inference endpoint with curl using a generated API key.
- README complete per §7; demo account credentials documented.

## 10. Suggested First Steps for Claude Code

1. Scaffold the monorepo (pnpm workspaces), Next.js + Tailwind in `apps/web`, worker skeleton in `apps/worker`, `packages/ml` with a tested OLS implementation, `.env.example` files, README skeleton.
2. Write all Phase 1 migrations + RLS policies + seed script; test policies before building UI.
3. Build auth flow and middleware.
4. Build dataset upload + validation, then the model builder.
5. Build the worker's claim/train/report loop against a fixture dataset; verify Realtime metrics reach the browser.
6. Build the inference route + API keys.
7. Deploy both apps, run the full loop live, then stop and review before Phase 2.