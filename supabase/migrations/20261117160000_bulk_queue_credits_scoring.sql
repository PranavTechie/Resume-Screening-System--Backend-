-- 2026-11-17: production-grade bulk processing.
--  * background job queue (processing_jobs) + batches (upload_batches)
--  * rejected-upload abuse cap (upload_rejections)
--  * atomic, idempotent credit reserve / refund RPCs
--  * duplicate detection (resumes.file_hash)
--  * versioned, explainable scoring + recruiter candidate status on job_matches
-- Every new SECURITY DEFINER function pins search_path and is executable by service_role ONLY.

-- ---------------------------------------------------------------------------
-- 1. Columns on existing tables (additive only)
-- ---------------------------------------------------------------------------
ALTER TABLE public.resumes
  ADD COLUMN IF NOT EXISTS file_hash text,
  ADD COLUMN IF NOT EXISTS content_truncated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS document_type text;

-- One copy of the same file (sha256 of bytes) per user.
CREATE UNIQUE INDEX IF NOT EXISTS resumes_user_file_hash_key
  ON public.resumes (user_id, file_hash) WHERE file_hash IS NOT NULL;

ALTER TABLE public.resume_analyses
  ADD COLUMN IF NOT EXISTS scoring_version text,
  ADD COLUMN IF NOT EXISTS ai_model text;

-- Cached, deterministic JD requirements (extracted once per JD text hash).
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS requirements_json jsonb,
  ADD COLUMN IF NOT EXISTS requirements_hash text;

ALTER TABLE public.job_matches
  ADD COLUMN IF NOT EXISTS candidate_status text NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS experience_match_percentage integer,
  ADD COLUMN IF NOT EXISTS skill_coverage_percentage integer,
  ADD COLUMN IF NOT EXISTS ai_judgment_percentage integer,
  ADD COLUMN IF NOT EXISTS match_reason text,
  ADD COLUMN IF NOT EXISTS score_breakdown_json jsonb,
  ADD COLUMN IF NOT EXISTS scoring_version text,
  ADD COLUMN IF NOT EXISTS ai_model text;

ALTER TABLE public.job_matches
  ADD CONSTRAINT job_matches_candidate_status_check
  CHECK (candidate_status IN ('new', 'shortlisted', 'on_hold', 'rejected'));

-- A job (reference) can be refunded at most once.
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_refund_once
  ON public.credit_transactions (reference_id, type) WHERE type = 'REFUND';

-- ---------------------------------------------------------------------------
-- 2. New tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.upload_batches (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_id              uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  kind                text NOT NULL CHECK (kind IN ('analyze_resume', 'rank_resume')),
  total               integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  counts              jsonb NOT NULL DEFAULT '{}'::jsonb,
  credits_reserved    integer NOT NULL DEFAULT 0 CHECK (credits_reserved >= 0),
  credits_refunded    integer NOT NULL DEFAULT 0 CHECK (credits_refunded >= 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  consent_at          timestamptz,
  cancel_requested_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_upload_batches_user_created ON public.upload_batches (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_batches_job ON public.upload_batches (job_id) WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.processing_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  batch_id      uuid NOT NULL REFERENCES public.upload_batches(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('analyze_resume', 'rank_resume')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'processing', 'done', 'failed', 'rejected', 'duplicate', 'cancelled')),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 3,
  retry_round   integer NOT NULL DEFAULT 0,   -- bumped by "retry failed"; each round is charged/refunded once
  charged       boolean NOT NULL DEFAULT false, -- a credit is currently reserved for this item
  error_code    text,
  error_message text,
  result_ref    uuid,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_at     timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_queue ON public.processing_jobs (run_after, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_processing_jobs_processing ON public.processing_jobs (locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_processing_jobs_batch ON public.processing_jobs (batch_id);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_user ON public.processing_jobs (user_id);

CREATE TABLE IF NOT EXISTS public.upload_rejections (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  error_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_upload_rejections_user_created ON public.upload_rejections (user_id, created_at DESC);

-- RLS: users may READ their own rows; all writes go through the backend (service_role).
ALTER TABLE public.upload_batches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.processing_jobs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_rejections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own upload batches" ON public.upload_batches
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can view own processing jobs" ON public.processing_jobs
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can view own upload rejections" ON public.upload_rejections
  FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.upload_batches, public.processing_jobs, public.upload_rejections FROM anon, authenticated;
REVOKE ALL ON public.upload_batches, public.processing_jobs, public.upload_rejections FROM anon;

-- ---------------------------------------------------------------------------
-- 3. Credit RPCs
-- ---------------------------------------------------------------------------
-- Reserve p_amount credits up front. Locks the profile row, fails with INSUFFICIENT_CREDITS,
-- writes ONE DEDUCTION ledger row (reference = batch / reservation id).
CREATE OR REPLACE FUNCTION public.reserve_credits(
  p_user_id uuid, p_amount integer, p_batch_id uuid, p_description text DEFAULT 'Credit reservation'
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_credits integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: reservation amount must be positive';
  END IF;
  IF p_batch_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REFERENCE: reservation needs a reference id';
  END IF;

  SELECT credits INTO v_credits FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: profile does not exist';
  END IF;
  IF v_credits < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDITS: need %, available %', p_amount, v_credits;
  END IF;

  UPDATE public.profiles SET credits = credits - p_amount, updated_at = now()
  WHERE id = p_user_id RETURNING credits INTO v_credits;

  INSERT INTO public.credit_transactions (user_id, amount, type, description, reference_id)
  VALUES (p_user_id, -p_amount, 'DEDUCTION', left(coalesce(p_description, 'Credit reservation'), 200), p_batch_id::text);

  UPDATE public.upload_batches SET credits_reserved = credits_reserved + p_amount, updated_at = now()
  WHERE id = p_batch_id AND user_id = p_user_id;

  RETURN v_credits;
END;
$$;

-- Give 1 credit back for a processing job (or a single-upload reservation id).
-- Idempotent: the REFUND ledger row is unique per reference, so a job can never be refunded twice.
-- Returns the new balance, or NULL when nothing was refunded (already refunded / never charged).
CREATE OR REPLACE FUNCTION public.refund_credit(p_user_id uuid, p_job_id uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_job_user uuid;
  v_batch_id uuid;
  v_round    integer;
  v_charged  boolean;
  v_ref      text;
  v_rows     integer;
  v_credits  integer;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_REFERENCE: refund needs a job id';
  END IF;

  SELECT user_id, batch_id, retry_round, charged
    INTO v_job_user, v_batch_id, v_round, v_charged
  FROM public.processing_jobs WHERE id = p_job_id;

  IF FOUND THEN
    IF v_job_user <> p_user_id THEN
      RAISE EXCEPTION 'FORBIDDEN: job does not belong to user';
    END IF;
    IF NOT v_charged THEN
      RETURN NULL;
    END IF;
    v_ref := CASE WHEN v_round = 0 THEN p_job_id::text ELSE p_job_id::text || ':r' || v_round END;
  ELSE
    -- Single-upload / JD reservation: only refundable if that reservation was really charged.
    PERFORM 1 FROM public.credit_transactions
     WHERE user_id = p_user_id AND type = 'DEDUCTION' AND reference_id = p_job_id::text;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_ref := p_job_id::text;
  END IF;

  -- Serialize with reservations on the same profile.
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: profile does not exist';
  END IF;

  INSERT INTO public.credit_transactions (user_id, amount, type, description, reference_id)
  VALUES (p_user_id, 1, 'REFUND', left(coalesce(p_reason, 'Refund'), 200), v_ref)
  ON CONFLICT (reference_id, type) WHERE type = 'REFUND' DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN NULL;
  END IF;

  UPDATE public.profiles SET credits = credits + 1, updated_at = now()
  WHERE id = p_user_id RETURNING credits INTO v_credits;

  IF v_batch_id IS NOT NULL THEN
    UPDATE public.processing_jobs SET charged = false, updated_at = now() WHERE id = p_job_id;
    UPDATE public.upload_batches SET credits_refunded = credits_refunded + 1, updated_at = now() WHERE id = v_batch_id;
  END IF;

  RETURN v_credits;
END;
$$;

-- Log-only reconciliation: profiles whose balance differs from the ledger sum.
CREATE OR REPLACE FUNCTION public.reconcile_credits()
RETURNS TABLE (profile_id uuid, credits integer, ledger_total bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.credits, coalesce(sum(t.amount), 0)::bigint
  FROM public.profiles p
  LEFT JOIN public.credit_transactions t ON t.user_id = p.id
  GROUP BY p.id, p.credits
  HAVING p.credits <> coalesce(sum(t.amount), 0);
$$;

-- ---------------------------------------------------------------------------
-- 4. Queue RPCs
-- ---------------------------------------------------------------------------
-- Claim up to p_limit queued jobs (round-robin across users), FOR UPDATE SKIP LOCKED.
CREATE OR REPLACE FUNCTION public.claim_next_jobs(p_limit integer)
RETURNS SETOF public.processing_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT q.id, q.created_at,
           row_number() OVER (PARTITION BY q.user_id ORDER BY q.created_at) AS rn
    FROM public.processing_jobs q
    WHERE q.status = 'queued' AND q.run_after <= now()
    ORDER BY rn, q.created_at
    LIMIT GREATEST(p_limit, 1) * 20
  ), picked AS (
    SELECT pj.id
    FROM public.processing_jobs pj
    JOIN candidates c ON c.id = pj.id
    WHERE pj.status = 'queued'
    ORDER BY c.rn, c.created_at
    LIMIT GREATEST(p_limit, 1)
    FOR UPDATE OF pj SKIP LOCKED
  )
  UPDATE public.processing_jobs t
     SET status = 'processing', locked_at = now(), attempts = t.attempts + 1, updated_at = now()
    FROM picked
   WHERE t.id = picked.id
  RETURNING t.*;
END;
$$;

-- Stuck-job recovery: 'processing' rows locked longer than p_stale_seconds go back to 'queued',
-- or to 'failed' when attempts are used up (caller refunds those).
CREATE OR REPLACE FUNCTION public.requeue_stale_jobs(p_stale_seconds integer DEFAULT 300)
RETURNS TABLE (job_id uuid, job_user_id uuid, job_batch_id uuid, new_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.processing_jobs t
     SET status        = CASE WHEN t.attempts >= t.max_attempts THEN 'failed' ELSE 'queued' END,
         error_code    = CASE WHEN t.attempts >= t.max_attempts THEN 'PROCESSING_TIMEOUT' ELSE t.error_code END,
         error_message = CASE WHEN t.attempts >= t.max_attempts THEN 'Processing took too long and was stopped.' ELSE t.error_message END,
         locked_at     = NULL,
         run_after     = now(),
         updated_at    = now()
   WHERE t.status = 'processing'
     AND t.locked_at < now() - make_interval(secs => GREATEST(p_stale_seconds, 30))
  RETURNING t.id, t.user_id, t.batch_id, t.status;
END;
$$;

-- Recompute per-status counts and the batch status from its items.
CREATE OR REPLACE FUNCTION public.refresh_batch(p_batch_id uuid)
RETURNS public.upload_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_counts jsonb;
  v_active integer;
  v_cancelled integer;
  v_batch public.upload_batches;
BEGIN
  SELECT coalesce(jsonb_object_agg(s, c), '{}'::jsonb) INTO v_counts
  FROM (SELECT status AS s, count(*) AS c FROM public.processing_jobs WHERE batch_id = p_batch_id GROUP BY status) x;

  v_active    := coalesce((v_counts->>'queued')::int, 0) + coalesce((v_counts->>'processing')::int, 0);
  v_cancelled := coalesce((v_counts->>'cancelled')::int, 0);

  UPDATE public.upload_batches b
     SET counts       = v_counts,
         status       = CASE WHEN v_active > 0 THEN 'active'
                             WHEN b.cancel_requested_at IS NOT NULL AND v_cancelled > 0 THEN 'cancelled'
                             ELSE 'completed' END,
         completed_at = CASE WHEN v_active > 0 THEN NULL ELSE coalesce(b.completed_at, now()) END,
         updated_at   = now()
   WHERE b.id = p_batch_id
  RETURNING b.* INTO v_batch;

  RETURN v_batch;
END;
$$;

-- Queue depth + age of the oldest queued job, for /health.
CREATE OR REPLACE FUNCTION public.queue_health()
RETURNS TABLE (queued bigint, processing bigint, oldest_queued_seconds integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT count(*) FILTER (WHERE status = 'queued'),
         count(*) FILTER (WHERE status = 'processing'),
         coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE status = 'queued'))::int, 0)
  FROM public.processing_jobs
  WHERE status IN ('queued', 'processing');
$$;

-- ---------------------------------------------------------------------------
-- 5. Lock down: service_role only
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.reserve_credits(uuid, integer, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_credit(uuid, uuid, text)           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_credits()                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_next_jobs(integer)                  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.requeue_stale_jobs(integer)               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refresh_batch(uuid)                       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.queue_health()                            FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_credits(uuid, integer, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_credit(uuid, uuid, text)           TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_credits()                       TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_jobs(integer)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_stale_jobs(integer)               TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_batch(uuid)                       TO service_role;
GRANT EXECUTE ON FUNCTION public.queue_health()                            TO service_role;
