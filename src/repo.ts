import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import { runInTransaction, type Clock } from './db.js';
import type { ValidatedDataset } from './validate.js';

export interface StoredVersion {
  versionId: number;
  datasetId: number;
  version: number;
  name: string;
  timeUnit: string;
  observationWindow: string;
  contentHash: string;
}

export interface StoredRow {
  subjectId: string;
  group: string;
  time: number;
  event: boolean;
  censorReason: string | null;
}

export const hashContent = (data: ValidatedDataset): string =>
  createHash('sha256').update(JSON.stringify(data.rows)).digest('hex');

export function createDataset(
  db: DatabaseSync,
  data: ValidatedDataset,
  clock: Clock,
): StoredVersion {
  return runInTransaction(db, () => {
    const now = clock().toISOString();
    const dsRes = db
      .prepare(
        'INSERT INTO datasets (name, time_unit, observation_window, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(data.name, data.timeUnit, data.observationWindow, now);
    const datasetId = Number(dsRes.lastInsertRowid);
    return insertVersion(db, datasetId, 1, data, now, 'initial import');
  });
}

export function addVersion(
  db: DatabaseSync,
  datasetId: number,
  data: ValidatedDataset,
  clock: Clock,
  changeNote: string,
): StoredVersion {
  return runInTransaction(db, () => {
    const ds = db
      .prepare('SELECT id, name, time_unit, observation_window FROM datasets WHERE id = ?')
      .get(datasetId) as
      | { id: number; name: string; time_unit: string; observation_window: string }
      | undefined;
    if (!ds) throw new AppError('NOT_FOUND', `dataset ${datasetId} not found`);
    const max = db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM dataset_versions WHERE dataset_id = ?')
      .get(datasetId) as { v: number };
    const now = clock().toISOString();
    return insertVersion(db, datasetId, max.v + 1, data, now, changeNote);
  });
}

function insertVersion(
  db: DatabaseSync,
  datasetId: number,
  version: number,
  data: ValidatedDataset,
  now: string,
  changeNote: string,
): StoredVersion {
  const contentHash = hashContent(data);
  const existing = db
    .prepare('SELECT id FROM dataset_versions WHERE dataset_id = ? AND content_hash = ?')
    .get(datasetId, contentHash) as { id: number } | undefined;
  if (existing) {
    // Idempotent re-submission: identical content maps to the existing version.
    return getVersion(db, existing.id)!;
  }
  const vRes = db
    .prepare(
      'INSERT INTO dataset_versions (dataset_id, version, content_hash, created_at, change_note) VALUES (?, ?, ?, ?, ?)',
    )
    .run(datasetId, version, contentHash, now, changeNote);
  const versionId = Number(vRes.lastInsertRowid);
  const ins = db.prepare(
    'INSERT INTO observations (version_id, subject_id, grp, time, event, censor_reason) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of data.rows) {
    ins.run(versionId, r.subjectId, r.group, r.time, r.event ? 1 : 0, r.censorReason ?? null);
  }
  return getVersion(db, versionId)!;
}

export function getVersion(db: DatabaseSync, versionId: number): StoredVersion | null {
  const row = db
    .prepare(
      `SELECT v.id AS version_id, v.dataset_id, v.version, v.content_hash,
              d.name, d.time_unit, d.observation_window
       FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id
       WHERE v.id = ?`,
    )
    .get(versionId) as
    | {
        version_id: number;
        dataset_id: number;
        version: number;
        content_hash: string;
        name: string;
        time_unit: string;
        observation_window: string;
      }
    | undefined;
  if (!row) return null;
  return {
    versionId: row.version_id,
    datasetId: row.dataset_id,
    version: row.version,
    name: row.name,
    timeUnit: row.time_unit,
    observationWindow: row.observation_window,
    contentHash: row.content_hash,
  };
}

export function findDatasetByName(db: DatabaseSync, name: string): number | null {
  const row = db.prepare('SELECT id FROM datasets WHERE name = ?').get(name) as
    | { id: number }
    | undefined;
  return row ? row.id : null;
}

export function listRows(db: DatabaseSync, versionId: number): StoredRow[] {
  const rows = db
    .prepare(
      'SELECT subject_id, grp, time, event, censor_reason FROM observations WHERE version_id = ? ORDER BY time, subject_id',
    )
    .all(versionId) as Array<{
    subject_id: string;
    grp: string;
    time: number;
    event: number;
    censor_reason: string | null;
  }>;
  return rows.map((r) => ({
    subjectId: r.subject_id,
    group: r.grp,
    time: r.time,
    event: r.event === 1,
    censorReason: r.censor_reason,
  }));
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export function listDatasets(
  db: DatabaseSync,
  limit: number,
  offset: number,
): Page<{ datasetId: number; name: string; latestVersion: number; timeUnit: string }> {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM datasets').get() as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT d.id AS dataset_id, d.name, d.time_unit, MAX(v.version) AS latest
       FROM datasets d JOIN dataset_versions v ON v.dataset_id = d.id
       GROUP BY d.id ORDER BY d.id LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as Array<{
    dataset_id: number;
    name: string;
    time_unit: string;
    latest: number;
  }>;
  return {
    items: rows.map((r) => ({
      datasetId: r.dataset_id,
      name: r.name,
      latestVersion: r.latest,
      timeUnit: r.time_unit,
    })),
    total,
    limit,
    offset,
  };
}

export function listVersions(
  db: DatabaseSync,
  datasetId: number,
  limit: number,
  offset: number,
): Page<{ versionId: number; version: number; changeNote: string; createdAt: string }> {
  const total = (
    db
      .prepare('SELECT COUNT(*) AS c FROM dataset_versions WHERE dataset_id = ?')
      .get(datasetId) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT id, version, change_note, created_at FROM dataset_versions
       WHERE dataset_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`,
    )
    .all(datasetId, limit, offset) as Array<{
    id: number;
    version: number;
    change_note: string;
    created_at: string;
  }>;
  return {
    items: rows.map((r) => ({
      versionId: r.id,
      version: r.version,
      changeNote: r.change_note,
      createdAt: r.created_at,
    })),
    total,
    limit,
    offset,
  };
}

export function storeAnalysis(
  db: DatabaseSync,
  versionId: number,
  group: string,
  ciMethod: string,
  tau: number | null,
  payload: unknown,
  clock: Clock,
): { analysisId: number; reportId: number; reused: boolean } {
  return runInTransaction(db, () => {
    const paramsHash = createHash('sha256')
      .update(JSON.stringify({ group, ciMethod, tau }))
      .digest('hex');
    const existing = db
      .prepare('SELECT id FROM analyses WHERE version_id = ? AND grp = ? AND params_hash = ?')
      .get(versionId, group, paramsHash) as { id: number } | undefined;
    const now = clock().toISOString();
    let analysisId: number;
    if (existing) {
      analysisId = existing.id;
    } else {
      analysisId = Number(
        db
          .prepare(
            'INSERT INTO analyses (version_id, grp, ci_method, tau, params_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(versionId, group, ciMethod, tau, paramsHash, now).lastInsertRowid,
      );
    }
    const reportId = Number(
      db
        .prepare(
          'INSERT INTO reports (analysis_id, comparison_id, payload_json, created_at) VALUES (?, NULL, ?, ?)',
        )
        .run(analysisId, JSON.stringify(payload), now).lastInsertRowid,
    );
    return { analysisId, reportId, reused: Boolean(existing) };
  });
}

export function storeComparison(
  db: DatabaseSync,
  versionId: number,
  group1: string,
  group2: string,
  payload: unknown,
  clock: Clock,
): { comparisonId: number; reportId: number } {
  return runInTransaction(db, () => {
    const now = clock().toISOString();
    const existing = db
      .prepare('SELECT id FROM comparisons WHERE version_id = ? AND group1 = ? AND group2 = ?')
      .get(versionId, group1, group2) as { id: number } | undefined;
    let comparisonId: number;
    if (existing) {
      comparisonId = existing.id;
    } else {
      comparisonId = Number(
        db
          .prepare(
            'INSERT INTO comparisons (version_id, group1, group2, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(versionId, group1, group2, now).lastInsertRowid,
      );
    }
    const reportId = Number(
      db
        .prepare(
          'INSERT INTO reports (analysis_id, comparison_id, payload_json, created_at) VALUES (NULL, ?, ?, ?)',
        )
        .run(comparisonId, JSON.stringify(payload), now).lastInsertRowid,
    );
    return { comparisonId, reportId };
  });
}

export function getReport(db: DatabaseSync, reportId: number): unknown | null {
  const row = db.prepare('SELECT payload_json FROM reports WHERE id = ?').get(reportId) as
    | { payload_json: string }
    | undefined;
  return row ? JSON.parse(row.payload_json) : null;
}

export function listReports(
  db: DatabaseSync,
  limit: number,
  offset: number,
): Page<{ reportId: number; analysisId: number | null; comparisonId: number | null; createdAt: string }> {
  const total = (db.prepare('SELECT COUNT(*) AS c FROM reports').get() as { c: number }).c;
  const rows = db
    .prepare(
      'SELECT id, analysis_id, comparison_id, created_at FROM reports ORDER BY id LIMIT ? OFFSET ?',
    )
    .all(limit, offset) as Array<{
    id: number;
    analysis_id: number | null;
    comparison_id: number | null;
    created_at: string;
  }>;
  return {
    items: rows.map((r) => ({
      reportId: r.id,
      analysisId: r.analysis_id,
      comparisonId: r.comparison_id,
      createdAt: r.created_at,
    })),
    total,
    limit,
    offset,
  };
}
