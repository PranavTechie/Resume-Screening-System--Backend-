-- ====================================================================
-- ResumeIQ Migration: Decommission AI Resume Tailoring
-- File: 20260819000000_decommission_resume_tailoring.sql
-- Description: Permanently drops public.resume_versions table and indexes.
-- ====================================================================

DROP TABLE IF EXISTS public.resume_versions CASCADE;
