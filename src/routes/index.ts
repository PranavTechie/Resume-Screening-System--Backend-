import { Router } from 'express';
import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import resumeRoutes from './resume.routes';
import jobRoutes from './job.routes';
import batchRoutes from './batch.routes';
import creditRoutes from './credit.routes';
import preferenceRoutes from './preference.routes';
import reportRoutes from './report.routes';
import dataRoutes from './data.routes';

const router = Router();

router.use('/', healthRoutes);
router.use('/api', authRoutes);
router.use('/api', resumeRoutes);
router.use('/api', jobRoutes);
router.use('/api', batchRoutes);
router.use('/api', creditRoutes);
router.use('/api', preferenceRoutes);
router.use('/api', reportRoutes);
router.use('/api', dataRoutes);

export default router;
