/**
 * Batches = one user action that becomes N queued processing_jobs (bulk upload or job ranking).
 * Credit flow: reserve the full cost up front -> refund every item that ends
 * failed / rejected / duplicate / cancelled (refund_credit is idempotent per item).
 */
import path from 'path';
import { supabaseAdmin } from '../config/supabase';
import {
  ALLOWED_RESUME_EXTENSIONS,
  ALLOWED_RESUME_MIME_TYPES,
  BATCH_LIMITS,
  CREDIT_COST,
  EXTENSION_MIME_MAP,
  MAX_RESUME_FILE_SIZE,
} from '../config/constants';
import { creditService } from './credit.service';
import { rejectionService } from './rejection.service';
import { storageService } from './storage.service';
import { findDuplicatesByHashes, sha256 } from './resumePipeline.service';
import { assertJobDescription, jobService } from './job.service';
import { AppError } from '../utils/errors';
import { logger, runWithLogContext } from '../utils/logger';
import type { SkippedEntry } from '../utils/zip';

export type BatchKind = 'analyze_resume' | 'rank_resume';
export type ItemStatus = 'queued' | 'processing' | 'done' | 'failed' | 'rejected' | 'duplicate' | 'cancelled';

/** A file waiting to be queued. Bytes are read lazily (multer writes to disk) to keep memory flat. */
export interface IncomingFile {
  name: string;
  size: number;
  mimeType?: string;
  /** sha256 of the bytes (computed while streaming from disk / unzipping). */
  hash: string;
  read: () => Promise<Buffer>;
}

const FAR_FUTURE_MS = 10 * 60 * 1000;

function extOf(name: string) {
  return path.extname(name || '').toLowerCase();
}

/** Pure: decide per file whether it can be queued, before any credit is touched. */
export function preflightFile(file: Pick<IncomingFile, 'name' | 'size' | 'mimeType'>): { ok: true; mimeType: string } | { ok: false; code: string; message: string } {
  const ext = extOf(file.name);
  if (!ALLOWED_RESUME_EXTENSIONS.includes(ext)) {
    return { ok: false, code: 'UNSUPPORTED_TYPE', message: 'Unsupported file type. Use PDF, DOCX, DOC, TXT, JPG or PNG.' };
  }
  if (!file.size) return { ok: false, code: 'EMPTY_FILE', message: 'The file is empty.' };
  if (file.size > MAX_RESUME_FILE_SIZE) return { ok: false, code: 'FILE_TOO_LARGE', message: 'File is larger than 5 MB.' };
  const declared = (file.mimeType || '').toLowerCase();
  const mimeType = ALLOWED_RESUME_MIME_TYPES.includes(declared) ? declared : EXTENSION_MIME_MAP[ext];
  return { ok: true, mimeType };
}

/** Normalized identity keys used to spot the same candidate twice inside one job. */
export function candidateKeys(email?: string | null, phone?: string | null): string[] {
  const keys: string[] = [];
  const e = (email || '').trim().toLowerCase();
  if (e && e.includes('@')) keys.push(`e:${e}`);
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length >= 8) keys.push(`p:${digits.slice(-10)}`);
  return keys;
}

const SKIP_MESSAGES: Record<SkippedEntry['reason'], string> = {
  UNSUPPORTED_TYPE: 'Unsupported file type inside the ZIP.',
  FILE_TOO_LARGE: 'File is larger than 5 MB.',
  EMPTY_FILE: 'The file is empty.',
  ENCRYPTED: 'Password-protected file.',
};

async function refundItems(userId: string, items: Array<{ id: string }>, reason: string) {
  for (const it of items) {
    await creditService.refundCredit(userId, it.id, reason).catch((e) => logger.error('batch.refund_failed', { jobId: it.id, error: String(e?.message || e) }));
  }
}

async function refresh(batchId: string) {
  const { data, error } = await supabaseAdmin.rpc('refresh_batch', { p_batch_id: batchId });
  if (error) logger.warn('batch.refresh_failed', { batchId, error: error.message });
  return data;
}

function mapItem(row: any) {
  const p = row.payload || {};
  return {
    id: row.id,
    status: row.status as ItemStatus,
    fileName: p.fileName || null,
    resumeId: p.resumeId || (row.kind === 'analyze_resume' ? row.result_ref : null),
    candidateName: p.candidateName || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    duplicateOfName: p.duplicateOfName || null,
    resultRef: row.result_ref || null,
    attempts: row.attempts,
    updatedAt: row.updated_at,
  };
}

function mapBatch(row: any) {
  return {
    id: row.id,
    kind: row.kind as BatchKind,
    jobId: row.job_id,
    total: row.total,
    counts: row.counts || {},
    creditsReserved: row.credits_reserved,
    creditsRefunded: row.credits_refunded,
    status: row.status,
    consentAt: row.consent_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export const batchService = {
  async createUploadBatch(userId: string, files: IncomingFile[], opts: { consent: boolean; skipped?: SkippedEntry[] }) {
    if (!opts.consent) {
      throw new AppError('CONSENT_REQUIRED', 'Please confirm you have permission to process these candidates’ data.', { status: 400 });
    }
    const skipped = opts.skipped || [];
    if (files.length === 0 && skipped.length === 0) throw new AppError('NO_FILES', 'No files were uploaded.', { status: 400 });
    if (files.length + skipped.length > BATCH_LIMITS.MAX_FILES) {
      throw new AppError('TOO_MANY_FILES', `You can upload at most ${BATCH_LIMITS.MAX_FILES} files per batch.`, { status: 400 });
    }
    await rejectionService.assertUnderCap(userId);

    // 1. Free local checks + duplicate detection (no credits for any of these).
    type Planned = { file: IncomingFile; status: ItemStatus; mimeType?: string; hash?: string; code?: string; message?: string; duplicateOfName?: string };
    const planned: Planned[] = [];
    const hashes = files.map((f) => f.hash);
    const existing = await findDuplicatesByHashes(userId, hashes);
    const seenInBatch = new Map<string, string>();

    files.forEach((file, i) => {
      const pre = preflightFile(file);
      if (!pre.ok) return planned.push({ file, status: 'rejected', code: pre.code, message: pre.message });
      const hash = hashes[i];
      const lib = existing.get(hash);
      if (lib) return planned.push({ file, status: 'duplicate', hash, code: 'DUPLICATE_RESUME', message: `Duplicate of ${lib.candidateName}`, duplicateOfName: lib.candidateName });
      const twin = seenInBatch.get(hash);
      if (twin) return planned.push({ file, status: 'duplicate', hash, code: 'DUPLICATE_RESUME', message: `Duplicate of ${twin}`, duplicateOfName: twin });
      seenInBatch.set(hash, file.name);
      planned.push({ file, status: 'queued', mimeType: pre.mimeType, hash });
    });
    for (const s of skipped) {
      planned.push({ file: { name: s.name, size: 0, hash: '', read: async () => Buffer.alloc(0) }, status: 'rejected', code: s.reason, message: SKIP_MESSAGES[s.reason] });
    }

    const toProcess = planned.filter((p) => p.status === 'queued');
    const cost = toProcess.length * CREDIT_COST.RESUME_ANALYSIS;
    if (cost > 0) {
      const balance = await creditService.getBalance(userId);
      if (balance < cost) {
        throw new AppError('INSUFFICIENT_CREDITS', `Analyzing ${toProcess.length} resumes needs ${cost} credits, but you have ${balance}.`, {
          status: 402,
          details: { requiredCredits: cost, availableCredits: balance },
        });
      }
    }

    // 2. Batch + items. Queued items wait (run_after in the future) until their file is stored.
    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('upload_batches')
      .insert({ user_id: userId, kind: 'analyze_resume', total: planned.length, consent_at: new Date().toISOString() })
      .select('*')
      .single();
    if (batchErr || !batch) throw new AppError('DATABASE_ERROR', 'Could not start the batch. Please try again.', { status: 503 });

    return runWithLogContext({ batchId: batch.id }, async () => {
      const later = new Date(Date.now() + FAR_FUTURE_MS).toISOString();
      const rows = planned.map((p) => ({
        user_id: userId,
        batch_id: batch.id,
        kind: 'analyze_resume',
        status: p.status,
        charged: p.status === 'queued',
        run_after: later,
        error_code: p.code || null,
        error_message: p.message || null,
        payload: {
          fileName: p.file.name.slice(0, 200),
          mimeType: p.mimeType || null,
          fileSize: p.file.size,
          fileHash: p.hash || null,
          filePath: null,
          duplicateOfName: p.duplicateOfName || null,
        },
      }));
      const { data: items, error: itemsErr } = await supabaseAdmin.from('processing_jobs').insert(rows).select('id, status, payload');
      if (itemsErr || !items) {
        await supabaseAdmin.from('upload_batches').update({ status: 'cancelled', cancel_requested_at: new Date().toISOString() }).eq('id', batch.id);
        throw new AppError('DATABASE_ERROR', 'Could not queue the files. No credits were used.', { status: 503 });
      }

      // 3. Reserve the full cost. On failure nothing is charged and the items are cancelled.
      if (cost > 0) {
        try {
          await creditService.reserveCredits(userId, cost, batch.id, `Bulk resume analysis (${toProcess.length} files)`);
        } catch (err) {
          await supabaseAdmin
            .from('processing_jobs')
            .update({ status: 'cancelled', charged: false, error_code: 'INSUFFICIENT_CREDITS', error_message: 'Not enough credits.' })
            .eq('batch_id', batch.id)
            .eq('status', 'queued');
          await supabaseAdmin.from('upload_batches').update({ cancel_requested_at: new Date().toISOString() }).eq('id', batch.id);
          await refresh(batch.id);
          throw err;
        }
      }

      // 4. Store each file in the user's folder, then release its item to the worker.
      const queuedItems = items.filter((it: any) => it.status === 'queued');
      const byHash = new Map(toProcess.map((p) => [p.hash as string, p]));
      const failedUploads: Array<{ id: string }> = [];
      let cursor = 0;
      const uploadNext = async (): Promise<void> => {
        while (cursor < queuedItems.length) {
          const item: any = queuedItems[cursor++];
          const plan = byHash.get(item.payload.fileHash)!;
          try {
            const bytes = await plan.file.read();
            if (sha256(bytes) !== plan.hash) throw new Error('hash mismatch');
            const { filePath } = await storageService.uploadResumeFile(userId, bytes, plan.file.name, plan.mimeType!);
            await supabaseAdmin
              .from('processing_jobs')
              .update({ payload: { ...item.payload, filePath }, run_after: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq('id', item.id)
              .eq('status', 'queued');
          } catch {
            await supabaseAdmin
              .from('processing_jobs')
              .update({ status: 'failed', error_code: 'STORAGE_UPLOAD_FAILED', error_message: 'Could not store the file. Use "Retry failed" later.' })
              .eq('id', item.id);
            failedUploads.push({ id: item.id });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, queuedItems.length) }, uploadNext));
      await refundItems(userId, failedUploads, 'Refund: file could not be stored');

      const fresh = await refresh(batch.id);
      logger.info('batch.created', { kind: 'analyze_resume', total: planned.length, queued: toProcess.length - failedUploads.length });
      return { batch: mapBatch(fresh || batch), creditsReserved: cost };
    });
  },

  async createRankBatch(userId: string, jobId: string) {
    const job = await jobService.getJobRow(userId, jobId);
    if (!job) throw new AppError('NOT_FOUND', 'Job workspace not found.', { status: 404 });
    assertJobDescription(job.description);

    const attached: string[] = Array.isArray(job.attached_resume_ids) ? job.attached_resume_ids : [];
    if (attached.length === 0) throw new AppError('NO_RESUMES_ATTACHED', 'Attach resumes to this job before ranking.', { status: 400 });

    const { data: active } = await supabaseAdmin
      .from('upload_batches')
      .select('id')
      .eq('user_id', userId)
      .eq('job_id', jobId)
      .eq('kind', 'rank_resume')
      .eq('status', 'active')
      .limit(1);
    if (active && active.length) {
      throw new AppError('RANKING_IN_PROGRESS', 'This job is already being ranked. Please wait for it to finish.', { status: 409, details: { batchId: active[0].id } });
    }

    const { data: resumes } = await supabaseAdmin
      .from('resumes')
      .select('id, candidate_name, candidate_email, candidate_phone, created_at')
      .eq('user_id', userId)
      .in('id', attached.slice(0, 1000));
    const order = new Map(attached.map((id, i) => [id, i]));
    const list = (resumes || []).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    if (list.length === 0) throw new AppError('NO_RESUMES_ATTACHED', 'The attached resumes no longer exist.', { status: 400 });

    // Same email / phone inside one job = the same candidate: rank once, no extra credit.
    const seen = new Map<string, string>();
    const planned = list.map((r) => {
      const keys = candidateKeys(r.candidate_email, r.candidate_phone);
      const twin = keys.map((k) => seen.get(k)).find(Boolean);
      if (twin) return { resume: r, duplicateOfName: twin };
      keys.forEach((k) => seen.set(k, r.candidate_name || 'another candidate'));
      return { resume: r, duplicateOfName: null as string | null };
    });
    const toRank = planned.filter((p) => !p.duplicateOfName);
    const cost = toRank.length * CREDIT_COST.RANK_PER_RESUME;

    const balance = await creditService.getBalance(userId);
    if (balance < cost) {
      throw new AppError('INSUFFICIENT_CREDITS', `Ranking ${toRank.length} candidates needs ${cost} credits, but you have ${balance}.`, {
        status: 402,
        details: { requiredCredits: cost, availableCredits: balance },
      });
    }

    // Extract + cache JD requirements once, before charging (fails cleanly with 503).
    await jobService.ensureRequirements(userId, job);

    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('upload_batches')
      .insert({ user_id: userId, kind: 'rank_resume', job_id: jobId, total: planned.length })
      .select('*')
      .single();
    if (batchErr || !batch) throw new AppError('DATABASE_ERROR', 'Could not start ranking. Please try again.', { status: 503 });

    return runWithLogContext({ batchId: batch.id }, async () => {
      const rows = planned.map((p) => ({
        user_id: userId,
        batch_id: batch.id,
        kind: 'rank_resume',
        status: p.duplicateOfName ? 'duplicate' : 'queued',
        charged: !p.duplicateOfName,
        error_code: p.duplicateOfName ? 'DUPLICATE_CANDIDATE' : null,
        error_message: p.duplicateOfName ? `Duplicate of ${p.duplicateOfName}` : null,
        run_after: new Date(Date.now() + FAR_FUTURE_MS).toISOString(),
        payload: { jobId, resumeId: p.resume.id, candidateName: p.resume.candidate_name, duplicateOfName: p.duplicateOfName },
      }));
      const { error: itemsErr } = await supabaseAdmin.from('processing_jobs').insert(rows);
      if (itemsErr) {
        await supabaseAdmin.from('upload_batches').update({ status: 'cancelled', cancel_requested_at: new Date().toISOString() }).eq('id', batch.id);
        throw new AppError('DATABASE_ERROR', 'Could not queue ranking. No credits were used.', { status: 503 });
      }
      if (cost > 0) {
        try {
          await creditService.reserveCredits(userId, cost, batch.id, `Candidate ranking (${toRank.length}) for job: ${String(job.title).slice(0, 80)}`);
        } catch (err) {
          await supabaseAdmin
            .from('processing_jobs')
            .update({ status: 'cancelled', charged: false, error_code: 'INSUFFICIENT_CREDITS', error_message: 'Not enough credits.' })
            .eq('batch_id', batch.id)
            .eq('status', 'queued');
          await supabaseAdmin.from('upload_batches').update({ cancel_requested_at: new Date().toISOString() }).eq('id', batch.id);
          await refresh(batch.id);
          throw err;
        }
      }
      await supabaseAdmin.from('processing_jobs').update({ run_after: new Date().toISOString() }).eq('batch_id', batch.id).eq('status', 'queued');
      const fresh = await refresh(batch.id);
      logger.info('batch.created', { kind: 'rank_resume', total: planned.length, queued: toRank.length });
      return { batch: mapBatch(fresh || batch), creditsReserved: cost };
    });
  },

  async getBatch(userId: string, batchId: string) {
    const { data: batch } = await supabaseAdmin.from('upload_batches').select('*').eq('id', batchId).eq('user_id', userId).maybeSingle();
    if (!batch) return null;
    const { data: items } = await supabaseAdmin
      .from('processing_jobs')
      .select('id, kind, status, payload, error_code, error_message, result_ref, attempts, updated_at, created_at')
      .eq('batch_id', batchId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    return { ...mapBatch(batch), items: (items || []).map(mapItem) };
  },

  async listBatches(userId: string, opts: { activeOnly?: boolean; jobId?: string; limit?: number } = {}) {
    let q = supabaseAdmin.from('upload_batches').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(Math.min(opts.limit || 20, 50));
    if (opts.activeOnly) q = q.eq('status', 'active');
    if (opts.jobId) q = q.eq('job_id', opts.jobId);
    const { data } = await q;
    return (data || []).map(mapBatch);
  },

  async cancelBatch(userId: string, batchId: string) {
    const { data: batch } = await supabaseAdmin.from('upload_batches').select('id').eq('id', batchId).eq('user_id', userId).maybeSingle();
    if (!batch) return null;
    await supabaseAdmin.from('upload_batches').update({ cancel_requested_at: new Date().toISOString() }).eq('id', batchId);
    const { data: cancelled } = await supabaseAdmin
      .from('processing_jobs')
      .update({ status: 'cancelled', error_code: 'CANCELLED', error_message: 'Cancelled by you.', updated_at: new Date().toISOString() })
      .eq('batch_id', batchId)
      .eq('user_id', userId)
      .eq('status', 'queued')
      .select('id, payload');
    await refundItems(userId, cancelled || [], 'Refund: cancelled');
    // Cancelled uploads keep no file around.
    const paths = (cancelled || []).map((c: any) => c.payload?.filePath).filter((p: string) => typeof p === 'string' && p.startsWith(`${userId}/`));
    if (paths.length) await storageService.deleteResumeFiles(paths);
    await refresh(batchId);
    logger.info('batch.cancelled', { batchId, cancelled: (cancelled || []).length });
    return this.getBatch(userId, batchId);
  },

  async retryFailed(userId: string, batchId: string) {
    const { data: batch } = await supabaseAdmin.from('upload_batches').select('*').eq('id', batchId).eq('user_id', userId).maybeSingle();
    if (!batch) return null;
    const { data: failed } = await supabaseAdmin
      .from('processing_jobs')
      .select('id, retry_round, charged, payload, kind')
      .eq('batch_id', batchId)
      .eq('user_id', userId)
      .eq('status', 'failed');
    if (!failed || failed.length === 0) return this.getBatch(userId, batchId);

    // Make sure every earlier round was refunded before charging a new one (idempotent).
    await refundItems(userId, failed.filter((f) => f.charged), 'Refund: failed');

    const retryable = failed.filter((f) => f.kind === 'rank_resume' || f.payload?.filePath);
    if (retryable.length === 0) {
      throw new AppError('NOTHING_TO_RETRY', 'These files were never stored. Please upload them again.', { status: 400 });
    }
    const cost = retryable.length;
    const balance = await creditService.getBalance(userId);
    if (balance < cost) {
      throw new AppError('INSUFFICIENT_CREDITS', `Retrying ${cost} items needs ${cost} credits, but you have ${balance}.`, {
        status: 402,
        details: { requiredCredits: cost, availableCredits: balance },
      });
    }

    const later = new Date(Date.now() + FAR_FUTURE_MS).toISOString();
    for (const f of retryable) {
      await supabaseAdmin
        .from('processing_jobs')
        .update({ status: 'queued', attempts: 0, retry_round: (f.retry_round || 0) + 1, charged: true, error_code: null, error_message: null, run_after: later, locked_at: null })
        .eq('id', f.id)
        .eq('status', 'failed');
    }
    try {
      await creditService.reserveCredits(userId, cost, batchId, `Retry ${cost} failed item(s)`);
    } catch (err) {
      for (const f of retryable) {
        await supabaseAdmin
          .from('processing_jobs')
          .update({ status: 'failed', charged: false, error_code: 'INSUFFICIENT_CREDITS', error_message: 'Not enough credits to retry.' })
          .eq('id', f.id);
      }
      await refresh(batchId);
      throw err;
    }
    await supabaseAdmin.from('upload_batches').update({ cancel_requested_at: null }).eq('id', batchId);
    await supabaseAdmin
      .from('processing_jobs')
      .update({ run_after: new Date().toISOString() })
      .in('id', retryable.map((f) => f.id))
      .eq('status', 'queued');
    await refresh(batchId);
    logger.info('batch.retry', { batchId, count: cost });
    return this.getBatch(userId, batchId);
  },

  refresh,
  refundItems,
};
