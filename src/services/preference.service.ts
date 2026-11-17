import { supabaseAdmin } from '../config/supabase';
import { logger } from '../utils/logger';

export interface UserPreferences {
  theme: 'light' | 'dark' | 'system';
  reduceMotion: boolean;
  compactDensity: boolean;
  autoSaveDrafts: boolean;
}

export const preferenceService = {
  async getPreferences(userId: string): Promise<UserPreferences> {
    try {
      const { data, error } = await supabaseAdmin
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (error || !data) {
        return {
          theme: 'system',
          reduceMotion: false,
          compactDensity: false,
          autoSaveDrafts: true,
        };
      }

      return {
        theme: data.theme || 'system',
        reduceMotion: data.reduce_motion ?? false,
        compactDensity: data.compact_density ?? false,
        autoSaveDrafts: data.auto_save_drafts ?? true,
      };
    } catch {
      return {
        theme: 'system',
        reduceMotion: false,
        compactDensity: false,
        autoSaveDrafts: true,
      };
    }
  },

  async updatePreferences(userId: string, prefs: Partial<UserPreferences>): Promise<UserPreferences> {
    try {
      const current = await this.getPreferences(userId);
      const updated = { ...current, ...prefs };

      const { error } = await supabaseAdmin
        .from('user_preferences')
        .upsert({
          user_id: userId,
          theme: updated.theme,
          reduce_motion: updated.reduceMotion,
          compact_density: updated.compactDensity,
          auto_save_drafts: updated.autoSaveDrafts,
          updated_at: new Date().toISOString(),
        });

      if (error) {
        logger.warn(`Failed to save preferences to DB: ${error.message}`);
      }

      return updated;
    } catch (err: any) {
      logger.error(`Error updating preferences: ${err.message}`);
      return {
        theme: prefs.theme || 'system',
        reduceMotion: prefs.reduceMotion ?? false,
        compactDensity: prefs.compactDensity ?? false,
        autoSaveDrafts: prefs.autoSaveDrafts ?? true,
      };
    }
  }
};
