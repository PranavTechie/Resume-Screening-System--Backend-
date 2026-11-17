-- Migration: add candidate_name column to job_matches
-- The job_matches upsert in job.service.ts inserts candidate_name but the
-- original table schema was missing this column, causing all upserts to fail
-- silently and leaving job_matches permanently empty.

ALTER TABLE public.job_matches
  ADD COLUMN IF NOT EXISTS candidate_name TEXT;

-- Back-fill existing rows from the joined resumes table
UPDATE public.job_matches jm
SET candidate_name = r.candidate_name
FROM public.resumes r
WHERE jm.resume_id = r.id
  AND jm.candidate_name IS NULL;
