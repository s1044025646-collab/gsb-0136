import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLifetimes, seededRng } from '../src/generator.ts';
import { kaplanMeier } from '../src/stats/km.ts';
import { logRank } from '../src/stats/logrank.ts';
import type { Observation } from '../src/stats/types.ts';

test('seeded generator is deterministic', () => {
  const specs = [
    { name: 'A', n: 30, lambda: 0.2, censorProbability: 0.3 },
    { name: 'B', n: 30, lambda: 0.1, censorLambda: 0.05 },
  ];
  const a = generateLifetimes(specs, { seed: 123 });
  const b = generateLifetimes(specs, { seed: 123 });
  assert.deepEqual(a, b);
  const c = generateLifetimes(specs, { seed: 124 });
  assert.notDeepEqual(a, c);
  assert.ok(a.every((r) => Number.isFinite(r.time) && r.time >= 0));
});

test('zero-time event fixture', () => {
  const rows = generateLifetimes([{ name: 'A', n: 5, lambda: 0.3 }], {
    seed: 1,
    includeZeroTimeEvent: true,
  });
  assert.equal(rows[0]!.time, 0);
  assert.equal(rows[0]!.event, true);
  const km = kaplanMeier(rows);
  assert.equal(km.points[0]!.time, 0);
  assert.ok(km.points[0]!.survival < 1);
});

test('non-crossing curves: uniformly lower-hazard group stays above', () => {
  // Construct deterministic fixtures directly.
  const good: Observation[] = [
    { subjectId: 'g1', group: 'good', time: 6, event: true },
    { subjectId: 'g2', group: 'good', time: 8, event: true },
    { subjectId: 'g3', group: 'good', time: 10, event: false },
  ];
  const bad: Observation[] = [
    { subjectId: 'b1', group: 'bad', time: 1, event: true },
    { subjectId: 'b2', group: 'bad', time: 2, event: true },
    { subjectId: 'b3', group: 'bad', time: 3, event: true },
  ];
  const sGood = kaplanMeier(good);
  const sBad = kaplanMeier(bad);
  assert.equal(sGood.median, 8);
  assert.equal(sBad.median, 2);
  const lr = logRank([...good, ...bad], 'good', 'bad');
  assert.ok(lr.chiSquare > 0);
});

test('crossing curves fixture is accepted by both KM and log-rank', () => {
  const a: Observation[] = [
    { subjectId: 'a1', group: 'A', time: 1, event: true },
    { subjectId: 'a2', group: 'A', time: 10, event: true },
    { subjectId: 'a3', group: 'A', time: 12, event: false },
  ];
  const b: Observation[] = [
    { subjectId: 'b1', group: 'B', time: 4, event: true },
    { subjectId: 'b2', group: 'B', time: 5, event: true },
    { subjectId: 'b3', group: 'B', time: 6, event: true },
  ];
  // A drops first (t=1) while B is still at 1; later B falls to 0 while A plateaus > 0.
  const ka = kaplanMeier(a);
  const kb = kaplanMeier(b);
  assert.ok(ka.points[0]!.survival < 1);
  assert.equal(kb.points[kb.points.length - 1]!.survival, 0);
  assert.ok(ka.points[ka.points.length - 1]!.survival > 0);
  const lr = logRank([...a, ...b], 'A', 'B');
  assert.ok(Number.isFinite(lr.chiSquare));
});

test('tiny sample: n=1 event and n=1 censored', () => {
  const ev: Observation[] = [{ subjectId: 'x', group: 'G', time: 3, event: true }];
  const km = kaplanMeier(ev);
  assert.equal(km.points[0]!.survival, 0);
  assert.equal(km.median, 3);
  const ce: Observation[] = [{ subjectId: 'y', group: 'G', time: 3, event: false }];
  const kmc = kaplanMeier(ce);
  assert.equal(kmc.median, null);
});

test('rng stays within [0,1)', () => {
  const r = seededRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
  }
});
