import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { CREDIT_COST, MAX_RESUME_FILE_SIZE } from '../config/constants';
import { creditService } from './credit.service';
import { rejectionService } from './rejection.service';
import { storageService } from './storage.service';
import { analyzeAndPersistResume, findDuplicateByHash, sha256 } from './resumePipeline.service';
import { AppError, duplicateError, toAppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { ResumeAnalysisOutput } from '../types';

export function mapResumeRow(row: any): ResumeAnalysisOutput {
  const analysis = row.resume_analyses?.[0] || {};
  const allSkills = row.detected_skills || [];
  const detectedSkills = allSkills.filter((s: any) => !s.is_missing).map((s: any) => s.skill_name);
  const missingSkills = allSkills.filter((s: any) => s.is_missing).map((s: any) => s.skill_name);
  return {
    id: row.id,
    candidateName: row.candidate_name,
    candidateEmail: row.candidate_email || undefined,
    candidatePhone: row.candidate_phone || undefined,
    candidateLinkedIn: row.candidate_linkedin || undefined,
    candidateGitHub: row.candidate_github || undefined,
    candidateWebsite: row.candidate_website || undefined,
    targetRole: row.target_role,
    status: row.status,
    resumeScore: row.resume_score,
    atsCompatibility: row.ats_compatibility,
    skillsDetectedCount: row.skills_detected_count || detectedSkills.length,
    aiImprovementsCount: row.ai_improvements_count,
    detectedSkills,
    missingSkills,
    generalIssues: analysis.general_issues || [],
    aiRecommendation: analysis.ai_recommendation || '',
    atsBreakdown: analysis.ats_breakdown_json || { keywordMatch: 0, formatting: 0, experienceRelevance: 0 },
    truncated: Boolean(row.content_truncated),
    documentType: row.document_type || null,
    scoringVersion: analysis.scoring_version || null,
    aiModel: analysis.ai_model || null,
    createdAt: row.created_at,
  };
}

export const resumeService = {
  /**
   * Single-file upload: same validator + pipeline as bulk, same reserve -> refund-on-failure path.
   */
  async processSingleUpload(
    userId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number }
  ): Promise<{ resume: ResumeAnalysisOutput; creditsRemaining: number }> {
    if (file.size > MAX_RESUME_FILE_SIZE) {
      throw new AppError('FILE_TOO_LARGE', 'File size exceeds the 5MB limit.', { status: 413 });
    }
    await rejectionService.assertUnderCap(userId);

    const fileHash = sha256(file.buffer);
    const dup = await findDuplicateByHash(userId, fileHash);
    if (dup) {
      throw duplicateError(`This file is already in your library (duplicate of ${dup.candidateName}). No credit was used.`, {
        duplicateOf: dup.id,
        duplicateOfName: dup.candidateName,
      });
    }

    const reservationId = crypto.randomUUID();
    let balance = await creditService.reserveCredits(userId, CREDIT_COST.RESUME_ANALYSIS, reservationId, 'Resume analysis');

    try {
      const out = await analyzeAndPersistResume({
        userId,
        buffer: file.buffer,
        fileName: file.originalname,
        mimeType: file.mimetype,
        fileHash,
        createReport: true,
      });
      return { resume: out.resume, creditsRemaining: balance };
    } catch (raw) {
      const err = toAppError(raw);
      const refund = await creditService.refundCredit(userId, reservationId, `Refund: resume ${err.outcome} (${err.code})`).catch((e) => {
        logger.error('single_upload.refund_failed', { reservationId, error: String(e?.message || e) });
        return { refunded: false, newBalance: null };
      });
      if (refund.newBalance !== null) balance = refund.newBalance;
      if (err.outcome === 'rejected') await rejectionService.record(userId, err.code);
      (err as any).creditsRemaining = balance;
      throw err;
    }
  },

  async listResumes(userId: string): Promise<ResumeAnalysisOutput[]> {
    const { data, error } = await supabaseAdmin
      .from('resumes')
      .select('*, resume_analyses(*), detected_skills(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new AppError('DATABASE_ERROR', 'Could not load resumes.', { status: 503 });
    return (data || []).map(mapResumeRow);
  },

  async getResumeById(userId: string, resumeId: string): Promise<ResumeAnalysisOutput | null> {
    const { data: row, error } = await supabaseAdmin
      .from('resumes')
      .select('*, resume_analyses(*), detected_skills(*)')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !row) return null;
    return mapResumeRow(row);
  },

  /** Delete the user's OWN resumes (rows + storage files) and detach them from jobs. */
  async deleteResumes(userId: string, resumeIds: string[]): Promise<{ deleted: number }> {
    const ids = Array.from(new Set(resumeIds.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))));
    if (ids.length === 0) return { deleted: 0 };

    let deleted = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const { data: rows, error } = await supabaseAdmin.from('resumes').select('id, file_path').eq('user_id', userId).in('id', chunk);
      if (error) throw new AppError('DATABASE_ERROR', 'Could not delete resumes.', { status: 503 });
      const ownIds = (rows || []).map((r) => r.id);
      if (ownIds.length === 0) continue;

      const { error: delErr } = await supabaseAdmin.from('resumes').delete().eq('user_id', userId).in('id', ownIds);
      if (delErr) throw new AppError('DATABASE_ERROR', 'Could not delete resumes.', { status: 503 });
      deleted += ownIds.length;

      const paths = (rows || []).map((r) => r.file_path).filter((p: string) => typeof p === 'string' && p.startsWith(`${userId}/`));
      await storageService.deleteResumeFiles(paths);
    }

    // Remove deleted ids from jobs.attached_resume_ids (job_matches cascade on delete).
    const { data: jobs } = await supabaseAdmin.from('jobs').select('id, attached_resume_ids').eq('user_id', userId);
    const removed = new Set(ids);
    for (const job of jobs || []) {
      const attached: string[] = Array.isArray(job.attached_resume_ids) ? job.attached_resume_ids : [];
      const next = attached.filter((id) => !removed.has(id));
      if (next.length !== attached.length) {
        await supabaseAdmin.from('jobs').update({ attached_resume_ids: next, updated_at: new Date().toISOString() }).eq('id', job.id).eq('user_id', userId);
      }
    }
    logger.info('resumes.deleted', { count: deleted });
    return { deleted };
  },

  async deleteAllResumes(userId: string): Promise<{ deleted: number }> {
    const { data, error } = await supabaseAdmin.from('resumes').select('id').eq('user_id', userId);
    if (error) throw new AppError('DATABASE_ERROR', 'Could not delete resumes.', { status: 503 });
    return this.deleteResumes(userId, (data || []).map((r) => r.id));
  },

  /** Everything we store about the user, as JSON (no storage file bytes). */
  async exportUserData(userId: string): Promise<Record<string, unknown>> {
    const pick = async (table: string, column = 'user_id') => {
      const { data } = await supabaseAdmin.from(table).select('*').eq(column, userId);
      return data || [];
    };
    const [profile, preferences, subscription, resumes, analyses, skills, jobs, matches, reports, transactions, batches] = await Promise.all([
      pick('profiles', 'id'),
      pick('user_preferences'),
      pick('subscriptions'),
      pick('resumes'),
      pick('resume_analyses'),
      pick('detected_skills'),
      pick('jobs'),
      pick('job_matches'),
      pick('analysis_reports'),
      pick('credit_transactions'),
      pick('upload_batches'),
    ]);
    return {
      exportedAt: new Date().toISOString(),
      profile: profile[0] || null,
      preferences: preferences[0] || null,
      subscription: subscription[0] || null,
      resumes,
      resumeAnalyses: analyses,
      detectedSkills: skills,
      jobs,
      jobMatches: matches,
      reports,
      creditTransactions: transactions,
      uploadBatches: batches,
    };
  },
};
