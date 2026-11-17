import { Request, Response, NextFunction } from 'express';
import { supabaseAnon } from '../config/supabase';
import { sendError } from '../utils/response';
import { logger } from '../utils/logger';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<any> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // In local dev without configured Supabase credentials, provide a safe fallback user
    if (process.env.NODE_ENV !== 'production' && !process.env.SUPABASE_URL) {
      req.user = {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'alex.morgan@resumescreening.ai',
      };
      return next();
    }
    return sendError(res, 'Authentication token is missing', 401, 'MISSING_TOKEN');
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);

    if (error || !user) {
      logger.warn(`Auth failed for provided token: ${error?.message || 'Invalid user'}`);
      return sendError(res, 'Invalid or expired authentication token', 401, 'INVALID_TOKEN');
    }

    req.user = {
      id: user.id,
      email: user.email || '',
    };

    return next();
  } catch (err: any) {
    logger.error(`Authentication error: ${err.message}`);
    return sendError(res, 'Authentication verification failed', 401, 'AUTH_ERROR');
  }
}
