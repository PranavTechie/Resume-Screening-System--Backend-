/**
 * Typed application error. `outcome` tells the queue worker what to do with an item:
 *  - 'rejected'  : the document is not acceptable (not a resume, too long...). No retry, refund.
 *  - 'duplicate' : same file / same candidate already exists. No retry, refund.
 *  - 'failed'    : something went wrong. Retried when `retryable`, refunded when final.
 */
export type ErrorOutcome = 'rejected' | 'duplicate' | 'failed';

export class AppError extends Error {
  code: string;
  status: number;
  outcome: ErrorOutcome;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { status?: number; outcome?: ErrorOutcome; retryable?: boolean; details?: Record<string, unknown> } = {}
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? 500;
    this.outcome = opts.outcome ?? 'failed';
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export const rejectError = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, { status: 422, outcome: 'rejected', retryable: false, details });

export const duplicateError = (message: string, details?: Record<string, unknown>) =>
  new AppError('DUPLICATE_RESUME', message, { status: 409, outcome: 'duplicate', retryable: false, details });

/** Classify any thrown value into an AppError (Gemini 429/5xx/timeouts are retryable). */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const e = err as any;
  const msg: string = String(e?.message || e || 'Unexpected error');
  const code: string = e?.code || '';

  if (code === 'INSUFFICIENT_CREDITS' || msg.includes('INSUFFICIENT_CREDITS')) {
    return new AppError('INSUFFICIENT_CREDITS', 'Not enough credits for this action.', { status: 402 });
  }
  if (code === 'AI_ANALYSIS_TIMEOUT' || /timed out|timeout|ETIMEDOUT/i.test(msg)) {
    return new AppError('AI_ANALYSIS_TIMEOUT', 'AI analysis timed out. Please try again.', { status: 504, retryable: true });
  }
  if (
    code === 'AI_SERVICE_UNAVAILABLE' ||
    /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|quota|ECONNRESET|fetch failed/i.test(msg)
  ) {
    return new AppError('AI_SERVICE_UNAVAILABLE', 'AI analysis is temporarily unavailable. Please try again.', { status: 503, retryable: true });
  }
  if (code === 'DATABASE_TIMEOUT') {
    return new AppError('DATABASE_TIMEOUT', 'Database operation timed out. Please try again.', { status: 504, retryable: true });
  }
  if (code === 'GEMINI_VALIDATION_FAILED' || msg.includes('GEMINI_VALIDATION_FAILED')) {
    return new AppError('GEMINI_VALIDATION_FAILED', 'AI returned an unreadable answer. Please try again.', { status: 502, retryable: true });
  }
  return new AppError(code || 'PROCESS_FAILED', 'Something went wrong while processing this file.', { status: 500, retryable: false });
}
