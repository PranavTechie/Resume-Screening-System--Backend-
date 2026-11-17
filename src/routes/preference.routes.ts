import { Router } from 'express';
import { preferenceController } from '../controllers/preference.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.get('/preferences', requireAuth, preferenceController.getPreferences);
router.put('/preferences', requireAuth, preferenceController.updatePreferences);

export default router;
