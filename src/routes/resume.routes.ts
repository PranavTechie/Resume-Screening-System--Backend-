import { Router } from 'express';
import multer from 'multer';
import { resumeController } from '../controllers/resume.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { aiLimiter } from '../middleware/rateLimit.middleware';
import { sendError } from '../utils/response';
import { MAX_RESUME_FILE_SIZE, ALLOWED_RESUME_MIME_TYPES, ALLOWED_RESUME_EXTENSIONS } from '../config/constants';

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: {
    fileSize: MAX_RESUME_FILE_SIZE, // 5 MB limit (5 * 1024 * 1024 bytes)
  },
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    const isMimeAllowed = ALLOWED_RESUME_MIME_TYPES.includes(file.mimetype);
    const isExtAllowed = ALLOWED_RESUME_EXTENSIONS.some(allowedExt => ext.endsWith(allowedExt));

    if (isMimeAllowed || isExtAllowed) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a PDF, DOCX, DOC, TXT, JPG, or PNG file.'));
    }
  },
});

const router = Router();

router.post(
  '/resumes',
  requireAuth,
  aiLimiter,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return sendError(res, 'File size exceeds the 5MB limit.', 400, 'FILE_TOO_LARGE');
        }
        return sendError(res, err.message || 'File upload error', 400, 'FILE_VALIDATION_ERROR');
      }
      next();
    });
  },
  resumeController.uploadResume
);

router.get('/resumes', requireAuth, resumeController.listResumes);
router.get('/resumes/:id', requireAuth, resumeController.getResumeById);
router.delete('/resumes/:id', requireAuth, resumeController.deleteResume);

export default router;
