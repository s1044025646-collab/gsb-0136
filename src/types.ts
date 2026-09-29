export type TimeUnit = "hours" | "cycles" | "days" | "weeks";
export type SubjectStatus = "event" | "censored";

export interface SubjectInput {
  anonId: string;
  group: string;
  time: number;
  status: SubjectStatus;
  censorReason?: string | null;
}

export interface SubjectRow extends SubjectInput {
  id: number;
  versionId: number;
}

export interface CurvePoint {
  t: number;
  nAtRisk: number;
  dEvents: number;
  cCensored: number;
  sBefore: number;
  sAfter: number;
  variance: number; // Greenwood variance of S(t) at/after this point
  ciLower: number;
  ciUpper: number;
}

export interface CurveResult {
  group: string;
  timeUnit: TimeUnit;
  method: string;
  points: CurvePoint[];
  medianSurvival: number | null; // null = not reached
  medianNote: string;
  rmst: number | null; // restricted mean survival up to horizon
  rmstHorizon: number;
  rmstNote: string;
  n: number;
  events: number;
  censored: number;
}

export interface LogrankResult {
  method: string;
  groupA: string;
  groupB: string;
  timeUnit: TimeUnit;
  eventTimes: {
    t: number;
    nA: number;
    nB: number;
    dA: number;
    dB: number;
    eA: number;
    eB: number;
    varianceTerm: number;
  }[];
  observedA: number;
  observedB: number;
  expectedA: number;
  expectedB: number;
  variance: number;
  chiSquare: number | null;
  degreesOfFreedom: number;
  pValue: number | null;
  note: string;
}
