import { AppError } from '../errors.js';
import type { CiMethod, CurvePoint, KMSummary, Observation } from './types.js';

/**
 * Ties rule (public, consistent): when events and right censorings share a
 * time, events are counted first. Censored subjects are part of the risk set
 * at that time, and leave the risk set immediately after the event step.
 * Censorings are never counted as failures.
 */

interface TimeBucket {
  time: number;
  events: number;
  censored: number;
}

export const bucketize = (rows: Observation[]): TimeBucket[] => {
  const map = new Map<number, TimeBucket>();
  for (const r of rows) {
    let b = map.get(r.time);
    if (!b) {
      b = { time: r.time, events: 0, censored: 0 };
      map.set(r.time, b);
    }
    if (r.event) b.events += 1;
    else b.censored += 1;
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
};

const norm = (x: number): number => Math.min(1, Math.max(0, x));

export function kaplanMeier(rows: Observation[], ci: CiMethod = 'log-log'): KMSummary {
  if (rows.length === 0) throw new AppError('EMPTY_GROUP', 'group contains no observations');

  const buckets = bucketize(rows);
  let atRisk = rows.length;
  let survival = 1;
  let greenwood = 0;

  const points: CurvePoint[] = [];
  for (const b of buckets) {
    let variance = greenwood;
    let se = Math.sqrt(Math.max(0, variance)) * survival;
    if (b.events > 0) {
      // Greenwood increment: d / (n * (n - d)); requires n - d > 0.
      if (atRisk - b.events <= 0) {
        // Everyone still at risk experiences the event: curve reaches zero and
        // the Greenwood variance is undefined beyond this point.
        survival = 0;
        greenwood = Infinity;
        variance = Infinity;
        se = Infinity;
      } else {
        survival *= (atRisk - b.events) / atRisk;
        greenwood += b.events / (atRisk * (atRisk - b.events));
        variance = greenwood;
        se = Math.sqrt(greenwood) * survival;
      }
    }

    let lower: number;
    let upper: number;
    if (!Number.isFinite(se)) {
      lower = 0;
      upper = b.events > 0 && survival === 0 ? 0 : norm(survival);
    } else if (ci === 'linear') {
      lower = norm(survival - 1.96 * se);
      upper = norm(survival + 1.96 * se);
    } else {
      // Expressed on the cumulative-hazard scale H = -log S with SE derived
      // from Greenwood: SE(H) = SE(S) / S. Transform back via S^exp(±...).
      if (survival <= 0) {
        lower = 0;
        upper = 0;
      } else {
        const z = 1.96 * Math.sqrt(Math.max(0, variance)) / Math.max(1e-12, -Math.log(survival));
        lower = norm(survival ** Math.exp(z));
        upper = norm(survival ** Math.exp(-z));
      }
    }

    points.push({
      time: b.time,
      atRisk,
      events: b.events,
      censored: b.censored,
      survival,
      variance,
      se: Number.isFinite(se) ? se : Infinity,
      ciLower: lower,
      ciUpper: upper,
    });
    atRisk -= b.events + b.censored;
  }

  const totalEvents = buckets.reduce((s, b) => s + b.events, 0);
  const totalCensored = buckets.reduce((s, b) => s + b.censored, 0);

  // Median: smallest event time at which S(t) <= 0.5. If the curve never
  // falls to/below 0.5 the median is NOT reached (never substitute max time).
  const hit = points.find((p) => p.events > 0 && p.survival <= 0.5);
  const median = hit ? hit.time : null;

  return { n: rows.length, events: totalEvents, censored: totalCensored, median, points };
}

export interface RMSTResult {
  tau: number;
  /** Area under the KM step curve on [0, tau]. */
  rmst: number;
  /** Life-years (time units) lost vs an immortal curve at S=1. */
  lost: number;
}

/**
 * Restricted mean survival time up to tau. S is right-continuous step
 * constant: S(t)=S(t_{i-1}) on [t_{i-1}, t_i); censoring-only times do not
 * change S but are explicit interval boundaries.
 */
export function restrictedMean(rows: Observation[], tau: number): RMSTResult {
  if (!Number.isFinite(tau) || tau < 0) throw new AppError('VALIDATION', 'tau must be finite and >= 0');
  const buckets = bucketize(rows);
  const tMax = buckets.length ? buckets[buckets.length - 1]!.time : 0;
  if (tau > tMax + 1e-9) {
    throw new AppError(
      'TAU_TOO_LARGE',
      `tau ${tau} exceeds the largest observed time ${tMax}; the survival curve is not estimable beyond it`,
      { tau, tMax },
    );
  }

  let area = 0;
  let prev = 0;
  let s = 1;
  let atRisk = rows.length;
  for (const b of buckets) {
    if (b.time >= tau) break;
    area += s * (b.time - prev);
    prev = b.time;
    if (b.events > 0) {
      if (atRisk - b.events <= 0) s = 0;
      else s *= (atRisk - b.events) / atRisk;
    }
    atRisk -= b.events + b.censored;
  }
  area += s * (tau - prev);
  return { tau, rmst: area, lost: tau - area };
}
