import { Request, Response } from 'express';
import { supabaseAdmin } from '../config/supabase';
import { creditService } from '../services/credit.service';
import { preferenceService } from '../services/preference.service';
import { sendSuccess } from '../utils/response';

export const authController = {
  getMe: async (req: Request, res: Response): Promise<any> => {
    const user = req.user!;
    const credits = await creditService.getBalance(user.id);
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
      // Delete associated profile & records
      try {
        await supabaseAdmin.from('profiles').delete().eq('id', userId);
        await supabaseAdmin.from('user_preferences').delete().eq('user_id', userId);
        await supabaseAdmin.from('resumes').delete().eq('user_id', userId);
        await supabaseAdmin.from('jobs').delete().eq('user_id', userId);
        await supabaseAdmin.from('reports').delete().eq('user_id', userId);
      } catch (dbErr) {
        console.warn('Notice during table data cleanup:', dbErr);
      }

      // Delete user from Supabase Auth admin system
      const { error: deleteAuthError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (deleteAuthError) {
        console.error('Supabase admin deleteUser error:', deleteAuthError);
        throw deleteAuthError;
      }

      return sendSuccess(res, { message: 'Account permanently deleted' });
    } catch (err: any) {
      console.error('Account deletion error:', err);
      return res.status(500).json({
        success: false,
        error: { message: err.message || 'Unable to delete your account. Please try again.' },
      });
    }
  },
};
