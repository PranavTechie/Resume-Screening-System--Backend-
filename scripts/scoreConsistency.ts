/**
 * Scoring consistency check (Phase 4 target: same resume + same JD, 3 runs, within ±5 points).
 * Calls Gemini directly (no credits, no DB writes) with the exact production scoring pipeline.
 * Still burns real Gemini quota (no mock mode here), so it's gated the same as the other scripts:
 *   CONFIRM_LIVE_TEST=yes npm run check:consistency            (RUNS=3 by default)
 */
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { geminiService } from '../src/services/ai/gemini.service';
import { blendMatchScore, computeExperienceFit, computeSkillCoverage, displaySkill, normalizeSkillList } from '../src/services/scoring.service';
import { SCORING_VERSION } from '../src/config/constants';
import { fakeResume, SAMPLE_JD } from './lib';

/** Same policy as the worker: retry transient Gemini errors with backoff. */
async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e: any) {
      if (i >= attempts || !e?.retryable) throw e;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

async function main() {
  const runs = Number(process.env.RUNS || 3);
  const samples = [fakeResume(4), fakeResume(9), fakeResume(11)];
  const title = 'Frontend Developer';
  const req = await retry(() => geminiService.extractJobRequirements(title, SAMPLE_JD));
  const requirements = { requiredSkills: normalizeSkillList(req.requiredSkills), niceToHaveSkills: normalizeSkillList(req.niceToHaveSkills), minYearsExperience: req.minYearsExperience };
  console.log(`scoring ${SCORING_VERSION}, model ${req.modelUsed}`);
  console.log(`JD required: ${requirements.requiredSkills.join(', ')} | nice: ${requirements.niceToHaveSkills.join(', ')} | min years: ${requirements.minYearsExperience}`);

  let worst = 0;
  for (const sample of samples) {
    const analysis = await retry(() => geminiService.analyzeResume(sample.text));
    const scores: number[] = [];
    const ats: number[] = [];
    for (let i = 0; i < runs; i++) {
      const a = i === 0 ? analysis : await retry(() => geminiService.analyzeResume(sample.text));
      ats.push(a.atsCompatibility);
      const coverage = computeSkillCoverage(requirements, a.detectedSkills, sample.text);
      const j = await retry(() => geminiService.judgeMatch({
        jobTitle: title,
        jobDescription: SAMPLE_JD,
        requiredSkills: requirements.requiredSkills.map(displaySkill),
        resumeText: sample.text,
        resumeSkills: a.detectedSkills,
      }));
      const exp = computeExperienceFit(requirements.minYearsExperience, j.candidateYearsExperience, j.experienceFit);
      scores.push(blendMatchScore({ skillCoverage: coverage.coverage, experienceFit: exp, aiJudgment: j.aiJudgment }).score);
    }
    const spread = Math.max(...scores) - Math.min(...scores);
    const atsSpread = Math.max(...ats) - Math.min(...ats);
    worst = Math.max(worst, spread / 2, atsSpread / 2);
    console.log(`${sample.name}: match ${scores.join(' / ')} (±${spread / 2}), ATS ${ats.join(' / ')} (±${atsSpread / 2})`);
  }
  const ok = worst <= 5;
  console.log(ok ? `PASS: worst deviation ±${worst}` : `FAIL: worst deviation ±${worst} (> ±5)`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('Consistency check crashed:', e.message);
  process.exit(1);
});
