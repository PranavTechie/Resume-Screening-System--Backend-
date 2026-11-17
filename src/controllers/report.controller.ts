import { Request, Response } from 'express';
import { reportService } from '../services/report.service';
import { sendSuccess, sendError } from '../utils/response';

export const reportController = {
  listReports: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    try {
      const reports = await reportService.listReports(user.id);
      return sendSuccess(res, reports);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to list reports', 500);
    }
  },

  createReport: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const { title, reportType, candidateName, score, atsPassRate, summary, data } = req.body;

    if (!title || !reportType || !candidateName) {
      return sendError(res, 'Title, reportType, and candidateName are required.', 400, 'MISSING_FIELDS');
    }

    try {
      const report = await reportService.createReport(user.id, {
        title,
        reportType,
        candidateName,
        score: score || 85,
        atsPassRate: atsPassRate || 90,
        summary: summary || '',
        data,
      });

      return sendSuccess(res, report, 'Analysis report created successfully', 201);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to create report', 500);
    }
  },

  deleteReport: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;

    try {
      const success = await reportService.deleteReport(user.id, id);
      if (!success) {
        return sendError(res, 'Failed to delete report', 400, 'DELETE_FAILED');
      }
      return sendSuccess(res, { id }, 'Report deleted successfully');
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to delete report', 500);
    }
  },

  exportReport: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const id = req.params.id as string;

    try {
      return sendSuccess(res, { reportId: id, exportAllowed: true }, 'PDF Report export authorized.');
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to authorize report export', 500);
    }
  }
};
