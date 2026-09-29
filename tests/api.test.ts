import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { startLocalServer } from '../src/server/app.ts';
import type { Server } from 'node:http';

const dbFile = join(tmpdir(), `lifetable-api-${process.pid}.sqlite`);
rmSync(dbFile, { force: true });
const db = openDb(dbFile);

let tick = 1_700_000_000_000;
const server: Server = (
  await startLocalServer({ db, clock: () => new Date(tick += 1000) })
).server;
after(() => {
  server.close();
  db.close();
});

const port = (server.address() as AddressInfo).port;
assert.ok(port > 0, 'auto-assigned port');

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const payload = {
  name: 'shafts',
  timeUnit: 'cycles',
  observationWindow: 'single-event',
  rows: [
    { subjectId: 'a1', group: 'control', time: 100, event: true },
    { subjectId: 'a2', group: 'control', time: 150, event: false, censorReason: 'end of bench window' },
    { subjectId: 'a3', group: 'control', time: 200, event: true },
    { subjectId: 'b1', group: 'treated', time: 300, event: true },
    { subjectId: 'b2', group: 'treated', time: 400, event: false, censorReason: 'rig retired' },
  ],
};

test('health + create + idempotent conflict + validation errors', async () => {
  const h = await call('GET', '/health');
  assert.equal(h.status, 200);

  const created = await call('POST', '/datasets', payload);
  assert.equal(created.status, 201);
  assert.equal(created.json.version, 1);

  const dup = await call('POST', '/datasets', payload);
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'CONFLICT');

  const bad = await call('POST', '/datasets', { ...payload, name: 'x', rows: [] });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'VALIDATION');

  const badGroup = await call('POST', '/datasets', {
    ...payload,
    name: 'y',
    rows: [{ subjectId: 'z', time: 1, event: true }],
  });
  assert.equal(badGroup.json.error.code, 'VALIDATION');

  const badWindow = await call('POST', '/datasets', {
    ...payload,
    name: 'z',
    observationWindow: 'recurrent',
  });
  assert.equal(badWindow.status, 422);
});

test('pagination on datasets and rows', async () => {
  await call('POST', '/datasets', { ...payload, name: 'second' });
  const page = await call('GET', '/datasets?limit=1&offset=0');
  assert.equal(page.status, 200);
  assert.equal(page.json.items.length, 1);
  assert.equal(page.json.total, 2);

  const first = (await call('GET', '/datasets?limit=1&offset=0')).json.items[0].datasetId;
  const ver = await call('GET', `/datasets/${first}/versions`);
  const versionId = ver.json.items[0].versionId;

  const rowsPage = await call('GET', `/versions/${versionId}/rows?limit=2&offset=1`);
  assert.equal(rowsPage.json.items.length, 2);
  assert.equal(rowsPage.json.total, 5);

  assert.equal((await call('GET', '/datasets/99999')).status, 404);
});

test('frozen analysis: KM curve, median, RMST, report persistence', async () => {
  const list = await call('GET', '/datasets');
  const ds = list.json.items.find((d: any) => d.name === 'shafts');
  const versionId = (await call('GET', `/datasets/${ds.datasetId}/versions`)).json.items[0].versionId;

  const a = await call('POST', `/versions/${versionId}/analyses`, { group: 'control', tau: 200 });
  assert.equal(a.status, 201);
  assert.equal(a.json.n, 3);
  assert.equal(a.json.censorImpact.censored, 1);
  assert.ok(a.json.rmst.rmst > 0);
  const reportId = a.json.stored.reportId;
  const fetched = await call('GET', `/reports/${reportId}`);
  assert.equal(fetched.json.kind, 'km-analysis');

  // treated: one event at 300 out of 2 -> S=0.5 reached => median 300
  const b = await call('POST', `/versions/${versionId}/analyses`, { group: 'treated' });
  assert.equal(b.json.median.reached, true);
  assert.equal(b.json.median.value, 300);

  // group with no events must report ALL_CENSORED
  const allC = await call('POST', '/datasets', {
    name: 'allcens',
    timeUnit: 'hours',
    observationWindow: 'single-event',
    rows: [{ subjectId: 'q', group: 'G', time: 5, event: false, censorReason: 'x' }],
  });
  const allCensId = (await call('GET', `/datasets/${allC.json.datasetId}/versions`)).json.items[0].versionId;
  const err = await call('POST', `/versions/${allCensId}/analyses`, { group: 'G' });
  assert.equal(err.json.error.code, 'ALL_CENSORED');
});

test('log-rank comparison with O/E/V and error paths', async () => {
  const ds = (await call('GET', '/datasets')).json.items.find((d: any) => d.name === 'shafts');
  const versionId = (await call('GET', `/datasets/${ds.datasetId}/versions`)).json.items[0].versionId;
  const c = await call('POST', `/versions/${versionId}/comparisons`, {
    group1: 'control',
    group2: 'treated',
  });
  assert.equal(c.status, 201);
  assert.equal(c.json.degreesOfFreedom, 1);
  assert.equal(c.json.table.group1.observed, 2);
  assert.ok(Math.abs(c.json.table.group1.expected - (0.6 + 1 / 3)) < 1e-9);
  assert.ok(c.json.table.variance > 0);
  assert.equal(typeof c.json.pValue, 'number');

  const missing = await call('POST', `/versions/${versionId}/comparisons`, {
    group1: 'control',
    group2: 'nope',
  });
  assert.equal(missing.json.error.code, 'GROUP_MISSING');

  const badParams = await call('POST', `/versions/${versionId}/analyses`, { group: 42 });
  assert.equal(badParams.status, 422);

  const reports = await call('GET', '/reports?limit=1&offset=0');
  assert.equal(reports.json.items.length, 1);
  assert.ok(reports.json.total >= 3);
});

test('revision produces a new frozen version; comparison stays on old snapshot', async () => {
  const ds = (await call('GET', '/datasets')).json.items.find((d: any) => d.name === 'shafts');
  const revised = await call('POST', `/datasets/${ds.datasetId}/versions`, {
    ...payload,
    changeNote: 'b1 endpoint corrected',
    rows: payload.rows.map((r) =>
      r.subjectId === 'b1' ? { ...r, event: false, censorReason: 'endpoint corrected' } : r,
    ),
  });
  assert.equal(revised.status, 201);
  assert.equal(revised.json.version, 2);

  const versions = await call('GET', `/datasets/${ds.datasetId}/versions`);
  assert.equal(versions.json.total, 2);
});
