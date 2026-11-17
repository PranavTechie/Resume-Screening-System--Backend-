-- ====================================================================
-- ResumeIQ Migration: AI Resume Tailoring & Versioning Schema
-- File: 20260812000000_resume_tailoring_and_versions.sql
-- Description: Creates public.resume_versions table for tailored resume versions,
--              metadata, change history, non-fabricated skill tracking, and RLS policies.
-- ====================================================================

CREATE TABLE IF NOT EXISTS public.resume_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  parent_resume_id UUID NOT NULL REFERENCES public.resumes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version_name TEXT NOT NULL,
  target_role TEXT NOT NULL,
  job_description TEXT,
  ats_alignment INTEGER NOT NULL DEFAULT 85 CHECK (ats_alignment >= 0 AND ats_alignment <= 100),
  matched_keywords_count INTEGER NOT NULL DEFAULT 0,
  skills_repositioned_count INTEGER NOT NULL DEFAULT 0,
  sections_improved_count INTEGER NOT NULL DEFAULT 0,
  tailored_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  what_changed JSONB NOT NULL DEFAULT '[]'::jsonb,
  not_added JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_resume_versions_parent_id ON public.resume_versions(parent_resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_versions_user_id ON public.resume_versions(user_id);

-- ROW LEVEL SECURITY
ALTER TABLE public.resume_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own resume versions" ON public.resume_versions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own resume versions" ON public.resume_versions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own resume versions" ON public.resume_versions
  FOR DELETE USING (auth.uid() = user_id);
