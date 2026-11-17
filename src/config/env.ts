import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

//loading environment variables
export const env = {
  PORT: process.env.PORT || '3000',
  NODE_ENV: process.env.NODE_ENV || 'development',
  FRONTEND_URL: process.env.FRONTEND_URL || '*',

  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest',

  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET || 'resumes',
  MAX_RESUME_FILE_SIZE: parseInt(process.env.MAX_RESUME_FILE_SIZE || '5242880', 10),

  /** Run the background job worker inside this process (default on). */
  WORKER_ENABLED: (process.env.WORKER_ENABLED || 'true').toLowerCase() !== 'false',
  /**
   * Deterministic fake AI for local load tests only. Ignored when NODE_ENV=production,
   * so production can never silently return fake scores.
   */
  AI_MOCK_MODE: (process.env.AI_MOCK_MODE || '').toLowerCase() === 'true' && (process.env.NODE_ENV || 'development') !== 'production',
};

// Validate environment variables
export function validateEnv() {
  const missing: string[] = [];
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!env.GEMINI_API_KEY && !env.AI_MOCK_MODE) missing.push('GEMINI_API_KEY');

  if (missing.length > 0) {
    console.warn(`[WARNING] Missing environment variables: ${missing.join(', ')}`);
  }
}
