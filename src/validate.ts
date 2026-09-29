import { AppError } from './errors.js';
import type { Observation } from './stats/types.js';

export interface ValidatedDataset {
  name: string;
  timeUnit: string;
  observationWindow: string;
  rows: Observation[];
}

const UNITS = ['hours', 'days', 'weeks', 'months', 'cycles'];
const WINDOWS = ['single-event', 'competing-risk', 'recurrent'];

export function validateDatasetInput(input: {
  name?: unknown;
  timeUnit?: unknown;
  observationWindow?: unknown;
  rows?: unknown;
}): ValidatedDataset {
  const errors: string[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.push('name is required');
  const timeUnit = input.timeUnit;
  if (typeof timeUnit !== 'string' || !UNITS.includes(timeUnit)) {
    errors.push(`timeUnit must be one of ${UNITS.join(', ')}`);
  }
  const observationWindow = input.observationWindow;
  if (typeof observationWindow !== 'string' || !WINDOWS.includes(observationWindow)) {
    errors.push(`observationWindow must be one of ${WINDOWS.join(', ')}`);
  }
  if (observationWindow !== 'single-event') {
    errors.push('only single-event observation window is supported (no competing risks / recurrent events)');
  }
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    errors.push('rows must be a non-empty array');
  }

  const rows: Observation[] = [];
  const seen = new Set<string>();
  (Array.isArray(input.rows) ? input.rows : []).forEach((r, i) => {
    const prefix = `rows[${i}]`;
    if (typeof r !== 'object' || r === null) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    const o = r as Record<string, unknown>;
    const subjectId = typeof o.subjectId === 'string' ? o.subjectId.trim() : '';
    const group = typeof o.group === 'string' ? o.group.trim() : '';
    const time = typeof o.time === 'number' ? o.time : NaN;
    const event = typeof o.event === 'boolean' ? o.event : null;
    if (!subjectId) errors.push(`${prefix}.subjectId required`);
    if (!group) errors.push(`${prefix}.group required (missing group is rejected)`);
    if (!Number.isFinite(time) || time < 0) errors.push(`${prefix}.time must be a finite number >= 0`);
    if (event === null) errors.push(`${prefix}.event must be boolean`);
    const key = `${subjectId}|${group}`;
    if (seen.has(key)) errors.push(`${prefix}: duplicate subjectId "${subjectId}" in group "${group}"`);
    seen.add(key);
    rows.push({
      subjectId,
      group,
      time,
      event: event === true,
      censorReason: event === false && typeof o.censorReason === 'string' ? o.censorReason : undefined,
    });
  });

  if (errors.length) throw new AppError('VALIDATION', errors.join('; '), { errors });
  return {
    name,
    timeUnit: timeUnit as string,
    observationWindow: observationWindow as string,
    rows,
  };
}

export function assertComparable(a: ValidatedDataset, b: ValidatedDataset): void {
  const problems: string[] = [];
  if (a.timeUnit !== b.timeUnit) {
    problems.push(`time unit mismatch: ${a.timeUnit} vs ${b.timeUnit}`);
  }
  if (a.observationWindow !== b.observationWindow) {
    problems.push(`observation window mismatch: ${a.observationWindow} vs ${b.observationWindow}`);
  }
  if (problems.length) throw new AppError('UNIT_MISMATCH', problems.join('; '));
}
