import { AppError } from '../errors.js';
import type { Observation } from './types.js';

export interface LogRankRow {
  time: number;
  n1: number;
  n2: number;
  d1: number;
  d2: number;
  e1: number;
  e2: number;
  varianceContribution: number;
}

export interface LogRankResult {
  group1: string;
  group2: string;
  n1: number;
  n2: number;
  events1: number;
  events2: number;
  observed1: number;
  expected1: number;
  observed2: number;
  expected2: number;
  variance: number;
  /** (O1 - E1)^2 / V; Infinity is never returned: zero variance throws. */
  chiSquare: number;
  pValue: number;
  rows: LogRankRow[];
}

/**
 * Two-group log-rank test (unstratified). At each distinct event time t,
 * with n1,n2 at risk (censors leave after the event step) and d total
 * events: E1 = d * n1/(n1+n2), hypergeometric variance
 * V = n1*n2*d*(n-d) / (n^2*(n-1)). Times with no events contribute nothing.
 */
export function logRank(rows: Observation[], group1: string, group2: string): LogRankResult {
  const g1 = rows.filter((r) => r.group === group1);
  const g2 = rows.filter((r) => r.group === group2);
  if (g1.length === 0 || g2.length === 0) {
    throw new AppError(
      'GROUP_MISSING',
      `both groups must exist: got ${g1.length} in "${group1}", ${g2.length} in "${group2}"`,
      { group1, group2, n1: g1.length, n2: g2.length },
    );
  }

  const times = [...new Set(rows.map((r) => r.time))].sort((a, b) => a - b);
  let n1 = g1.length;
  let n2 = g2.length;
  let o1 = 0;
  let o2 = 0;
  let e1Sum = 0;
  let e2Sum = 0;
  let variance = 0;
  const out: LogRankRow[] = [];

  const at = (g: Observation[], t: number, ev: boolean) =>
    g.reduce((s, r) => s + (r.time === t && r.event === ev ? 1 : 0), 0);

  for (const t of times) {
    const d1 = at(g1, t, true);
    const d2 = at(g2, t, true);
    const c1 = at(g1, t, false);
    const c2 = at(g2, t, false);
    const d = d1 + d2;
    const n = n1 + n2;

    if (d > 0) {
      const e1 = (d * n1) / n;
      const e2 = d - e1;
      let v = 0;
      if (n > 1) v = (n1 * n2 * d * (n - d)) / (n * n * (n - 1));
      o1 += d1;
      o2 += d2;
      e1Sum += e1;
      e2Sum += e2;
      variance += v;
      out.push({ time: t, n1, n2, d1, d2, e1, e2, varianceContribution: v });
    }
    n1 -= d1 + c1;
    n2 -= d2 + c2;
  }

  if (variance === 0) {
    throw new AppError(
      'ZERO_VARIANCE',
      'log-rank variance is zero (e.g. no events in a comparable risk set); the test is undefined',
      { observed1: o1, observed2: o2, expected1: e1Sum, expected2: e2Sum },
    );
  }

  const chi = ((o1 - e1Sum) * (o1 - e1Sum)) / variance;
  return {
    group1,
    group2,
    n1: g1.length,
    n2: g2.length,
    events1: o1,
    events2: o2,
    observed1: o1,
    expected1: e1Sum,
    observed2: o2,
    expected2: e2Sum,
    variance,
    chiSquare: chi,
    pValue: chiSquarePValue(chi),
    rows: out,
  };
}

/** Upper-tail probability P(Chi^2_1 >= x) = erfc(sqrt(x/2)). */
export function chiSquarePValue(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  return erfc(Math.sqrt(x / 2));
}

function erfc(x: number): number {
  // Abramowitz & Stegun 7.1.26 (Horner form), |error| < 1.5e-7.
  const t = 1 / (1 + 0.3275911 * x);
  // erf(x) ~ 1 - (a1 t + a2 t^2 + a3 t^3 + a4 t^4 + a5 t^5) exp(-x^2)
  const poly =
    0.254829592 * t -
    0.284496736 * t * t +
    1.421413741 * t ** 3 -
    1.453152027 * t ** 4 +
    1.061405429 * t ** 5;
  const erfApprox =
    1 - poly * Math.exp(-x * x);
  return 1 - erfApprox;
}
