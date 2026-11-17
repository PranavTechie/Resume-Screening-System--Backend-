import { Router } from 'express';
import { jobController } from '../controllers/job.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { aiLimiter } from '../middleware/rateLimit.middleware';

const router = Router();

router.post('/jobs', requireAuth, jobController.createJob);
router.get('/jobs', requireAuth, jobController.listJobs);
router.get('/jobs/:id', requireAuth, jobController.getJobById);
router.delete('/jobs/:id', requireAuth, jobController.deleteJob);

router.post('/jobs/:id/attach', requireAuth, jobController.attachResumes);
router.post('/jobs/:id/detach/:resumeId', requireAuth, jobController.detachResume);
router.post('/jobs/:id/rank', requireAuth, aiLimiter, jobController.rankCandidates);
router.post('/jobs/generate-description', requireAuth, aiLimiter, jobController.generateJobDescription);

export default router;
