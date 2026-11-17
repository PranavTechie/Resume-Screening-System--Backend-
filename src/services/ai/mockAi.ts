/**
 * Deterministic fake AI used ONLY when AI_MOCK_MODE=true and NODE_ENV != production
 * (local load tests / CI). It never runs in production, so real users never get fake scores.
 */
import crypto from 'crypto';
import { countResumeSignals } from '../resumeValidator.service';
import type { AnalyzeResumeResult, JobRequirementsResult, MatchJudgment, VisionReadResult } from './gemini.service';

const KNOWN_SKILLS = [
  'JavaScript', 'TypeScript', 'React', 'Node.js', 'Python', 'Java', 'SQL', 'PostgreSQL', 'MongoDB', 'Docker',
  'Kubernetes', 'AWS', 'Git', 'HTML', 'CSS', 'Machine Learning', 'TensorFlow', 'Pandas', 'Excel', 'Figma',
  'Communication', 'Express', 'Django', 'Flask', 'C++', 'Linux', 'REST API', 'GraphQL', 'Redis', 'Power BI',
];

function hashInt(text: string, mod: number): number {
  return parseInt(crypto.createHash('sha256').update(text).digest('hex').slice(0, 8), 16) % mod;
}

function skillsIn(text: string): string[] {
  const lower = text.toLowerCase();
  return KNOWN_SKILLS.filter((s) => lower.includes(s.toLowerCase()));
}

async function latency(): Promise<void> {
  const ms = 150 + Math.floor(Math.random() * 350);
  await new Promise((r) => setTimeout(r, ms));
}

export const mockAi = {
  async analyzeResume(text: string): Promise<AnalyzeResumeResult> {
    await latency();
    const signals = countResumeSignals(text);
    const isResume = signals.total >= 2;
    const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || 'Candidate';
    const skills = skillsIn(text).slice(0, 10);
    const base = 55 + hashInt(text, 35);
    return {
      isResume,
      documentType: isResume ? 'resume' : 'other document',
      confidence: isResume ? 0.95 : 0.9,
      candidateName: firstLine.slice(0, 60),
      candidateEmail: null,
      candidatePhone: null,
      candidateLinkedIn: null,
      candidateGitHub: null,
      candidateWebsite: null,
      targetRole: 'Software Engineer',
      resumeScore: base,
      atsCompatibility: Math.min(100, base + 5),
      detectedSkills: skills,
      missingSkills: ['Docker', 'Cloud'].filter((s) => !skills.includes(s)).slice(0, 2),
      generalIssues: ['Add measurable results to project bullets.'],
      aiRecommendation: 'Mock analysis (AI_MOCK_MODE).',
      atsBreakdown: { keywordMatch: base, formatting: Math.min(100, base + 10), experienceRelevance: base },
      modelUsed: 'mock',
    };
  },

  async readDocument(buffer: Buffer): Promise<VisionReadResult> {
    await latency();
    const text = buffer.toString('utf8').replace(/[^\x20-\x7E\n]/g, ' ');
    return { isResume: true, documentType: 'resume', confidence: 0.9, text, modelUsed: 'mock' };
  },

  async extractJobRequirements(description: string): Promise<JobRequirementsResult> {
    await latency();
    const skills = skillsIn(description);
    const years = description.match(/(\d+)\+?\s*years?/i);
    return {
      requiredSkills: skills.slice(0, 6),
      niceToHaveSkills: skills.slice(6, 10),
      minYearsExperience: years ? parseInt(years[1], 10) : null,
      modelUsed: 'mock',
    };
  },

  async judgeMatch(resumeText: string, jobDescription: string): Promise<MatchJudgment> {
    await latency();
    const jd = skillsIn(jobDescription);
    const have = skillsIn(resumeText);
    const overlap = jd.filter((s) => have.includes(s));
    const ai = jd.length ? Math.round((overlap.length / jd.length) * 100) : 50;
    return {
      aiJudgment: ai,
      experienceFit: 60,
      candidateYearsExperience: 2,
      reason: `Mock judgment: ${overlap.length}/${jd.length} JD skills found.`,
      strengths: overlap.slice(0, 3),
      concerns: jd.filter((s) => !have.includes(s)).slice(0, 3),
      modelUsed: 'mock',
    };
  },
};
