import type { SubjectInput } from "../types.js";

export interface CensorImpact {
  total: number;
  events: number;
  censored: number;
  censorRate: number;
  censorReasons: { reason: string; count: number }[];
  // Censors that occur before the last event time: they actively truncate
  // follow-up while failures are still being observed.
  earlyCensors: number;
  // Subjects still censored at the end (no later event observed).
  tailCensors: number;
  lastEventTime: number | null;
  maxObservedTime: number;
  explanation: string;
}

export function explainCensoring(subjects: SubjectInput[]): CensorImpact {
  const total = subjects.length;
  const events = subjects.filter((s) => s.status === "event");
  const censored = subjects.filter((s) => s.status === "censored");
  const lastEventTime = events.length === 0 ? null : Math.max(...events.map((s) => s.time));
  const maxObservedTime = total === 0 ? 0 : Math.max(...subjects.map((s) => s.time));
  const earlyCensors = censored.filter(
    (s) => lastEventTime !== null && s.time < lastEventTime
  ).length;
  const tailCensors = censored.length - earlyCensors;

  const reasonMap = new Map<string, number>();
  for (const s of censored) {
    const reason = s.censorReason ?? "unspecified";
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push(
    `${censored.length} of ${total} specimens (${((censored.length / total) * 100).toFixed(1)}%) are right-censored: their event had not occurred when observation ended.`
  );
  lines.push("Censored specimens contribute person-time and stay in the risk set until their censor time; they are never counted as failures.");
  if (events.length === 0) {
    lines.push("No events were observed at all: the KM curve stays at 1.0 and no median survival can be estimated.");
  } else {
    lines.push(`${earlyCensors} censor time(s) occur before the last event at t=${lastEventTime}, reducing later risk-set sizes and widening confidence intervals.`);
    if (tailCensors > 0) {
      lines.push(`${tailCensors} specimen(s) are censored at/after the last event; the KM tail is carried at the final survival estimate and the median may be unestimable.`);
    }
  }

  return {
    total,
    events: events.length,
    censored: censored.length,
    censorRate: censored.length / total,
    censorReasons: [...reasonMap.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    earlyCensors,
    tailCensors,
    lastEventTime,
    maxObservedTime,
    explanation: lines.join(" "),
  };
}
