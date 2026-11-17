import { describe, expect, it } from 'vitest';
import {
  assertAiVerdict,
  assertPageCount,
  clipForPrompt,
  countResumeSignals,
  precheckResumeText,
} from '../src/services/resumeValidator.service';
import { RESUME_VALIDATION } from '../src/config/constants';
import { AppError } from '../src/utils/errors';

const RESUME = `Aarav Fake
aarav.fake@example.org | +91 98765 43210 | linkedin.com/in/aarav-fake

PROFESSIONAL SUMMARY
Frontend developer with 3 years of experience building React applications.

WORK EXPERIENCE
Software Engineer, Acme Pvt Ltd            Jun 2021 – Present
- Built a design system in React and TypeScript used by 6 teams.
- Cut page load time by 40% by code-splitting.

EDUCATION
B.Tech Computer Science, Sample Institute of Technology   2017 - 2021

SKILLS
React, TypeScript, Node.js, SQL, Git

PROJECTS
Expense tracker (React, Firebase)`.padEnd(600, ' ');

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : 'NON_APP_ERROR';
  }
}

describe('resume signals', () => {
  it('finds contact, sections and date ranges in a real-looking resume', () => {
    const s = countResumeSignals(RESUME);
    expect(s.sectionHeadings).toEqual(expect.arrayContaining(['experience', 'education', 'skills', 'projects']));
    expect(s.dateRanges).toBeGreaterThanOrEqual(2);
    expect(s.total).toBeGreaterThanOrEqual(5);
  });

  it('detects Hindi section headings', () => {
    expect(countResumeSignals('नाम: टेस्ट\nशिक्षा: बी.कॉम\nअनुभव: 2 साल').sectionHeadings).toContain('hindi');
  });

  it('detects "2019 to 2022" and "03/2020 - present" date ranges', () => {
    expect(countResumeSignals('Worked there 2019 to 2022').dateRanges).toBe(1);
    expect(countResumeSignals('Analyst 03/2020 - present').dateRanges).toBeGreaterThanOrEqual(1);
  });

  it('finds zero signals in an invoice-like text', () => {
    const invoice = 'TAX INVOICE No 4411. Item: Printer cartridge x2. Amount due 1,250.00 INR. Thank you for shopping.'.repeat(5);
    expect(countResumeSignals(invoice).total).toBe(0);
  });
});

describe('Layer A precheck', () => {
  it('accepts a normal resume', () => {
    const r = precheckResumeText({ text: RESUME, pageCount: 2 });
    expect(r.willTruncate).toBe(false);
  });

  it('rejects PDFs with more than 5 pages', () => {
    expect(codeOf(() => precheckResumeText({ text: RESUME, pageCount: 6 }))).toBe('TOO_MANY_PAGES');
    expect(codeOf(() => assertPageCount(RESUME_VALIDATION.MAX_PDF_PAGES))).toBeNull();
  });

  it('rejects text under 300 chars, but not for vision-read files', () => {
    expect(codeOf(() => precheckResumeText({ text: 'Experience: some. Skills: React. 2019-2021' }))).toBe('TOO_LITTLE_TEXT');
    expect(codeOf(() => precheckResumeText({ text: 'Experience: some. Skills: React. 2019-2021', viaVision: true }))).toBeNull();
  });

  it('rejects text over 25,000 chars as not a resume', () => {
    expect(codeOf(() => precheckResumeText({ text: RESUME + 'x'.repeat(RESUME_VALIDATION.MAX_TEXT_CHARS) }))).toBe('TOO_LONG_NOT_A_RESUME');
  });

  it('rejects zero-signal documents and lets borderline ones through to Layer B', () => {
    const invoice = 'TAX INVOICE No 4411. Item: Printer cartridge x2. Amount due 1,250.00 INR. Thank you for shopping. '.repeat(5);
    expect(codeOf(() => precheckResumeText({ text: invoice }))).toBe('NOT_A_RESUME');
    // A designer CV with almost no structure: one signal (email) is enough to go to the AI check.
    const designer = `MAYA FAKE — visual designer — maya.fake@example.org\n${'Brand identities, posters, motion pieces. '.repeat(10)}`;
    expect(codeOf(() => precheckResumeText({ text: designer }))).toBeNull();
  });

  it('flags long-but-valid resumes for truncation instead of cutting silently', () => {
    const long = RESUME + ' Built things.'.repeat(1700);
    expect(long.length).toBeGreaterThan(RESUME_VALIDATION.PROMPT_CHAR_LIMIT);
    expect(long.length).toBeLessThan(RESUME_VALIDATION.MAX_TEXT_CHARS);
    expect(precheckResumeText({ text: long }).willTruncate).toBe(true);
    const clipped = clipForPrompt(long);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text.length).toBe(RESUME_VALIDATION.PROMPT_CHAR_LIMIT);
    expect(clipForPrompt('short').truncated).toBe(false);
  });
});

describe('Layer B AI verdict', () => {
  it('rejects when the model says it is not a resume and reports the detected type', () => {
    try {
      assertAiVerdict({ isResume: false, documentType: 'Research Paper', confidence: 0.97 });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as AppError).code).toBe('NOT_A_RESUME');
      expect((e as AppError).message).toContain('research paper');
      expect((e as AppError).outcome).toBe('rejected');
    }
  });

  it('rejects low confidence (< 0.6) even if flagged as resume', () => {
    expect(codeOf(() => assertAiVerdict({ isResume: true, documentType: 'resume', confidence: 0.4 }))).toBe('NOT_A_RESUME');
  });

  it('accepts confident resumes', () => {
    expect(codeOf(() => assertAiVerdict({ isResume: true, documentType: 'resume', confidence: 0.6 }))).toBeNull();
  });
});
