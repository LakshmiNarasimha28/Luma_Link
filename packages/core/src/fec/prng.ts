/**
 * Deterministic 32-bit pseudo-random number generator for LumaLink.
 * Uses Mulberry32 algorithm: fast, high-quality statistical distribution,
 * fully deterministic, zero external dependencies.
 */
export class Prng {
  private state: number;

  constructor(seed: number) {
    // Force to 32-bit unsigned integer
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 0x6d2b79f5;
    }
  }

  /**
   * Generates a pseudo-random unsigned 32-bit integer in [0, 2^32 - 1].
   */
  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * Generates a floating point number in [0, 1).
   */
  nextFloat(): number {
    return this.nextUint32() / 4294967296.0;
  }

  /**
   * Generates an integer in [min, max] inclusive.
   */
  nextInt(min: number, max: number): number {
    if (min > max) {
      throw new RangeError(`min (${min}) cannot be greater than max (${max})`);
    }
    const range = max - min + 1;
    return min + Math.floor(this.nextFloat() * range);
  }

  /**
   * Returns a child PRNG branched deterministically from the current state.
   */
  fork(): Prng {
    return new Prng(this.nextUint32());
  }
}
