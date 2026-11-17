import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { creditService } from '../services/credit.service';
import { preferenceService } from '../services/preference.service';
import { resumeService } from '../services/resume.service';
import { storageService } from '../services/storage.service';
import { env } from '../config/env';
import { sendAppError, sendSuccess } from '../utils/response';
import { logger } from '../utils/logger';

export const authController = {
  getMe: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    let credits: number;
    try {
      credits = await creditService.getBalance(user.id);
    } catch (err: any) {
      return sendAppError(res, err);
    }
    const preferences = await preferenceService.getPreferences(user.id);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .maybeSingle();

    return sendSuccess(res, {
      user: {
        id: user.id,
        email: user.email,
        name: profile?.full_name || (user.email ? user.email.split('@')[0] : 'User'),
        role: 'Technical Professional',
      },
      credits,
      preferences,
    });
  },

  deleteAccount: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const userId = user.id;

    try {
      // Delete the user's resume files from Storage first (rows cascade with the auth user).
      try {
        await resumeService.deleteAllResumes(userId);
        const { data: objects } = await supabaseAdmin.storage.from(env.SUPABASE_STORAGE_BUCKET).list(userId, { limit: 1000 });
        if (objects?.length) await storageService.deleteResumeFiles(objects.map((o) => `${userId}/${o.name}`));
      } catch (storageErr: any) {
        logger.warn('account.delete_files_failed', { error: String(storageErr?.message || storageErr).slice(0, 200) });
      }

      // Delete associated profile & records
      try {
        await supabaseAdmin.from('profiles').delete().eq('id', userId);
        await supabaseAdmin.from('user_preferences').delete().eq('user_id', userId);
        await supabaseAdmin.from('resumes').delete().eq('user_id', userId);
        await supabaseAdmin.from('jobs').delete().eq('user_id', userId);
        await supabaseAdmin.from('reports').delete().eq('user_id', userId);
      } catch (dbErr) {
        logger.warn('account.delete_rows_notice', { error: String((dbErr as any)?.message || dbErr).slice(0, 200) });
      }

      // Delete user from Supabase Auth admin system
      const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteAuthError) {
        throw deleteAuthError;
      }

      return sendSuccess(res, { message: 'Account permanently deleted' });
    } catch (err: any) {
      logger.error('account.delete_failed', { error: String(err?.message || err).slice(0, 200) });
      return res.status(500).json({
        success: false,
        error: { message: err.message || 'Unable to delete your account. Please try again.' },
      });
    }
  },
};
