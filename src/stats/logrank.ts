import { AppError } from "../errors.js";
import type { LogrankResult, SubjectInput, TimeUnit } from "../types.js";
import { chiSquare1Survival } from "./distributions.js";

/**
 * Two-group log-rank test (Mantel-Haenszel), unstratified.
 *
 * At each distinct EVENT time t:
 *   n1, n2 = risk-set sizes; d1, d2 = events; n = n1+n2; d = d1+d2
 *   e1 = d * n1 / n
 *   variance term = n1*n2*d*(n-d) / (n^2 * (n-1))
 * Z = sum(d1 - e1); V = sum of variance terms; chi2 = Z^2 / V (df = 1).
 * Ties between groups at the same time are handled inside the 2x2 table.
 * Zero variance (no informative events) returns chi2 = null, not infinity.
 */
export function logrank(
  subjects: SubjectInput[],
  groupA: string,
  groupB: string,
  timeUnit: TimeUnit
): LogrankResult {
  if (groupA === groupB) {
    throw new AppError("VALIDATION_ERROR", "log-rank requires two distinct groups");
  }
  const a = subjects.filter((s) => s.group === groupA);
  const b = subjects.filter((s) => s.group === groupB);
  if (a.length === 0) throw new AppError("MISSING_GROUP", `no subjects in group '${groupA}'`);
  if (b.length === 0) throw new AppError("MISSING_GROUP", `no subjects in group '${groupB}'`);

  const eventTimesSet = new Set<number>();
  for (const s of subjects) {
    if ((s.group === groupA || s.group === groupB) && s.status === "event") {
      eventTimesSet.add(s.time);
    }
  }
  const eventTimes = [...eventTimesSet].sort((x, y) => x - y);

  let observedA = 0;
  let observedB = 0;
  let expectedA = 0;
  let expectedB = 0;
  let variance = 0;
  let z = 0;

  const table: LogrankResult["eventTimes"] = [];

  for (const t of eventTimes) {
    // Risk sets include every subject with observed time >= t (events and
    // censors at t are still at risk at t; censors leave after t).
    const nA = a.filter((s) => s.time >= t).length;
    const nB = b.filter((s) => s.time >= t).length;
    const dA = a.filter((s) => s.time === t && s.status === "event").length;
    const dB = b.filter((s) => s.time === t && s.status === "event").length;
    const n = nA + nB;
    const d = dA + dB;
    const eA = n === 0 ? 0 : (d * nA) / n;
    const eB = n === 0 ? 0 : (d * nB) / n;
    // Hypergeometric variance; zero when everyone at risk fails (d === n).
    const varianceTerm = n > 1 ? (nA * nB * d * (n - d)) / (n * n * (n - 1)) : 0;

    observedA += dA;
    observedB += dB;
    expectedA += eA;
    expectedB += eB;
    variance += varianceTerm;
    z += dA - eA;

    table.push({ t, nA, nB, dA, dB, eA, eB, varianceTerm });
  }

  const note =
    variance === 0
      ? "variance is zero (e.g. all observations censored or every risk set fails completely); chi-square and p-value are undefined"
      : "chi-square = (sum(O_A - E_A))^2 / V, compared with chi-square(1)";
  const chiSquare = variance === 0 ? null : round((z * z) / variance, 10);
  const pValue = chiSquare === null ? null : chiSquare1Survival(chiSquare);

  return {
    method:
      "Two-group unstratified log-rank (Mantel-Haenszel); event-time 2x2 tables; hypergeometric variance; ties across groups handled in-table",
    groupA,
    groupB,
    timeUnit,
    eventTimes: table,
    observedA,
    observedB,
    expectedA: round(expectedA, 10),
    expectedB: round(expectedB, 10),
    variance: round(variance, 10),
    chiSquare,
    degreesOfFreedom: 1,
    pValue: pValue === null ? null : round(pValue, 10),
    note,
  };
}

export function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
