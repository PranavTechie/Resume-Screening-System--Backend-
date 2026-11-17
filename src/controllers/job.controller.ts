import { Request, Response } from 'express';
import { jobService } from '../services/job.service';
import { sendSuccess, sendError } from '../utils/response';
import { logger } from '../utils/logger';
import {
  JOB_DESCRIPTION_MIN_LENGTH,
  JOB_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_VALIDATION_MESSAGES,
} from '../config/constants';

export const jobController = {
  createJob: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const { title, company, description, location } = req.body;

    if (!title || typeof title !== 'string' || !title.trim()) {
      return sendError(res, 'Title is a required field.', 400, 'MISSING_TITLE');
    }

    if (!description || typeof description !== 'string' || !description.trim()) {
      return sendError(res, JOB_DESCRIPTION_VALIDATION_MESSAGES.REQUIRED, 400, 'JOB_DESCRIPTION_REQUIRED');
    }

    const descLength = description.length;
    if (descLength < JOB_DESCRIPTION_MIN_LENGTH) {
      return sendError(res, JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_SHORT, 400, 'JOB_DESCRIPTION_TOO_SHORT');
    }

    if (descLength > JOB_DESCRIPTION_MAX_LENGTH) {
      return sendError(res, JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_LONG, 400, 'JOB_DESCRIPTION_TOO_LONG');
    }

    try {
      const job = await jobService.createJob(user.id, { title, company, description, location });
      return sendSuccess(res, job, 'Job workspace created successfully', 201);
    } catch (err: any) {
      logger.error(`Error creating job: ${err.message}`);
      if (err.code === 'JOB_DESCRIPTION_TOO_SHORT' || err.code === 'JOB_DESCRIPTION_TOO_LONG' || err.code === 'JOB_DESCRIPTION_REQUIRED') {
        return sendError(res, err.message, 400, err.code);
      }
      return sendError(res, err.message || 'Failed to create job', 500);
    }
  },

  listJobs: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    try {
      const jobs = await jobService.listJobs(user.id);
      return sendSuccess(res, jobs);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to retrieve jobs', 500);
    }
  },

  getJobById: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;

    try {
      const job = await jobService.getJobById(user.id, id);
      if (!job) {
        return sendError(res, 'Job workspace not found', 404, 'NOT_FOUND');
      }
      return sendSuccess(res, job);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to retrieve job', 500);
    }
  },

  deleteJob: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;

    try {
      const success = await jobService.deleteJob(user.id, id);
      if (!success) {
        return sendError(res, 'Failed to delete job', 400, 'DELETE_FAILED');
      }
      return sendSuccess(res, { id }, 'Job workspace deleted successfully');
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to delete job', 500);
    }
  },

  attachResumes: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;
    const { resumeIds } = req.body;

    if (!Array.isArray(resumeIds) || resumeIds.length === 0) {
      return sendError(res, 'resumeIds must be a non-empty array of resume IDs', 400, 'INVALID_BODY');
    }

    try {
      const job = await jobService.attachResumes(user.id, id, resumeIds);
      if (!job) {
        return sendError(res, 'Job workspace not found', 404, 'NOT_FOUND');
      }
      return sendSuccess(res, job, 'Resumes attached to job successfully');
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to attach resumes', 500);
    }
  },

  detachResume: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;
    const resumeId = req.params.resumeId as string;

    try {
      const job = await jobService.detachResume(user.id, id, resumeId);
      if (!job) {
        return sendError(res, 'Job workspace not found', 404, 'NOT_FOUND');
      }
      return sendSuccess(res, job, 'Resume removed from job workspace');
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to detach resume', 500);
    }
  },

  rankCandidates: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;

    try {
      const result = await jobService.rankResumesForJob(user.id, id);
      return sendSuccess(res, result, 'Candidates ranked successfully');
    } catch (err: any) {
      if (err.code === 'INSUFFICIENT_CREDITS' || err.message?.includes('INSUFFICIENT_CREDITS')) {
        const required = err.requiredCredits || 0;
        const available = err.availableCredits || 0;
        return res.status(402).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: err.message || `Ranking candidate resumes requires ${required} credits, but only ${available} are available.`,
            requiredCredits: required,
            availableCredits: available,
          },
          timestamp: new Date().toISOString(),
        });
      }

      if (err.code === 'JOB_DESCRIPTION_TOO_SHORT' || err.code === 'JOB_DESCRIPTION_TOO_LONG' || err.code === 'JOB_DESCRIPTION_REQUIRED') {
        return sendError(res, err.message, 400, err.code);
      }
      return sendError(res, err.message || 'Failed to rank candidates', 500);
    }
  },

  generateJobDescription: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const { title, company, keywords } = req.body;

    if (!title) {
      return sendError(res, 'Job title is required for AI description generation.', 400, 'MISSING_TITLE');
    }

    try {
      const result = await jobService.generateJobDescription(user.id, title, company, keywords);
      return sendSuccess(res, result, 'AI Job description generated successfully');
    } catch (err: any) {
      const errMsg = err.message || 'Failed to generate job description';
      logger.error(`Error generating job description: ${errMsg}`);

      if (errMsg.includes('INSUFFICIENT_CREDITS')) {
        return sendError(res, errMsg, 402, 'INSUFFICIENT_CREDITS');
      }
      return sendError(res, errMsg, 500, 'GENERATE_FAILED');
    }
  }
};
