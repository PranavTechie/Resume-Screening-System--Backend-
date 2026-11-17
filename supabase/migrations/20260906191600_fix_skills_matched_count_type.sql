-- Drop and re-add skills_matched_count as INTEGER
ALTER TABLE public.job_matches DROP COLUMN IF EXISTS skills_matched_count;
ALTER TABLE public.job_matches ADD COLUMN skills_matched_count INTEGER;
