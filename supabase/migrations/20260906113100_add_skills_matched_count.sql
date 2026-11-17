-- Add skills_matched_count column to public.job_matches
-- Using TEXT instead of INTEGER since the field stores ratio strings like "4/8"
ALTER TABLE public.job_matches
ADD COLUMN IF NOT EXISTS skills_matched_count TEXT;
