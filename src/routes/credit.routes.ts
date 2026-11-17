import { Router } from 'express';
import { creditController } from '../controllers/credit.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/credits/balance', requireAuth, creditController.getBalance);
router.get('/credits/history', requireAuth, creditController.getHistory);

export default router;
