import { describe, expect, it } from 'vitest';
import { ICP_FIT_THRESHOLD, readIcpScore } from './icp.js';

describe('readIcpScore', () => {
  it('reads a full score envelope and flags below-threshold', () => {
    const view = readIcpScore({
      score: 30,
      scoreModel: 'heuristic-v1',
      scoreReasons: ['no title match'],
      icp: 'Ops leaders',
      name: 'Someone',
    });
    expect(view).toEqual({
      score: 30,
      scoreModel: 'heuristic-v1',
      scoreReasons: ['no title match'],
      icp: 'Ops leaders',
      offIcp: true,
    });
  });

  it('does not flag an on-ICP score', () => {
    expect(readIcpScore({ score: ICP_FIT_THRESHOLD }).offIcp).toBe(false);
    expect(readIcpScore({ score: 90 }).offIcp).toBe(false);
  });

  it('treats an unscored member as score=null, offIcp=false', () => {
    for (const blob of [undefined, null, {}, { name: 'x' }, 'garbage', 42]) {
      const view = readIcpScore(blob);
      expect(view.score).toBeNull();
      expect(view.offIcp).toBe(false);
    }
  });

  it('honors a custom threshold', () => {
    expect(readIcpScore({ score: 60 }, 70).offIcp).toBe(true);
    expect(readIcpScore({ score: 60 }, 50).offIcp).toBe(false);
  });
});
