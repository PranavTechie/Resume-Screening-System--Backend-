import { Response } from 'express';
import { ApiResponse } from '../types';

export function sendSuccess<T>(res: Response, data: T, message?: string, statusCode: number = 200): Response {
  const payload: ApiResponse<T> = {
    success: true,
    data,
    message,
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(payload);
}

export function sendError(
  res: Response,
  message: string,
  statusCode: number = 500,
  code: string = 'INTERNAL_ERROR',
  details?: any
): Response {
  const payload: ApiResponse = {
    success: false,
    error: {
      code,
      message,
      details,
    },
    timestamp: new Date().toISOString(),
  };
  return res.status(statusCode).json(payload);
}

/** Send an AppError (or anything) using the standard envelope. Details are also spread on `error`. */
export function sendAppError(res: Response, err: { code?: string; message?: string; status?: number; details?: Record<string, unknown> }, extra?: Record<string, unknown>): Response {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = status >= 500 && !err.code ? 'Something went wrong. Please try again.' : err.message || 'Request failed';
  return res.status(status).json({
    success: false,
    error: { code: err.code || 'INTERNAL_ERROR', message, ...(err.details || {}), ...(extra || {}) },
    timestamp: new Date().toISOString(),
  });
}
