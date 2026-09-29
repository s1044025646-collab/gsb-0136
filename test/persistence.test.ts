import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type Clock } from "../src/db/database.js";
import { Repository, validateSubjects } from "../src/db/repository.js";
import { AnalysisService } from "../src/service.js";
import { AppError } from "../src/errors.js";
import type { SubjectInput } from "../src/types.js";

mkdirSync("tmp", { recursive: true });
const dbFile = join("tmp", `lifetrial-persist-${process.pid}.db`);

function fixedClock(): Clock {
  let t = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1) + t++ * 1000) };
}

const subjects: SubjectInput[] = [
  { anonId: "P1", group: "A", time: 3, status: "event" },
  { anonId: "P2", group: "A", time: 6, status: "censored", censorReason: "study-end" },
  { anonId: "P3", group: "B", time: 5, status: "event" },
  { anonId: "P4", group: "B", time: 9, status: "censored", censorReason: "removed" },
];

before(() => {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(dbFile + suffix)) rmSync(dbFile + suffix);
  }
});

function cleanup() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(dbFile + suffix)) rmSync(dbFile + suffix, { maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows may briefly retain WAL handles; temp artifacts stay in project tmp/.
    }
  }
}

after(() => cleanup());

test("migrations are repeatable (re-run is a no-op)", () => {
  const db = openDatabase(dbFile, fixedClock());
  const applied = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: number }[];
  assert.deepEqual(applied.map((r) => r.id), [1]);
  db.close();
});

test("dataset creation, versioning and frozen snapshots", () => {
  const db = openDatabase(dbFile, fixedClock());
  const repo = new Repository(db, fixedClock());
  const ds = repo.createDataset("bearings", "hours", "synthetic bearings");
  assert.equal(ds.current_version, 1);

  const v1 = repo.freezeVersion(ds.id, subjects, "initial import", { idempotencyKey: "bearings-v2" });
  assert.equal(v1.created, true);
  assert.equal(v1.version.version, 2); // datasets row starts at version 1 baseline
  assert.equal(v1.version.event_count, 2);
  assert.equal(v1.version.censor_count, 2);

  // Corrections create a NEW version; old snapshot stays intact.
  const corrected = subjects.map((s) =>
    s.anonId === "P2" ? { ...s, status: "event" as const, censorReason: undefined } : s
  );
  const v2 = repo.freezeVersion(ds.id, corrected, "correct P2 endpoint: censor -> event", {
    idempotencyKey: "bearings-v3",
  });
  assert.equal(v2.version.version, 3);
  const oldRows = repo.listSubjects(v1.version.id);
  assert.equal(oldRows.find((r) => r.anon_id === "P2")!.status, "censored");
  db.close();
});

test("repeated identical submission is idempotent", () => {
  const db = openDatabase(dbFile, fixedClock());
  const repo = new Repository(db, fixedClock());
  const ds = repo.createDataset("seals", "cycles");
  const first = repo.freezeVersion(ds.id, subjects, "v1", { idempotencyKey: "seals-import" });
  // Retried submission with the same key returns the SAME version, unchanged.
  const replay = repo.freezeVersion(ds.id, subjects, "v1 retry", { idempotencyKey: "seals-import" });
  assert.equal(replay.created, false);
  assert.equal(first.version.id, replay.version.id);
  assert.equal(repo.getDataset(ds.id).current_version, first.version.version);

  // Reusing a key with different data is a conflict.
  const tampered = subjects.map((s) => (s.anonId === "P1" ? { ...s, time: 999 } : s));
  assert.throws(
    () => repo.freezeVersion(ds.id, tampered, "tampered", { idempotencyKey: "seals-import" }),
    (err: unknown) => err instanceof AppError && err.code === "VERSION_CONFLICT"
  );
  db.close();
});

test("analysis only reads frozen snapshots and reports are idempotent", () => {
  const db = openDatabase(dbFile, fixedClock());
  const service = new AnalysisService(new Repository(db, fixedClock()), fixedClock());
  const bearings = service.listDatasets(1000, 0).items.find((d) => d.name === "bearings")!;
  const c1 = service.curve(bearings.id, { group: "A", version: 2 });
  const c2 = service.curve(bearings.id, { group: "A", version: 2 });
  assert.equal(c1.reportId, c2.reportId);
  assert.equal(c2.created, false);
  assert.ok(c1.result.points.length >= 1);
  const cmp = service.compare(bearings.id, "A", "B", 2);
  assert.equal(cmp.result.timeUnit, "hours");
  db.close();
});

test("invalid subject data is rejected (transaction never partially persists)", () => {
  const db = openDatabase(dbFile, fixedClock());
  const repo = new Repository(db, fixedClock());
  const ds = repo.createDataset("bad", "hours");
  const bad: SubjectInput[] = [
    { anonId: "x1", group: "A", time: 1, status: "event" },
    { anonId: "x2", group: "A", time: -4, status: "event" },
  ];
  assert.throws(() => repo.freezeVersion(ds.id, bad, "bad"), AppError);
  // No version row should exist for the failed attempt beyond the baseline.
  const versions = repo.listVersions(ds.id);
  assert.equal(versions.length, 0);
  db.close();
});

test("duplicate anon id inside a batch is rejected before any insert", () => {
  assert.throws(
    () =>
      validateSubjects([
        { anonId: "x", group: "A", time: 1, status: "event" },
        { anonId: "x", group: "A", time: 2, status: "event" },
      ]),
    /duplicate anonId/
  );
});

test("state survives closing and reopening the database (restart reproduction)", () => {
  let db = openDatabase(dbFile, fixedClock());
  let repo = new Repository(db, fixedClock());
  const before = repo.listDatasets(100, 0);
  const reportBefore = new AnalysisService(repo, fixedClock())
    .curve(repo.findDatasetByName("bearings")!.id, { group: "B", version: 2 });
  db.close();

  db = openDatabase(dbFile, fixedClock());
  repo = new Repository(db, fixedClock());
  const after = repo.listDatasets(100, 0);
  assert.equal(after.total, before.total);
  const reportAfter = new AnalysisService(repo, fixedClock())
    .curve(repo.findDatasetByName("bearings")!.id, { group: "B", version: 2 });
  assert.equal(reportBefore.reportId, reportAfter.reportId);
  assert.deepEqual(reportAfter.result, reportBefore.result);
  db.close();
});

test("pagination metadata is correct", () => {
  const db = openDatabase(dbFile, fixedClock());
  const repo = new Repository(db, fixedClock());
  const page1 = repo.listDatasets(2, 0);
  const page2 = repo.listDatasets(2, 2);
  assert.equal(page1.items.length, 2);
  assert.ok(page2.items.length >= 1);
  assert.equal(page1.total, page2.total);
  assert.deepEqual(
    page1.items.map((d) => d.id),
    repo.listDatasets(100, 0).items.slice(0, 2).map((d) => d.id)
  );
  db.close();
});
