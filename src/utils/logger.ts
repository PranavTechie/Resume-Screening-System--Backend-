import { AsyncLocalStorage } from 'async_hooks';

/**
 * Structured JSON logger. Every line carries the request id / batch id / job id from the
 * current async context. NEVER log PII (names, emails, phones, file names) or resume text.
 */
export interface LogContext {
  requestId?: string;
  batchId?: string;
  jobId?: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = storage.getStore() || {};
  return storage.run({ ...parent, ...ctx }, fn);
}

export function getLogContext(): LogContext {
  return storage.getStore() || {};
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (level === 'debug' && process.env.NODE_ENV === 'production') return;
  if (process.env.VITEST && level !== 'error') return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...getLogContext(),
    ...(meta || {}),
  };
  const out = JSON.stringify(line);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
