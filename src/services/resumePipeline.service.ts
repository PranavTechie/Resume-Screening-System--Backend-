/**
 * The ONE pipeline that turns an uploaded file into a saved, analyzed resume.
 * Used by single upload (resume.service) and by the background worker (bulk upload).
 * Credits are NOT touched here: callers reserve before and refund on failure.
 */
import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { SCORING_VERSION } from '../config/constants';
import { geminiService } from './ai/gemini.service';
import { storageService } from './storage.service';
import { assertAiVerdict, assertPageCount, clipForPrompt, cleanDocumentType, precheckResumeText } from './resumeValidator.service';
import { extractTextLocally } from '../utils/textExtractor';
import { extractContactInfo, isValidEmail, normalizePhone } from '../utils/contactExtractor';
import { AppError, duplicateError } from '../utils/errors';
import { logger } from '../utils/logger';
import { ResumeAnalysisOutput } from '../types';

export type PipelineStage = 'extracting' | 'validating' | 'ai_analyzing' | 'persisting';

export interface PipelineInput {
  userId: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  fileHash?: string;
  /** Already stored (bulk upload streams files to storage first). */
  filePath?: string;
  /** Create an "ATS Audit" report row (single uploads only, avoids flooding Reports in bulk). */
  createReport?: boolean;
  /** Set by the worker when the per-item deadline passes; checked before any write. */
  isCancelled?: () => boolean;
  onStage?: (stage: PipelineStage) => void;
}

export interface PipelineOutput {
  resume: ResumeAnalysisOutput;
  resumeId: string;
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function findDuplicateByHash(userId: string, fileHash: string): Promise<{ id: string; candidateName: string } | null> {
  const { data } = await supabaseAdmin
    .from('resumes')
    .select('id, candidate_name')
    .eq('user_id', userId)
    .eq('file_hash', fileHash)
    .maybeSingle();
  return data ? { id: data.id, candidateName: data.candidate_name || 'an existing resume' } : null;
}

export async function findDuplicatesByHashes(userId: string, hashes: string[]): Promise<Map<string, { id: string; candidateName: string }>> {
  const map = new Map<string, { id: string; candidateName: string }>();
  const unique = Array.from(new Set(hashes.filter(Boolean)));
  for (let i = 0; i < unique.length; i += 100) {
    const { data } = await supabaseAdmin
      .from('resumes')
      .select('id, candidate_name, file_hash')
      .eq('user_id', userId)
      .in('file_hash', unique.slice(i, i + 100));
    for (const row of data || []) map.set(row.file_hash, { id: row.id, candidateName: row.candidate_name || 'an existing resume' });
  }
  return map;
}

function checkCancelled(input: PipelineInput) {
  if (input.isCancelled?.()) {
    throw new AppError('AI_ANALYSIS_TIMEOUT', 'Processing took too long and was stopped.', { status: 504, retryable: true });
  }
}

export async function analyzeAndPersistResume(input: PipelineInput): Promise<PipelineOutput> {
  const { userId, buffer, fileName, mimeType } = input;
  const fileHash = input.fileHash || sha256(buffer);

  // 0. Duplicate file (no AI call, no credit).
  const dup = await findDuplicateByHash(userId, fileHash);
  if (dup) {
    throw duplicateError(`Duplicate of ${dup.candidateName}`, { duplicateOf: dup.id, duplicateOfName: dup.candidateName });
  }

  // 1. Local extraction + Layer A (free).
  input.onStage?.('extracting');
  const local = await extractTextLocally(buffer, mimeType, fileName);
  let text = local.text;
  let documentType = 'resume';
  let viaVision = false;

  input.onStage?.('validating');
  if (local.needsVision) {
    assertPageCount(local.pageCount);
    checkCancelled(input);
    const vision = await geminiService.readDocumentWithVision(buffer, mimeType, fileName);
    assertAiVerdict(vision); // Layer B for images / scanned PDFs
    text = vision.text;
    documentType = cleanDocumentType(vision.documentType);
    viaVision = true;
    if (text.trim().length < 50) {
      throw new AppError('TEXT_EXTRACTION_FAILED', "We couldn't read this file clearly. Please upload a sharper scan or a text PDF.", {
        status: 422,
        outcome: 'rejected',
      });
    }
  }
  precheckResumeText({ text, pageCount: local.pageCount, viaVision });

  // 2. AI analysis + Layer B (same call).
  checkCancelled(input);
  input.onStage?.('ai_analyzing');
  const clipped = clipForPrompt(text);
  const ai = await geminiService.analyzeResume(clipped.text);
  assertAiVerdict(ai);
  documentType = cleanDocumentType(ai.documentType) || documentType;

  // 3. Contacts: deterministic regex first, AI value only when it validates.
  const regex = extractContactInfo(text);
  const email = regex.email || (ai.candidateEmail && isValidEmail(ai.candidateEmail) ? ai.candidateEmail.trim().toLowerCase() : null);
  const phone = regex.phone || (ai.candidatePhone ? normalizePhone(ai.candidatePhone) : null);

  // 4. Persist (compensating cleanup on failure).
  checkCancelled(input);
  input.onStage?.('persisting');
  let uploadedHere: string | null = null;
  let createdResumeId: string | null = null;
  try {
    let filePath = input.filePath;
    if (!filePath) {
      filePath = (await storageService.uploadResumeFile(userId, buffer, fileName, mimeType)).filePath;
      uploadedHere = filePath;
    }
    checkCancelled(input);

    const now = new Date().toISOString();
    const { data: row, error: insertErr } = await supabaseAdmin
      .from('resumes')
      .insert({
        user_id: userId,
        candidate_name: ai.candidateName,
        candidate_email: email,
        candidate_phone: phone,
        candidate_linkedin: ai.candidateLinkedIn,
        candidate_github: ai.candidateGitHub,
        candidate_website: ai.candidateWebsite,
        target_role: ai.targetRole,
        status: 'Ready',
        file_path: filePath,
        file_type: mimeType,
        file_name: fileName.slice(0, 200),
        file_size: buffer.length,
        file_hash: fileHash,
        content_truncated: clipped.truncated,
        document_type: documentType,
        raw_text: text,
        resume_score: ai.resumeScore,
        ats_compatibility: ai.atsCompatibility,
        skills_detected_count: ai.detectedSkills.length,
        ai_improvements_count: ai.missingSkills.length + ai.generalIssues.length,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (insertErr || !row) {
      if ((insertErr as any)?.code === '23505') {
        const again = await findDuplicateByHash(userId, fileHash);
        throw duplicateError(`Duplicate of ${again?.candidateName || 'an existing resume'}`, {
          duplicateOf: again?.id,
          duplicateOfName: again?.candidateName,
        });
      }
      throw new AppError('DATABASE_ERROR', 'Could not save the resume. Please try again.', { status: 503, retryable: true });
    }
    createdResumeId = row.id as string;

    const { error: analysisErr } = await supabaseAdmin.from('resume_analyses').insert({
      resume_id: createdResumeId,
      user_id: userId,
      overall_score: ai.resumeScore,
      ats_score: ai.atsCompatibility,
      ai_recommendation: ai.aiRecommendation,
      general_issues: ai.generalIssues,
      ats_breakdown_json: ai.atsBreakdown,
      scoring_version: SCORING_VERSION,
      ai_model: ai.modelUsed,
      created_at: now,
      updated_at: now,
    });
    if (analysisErr) {
      throw new AppError('DATABASE_ERROR', 'Could not save the analysis. Please try again.', { status: 503, retryable: true });
    }

    const skillRows = [
      ...ai.detectedSkills.map((s) => ({ resume_id: createdResumeId, user_id: userId, skill_name: s, category: 'frontend', is_missing: false })),
      ...ai.missingSkills.map((s) => ({ resume_id: createdResumeId, user_id: userId, skill_name: s, category: 'frontend', is_missing: true })),
    ];
    if (skillRows.length) {
      const { error: skillErr } = await supabaseAdmin.from('detected_skills').insert(skillRows);
      if (skillErr) throw new AppError('DATABASE_ERROR', 'Could not save detected skills. Please try again.', { status: 503, retryable: true });
    }

    const output: ResumeAnalysisOutput = {
      id: createdResumeId,
      candidateName: ai.candidateName,
      candidateEmail: email,
      candidatePhone: phone,
      candidateLinkedIn: ai.candidateLinkedIn,
      candidateGitHub: ai.candidateGitHub,
      candidateWebsite: ai.candidateWebsite,
      targetRole: ai.targetRole,
      status: 'Ready',
      resumeScore: ai.resumeScore,
      atsCompatibility: ai.atsCompatibility,
      skillsDetectedCount: ai.detectedSkills.length,
      aiImprovementsCount: ai.missingSkills.length + ai.generalIssues.length,
      detectedSkills: ai.detectedSkills,
      missingSkills: ai.missingSkills,
      generalIssues: ai.generalIssues,
      aiRecommendation: ai.aiRecommendation,
      atsBreakdown: ai.atsBreakdown,
      truncated: clipped.truncated,
      documentType,
      scoringVersion: SCORING_VERSION,
      aiModel: ai.modelUsed,
    };

    if (input.createReport) {
      const { error: reportErr } = await supabaseAdmin.from('analysis_reports').insert({
        user_id: userId,
        title: `${ai.targetRole} ATS & Resume Audit`,
        report_type: 'ATS Audit',
        candidate_name: ai.candidateName,
        score: ai.resumeScore,
        ats_pass_rate: ai.atsCompatibility,
        summary: ai.aiRecommendation,
        data_json: output,
        created_at: now,
        updated_at: now,
      });
      if (reportErr) logger.warn('pipeline.report_insert_failed', { error: reportErr.message });
    }

    logger.info('pipeline.resume_saved', { resumeId: createdResumeId, truncated: clipped.truncated, viaVision, model: ai.modelUsed });
    return { resume: output, resumeId: createdResumeId };
  } catch (err) {
    if (createdResumeId) {
      await supabaseAdmin.from('resumes').delete().eq('id', createdResumeId).eq('user_id', userId);
    }
    if (uploadedHere) await storageService.deleteResumeFile(uploadedHere);
    throw err;
  }
}
