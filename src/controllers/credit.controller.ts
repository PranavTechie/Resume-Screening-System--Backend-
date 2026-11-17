import { Request, Response } from 'express';
import { creditService } from '../services/credit.service';
import { sendSuccess, sendError } from '../utils/response';

export const creditController = {
  getBalance: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    try {
      const balance = await creditService.getBalance(user.id);
      return sendSuccess(res, { credits: balance });
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to fetch credit balance', 500);
    }
  },

  getHistory: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    try {
      const history = await creditService.getTransactionHistory(user.id);
      return sendSuccess(res, history);
    } catch (err: any) {
      return sendError(res, err.message || 'Failed to fetch transaction history', 500);
    }
  }
};
