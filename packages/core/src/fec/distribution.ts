import { Prng } from './prng.js';

export interface RobustSolitonConfig {
  /** Constant factor tuning the spike position (typical: 0.1 - 0.2) */
  readonly c: number;
  /** Allowed failure probability bound (typical: 0.05 - 0.5) */
  readonly delta: number;
}

export const DEFAULT_SOLITON_CONFIG: RobustSolitonConfig = {
  c: 0.1,
  delta: 0.05,
};

/**
 * Robust Soliton degree distribution for Luby Transform (LT) codes.
 *
 * Provides the probability distribution mu(d) over degrees d in [1, K]
 * such that the decoder ripple (number of degree-1 symbols available for peeling)
 * remains neither empty (stalling) nor excessively large (redundant work).
 */
export class RobustSolitonDistribution {
  readonly k: number;
  readonly c: number;
  readonly delta: number;
  private readonly cdf: Float64Array;

  constructor(k: number, config: RobustSolitonConfig = DEFAULT_SOLITON_CONFIG) {
    if (k < 1) {
      throw new RangeError(`Number of source symbols K (${k}) must be >= 1`);
    }
    this.k = k;
    this.c = config.c;
    this.delta = config.delta;

    this.cdf = new Float64Array(k);
    this.computeCdf();
  }

  private computeCdf(): void {
    if (this.k === 1) {
      this.cdf[0] = 1.0;
      return;
    }

    const k = this.k;
    const c = this.c;
    const delta = this.delta;

    // R = c * ln(K / delta) * sqrt(K)
    const R = c * Math.log(k / delta) * Math.sqrt(k);
    const pivot = Math.max(1, Math.min(k, Math.floor(k / R)));

    const pdf = new Float64Array(k);
    let sum = 0.0;

    for (let d = 1; d <= k; d++) {
      // 1. Ideal Soliton component rho(d)
      let rho: number;
      if (d === 1) {
        rho = 1.0 / k;
      } else {
        rho = 1.0 / (d * (d - 1));
      }

      // 2. Robust spike component tau(d)
      let tau = 0.0;
      if (d < pivot) {
        tau = R / (d * k);
      } else if (d === pivot) {
        tau = (R * Math.log(Math.max(1.0, R / delta))) / k;
      } else {
        tau = 0.0;
      }

      const mu = rho + tau;
      pdf[d - 1] = mu;
      sum += mu;
    }

    // Normalize to form valid probability distribution and compute CDF
    let cumulative = 0.0;
    for (let i = 0; i < k; i++) {
      const p = (pdf[i] ?? 0.0) / sum;
      cumulative += p;
      this.cdf[i] = cumulative;
    }
    // Ensure final element is exactly 1.0
    this.cdf[k - 1] = 1.0;
  }

  /**
   * Samples a degree d in [1, K] deterministically using the supplied PRNG.
   */
  sampleDegree(prng: Prng): number {
    if (this.k === 1) {
      return 1;
    }

    const u = prng.nextFloat();
    // Binary search in the cumulative distribution function
    let low = 0;
    let high = this.k - 1;

    while (low < high) {
      const mid = (low + high) >>> 1;
      const cdfVal = this.cdf[mid] ?? 1.0;
      if (u <= cdfVal) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    return low + 1;
  }

  /**
   * Deterministically selects `degree` distinct source symbol indices in [0, K-1]
   * without replacement, using the supplied PRNG.
   */
  sampleNeighbors(degree: number, prng: Prng): number[] {
    if (degree < 1 || degree > this.k) {
      throw new RangeError(`Degree (${degree}) must be between 1 and K (${this.k})`);
    }

    if (degree === this.k) {
      const all = new Array<number>(this.k);
      for (let i = 0; i < this.k; i++) all[i] = i;
      return all;
    }

    if (degree === 1) {
      return [prng.nextInt(0, this.k - 1)];
    }

    // Partial Fisher-Yates shuffle on indices [0, K-1]
    const pool = new Array<number>(this.k);
    for (let i = 0; i < this.k; i++) {
      pool[i] = i;
    }

    const neighbors: number[] = new Array<number>(degree);
    for (let i = 0; i < degree; i++) {
      const pickIndex = prng.nextInt(i, this.k - 1);
      const chosen = pool[pickIndex]!;
      pool[pickIndex] = pool[i]!;
      pool[i] = chosen;
      neighbors[i] = chosen;
    }

    // Sort neighbors for deterministic canonical ordering
    neighbors.sort((a, b) => a - b);
    return neighbors;
  }
}
