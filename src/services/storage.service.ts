import { supabaseAdmin } from '../config/supabase';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const storageService = {
  async uploadResumeFile(
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string
  ): Promise<{ filePath: string; publicUrl?: string }> {
    const bucket = env.SUPABASE_STORAGE_BUCKET;
    const cleanFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `${userId}/${Date.now()}_${cleanFileName}`;

    try {
      const { data, error } = await supabaseAdmin.storage
        .from(bucket)
        .upload(filePath, fileBuffer, {
          contentType: mimeType,
          upsert: true,
        });

      if (error) {
        logger.warn(`Supabase Storage upload warning: ${error.message}. Proceeding with local path reference.`);
      }

      return {
        filePath: data?.path || filePath,
      };
    } catch (err: any) {
      logger.error(`Storage service error: ${err.message}`);
      return { filePath };
    }
  },

  async deleteResumeFile(filePath: string): Promise<boolean> {
    const bucket = env.SUPABASE_STORAGE_BUCKET;
    try {
      const { error } = await supabaseAdmin.storage.from(bucket).remove([filePath]);
      if (error) {
        logger.warn(`Storage delete warning for path ${filePath}: ${error.message}`);
        return false;
      }
      return true;
    } catch (err: any) {
      logger.error(`Storage service delete error: ${err.message}`);
      return false;
    }
  },

  async getSignedUrl(filePath: string): Promise<string | null> {
    const bucket = env.SUPABASE_STORAGE_BUCKET;
    try {
      const { data, error } = await supabaseAdmin.storage
        .from(bucket)
        .createSignedUrl(filePath, 3600); // 1 hour validity

      if (error) return null;
      return data.signedUrl;
    } catch {
      return null;
    }
  }
};
