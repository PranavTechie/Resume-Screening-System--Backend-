import rateLimit from 'express-rate-limit';
import type { Request } from 'express';
import { BATCH_LIMITS } from '../config/constants';

const body = (code: string, message: string) => ({
  success: false,
  error: { code, message },
  timestamp: new Date().toISOString(),
});

/** Per authenticated user (falls back to IP before auth). Must be mounted AFTER requireAuth. */
const userKey = (req: Request) => (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`);

/** General per-IP limiter for /api. Batch status polling has its own per-user limiter. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  skip: (req) => req.method === 'OPTIONS' || (req.method === 'GET' && req.path.startsWith('/batches/')),
  standardHeaders: true,
  legacyHeaders: false,
  message: body('TOO_MANY_REQUESTS', 'Too many requests from this network, please try again in a few minutes.'),
});

/** Single AI actions (one upload, one JD generation): 30 / minute / user. */
export const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: userKey,
  skip: (req) => req.method === 'OPTIONS',
  standardHeaders: true,
  legacyHeaders: false,
  message: body('AI_RATE_LIMIT', 'Too many AI requests. Please wait a minute and try again.'),
});

/** Batch creation (bulk upload, ranking): 20 / hour / user. Rejected requests (4xx/5xx) don't count. */
export const batchCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: BATCH_LIMITS.BATCHES_PER_HOUR,
  keyGenerator: userKey,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: body('BATCH_RATE_LIMIT', `You can start at most ${BATCH_LIMITS.BATCHES_PER_HOUR} batches per hour. Please try again later.`),
});

/** Status polling (every 2 s while a batch runs): 120 / minute / user. */
export const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: userKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: body('POLL_RATE_LIMIT', 'Checking status too often. Please slow down.'),
});
