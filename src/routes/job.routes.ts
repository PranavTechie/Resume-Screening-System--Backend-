import { Router, Response } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { aiLimiter, batchCreateLimiter } from '../middleware/rateLimit.middleware';
import { jobService } from '../services/job.service';
import { batchService } from '../services/batch.service';
import { asyncHandler } from '../utils/asyncHandler';
import { sendAppError, sendSuccess } from '../utils/response';

const router = Router();
const notFound = (res: Response) => sendAppError(res, { status: 404, code: 'NOT_FOUND', message: 'Job workspace not found.' });
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 1000) : []);

router.post(
  '/jobs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { title, company, description, location } = req.body || {};
    if (!title || typeof title !== 'string' || !title.trim()) return sendAppError(res, { status: 400, code: 'MISSING_TITLE', message: 'Title is required.' });
    return sendSuccess(res, await jobService.createJob(req.user!.id, { title, company, description, location }), 'Job created', 201);
  })
);
router.get('/jobs', requireAuth, asyncHandler(async (req, res) => sendSuccess(res, await jobService.listJobs(req.user!.id))));
router.get(
  '/jobs/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const job = await jobService.getJobById(req.user!.id, String(req.params.id));
    return job ? sendSuccess(res, job) : notFound(res);
  })
);
router.delete(
  '/jobs/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ok = await jobService.deleteJob(req.user!.id, String(req.params.id));
    return ok ? sendSuccess(res, { id: req.params.id }) : sendAppError(res, { status: 400, code: 'DELETE_FAILED', message: 'Could not delete job.' });
  })
);

router.post(
  '/jobs/:id/attach',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ids = idList(req.body?.resumeIds);
    if (!ids.length) return sendAppError(res, { status: 400, code: 'INVALID_BODY', message: 'resumeIds must be a non-empty array.' });
    const job = await jobService.attachResumes(req.user!.id, String(req.params.id), ids);
    return job ? sendSuccess(res, job) : notFound(res);
  })
);
router.post(
  '/jobs/:id/detach/:resumeId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const job = await jobService.detachResume(req.user!.id, String(req.params.id), String(req.params.resumeId));
    return job ? sendSuccess(res, job) : notFound(res);
  })
);
router.post(
  '/jobs/:id/detach',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ids = idList(req.body?.resumeIds);
    if (!ids.length) return sendAppError(res, { status: 400, code: 'INVALID_BODY', message: 'resumeIds must be a non-empty array.' });
    const job = await jobService.detachResumes(req.user!.id, String(req.params.id), ids);
    return job ? sendSuccess(res, job) : notFound(res);
  })
);

/** Ranking runs on the background queue: returns 202 + the batch to poll. */
router.post(
  '/jobs/:id/rank',
  requireAuth,
  batchCreateLimiter,
  asyncHandler(async (req, res) => sendSuccess(res, await batchService.createRankBatch(req.user!.id, String(req.params.id)), 'Ranking started', 202))
);

router.patch(
  '/jobs/:id/candidates/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ids = idList(req.body?.resumeIds);
    if (!ids.length) return sendAppError(res, { status: 400, code: 'INVALID_BODY', message: 'resumeIds must be a non-empty array.' });
    return sendSuccess(res, await jobService.updateCandidateStatus(req.user!.id, String(req.params.id), ids, String(req.body?.status || '')));
  })
);

router.get(
  '/jobs/:id/export.csv',
  requireAuth,
  asyncHandler(async (req, res) => {
    const blind = req.query.blind === '1' || req.query.blind === 'true';
    const { filename, csv } = await jobService.exportRankingCsv(req.user!.id, String(req.params.id), blind);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(csv);
  })
);

router.post(
  '/jobs/generate-description',
  requireAuth,
  aiLimiter,
  asyncHandler(async (req, res) => {
    const { title, company, keywords } = req.body || {};
    if (!title || typeof title !== 'string') return sendAppError(res, { status: 400, code: 'MISSING_TITLE', message: 'Job title is required.' });
    return sendSuccess(
      res,
      await jobService.generateJobDescription(req.user!.id, title.slice(0, 200), typeof company === 'string' ? company.slice(0, 200) : undefined, typeof keywords === 'string' ? keywords.slice(0, 500) : undefined)
    );
  })
);

export default router;
