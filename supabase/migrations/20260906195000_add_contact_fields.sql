-- Add contact information columns to resumes table
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS candidate_linkedin TEXT;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS candidate_github TEXT;
ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS candidate_website TEXT;
