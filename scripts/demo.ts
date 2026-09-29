// Reproducible end-to-end demo: synthetic parts -> SQLite snapshot ->
// KM curves, risk table, censoring explanation, log-rank, frozen report export.
// Everything is written under ./tmp and ./data inside this project.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, defaultClock } from "../src/db/database.js";
import { Repository } from "../src/db/repository.js";
import { AnalysisService } from "../src/service.js";
import { generateParts } from "../src/synthetic.js";
import { writeFileSync } from "node:fs";

const dbPath = resolve("tmp/demo.db");
for (const suffix of ["", "-wal", "-shm"]) {
  try { rmSync(dbPath + suffix); } catch { /* first run */ }
}

const db = openDatabase(dbPath);
const service = new AnalysisService(new Repository(db, defaultClock), defaultClock);

console.log("== 1. generate reproducible synthetic part lifetimes (seed=20260929) ==");
const subjects = generateParts({
  perGroup: 24,
  groups: [
    { label: "alloy-A", failureRate: 0.012 },
    { label: "alloy-B", failureRate: 0.03 },
  ],
  censorRate: 0.006,
  maxTime: 240,
  seed: 20260929,
});
writeFileSync(resolve("tmp/demo-subjects.json"), JSON.stringify(subjects, null, 2));
console.log(`   wrote ${subjects.length} records to tmp/demo-subjects.json`);

console.log("== 2. create dataset and freeze an immutable snapshot ==");
const ds = service.createDataset("demo-shafts", "hours", "reproducible demo dataset");
const { version } = service.freezeVersion(ds.id, subjects, "initial frozen snapshot", {
  idempotencyKey: "demo-v1",
});
console.log(`   dataset #${ds.id}, frozen version v${version.version} (n=${version.subject_count})`);

console.log("== 3. Kaplan-Meier curves + RMST + median ==");
for (const group of ["alloy-A", "alloy-B"]) {
  const { result } = service.curve(ds.id, { group, horizon: 200, ciMethod: "loglog" });
  console.log(
    `   ${group}: n=${result.n} events=${result.events} median=${
      result.medianSurvival === null ? "NOT REACHED" : result.medianSurvival
    } RMST(200)=${result.rmst?.toFixed(2)}`
  );
}

console.log("== 4. censoring explanation ==");
const { impact } = service.censoring(ds.id);
console.log(`   ${impact.censored}/${impact.total} censored; ${impact.explanation.split(".")[0]}.`);

console.log("== 5. two-group log-rank comparison (one frozen snapshot, same unit) ==");
const cmp = service.compare(ds.id, "alloy-A", "alloy-B");
console.log(
  `   O_A=${cmp.result.observedA} E_A=${cmp.result.expectedA.toFixed(3)} ` +
    `V=${cmp.result.variance.toFixed(4)} chi2=${cmp.result.chiSquare?.toFixed(4)} p=${cmp.result.pValue?.toExponential(2)}`
);

const curve = service.curve(ds.id, { group: "alloy-A", horizon: 200 });
const report = service.getReport(curve.reportId);
writeFileSync(
  resolve("tmp/demo-report.json"),
  JSON.stringify(
    {
      reportId: report.id,
      versionId: report.version_id,
      kind: report.kind,
      params: JSON.parse(report.params_json),
      result: JSON.parse(report.result_json),
      frozen: true,
    },
    null,
    2
  )
);
console.log("== 6. frozen report exported to tmp/demo-report.json ==");
console.log("DONE. Re-running this script produces identical output.");
db.close();
