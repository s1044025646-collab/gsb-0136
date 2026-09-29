import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, defaultClock } from "../db/database.js";
import { Repository } from "../db/repository.js";
import { generateParts } from "../synthetic.js";
import { AnalysisService } from "../service.js";
import type { SubjectInput, TimeUnit } from "../types.js";

export interface CliContext {
  dbPath: string;
}

function withService<T>(ctx: CliContext, fn: (service: AnalysisService) => T): T {
  const db = openDatabase(ctx.dbPath);
  try {
    const service = new AnalysisService(new Repository(db, defaultClock), defaultClock);
    return fn(service);
  } finally {
    db.close();
  }
}

function parseSubjectFile(file: string): SubjectInput[] {
  const raw = readFileSync(resolve(file), "utf8").trim();
  if (!raw) throw new Error(`input file ${file} is empty`);
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed.subjects;
    if (!Array.isArray(arr)) throw new Error("JSON input must be an array or { subjects: [...] }");
    return arr as SubjectInput[];
  }
  // CSV: anon_id,group,time,status,censor_reason
  const lines = raw.split(/\r?\n/);
  const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  if (idx("anon_id") < 0 || idx("group") < 0 || idx("time") < 0 || idx("status") < 0) {
    throw new Error("CSV header must include anon_id,group,time,status[,censor_reason]");
  }
  return lines.slice(1).filter((l) => l.trim() !== "").map((line) => {
    const cols = line.split(",");
    const reasonIdx = idx("censor_reason");
    const reason = reasonIdx >= 0 ? cols[reasonIdx]?.trim() : "";
    return {
      anonId: cols[idx("anon_id")]!.trim(),
      group: cols[idx("group")]!.trim(),
      time: Number(cols[idx("time")]),
      status: cols[idx("status")]!.trim() as "event" | "censored",
      censorReason: reason || null,
    };
  });
}

export function cmdInit(ctx: CliContext, args: string[]): void {
  const name = requireArg(args, "--name");
  const unit = requireArg(args, "--unit") as TimeUnit;
  const desc = optionalArg(args, "--desc") ?? "";
  withService(ctx, (service) => {
    console.log(`[before] database: ${ctx.dbPath}`);
    const row = service.createDataset(name, unit, desc);
    console.log(`[after]  dataset #${row.id} '${row.name}' unit=${row.time_unit} version=${row.current_version}`);
  });
}

export function cmdList(ctx: CliContext, args: string[]): void {
  const limit = Number(optionalArg(args, "--limit") ?? "50");
  const offset = Number(optionalArg(args, "--offset") ?? "0");
  withService(ctx, (service) => {
    const page = service.listDatasets(limit, offset);
    console.log(`datasets ${page.offset + 1}-${page.offset + page.items.length} of ${page.total}`);
    for (const d of page.items) {
      console.log(`  #${d.id} ${d.name} [${d.time_unit}] current=v${d.current_version}`);
    }
  });
}

export function cmdImport(ctx: CliContext, args: string[]): void {
  const datasetId = Number(requireArg(args, "--dataset"));
  const file = requireArg(args, "--file");
  const note = optionalArg(args, "--note") ?? "imported snapshot";
  const expectedVersion = optionalArg(args, "--expected-version");
  const idempotencyKey = optionalArg(args, "--idempotency-key") ?? `import:${file}`;
  const subjects = parseSubjectFile(file);
  withService(ctx, (service) => {
    const before = service.getDataset(datasetId);
    console.log(`[before] dataset #${datasetId} current=v${before.current_version}, importing ${subjects.length} subjects from ${file}`);
    const { version, created } = service.freezeVersion(
      datasetId,
      subjects,
      note,
      {
        expectedVersion: expectedVersion === undefined ? undefined : Number(expectedVersion),
        idempotencyKey,
      }
    );
    console.log(
      `[after]  ${created ? "froze" : "idempotent replay of"} v${version.version}: n=${version.subject_count} events=${version.event_count} censored=${version.censor_count}`
    );
  });
}

export function cmdGenerate(ctx: CliContext, args: string[]): void {
  const seed = Number(optionalArg(args, "--seed") ?? "1");
  const perGroup = Number(optionalArg(args, "--per-group") ?? "20");
  const censorRate = Number(optionalArg(args, "--censor-rate") ?? "0.05");
  const maxTime = Number(optionalArg(args, "--max-time") ?? "100");
  const ratesArg = optionalArg(args, "--rates") ?? "A:0.02,B:0.05";
  const out = optionalArg(args, "--out") ?? "tmp/generated.json";
  const groups = ratesArg.split(",").map((part) => {
    const [label, rate] = part.split(":");
    return { label: label!.trim(), failureRate: Number(rate) };
  });
  const subjects = generateParts({ perGroup, groups, censorRate, maxTime, seed });
  writeFileSync(resolve(out), JSON.stringify(subjects, null, 2));
  console.log(`generated ${subjects.length} synthetic part records (seed=${seed}) -> ${out}`);
  void ctx;
}

export function cmdCurve(ctx: CliContext, args: string[]): void {
  const datasetId = Number(requireArg(args, "--dataset"));
  const group = requireArg(args, "--group");
  const version = optionalArg(args, "--version");
  const horizon = optionalArg(args, "--horizon");
  const ciMethod = (optionalArg(args, "--ci") ?? "loglog") as "loglog" | "linear";
  withService(ctx, (service) => {
    console.log(`[before] dataset #${datasetId}, computing KM curve for group '${group}' on frozen snapshot`);
    const { result, reportId, version: v } = service.curve(datasetId, {
      group,
      version: version === undefined ? undefined : Number(version),
      ciMethod,
      horizon: horizon === undefined ? null : Number(horizon),
    });
    console.log(`[after]  report #${reportId} on v${v}: n=${result.n} events=${result.events} censored=${result.censored}`);
    console.log("  t      nRisk  d    c    S(t)   CI95");
    for (const p of result.points) {
      console.log(
        `  ${p.t.toFixed(2).padStart(6)} ${String(p.nAtRisk).padStart(5)} ${String(p.dEvents).padStart(4)} ${String(p.cCensored).padStart(4)} ${p.sAfter.toFixed(4).padStart(6)} [${p.ciLower.toFixed(3)}, ${p.ciUpper.toFixed(3)}]`
      );
    }
    console.log(
      result.medianSurvival === null
        ? `  median: NOT REACHED (${result.medianNote})`
        : `  median: ${result.medianSurvival}`
    );
    console.log(`  RMST(${result.rmstHorizon}) = ${result.rmst?.toFixed(4)} ${result.timeUnit}`);
  });
}

export function cmdRiskTable(ctx: CliContext, args: string[]): void {
  const datasetId = Number(requireArg(args, "--dataset"));
  const group = requireArg(args, "--group");
  const version = optionalArg(args, "--version");
  withService(ctx, (service) => {
    const { points } = service.riskTable(
      datasetId,
      group,
      version === undefined ? undefined : Number(version)
    );
    console.log("time\tnRisk\tevents\tcensored\tS_before\tS_after");
    for (const p of points) {
      console.log(
        [p.t, p.nAtRisk, p.dEvents, p.cCensored, p.sBefore.toFixed(5), p.sAfter.toFixed(5)].join("\t")
      );
    }
  });
}

export function cmdCompare(ctx: CliContext, args: string[]): void {
  const datasetId = Number(requireArg(args, "--dataset"));
  const groupA = requireArg(args, "--a");
  const groupB = requireArg(args, "--b");
  const version = optionalArg(args, "--version");
  withService(ctx, (service) => {
    console.log(`[before] log-rank '${groupA}' vs '${groupB}' on one frozen snapshot (same unit & origin)`);
    const { result, reportId, version: v } = service.compare(
      datasetId,
      groupA,
      groupB,
      version === undefined ? undefined : Number(version)
    );
    console.log(`[after]  report #${reportId} on v${v}`);
    console.log(`  O_${groupA}=${result.observedA} E_${groupA}=${result.expectedA.toFixed(4)}`);
    console.log(`  O_${groupB}=${result.observedB} E_${groupB}=${result.expectedB.toFixed(4)}`);
    console.log(`  variance V=${result.variance.toFixed(6)}`);
    if (result.chiSquare === null) {
      console.log(`  chi-square: undefined — ${result.note}`);
    } else {
      console.log(`  chi2(1)=${result.chiSquare.toFixed(4)} p=${result.pValue?.toFixed(6)}`);
    }
  });
}

export function cmdCensoring(ctx: CliContext, args: string[]): void {
  const datasetId = Number(requireArg(args, "--dataset"));
  const group = optionalArg(args, "--group");
  const version = optionalArg(args, "--version");
  withService(ctx, (service) => {
    const { impact } = service.censoring(
      datasetId,
      group,
      version === undefined ? undefined : Number(version)
    );
    console.log(`censored ${impact.censored}/${impact.total} (${(impact.censorRate * 100).toFixed(1)}%)`);
    for (const r of impact.censorReasons) console.log(`  ${r.reason}: ${r.count}`);
    console.log(impact.explanation);
  });
}

export function cmdExportReport(ctx: CliContext, args: string[]): void {
  const reportId = Number(requireArg(args, "--id"));
  const out = requireArg(args, "--out");
  withService(ctx, (service) => {
    const row = service.getReport(reportId);
    const payload = {
      reportId: row.id,
      versionId: row.version_id,
      kind: row.kind,
      params: JSON.parse(row.params_json),
      result: JSON.parse(row.result_json),
      frozen: true,
    };
    writeFileSync(resolve(out), JSON.stringify(payload, null, 2));
    console.log(`exported frozen ${row.kind} report #${row.id} -> ${out}`);
  });
}

function requireArg(args: string[], name: string): string {
  const value = optionalArg(args, name);
  if (value === undefined) throw new Error(`missing required argument ${name}`);
  return value;
}

function optionalArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}
