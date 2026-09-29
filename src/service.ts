import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import type { Clock } from './db.js';
import {
  getVersion,
  listRows,
  storeAnalysis,
  storeComparison,
  type StoredVersion,
} from './repo.js';
import { kaplanMeier, restrictedMean, type RMSTResult } from './stats/km.js';
import { logRank } from './stats/logrank.js';
import type { CiMethod } from './stats/types.js';

export interface CensorImpact {
  n: number;
  events: number;
  censored: number;
  censorRate: number;
  /** Largest t at which S is estimable from data. */
  maxObservedTime: number;
  /** True when the last observation(s) are censored: the curve tail is unobserved. */
  tailCensored: boolean;
  reasons: Array<{ reason: string; count: number }>;
  explanation: string[];
}

export function loadFrozen(db: DatabaseSync, versionId: number) {
  const meta: StoredVersion | null = getVersion(db, versionId);
  if (!meta) throw new AppError('NOT_FOUND', `frozen snapshot version ${versionId} not found`);
  const rows = listRows(db, versionId).map((r) => ({
    subjectId: r.subjectId,
    group: r.group,
    time: r.time,
    event: r.event,
    censorReason: r.censorReason ?? undefined,
  }));
  return { meta, rows };
}

export function analyzeGroup(
  db: DatabaseSync,
  versionId: number,
  group: string,
  opts: { ci?: CiMethod; tau?: number | null; persist?: boolean; clock?: Clock } = {},
) {
  const ci: CiMethod = opts.ci ?? 'log-log';
  if (ci !== 'log-log' && ci !== 'linear') {
    throw new AppError('VALIDATION', "ci must be 'log-log' or 'linear'");
  }
  const { meta, rows } = loadFrozen(db, versionId);
  const groupRows = rows.filter((r) => r.group === group);
  if (groupRows.length === 0) {
    throw new AppError('GROUP_MISSING', `group "${group}" not present in frozen snapshot`);
  }
  const km = kaplanMeier(groupRows, ci);
  if (km.events === 0) {
    throw new AppError(
      'ALL_CENSORED',
      `group "${group}" is entirely right-censored; the KM curve stays at 1 and median/RMST of events are not estimable`,
    );
  }
  let rmst: RMSTResult | null = null;
  if (opts.tau != null) rmst = restrictedMean(groupRows, opts.tau);

  const payload = {
    kind: 'km-analysis',
    frozenAt: { versionId, dataset: meta.name, version: meta.version, timeUnit: meta.timeUnit },
    method: {
      estimator: 'kaplan-meier product-limit',
      ties: 'events counted before censorings at the same time; censored subjects stay at risk at t and leave after the event step',
      variance: 'Greenwood',
      confidenceInterval: ci === 'log-log' ? 'log(-log S) transform, 95%' : 'linear Greenwood +/- 1.96 SE, 95%',
      delayedEntry: 'none (single origin)',
    },
    group,
    n: km.n,
    events: km.events,
    censored: km.censored,
    median:
      km.median === null
        ? { reached: false, value: null, note: 'curve never reaches S=0.5; maximum observed time is NOT a substitute' }
        : { reached: true, value: km.median },
    rmst,
    censorImpact: explainCensoring(groupRows),
    curve: km.points,
  };

  let stored: { analysisId: number; reportId: number; reused: boolean } | null = null;
  if (opts.persist !== false && opts.clock) {
    stored = storeAnalysis(db, versionId, group, ci, opts.tau ?? null, payload, opts.clock);
  }
  return { ...payload, stored };
}

export function compareGroups(
  db: DatabaseSync,
  versionId: number,
  group1: string,
  opts: { group2?: string; persist?: boolean; clock?: Clock } = {},
) {
  const { meta, rows } = loadFrozen(db, versionId);
  const groups = [...new Set(rows.map((r) => r.group))].sort();
  const group2 =
    opts.group2 ?? groups.find((g) => g !== group1) ?? (() => { throw new AppError('GROUP_MISSING', 'need two distinct groups'); })();
  if (group1 === group2) throw new AppError('VALIDATION', 'group1 and group2 must differ');
  const result = logRank(rows, group1, group2);

  const payload = {
    kind: 'log-rank-comparison',
    frozenAt: { versionId, dataset: meta.name, version: meta.version, timeUnit: meta.timeUnit },
    method: {
      test: 'two-group unstratified log-rank',
      ties: 'events before censorings at identical times',
      comparability: 'same frozen snapshot => same time unit and observation window',
    },
    groups: [group1, group2],
    chiSquare: result.chiSquare,
    degreesOfFreedom: 1,
    pValue: result.pValue,
    table: {
      group1: { group: group1, n: result.n1, observed: result.observed1, expected: result.expected1, events: result.events1 },
      group2: { group: group2, n: result.n2, observed: result.observed2, expected: result.expected2, events: result.events2 },
      variance: result.variance,
    },
    perEventTime: result.rows,
  };

  let stored: { comparisonId: number; reportId: number } | null = null;
  if (opts.persist !== false && opts.clock) {
    stored = storeComparison(db, versionId, group1, group2, payload, opts.clock);
  }
  return { ...payload, stored };
}

export function explainCensoring(
  rows: Array<{ time: number; event: boolean; censorReason?: string }>,
): CensorImpact {
  const events = rows.filter((r) => r.event).length;
  const censoredRows = rows.filter((r) => !r.event);
  const tMax = rows.reduce((m, r) => Math.max(m, r.time), 0);
  const tailCensored = censoredRows.some((r) => r.time === tMax);
  const reasonMap = new Map<string, number>();
  for (const r of censoredRows) {
    const reason = r.censorReason?.trim() || 'unspecified';
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
  }
  const reasons = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const explanation: string[] = [];
  explanation.push(
    `${censoredRows.length} of ${rows.length} observations are right-censored (${((censoredRows.length / rows.length) * 100).toFixed(1)}%); they contribute person-time up to censoring but are never counted as failures.`,
  );
  if (tailCensored) {
    explanation.push(
      `The latest observation at t=${tMax} is a censoring, so survival beyond that time is unobserved; the KM curve must not be extrapolated and the median may be unestimable.`,
    );
  }
  if (events === 0) {
    explanation.push('No events exist: the KM estimator is identically 1; no median survival time can be reported.');
  }
  if (censoredRows.length > 0) {
    explanation.push(
      'Censoring is assumed non-informative (independent of residual lifetime conditional on group). Heavy or late censoring widens Greenwood intervals and lowers power of the log-rank test.',
    );
  }
  return {
    n: rows.length,
    events,
    censored: censoredRows.length,
    censorRate: censoredRows.length / rows.length,
    maxObservedTime: tMax,
    tailCensored,
    reasons,
    explanation,
  };
}
