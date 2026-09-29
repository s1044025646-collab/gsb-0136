/** A single anonymous subject observation. */
export interface Observation {
  /** Subject identifier within the dataset (anonymized, any stable string). */
  subjectId: string;
  /** Group label (required; missing group is rejected). */
  group: string;
  /**
   * Observed time from the common observation origin (no delayed entry).
   * Must be finite and >= 0.
   */
  time: number;
  /** true = event/failure, false = right censoring at `time`. */
  event: boolean;
  /** Free-text censoring reason (ignored when event is true). */
  censorReason?: string;
}

export interface CurvePoint {
  time: number;
  /** Number at risk just before time t. */
  atRisk: number;
  /** Events at exactly time t. */
  events: number;
  /** Right censorings at exactly time t (events at same time counted first). */
  censored: number;
  /** Kaplan-Meier survival estimate on [t, next event time). */
  survival: number;
  /** Greenwood cumulative variance of S(t) (linear scale). */
  variance: number;
  se: number;
  ciLower: number;
  ciUpper: number;
}

export type CiMethod = 'log-log' | 'linear';

export interface KMSummary {
  n: number;
  events: number;
  censored: number;
  /** null when the curve never reaches 0.5; the last observed time is NOT used. */
  median: number | null;
  points: CurvePoint[];
}
