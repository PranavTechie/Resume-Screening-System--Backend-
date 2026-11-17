/**
 * Safe ZIP extraction for bulk resume uploads.
 *  - max 50 file entries, max 50 MB compressed / 100 MB uncompressed (actual bytes, not headers)
 *  - no nested archives, no path traversal ("..") and no absolute paths
 *  - only allowed resume extensions; everything else is skipped and reported
 */
import yauzl from 'yauzl';
import path from 'path';
import { ALLOWED_RESUME_EXTENSIONS, BATCH_LIMITS, MAX_RESUME_FILE_SIZE } from '../config/constants';
import { AppError } from './errors';

export interface ExtractedFile {
  name: string;
  buffer: Buffer;
}

export interface SkippedEntry {
  name: string;
  reason: 'UNSUPPORTED_TYPE' | 'FILE_TOO_LARGE' | 'EMPTY_FILE' | 'ENCRYPTED';
}

export interface ZipExtractResult {
  files: ExtractedFile[];
  skipped: SkippedEntry[];
}

export interface ZipLimits {
  maxEntries: number;
  maxCompressedBytes: number;
  maxUncompressedBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: BATCH_LIMITS.MAX_ZIP_ENTRIES,
  maxCompressedBytes: BATCH_LIMITS.MAX_ZIP_BYTES,
  maxUncompressedBytes: BATCH_LIMITS.MAX_ZIP_UNCOMPRESSED_BYTES,
  maxFileBytes: MAX_RESUME_FILE_SIZE,
};

const ARCHIVE_EXT = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.jar', '.war']);

const zipError = (code: string, message: string) => new AppError(code, message, { status: 400, outcome: 'rejected' });

export type EntryNameVerdict = { action: 'extract'; name: string } | { action: 'skip-silent' } | { action: 'skip'; name: string; reason: SkippedEntry['reason'] };

/** Pure check of one entry name. Throws on traversal / absolute paths / nested archives. */
export function classifyZipEntryName(rawName: string): EntryNameVerdict {
  const name = String(rawName || '').replace(/\\/g, '/');
  if (!name || name.includes('\0')) throw zipError('ZIP_UNSAFE_PATH', 'The ZIP contains an invalid file name.');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw zipError('ZIP_UNSAFE_PATH', 'The ZIP contains absolute file paths, which are not allowed.');
  }
  const segments = name.split('/');
  if (segments.some((s) => s === '..')) {
    throw zipError('ZIP_UNSAFE_PATH', 'The ZIP contains "../" paths, which are not allowed.');
  }
  if (name.endsWith('/')) return { action: 'skip-silent' }; // directory
  const base = segments[segments.length - 1];
  if (segments[0] === '__MACOSX' || base.startsWith('.') || base.toLowerCase() === 'thumbs.db' || base.toLowerCase() === 'desktop.ini') {
    return { action: 'skip-silent' };
  }
  const ext = path.extname(base).toLowerCase();
  if (ARCHIVE_EXT.has(ext)) {
    throw zipError('ZIP_NESTED_ARCHIVE', 'ZIP files inside the ZIP are not allowed. Please upload one flat ZIP.');
  }
  if (!ALLOWED_RESUME_EXTENSIONS.includes(ext)) return { action: 'skip', name: base, reason: 'UNSUPPORTED_TYPE' };
  return { action: 'extract', name: base };
}

function openZip(input: Buffer | string): Promise<yauzl.ZipFile> {
  const opts: yauzl.Options = { lazyEntries: true, autoClose: true, decodeStrings: false, validateEntrySizes: true };
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, zip?: yauzl.ZipFile) => {
      if (err || !zip) return reject(zipError('ZIP_INVALID', 'This ZIP file is damaged or not a real ZIP.'));
      resolve(zip);
    };
    if (typeof input === 'string') yauzl.open(input, opts, cb);
    else yauzl.fromBuffer(input, opts, cb);
  });
}

export async function extractZipSafely(input: Buffer | string, compressedSize: number, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipExtractResult> {
  if (compressedSize > limits.maxCompressedBytes) {
    throw zipError('ZIP_TOO_LARGE', `ZIP files can be at most ${Math.round(limits.maxCompressedBytes / 1048576)} MB.`);
  }
  const zip = await openZip(input);
  // Hard cap on raw entries (dirs included) so a ZIP with 1M tiny entries can't stall us.
  if (zip.entryCount > limits.maxEntries * 4) {
    zip.close();
    throw zipError('ZIP_TOO_MANY_FILES', `A ZIP can contain at most ${limits.maxEntries} resumes.`);
  }

  const files: ExtractedFile[] = [];
  const skipped: SkippedEntry[] = [];
  let totalBytes = 0;
  let fileEntries = 0;

  return new Promise<ZipExtractResult>((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch { /* already closed */ }
      reject(err);
    };

    zip.on('error', () => fail(zipError('ZIP_INVALID', 'This ZIP file is damaged or not a real ZIP.')));
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ files, skipped });
    });

    zip.on('entry', (entry: yauzl.Entry) => {
      if (settled) return;
      let verdict: EntryNameVerdict;
      try {
        const rawName = Buffer.isBuffer(entry.fileName) ? (entry.fileName as unknown as Buffer).toString('utf8') : String(entry.fileName);
        verdict = classifyZipEntryName(rawName);
      } catch (err) {
        return fail(err as Error);
      }

      if (verdict.action === 'skip-silent') return zip.readEntry();

      fileEntries += 1;
      if (fileEntries > limits.maxEntries) {
        return fail(zipError('ZIP_TOO_MANY_FILES', `A ZIP can contain at most ${limits.maxEntries} resumes.`));
      }
      if (verdict.action === 'skip') {
        skipped.push({ name: verdict.name, reason: verdict.reason });
        return zip.readEntry();
      }
      if (entry.isEncrypted()) {
        skipped.push({ name: verdict.name, reason: 'ENCRYPTED' });
        return zip.readEntry();
      }
      if (entry.uncompressedSize > limits.maxFileBytes) {
        skipped.push({ name: verdict.name, reason: 'FILE_TOO_LARGE' });
        return zip.readEntry();
      }
      if (totalBytes + entry.uncompressedSize > limits.maxUncompressedBytes) {
        return fail(zipError('ZIP_TOO_LARGE', `The ZIP expands to more than ${Math.round(limits.maxUncompressedBytes / 1048576)} MB.`));
      }

      const name = verdict.name;
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return fail(zipError('ZIP_INVALID', 'This ZIP file is damaged or not a real ZIP.'));
        const chunks: Buffer[] = [];
        let entryBytes = 0;
        stream.on('data', (chunk: Buffer) => {
          entryBytes += chunk.length;
          totalBytes += chunk.length;
          // Never trust headers: count the real inflated bytes.
          if (entryBytes > limits.maxFileBytes || totalBytes > limits.maxUncompressedBytes) {
            stream.destroy();
            return fail(zipError('ZIP_TOO_LARGE', 'The ZIP expands to more data than allowed.'));
          }
          chunks.push(chunk);
        });
        stream.on('error', () => fail(zipError('ZIP_INVALID', 'This ZIP file is damaged or not a real ZIP.')));
        stream.on('end', () => {
          if (settled) return;
          if (entryBytes === 0) skipped.push({ name, reason: 'EMPTY_FILE' });
          else files.push({ name, buffer: Buffer.concat(chunks) });
          zip.readEntry();
        });
      });
    });

    zip.readEntry();
  });
}
