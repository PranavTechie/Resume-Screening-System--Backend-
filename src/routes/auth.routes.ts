import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/auth/me', requireAuth, authController.getMe);
router.delete('/auth/account', requireAuth, authController.deleteAccount);

export default router;
