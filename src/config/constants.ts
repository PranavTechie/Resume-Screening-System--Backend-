import { env } from './env';

export const MAX_RESUME_FILE_SIZE = env.MAX_RESUME_FILE_SIZE || 5 * 1024 * 1024; // 5MB in bytes (5,242,880)
export const MAX_RESUME_FILE_SIZE_MB = Math.round(MAX_RESUME_FILE_SIZE / (1024 * 1024));

export const ALLOWED_RESUME_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'image/jpeg',
  'image/png',
];

export const ALLOWED_RESUME_EXTENSIONS = [
  '.pdf',
  '.doc',
  '.docx',
  '.txt',
  '.jpg',
  '.jpeg',
  '.png',
];

export const EXTENSION_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

// Job Description Validation Constraints
export const JOB_DESCRIPTION_MIN_LENGTH = 100;
export const JOB_DESCRIPTION_MAX_LENGTH = 10000;

export const JOB_DESCRIPTION_VALIDATION_MESSAGES = {
  TOO_SHORT: 'Job description must be at least 100 characters.',
  TOO_LONG: 'Job description must be 10,000 characters or less.',
  REQUIRED: 'Job description is required and cannot be empty.',
};

// ---------------------------------------------------------------------------
// Credit prices (FINAL, do not change without the owner)
// ---------------------------------------------------------------------------
export const CREDIT_COST = {
  RESUME_ANALYSIS: 1,
  RANK_PER_RESUME: 1,
  JOB_DESCRIPTION: 1,
} as const;

// ---------------------------------------------------------------------------
// Resume validation (Layer A free pre-check, Layer B AI check, Layer C abuse cap)
// ---------------------------------------------------------------------------
export const RESUME_VALIDATION = {
  MAX_PDF_PAGES: 5,
  MIN_TEXT_CHARS: 300,
  MAX_TEXT_CHARS: 25000,
  /** Characters of resume text sent to the model; longer valid resumes are flagged truncated. */
  PROMPT_CHAR_LIMIT: 20000,
  MIN_AI_CONFIDENCE: 0.6,
  /** Below this many local chars a PDF is treated as scanned and read with Gemini vision. */
  SCANNED_PDF_TEXT_THRESHOLD: 50,
} as const;

export const REJECTION_CAP = {
  MAX_REJECTIONS: 15,
  WINDOW_HOURS: 24,
} as const;

// ---------------------------------------------------------------------------
// Bulk upload / ZIP safety
// ---------------------------------------------------------------------------
export const BATCH_LIMITS = {
  MAX_FILES: 50,
  MAX_ZIP_BYTES: 50 * 1024 * 1024,
  MAX_ZIP_UNCOMPRESSED_BYTES: 100 * 1024 * 1024,
  MAX_ZIP_ENTRIES: 50,
  BATCHES_PER_HOUR: 20,
} as const;

// ---------------------------------------------------------------------------
// Background worker
// ---------------------------------------------------------------------------
export const WORKER_CONFIG = {
  CONCURRENCY: Math.max(1, parseInt(process.env.WORKER_CONCURRENCY || '4', 10) || 4),
  POLL_INTERVAL_MS: Math.max(500, parseInt(process.env.WORKER_POLL_MS || '1500', 10) || 1500),
  ITEM_TIMEOUT_MS: 90_000,
  STALE_AFTER_SECONDS: 300,
  STALE_SWEEP_INTERVAL_MS: 60_000,
  RECONCILE_INTERVAL_MS: 24 * 60 * 60 * 1000,
  BACKOFF_BASE_MS: 2_000,
  BACKOFF_MAX_MS: 30_000,
  SHUTDOWN_GRACE_MS: 25_000,
} as const;

// ---------------------------------------------------------------------------
// Scoring (Phase 4). Bump SCORING_VERSION whenever weights, rubric or prompts change.
// ---------------------------------------------------------------------------
export const SCORING_VERSION = 'v2.0-2026-11-17';

export const MATCH_SCORE_WEIGHTS = {
  skillCoverage: 0.5,
  experienceFit: 0.2,
  aiJudgment: 0.3,
} as const;

/** Inside skill coverage, a required skill counts this many times a nice-to-have one. */
export const REQUIRED_SKILL_WEIGHT = 2;
export const NICE_TO_HAVE_SKILL_WEIGHT = 1;

export const CANDIDATE_STATUSES = ['new', 'shortlisted', 'on_hold', 'rejected'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
