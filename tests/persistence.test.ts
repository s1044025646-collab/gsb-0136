import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.ts';
import {
  addVersion,
  createDataset,
  findDatasetByName,
  getVersion,
  listRows,
  listVersions,
} from '../src/repo.ts';
import { validateDatasetInput } from '../src/validate.ts';
import { analyzeGroup, compareGroups } from '../src/service.ts';
import type { DatabaseSync } from 'node:sqlite';

const dbFile = join(tmpdir(), `lifetable-persist-${process.pid}.sqlite`);
const rows = (suffix: string) =>
  validateDatasetInput({
    name: 'bearings',
    timeUnit: 'hours',
    observationWindow: 'single-event',
    rows: [
      { subjectId: `s1-${suffix}`, group: 'A', time: 10, event: true },
      { subjectId: `s2-${suffix}`, group: 'A', time: 20, event: false, censorReason: 'cutoff' },
      { subjectId: `s3-${suffix}`, group: 'B', time: 15, event: true },
      { subjectId: `s4-${suffix}`, group: 'B', time: 30, event: true },
    ],
  });

let clockTick = 1_700_000_000_000;
const clock = () => new Date(clockTick++);

let v1: number;

test('create + version + idempotent re-import', () => {
  rmSync(dbFile, { force: true });
  const db: DatabaseSync = openDb(dbFile);
  const created = createDataset(db, rows('v1'), clock);
  v1 = created.versionId;
  assert.equal(created.version, 1);

  // Same content again -> same version id (idempotent), no duplicate rows.
  const dsId = findDatasetByName(db, 'bearings')!;
  const again = addVersion(db, dsId, rows('v1'), clock, 'no change resubmit');
  assert.equal(again.versionId, v1);
  assert.equal(listVersions(db, dsId, 10, 0).total, 1);

  // Revised endpoint/status creates a new version; old snapshot is frozen.
  const revised = validateDatasetInput({
    name: 'bearings',
    timeUnit: 'hours',
    observationWindow: 'single-event',
    rows: [
      { subjectId: 's1-v1', group: 'A', time: 10, event: false, censorReason: 'status corrected' },
      { subjectId: 's2-v1', group: 'A', time: 20, event: false, censorReason: 'cutoff' },
      { subjectId: 's3-v1', group: 'B', time: 15, event: true },
      { subjectId: 's4-v1', group: 'B', time: 30, event: true },
    ],
  });
  const v2 = addVersion(db, dsId, revised, clock, 'endpoint corrected for s1');
  assert.equal(v2.version, 2);
  assert.equal(listRows(db, v1).find((r) => r.subjectId === 's1-v1')!.event, true);
  assert.equal(listRows(db, v2.versionId).find((r) => r.subjectId === 's1-v1')!.event, false);
  db.close();
});

test('restart: reopening the file runs idempotent migrations and keeps data', () => {
  assert.ok(existsSync(dbFile));
  const db: DatabaseSync = openDb(dbFile);
  const meta = getVersion(db, v1)!;
  assert.equal(meta.name, 'bearings');
  assert.equal(listRows(db, v1).length, 4);
  // Migrations are repeatable: opening twice in a row must not throw.
  const db2: DatabaseSync = openDb(dbFile + '.2');
  db2.close();
  db.close();
});

test('transaction rollback on invalid version keeps state intact', () => {
  const db: DatabaseSync = openDb(dbFile);
  const before = listVersions(db, findDatasetByName(db, 'bearings')!, 10, 0).total;
  assert.throws(() =>
    // dataset id that does not exist -> transaction must roll back
    addVersion(db, 999_999, rows('boom'), clock, 'should rollback'),
  );
  const after = listVersions(db, findDatasetByName(db, 'bearings')!, 10, 0).total;
  assert.equal(after, before);
  db.close();
});

test('analyses and reports persist against the frozen snapshot', () => {
  const db: DatabaseSync = openDb(dbFile);
  const a = analyzeGroup(db, v1, 'A', { tau: 20, clock });
  assert.equal(a.median.reached, true);
  assert.ok(a.stored!.reportId > 0);
  // Re-run with identical parameters: analysis row reused, new frozen report.
  const a2 = analyzeGroup(db, v1, 'A', { tau: 20, clock });
  assert.equal(a2.stored!.reused, true);
  const c = compareGroups(db, v1, 'A', { group2: 'B', clock });
  assert.ok(c.pValue >= 0 && c.pValue <= 1);
  assert.ok(c.stored!.reportId > 0);
  db.close();
});
