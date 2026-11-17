import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger, runWithLogContext } from '../utils/logger';

/** Adds a request id (X-Request-Id), runs the request inside a log context and logs one access line. */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const requestId = incoming && /^[a-zA-Z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  const started = Date.now();
  runWithLogContext({ requestId }, () => {
    res.on('finish', () => {
      // Path only (ids are opaque UUIDs); never query strings or bodies.
      const route = req.originalUrl.split('?')[0];
      if (route === '/health' && res.statusCode === 200) return;
      logger.info('http', { method: req.method, path: route, status: res.statusCode, ms: Date.now() - started, userId: req.user?.id });
    });
    next();
  });
}
