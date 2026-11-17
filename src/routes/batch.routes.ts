import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.middleware';
import { aiLimiter, batchCreateLimiter, pollLimiter } from '../middleware/rateLimit.middleware';
import { batchService, IncomingFile } from '../services/batch.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendAppError, sendSuccess } from '../utils/response';
import { extractZipSafely } from '../utils/zip';
import { BATCH_LIMITS } from '../config/constants';

const TMP_DIR = path.join(os.tmpdir(), 'rss-uploads');
fs.mkdirSync(TMP_DIR, { recursive: true });

// Files go to a temp folder on disk (not RAM) so a 50-file batch can't exhaust memory.
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID()}`),
  }),
  limits: { fileSize: BATCH_LIMITS.MAX_ZIP_BYTES, files: BATCH_LIMITS.MAX_FILES + 1, fields: 10, fieldSize: 1024 },
});

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

const router = Router();

router.post(
  '/batches/upload',
  requireAuth,
  batchCreateLimiter,
  (req, res, next) =>
    upload.fields([
      { name: 'files', maxCount: BATCH_LIMITS.MAX_FILES },
      { name: 'zip', maxCount: 1 },
    ])(req, res, (err: any) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return sendAppError(res, { status: 413, code: 'FILE_TOO_LARGE', message: 'A file is larger than allowed (5 MB per resume, 50 MB per ZIP).' });
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return sendAppError(res, { status: 400, code: 'TOO_MANY_FILES', message: `Upload at most ${BATCH_LIMITS.MAX_FILES} files, or one ZIP.` });
      }
      return sendAppError(res, { status: 400, code: 'FILE_VALIDATION_ERROR', message: 'Could not read the uploaded files.' });
    }),
  asyncHandler(async (req, res) => {
    const groups = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const files = groups.files || [];
    const zips = groups.zip || [];
    const tempPaths = [...files, ...zips].map((f) => f.path);
    try {
      const consent = String(req.body?.consent || '').toLowerCase() === 'true';
      if (zips.length && files.length) {
        return sendAppError(res, { status: 400, code: 'MIXED_UPLOAD', message: 'Upload either separate files or one ZIP, not both.' });
      }

      let incoming: IncomingFile[] = [];
      let skipped: Awaited<ReturnType<typeof extractZipSafely>>['skipped'] = [];
      if (zips.length) {
        const zip = zips[0];
        if (!zip.originalname.toLowerCase().endsWith('.zip')) {
          return sendAppError(res, { status: 400, code: 'UNSUPPORTED_TYPE', message: 'The archive must be a .zip file.' });
        }
        const out = await extractZipSafely(zip.path, zip.size);
        skipped = out.skipped;
        incoming = out.files.map((f) => ({
          name: f.name,
          size: f.buffer.length,
          hash: crypto.createHash('sha256').update(f.buffer).digest('hex'),
          read: async () => f.buffer,
        }));
      } else {
        incoming = await Promise.all(
          files.map(async (f) => ({
            name: f.originalname,
            size: f.size,
            mimeType: f.mimetype,
            hash: f.size > 0 ? await hashFile(f.path) : '',
            read: () => fs.promises.readFile(f.path),
          }))
        );
      }

      const result = await batchService.createUploadBatch(req.user!.id, incoming, { consent, skipped });
      return sendSuccess(res, result, 'Batch queued', 202);
    } finally {
      await Promise.all(tempPaths.map((p) => fs.promises.unlink(p).catch(() => undefined)));
    }
  })
);

router.get(
  '/batches',
  requireAuth,
  asyncHandler(async (req, res) =>
    sendSuccess(
      res,
      await batchService.listBatches(req.user!.id, {
        activeOnly: req.query.active === '1' || req.query.active === 'true',
        jobId: typeof req.query.jobId === 'string' ? req.query.jobId : undefined,
      })
    )
  )
);

router.get(
  '/batches/:id',
  requireAuth,
  pollLimiter,
  asyncHandler(async (req, res) => {
    const batch = await batchService.getBatch(req.user!.id, String(req.params.id));
    return batch ? sendSuccess(res, batch) : sendAppError(res, { status: 404, code: 'NOT_FOUND', message: 'Batch not found.' });
  })
);

router.post(
  '/batches/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const batch = await batchService.cancelBatch(req.user!.id, String(req.params.id));
    return batch ? sendSuccess(res, batch) : sendAppError(res, { status: 404, code: 'NOT_FOUND', message: 'Batch not found.' });
  })
);

router.post(
  '/batches/:id/retry-failed',
  requireAuth,
  aiLimiter,
  asyncHandler(async (req, res) => {
    const batch = await batchService.retryFailed(req.user!.id, String(req.params.id));
    return batch ? sendSuccess(res, batch) : sendAppError(res, { status: 404, code: 'NOT_FOUND', message: 'Batch not found.' });
  })
);

export default router;
