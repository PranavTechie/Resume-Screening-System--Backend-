# ResumeIQ Supabase Migration Architecture

This directory contains the versioned, chronological SQL migration files for the **ResumeIQ** Supabase database.

## Migration Guidelines

1. **Baseline Schema**: `20260811000000_initial_schema.sql` represents the original baseline schema. It MUST NEVER be modified after creation.
2. **Incremental Migrations**: Every new schema change, security update, or feature addition must be placed in a **new timestamped migration file** (e.g., `YYYYMMDDHHMMSS_feature_name.sql`).
3. **Idempotency**: Every migration file must use idempotent SQL patterns (`CREATE TABLE IF NOT EXISTS`, `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`, `DROP POLICY IF EXISTS`, `CREATE OR REPLACE FUNCTION`).
4. **Manual Execution Order**: Apply migrations chronologically in the Supabase SQL Editor.

---

## Migration Index

| Filename | Description | Status |
|---|---|---|
| [`20260811000000_initial_schema.sql`](./migrations/20260811000000_initial_schema.sql) | Baseline schema: tables (`profiles`, `user_preferences`, `resumes`, `resume_analyses`, `detected_skills`, `jobs`, `job_matches`, `analysis_reports`, `credit_transactions`, `subscriptions`), storage bucket, base RLS policies. | Initial Release |
| [`20260811150000_harden_auth_and_welcome_credits.sql`](./migrations/20260811150000_harden_auth_and_welcome_credits.sql) | Auth hardening: sets initial credits to 10, aligns subscription default to 'starter', adds `search_path` to `SECURITY DEFINER` functions, enforces unique welcome bonus, and adds client credit update defense trigger. | **Pending Manual Execution** |
