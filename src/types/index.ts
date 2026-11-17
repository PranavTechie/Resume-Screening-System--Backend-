export interface AuthenticatedUser {
  id: string;
  email: string;
  role?: string;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  message?: string;
  timestamp: string;
}

export interface SkillItem {
  name: string;
  category: 'frontend' | 'backend' | 'devops' | 'soft' | 'data';
  level?: 'Expert' | 'Intermediate' | 'Foundational';
}

export interface ResumeAnalysisOutput {
  id: string;
  candidateName: string;
  targetRole: string;
  status: 'Ready' | 'Processing' | 'Error';
  resumeScore: number;
  atsCompatibility: number;
  skillsDetectedCount: number;
  aiImprovementsCount: number;
  detectedSkills: string[];
  missingSkills: string[];
  generalIssues: string[];
  aiRecommendation: string;
  atsBreakdown: {
    keywordMatch: number;
    formatting: number;
    experienceRelevance: number;
  };
  extractedText?: string;
  candidateEmail?: string | null;
  candidatePhone?: string | null;
  candidateLinkedIn?: string | null;
  candidateGitHub?: string | null;
  candidateWebsite?: string | null;
  /** Resume text was longer than the AI prompt limit; analysis used the first part only. */
  truncated?: boolean;
  documentType?: string | null;
  scoringVersion?: string | null;
  aiModel?: string | null;
  createdAt?: string;
}

export interface JobMatchOutput {
  resumeId: string;
  candidateName: string;
  candidateEmail?: string | null;
  candidatePhone?: string | null;
  targetRole: string;
  matchPercentage: number;
  atsMatchPercentage: number;
  skillsMatchedCount: number;
  experienceMatchPercentage: number;
  matchSummary: string;
  strongMatches: string[];
  skillGaps: string[];
}

export interface JobMatchResult {
  resumeId: string;
  candidateName: string;
  candidateEmail?: string | null;
  candidatePhone?: string | null;
  targetRole: string;
  matchPercentage: number;
  atsMatchPercentage?: number;
  skillsMatchedCount?: number;
  experienceMatchPercentage?: number;
  skillCoveragePercentage?: number | null;
  aiJudgmentPercentage?: number | null;
  matchSummary: string;
  matchReason?: string | null;
  strongMatches: string[];
  skillGaps: string[];
  candidateStatus?: string;
  scoringVersion?: string | null;
  aiModel?: string | null;
  scoreBreakdown?: any;
}

export interface JobItem {
  id: string;
  title: string;
  company: string;
  description: string;
  createdAt: string;
  lastUpdated: string;
  status: 'Active' | 'Screened' | 'Draft';
  attachedResumeIds: string[];
  matches?: Record<string, JobMatchResult>;
  isRanked: boolean;
}
