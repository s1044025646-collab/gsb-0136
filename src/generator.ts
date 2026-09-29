import type { Observation } from './stats/types.js';

export interface Rng {
  next(): number;
}

/** Mulberry32: deterministic seeded PRNG so generated datasets are reproducible. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** Inverse-CDF sampling of an exponential lifetime with rate lambda. */
const expSample = (rng: Rng, lambda: number): number => -Math.log(1 - rng.next()) / lambda;

export interface GroupSpec {
  name: string;
  n: number;
  /** Event hazard (per time unit). */
  lambda: number;
  /** Probability a subject is right-censored before its event. */
  censorProbability?: number;
  /** Independent censoring hazard (exponential competing dropout). */
  censorLambda?: number;
  censorReason?: string;
}

export interface GeneratorOptions {
  seed: number;
  /** Decimal places for generated times (default 2). */
  precision?: number;
  /** Force a zero-time event into the first group (test fixture support). */
  includeZeroTimeEvent?: boolean;
}

/**
 * Generates independent single-event lifetimes with non-informative
 * administrative/exponential right censoring. No delayed entry.
 */
export function generateLifetimes(specs: GroupSpec[], opts: GeneratorOptions): Observation[] {
  const rng = seededRng(opts.seed);
  const precision = opts.precision ?? 2;
  const round = (x: number) => Math.round(x * 10 ** precision) / 10 ** precision;
  const rows: Observation[] = [];

  specs.forEach((spec, gi) => {
    const censorReasons = ['study-end administrative cutoff', 'lost to follow-up', 'part withdrawn from test rig'];
    for (let i = 1; i <= spec.n; i++) {
      let lifetime = expSample(rng, spec.lambda);
      let censoredAt: number | null = null;
      if (spec.censorLambda && spec.censorLambda > 0) {
        const c = expSample(rng, spec.censorLambda);
        if (c < lifetime) censoredAt = c;
      } else if (spec.censorProbability && rng.next() < spec.censorProbability) {
        censoredAt = round(lifetime * rng.next());
      }
      if (opts.includeZeroTimeEvent && gi === 0 && i === 1) {
        lifetime = 0;
        censoredAt = null;
      }
      if (censoredAt !== null) {
        rows.push({
          subjectId: `${spec.name}-S${String(i).padStart(3, '0')}`,
          group: spec.name,
          time: round(Math.max(0, censoredAt)),
          event: false,
          censorReason: spec.censorReason ?? censorReasons[Math.floor(rng.next() * censorReasons.length)],
        });
      } else {
        rows.push({
          subjectId: `${spec.name}-S${String(i).padStart(3, '0')}`,
          group: spec.name,
          time: round(Math.max(0, lifetime)),
          event: true,
        });
      }
    }
  });
  return rows;
}
