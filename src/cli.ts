import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getDb } from './db.js';
import {
  addVersion,
  createDataset,
  findDatasetByName,
  getVersion,
  listRows,
} from './repo.js';
import { validateDatasetInput } from './validate.js';
import { analyzeGroup, compareGroups, explainCensoring, loadFrozen } from './service.js';
import { generateLifetimes, type GroupSpec } from './generator.js';
import { AppError } from './errors.js';

const dbPath = process.env.LIFETABLE_DB
  ? resolve(process.env.LIFETABLE_DB)
  : resolve('data/lifetable.sqlite');
const db = getDb(dbPath);
const clock = () => new Date();

const fmt = (x: number, d = 4): string => (Number.isFinite(x) ? x.toFixed(d) : '  NA  ');

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new AppError('VALIDATION', 'CSV needs a header row and at least one data row');
  const headers = lines[0]!.split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

function rowsFromCsv(path: string) {
  const raw = parseCsv(readFileSync(path, 'utf8'));
  return raw.map((r) => ({
    subjectId: r.subjectId ?? '',
    group: r.group ?? '',
    time: Number(r.time),
    event: r.event === '1' || r.event?.toLowerCase() === 'true' || r.event?.toLowerCase() === 'event',
    censorReason: r.censorReason || undefined,
  }));
}

function datasetSummary(versionId: number): string {
  const meta = getVersion(db, versionId);
  const rows = listRows(db, versionId);
  const groups = [...new Set(rows.map((r) => r.group))].sort();
  return `dataset="${meta?.name}" v${meta?.version} (id=${versionId}), unit=${meta?.timeUnit}, rows=${rows.length}, groups=[${groups.join(', ')}]`;
}

function cmdImport(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      file: { type: 'string' },
      name: { type: 'string' },
      unit: { type: 'string', default: 'hours' },
      window: { type: 'string', default: 'single-event' },
      note: { type: 'string', default: 'revised snapshot' },
    },
    allowPositionals: false,
  });
  if (!values.file || !values.name) throw new AppError('VALIDATION', '--file and --name are required');
  const data = validateDatasetInput({
    name: values.name,
    timeUnit: values.unit,
    observationWindow: values.window,
    rows: rowsFromCsv(values.file),
  });
  const before = findDatasetByName(db, data.name);
  console.log(`BEFORE: dataset "${data.name}" ${before ? `exists (id=${before})` : 'does not exist'}; rows in file=${data.rows.length}`);
  let v;
  if (before) v = addVersion(db, before, data, clock, values.note);
  else v = createDataset(db, data, clock);
  console.log(`AFTER:  ${datasetSummary(v.versionId)}; content=${v.contentHash.slice(0, 12)}`);
}

function resolveVersion(datasetName: string | undefined, versionId: string | undefined): number {
  if (versionId) return Number(versionId);
  if (!datasetName) throw new AppError('VALIDATION', 'provide --version or --dataset');
  const id = findDatasetByName(db, datasetName);
  if (!id) throw new AppError('NOT_FOUND', `dataset "${datasetName}" not found`);
  const row = db
    .prepare('SELECT MAX(id) AS id FROM dataset_versions WHERE dataset_id = ?')
    .get(id) as { id: number };
  return row.id;
}

function cmdCurve(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: 'string' },
      version: { type: 'string' },
      group: { type: 'string' },
      ci: { type: 'string', default: 'log-log' },
      tau: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const versionId = resolveVersion(values.dataset, values.version);
  console.log(`BEFORE: ${datasetSummary(versionId)}`);
  if (!values.group) throw new AppError('VALIDATION', '--group is required');
  const result = analyzeGroup(db, versionId, values.group, {
    ci: values.ci === 'linear' ? 'linear' : 'log-log',
    tau: values.tau ? Number(values.tau) : null,
    clock,
  });
  console.log(`AFTER:  analyzed group="${values.group}"; report id=${result.stored?.reportId}`);
  console.log(`n=${result.n} events=${result.events} censored=${result.censored}`);
  console.log(
    `median: ${result.median.reached ? result.median.value : `NOT REACHED (${result.median.note})`}`,
  );
  if (result.rmst) console.log(`RMST(tau=${result.rmst.tau})=${fmt(result.rmst.rmst)} lost=${fmt(result.rmst.lost)}`);
  console.log('time     nRisk  events  censor  S(t)     SE       CI95lo   CI95hi');
  for (const p of result.curve) {
    console.log(
      `${fmt(p.time, 2).padStart(7)} ${String(p.atRisk).padStart(6)} ${String(p.events).padStart(6)} ${String(p.censored).padStart(6)}  ${fmt(p.survival)} ${fmt(p.se)} ${fmt(p.ciLower)} ${fmt(p.ciUpper)}`,
    );
  }
  if (values.out) {
    mkdirSync(resolve(values.out, '..'), { recursive: true });
    writeFileSync(values.out, JSON.stringify(result, null, 2));
    console.log(`exported frozen report -> ${values.out}`);
  }
}

function cmdRiskTable(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { dataset: { type: 'string' }, version: { type: 'string' }, group: { type: 'string' } },
  });
  const versionId = resolveVersion(values.dataset, values.version);
  const { rows } = loadFrozen(db, versionId);
  const groups = values.group ? [values.group] : [...new Set(rows.map((r) => r.group))].sort();
  console.log(datasetSummary(versionId));
  for (const group of groups) {
    const gr = rows.filter((r) => r.group === group);
    const times = [...new Set(gr.map((r) => r.time))].sort((a, b) => a - b);
    let atRisk = gr.length;
    console.log(`\n== ${group} (n=${gr.length}) ==`);
    console.log('time     nRisk  events  censor  nAfter');
    for (const t of times) {
      const d = gr.filter((r) => r.time === t && r.event).length;
      const c = gr.filter((r) => r.time === t && !r.event).length;
      console.log(`${fmt(t, 2).padStart(7)} ${String(atRisk).padStart(6)} ${String(d).padStart(6)} ${String(c).padStart(6)}  ${String(atRisk - d - c).padStart(6)}`);
      atRisk -= d + c;
    }
  }
}

function cmdCompare(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      dataset: { type: 'string' },
      version: { type: 'string' },
      group1: { type: 'string' },
      group2: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const versionId = resolveVersion(values.dataset, values.version);
  console.log(`BEFORE: ${datasetSummary(versionId)}`);
  if (!values.group1 || !values.group2) throw new AppError('VALIDATION', '--group1 and --group2 are required');
  const result = compareGroups(db, versionId, values.group1, { group2: values.group2, clock });
  console.log(`AFTER:  log-rank report id=${result.stored?.reportId}`);
  const t1 = result.table.group1;
  const t2 = result.table.group2;
  console.log(`group        n     observed(O)  expected(E)  O-E`);
  console.log(`${t1.group.padEnd(12)}${String(t1.n).padStart(5)} ${fmt(t1.observed, 2).padStart(11)} ${fmt(t1.expected, 3).padStart(11)} ${fmt(t1.observed - t1.expected, 3).padStart(8)}`);
  console.log(`${t2.group.padEnd(12)}${String(t2.n).padStart(5)} ${fmt(t2.observed, 2).padStart(11)} ${fmt(t2.expected, 3).padStart(11)} ${fmt(t2.observed - t2.expected, 3).padStart(8)}`);
  console.log(`variance V=${fmt(result.table.variance, 5)}`);
  console.log(`chi2(1)=${fmt(result.chiSquare)}  p=${fmt(result.pValue)}`);
  if (values.out) {
    mkdirSync(resolve(values.out, '..'), { recursive: true });
    writeFileSync(values.out, JSON.stringify(result, null, 2));
    console.log(`exported frozen report -> ${values.out}`);
  }
}

function cmdCensoring(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: { dataset: { type: 'string' }, version: { type: 'string' }, group: { type: 'string' } },
  });
  const versionId = resolveVersion(values.dataset, values.version);
  const { rows } = loadFrozen(db, versionId);
  const scoped = values.group ? rows.filter((r) => r.group === values.group) : rows;
  if (values.group && scoped.length === 0) throw new AppError('GROUP_MISSING', `group "${values.group}" not found`);
  const impact = explainCensoring(scoped);
  console.log(datasetSummary(versionId) + (values.group ? ` group="${values.group}"` : ''));
  console.log(`censored=${impact.censored}/${impact.n} (${(impact.censorRate * 100).toFixed(1)}%), events=${impact.events}, max t=${impact.maxObservedTime}, tail censored=${impact.tailCensored}`);
  console.log('reasons:', impact.reasons.map((r) => `${r.reason} x${r.count}`).join('; ') || '(none)');
  for (const line of impact.explanation) console.log(`- ${line}`);
}

function cmdGenerate(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      seed: { type: 'string', default: '42' },
      out: { type: 'string' },
      'zero-event': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  // positionals like A:20:0.1:0.3 B:20:0.3:0.3  => name:n:lambda:censorProb
  const specs: GroupSpec[] = positionals.map((token) => {
    const [name, n, lambda, censorProb] = token.split(':');
    return { name: name!, n: Number(n), lambda: Number(lambda), censorProbability: censorProb ? Number(censorProb) : 0 };
  });
  if (specs.length === 0) throw new AppError('VALIDATION', 'provide at least one NAME:N:LAMBDA[:CENSORPROB]');
  const rows = generateLifetimes(specs, { seed: Number(values.seed), includeZeroTimeEvent: values['zero-event'] });
  const csv = ['subjectId,group,time,event,censorReason'];
  for (const r of rows) csv.push(`${r.subjectId},${r.group},${r.time},${r.event ? 1 : 0},${r.event ? '' : r.censorReason ?? ''}`);
  const text = csv.join('\n') + '\n';
  if (values.out) {
    mkdirSync(resolve(values.out, '..'), { recursive: true });
    writeFileSync(values.out, text);
    console.log(`generated ${rows.length} rows (seed=${values.seed}) -> ${values.out}`);
  } else {
    process.stdout.write(text);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case 'import': return cmdImport(rest);
      case 'curve': return cmdCurve(rest);
      case 'risk-table': return cmdRiskTable(rest);
      case 'compare': return cmdCompare(rest);
      case 'censoring': return cmdCensoring(rest);
      case 'generate': return cmdGenerate(rest);
      default:
        console.log(
          [
            'usage: cli <command> [options]',
            '  generate NAME:N:LAMBDA[:CENSORPROB]... [--seed N] [--zero-event] [--out f.csv]',
            '  import --file f.csv --name DS [--unit hours] [--note "..."]',
            '  curve --dataset DS | --version ID --group G [--ci log-log|linear] [--tau T] [--out r.json]',
            '  risk-table --dataset DS | --version ID [--group G]',
            '  compare --dataset DS | --version ID --group1 A --group2 B [--out r.json]',
            '  censoring --dataset DS | --version ID [--group G]',
          ].join('\n'),
        );
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`ERROR [${err.code}] ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

main();
