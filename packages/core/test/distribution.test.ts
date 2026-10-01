import { describe, it, expect } from 'vitest';
import { Prng } from '../src/fec/prng.js';
import { RobustSolitonDistribution } from '../src/fec/distribution.js';

describe('Robust Soliton Degree Distribution & Neighbor Selection', () => {
  it('throws RangeError if K < 1', () => {
    expect(() => new RobustSolitonDistribution(0)).toThrow(RangeError);
  });

  it('guarantees degree is 1 when K = 1', () => {
    const dist = new RobustSolitonDistribution(1);
    const prng = new Prng(42);

    for (let i = 0; i < 20; i++) {
      expect(dist.sampleDegree(prng)).toBe(1);
      const neighbors = dist.sampleNeighbors(1, prng);
      expect(neighbors).toEqual([0]);
    }
  });

  it('samples degrees strictly within [1, K]', () => {
    const k = 64;
    const dist = new RobustSolitonDistribution(k);
    const prng = new Prng(123);

    for (let i = 0; i < 500; i++) {
      const d = dist.sampleDegree(prng);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(k);
    }
  });

  it('samples neighbors within valid bounds [0, K-1] with no duplicates', () => {
    const k = 32;
    const dist = new RobustSolitonDistribution(k);
    const prng = new Prng(456);

    for (let i = 0; i < 100; i++) {
      const degree = dist.sampleDegree(prng);
      const neighbors = dist.sampleNeighbors(degree, prng);

      expect(neighbors.length).toBe(degree);

      // Verify bounds
      for (const idx of neighbors) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(k);
      }

      // Verify uniqueness (no duplicate neighbors)
      const unique = new Set(neighbors);
      expect(unique.size).toBe(degree);
    }
  });

  it('returns all indices when degree equals K', () => {
    const k = 10;
    const dist = new RobustSolitonDistribution(k);
    const prng = new Prng(789);

    const neighbors = dist.sampleNeighbors(k, prng);
    expect(neighbors.length).toBe(k);
    expect(neighbors).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('is completely deterministic under the same seed', () => {
    const k = 50;
    const dist1 = new RobustSolitonDistribution(k);
    const dist2 = new RobustSolitonDistribution(k);

    const prng1 = new Prng(999);
    const prng2 = new Prng(999);

    for (let i = 0; i < 50; i++) {
      const d1 = dist1.sampleDegree(prng1);
      const d2 = dist2.sampleDegree(prng2);
      expect(d1).toBe(d2);

      const n1 = dist1.sampleNeighbors(d1, prng1);
      const n2 = dist2.sampleNeighbors(d2, prng2);
      expect(n1).toEqual(n2);
    }
  });

  it('throws RangeError when degree is out of bounds [1, K]', () => {
    const dist = new RobustSolitonDistribution(10);
    const prng = new Prng(1);

    expect(() => dist.sampleNeighbors(0, prng)).toThrow(RangeError);
    expect(() => dist.sampleNeighbors(11, prng)).toThrow(RangeError);
  });
});
