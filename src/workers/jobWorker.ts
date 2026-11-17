/**
 * In-process background worker for the Postgres job queue (no Redis).
 *  - polls claim_next_jobs (FOR UPDATE SKIP LOCKED) every POLL_INTERVAL_MS
 *  - concurrency 4, 90 s per-item timeout
 *  - retries Gemini 429/5xx/timeouts with exponential backoff + jitter (max 3 attempts)
 *  - never retries validation errors (rejected / duplicate)
 *  - refunds every item that ends failed / rejected / duplicate / cancelled
 *  - stuck-job recovery + graceful shutdown on SIGTERM
 */
import { supabaseAdmin } from '../config/supabase';
import { WORKER_CONFIG } from '../config/constants';
import { analyzeAndPersistResume } from '../services/resumePipeline.service';
import { batchService } from '../services/batch.service';
import { creditService } from '../services/credit.service';
import { jobService } from '../services/job.service';
import { rejectionService } from '../services/rejection.service';
import { storageService } from '../services/storage.service';
import { AppError, toAppError } from '../utils/errors';
import { logger, runWithLogContext } from '../utils/logger';

interface QueueRow {
  id: string;
  user_id: string;
  batch_id: string;
  kind: 'analyze_resume' | 'rank_resume';
  payload: any;
  status: string;
  attempts: number;
  max_attempts: number;
  retry_round: number;
}

export function backoffMs(attempt: number, base: number = WORKER_CONFIG.BACKOFF_BASE_MS, max: number = WORKER_CONFIG.BACKOFF_MAX_MS): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
}

class Deadline {
  private expired = false;
  private timer: NodeJS.Timeout;
  constructor(ms: number) {
    this.timer = setTimeout(() => (this.expired = true), ms);
  }
  get isExpired() {
    return this.expired;
  }
  clear() {
    clearTimeout(this.timer);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new AppError('AI_ANALYSIS_TIMEOUT', 'Processing took too long and was stopped.', { status: 504, retryable: true })), ms);
    }),
  ]);
}

export class JobWorker {
  private running = false;
  private stopping = false;
  private inFlight = new Map<string, Promise<void>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private lastPollAt: number | null = null;
  private processed = 0;

  constructor(private concurrency: number = WORKER_CONFIG.CONCURRENCY) {}

  status() {
    return { running: this.running && !this.stopping, inFlight: this.inFlight.size, concurrency: this.concurrency, processed: this.processed, lastPollAt: this.lastPollAt ? new Date(this.lastPollAt).toISOString() : null };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    logger.info('worker.started', { concurrency: this.concurrency, pollMs: WORKER_CONFIG.POLL_INTERVAL_MS });
    void this.recoverStale();
    void creditService.reconcile();
    this.staleTimer = setInterval(() => void this.recoverStale(), WORKER_CONFIG.STALE_SWEEP_INTERVAL_MS);
    this.reconcileTimer = setInterval(() => void creditService.reconcile(), WORKER_CONFIG.RECONCILE_INTERVAL_MS);
    this.schedule(0);
  }

  private schedule(ms: number) {
    if (!this.running || this.stopping) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    this.lastPollAt = Date.now();
    try {
      const free = this.concurrency - this.inFlight.size;
      if (free > 0 && !this.stopping) {
        const { data, error } = await supabaseAdmin.rpc('claim_next_jobs', { p_limit: free });
        if (error) throw new Error(error.message);
        for (const row of (data || []) as QueueRow[]) {
          const p = this.process(row).finally(() => this.inFlight.delete(row.id));
          this.inFlight.set(row.id, p);
        }
        // Something was claimed: poll again quickly to fill remaining slots.
        if ((data || []).length > 0) return this.schedule(200);
      }
    } catch (err: any) {
      logger.warn('worker.poll_failed', { error: String(err?.message || err).slice(0, 200) });
    }
    this.schedule(WORKER_CONFIG.POLL_INTERVAL_MS);
  }

  private async process(row: QueueRow): Promise<void> {
    return runWithLogContext({ batchId: row.batch_id, jobId: row.id }, async () => {
      const started = Date.now();
      const deadline = new Deadline(WORKER_CONFIG.ITEM_TIMEOUT_MS - 2000);
      try {
        const resultRef = await withTimeout(this.runItem(row, () => deadline.isExpired), WORKER_CONFIG.ITEM_TIMEOUT_MS);
        await this.finish(row, 'done', { result_ref: resultRef, error_code: null, error_message: null });
        logger.info('worker.item_done', { kind: row.kind, ms: Date.now() - started, attempt: row.attempts });
      } catch (raw) {
        const err = toAppError(raw);
        await this.handleFailure(row, err, Date.now() - started);
      } finally {
        deadline.clear();
        this.processed += 1;
      }
    });
  }

  private async runItem(row: QueueRow, isCancelled: () => boolean): Promise<string> {
    const p = row.payload || {};
    if (row.kind === 'analyze_resume') {
      if (!p.filePath) throw new AppError('STORAGE_FILE_MISSING', 'The file was never stored. Please upload it again.', { status: 410 });
      const buffer = await storageService.downloadResumeFile(p.filePath);
      const out = await analyzeAndPersistResume({
        userId: row.user_id,
        buffer,
        fileName: p.fileName || 'resume',
        mimeType: p.mimeType || 'application/octet-stream',
        fileHash: p.fileHash || undefined,
        filePath: p.filePath,
        isCancelled,
      });
      return out.resumeId;
    }
    if (row.kind === 'rank_resume') {
      await jobService.rankOneResume(row.user_id, p.jobId, p.resumeId, isCancelled);
      await jobService.markRanked(row.user_id, p.jobId);
      return p.resumeId;
    }
    throw new AppError('UNKNOWN_JOB_KIND', 'Unknown job type.');
  }

  private async handleFailure(row: QueueRow, err: AppError, ms: number) {
    const canRetry = err.outcome === 'failed' && err.retryable && row.attempts < row.max_attempts;
    if (canRetry) {
      const delay = backoffMs(row.attempts);
      await supabaseAdmin
        .from('processing_jobs')
        .update({ status: 'queued', locked_at: null, run_after: new Date(Date.now() + delay).toISOString(), error_code: err.code, error_message: err.message, updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('status', 'processing');
      logger.warn('worker.item_retry', { code: err.code, attempt: row.attempts, delayMs: delay, ms });
      return;
    }

    const status = err.outcome === 'rejected' ? 'rejected' : err.outcome === 'duplicate' ? 'duplicate' : 'failed';
    const payload = { ...(row.payload || {}) };
    if (err.details?.duplicateOfName) payload.duplicateOfName = err.details.duplicateOfName;
    if (err.details?.documentType) payload.documentType = err.details.documentType;
    await this.finish(row, status, { error_code: err.code, error_message: err.message, payload });

    if (status === 'rejected') await rejectionService.record(row.user_id, err.code);
    // Rejected / duplicate uploads: don't keep the stored copy around.
    if (row.kind === 'analyze_resume' && status !== 'failed' && payload.filePath) {
      await storageService.deleteResumeFile(payload.filePath);
    }
    logger.warn('worker.item_final', { status, code: err.code, attempt: row.attempts, ms });
  }

  /** Terminal update (guarded on status='processing'), refund when not done, refresh batch counts. */
  private async finish(row: QueueRow, status: 'done' | 'failed' | 'rejected' | 'duplicate', patch: Record<string, unknown>) {
    const { data } = await supabaseAdmin
      .from('processing_jobs')
      .update({ ...patch, status, locked_at: null, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'processing')
      .select('id');
    const applied = (data || []).length > 0;
    if (applied && status !== 'done') {
      await creditService
        .refundCredit(row.user_id, row.id, `Refund: ${row.kind === 'rank_resume' ? 'ranking' : 'resume'} ${status}${patch.error_code ? ` (${patch.error_code})` : ''}`)
        .catch((e) => logger.error('worker.refund_failed', { error: String(e?.message || e) }));
    }
    await batchService.refresh(row.batch_id);
  }

  private async recoverStale() {
    try {
      const { data, error } = await supabaseAdmin.rpc('requeue_stale_jobs', { p_stale_seconds: WORKER_CONFIG.STALE_AFTER_SECONDS });
      if (error) throw new Error(error.message);
      const rows = (data || []) as Array<{ job_id: string; job_user_id: string; job_batch_id: string; new_status: string }>;
      for (const r of rows) {
        if (r.new_status === 'failed') {
          await creditService.refundCredit(r.job_user_id, r.job_id, 'Refund: processing timed out').catch(() => undefined);
        }
        await batchService.refresh(r.job_batch_id);
      }
      if (rows.length) logger.warn('worker.stale_recovered', { count: rows.length });
    } catch (err: any) {
      logger.warn('worker.stale_sweep_failed', { error: String(err?.message || err).slice(0, 200) });
    }
  }

  /** Stop claiming; wait for in-flight items, then requeue whatever is still running. */
  async stop(graceMs: number = WORKER_CONFIG.SHUTDOWN_GRACE_MS) {
    if (!this.running) return;
    this.stopping = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    const ids = Array.from(this.inFlight.keys());
    logger.info('worker.stopping', { inFlight: ids.length });
    await Promise.race([Promise.allSettled(Array.from(this.inFlight.values())), new Promise((r) => setTimeout(r, graceMs))]);
    const leftover = Array.from(this.inFlight.keys());
    if (leftover.length) {
      // attempts is decremented so the interruption doesn't count against the item.
      for (const id of leftover) {
        const { data: row } = await supabaseAdmin.from('processing_jobs').select('attempts').eq('id', id).maybeSingle();
        await supabaseAdmin
          .from('processing_jobs')
          .update({ status: 'queued', locked_at: null, run_after: new Date().toISOString(), attempts: Math.max(0, (row?.attempts || 1) - 1) })
          .eq('id', id)
          .eq('status', 'processing');
      }
      logger.warn('worker.requeued_on_shutdown', { count: leftover.length });
    }
    this.running = false;
    logger.info('worker.stopped', {});
  }
}

export const jobWorker = new JobWorker();
