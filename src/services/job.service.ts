import { supabaseAdmin } from '../config/supabase';
import { geminiService } from './ai/gemini.service';
import { creditService } from './credit.service';
import { logger } from '../utils/logger';
import { JobItem, JobMatchResult } from '../types';
import {
  JOB_DESCRIPTION_MIN_LENGTH,
  JOB_DESCRIPTION_MAX_LENGTH,
  JOB_DESCRIPTION_VALIDATION_MESSAGES,
} from '../config/constants';

export const jobService = {
  async createJob(userId: string, data: { title: string; company?: string; description: string; location?: string }): Promise<JobItem> {
    if (!data.description || typeof data.description !== 'string' || !data.description.trim()) {
      const err: any = new Error(JOB_DESCRIPTION_VALIDATION_MESSAGES.REQUIRED);
      err.code = 'JOB_DESCRIPTION_REQUIRED';
      err.status = 400;
      throw err;
    }

    if (data.description.length < JOB_DESCRIPTION_MIN_LENGTH) {
      const err: any = new Error(JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_SHORT);
      err.code = 'JOB_DESCRIPTION_TOO_SHORT';
      err.status = 400;
      throw err;
    }

    if (data.description.length > JOB_DESCRIPTION_MAX_LENGTH) {
      const err: any = new Error(JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_LONG);
      err.code = 'JOB_DESCRIPTION_TOO_LONG';
      err.status = 400;
      throw err;
    }

    const jobData = {
      user_id: userId,
      title: data.title,
      company: data.company || 'Company Confidential',
      location: data.location || 'Remote / Flexible',
      description: data.description,
      status: 'Active',
      is_ranked: false,
      attached_resume_ids: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    try {
      const { data: row, error } = await supabaseAdmin
        .from('jobs')
        .insert(jobData)
        .select()
        .single();

      if (error || !row) {
        logger.warn(`Failed to insert job into database: ${error?.message}`);
        return {
          id: `job-${Date.now()}`,
          title: data.title,
          company: data.company || 'Company Confidential',
          description: data.description,
          createdAt: 'Today',
          lastUpdated: 'Today',
          status: 'Active',
          attachedResumeIds: [],
          isRanked: false,
        };
      }

      return {
        id: row.id,
        title: row.title,
        company: row.company,
        description: row.description,
        createdAt: 'Today',
        lastUpdated: 'Today',
        status: row.status as 'Active' | 'Screened' | 'Draft',
        attachedResumeIds: row.attached_resume_ids || [],
        isRanked: row.is_ranked,
      };
    } catch {
      return {
        id: `job-${Date.now()}`,
        title: data.title,
        company: data.company || 'Company Confidential',
        description: data.description,
        createdAt: 'Today',
        lastUpdated: 'Today',
        status: 'Active',
        attachedResumeIds: [],
        isRanked: false,
      };
    }
  },

  async listJobs(userId: string): Promise<JobItem[]> {
    try {
      const { data: rows, error } = await supabaseAdmin
        .from('jobs')
        .select(`*, job_matches(*)`)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error || !rows) return [];

      return rows.map((r) => {
        const matchesMap: Record<string, JobMatchResult> = {};
        if (r.job_matches && Array.isArray(r.job_matches)) {
          r.job_matches.forEach((m: any) => {
            const strongCount = m.strong_matches_json?.length || 0;
            const gapCount = m.skill_gaps_json?.length || 0;
            const totalCount = strongCount + gapCount;

            matchesMap[m.resume_id] = {
              resumeId: m.resume_id,
              candidateName: m.candidate_name || 'Candidate',
              candidateEmail: m.candidate_email || undefined,
              candidatePhone: m.candidate_phone || undefined,
              targetRole: r.title,
              matchPercentage: m.match_percentage,
              atsMatchPercentage: m.ats_match_percentage ?? m.match_percentage,
              skillsMatchedCount: m.skills_matched_count || (totalCount > 0 ? `${strongCount}/${totalCount}` : undefined),
              experienceMatchPercentage: m.experience_match_percentage ?? undefined,
              matchSummary: m.match_summary || '',
              strongMatches: m.strong_matches_json || [],
              skillGaps: m.skill_gaps_json || [],
            };
          });
        }

        return {
          id: r.id,
          title: r.title,
          company: r.company,
          description: r.description,
          createdAt: 'Today',
          lastUpdated: 'Today',
          status: r.status as 'Active' | 'Screened' | 'Draft',
          attachedResumeIds: r.attached_resume_ids || [],
          matches: matchesMap,
          isRanked: r.is_ranked,
        };
      });
    } catch {
      return [];
    }
  },

  async getJobById(userId: string, jobId: string): Promise<JobItem | null> {
    try {
      const { data: r, error } = await supabaseAdmin
        .from('jobs')
        .select(`*, job_matches(*)`)
        .eq('id', jobId)
        .eq('user_id', userId)
        .single();

      if (error || !r) return null;

      const matchesMap: Record<string, JobMatchResult> = {};
      if (r.job_matches && Array.isArray(r.job_matches)) {
        r.job_matches.forEach((m: any) => {
          const strongCount = m.strong_matches_json?.length || 0;
          const gapCount = m.skill_gaps_json?.length || 0;
          const totalCount = strongCount + gapCount;

          matchesMap[m.resume_id] = {
            resumeId: m.resume_id,
            candidateName: m.candidate_name || 'Candidate',
            candidateEmail: m.candidate_email || undefined,
            candidatePhone: m.candidate_phone || undefined,
            targetRole: r.title,
            matchPercentage: m.match_percentage,
            atsMatchPercentage: m.ats_match_percentage ?? m.match_percentage,
            skillsMatchedCount: m.skills_matched_count || (totalCount > 0 ? `${strongCount}/${totalCount}` : undefined),
            experienceMatchPercentage: m.experience_match_percentage ?? undefined,
            matchSummary: m.match_summary || '',
            strongMatches: m.strong_matches_json || [],
            skillGaps: m.skill_gaps_json || [],
          };
        });
      }

      return {
        id: r.id,
        title: r.title,
        company: r.company,
        description: r.description,
        createdAt: 'Today',
        lastUpdated: 'Today',
        status: r.status,
        attachedResumeIds: r.attached_resume_ids || [],
        matches: matchesMap,
        isRanked: r.is_ranked,
      };
    } catch {
      return null;
    }
  },

  async deleteJob(userId: string, jobId: string): Promise<boolean> {
    try {
      const { error } = await supabaseAdmin
        .from('jobs')
        .delete()
        .eq('id', jobId)
        .eq('user_id', userId);

      return !error;
    } catch {
      return false;
    }
  },

  async attachResumes(userId: string, jobId: string, resumeIds: string[]): Promise<JobItem | null> {
    try {
      const job = await this.getJobById(userId, jobId);
      if (!job) return null;

      const merged = Array.from(new Set([...job.attachedResumeIds, ...resumeIds]));

      await supabaseAdmin
        .from('jobs')
        .update({
          attached_resume_ids: merged,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('user_id', userId);

      job.attachedResumeIds = merged;
      return job;
    } catch {
      return null;
    }
  },

  async detachResume(userId: string, jobId: string, resumeId: string): Promise<JobItem | null> {
    try {
      const job = await this.getJobById(userId, jobId);
      if (!job) return null;

      const updated = job.attachedResumeIds.filter((id) => id !== resumeId);

      await supabaseAdmin
        .from('jobs')
        .update({
          attached_resume_ids: updated,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('user_id', userId);

      // Delete match record if existing
      await supabaseAdmin
        .from('job_matches')
        .delete()
        .eq('job_id', jobId)
        .eq('resume_id', resumeId)
        .eq('user_id', userId);

      if (job.matches) {
        delete job.matches[resumeId];
      }
      job.attachedResumeIds = updated;
      return job;
    } catch {
      return null;
    }
  },

  async rankResumesForJob(userId: string, jobId: string): Promise<{ job: JobItem; creditsDeducted: number }> {
    const job = await this.getJobById(userId, jobId);
    if (!job || job.attachedResumeIds.length === 0) {
      throw new Error('No resumes attached to rank for this job.');
    }

    if (!job.description || typeof job.description !== 'string' || !job.description.trim()) {
      const err: any = new Error(JOB_DESCRIPTION_VALIDATION_MESSAGES.REQUIRED);
      err.code = 'JOB_DESCRIPTION_REQUIRED';
      err.status = 400;
      throw err;
    }

    if (job.description.length < JOB_DESCRIPTION_MIN_LENGTH) {
      const err: any = new Error(JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_SHORT);
      err.code = 'JOB_DESCRIPTION_TOO_SHORT';
      err.status = 400;
      throw err;
    }

    if (job.description.length > JOB_DESCRIPTION_MAX_LENGTH) {
      const err: any = new Error(JOB_DESCRIPTION_VALIDATION_MESSAGES.TOO_LONG);
      err.code = 'JOB_DESCRIPTION_TOO_LONG';
      err.status = 400;
      throw err;
    }

    const COST_PER_CANDIDATE = 1;
    const totalCost = job.attachedResumeIds.length * COST_PER_CANDIDATE;
    const balance = await creditService.getBalance(userId);

    if (balance < totalCost) {
      const err: any = new Error(`INSUFFICIENT_CREDITS: Ranking ${job.attachedResumeIds.length} candidate resume(s) requires ${totalCost} credit(s), but only ${balance} is available.`);
      err.code = 'INSUFFICIENT_CREDITS';
      err.requiredCredits = totalCost;
      err.availableCredits = balance;
      throw err;
    }

    const matchesMap: Record<string, JobMatchResult> = {};

    try {
      // Fetch resumes with detected skills and resume analysis
      const { data: resumeRows } = await supabaseAdmin
        .from('resumes')
        .select(`
          *,
          resume_analyses(*),
          detected_skills(*)
        `)
        .in('id', job.attachedResumeIds)
        .eq('user_id', userId);

      for (const resRow of resumeRows || []) {
        const detectedSkillsList = (resRow.detected_skills || [])
          .filter((s: any) => !s.is_missing)
          .map((s: any) => s.skill_name);
        
        const missingSkillsList = (resRow.detected_skills || [])
          .filter((s: any) => s.is_missing)
          .map((s: any) => s.skill_name);

        const analysis = (resRow.resume_analyses && resRow.resume_analyses[0]) || {};

        const candidateProfile = [
          `Candidate Name: ${resRow.candidate_name}`,
          `Target Role: ${resRow.target_role}`,
          `Resume Quality Score: ${resRow.resume_score || 80}/100`,
          `ATS Score: ${resRow.ats_compatibility || 80}%`,
          `Candidate Detected Technical Skills: ${detectedSkillsList.length > 0 ? detectedSkillsList.join(', ') : 'None extracted'}`,
          `Candidate Known Missing/Gap Skills: ${missingSkillsList.length > 0 ? missingSkillsList.join(', ') : 'None'}`,
          `Executive Summary & Recommendation: ${analysis.ai_recommendation || 'Candidate technical profile.'}`
        ].join('\n');

        const matchResult = await geminiService.matchResumeWithJob(
          candidateProfile,
          job.title,
          job.description
        );

        const candidateEmail = resRow.candidate_email || undefined;
        const candidatePhone = resRow.candidate_phone || undefined;

        matchResult.resumeId = resRow.id;
        matchResult.candidateName = resRow.candidate_name;
        matchResult.candidateEmail = candidateEmail;
        matchResult.candidatePhone = candidatePhone;
        // The original resume ats_compatibility is the sole source of truth for ATS Score.
        if (resRow.ats_compatibility !== undefined) {
          matchResult.atsMatchPercentage = resRow.ats_compatibility;
        }
        matchesMap[resRow.id] = matchResult;

        // Upsert job_match — onConflict references the named unique constraint
        const { error: upsertErr } = await supabaseAdmin.from('job_matches').upsert({
          job_id: jobId,
          resume_id: resRow.id,
          user_id: userId,
          candidate_name: resRow.candidate_name,
          candidate_email: candidateEmail || null,
          candidate_phone: candidatePhone || null,
          match_percentage: matchResult.matchPercentage,
          ats_match_percentage: matchResult.atsMatchPercentage,
          skills_matched_count: matchResult.skillsMatchedCount,
          match_summary: matchResult.matchSummary,
          strong_matches_json: matchResult.strongMatches,
          skill_gaps_json: matchResult.skillGaps,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'job_id,resume_id' });

        if (upsertErr) {
          logger.error(`Failed to upsert job_match for resume ${resRow.id}: ${upsertErr.message}`);
          throw new Error(`Database error saving match for ${resRow.candidate_name}: ${upsertErr.message}`);
        }
      }

      // Update job status
      await supabaseAdmin
        .from('jobs')
        .update({
          status: 'Screened',
          is_ranked: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .eq('user_id', userId);

      job.status = 'Screened';
      job.isRanked = true;
      job.matches = matchesMap;

      // 4. ATOMIC CREDIT DEDUCTION ONLY AFTER RANKING PIPELINE & PERSISTENCE SUCCEED
      await creditService.deductCredits(userId, totalCost, `Candidate ranking for job: ${job.title}`, jobId);

      return { job, creditsDeducted: totalCost };
    } catch (err: any) {
      logger.error(`Candidate ranking operation failed for job ${jobId}: ${err.message}`);
      throw err;
    }
  },

  async generateJobDescription(userId: string, title: string, company?: string, keywords?: string): Promise<{ description: string; creditsRemaining: number }> {
    const COST = 1;
    const balance = await creditService.getBalance(userId);

    if (balance < COST) {
      const err: any = new Error(`INSUFFICIENT_CREDITS: AI job description generation requires ${COST} credit, but current balance is ${balance}.`);
      err.code = 'INSUFFICIENT_CREDITS';
      throw err;
    }

    const generatedText = await geminiService.generateJobDescription(title, company, keywords);

    const deduction = await creditService.deductCredits(userId, COST, `AI job description generation for ${title}`);

    return {
      description: generatedText,
      creditsRemaining: deduction.newBalance,
    };
  }
};
