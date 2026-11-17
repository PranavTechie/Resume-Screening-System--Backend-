import { Router } from 'express';
import { reportController } from '../controllers/report.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/reports', requireAuth, reportController.listReports);
router.post('/reports', requireAuth, reportController.createReport);
router.get('/reports/:id/export', requireAuth, reportController.exportReport);
router.delete('/reports/:id', requireAuth, reportController.deleteReport);

export default router;
