import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.middleware';
import { aiLimiter } from '../middleware/rateLimit.middleware';
import { resumeService } from '../services/resume.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendAppError, sendSuccess } from '../utils/response';
import { toAppError } from '../utils/errors';
import { MAX_RESUME_FILE_SIZE } from '../config/constants';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RESUME_FILE_SIZE, files: 1 } });

const router = Router();

router.post(
  '/resumes',
  requireAuth,
  aiLimiter,
  (req, res, next) =>
    upload.single('file')(req, res, (err: any) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return sendAppError(res, { status: 413, code: 'FILE_TOO_LARGE', message: 'File size exceeds the 5MB limit.' });
      return sendAppError(res, { status: 400, code: 'FILE_VALIDATION_ERROR', message: 'Could not read the uploaded file.' });
    }),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file?.buffer) return sendAppError(res, { status: 400, code: 'FILE_MISSING', message: 'No resume file provided.' });
    try {
      const result = await resumeService.processSingleUpload(req.user!.id, file);
      return sendSuccess(res, result, 'Resume analyzed', 201);
    } catch (raw) {
      const err = toAppError(raw);
      return sendAppError(res, err, { creditsRemaining: (raw as any)?.creditsRemaining });
    }
  })
);

router.get('/resumes', requireAuth, asyncHandler(async (req, res) => sendSuccess(res, await resumeService.listResumes(req.user!.id))));

router.get(
  '/resumes/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const resume = await resumeService.getResumeById(req.user!.id, String(req.params.id));
    if (!resume) return sendAppError(res, { status: 404, code: 'NOT_FOUND', message: 'Resume not found.' });
    return sendSuccess(res, resume);
  })
);

router.delete(
  '/resumes/:id',
  requireAuth,
  asyncHandler(async (req, res) => sendSuccess(res, await resumeService.deleteResumes(req.user!.id, [String(req.params.id)])))
);

router.post(
  '/resumes/bulk-delete',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body?.resumeIds) ? req.body.resumeIds.slice(0, 1000) : [];
    if (ids.length === 0) return sendAppError(res, { status: 400, code: 'INVALID_BODY', message: 'resumeIds must be a non-empty array.' });
    return sendSuccess(res, await resumeService.deleteResumes(req.user!.id, ids));
  })
);

export default router;
