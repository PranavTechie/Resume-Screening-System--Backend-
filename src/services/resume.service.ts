import crypto from 'crypto';
import { supabaseAdmin } from '../config/supabase';
import { storageService } from './storage.service';
import { extractTextFromFile } from '../utils/textExtractor';
import { extractContactInfo } from '../utils/contactExtractor';
import { geminiService } from './ai/gemini.service';
import { creditService } from './credit.service';
import { logger } from '../utils/logger';
import { ResumeAnalysisOutput } from '../types';

import { MAX_RESUME_FILE_SIZE } from '../config/constants';

export interface AnalysisProgressEvent {
  stage: 'uploading' | 'extracting' | 'ai_analyzing' | 'ats_scoring' | 'persisting' | 'completed' | 'error';
  progress: number;
  message: string;
  data?: any;
}

async function withDbTimeout<T>(promise: PromiseLike<T>, timeoutMs: number = 10000, operationName: string = 'Database operation'): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err: any = new Error(`DATABASE_TIMEOUT: ${operationName} timed out after ${timeoutMs / 1000}s`);
      err.code = 'DATABASE_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const resumeService = {
  async processAndSaveResume(
    userId: string,
    fileBuffer: Buffer,
    fileName: string,
    mimeType: string,
    fileSize: number,
    onProgress?: (event: AnalysisProgressEvent) => void,
    requestStartTime?: number
  ): Promise<{ resume: ResumeAnalysisOutput; creditsRemaining: number }> {
    const COST = 1;
    let uploadedFilePath: string | null = null;
    let createdResumeId: string | null = null;
    const totalStartTime = requestStartTime || Date.now();

    // 0. ENFORCE 5MB MAXIMUM FILE SIZE LIMIT
    if (fileSize > MAX_RESUME_FILE_SIZE) {
      throw new Error('File size exceeds the 5MB limit.');
    }

    try {
      // STAGE 1: VALIDATING & UPLOADING (15%)
      onProgress?.({
        stage: 'uploading',
        progress: 15,
        message: 'Validating document & checking credits...',
      });

      // 1. PRE-CHECK CREDITS BALANCE BEFORE STORAGE UPLOAD OR AI API CALLS
      const currentBalance = await withDbTimeout(creditService.getBalance(userId), 8000, 'Check Credit Balance');
      logger.info(`[ResumeAPI] credits checked (${Date.now() - totalStartTime}ms) - balance=${currentBalance}`);
      if (currentBalance < COST) {
        throw new Error(`INSUFFICIENT_CREDITS: Need ${COST} credit for resume analysis, current balance is ${currentBalance}.`);
      }

      // 2. INITIATE STORAGE UPLOAD CONCURRENTLY WITH AI ANALYSIS
      const storageUploadPromise = storageService.uploadResumeFile(userId, fileBuffer, fileName, mimeType);

      // STAGE 2: EXTRACTING TEXT & AI ANALYSIS
      const isImage = mimeType.startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(fileName);
      let analysisResult: ResumeAnalysisOutput;
      let text = '';

      if (isImage) {
        logger.info(`[ResumeAPI] extraction started (${Date.now() - totalStartTime}ms) for "${fileName}"`);
        logger.info(`[ResumeAPI] extraction completed in 0ms (multimodal image inline)`);
        analysisResult = await geminiService.analyzeResume({ buffer: fileBuffer, mimeType }, fileName, totalStartTime);
        text = analysisResult.extractedText || '';
      } else {
        logger.info(`[ResumeAPI] extraction started (${Date.now() - totalStartTime}ms) for "${fileName}"`);
        const extractStartTime = Date.now();
        const rawText = await extractTextFromFile(fileBuffer, mimeType, fileName);
        text = (rawText || '').trim();
        const extractionDuration = Date.now() - extractStartTime;
        logger.info(`[ResumeAPI] extraction completed in ${extractionDuration}ms (${text.length} chars)`);

        if (text.length < 50 && (mimeType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf'))) {
          logger.info(`[ResumeAPI] PDF has insufficient text (<50 chars) - routing to multimodal Gemini call (${Date.now() - totalStartTime}ms)`);
          analysisResult = await geminiService.analyzeResume({ buffer: fileBuffer, mimeType: 'application/pdf' }, fileName, totalStartTime);
          text = analysisResult.extractedText || '';
        } else if (text.length < 50) {
          throw new Error("TEXT_EXTRACTION_FAILED: We couldn't read enough text from this document. Please upload a clearer resume.");
        } else {
          analysisResult = await geminiService.analyzeResume(text, fileName, totalStartTime);
        }
      }

      // STAGE 4: ATS SCORING & SKILL MATRIX (85%)
      logger.info(`[ResumeAPI] ATS started (${Date.now() - totalStartTime}ms)`);
      const atsStartTime = Date.now();
      onProgress?.({
        stage: 'ats_scoring',
        progress: 85,
        message: 'Calculating ATS score & skill matrix...',
      });
      const atsDuration = Date.now() - atsStartTime;
      logger.info(`[ResumeAPI] ATS completed in ${atsDuration}ms`);

      // STAGE 5: DB PERSISTENCE & AUDIT REPORT (95%)
      logger.info(`[ResumeAPI] persistence started (${Date.now() - totalStartTime}ms)`);
      const persistStartTime = Date.now();
      onProgress?.({
        stage: 'persisting',
        progress: 95,
        message: 'Saving audit report & profile...',
      });

      // Await storage upload before DB persistence (with graceful path fallback on network timeout)
      const cleanFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
      const fallbackPath = `${userId}/${Date.now()}_${cleanFileName}`;
      let resolvedFilePath = fallbackPath;
      try {
        const storageResult = await Promise.race([
          storageUploadPromise,
          new Promise<{ filePath: string }>((resolve) =>
            setTimeout(() => {
              logger.warn(`Storage upload exceeded 15s; proceeding with storage path reference.`);
              resolve({ filePath: fallbackPath });
            }, 15000)
          )
        ]);
        resolvedFilePath = storageResult?.filePath || fallbackPath;
      } catch (storageErr: any) {
        logger.warn(`Storage upload fallback triggered: ${storageErr.message}`);
        resolvedFilePath = fallbackPath;
      }
      uploadedFilePath = resolvedFilePath;

      // Extract candidate contact information if not already extracted by AI
      const deterministicContacts = extractContactInfo(text || analysisResult.extractedText || '');
      const candidateEmail = analysisResult.candidateEmail || deterministicContacts.email;
      const candidatePhone = analysisResult.candidatePhone || deterministicContacts.phone;
      analysisResult.candidateEmail = candidateEmail;
      analysisResult.candidatePhone = candidatePhone;

      // 6. DB PERSISTENCE (COMPENSATING TRANSACTION WRAPPER)
      // A. Insert Resumes Row
      const { data: resumeRow, error: resumeErr } = await withDbTimeout(
        supabaseAdmin
          .from('resumes')
          .insert({
            user_id: userId,
            candidate_name: analysisResult.candidateName,
            candidate_email: candidateEmail || null,
            candidate_phone: candidatePhone || null,
            candidate_linkedin: analysisResult.candidateLinkedIn || null,
            candidate_github: analysisResult.candidateGitHub || null,
            candidate_website: analysisResult.candidateWebsite || null,
            target_role: analysisResult.targetRole,
            status: 'Ready',
            file_path: resolvedFilePath,
            file_type: mimeType,
            file_name: fileName,
            file_size: fileSize,
            raw_text: text || analysisResult.extractedText || null,
            resume_score: analysisResult.resumeScore,
            ats_compatibility: analysisResult.atsCompatibility,
            skills_detected_count: analysisResult.skillsDetectedCount,
            ai_improvements_count: analysisResult.aiImprovementsCount,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .select()
          .single(),
        10000,
        'Insert Resume'
      );

      if (resumeErr || !resumeRow) {
        throw new Error(`DATABASE_ERROR: Failed to save resume record (${resumeErr?.message || 'Database insert failed'})`);
      }

      createdResumeId = resumeRow.id;
      if (createdResumeId) {
        analysisResult.id = createdResumeId;
      }

      // B. Insert Resume Analyses Row
      const { error: analysisErr } = await withDbTimeout(
        supabaseAdmin
          .from('resume_analyses')
          .insert({
            resume_id: createdResumeId,
            user_id: userId,
            overall_score: analysisResult.resumeScore,
            ats_score: analysisResult.atsCompatibility,
            ai_recommendation: analysisResult.aiRecommendation,
            general_issues: analysisResult.generalIssues,
            ats_breakdown_json: analysisResult.atsBreakdown,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        10000,
        'Insert Resume Analysis'
      );

      if (analysisErr) {
        throw new Error(`DATABASE_ERROR: Failed to save resume analysis (${analysisErr.message})`);
      }

      // C. Insert Detected Skills Rows
      const skillRows: any[] = [];
      if (analysisResult.detectedSkills && analysisResult.detectedSkills.length > 0) {
        analysisResult.detectedSkills.forEach((s) => {
          skillRows.push({
            resume_id: createdResumeId,
            user_id: userId,
            skill_name: s,
            category: 'frontend',
            is_missing: false,
          });
        });
      }
      if (analysisResult.missingSkills && analysisResult.missingSkills.length > 0) {
        analysisResult.missingSkills.forEach((s) => {
          skillRows.push({
            resume_id: createdResumeId,
            user_id: userId,
            skill_name: s,
            category: 'frontend',
            is_missing: true,
          });
        });
      }
      if (skillRows.length > 0) {
        const { error: skillErr } = await withDbTimeout(
          supabaseAdmin.from('detected_skills').insert(skillRows),
          10000,
          'Insert Detected Skills'
        );
        if (skillErr) {
          logger.warn(`Failed to insert detected_skills: ${skillErr.message}`);
        }
      }

      // D. Insert Analysis Report Row (Immediate Executive Audit Report)
      await withDbTimeout(
        supabaseAdmin.from('analysis_reports').insert({
          user_id: userId,
          title: `${analysisResult.targetRole} ATS & Resume Audit`,
          report_type: 'ATS Audit',
          candidate_name: analysisResult.candidateName,
          score: analysisResult.resumeScore,
          ats_pass_rate: analysisResult.atsCompatibility,
          summary: analysisResult.aiRecommendation,
          data_json: analysisResult,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
        10000,
        'Insert Analysis Report'
      );

      // 7. ATOMIC CREDIT DEDUCTION (FINAL STEP ONLY AFTER DB PERSISTENCE SUCCEEDS)
      let deduction;
      try {
        deduction = await withDbTimeout(
          creditService.deductCredits(
            userId,
            COST,
            `Resume analysis: ${fileName}`,
            createdResumeId || undefined
          ),
          8000,
          'Deduct Credit'
        );
      } catch (creditErr: any) {
        throw new Error(`CREDIT_DEDUCTION_FAILED: ${creditErr.message}`);
      }

      const persistDuration = Date.now() - persistStartTime;
      const totalDuration = Date.now() - totalStartTime;

      logger.info(`[ResumeAPI] persistence completed in ${persistDuration}ms`);

      return {
        resume: analysisResult,
        creditsRemaining: deduction.newBalance,
      };

    } catch (err: any) {
      logger.error(`Pipeline execution failed for user ${userId} file "${fileName}": ${err.message}`);

      // COMPENSATING CLEANUP & ROLLBACK
      if (createdResumeId) {
        try {
          // Deleting from resumes CASCADE deletes resume_analyses and detected_skills automatically
          await supabaseAdmin.from('resumes').delete().eq('id', createdResumeId).eq('user_id', userId);
        } catch (cleanupDbErr: any) {
          logger.error(`Rollback DB cleanup error for resume ${createdResumeId}: ${cleanupDbErr.message}`);
        }
      }

      if (uploadedFilePath) {
        try {
          await storageService.deleteResumeFile(uploadedFilePath);
        } catch (cleanupStorageErr: any) {
          logger.error(`Rollback Storage cleanup error for path ${uploadedFilePath}: ${cleanupStorageErr.message}`);
        }
      }

      throw err;
    }
  },

  async listResumes(userId: string): Promise<ResumeAnalysisOutput[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('resumes')
        .select(`
          *,
          resume_analyses(*),
          detected_skills(*)
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error || !data) return [];

      return data.map((row) => {
        const analysis = row.resume_analyses?.[0] || {};
        const allSkills = row.detected_skills || [];
        const detectedSkills = allSkills.filter((s: any) => !s.is_missing).map((s: any) => s.skill_name);
        const missingSkills = allSkills.filter((s: any) => s.is_missing).map((s: any) => s.skill_name);

        return {
          id: row.id,
          candidateName: row.candidate_name,
          candidateEmail: row.candidate_email || analysis.data_json?.candidateEmail || undefined,
          candidatePhone: row.candidate_phone || analysis.data_json?.candidatePhone || undefined,
          candidateLinkedIn: row.candidate_linkedin || analysis.data_json?.candidateLinkedIn || undefined,
          candidateGitHub: row.candidate_github || analysis.data_json?.candidateGitHub || undefined,
          candidateWebsite: row.candidate_website || analysis.data_json?.candidateWebsite || undefined,
          targetRole: row.target_role,
          status: row.status as 'Ready' | 'Processing' | 'Error',
          resumeScore: row.resume_score,
          atsCompatibility: row.ats_compatibility,
          skillsDetectedCount: row.skills_detected_count || detectedSkills.length,
          aiImprovementsCount: row.ai_improvements_count,
          detectedSkills,
          missingSkills,
          generalIssues: analysis.general_issues || [],
          aiRecommendation: analysis.ai_recommendation || '',
          atsBreakdown: analysis.ats_breakdown_json || { keywordMatch: 0, formatting: 0, experienceRelevance: 0 },
        };
      });
    } catch (err: any) {
      logger.error(`listResumes error: ${err.message}`);
      return [];
    }
  },

  async getResumeById(userId: string, resumeId: string): Promise<ResumeAnalysisOutput | null> {
    try {
      const { data: row, error } = await supabaseAdmin
        .from('resumes')
        .select(`*, resume_analyses(*), detected_skills(*)`)
        .eq('id', resumeId)
        .eq('user_id', userId)
        .single();

      if (error || !row) return null;

      const analysis = row.resume_analyses?.[0] || {};
      const allSkills = row.detected_skills || [];
      const detectedSkills = allSkills.filter((s: any) => !s.is_missing).map((s: any) => s.skill_name);
      const missingSkills = allSkills.filter((s: any) => s.is_missing).map((s: any) => s.skill_name);

      return {
        id: row.id,
        candidateName: row.candidate_name,
        candidateEmail: row.candidate_email || analysis.data_json?.candidateEmail || undefined,
        candidatePhone: row.candidate_phone || analysis.data_json?.candidatePhone || undefined,
        candidateLinkedIn: row.candidate_linkedin || analysis.data_json?.candidateLinkedIn || undefined,
        candidateGitHub: row.candidate_github || analysis.data_json?.candidateGitHub || undefined,
        candidateWebsite: row.candidate_website || analysis.data_json?.candidateWebsite || undefined,
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
      };
    } catch {
      return null;
    }
  },

  async deleteResume(userId: string, resumeId: string): Promise<boolean> {
    try {
      // 1. Fetch file_path to delete from storage
      const { data: row } = await supabaseAdmin
        .from('resumes')
        .select('file_path')
        .eq('id', resumeId)
        .eq('user_id', userId)
        .single();

      if (row?.file_path) {
        await storageService.deleteResumeFile(row.file_path);
      }

      // 2. Delete database record (cascade deletes analyses & skills)
      const { error } = await supabaseAdmin
        .from('resumes')
        .delete()
        .eq('id', resumeId)
        .eq('user_id', userId);

      if (error) {
        logger.warn(`Failed to delete resume record ${resumeId}: ${error.message}`);
      }

      return true;
    } catch (err: any) {
      logger.error(`Delete resume error: ${err.message}`);
      return false;
    }
  },

  async generateInterviewPrep(
    userId: string,
    resumeId: string,
    jobId?: string
  ): Promise<{ interviewPrep: any; creditsRemaining: number }> {
    const { data: row, error } = await supabaseAdmin
      .from('resumes')
      .select('*, resume_analyses(*), detected_skills(*)')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .single();

    if (error || !row) {
      throw new Error('RESUME_NOT_FOUND: Candidate resume not found.');
    }

    const analysis = row.resume_analyses?.[0];
    const existingPrep = analysis?.interview_prep_json;

    // Check if rich prep already generated (0 credits for reopening)
    if (existingPrep && existingPrep.isGenerated && existingPrep.sampleQuestions?.length > 0) {
      const currentBalance = await creditService.getBalance(userId);
      return { interviewPrep: existingPrep, creditsRemaining: currentBalance };
    }

    const balance = await creditService.getBalance(userId);
    if (balance < 1) {
      const err: any = new Error('INSUFFICIENT_CREDITS: Interview preparation AI generation requires 1 credit.');
      err.code = 'INSUFFICIENT_CREDITS';
      throw err;
    }

    let jobDescription: string | undefined;
    if (jobId) {
      const { data: jRow } = await supabaseAdmin.from('jobs').select('description').eq('id', jobId).single();
      if (jRow) jobDescription = jRow.description;
    }

    const detectedSkills = (row.detected_skills || []).map((s: any) => s.skill_name);
    const resumeContextText = `
Candidate Name: ${row.candidate_name}
Target Role: ${row.target_role}
Summary: ${analysis?.ai_recommendation || ''}
Detected Skills: ${detectedSkills.join(', ')}

FULL CANDIDATE RESUME TEXT & PROJECTS:
"""
${row.raw_text || ''}
"""
    `.trim();

    const generatedPrep = await geminiService.generateInterviewPrep(
      row.candidate_name,
      row.target_role,
      resumeContextText,
      jobDescription
    );
    generatedPrep.isGenerated = true;

    const { error: updateErr } = await supabaseAdmin
      .from('resume_analyses')
      .update({
        interview_prep_json: generatedPrep,
        updated_at: new Date().toISOString(),
      })
      .eq('resume_id', resumeId)
      .eq('user_id', userId);

    if (updateErr) {
      throw new Error(`DATABASE_ERROR: Failed to save interview preparation (${updateErr.message})`);
    }

    const deduction = await creditService.deductCredits(
      userId,
      1,
      `Interview preparation: ${row.candidate_name}`,
      resumeId
    );

    return {
      interviewPrep: generatedPrep,
      creditsRemaining: deduction.newBalance,
    };
  },

  async evaluatePracticeAnswer(
    userId: string,
    resumeId: string,
    questionId: string,
    candidateAnswer: string
  ): Promise<{ evaluation: any; updatedPrep: any }> {
    const { data: row, error } = await supabaseAdmin
      .from('resumes')
      .select('*, resume_analyses(*), detected_skills(*)')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .single();

    if (error || !row) {
      throw new Error('RESUME_NOT_FOUND: Candidate resume not found.');
    }

    const analysis = row.resume_analyses?.[0];
    const prepData = analysis?.interview_prep_json || {};
    const questions: any[] = prepData.sampleQuestions || [];
    const targetQ = questions.find((q: any) => q.id === questionId) || questions[0];

    if (!targetQ) {
      throw new Error('QUESTION_NOT_FOUND: Question ID not found in generated set.');
    }

    const detectedSkills = (row.detected_skills || []).map((s: any) => s.skill_name);
    const resumeContext = `Candidate Name: ${row.candidate_name}, Skills: ${detectedSkills.join(', ')}\nRaw Text: ${row.raw_text || ''}`;

    const evaluation = await geminiService.evaluatePracticeAnswer(
      targetQ.question,
      targetQ.category,
      targetQ.difficulty,
      targetQ.keyPoints || [],
      targetQ.idealAnswer || '',
      candidateAnswer,
      resumeContext
    );

    const practiceHistory = prepData.practiceHistory || {};
    const qHistory = practiceHistory[questionId] || [];
    const attemptNumber = qHistory.length + 1;

    evaluation.id = `eval-${Date.now()}`;
    evaluation.questionId = questionId;
    evaluation.candidateAnswer = candidateAnswer;
    evaluation.attemptNumber = attemptNumber;
    evaluation.evaluatedAt = new Date().toISOString();

    // Chronological practice history per question (Attempt 1, Attempt 2...)
    practiceHistory[questionId] = [...qHistory, evaluation];

    // Compute dynamic readiness dashboard stats
    const allEvaluations: any[] = Object.values(practiceHistory).flat();
    const questionsPracticed = Object.keys(practiceHistory).length;
    const overallAvg = allEvaluations.length > 0 ? Math.round(allEvaluations.reduce((sum, e) => sum + (e.overallScore || 0), 0) / allEvaluations.length) : null;
    const techAvg = allEvaluations.length > 0 ? Math.round(allEvaluations.reduce((sum, e) => sum + (e.technicalAccuracy || 0), 0) / allEvaluations.length) : null;
    const relAvg = allEvaluations.length > 0 ? Math.round(allEvaluations.reduce((sum, e) => sum + (e.relevance || 0), 0) / allEvaluations.length) : null;
    const compAvg = allEvaluations.length > 0 ? Math.round(allEvaluations.reduce((sum, e) => sum + (e.completeness || 0), 0) / allEvaluations.length) : null;

    prepData.practiceHistory = practiceHistory;
    prepData.readinessDashboard = {
      overallReadiness: overallAvg,
      technicalReadiness: techAvg,
      systemDesignReadiness: relAvg,
      behavioralReadiness: compAvg,
      projectReadiness: techAvg,
      totalQuestions: questions.length,
      questionsPracticed
    };
    if (overallAvg !== null) {
      prepData.readinessScore = overallAvg;
    }

    await supabaseAdmin
      .from('resume_analyses')
      .update({
        interview_prep_json: prepData,
        updated_at: new Date().toISOString(),
      })
      .eq('resume_id', resumeId)
      .eq('user_id', userId);

    return { evaluation, updatedPrep: prepData };
  },

  async generateFollowUpQuestions(
    userId: string,
    resumeId: string,
    questionId: string,
    candidateAnswer: string
  ): Promise<{ followUps: string[] }> {
    const { data: row } = await supabaseAdmin
      .from('resumes')
      .select('*, resume_analyses(*)')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .single();

    const analysis = row?.resume_analyses?.[0];
    const prepData = analysis?.interview_prep_json || {};
    const questions: any[] = prepData.sampleQuestions || [];
    const targetQ = questions.find((q: any) => q.id === questionId);

    const followUps = await geminiService.generateFollowUpQuestions(
      targetQ?.question || 'Technical question',
      candidateAnswer,
      row?.raw_text || ''
    );

    return { followUps };
  },

  async evaluateMockInterview(
    userId: string,
    resumeId: string,
    qaPairs: { questionId: string; question: string; category: string; candidateAnswer: string }[]
  ): Promise<{ session: any; updatedPrep: any }> {
    const { data: row, error } = await supabaseAdmin
      .from('resumes')
      .select('*, resume_analyses(*), detected_skills(*)')
      .eq('id', resumeId)
      .eq('user_id', userId)
      .single();

    if (error || !row) {
      throw new Error('RESUME_NOT_FOUND: Candidate resume not found.');
    }

    const analysis = row.resume_analyses?.[0];
    const prepData = analysis?.interview_prep_json || {};

    const detectedSkills = (row.detected_skills || []).map((s: any) => s.skill_name);
    const resumeContext = `Candidate Name: ${row.candidate_name}, Target Role: ${row.target_role}, Skills: ${detectedSkills.join(', ')}`;

    const mockEval = await geminiService.evaluateMockInterview(
      row.candidate_name,
      row.target_role,
      qaPairs,
      resumeContext
    );

    const mockSession = {
      id: `mock-${Date.now()}`,
      completedAt: new Date().toISOString(),
      ...mockEval,
      qaPairs
    };

    const mockSessions = prepData.mockInterviewSessions || [];
    prepData.mockInterviewSessions = [mockSession, ...mockSessions];

    await supabaseAdmin
      .from('resume_analyses')
      .update({
        interview_prep_json: prepData,
        updated_at: new Date().toISOString(),
      })
      .eq('resume_id', resumeId)
      .eq('user_id', userId);

    return { session: mockSession, updatedPrep: prepData };
  }
};
