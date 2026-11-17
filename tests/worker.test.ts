import { describe, expect, it } from 'vitest';
import { backoffMs } from '../src/workers/jobWorker';
import { toAppError } from '../src/utils/errors';

describe('worker retry policy', () => {
  it('exponential backoff with jitter stays inside bounds', () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const cap = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const ms = backoffMs(attempt);
        expect(ms).toBeGreaterThanOrEqual(cap / 2);
        expect(ms).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('retries Gemini 429/5xx/timeouts but never validation errors', () => {
    expect(toAppError(new Error('got status 429 RESOURCE_EXHAUSTED')).retryable).toBe(true);
    expect(toAppError(new Error('503 UNAVAILABLE high demand')).retryable).toBe(true);
    expect(toAppError(Object.assign(new Error('x'), { code: 'AI_ANALYSIS_TIMEOUT' })).retryable).toBe(true);
    expect(toAppError(new Error('something odd')).retryable).toBe(false);
  });
});
