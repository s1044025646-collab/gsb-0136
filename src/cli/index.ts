#!/usr/bin/env node
import { resolve } from "node:path";
import { cmdCensoring, cmdCompare, cmdCurve, cmdExportReport, cmdGenerate, cmdImport, cmdInit, cmdList, cmdRiskTable, type CliContext } from "./commands.js";

const HELP = `lifetrial — local survival analysis CLI (synthetic part lifetimes)

Usage:
  lifetrial init     --name NAME --unit hours|cycles|days|weeks [--desc TEXT]
  lifetrial list     [--limit N] [--offset N]
  lifetrial generate [--seed N] [--per-group N] [--rates A:0.02,B:0.05]
                     [--censor-rate R] [--max-time T] [--out FILE]
  lifetrial import   --dataset ID --file data.csv|data.json [--note TEXT] [--expected-version V]
  lifetrial curve    --dataset ID --group G [--version V] [--horizon T] [--ci loglog|linear]
  lifetrial risk-table --dataset ID --group G [--version V]
  lifetrial compare  --dataset ID --a G1 --b G2 [--version V]
  lifetrial censoring --dataset ID [--group G] [--version V]
  lifetrial report   --id REPORT_ID --out FILE

Environment:
  LIFETRIAL_DB   SQLite file (default: data/lifetrial.db)

CSV input columns: anon_id,group,time,status,censor_reason
  status is 'event' or 'censored'; censor_reason is required for censored rows.
`;

const ctx: CliContext = {
  dbPath: process.env.LIFETRIAL_DB
    ? resolve(process.env.LIFETRIAL_DB)
    : resolve("data/lifetrial.db"),
};

const [command, ...rest] = process.argv.slice(2);

try {
  switch (command) {
    case "init": cmdInit(ctx, rest); break;
    case "list": cmdList(ctx, rest); break;
    case "import": cmdImport(ctx, rest); break;
    case "generate": cmdGenerate(ctx, rest); break;
    case "curve": cmdCurve(ctx, rest); break;
    case "risk-table": cmdRiskTable(ctx, rest); break;
    case "compare": cmdCompare(ctx, rest); break;
    case "censoring": cmdCensoring(ctx, rest); break;
    case "report": cmdExportReport(ctx, rest); break;
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(2);
  }
} catch (err) {
  const code = typeof err === "object" && err && "code" in err ? `[${(err as { code: string }).code}] ` : "";
  console.error(`error: ${code}${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
