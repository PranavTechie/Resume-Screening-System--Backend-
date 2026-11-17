/**
 * Shared resume validator used by BOTH single upload and bulk upload.
 *
 * Layer A (free, before any Gemini call / credit): page count, text length, resume-signal score.
 * Layer B (no extra call): verdict from the `is_resume / document_type / confidence` fields the
 *          analysis (or vision extraction) already returns.
 * Layer C (abuse cap) lives in rejection.service.ts.
 *
 * Everything here is pure so it can be unit-tested without Supabase or Gemini.
 */
import { RESUME_VALIDATION } from '../config/constants';
import { extractContactInfo } from '../utils/contactExtractor';
import { AppError, rejectError } from '../utils/errors';

export interface ResumeSignals {
  hasContact: boolean;
  sectionHeadings: string[];
  dateRanges: number;
  total: number;
}

// Section headings (English + common Indian / Hindi variants). Matched as whole words, any case.
const SECTION_PATTERNS: Array<[string, RegExp]> = [
  ['experience', /\b(work|professional|employment|relevant)?\s*experience\b/i],
  ['work history', /\b(work|employment|career)\s+history\b/i],
  ['education', /\b(education|academics?|academic\s+(details|background|qualifications?)|educational\s+qualifications?|qualifications?)\b/i],
  ['skills', /\b(technical\s+|key\s+|core\s+)?skills?\b|\bskill\s*set\b|\bcompetenc(y|ies)\b/i],
  ['projects', /\b(academic\s+|personal\s+|key\s+)?projects?\b/i],
  ['internship', /\binternships?\b|\bindustrial\s+training\b|\barticleship\b/i],
  ['certifications', /\bcertifications?\b|\bcertificates?\b|\blicen[cs]es?\b/i],
  ['summary', /\b(career\s+objective|objective|professional\s+summary|profile\s+summary|summary)\b/i],
  ['achievements', /\b(achievements?|accomplishments?|awards?|extra[-\s]?curricular)\b/i],
  ['personal details', /\b(personal\s+(details|information|profile)|declaration)\b/i],
  // Hindi (Devanagari) variants
  ['hindi', /(अनुभव|शिक्षा|कौशल|परियोजना|प्रमाणपत्र|व्यक्तिगत\s+विवरण)/],
];

const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const YEAR = '(19[7-9]\\d|20[0-4]\\d)';
const DATE_RANGE_RE = new RegExp(
  `(?:${MONTH}\\s*,?\\s*)?${YEAR}\\s*(?:-|–|—|to|till|until)\\s*(?:(?:${MONTH}\\s*,?\\s*)?${YEAR}|present|current|now|date|ongoing)`,
  'gi'
);
const NUMERIC_DATE_RANGE_RE = /\b(0?[1-9]|1[0-2])\s*[/.-]\s*(19|20)\d{2}\s*(?:-|–|—|to)\s*(?:(0?[1-9]|1[0-2])\s*[/.-]\s*(19|20)\d{2}|present|current)/gi;

export function countResumeSignals(text: string): ResumeSignals {
  const sample = (text || '').slice(0, 30000);
  const contact = extractContactInfo(sample);
  const hasContact = Boolean(contact.email || contact.phone);

  const sectionHeadings = SECTION_PATTERNS.filter(([, re]) => re.test(sample)).map(([name]) => name);

  const dateRanges = (sample.match(DATE_RANGE_RE) || []).length + (sample.match(NUMERIC_DATE_RANGE_RE) || []).length;

  const total = (hasContact ? 1 : 0) + sectionHeadings.length + (dateRanges > 0 ? 1 : 0);
  return { hasContact, sectionHeadings, dateRanges, total };
}

export interface PrecheckInput {
  text: string;
  /** PDF page count when known. */
  pageCount?: number | null;
  /** True when the text came from Gemini vision (images / scanned PDFs). */
  viaVision?: boolean;
}

export interface PrecheckResult {
  signals: ResumeSignals;
  /** Text is longer than the model prompt limit and will be truncated (flagged, never silent). */
  willTruncate: boolean;
}

/** Page count check, usable before text extraction. */
export function assertPageCount(pageCount: number | null | undefined): void {
  if (typeof pageCount === 'number' && pageCount > RESUME_VALIDATION.MAX_PDF_PAGES) {
    throw rejectError(
      'TOO_MANY_PAGES',
      `This PDF has ${pageCount} pages. Resumes are usually 1-${RESUME_VALIDATION.MAX_PDF_PAGES} pages, so this file was not analyzed.`,
      { pageCount, maxPages: RESUME_VALIDATION.MAX_PDF_PAGES }
    );
  }
}

/** Layer A. Throws a 'rejected' AppError, or returns the signal breakdown. */
export function precheckResumeText(input: PrecheckInput): PrecheckResult {
  assertPageCount(input.pageCount);

  const text = (input.text || '').trim();

  if (!input.viaVision && text.length < RESUME_VALIDATION.MIN_TEXT_CHARS) {
    throw rejectError(
      'TOO_LITTLE_TEXT',
      "We couldn't find enough text in this file to analyze it. Please upload a text-based resume.",
      { chars: text.length, minChars: RESUME_VALIDATION.MIN_TEXT_CHARS }
    );
  }

  if (text.length > RESUME_VALIDATION.MAX_TEXT_CHARS) {
    throw rejectError(
      'TOO_LONG_NOT_A_RESUME',
      'This document is much longer than a resume, so it was not analyzed.',
      { chars: text.length, maxChars: RESUME_VALIDATION.MAX_TEXT_CHARS }
    );
  }

  const signals = countResumeSignals(text);
  // Vision text was already classified by the model; only block text files with zero signals.
  if (!input.viaVision && signals.total === 0) {
    throw rejectError('NOT_A_RESUME', "This doesn't look like a resume (no contact details, sections or dates found). Please upload a CV.", {
      documentType: 'unknown',
    });
  }

  return { signals, willTruncate: text.length > RESUME_VALIDATION.PROMPT_CHAR_LIMIT };
}

export interface AiVerdict {
  isResume?: boolean | null;
  documentType?: string | null;
  confidence?: number | null;
}

/** Layer B. Throws NOT_A_RESUME when the model says it is not a resume or is unsure. */
export function assertAiVerdict(verdict: AiVerdict): void {
  const confidence = typeof verdict.confidence === 'number' && Number.isFinite(verdict.confidence) ? verdict.confidence : 0;
  const docType = cleanDocumentType(verdict.documentType);
  if (verdict.isResume === false || confidence < RESUME_VALIDATION.MIN_AI_CONFIDENCE) {
    const detected = verdict.isResume === false ? docType : docType === 'resume' ? 'unclear document' : docType;
    throw rejectError('NOT_A_RESUME', `This doesn't look like a resume (detected: ${detected}). Please upload a CV.`, {
      documentType: detected,
      confidence,
    });
  }
}

export function cleanDocumentType(raw: string | null | undefined): string {
  const t = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9 /&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return t || 'unknown document';
}

/** Truncate text for the prompt and report whether anything was cut. */
export function clipForPrompt(text: string, limit: number = RESUME_VALIDATION.PROMPT_CHAR_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

export function isRejection(err: unknown): err is AppError {
  return err instanceof AppError && err.outcome === 'rejected';
}
