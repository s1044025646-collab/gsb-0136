import type { SubjectInput } from "./types.js";

// Injectable RNG so generated datasets are fully reproducible in tests/demos.
export interface Rng {
  next(): number; // uniform [0, 1)
}

export function mulberry32(seed: number): Rng {
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

// Exponential variate via inverse transform (constant hazard lifetime model).
function exponential(rng: Rng, rate: number): number {
  const u = Math.max(rng.next(), Number.EPSILON);
  return -Math.log(u) / rate;
}

export interface GeneratorConfig {
  perGroup: number;
  groups: { label: string; failureRate: number }[];
  censorRate: number; // independent administrative censoring hazard
  maxTime: number; // hard follow-up cutoff
  seed: number;
  idPrefix?: string;
}

/**
 * Generates anonymous synthetic PART lifetime records.
 * Independent single-event, no delayed entry (all specimens observed from 0).
 * Failure: exponential(failureRate). Censoring: min(exponential(censorRate),
 * maxTime). The smaller of the two clocks is observed; if censoring wins the
 * record is right-censored with a reason.
 */
export function generateParts(config: GeneratorConfig): SubjectInput[] {
  if (config.perGroup <= 0 || !Number.isInteger(config.perGroup)) {
    throw new Error("perGroup must be a positive integer");
  }
  if (config.groups.length < 1) throw new Error("at least one group required");
  const rng = mulberry32(config.seed);
  const prefix = config.idPrefix ?? "P";
  const out: SubjectInput[] = [];
  let seq = 0;

  for (const group of config.groups) {
    if (group.failureRate <= 0) throw new Error(`failureRate for ${group.label} must be > 0`);
    for (let i = 0; i < config.perGroup; i++) {
      seq += 1;
      const failureAt = exponential(rng, group.failureRate);
      const randomCensor = config.censorRate > 0 ? exponential(rng, config.censorRate) : Infinity;
      const adminCensor = config.maxTime;
      const censorAt = Math.min(randomCensor, adminCensor);
      const anonId = `${prefix}-${String(seq).padStart(4, "0")}`;
      if (failureAt <= censorAt) {
        out.push({ anonId, group: group.label, time: round(failureAt), status: "event" });
      } else {
        const reason = randomCensor < adminCensor ? "removed-from-service" : "study-end";
        out.push({
          anonId,
          group: group.label,
          time: round(censorAt),
          status: "censored",
          censorReason: reason,
        });
      }
    }
  }
  return out;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
