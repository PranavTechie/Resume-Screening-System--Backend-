import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { jobWorker } from '../workers/jobWorker';

async function queueStats(): Promise<{ queued: number; processing: number; oldestQueuedSeconds: number } | null> {
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 2000));
  const query = (async () => {
    const { data, error } = await supabaseAdmin.rpc('queue_health');
    if (error || !data) return null;
    const row = Array.isArray(data) ? data[0] : data;
    return { queued: Number(row?.queued || 0), processing: Number(row?.processing || 0), oldestQueuedSeconds: Number(row?.oldest_queued_seconds || 0) };
  })();
  return Promise.race([query, timeout]);
}

export const healthController = {
  // Always 200 while the process is up (Railway health check); queue details are informational.
  checkHealth: async (_req: Request, res: Response) => {
    const queue = await queueStats().catch(() => null);
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      queue,
      worker: jobWorker.status(),
    });
  },
};
