import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { resumeService } from '../services/resume.service';
import { storageService } from '../services/storage.service';
import { supabaseAdmin } from '../config/supabase';
import { env } from '../config/env';
import { asyncHandler } from '../utils/asyncHandler';
import { sendAppError, sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';

const router = Router();

/** Settings -> Data: download everything we store about the user as JSON. */
router.get(
  '/data/export',
  requireAuth,
  asyncHandler(async (req, res) => {
    const data = await resumeService.exportUserData(req.user!.id);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="resume-screening-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(JSON.stringify(data, null, 2));
  })
);

/** Settings -> Data: delete ALL of the user's resumes/candidates and every stored file. */
router.delete(
  '/data/resumes',
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.body?.confirm !== 'DELETE') {
      return sendAppError(res, { status: 400, code: 'CONFIRMATION_REQUIRED', message: 'Type DELETE to confirm.' });
    }
    const userId = req.user!.id;
    const { deleted } = await resumeService.deleteAllResumes(userId);

    // Also remove any leftover files in the user's own folder (failed / cancelled uploads).
    let removedFiles = 0;
    for (let page = 0; page < 50; page++) {
      const { data: objects, error } = await supabaseAdmin.storage.from(env.SUPABASE_STORAGE_BUCKET).list(userId, { limit: 100 });
      if (error || !objects || objects.length === 0) break;
      removedFiles += await storageService.deleteResumeFiles(objects.map((o) => `${userId}/${o.name}`));
      if (objects.length < 100) break;
    }
    await supabaseAdmin.from('upload_batches').delete().eq('user_id', userId).neq('status', 'active');
    logger.info('data.resumes_deleted', { deleted, removedFiles });
    return sendSuccess(res, { deleted, removedFiles });
  })
);

export default router;
