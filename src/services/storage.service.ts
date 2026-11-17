import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';

export function safeStorageName(fileName: string): string {
  const cleaned = (fileName || 'resume').replace(/[^a-zA-Z0-9.-]/g, '_').replace(/_+/g, '_').slice(-80);
  return cleaned || 'resume';
}

export const storageService = {
  /** Upload into the user's own folder. Throws on failure (never returns a fake path). */
  async uploadResumeFile(userId: string, fileBuffer: Buffer, fileName: string, mimeType: string): Promise<{ filePath: string }> {
    const filePath = `${userId}/${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${safeStorageName(fileName)}`;
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await supabaseAdmin.storage
        .from(env.SUPABASE_STORAGE_BUCKET)
        .upload(filePath, fileBuffer, { contentType: mimeType || 'application/octet-stream', upsert: false });
      if (!error) return { filePath: data?.path || filePath };
      lastErr = error.message;
      if (/already exists|Duplicate/i.test(error.message)) return { filePath };
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    logger.error('storage.upload_failed', { error: lastErr });
    throw new AppError('STORAGE_UPLOAD_FAILED', 'Could not store the file. Please try again.', { status: 503, retryable: true });
  },

  async downloadResumeFile(filePath: string): Promise<Buffer> {
    const { data, error } = await supabaseAdmin.storage.from(env.SUPABASE_STORAGE_BUCKET).download(filePath);
    if (error || !data) {
      const notFound = /not found|404|Object not found/i.test(error?.message || '');
      throw new AppError(notFound ? 'STORAGE_FILE_MISSING' : 'STORAGE_DOWNLOAD_FAILED', 'The uploaded file could not be read.', {
        status: notFound ? 410 : 503,
        retryable: !notFound,
      });
    }
    return Buffer.from(await data.arrayBuffer());
  },

  async deleteResumeFile(filePath: string): Promise<boolean> {
    return (await this.deleteResumeFiles([filePath])) === 1;
  },

  /** Delete many objects (only paths inside the bucket; callers pass the user's own paths). */
  async deleteResumeFiles(paths: string[]): Promise<number> {
    const clean = Array.from(new Set(paths.filter(Boolean)));
    let removed = 0;
    for (let i = 0; i < clean.length; i += 100) {
      const chunk = clean.slice(i, i + 100);
      const { data, error } = await supabaseAdmin.storage.from(env.SUPABASE_STORAGE_BUCKET).remove(chunk);
      if (error) logger.warn('storage.delete_failed', { count: chunk.length, error: error.message });
      else removed += data?.length || 0;
    }
    return removed;
  },
};
