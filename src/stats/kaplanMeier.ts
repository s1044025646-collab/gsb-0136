import { AppError } from "../errors.js";
import type { CurvePoint, CurveResult, SubjectInput, TimeUnit } from "../types.js";
import { normalCdf } from "./distributions.js";

export type CiMethod = "loglog" | "linear";

export interface CurveParams {
  group: string;
  timeUnit: TimeUnit;
  ciMethod: CiMethod;
  confidenceLevel: number; // e.g. 0.95
  horizon: number | null; // RMST truncation time; null = min(max event/censor time)
}

interface DistinctTime {
  t: number;
  events: number;
  censors: number;
}

/**
 * Kaplan-Meier product-limit estimator.
 *
 * Tie rule (documented, consistent with the standard KM convention):
 * at a time t where both failures and right-censoring occur, failures are
 * counted first. Every observation with time == t is in the risk set n(t);
 * S jumps by (n(t) - d(t)) / n(t), and the c(t) censored units leave the
 * risk set immediately afterwards. Censoring never multiplies the curve.
 *
 * Greenwood variance: V(S(t)) = S(t)^2 * sum d_j / (n_j (n_j - d_j)) over
 * event times up to t.
 */
export function kaplanMeier(subjects: SubjectInput[], params: CurveParams): CurveResult {
  const groupSubjects = subjects.filter((s) => s.group === params.group);
  const n = groupSubjects.length;
  if (n === 0) {
    throw new AppError("MISSING_GROUP", `no subjects in group '${params.group}'`);
  }
  if (
    typeof params.confidenceLevel !== "number" ||
    params.confidenceLevel <= 0 ||
    params.confidenceLevel >= 1
  ) {
    throw new AppError("VALIDATION_ERROR", "confidenceLevel must be between 0 and 1");
  }
  const z = inverseNormal((1 + params.confidenceLevel) / 2);

  const eventCount = groupSubjects.filter((s) => s.status === "event").length;
  const censorCount = n - eventCount;

  const timeMap = new Map<number, DistinctTime>();
  for (const s of groupSubjects) {
    let entry = timeMap.get(s.time);
    if (!entry) {
      entry = { t: s.time, events: 0, censors: 0 };
      timeMap.set(s.time, entry);
    }
    if (s.status === "event") entry.events += 1;
    else entry.censors += 1;
  }
  const distinct = [...timeMap.values()].sort((a, b) => a.t - b.t);

  let atRisk = n;
  let survival = 1;
  let greenwoodSum = 0;
  const points: CurvePoint[] = [];

  for (const { t, events, censors } of distinct) {
    const sBefore = survival;
    const nRisk = atRisk;
    let sAfter = survival;
    let variance = survival * survival * greenwoodSum;
    if (events > 0) {
      const factor = (nRisk - events) / nRisk;
      sAfter = survival * factor;
      // Greenwood increment; when nRisk == events the last term is undefined
      // (curve reaches zero) and contributes no finite increment.
      if (nRisk > events) {
        greenwoodSum += events / (nRisk * (nRisk - events));
      }
      variance = sAfter * sAfter * greenwoodSum;
      survival = sAfter;
    }
    points.push({
      t,
      nAtRisk: nRisk,
      dEvents: events,
      cCensored: censors,
      sBefore,
      sAfter,
      variance,
      ciLower: ciBound(sAfter, variance, z, params.ciMethod, "lower"),
      ciUpper: ciBound(sAfter, variance, z, params.ciMethod, "upper"),
    });
    atRisk -= events + censors;
  }

  const maxObserved = distinct.length > 0 ? distinct[distinct.length - 1]!.t : 0;
  const horizon = params.horizon ?? maxObserved;
  if (!(horizon >= 0) || !Number.isFinite(horizon)) {
    throw new AppError("VALIDATION_ERROR", "RMST horizon must be a finite number >= 0");
  }

  // Median: smallest event time at which S(t) <= 0.5. If the curve never
  // reaches 0.5 the median is NOT reached; max observation time is not used.
  const crossing = points.find((p) => p.dEvents > 0 && p.sAfter <= 0.5);
  const medianSurvival = crossing ? crossing.t : null;

  // RMST: stepwise integral of S over [0, horizon]. After the last observed
  // time S stays at its last value (standard KM tail assumption).
  let area = 0;
  let currentS = 1;
  let prevT = 0;
  for (const p of points) {
    if (p.t >= horizon) break;
    area += currentS * (p.t - prevT);
    currentS = p.sAfter;
    prevT = p.t;
  }
  area += currentS * (horizon - prevT);

  return {
    group: params.group,
    timeUnit: params.timeUnit,
    method: `Kaplan-Meier product-limit; ties: events counted before censoring at the same time; Greenwood variance; ${params.ciMethod} ${Math.round(params.confidenceLevel * 100)}% CI`,
    points,
    medianSurvival,
    medianNote: medianSurvival === null
      ? "median survival not reached: the KM curve never dropped to 0.5 within observed time"
      : `smallest event time at which S(t) <= 0.5`,
    rmst: area,
    rmstHorizon: horizon,
    rmstNote:
      horizon > maxObserved
        ? `horizon ${horizon} exceeds last observed time ${maxObserved}; S held flat after last observation`
        : `integrated KM step function over [0, ${horizon}]`,
    n,
    events: eventCount,
    censored: censorCount,
  };
}

function ciBound(
  s: number,
  variance: number,
  z: number,
  method: CiMethod,
  side: "lower" | "upper"
): number {
  const se = Math.sqrt(Math.max(0, variance));
  if (method === "linear") {
    const value = side === "lower" ? s - z * se : s + z * se;
    return clamp01(value);
  }
  // Log-log ("log(-log)") transform, Kalbfleisch & Prentice.
  if (s <= 0 || s >= 1 || variance === 0) return s;
  const logS = Math.log(s);
  const sigma = Math.sqrt(variance) / (s * Math.abs(logS));
  const transformed = Math.log(-logS) + (side === "lower" ? z * sigma : -z * sigma);
  const value = Math.exp(-Math.exp(transformed));
  return clamp01(value);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// Inverse standard normal CDF (Acklam approximation).
function inverseNormal(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -0.3223964580411365, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 0.3224671290700398, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    );
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

export { normalCdf };
