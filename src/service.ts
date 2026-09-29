import type { Clock } from "./db/database.js";
import { Repository, type SubjectRecord } from "./db/repository.js";
import { AppError } from "./errors.js";
import { explainCensoring, type CensorImpact } from "./stats/censoring.js";
import { kaplanMeier, type CiMethod, type CurveParams } from "./stats/kaplanMeier.js";
import { logrank } from "./stats/logrank.js";
import type { CurveResult, LogrankResult, SubjectInput, TimeUnit } from "./types.js";

export function toSubjectInput(row: SubjectRecord): SubjectInput {
  return {
    anonId: row.anon_id,
    group: row.group_label,
    time: row.time,
    status: row.status,
    censorReason: row.censor_reason ?? undefined,
  };
}

export class AnalysisService {
  constructor(private readonly repo: Repository, private readonly clock: Clock) {}

  createDataset(name: string, timeUnit: TimeUnit, description?: string) {
    return this.repo.createDataset(name, timeUnit, description);
  }

  freezeVersion(
    datasetId: number,
    subjects: SubjectInput[],
    changeNote: string,
    options?: { expectedVersion?: number; idempotencyKey?: string }
  ) {
    return this.repo.freezeVersion(datasetId, subjects, changeNote, options);
  }

  private loadSnapshot(datasetId: number, version?: number) {
    const versionRow =
      version === undefined
        ? this.repo.getCurrentVersion(datasetId)
        : this.repo.getVersion(datasetId, version);
    const rows = this.repo.listSubjects(versionRow.id);
    return { versionRow, subjects: rows.map(toSubjectInput) };
  }

  curve(datasetId: number, options: {
    group: string;
    version?: number;
    ciMethod?: CiMethod;
    confidenceLevel?: number;
    horizon?: number | null;
  }): { result: CurveResult; reportId: number; created: boolean; version: number } {
    const dataset = this.repo.getDataset(datasetId);
    const { versionRow, subjects } = this.loadSnapshot(datasetId, options.version);
    const params: CurveParams = {
      group: options.group,
      timeUnit: dataset.time_unit,
      ciMethod: options.ciMethod ?? "loglog",
      confidenceLevel: options.confidenceLevel ?? 0.95,
      horizon: options.horizon === undefined ? null : options.horizon,
    };
    if (params.ciMethod !== "loglog" && params.ciMethod !== "linear") {
      throw new AppError("VALIDATION_ERROR", "ciMethod must be 'loglog' or 'linear'");
    }
    const result = kaplanMeier(subjects, params);
    const report = this.repo.saveReport(versionRow.id, "curve", params, result);
    return { result, reportId: report.id, created: report.created, version: versionRow.version };
  }

  compare(datasetId: number, groupA: string, groupB: string, version?: number): {
    result: LogrankResult;
    reportId: number;
    created: boolean;
    version: number;
  } {
    const dataset = this.repo.getDataset(datasetId);
    const { versionRow, subjects } = this.loadSnapshot(datasetId, version);
    const labels = new Set(subjects.map((s) => s.group));
    if (!labels.has(groupA)) throw new AppError("MISSING_GROUP", `group '${groupA}' absent from snapshot`);
    if (!labels.has(groupB)) throw new AppError("MISSING_GROUP", `group '${groupB}' absent from snapshot`);
    // Unit/orientation guard: a single snapshot always uses one time unit and
    // one observation origin (0), so cross-unit mixing is structurally blocked.
    const result = logrank(subjects, groupA, groupB, dataset.time_unit);
    const params = { kind: "logrank", groupA, groupB, timeUnit: dataset.time_unit };
    const report = this.repo.saveReport(versionRow.id, "logrank", params, result);
    return { result, reportId: report.id, created: report.created, version: versionRow.version };
  }

  censoring(datasetId: number, group?: string, version?: number): {
    impact: CensorImpact;
    version: number;
  } {
    const { versionRow, subjects } = this.loadSnapshot(datasetId, version);
    const scoped = group ? subjects.filter((s) => s.group === group) : subjects;
    if (group && scoped.length === 0) {
      throw new AppError("MISSING_GROUP", `group '${group}' absent from snapshot`);
    }
    return { impact: explainCensoring(scoped), version: versionRow.version };
  }

  // Read-only repository pass-through used by the HTTP and CLI layers.
  getDataset(datasetId: number) {
    return this.repo.getDataset(datasetId);
  }

  listDatasets(limit: number, offset: number) {
    return this.repo.listDatasets(limit, offset);
  }

  listVersions(datasetId: number) {
    return this.repo.listVersions(datasetId);
  }

  listSubjectsPage(versionId: number, limit: number, offset: number) {
    return this.repo.listSubjectsPage(versionId, limit, offset);
  }

  listReports(versionId: number, limit: number, offset: number) {
    return this.repo.listReports(versionId, limit, offset);
  }

  getReport(id: number) {
    return this.repo.getReport(id);
  }

  riskTable(datasetId: number, group: string, version?: number) {
    const { result, reportId } = this.curve(datasetId, { group, version });
    return { points: result.points, reportId };
  }
}
