import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { geminiService } from './ai/gemini.service';
import { creditService } from './credit.service';
import {
  blendMatchScore,
  computeExperienceFit,
  computeSkillCoverage,
  displaySkill,
  JobRequirements,
  normalizeSkillList,
} from './scoring.service';
import { clipForPrompt } from './resumeValidator.service';
import { logger } from '../utils/logger';
import { AppError } from '../utils/errors';
import { toCsv } from '../utils/csv';
import { JobItem, JobMatchResult } from '../types';
import {
  CANDIDATE_STATUSES,
  CandidateStatus,
  CREDIT_COST,
  JOB_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_MIN_LENGTH,
  JOB_DESCRIPTION_VALIDATION_MESSAGES,
  MATCH_SCORE_WEIGHTS,
  SCORING_VERSION,
} from '../config/constants';

export function assertJobDescription(description: unknown): asserts description is string {
  if (!description || typeof description !== 'string' || !description.trim()) {
    throw new AppError('JOB_DESCRIPTION_REQUIRED', JOB_DESCRIPTION_VALIDATION_MESSAGES.REQUIRED, { status: 400 });
  }
  if (description.length < JOB_DESCRIPTION_MIN_LENGTH) {
    throw new AppError('JOB_DESCRIPTION_TOO_SHORT', JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_SHORT, { status: 400 });
  }
  if (description.length > JOB_DESCRIPTION_MAX_LENGTH) {
    throw new AppError('JOB_DESCRIPTION_TOO_LONG', JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_LONG, { status: 400 });
  }
}

export function mapMatchRow(m: any, jobTitle: string): JobMatchResult {
  const strong = m.strong_matches_json || [];
  const gaps = m.skill_gaps_json || [];
  return {
    resumeId: m.resume_id,
    candidateName: m.candidate_name || 'Candidate',
    candidateEmail: m.candidate_email || undefined,
    candidatePhone: m.candidate_phone || undefined,
    targetRole: jobTitle,
    matchPercentage: m.match_percentage,
    atsMatchPercentage: m.ats_match_percentage ?? m.match_percentage,
    skillsMatchedCount: m.skills_matched_count ?? strong.length,
    experienceMatchPercentage: m.experience_match_percentage ?? undefined,
    skillCoveragePercentage: m.skill_coverage_percentage ?? null,
    aiJudgmentPercentage: m.ai_judgment_percentage ?? null,
    matchSummary: m.match_summary || '',
    matchReason: m.match_reason || null,
    strongMatches: strong,
    skillGaps: gaps,
    candidateStatus: m.candidate_status || 'new',
    scoringVersion: m.scoring_version || null,
    aiModel: m.ai_model || null,
    scoreBreakdown: m.score_breakdown_json || null,
  };
}

function mapJobRow(r: any): JobItem {
  const matches: Record<string, JobMatchResult> = {};
  for (const m of r.job_matches || []) matches[m.resume_id] = mapMatchRow(m, r.title);
  return {
    id: r.id,
    title: r.title,
    company: r.company,
    description: r.description,
    createdAt: r.created_at,
    lastUpdated: r.updated_at,
    status: r.status,
    attachedResumeIds: Array.isArray(r.attached_resume_ids) ? r.attached_resume_ids : [],
    matches,
    isRanked: r.is_ranked,
  };
}

const descHash = (title: string, description: string) => crypto.createHash('sha256').update(`${title}\n${description}`).digest('hex');

export const jobService = {
  async createJob(userId: string, data: { title: string; company?: string; description: string; location?: string }): Promise<JobItem> {
    assertJobDescription(data.description);
    const now = new Date().toISOString();
    const { data: row, error } = await supabaseAdmin
      .from('jobs')
      .insert({
        user_id: userId,
        title: data.title.trim().slice(0, 200),
        company: (data.company || 'Company Confidential').slice(0, 200),
        location: (data.location || 'Remote / Flexible').slice(0, 200),
        description: data.description,
        status: 'Active',
        is_ranked: false,
        attached_resume_ids: [],
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single();
    if (error || !row) throw new AppError('DATABASE_ERROR', 'Could not create the job. Please try again.', { status: 503 });
    return mapJobRow(row);
  },

  async listJobs(userId: string): Promise<JobItem[]> {
    const { data, error } = await supabaseAdmin
      .from('jobs')
      .select('*, job_matches(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new AppError('DATABASE_ERROR', 'Could not load jobs.', { status: 503 });
    return (data || []).map(mapJobRow);
  },

  async getJobRow(userId: string, jobId: string): Promise<any | null> {
    const { data } = await supabaseAdmin.from('jobs').select('*').eq('id', jobId).eq('user_id', userId).maybeSingle();
    return data || null;
  },

  async getJobById(userId: string, jobId: string): Promise<JobItem | null> {
    const { data } = await supabaseAdmin.from('jobs').select('*, job_matches(*)').eq('id', jobId).eq('user_id', userId).maybeSingle();
    return data ? mapJobRow(data) : null;
  },

  async deleteJob(userId: string, jobId: string): Promise<boolean> {
    const { error } = await supabaseAdmin.from('jobs').delete().eq('id', jobId).eq('user_id', userId);
    return !error;
  },

  async attachResumes(userId: string, jobId: string, resumeIds: string[]): Promise<JobItem | null> {
    const job = await this.getJobRow(userId, jobId);
    if (!job) return null;
    // Only the user's own, existing resumes can be attached.
    const { data: own } = await supabaseAdmin.from('resumes').select('id').eq('user_id', userId).in('id', resumeIds.slice(0, 500));
    const ownIds = (own || []).map((r) => r.id);
    const merged = Array.from(new Set([...(job.attached_resume_ids || []), ...ownIds]));
    await supabaseAdmin.from('jobs').update({ attached_resume_ids: merged, updated_at: new Date().toISOString() }).eq('id', jobId).eq('user_id', userId);
    return this.getJobById(userId, jobId);
  },

  async detachResumes(userId: string, jobId: string, resumeIds: string[]): Promise<JobItem | null> {
    const job = await this.getJobRow(userId, jobId);
    if (!job) return null;
    const remove = new Set(resumeIds);
    const updated = (job.attached_resume_ids || []).filter((id: string) => !remove.has(id));
    await supabaseAdmin.from('jobs').update({ attached_resume_ids: updated, updated_at: new Date().toISOString() }).eq('id', jobId).eq('user_id', userId);
    await supabaseAdmin.from('job_matches').delete().eq('job_id', jobId).eq('user_id', userId).in('resume_id', resumeIds);
    return this.getJobById(userId, jobId);
  },

  async detachResume(userId: string, jobId: string, resumeId: string): Promise<JobItem | null> {
    return this.detachResumes(userId, jobId, [resumeId]);
  },

  /** Deterministic JD requirements, extracted once per (title, description) and cached on the job. */
  async ensureRequirements(userId: string, job: any): Promise<JobRequirements> {
    const hash = descHash(job.title, job.description);
    if (job.requirements_hash === hash && job.requirements_json) {
      const r = job.requirements_json;
      return { requiredSkills: r.requiredSkills || [], niceToHaveSkills: r.niceToHaveSkills || [], minYearsExperience: r.minYearsExperience ?? null };
    }
    const extracted = await geminiService.extractJobRequirements(job.title, job.description);
    const requirements: JobRequirements = {
      requiredSkills: normalizeSkillList(extracted.requiredSkills),
      niceToHaveSkills: normalizeSkillList(extracted.niceToHaveSkills),
      minYearsExperience: extracted.minYearsExperience,
    };
    await supabaseAdmin
      .from('jobs')
      .update({ requirements_json: { ...requirements, model: extracted.modelUsed, scoringVersion: SCORING_VERSION }, requirements_hash: hash })
      .eq('id', job.id)
      .eq('user_id', userId);
    return requirements;
  },

  /** Rank ONE resume against a job (called by the queue worker). Throws on failure. */
  async rankOneResume(userId: string, jobId: string, resumeId: string, isCancelled?: () => boolean): Promise<JobMatchResult> {
    const job = await this.getJobRow(userId, jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', 'This job was deleted.', { status: 404 });
    assertJobDescription(job.description);

    const { data: resume } = await supabaseAdmin
      .from('resumes')
      .select('id, candidate_name, candidate_email, candidate_phone, target_role, raw_text, ats_compatibility, detected_skills(skill_name, is_missing)')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!resume) throw new AppError('RESUME_NOT_FOUND', 'This resume was deleted.', { status: 404 });

    const requirements = await this.ensureRequirements(userId, job);
    const resumeSkills: string[] = ((resume as any).detected_skills || []).filter((s: any) => !s.is_missing).map((s: any) => s.skill_name);
    const rawText: string = resume.raw_text || '';

    const coverage = computeSkillCoverage(requirements, resumeSkills, rawText);
    const judgment = await geminiService.judgeMatch({
      jobTitle: job.title,
      jobDescription: job.description,
      requiredSkills: requirements.requiredSkills.map(displaySkill),
      resumeText: clipForPrompt(rawText || resumeSkills.join(', ')).text,
      resumeSkills,
    });
    if (isCancelled?.()) throw new AppError('AI_ANALYSIS_TIMEOUT', 'Processing took too long and was stopped.', { status: 504, retryable: true });

    const experienceFit = computeExperienceFit(requirements.minYearsExperience, judgment.candidateYearsExperience, judgment.experienceFit);
    const blend = blendMatchScore({ skillCoverage: coverage.coverage, experienceFit, aiJudgment: judgment.aiJudgment });

    const matched = [...coverage.matchedRequired, ...coverage.matchedNiceToHave].map(displaySkill);
    const missing = coverage.missingRequired.map(displaySkill);
    const totalRequired = coverage.matchedRequired.length + coverage.missingRequired.length;
    const reason =
      judgment.reason ||
      (totalRequired > 0
        ? `Has ${coverage.matchedRequired.length} of ${totalRequired} must-have skills.`
        : 'Scored on overall fit; the job lists no specific skills.');

    const breakdown = {
      skillCoverage: coverage.coverage,
      experienceFit,
      aiJudgment: judgment.aiJudgment,
      weights: blend.weights,
      defaultWeights: MATCH_SCORE_WEIGHTS,
      candidateYearsExperience: judgment.candidateYearsExperience,
      minYearsExperience: requirements.minYearsExperience,
      matchedRequired: coverage.matchedRequired.map(displaySkill),
      missingRequired: coverage.missingRequired.map(displaySkill),
      matchedNiceToHave: coverage.matchedNiceToHave.map(displaySkill),
      missingNiceToHave: coverage.missingNiceToHave.map(displaySkill),
      strengths: judgment.strengths,
      concerns: judgment.concerns,
    };
    const summary = [reason, judgment.strengths.length ? `Strengths: ${judgment.strengths.join('; ')}.` : '', judgment.concerns.length ? `Gaps: ${judgment.concerns.join('; ')}.` : '']
      .filter(Boolean)
      .join(' ');

    const { error } = await supabaseAdmin.from('job_matches').upsert(
      {
        job_id: jobId,
        resume_id: resumeId,
        user_id: userId,
        candidate_name: resume.candidate_name,
        candidate_email: resume.candidate_email || null,
        candidate_phone: resume.candidate_phone || null,
        match_percentage: blend.score,
        ats_match_percentage: resume.ats_compatibility ?? null,
        skills_matched_count: coverage.matchedRequired.length + coverage.matchedNiceToHave.length,
        experience_match_percentage: experienceFit,
        skill_coverage_percentage: coverage.coverage,
        ai_judgment_percentage: judgment.aiJudgment,
        match_summary: summary,
        match_reason: reason.slice(0, 240),
        strong_matches_json: matched,
        skill_gaps_json: missing,
        score_breakdown_json: breakdown,
        scoring_version: SCORING_VERSION,
        ai_model: judgment.modelUsed,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_id,resume_id' }
    );
    if (error) throw new AppError('DATABASE_ERROR', 'Could not save the ranking result.', { status: 503, retryable: true });

    return {
      resumeId,
      candidateName: resume.candidate_name,
      targetRole: job.title,
      matchPercentage: blend.score,
      matchSummary: summary,
      matchReason: reason,
      strongMatches: matched,
      skillGaps: missing,
      scoringVersion: SCORING_VERSION,
      aiModel: judgment.modelUsed,
      scoreBreakdown: breakdown,
    };
  },

  async markRanked(userId: string, jobId: string): Promise<void> {
    await supabaseAdmin.from('jobs').update({ status: 'Screened', is_ranked: true, updated_at: new Date().toISOString() }).eq('id', jobId).eq('user_id', userId);
  },

  async updateCandidateStatus(userId: string, jobId: string, resumeIds: string[], status: string): Promise<{ updated: number }> {
    if (!(CANDIDATE_STATUSES as readonly string[]).includes(status)) {
      throw new AppError('INVALID_STATUS', 'Unknown candidate status.', { status: 400 });
    }
    const { data, error } = await supabaseAdmin
      .from('job_matches')
      .update({ candidate_status: status as CandidateStatus, updated_at: new Date().toISOString() })
      .eq('job_id', jobId)
      .eq('user_id', userId)
      .in('resume_id', resumeIds.slice(0, 1000))
      .select('id');
    if (error) throw new AppError('DATABASE_ERROR', 'Could not update candidate status.', { status: 503 });
    return { updated: (data || []).length };
  },

  async exportRankingCsv(userId: string, jobId: string, blind: boolean): Promise<{ filename: string; csv: string }> {
    const job = await this.getJobById(userId, jobId);
    if (!job) throw new AppError('NOT_FOUND', 'Job not found.', { status: 404 });
    const rows = Object.values(job.matches || {}).sort((a, b) => b.matchPercentage - a.matchPercentage);
    const headers = ['Rank', 'Name', 'Email', 'Phone', 'Match %', 'ATS %', 'Matched skills', 'Missing skills', 'Status', 'Reason', 'Scoring version'];
    const data = rows.map((m, i) => [
      i + 1,
      blind ? `Candidate ${i + 1}` : m.candidateName,
      blind ? '' : m.candidateEmail || '',
      blind ? '' : m.candidatePhone || '',
      m.matchPercentage,
      m.atsMatchPercentage ?? '',
      m.strongMatches,
      m.skillGaps,
      (m.candidateStatus || 'new').replace('_', ' '),
      m.matchReason || '',
      m.scoringVersion || '',
    ]);
    const safeTitle = job.title.replace(/[^a-zA-Z0-9-]+/g, '_').slice(0, 50) || 'job';
    return { filename: `ranking_${safeTitle}.csv`, csv: toCsv(headers, data) };
  },

  /** 1 credit, reserved first and refunded if generation fails. */
  async generateJobDescription(userId: string, title: string, company?: string, keywords?: string): Promise<{ description: string; creditsRemaining: number }> {
    const reservationId = crypto.randomUUID();
    const balance = await creditService.reserveCredits(userId, CREDIT_COST.JOB_DESCRIPTION, reservationId, `AI job description: ${title.slice(0, 80)}`);
    try {
      const description = await geminiService.generateJobDescription(title, company, keywords);
      return { description: description.slice(0, JOB_DESCRIPTION_MAX_LENGTH), creditsRemaining: balance };
    } catch (err) {
      await creditService.refundCredit(userId, reservationId, 'Refund: job description generation failed').catch((e) => {
        logger.error('jd.refund_failed', { reservationId, error: String(e?.message || e) });
      });
      throw err;
    }
  },
};
