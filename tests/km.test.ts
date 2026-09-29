import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kaplanMeier, restrictedMean } from '../src/stats/km.ts';
import { logRank, chiSquarePValue } from '../src/stats/logrank.ts';
import { AppError } from '../src/errors.ts';
import type { Observation } from '../src/stats/types.ts';

const throwsCode = (fn: () => unknown, code: string) => {
  assert.throws(fn, (err: unknown) => err instanceof AppError && err.code === code);
};

const obs = (rows: Array<[number, boolean, string?]>): Observation[] =>
  rows.map(([time, event, censorReason], i) => ({
    subjectId: `s${i}`,
    group: 'A',
    time,
    event,
    censorReason: event ? undefined : (censorReason ?? 'c'),
  }));

test('KM hand calculation: no censoring', () => {
  // 6 units, event times 1,1,2,3,4,5
  const r = kaplanMeier(obs([[1, true], [1, true], [2, true], [3, true], [4, true], [5, true]]), 'linear');
  // S: 4/6, 3/6, 2/6, 1/6, 0
  assert.deepEqual(
    r.points.filter((p) => p.events > 0).map((p) => p.survival),
    [4 / 6, 3 / 6, 2 / 6, 1 / 6, 0],
  );
  assert.equal(r.median, 2); // first t with S <= 0.5
});

test('KM hand calculation: tied event and censoring at t=3', () => {
  // classic example: events at 1; t=3 one event + one censor among 4 at risk
  const r = kaplanMeier(obs([[1, true], [3, true], [3, false], [5, false]]), 'linear');
  // t=1: S = 3/4 = 0.75. t=3: n=3,d=1 => S = 0.75 * 2/3 = 0.5
  assert.ok(Math.abs(r.points[0]!.survival - 0.75) < 1e-12);
  assert.ok(Math.abs(r.points[1]!.survival - 0.5) < 1e-12);
  assert.equal(r.points[1]!.atRisk, 3); // censored subject still at risk at t=3
  assert.equal(r.points[1]!.events, 1);
  assert.equal(r.points[1]!.censored, 1);
  // t=5 censoring-only: S stays 0.5, median = 3 (not 5)
  assert.equal(r.points[2]!.survival, 0.5);
  assert.equal(r.median, 3);
});

test('Greenwood variance hand calculation', () => {
  const r = kaplanMeier(obs([[1, true], [3, true], [3, false], [5, false]]));
  // G = 1/(4*3) + 1/(3*2) = 1/12 + 1/6 = 0.25 at t=3
  assert.ok(Math.abs(r.points[1]!.variance - 0.25) < 1e-12);
  // SE(S) = S * sqrt(G) = 0.5 * 0.5 = 0.25
  assert.ok(Math.abs(r.points[1]!.se - 0.25) < 1e-12);
});

test('zero-time event is handled', () => {
  const r = kaplanMeier(obs([[0, true], [2, true], [5, false]]));
  assert.equal(r.points[0]!.time, 0);
  assert.ok(Math.abs(r.points[0]!.survival - 2 / 3) < 1e-12);
  assert.equal(r.points[0]!.atRisk, 3);
});

test('all-censored: curve stays 1 and median is null', () => {
  const r = kaplanMeier(obs([[1, false], [4, false], [9, false]]));
  assert.equal(r.events, 0);
  assert.equal(r.median, null);
  assert.ok(r.points.every((p) => p.survival === 1));
});

test('median not reached is not replaced by max observed time', () => {
  // 10 units, one early event then all censored: S = 0.9 > 0.5
  const rows: Array<[number, boolean]> = [[2, true]];
  for (let i = 0; i < 9; i++) rows.push([10 + i, false]);
  const r = kaplanMeier(obs(rows));
  assert.equal(r.median, null);
});

test('RMST area hand calculation', () => {
  // S=1 on [0,1), 0.75 on [1,3), 0.5 on [3,5]; tau=5
  const r = restrictedMean(obs([[1, true], [3, true], [3, false], [5, false]]), 5);
  const expected = 1 * 1 + 0.75 * 2 + 0.5 * 2;
  assert.ok(Math.abs(r.rmst - expected) < 1e-12);
  assert.ok(Math.abs(r.lost - (5 - expected)) < 1e-12);
});

test('RMST rejects tau beyond largest observed time', () => {
  throwsCode(() => restrictedMean(obs([[1, true]]), 5), 'TAU_TOO_LARGE');
});

test('risk set decreases monotonically', () => {
  const r = kaplanMeier(obs([[1, true], [1, false], [2, true], [4, false], [6, true]]));
  const n = r.points.map((p) => p.atRisk);
  for (let i = 1; i < n.length; i++) assert.ok(n[i]! < n[i - 1]!);
});

test('log-rank hand calculation', () => {
  const g = (group: string, rows: Array<[number, boolean]>): Observation[] =>
    rows.map(([time, event], i) => ({ subjectId: `${group}${i}`, group, time, event }));
  const rows = [
    ...g('A', [[1, true], [4, true], [5, false]]),
    ...g('B', [[2, true], [3, true], [6, true]]),
  ];
  const r = logRank(rows, 'A', 'B');
  // t=1: n1=3,n2=3,d1=1; E1=0.5,V= 3*3*1*5/(36*5)=0.25
  const row1 = r.rows.find((x) => x.time === 1)!;
  assert.ok(Math.abs(row1.e1 - 0.5) < 1e-12);
  assert.ok(Math.abs(row1.varianceContribution - 0.25) < 1e-12);
  assert.equal(r.observed1, 2);
  assert.ok(Math.abs(r.observed1 + r.observed2 - (r.expected1 + r.expected2)) < 1e-12);
  assert.ok(r.chiSquare >= 0);
  assert.ok(r.pValue > 0 && r.pValue <= 1);
});

test('log-rank zero variance (no events) throws ZERO_VARIANCE', () => {
  const g = (group: string, t: number): Observation[] => [
    { subjectId: `${group}0`, group, time: t, event: false },
    { subjectId: `${group}1`, group, time: t + 1, event: false },
  ];
  throwsCode(() => logRank([...g('A', 1), ...g('B', 2)], 'A', 'B'), 'ZERO_VARIANCE');
});

test('log-rank missing group throws GROUP_MISSING', () => {
  const rows: Observation[] = [{ subjectId: 'a0', group: 'A', time: 1, event: true }];
  throwsCode(() => logRank(rows, 'A', 'B'), 'GROUP_MISSING');
});

test('chi-square p-value sanity: chi2=3.84 ~ p=0.05', () => {
  const p = chiSquarePValue(3.8414588);
  assert.ok(Math.abs(p - 0.05) < 1e-4);
});
