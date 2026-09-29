import { test } from "node:test";
import assert from "node:assert/strict";
import { kaplanMeier } from "../src/stats/kaplanMeier.js";
import { logrank } from "../src/stats/logrank.js";
import { explainCensoring } from "../src/stats/censoring.js";
import type { SubjectInput } from "../src/types.js";

const baseParams = {
  timeUnit: "hours" as const,
  ciMethod: "linear" as const,
  confidenceLevel: 0.95,
  horizon: null,
};

test("hand-computed KM step values, Greenwood variance and RMST", () => {
  // Classic text-book style data for one group:
  // event 6, event 6, censored 6, event 10, censored 14, event 15
  const subjects: SubjectInput[] = [
    { anonId: "1", group: "G", time: 6, status: "event" },
    { anonId: "2", group: "G", time: 6, status: "event" },
    { anonId: "3", group: "G", time: 6, status: "censored", censorReason: "study-end" },
    { anonId: "4", group: "G", time: 10, status: "event" },
    { anonId: "5", group: "G", time: 14, status: "censored", censorReason: "removed" },
    { anonId: "6", group: "G", time: 15, status: "event" },
  ];
  const r = kaplanMeier(subjects, { ...baseParams, group: "G" });

  // t=6: n=6, d=2 -> S = 4/6 = 2/3 ; censored leaves after jump
  assert.ok(Math.abs(r.points[0]!.sAfter - 2 / 3) < 1e-12);
  assert.equal(r.points[0]!.nAtRisk, 6);
  assert.equal(r.points[0]!.cCensored, 1);
  // t=10: n=3 (6-2-1), d=1 -> S = (2/3)*(2/3) = 4/9
  assert.ok(Math.abs(r.points[1]!.sAfter - 4 / 9) < 1e-12);
  assert.equal(r.points[1]!.nAtRisk, 3);
  // t=14: censor only, no jump: n=2
  assert.equal(r.points[2]!.dEvents, 0);
  assert.equal(r.points[2]!.nAtRisk, 2);
  assert.ok(Math.abs(r.points[2]!.sAfter - 4 / 9) < 1e-12);
  // t=15: n=1 d=1 -> S = 0
  assert.equal(r.points[3]!.sAfter, 0);

  // Greenwood at t=10: S^2 * [2/(6*4) + 1/(3*2)] = 16/81 * (1/12 + 1/6)
  const expectedVar = (16 / 81) * (1 / 12 + 1 / 6);
  assert.ok(Math.abs(r.points[1]!.variance - expectedVar) < 1e-12);

  // RMST with default horizon = max observed = 15:
  // [0,6): S=1 -> 6 ; [6,10): S=2/3 -> 8/3 ; [10,15): S=4/9 -> 20/9
  // = 6 + 2.6666667 + 2.2222222 = 10.8889
  assert.ok(Math.abs(r.rmst! - (6 + 8 / 3 + 20 / 9)) < 1e-9);
});

test("median reached exactly at 0.5", () => {
  // 4 units, two events at t=5 (S=0.5), rest censored later
  const subjects: SubjectInput[] = [
    { anonId: "1", group: "G", time: 5, status: "event" },
    { anonId: "2", group: "G", time: 5, status: "event" },
    { anonId: "3", group: "G", time: 8, status: "censored", censorReason: "x" },
    { anonId: "4", group: "G", time: 9, status: "censored", censorReason: "x" },
  ];
  const r = kaplanMeier(subjects, { ...baseParams, group: "G" });
  assert.equal(r.medianSurvival, 5);
});

test("median NOT reached when curve stays above 0.5", () => {
  const subjects: SubjectInput[] = [
    { anonId: "1", group: "G", time: 5, status: "event" },
    { anonId: "2", group: "G", time: 100, status: "censored", censorReason: "x" },
    { anonId: "3", group: "G", time: 100, status: "censored", censorReason: "x" },
    { anonId: "4", group: "G", time: 100, status: "censored", censorReason: "x" },
  ];
  const r = kaplanMeier(subjects, { ...baseParams, group: "G" });
  assert.equal(r.medianSurvival, null);
  assert.match(r.medianNote, /not reached/i);
  // Max observed time must NOT be substituted as median
  assert.notEqual(r.medianSurvival, 100);
});

test("no censoring: KM equals empirical survival, monotone risk set", () => {
  const subjects: SubjectInput[] = [2, 4, 6, 8].map((t, i) => ({
    anonId: String(i), group: "G", time: t, status: "event" as const,
  }));
  const r = kaplanMeier(subjects, { ...baseParams, group: "G" });
  const expected = [0.75, 0.5, 0.25, 0];
  r.points.forEach((p, i) => assert.ok(Math.abs(p.sAfter - expected[i]!) < 1e-12));
  for (let i = 1; i < r.points.length; i++) {
    assert.ok(r.points[i]!.nAtRisk < r.points[i - 1]!.nAtRisk);
  }
  assert.equal(r.medianSurvival, 4);
});

test("all censored: curve flat at 1, median not reached, zero variance", () => {
  const subjects: SubjectInput[] = [1, 2, 3].map((t, i) => ({
    anonId: String(i), group: "G", time: t, status: "censored" as const, censorReason: "end",
  }));
  const r = kaplanMeier(subjects, { ...baseParams, group: "G" });
  assert.ok(r.points.every((p) => p.sAfter === 1 && p.dEvents === 0 && p.variance === 0));
  assert.equal(r.medianSurvival, null);
  assert.ok((r.rmst ?? 0) > 0); // area under S=1 over [0,3] = 3
  assert.ok(Math.abs(r.rmst! - 3) < 1e-12);
  const impact = explainCensoring(subjects);
  assert.equal(impact.events, 0);
  assert.match(impact.explanation, /[Nn]o events/);
});

test("zero-time events are handled at t=0", () => {
  const subjects: SubjectInput[] = [
    { anonId: "1", group: "G", time: 0, status: "event" },
    { anonId: "2", group: "G", time: 5, status: "event" },
  ];
  const r = kaplanMeier(subjects, { ...baseParams, group: "G" });
  assert.equal(r.points[0]!.t, 0);
  assert.equal(r.points[0]!.sAfter, 0.5);
  assert.equal(r.medianSurvival, 0);
});

test("log-rank symmetry with identical staggered event times gives chi2 = 0", () => {
  // Balanced 2x2 tables at two times: each group fails one at t=1 and one at t=5.
  const mk = (group: string): SubjectInput[] =>
    [1, 5].map((t) => ({ anonId: `${group}-${t}`, group, time: t, status: "event" as const }));
  const r = logrank([...mk("A"), ...mk("B")], "A", "B", "hours");
  assert.equal(r.observedA, 2);
  assert.ok(Math.abs(r.expectedA - 2) < 1e-9);
  assert.equal(r.chiSquare, 0);
  assert.ok(Math.abs(r.pValue! - 1) < 1e-9);
});

test("log-rank: when an entire risk set fails, variance term is 0", () => {
  // A: events at 5,5,5 ; B: events at 5,5,5 -> n-d = 0 at the only event time
  const mk = (group: string): SubjectInput[] =>
    [0, 1, 2].map((i) => ({ anonId: `${group}${i}`, group, time: 5, status: "event" as const }));
  const r = logrank([...mk("A"), ...mk("B")], "A", "B", "hours");
  assert.equal(r.observedA, 3);
  assert.ok(Math.abs(r.expectedA - 3) < 1e-9);
  assert.equal(r.chiSquare, null);
  // At t=5: n=6 d=6 => variance term = 0
  assert.equal(r.eventTimes[0]!.varianceTerm, 0);
  assert.match(r.note, /variance is zero/);
});

test("log-rank hand calculation: separated groups", () => {
  // A events at 1,2 ; B events at 9,10 (n=2 each).
  // t=1: n1=2,n2=2,d=1,e1=0.5,V= 2*2*1*3/(16*3)=0.25
  // t=2: n1=1,n2=2,d=1,e1=1/3,V=1*2*1*2/(9*2)=2/9
  // t=9: n1=0,n2=2,d=1,e1=0,V=0
  // t=10: same V=0 ; Z=(1-0.5)+(1-1/3)=0.5+0.6667=1.1667
  // V=0.25+0.2222=0.47222 ; chi2=Z^2/V
  const subjects: SubjectInput[] = [
    { anonId: "a1", group: "A", time: 1, status: "event" },
    { anonId: "a2", group: "A", time: 2, status: "event" },
    { anonId: "b1", group: "B", time: 9, status: "event" },
    { anonId: "b2", group: "B", time: 10, status: "event" },
  ];
  const r = logrank(subjects, "A", "B", "hours");
  assert.ok(Math.abs(r.variance - (0.25 + 2 / 9)) < 1e-9);
  assert.ok(Math.abs(r.expectedA - (0.5 + 1 / 3)) < 1e-9);
  const z = 0.5 + 2 / 3;
  assert.ok(Math.abs(r.chiSquare! - (z * z) / (0.25 + 2 / 9)) < 1e-7);
});

test("log-rank zero variance on all-censored data returns undefined chi-square", () => {
  const subjects: SubjectInput[] = [
    { anonId: "a1", group: "A", time: 3, status: "censored", censorReason: "x" },
    { anonId: "b1", group: "B", time: 4, status: "censored", censorReason: "x" },
  ];
  const r = logrank(subjects, "A", "B", "hours");
  assert.equal(r.variance, 0);
  assert.equal(r.chiSquare, null);
  assert.equal(r.pValue, null);
  assert.match(r.note, /variance is zero/i);
});

test("log-rank rejects missing group", () => {
  const subjects: SubjectInput[] = [
    { anonId: "1", group: "A", time: 1, status: "event" },
  ];
  assert.throws(() => logrank(subjects, "A", "B", "hours"), /MISSING_GROUP|no subjects/);
});

test("ties: events and censoring at same time keep censor out of the jump", () => {
  // n=2: event and censor at t=5. Events-first rule: n=2,d=1 => S=0.5,
  // NOT S=1 (which would happen if the censor were removed before counting).
  const subjects: SubjectInput[] = [
    { anonId: "1", group: "G", time: 5, status: "event" },
    { anonId: "2", group: "G", time: 5, status: "censored", censorReason: "x" },
  ];
  const r = kaplanMeier(subjects, { ...baseParams, group: "G" });
  assert.equal(r.points[0]!.nAtRisk, 2);
  assert.equal(r.points[0]!.sAfter, 0.5);
  assert.equal(r.points[0]!.cCensored, 1);
});

test("RMST respects a specified horizon inside and beyond data", () => {
  const subjects: SubjectInput[] = [
    { anonId: "1", group: "G", time: 4, status: "event" },
    { anonId: "2", group: "G", time: 8, status: "event" },
  ];
  const r4 = kaplanMeier(subjects, { ...baseParams, group: "G", horizon: 4 });
  // S=1 on [0,4] => RMST 4
  assert.ok(Math.abs(r4.rmst! - 4) < 1e-12);
  const r10 = kaplanMeier(subjects, { ...baseParams, group: "G", horizon: 10 });
  // [0,4)=4; [4,8):0.5*4=2; [8,10):0*2=0 => 6
  assert.ok(Math.abs(r10.rmst! - 6) < 1e-12);
});
