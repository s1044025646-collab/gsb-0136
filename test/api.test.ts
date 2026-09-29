import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type Clock } from "../src/db/database.js";
import { Repository } from "../src/db/repository.js";
import { AnalysisService } from "../src/service.js";
import { startLocal, type StartedServer } from "../src/api/http.js";
import type { SubjectInput } from "../src/types.js";

mkdirSync("tmp", { recursive: true });
const dbFile = join("tmp", `lifetrial-api-${process.pid}.db`);
let server: StartedServer;
let base: string;

function fixedClock(): Clock {
  let t = 0;
  return { now: () => new Date(Date.UTC(2026, 0, 1) + t++ * 1000) };
}

const subjects: SubjectInput[] = [
  { anonId: "A1", group: "control", time: 4, status: "event" },
  { anonId: "A2", group: "control", time: 8, status: "event" },
  { anonId: "A3", group: "control", time: 12, status: "censored", censorReason: "study-end" },
  { anonId: "B1", group: "treated", time: 6, status: "event" },
  { anonId: "B2", group: "treated", time: 10, status: "event" },
  { anonId: "B3", group: "treated", time: 14, status: "censored", censorReason: "removed" },
];

before(async () => {
  const db = openDatabase(dbFile, fixedClock());
  const service = new AnalysisService(new Repository(db, fixedClock()), fixedClock());
  server = await startLocal(service);
  base = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      if (existsSync(dbFile + suffix)) rmSync(dbFile + suffix, { maxRetries: 3, retryDelay: 50 });
    } catch {
      // retained WAL handle is harmless; file stays inside project tmp/
    }
  }
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

test("health", async () => {
  const r = await api("GET", "/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "ok");
});

test("validation errors carry explicit codes", async () => {
  const r = await api("POST", "/api/datasets", { name: "x" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "VALIDATION_ERROR");

  const badUnit = await api("POST", "/api/datasets", { name: "y", timeUnit: "parsecs" });
  assert.equal(badUnit.status, 400);

  const malformed = await fetch(base + "/api/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  const payload = (await malformed.json()) as any;
  assert.equal(malformed.status, 400);
  assert.equal(payload.error.code, "BAD_REQUEST");
});

test("full workflow: create, freeze (idempotent), curve, compare, reports, paging", async () => {
  const created = await api("POST", "/api/datasets", { name: "gears", timeUnit: "cycles" });
  assert.equal(created.status, 201);
  const id = created.json.id as number;

  const freeze = await api("POST", `/api/datasets/${id}/versions`, {
    subjects,
    changeNote: "initial",
    idempotencyKey: "gears-import",
  });
  assert.equal(freeze.status, 201);
  const versionId = freeze.json.id as number;

  const replay = await api("POST", `/api/datasets/${id}/versions`, {
    subjects,
    changeNote: "replay",
    idempotencyKey: "gears-import",
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, versionId);

  const curve = await api("POST", `/api/datasets/${id}/curves`, { group: "control" });
  assert.equal(curve.status, 200);
  assert.equal(curve.json.result.group, "control");
  assert.ok(curve.json.result.medianSurvival === 8);
  assert.ok(typeof curve.json.result.rmst === "number");
  const reportId = curve.json.reportId as number;

  // frozen report fetch
  const report = await api("GET", `/api/reports/${reportId}`);
  assert.equal(report.status, 200);
  assert.equal(report.json.kind, "curve");

  const compare = await api("POST", `/api/datasets/${id}/compare`, {
    groupA: "control",
    groupB: "treated",
  });
  assert.equal(compare.status, 200);
  assert.equal(compare.json.result.degreesOfFreedom, 1);

  const missing = await api("POST", `/api/datasets/${id}/compare`, {
    groupA: "control",
    groupB: "ghost",
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "MISSING_GROUP");

  // subject pagination
  const page1 = await api("GET", `/api/versions/${versionId}/subjects?limit=2&offset=0`);
  assert.equal(page1.status, 200);
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.total, 6);
  const page2 = await api("GET", `/api/versions/${versionId}/subjects?limit=2&offset=2`);
  assert.notDeepEqual(page1.json.items[0].id, page2.json.items[0].id);

  // invalid paging
  const badPaging = await api("GET", `/api/versions/${versionId}/subjects?limit=99999`);
  assert.equal(badPaging.status, 400);
});

test("404 on unknown dataset and unknown route", async () => {
  const r = await api("GET", "/api/datasets/999999");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "NOT_FOUND");
  const route = await api("GET", "/nope");
  assert.equal(route.status, 404);
});

test("synthetic generator endpoint is reproducible by seed", async () => {
  const cfg = {
    perGroup: 8,
    groups: [
      { label: "A", failureRate: 0.02 },
      { label: "B", failureRate: 0.06 },
    ],
    censorRate: 0.04,
    maxTime: 100,
    seed: 42,
  };
  const r1 = await api("POST", "/api/generate", cfg);
  const r2 = await api("POST", "/api/generate", cfg);
  assert.deepEqual(r1.json.subjects, r2.json.subjects);
  assert.equal(r1.json.count, 16);
});
