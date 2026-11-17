import { supabaseAdmin } from '../config/supabase';
import { REJECTION_CAP } from '../config/constants';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

/** Layer C: max 15 rejected uploads per user per rolling 24h. Stored in upload_rejections. */
export const rejectionService = {
  async countRecent(userId: string): Promise<number> {
    const since = new Date(Date.now() - REJECTION_CAP.WINDOW_HOURS * 3600_000).toISOString();
    const { count, error } = await supabaseAdmin
      .from('upload_rejections')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('created_at', since);
    if (error) {
      logger.warn('rejections.count_failed', { error: error.message });
      return 0;
    }
    return count || 0;
  },

  async remaining(userId: string): Promise<number> {
    return Math.max(0, REJECTION_CAP.MAX_REJECTIONS - (await this.countRecent(userId)));
  },

  async assertUnderCap(userId: string): Promise<void> {
    if ((await this.remaining(userId)) <= 0) {
      throw new AppError(
        'TOO_MANY_REJECTED_UPLOADS',
        `Too many files were rejected in the last ${REJECTION_CAP.WINDOW_HOURS} hours. Please try again later and upload only resumes/CVs.`,
        { status: 429 }
      );
    }
  },

  async record(userId: string, errorCode: string): Promise<void> {
    const { error } = await supabaseAdmin.from('upload_rejections').insert({ user_id: userId, error_code: errorCode });
    if (error) logger.warn('rejections.record_failed', { error: error.message });
  },
};
