import { Request, Response, NextFunction } from 'express';
import { sendAppError } from '../utils/response';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): Response {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error('api.error', { code: err.code, path: req.path, method: req.method });
    return sendAppError(res, err);
  }
  if (err?.type === 'entity.too.large') {
    return sendAppError(res, { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' });
  }
  if (err?.message === 'Not allowed by CORS') {
    return sendAppError(res, { status: 403, code: 'CORS_BLOCKED', message: 'Origin not allowed.' });
  }
  logger.error('api.unhandled_error', { path: req.path, method: req.method, error: String(err?.message || err).slice(0, 300) });
  return sendAppError(res, { status: 500, code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong. Please try again.' });
}
