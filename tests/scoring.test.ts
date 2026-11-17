import { describe, expect, it } from 'vitest';
import {
  blendMatchScore,
  computeExperienceFit,
  computeSkillCoverage,
  normalizeSkill,
  normalizeSkillList,
  textMentionsSkill,
} from '../src/services/scoring.service';
import { MATCH_SCORE_WEIGHTS } from '../src/config/constants';

describe('skill normalization', () => {
  it.each([
    ['JS', 'javascript'],
    ['ReactJS', 'react'],
    ['React.js', 'react'],
    ['ML', 'machine learning'],
    ['NodeJS', 'node.js'],
    ['Postgres', 'postgresql'],
    ['  AWS ', 'amazon web services'],
    ['React (Hooks)', 'react'],
    ['k8s', 'kubernetes'],
    ['Tally ERP', 'tally erp'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeSkill(raw)).toBe(expected);
  });

  it('dedupes synonyms in a list', () => {
    expect(normalizeSkillList(['JS', 'JavaScript', 'javascript ', 'React', 'reactjs'])).toEqual(['javascript', 'react']);
  });

  it('finds skills in free text by whole word, ignoring ambiguous short aliases', () => {
    expect(textMentionsSkill('built apis with node.js and postgres', 'node.js')).toBe(true);
    expect(textMentionsSkill('worked with postgres daily', 'postgresql')).toBe(true);
    expect(textMentionsSkill('i like java and coffee', 'javascript')).toBe(false);
    expect(textMentionsSkill('graph node traversal', 'node.js')).toBe(false);
  });
});

describe('skill coverage', () => {
  it('weights required skills double', () => {
    const c = computeSkillCoverage({ requiredSkills: ['React', 'TypeScript'], niceToHaveSkills: ['GraphQL'] }, ['reactjs', 'graphql']);
    // got: react(2) + graphql(1) = 3 of 5
    expect(c.coverage).toBe(60);
    expect(c.matchedRequired).toEqual(['react']);
    expect(c.missingRequired).toEqual(['typescript']);
    expect(c.matchedNiceToHave).toEqual(['graphql']);
  });

  it('uses resume text as evidence too', () => {
    const c = computeSkillCoverage({ requiredSkills: ['SQL'], niceToHaveSkills: [] }, [], 'Wrote complex SQL reports');
    expect(c.coverage).toBe(100);
  });

  it('returns null coverage when the JD lists no skills', () => {
    expect(computeSkillCoverage({ requiredSkills: [], niceToHaveSkills: [] }, ['react']).coverage).toBeNull();
  });
});

describe('score blend', () => {
  it('uses the configured 50/20/30 weights', () => {
    expect(MATCH_SCORE_WEIGHTS).toEqual({ skillCoverage: 0.5, experienceFit: 0.2, aiJudgment: 0.3 });
    expect(blendMatchScore({ skillCoverage: 80, experienceFit: 50, aiJudgment: 70 }).score).toBe(Math.round(40 + 10 + 21));
  });

  it('moves the coverage weight to AI judgment when coverage is unknown', () => {
    const r = blendMatchScore({ skillCoverage: null, experienceFit: 100, aiJudgment: 60 });
    expect(r.weights.skillCoverage).toBe(0);
    expect(r.weights.aiJudgment).toBeCloseTo(0.8);
    expect(r.score).toBe(Math.round(20 + 48));
  });

  it('clamps to 0-100 and is deterministic', () => {
    const a = blendMatchScore({ skillCoverage: 150, experienceFit: -20, aiJudgment: 999 });
    expect(a.score).toBeLessThanOrEqual(100);
    expect(blendMatchScore({ skillCoverage: 33, experienceFit: 44, aiJudgment: 55 })).toEqual(
      blendMatchScore({ skillCoverage: 33, experienceFit: 44, aiJudgment: 55 })
    );
  });

  it('experience fit is deterministic when years are known', () => {
    expect(computeExperienceFit(4, 2, 90)).toBe(50);
    expect(computeExperienceFit(2, 5, 10)).toBe(100);
    expect(computeExperienceFit(null, 5, 72)).toBe(72);
  });
});
