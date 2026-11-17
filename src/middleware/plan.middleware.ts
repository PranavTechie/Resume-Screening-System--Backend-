import { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';

export async function requireProOrMaxPlan(req: Request, res: Response, next: NextFunction): Promise<any> {
  if (!req.user || !req.user.id) {
    return sendError(res, 'Authentication required.', 401, 'UNAUTHORIZED');
  }

  // Under the credit-only model, all features are accessible across all plans.
  return next();
}
