import { Request, Response } from 'express';
import { resumeService } from '../services/resume.service';
import { sendSuccess, sendError } from '../utils/response';
import { logger } from '../utils/logger';

export const resumeController = {
  uploadResume: async (req: Request, res: Response): Promise<any> => {
    const requestStart = Date.now();
    logger.info('[ResumeAPI] request received');

    const user = req.user!;
    const file = req.file;

    logger.info(`[ResumeAPI] multer completed (${Date.now() - requestStart}ms)`);

    if (!file || !file.buffer) {
      logger.warn(`[ResumeAPI] file missing (${Date.now() - requestStart}ms)`);
      return sendError(res, 'No resume file provided for upload', 400, 'FILE_MISSING');
    }

    logger.info(`[ResumeAPI] file validated (${Date.now() - requestStart}ms) - name="${file.originalname}", size=${file.size} bytes, mime=${file.mimetype}`);

    try {
      const result = await resumeService.processAndSaveResume(
        user.id,
        file.buffer,
        file.originalname,
        file.mimetype,
        file.size,
        undefined,
        requestStart
      );

      const elapsed = Date.now() - requestStart;
      logger.info(`[ResumeAPI] response sent (${elapsed}ms)`);
      return sendSuccess(res, result, 'Resume processed and analyzed successfully', 201);
    } catch (err: any) {
      const elapsed = Date.now() - requestStart;
      const rawErrMsg = err.message || 'Failed to process resume file';
      logger.error(`[ResumeAPI] pipeline error after ${elapsed}ms: ${rawErrMsg}`);

      let errCode = err.code || 'PROCESS_FAILED';
      let statusCode = err.status || 500;
      let userFriendlyMsg = rawErrMsg;

      if (rawErrMsg.includes('INSUFFICIENT_CREDITS') || err.code === 'INSUFFICIENT_CREDITS') {
        errCode = 'INSUFFICIENT_CREDITS';
        statusCode = 402;
        userFriendlyMsg = 'You need 1 credit to analyze this resume.';
      } else if (rawErrMsg.includes('AI_SERVICE_UNAVAILABLE') || err.code === 'AI_SERVICE_UNAVAILABLE' || rawErrMsg.includes('high demand') || rawErrMsg.includes('503')) {
        errCode = 'AI_SERVICE_UNAVAILABLE';
        statusCode = 503;
        userFriendlyMsg = 'AI analysis is temporarily unavailable. Please try again.';
      } else if (rawErrMsg.includes('AI_ANALYSIS_TIMEOUT') || err.code === 'AI_ANALYSIS_TIMEOUT' || rawErrMsg.includes('timed out')) {
        errCode = 'AI_ANALYSIS_TIMEOUT';
        statusCode = 504;
        userFriendlyMsg = 'AI analysis timed out. Please try again.';
      } else if (rawErrMsg.includes('DATABASE_TIMEOUT') || err.code === 'DATABASE_TIMEOUT') {
        errCode = 'DATABASE_TIMEOUT';
        statusCode = 504;
        userFriendlyMsg = 'Database operation timed out. Please try again.';
      } else if (rawErrMsg.includes('File size exceeds') || rawErrMsg.includes('5MB limit') || err.code === 'FILE_TOO_LARGE') {
        errCode = 'FILE_TOO_LARGE';
        statusCode = 413;
        userFriendlyMsg = 'File size exceeds the 5MB limit.';
      } else if (rawErrMsg.includes("couldn't read enough text") || rawErrMsg.includes('clearer resume') || rawErrMsg.includes('TEXT_EXTRACTION_FAILED') || err.code === 'TEXT_EXTRACTION_FAILED') {
        errCode = 'TEXT_EXTRACTION_FAILED';
        statusCode = 422;
      } else if (rawErrMsg.includes('CREDIT_DEDUCTION_FAILED')) {
        errCode = 'CREDIT_DEDUCTION_FAILED';
        statusCode = 402;
      } else if (rawErrMsg.includes('GEMINI_VALIDATION_FAILED')) {
        errCode = 'GEMINI_VALIDATION_FAILED';
        statusCode = 422;
        userFriendlyMsg = 'AI analysis could not validate the document structure. Please try again.';
      }

      logger.info(`[ResumeAPI] sending error response: ${errCode} (${statusCode}) after ${elapsed}ms`);
      return sendError(res, userFriendlyMsg, statusCode, errCode);
    }
  },

  listResumes: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    try {
      const resumes = await resumeService.listResumes(user.id);
      return sendSuccess(res, resumes);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to retrieve resumes', 500);
    }
  },

  getResumeById: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;

    try {
      const resume = await resumeService.getResumeById(user.id, id);
      if (!resume) {
        return sendError(res, 'Resume not found or access denied', 404, 'NOT_FOUND');
      }
      return sendSuccess(res, resume);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to retrieve resume', 500);
    }
  },

  deleteResume: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;

    try {
      const success = await resumeService.deleteResume(user.id, id);
      if (!success) {
        return sendError(res, 'Failed to delete resume', 400, 'DELETE_FAILED');
      }
      return sendSuccess(res, { id }, 'Resume deleted successfully');
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to delete resume', 500);
    }
  }
};
