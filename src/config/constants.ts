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

// Job Description Validation Constraints
export const JOB_DESCRIPTION_MIN_LENGTH = 100;
export const JOB_DESCRIPTION_MAX_LENGTH = 10000;

export const JOB_DESCRIPTION_VALIDATION_MESSAGES = {
  TOO_SHORT: 'Job description must be at least 100 characters.',
  TOO_LONG: 'Job description must be 10,000 characters or less.',
  REQUIRED: 'Job description is required and cannot be empty.',
};

