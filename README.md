# Resume Screening System: Backend API

Node.js + Express + TypeScript API for **Resume Screening System**. It validates and analyzes resumes with Google Gemini, ranks candidates against jobs, enforces credits server-side and processes bulk uploads on a Postgres-backed job queue (Supabase, no Redis).

## Features

- **Resume validation before any credit is spent**: page count (max 5), text length (300 to 25,000 chars), resume-signal check (contact, section headings incl. Hindi, date ranges), AI `is_resume` verdict, 15 rejected uploads per user per 24 h. Long valid resumes are flagged `truncated`, never cut silently.
- **Bulk upload**: up to 50 files or one ZIP (max 50 entries, 50 MB packed / 100 MB unpacked, no nested archives, no path traversal). Returns `202` + batch id immediately.
- **Background worker** inside the API process: `claim_next_jobs` with `FOR UPDATE SKIP LOCKED`, concurrency 4, 90 s per item, exponential backoff + jitter for Gemini 429/5xx/timeouts (max 3 attempts), stuck-job recovery, graceful SIGTERM.
- **Credits that never go wrong**: `reserve_credits` reserves a whole batch atomically, `refund_credit` gives 1 credit back per failed / rejected / duplicate / cancelled item and is idempotent (unique REFUND per job). Startup + daily reconciliation logs any profile whose balance differs from its ledger.
- **Duplicates are free**: same file (sha256) per user, and the same candidate (email/phone) inside one job.
- **Explainable, consistent scoring**: temperature 0 + fixed seed + written rubrics. Match score = 50% skill coverage (computed in code with a synonym map) + 20% experience fit + 30% AI judgment. `scoring_version` and model are stored on every result.
- **Recruiter tools**: candidate status (`new / shortlisted / on_hold / rejected`), CSV export with formula-injection escaping, bulk detach / delete, data export (JSON) and delete-all.
- **Ops**: structured JSON logs with request id / batch id (no PII, no resume text), `/health` with queue depth and oldest queued job age, per-user rate limits.

## Credit prices (fixed)

| Action | Cost |
|---|---|
| Resume upload + analysis | 1 credit |
| Ranking | 1 credit per resume ranked (re-rank charges again) |
| AI job description | 1 credit |

Rejected files, duplicates, failures and cancelled items are refunded automatically.

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`.

| Name | Notes |
|---|---|
| `PORT`, `NODE_ENV`, `FRONTEND_URL` | `FRONTEND_URL` is a comma-separated list of allowed origins |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase project |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only, bypasses RLS |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Default model `gemini-flash-lite-latest` |
| `SUPABASE_STORAGE_BUCKET` | `resumes` |
| `MAX_RESUME_FILE_SIZE` | `5242880` (5 MB) |
| `WORKER_ENABLED` | `true` (set `false` to run an API-only instance) |
| `WORKER_CONCURRENCY`, `WORKER_POLL_MS` | Defaults `4`, `1500` |
| `AI_MOCK_MODE` | Local load tests only; ignored when `NODE_ENV=production` |

## Database

Migrations live in `supabase/migrations` (apply in order, never edit an applied one). The bulk/credit work is in `20261117160000_bulk_queue_credits_scoring.sql`:

- tables `upload_batches`, `processing_jobs`, `upload_rejections` (RLS on, users can only SELECT their own rows, writes via the service role)
- `resumes.file_hash` (unique per user), `content_truncated`, `document_type`; `job_matches.candidate_status`, score breakdown, `scoring_version`, `ai_model`; cached `jobs.requirements_json`
- RPCs `reserve_credits`, `refund_credit`, `claim_next_jobs`, `requeue_stale_jobs`, `refresh_batch`, `queue_health`, `reconcile_credits` (all SECURITY DEFINER with a pinned `search_path`, executable by `service_role` only)

## API (all under `/api`, Bearer token required)

| Method | Route | Notes |
|---|---|---|
| GET | `/health` | public; includes `queue` and `worker` |
| GET / DELETE | `/auth/me`, `/auth/account` | |
| POST | `/resumes` | single upload (multipart `file`) |
| GET / DELETE | `/resumes`, `/resumes/:id` | |
| POST | `/resumes/bulk-delete` | `{ resumeIds }`, deletes rows + stored files |
| POST | `/batches/upload` | multipart `files[]` (max 50) **or** `zip`, plus `consent=true` → `202 { batch }` |
| GET | `/batches`, `/batches/:id` | list / poll (per-item status) |
| POST | `/batches/:id/cancel`, `/batches/:id/retry-failed` | |
| POST / GET / DELETE | `/jobs`, `/jobs/:id` | |
| POST | `/jobs/:id/attach`, `/jobs/:id/detach`, `/jobs/:id/detach/:resumeId` | |
| POST | `/jobs/:id/rank` | `202 { batch }`, runs on the queue |
| PATCH | `/jobs/:id/candidates/status` | `{ resumeIds, status }` |
| GET | `/jobs/:id/export.csv?blind=1` | |
| POST | `/jobs/generate-description` | |
| GET | `/credits/balance`, `/credits/history` | |
| GET / PUT | `/preferences` | |
| GET / POST / DELETE | `/reports`, `/reports/:id/export` | |
| GET / DELETE | `/data/export`, `/data/resumes` | delete needs `{ "confirm": "DELETE" }` |

Errors use `{ success: false, error: { code, message, ...details } }`. Codes include `TOO_MANY_PAGES`, `TOO_LITTLE_TEXT`, `TOO_LONG_NOT_A_RESUME`, `NOT_A_RESUME` (+ `documentType`), `DUPLICATE_RESUME`, `INSUFFICIENT_CREDITS` (402), `TOO_MANY_REJECTED_UPLOADS` (429), `RANKING_IN_PROGRESS` (409), `ZIP_*`.

Rate limits: 300 requests / 15 min per IP on `/api` (batch polling excluded), 30 AI actions / min per user, 20 batches / hour per user, 120 status polls / min per user.

## Local development

```bash
npm install
npm run dev        # tsx watch, port from PORT
npm run lint       # tsc --noEmit
npm run build      # tsc -> dist/
npm test           # vitest: validator, credits, dedupe, scoring, ZIP safety, CSV escaping
```

Scripts (run against a running server; they create `@example.com` test users and only upload generated fake resumes):

```bash
API_URL=http://localhost:3000 npm run smoke          # end-to-end API smoke test (real Gemini)
npm run check:consistency                             # same resume + JD scored 3x, must stay within ±5
AI_MOCK_MODE=true PORT=3005 npm run dev               # mock-AI server for load tests
API_URL=http://localhost:3005 npm run load:test       # 60 fake resumes, checks final states, ledger, latency
API_URL=http://localhost:3005 npx tsx scripts/edgeCases.ts   # cancel, ZIP, dedupe, 409, 429
```

## Deploy (Railway)

`railway.json` runs `npm start` (`dist/server.js`) with health check `/health`. Set the environment variables above in Railway. The worker runs in the same process; for more throughput run more replicas (the queue is safe with several workers) or raise `WORKER_CONCURRENCY` within your Gemini quota.
