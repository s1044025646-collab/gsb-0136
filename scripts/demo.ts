/**
 * Reproducible end-to-end demo: starts the loopback API server on an
 * auto-assigned port, generates deterministic synthetic part lifetimes,
 * imports them, revises an endpoint (new frozen version), runs a KM analysis
 * and a log-rank comparison, then prints the frozen report. All files stay
 * under ./data/demo and the server process is this process (clean shutdown).
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { openDb } from '../src/db.ts';
import { startLocalServer } from '../src/server/app.ts';
import { generateLifetimes } from '../src/generator.ts';

const dir = resolve(fileURLToPath(new URL('..', import.meta.url)), 'data', 'demo');
rmSync(dir, { recursive: true, force: true });
const db = openDb(resolve(dir, 'demo.sqlite'));

let fixed = Date.UTC(2026, 0, 1, 0, 0, 0);
const { server } = await startLocalServer({ db, clock: () => new Date((fixed += 1000)) });
const port = (server.address() as AddressInfo).port;
const url = (p: string) => `http://127.0.0.1:${port}${p}`;

const say = (label: string, value: unknown) =>
  console.log(`\n=== ${label} ===\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

try {
  say('server', { bound: '127.0.0.1', port });

  const rows = generateLifetimes(
    [
      { name: 'control', n: 20, lambda: 0.08, censorLambda: 0.02 },
      { name: 'treated', n: 20, lambda: 0.03, censorLambda: 0.02 },
    ],
    { seed: 2026 },
  );
  say('generated', { rows: rows.length, events: rows.filter((r) => r.event).length });

  const created = await fetch(url('/datasets'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'demo-bearings',
      timeUnit: 'hours',
      observationWindow: 'single-event',
      rows,
    }),
  }).then((r) => r.json());
  say('frozen snapshot v1', { versionId: created.versionId });

  const analysis = await fetch(url(`/versions/${created.versionId}/analyses`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group: 'control', ci: 'log-log', tau: 40 }),
  }).then((r) => r.json());
  say('KM analysis (control, RMST tau=40)', {
    n: analysis.n,
    events: analysis.events,
    censored: analysis.censored,
    median: analysis.median,
    rmst: analysis.rmst,
    steps: analysis.curve.length,
    reportId: analysis.stored.reportId,
  });

  const compare = await fetch(url(`/versions/${created.versionId}/comparisons`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group1: 'control', group2: 'treated' }),
  }).then((r) => r.json());
  say('log-rank control vs treated', {
    chiSquare: compare.chiSquare,
    pValue: compare.pValue,
    table: compare.table,
  });

  // Revise one subject's endpoint status: creates a new frozen version.
  const revised = await fetch(url(`/datasets/${created.datasetId}/versions`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'demo-bearings',
      timeUnit: 'hours',
      observationWindow: 'single-event',
      changeNote: 'first control subject endpoint corrected from event to censored',
      rows: rows.map((r, i) =>
        i === 0 ? { ...r, event: false, censorReason: 'endpoint corrected after QC' } : r,
      ),
    }),
  }).then((r) => r.json());
  say('revision => frozen snapshot v2', { versionId: revised.versionId, version: revised.version });

  // Demonstrate an explicit failure code: mixing a bad tau.
  const bad = await fetch(url(`/versions/${created.versionId}/analyses`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ group: 'control', tau: 99999 }),
  });
  say('expected failure (TAU_TOO_LARGE)', { status: bad.status, body: await bad.json() });

  say('done', { db: resolve(dir, 'demo.sqlite'), note: 're-run `npm run demo` for identical numeric output' });
} finally {
  server.close();
  db.close();
}
