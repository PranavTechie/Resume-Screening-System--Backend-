-- ====================================================================
-- ResumeIQ Migration: Update Storage Bucket Limit to 5MB and Support Images
-- File: 20260819120000_update_resume_storage_size_and_mimes.sql
-- Description: Updates public.storage.buckets resumes bucket file_size_limit
--              from 10MB (10485760 bytes) to 5MB (5242880 bytes) and adds image MIME types.
-- ====================================================================

UPDATE storage.buckets
SET
  file_size_limit = 5242880, -- 5MB limit (5 * 1024 * 1024 bytes)
  allowed_mime_types = ARRAY[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'image/jpeg',
    'image/png'
  ]
WHERE id = 'resumes';
