import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { RESUME_VALIDATION } from '../config/constants';
import { logger } from './logger';

export interface LocalExtraction {
  /** Text read locally (empty for images / scanned PDFs). */
  text: string;
  /** PDF page count when the file is a PDF and it could be counted. */
  pageCount: number | null;
  /** True for images and scanned PDFs: the text must be read with Gemini vision. */
  needsVision: boolean;
}

export function isPdf(mimeType: string, fileName: string): boolean {
  return (mimeType || '').includes('pdf') || fileName.toLowerCase().endsWith('.pdf');
}

export function isImage(mimeType: string, fileName: string): boolean {
  return (mimeType || '').startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(fileName);
}

/** Cheap page count straight from the PDF bytes (fallback when pdf-parse fails). */
export function countPdfPagesRaw(buffer: Buffer): number | null {
  const raw = buffer.toString('latin1');
  const matches = raw.match(/\/Type\s*\/Page(?!s)\b/g);
  return matches && matches.length > 0 ? matches.length : null;
}

/** Printable text runs from a legacy binary .doc (mammoth only supports .docx). */
function extractLegacyDocText(buffer: Buffer): string {
  const utf16 = buffer.toString('utf16le').replace(/[^\x20-\x7Eऀ-ॿ\n\r\t]+/g, ' ');
  const latin = buffer.toString('latin1').replace(/[^\x20-\x7E\n\r\t]+/g, ' ');
  const pick = (s: string) => s.split(/\s{2,}/).filter((w) => w.trim().length >= 3).join(' ').replace(/\s+/g, ' ').trim();
  const a = pick(utf16);
  const b = pick(latin);
  return a.length > b.length ? a : b;
}

export async function extractTextLocally(buffer: Buffer, mimeType: string, fileName: string): Promise<LocalExtraction> {
  const lower = fileName.toLowerCase();

  if (isPdf(mimeType, fileName)) {
    let text = '';
    let pageCount: number | null = null;
    try {
      const parsed = await pdfParse(buffer);
      text = (parsed.text || '').trim();
      pageCount = typeof parsed.numpages === 'number' ? parsed.numpages : null;
    } catch (err: any) {
      logger.warn('extract.pdf_parse_failed', { error: String(err?.message || err).slice(0, 120) });
      pageCount = countPdfPagesRaw(buffer);
    }
    return { text, pageCount, needsVision: text.length < RESUME_VALIDATION.SCANNED_PDF_TEXT_THRESHOLD };
  }

  if (isImage(mimeType, fileName)) {
    return { text: '', pageCount: null, needsVision: true };
  }

  if (mimeType.includes('wordprocessingml') || lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: (result.value || '').trim(), pageCount: null, needsVision: false };
  }

  if (mimeType.includes('msword') || lower.endsWith('.doc')) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      if ((result.value || '').trim().length > 0) return { text: result.value.trim(), pageCount: null, needsVision: false };
    } catch {
      /* legacy binary .doc, fall through */
    }
    return { text: extractLegacyDocText(buffer), pageCount: null, needsVision: false };
  }

  // .txt and anything else text-like
  return { text: buffer.toString('utf-8').replace(/^﻿/, '').trim(), pageCount: null, needsVision: false };
}
