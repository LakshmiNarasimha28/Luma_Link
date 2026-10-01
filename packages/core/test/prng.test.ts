import { describe, it, expect } from 'vitest';
import { Prng } from '../src/fec/prng.js';

describe('Deterministic PRNG (Mulberry32)', () => {
  it('produces identical sequences given identical seeds', () => {
    const prng1 = new Prng(42);
    const prng2 = new Prng(42);

    for (let i = 0; i < 100; i++) {
      expect(prng1.nextUint32()).toBe(prng2.nextUint32());
      expect(prng1.nextFloat()).toBe(prng2.nextFloat());
    }
  });

  it('produces distinct sequences given different seeds', () => {
    const prng1 = new Prng(100);
    const prng2 = new Prng(200);

    const seq1 = Array.from({ length: 10 }, () => prng1.nextUint32());
    const seq2 = Array.from({ length: 10 }, () => prng2.nextUint32());

    expect(seq1).not.toEqual(seq2);
  });

  it('generates floats strictly within [0, 1)', () => {
    const prng = new Prng(999);
    for (let i = 0; i < 500; i++) {
      const val = prng.nextFloat();
      expect(val).toBeGreaterThanOrEqual(0.0);
      expect(val).toBeLessThan(1.0);
    }
  });

  it('generates integers inclusively within [min, max]', () => {
    const prng = new Prng(12345);
    const min = 5;
    const max = 15;
    const counts = new Set<number>();

    for (let i = 0; i < 1000; i++) {
      const val = prng.nextInt(min, max);
      expect(val).toBeGreaterThanOrEqual(min);
      expect(val).toBeLessThanOrEqual(max);
      counts.add(val);
    }

    // All integers between 5 and 15 should be represented after 1000 trials
    expect(counts.size).toBe(max - min + 1);
  });

  it('throws RangeError when min > max in nextInt', () => {
    const prng = new Prng(1);
    expect(() => prng.nextInt(10, 5)).toThrow(RangeError);
  });

  it('forks into a deterministic child generator', () => {
    const parent1 = new Prng(777);
    const parent2 = new Prng(777);

    const child1 = parent1.fork();
    const child2 = parent2.fork();

    for (let i = 0; i < 50; i++) {
      expect(child1.nextUint32()).toBe(child2.nextUint32());
    }
  });
});
