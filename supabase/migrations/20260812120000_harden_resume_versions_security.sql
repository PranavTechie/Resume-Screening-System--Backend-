-- ====================================================================
-- ResumeIQ Migration: Harden Resume Versions RLS & Remove Fake Default Score
-- File: 20260812120000_harden_resume_versions_security.sql
-- ====================================================================

-- 1. DROP DEFAULT 85 FROM ats_alignment COLUMN
ALTER TABLE public.resume_versions 
  ALTER COLUMN ats_alignment DROP DEFAULT;

-- 2. HARDEN RLS INSERT POLICY TO ENFORCE PARENT RESUME OWNERSHIP
DROP POLICY IF EXISTS "Users can insert own resume versions" ON public.resume_versions;

CREATE POLICY "Users can insert own resume versions" ON public.resume_versions
  FOR INSERT WITH CHECK (
    auth.uid() = user_id AND
    EXISTS (
      SELECT 1 FROM public.resumes r
      WHERE r.id = parent_resume_id AND r.user_id = auth.uid()
    )
  );
