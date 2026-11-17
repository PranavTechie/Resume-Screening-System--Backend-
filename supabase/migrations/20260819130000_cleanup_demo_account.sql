-- ==============================================================================
-- ResumeIQ Migration: Clean up Demo Account & Orphaned Demo Data
-- ==============================================================================

-- 1. Remove demo records from public tables
DELETE FROM public.credit_transactions 
WHERE user_id IN (SELECT id FROM public.profiles WHERE email ILIKE '%demo@resumeiq.ai%');

DELETE FROM public.user_preferences 
WHERE user_id IN (SELECT id FROM public.profiles WHERE email ILIKE '%demo@resumeiq.ai%');

DELETE FROM public.resumes 
WHERE user_id IN (SELECT id FROM public.profiles WHERE email ILIKE '%demo@resumeiq.ai%');

DELETE FROM public.jobs 
WHERE user_id IN (SELECT id FROM public.profiles WHERE email ILIKE '%demo@resumeiq.ai%');

DELETE FROM public.analysis_reports 
WHERE user_id IN (SELECT id FROM public.profiles WHERE email ILIKE '%demo@resumeiq.ai%');

DELETE FROM public.subscriptions 
WHERE plan_id = 'demo' OR user_id IN (SELECT id FROM public.profiles WHERE email ILIKE '%demo@resumeiq.ai%');

DELETE FROM public.profiles 
WHERE email ILIKE '%demo@resumeiq.ai%' OR full_name = 'Demo Account';

-- ==============================================================================
-- End of Migration
-- ==============================================================================
