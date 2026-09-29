import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pExec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const dir = join(tmpdir(), `lifetable-cli-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const db = join(dir, 'demo.sqlite');
const csv = join(dir, 'parts.csv');
const out = join(dir, 'report.json');

const run = async (args: string[]) => {
  const res = await pExec(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
    cwd: root,
    env: { ...process.env, LIFETABLE_DB: db },
  });
  return res.stdout as string;
}

const runFail = async (args: string[]) => {
  await assert.rejects(
    pExec(process.execPath, [tsxCli, 'src/cli.ts', ...args], {
      cwd: root,
      env: { ...process.env, LIFETABLE_DB: db },
    }),
  );
};

test('full CLI workflow: generate, import, curve, risk table, compare, censoring, export', async () => {
  const gen = await run([
    'generate',
    'control:12:0.05:0.25',
    'treated:12:0.02:0.25',
    '--seed',
    '7',
    '--out',
    csv,
  ]);
  assert.match(gen, /generated 24 rows/);
  assert.ok(existsSync(csv));

  const imp = await run(['import', '--file', csv, '--name', 'demo', '--unit', 'hours']);
  assert.match(imp, /BEFORE: dataset "demo" does not exist/);
  assert.match(imp, /AFTER:  dataset="demo" v1/);

  // Reproducible generator: same seed -> identical file content.
  const csv2 = join(dir, 'parts2.csv');
  await run(['generate', 'control:12:0.05:0.25', 'treated:12:0.02:0.25', '--seed', '7', '--out', csv2]);
  assert.equal(readFileSync(csv, 'utf8'), readFileSync(csv2, 'utf8'));

  // Idempotent repeat import -> still v1.
  const imp2 = await run(['import', '--file', csv2, '--name', 'demo', '--unit', 'hours']);
  assert.match(imp2, /v1/);

  const curve = await run(['curve', '--dataset', 'demo', '--group', 'control', '--tau', '10', '--out', out]);
  assert.match(curve, /BEFORE: dataset="demo" v1/);
  assert.match(curve, /AFTER:  analyzed group="control"/);
  assert.match(curve, /RMST\(tau=10\)=/);
  assert.match(curve, /nRisk/);
  assert.ok(existsSync(out));
  const report = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(report.kind, 'km-analysis');
  assert.equal(report.frozenAt.timeUnit, 'hours');
  assert.ok(Array.isArray(report.curve));

  const risk = await run(['risk-table', '--dataset', 'demo']);
  assert.match(risk, /== control/);
  assert.match(risk, /== treated/);

  const cmp = await run(['compare', '--dataset', 'demo', '--group1', 'control', '--group2', 'treated']);
  assert.match(cmp, /observed\(O\)/);
  assert.match(cmp, /chi2\(1\)=/);

  const cen = await run(['censoring', '--dataset', 'demo', '--group', 'treated']);
  assert.match(cen, /censored=/);
  assert.match(cen, /never counted as failures/);

  // Restart reproducibility: a fresh invocation reads the same persisted state.
  const riskAgain = await run(['risk-table', '--dataset', 'demo']);
  assert.equal(riskAgain, risk);
});

test('CLI failure paths exit non-zero with clear codes', async () => {
  await runFail(['curve', '--dataset', 'demo', '--group', 'ghost']);
  await runFail(['compare', '--dataset', 'demo', '--group1', 'control', '--group2', 'ghost']);
  const badCsv = join(dir, 'bad.csv');
  writeFileSync(badCsv, 'subjectId,group,time,event\nx,A,-1,1\n');
  await runFail(['import', '--file', badCsv, '--name', 'bad']);
});
