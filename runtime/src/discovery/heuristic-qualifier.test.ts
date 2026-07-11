// Tests for the offline heuristic qualifier. The score is a logistic of a
// weighted log-odds sum, so these assert bands (high / low / neutral) and the
// presence of the right reason strings rather than exact numbers.

import { describe, expect, it } from 'vitest';
import { HeuristicQualifier } from './heuristic-qualifier.js';
import type { Candidate, Icp } from './types.js';

const qualifier = new HeuristicQualifier();

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    entityUrn: 'urn:li:fsd_profile:P1',
    profileUrl: 'https://www.linkedin.com/in/p1/',
    headline: 'Director of Field Operations',
    currentCompany: 'Meridian',
    location: 'United States',
    degree: '2nd',
    ...over,
  };
}

describe('HeuristicQualifier', () => {
  it('scores a strong attribute match high', async () => {
    const icp: Icp = {
      name: 'Ops leaders',
      query: {},
      attributes: [
        { field: 'title', match: ['director', 'head', 'vp'], weight: 2 },
        { field: 'location', match: ['united states', 'canada'] },
      ],
    };
    const res = await qualifier.score(candidate(), icp);
    expect(res.score).toBeGreaterThan(70);
    expect(res.model).toBe('heuristic-v1');
    expect(res.reasons.some((r) => r.includes('title matches "director"'))).toBe(true);
  });

  it('sinks a candidate that trips a negative attribute', async () => {
    const icp: Icp = {
      name: 'Ops leaders, not agencies',
      query: {},
      attributes: [
        { field: 'title', match: ['director'] },
        { field: 'company', match: ['staffing agency'], negative: true },
      ],
    };
    const res = await qualifier.score(
      candidate({ currentCompany: 'Globex Staffing Agency' }),
      icp,
    );
    expect(res.score).toBeLessThan(30);
    expect(res.reasons.some((r) => r.startsWith('disqualifier'))).toBe(true);
  });

  it('misses drag the score below an even prior', async () => {
    const icp: Icp = {
      name: 'CFOs',
      query: {},
      attributes: [{ field: 'title', match: ['chief financial officer', 'cfo'], weight: 2 }],
    };
    const res = await qualifier.score(candidate(), icp); // headline is an ops title
    expect(res.score).toBeLessThan(50);
  });

  it('returns a neutral 50 when the ICP has no criteria', async () => {
    const res = await qualifier.score(candidate(), { name: 'empty', query: {} });
    expect(res.score).toBe(50);
    expect(res.reasons[0]).toMatch(/no ICP criteria/i);
  });

  it('uses description-term overlap when there are no structured attributes', async () => {
    const icp: Icp = {
      name: 'Field service leaders',
      query: {},
      description: 'senior field service operations leader at an equipment operator',
    };
    const hit = await qualifier.score(
      candidate({ headline: 'VP Field Service Operations' }),
      icp,
    );
    const miss = await qualifier.score(
      candidate({ headline: 'Elementary School Teacher', currentCompany: 'PS 118', location: 'United States' }),
      icp,
    );
    expect(hit.score).toBeGreaterThan(miss.score);
    expect(hit.reasons.some((r) => r.startsWith('ICP terms'))).toBe(true);
  });

  it('is deterministic: same input, same score', async () => {
    const icp: Icp = { name: 'x', query: {}, attributes: [{ field: 'title', match: ['director'] }] };
    const a = await qualifier.score(candidate(), icp);
    const b = await qualifier.score(candidate(), icp);
    expect(a.score).toBe(b.score);
  });
});
