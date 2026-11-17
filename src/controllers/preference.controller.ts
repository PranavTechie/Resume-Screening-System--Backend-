import { Request, Response } from 'express';
import { preferenceService } from '../services/preference.service';
import { sendSuccess, sendError } from '../utils/response';

export const preferenceController = {
  getPreferences: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    try {
      const prefs = await preferenceService.getPreferences(user.id);
      return sendSuccess(res, prefs);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to fetch user preferences', 500);
    }
  },

  updatePreferences: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    try {
      const prefs = await preferenceService.updatePreferences(user.id, req.body);
      return sendSuccess(res, prefs, 'Preferences updated successfully');
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to update preferences', 500);
    }
  }
};
