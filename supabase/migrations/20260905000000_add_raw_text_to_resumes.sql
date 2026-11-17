-- ====================================================================
-- ResumeIQ Migration: Add raw_text column to resumes table
-- ====================================================================
-- The resume.service.ts stores extracted resume text in raw_text for:
--   - Interview preparation context
--   - Practice answer evaluation context
--   - Follow-up question generation
-- This column was referenced in code but missing from the initial schema.

ALTER TABLE public.resumes ADD COLUMN IF NOT EXISTS raw_text TEXT;
