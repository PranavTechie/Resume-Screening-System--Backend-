/**
 * Deterministic, explainable match scoring (Phase 4).
 *
 * final = 50% skill coverage (computed here, in code)
 *       + 20% experience fit
 *       + 30% AI judgment (Gemini, temperature 0, fixed rubric)
 *
 * Weights live in config/constants.ts (MATCH_SCORE_WEIGHTS). Bump SCORING_VERSION when they change.
 */
import {
  MATCH_SCORE_WEIGHTS,
  NICE_TO_HAVE_SKILL_WEIGHT,
  REQUIRED_SKILL_WEIGHT,
} from '../config/constants';

// Canonical name <- aliases. Keys and values are already lower-case.
const SYNONYMS: Record<string, string[]> = {
  javascript: ['js', 'java script', 'ecmascript', 'es6', 'es2015', 'vanilla js', 'vanilla javascript'],
  typescript: ['ts'],
  react: ['reactjs', 'react.js', 'react js'],
  'react native': ['react-native', 'reactnative'],
  'node.js': ['node', 'nodejs', 'node js'],
  'express.js': ['express', 'expressjs'],
  'next.js': ['next', 'nextjs', 'next js'],
  'vue.js': ['vue', 'vuejs'],
  angular: ['angularjs', 'angular.js', 'angular js'],
  'machine learning': ['ml'],
  'deep learning': ['dl'],
  'artificial intelligence': ['ai'],
  'natural language processing': ['nlp'],
  'computer vision': ['cv vision', 'opencv vision'],
  'large language models': ['llm', 'llms'],
  'generative ai': ['genai', 'gen ai'],
  python: ['python3', 'py'],
  golang: ['go', 'go lang'],
  'c++': ['cpp', 'c plus plus'],
  'c#': ['csharp', 'c sharp'],
  '.net': ['dotnet', 'dot net', 'asp.net', '.net core'],
  postgresql: ['postgres', 'psql', 'postgre sql'],
  mysql: ['my sql'],
  mongodb: ['mongo', 'mongo db'],
  sql: ['structured query language'],
  nosql: ['no sql', 'no-sql'],
  'amazon web services': ['aws'],
  'google cloud platform': ['gcp', 'google cloud'],
  'microsoft azure': ['azure'],
  kubernetes: ['k8s'],
  docker: ['containerization'],
  'ci/cd': ['cicd', 'ci cd', 'continuous integration', 'continuous delivery', 'continuous deployment'],
  git: ['github', 'gitlab', 'version control'],
  html: ['html5'],
  css: ['css3'],
  'tailwind css': ['tailwind', 'tailwindcss'],
  'rest api': ['rest', 'restful', 'rest apis', 'restful api', 'restful apis'],
  graphql: ['graph ql'],
  tensorflow: ['tf', 'tensor flow'],
  pytorch: ['torch', 'py torch'],
  'scikit-learn': ['sklearn', 'scikit learn'],
  pandas: [],
  numpy: [],
  'power bi': ['powerbi'],
  excel: ['ms excel', 'microsoft excel', 'advanced excel'],
  'data analysis': ['data analytics'],
  'data structures and algorithms': ['dsa', 'data structures', 'algorithms'],
  'object oriented programming': ['oop', 'oops'],
  linux: ['unix'],
  'spring boot': ['springboot', 'spring framework'],
  django: [],
  flask: [],
  fastapi: ['fast api'],
  redux: ['redux toolkit', 'rtk'],
  figma: [],
  'ui/ux': ['ui ux', 'ux', 'ui design', 'ux design', 'user experience'],
  communication: ['communication skills', 'verbal communication', 'written communication'],
  'problem solving': ['problem-solving', 'analytical skills'],
};

const ALIAS_TO_CANONICAL: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(SYNONYMS)) {
    map.set(canonical, canonical);
    for (const a of aliases) map.set(a, canonical);
  }
  return map;
})();

/** Lower-case, trim, collapse whitespace, strip decoration, then map synonyms to one canonical name. */
export function normalizeSkill(raw: string): string {
  let s = String(raw || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ') // "React (Hooks)" -> "react"
    .replace(/[“”"'`]/g, '')
    .replace(/[_]/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-•*·,.;:]+|[-•*·,;:]+$/g, '')
    .trim();
  if (!s) return '';
  const direct = ALIAS_TO_CANONICAL.get(s);
  if (direct) return direct;
  // "reactjs developer" style suffixes
  const stripped = s.replace(/\s+(framework|library|language|programming|development|developer|skills?)$/, '').trim();
  return ALIAS_TO_CANONICAL.get(stripped) || stripped;
}

export function normalizeSkillList(list: string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const item of list || []) {
    const n = normalizeSkill(item);
    if (n) out.add(n);
  }
  return Array.from(out);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const AMBIGUOUS_TEXT_ALIASES = new Set(['node', 'next', 'express', 'rest', 'torch', 'spring', 'version control', 'analytical skills']);

/** All surface forms (canonical + aliases) used to find a skill in raw resume text. */
function surfaceForms(canonical: string): string[] {
  const forms = new Set<string>([canonical]);
  for (const [alias, canon] of ALIAS_TO_CANONICAL.entries()) {
    // Very short / everyday-word aliases are too ambiguous for free-text search.
    if (canon === canonical && alias.length >= 3 && !AMBIGUOUS_TEXT_ALIASES.has(alias)) forms.add(alias);
  }
  return Array.from(forms);
}

/** Whole-word search for a skill (or any alias) in resume text. */
export function textMentionsSkill(textLower: string, canonical: string): boolean {
  for (const form of surfaceForms(canonical)) {
    const re = new RegExp(`(^|[^a-z0-9+#.])${escapeRegExp(form)}($|[^a-z0-9+#])`, 'i');
    if (re.test(textLower)) return true;
  }
  return false;
}

export interface JobRequirements {
  requiredSkills: string[];
  niceToHaveSkills: string[];
  minYearsExperience: number | null;
}

export interface SkillCoverage {
  /** 0-100, or null when the JD lists no skills at all. */
  coverage: number | null;
  matchedRequired: string[];
  missingRequired: string[];
  matchedNiceToHave: string[];
  missingNiceToHave: string[];
}

export function computeSkillCoverage(
  requirements: Pick<JobRequirements, 'requiredSkills' | 'niceToHaveSkills'>,
  resumeSkills: string[],
  resumeText: string = ''
): SkillCoverage {
  const required = normalizeSkillList(requirements.requiredSkills);
  const nice = normalizeSkillList(requirements.niceToHaveSkills).filter((s) => !required.includes(s));
  const have = new Set(normalizeSkillList(resumeSkills));
  const textLower = (resumeText || '').toLowerCase();

  const has = (skill: string) => have.has(skill) || (textLower.length > 0 && textMentionsSkill(textLower, skill));

  const matchedRequired = required.filter(has);
  const missingRequired = required.filter((s) => !has(s));
  const matchedNiceToHave = nice.filter(has);
  const missingNiceToHave = nice.filter((s) => !has(s));

  const totalWeight = required.length * REQUIRED_SKILL_WEIGHT + nice.length * NICE_TO_HAVE_SKILL_WEIGHT;
  const gotWeight = matchedRequired.length * REQUIRED_SKILL_WEIGHT + matchedNiceToHave.length * NICE_TO_HAVE_SKILL_WEIGHT;
  const coverage = totalWeight === 0 ? null : Math.round((gotWeight / totalWeight) * 100);

  return { coverage, matchedRequired, missingRequired, matchedNiceToHave, missingNiceToHave };
}

/**
 * Experience fit. Deterministic when both the JD minimum and the candidate's years are known,
 * otherwise falls back to the AI's experience estimate.
 */
export function computeExperienceFit(
  minYears: number | null | undefined,
  candidateYears: number | null | undefined,
  aiExperienceFit: number | null | undefined
): number {
  const ai = clampScore(aiExperienceFit ?? 50);
  if (typeof minYears !== 'number' || !Number.isFinite(minYears) || minYears <= 0) return ai;
  if (typeof candidateYears !== 'number' || !Number.isFinite(candidateYears) || candidateYears < 0) return ai;
  if (candidateYears >= minYears) return 100;
  return clampScore((candidateYears / minYears) * 100);
}

export function clampScore(n: number | null | undefined): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

export interface BlendInput {
  skillCoverage: number | null;
  experienceFit: number;
  aiJudgment: number;
}

export interface BlendResult {
  score: number;
  weights: { skillCoverage: number; experienceFit: number; aiJudgment: number };
}

/** Weighted blend. When the JD has no extractable skills, the coverage weight moves to AI judgment. */
export function blendMatchScore(input: BlendInput): BlendResult {
  const w: { skillCoverage: number; experienceFit: number; aiJudgment: number } = { ...MATCH_SCORE_WEIGHTS };
  if (input.skillCoverage === null) {
    w.aiJudgment = w.aiJudgment + w.skillCoverage;
    w.skillCoverage = 0;
  }
  const score =
    (input.skillCoverage ?? 0) * w.skillCoverage +
    clampScore(input.experienceFit) * w.experienceFit +
    clampScore(input.aiJudgment) * w.aiJudgment;
  return { score: clampScore(score), weights: w };
}

/** Title-case canonical skills for display ("node.js" -> "Node.js", "sql" -> "SQL"). */
export function displaySkill(canonical: string): string {
  const upper = new Set(['sql', 'html', 'css', 'aws', 'gcp', 'nlp', 'llm', 'ci/cd', 'ui/ux', 'rest api', 'c++', 'c#', 'php', 'api']);
  if (upper.has(canonical)) return canonical.toUpperCase();
  return canonical
    .split(' ')
    .map((w) => (w.length <= 2 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
