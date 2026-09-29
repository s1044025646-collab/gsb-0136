import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../errors.js";
import type { SubjectInput, TimeUnit } from "../types.js";
import type { Clock } from "./database.js";

export interface DatasetRecord {
  id: number;
  name: string;
  time_unit: TimeUnit;
  current_version: number;
  description: string;
  created_at: string;
}

export interface VersionRecord {
  id: number;
  dataset_id: number;
  version: number;
  frozen_at: string;
  change_note: string;
  subject_count: number;
  event_count: number;
  censor_count: number;
}

export interface SubjectRecord {
  id: number;
  version_id: number;
  anon_id: string;
  group_label: string;
  time: number;
  status: "event" | "censored";
  censor_reason: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

const VALID_UNITS: TimeUnit[] = ["hours", "cycles", "days", "weeks"];

export function validateSubjects(subjects: SubjectInput[]): void {
  if (!Array.isArray(subjects) || subjects.length === 0) {
    throw new AppError("VALIDATION_ERROR", "subjects must be a non-empty array");
  }
  const seen = new Set<string>();
  subjects.forEach((s, i) => {
    const where = `subjects[${i}]`;
    if (!s || typeof s.anonId !== "string" || s.anonId.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `${where}.anonId is required`);
    }
    if (typeof s.group !== "string" || s.group.trim() === "") {
      throw new AppError("VALIDATION_ERROR", `${where}.group is required`);
    }
    if (typeof s.time !== "number" || !Number.isFinite(s.time) || s.time < 0) {
      throw new AppError("VALIDATION_ERROR", `${where}.time must be a finite number >= 0`);
    }
    if (s.status !== "event" && s.status !== "censored") {
      throw new AppError("VALIDATION_ERROR", `${where}.status must be 'event' or 'censored'`);
    }
    if (s.status === "censored" && (typeof s.censorReason !== "string" || s.censorReason.trim() === "")) {
      throw new AppError("VALIDATION_ERROR", `${where}.censorReason is required for censored subjects`);
    }
    if (s.status === "event" && s.censorReason != null && s.censorReason !== "") {
      throw new AppError("VALIDATION_ERROR", `${where}.censorReason must be empty for events`);
    }
    if (seen.has(s.anonId)) {
      throw new AppError("DUPLICATE_SUBJECT", `duplicate anonId within import: ${s.anonId}`);
    }
    seen.add(s.anonId);
  });
}

export class Repository {
  constructor(private readonly db: DatabaseSync, private readonly clock: Clock) {}

  createDataset(name: string, timeUnit: TimeUnit, description = ""): DatasetRecord {
    if (typeof name !== "string" || name.trim() === "") {
      throw new AppError("VALIDATION_ERROR", "dataset name is required");
    }
    if (!VALID_UNITS.includes(timeUnit)) {
      throw new AppError("VALIDATION_ERROR", `timeUnit must be one of ${VALID_UNITS.join(", ")}`);
    }
    const info = this.db
      .prepare(
        "INSERT INTO datasets (name, time_unit, description, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(name.trim(), timeUnit, description, this.clock.now().toISOString());
    return this.getDataset(Number(info.lastInsertRowid));
  }

 getDataset(id: number): DatasetRecord {
    const row = this.db.prepare("SELECT * FROM datasets WHERE id = ?").get(id) as
      | DatasetRecord
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `dataset ${id} not found`);
    return row;
  }

  findDatasetByName(name: string): DatasetRecord | undefined {
    return this.db.prepare("SELECT * FROM datasets WHERE name = ?").get(name) as
      | DatasetRecord
      | undefined;
  }

  listDatasets(limit: number, offset: number): Page<DatasetRecord> {
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM datasets").get() as { c: number }).c;
    const items = this.db
      .prepare("SELECT * FROM datasets ORDER BY id LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as DatasetRecord[];
    return { items, total, limit, offset };
  }

  /**
   * Freeze a new immutable version of a dataset from a full subject list.
   * Re-submitting the exact same (dataset, version, subjects) payload is idempotent:
   * it returns the existing snapshot instead of failing.
   */
  freezeVersion(
    datasetId: number,
    subjects: SubjectInput[],
    changeNote: string,
    options: { expectedVersion?: number; idempotencyKey?: string } = {}
  ): { version: VersionRecord; created: boolean } {
    const dataset = this.getDataset(datasetId);
    validateSubjects(subjects);

    // Idempotent replay: a repeated submission with the same key returns the
    // already-frozen snapshot (content must match).
    if (options.idempotencyKey) {
      const prior = this.db
        .prepare("SELECT * FROM dataset_versions WHERE dataset_id = ? AND idempotency_key = ?")
        .get(datasetId, options.idempotencyKey) as VersionRecord | undefined;
      if (prior) {
        if (!this.versionMatches(prior.id, subjects)) {
          throw new AppError(
            "VERSION_CONFLICT",
            `idempotency key ${options.idempotencyKey} reused with different subject data`
          );
        }
        return { version: prior, created: false };
      }
    }

    const nextVersion = dataset.current_version + 1;
    if (options.expectedVersion !== undefined && options.expectedVersion !== nextVersion) {
      throw new AppError(
        "VERSION_CONFLICT",
        `expected next version ${nextVersion}, client sent ${options.expectedVersion}`
      );
    }

    const tx = this.db.prepare("BEGIN");
    tx.run();
    try {
      const eventCount = subjects.filter((s) => s.status === "event").length;
      const censorCount = subjects.length - eventCount;
      const info = this.db
        .prepare(
          `INSERT INTO dataset_versions
             (dataset_id, version, frozen_at, change_note, idempotency_key, subject_count, event_count, censor_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          datasetId,
          nextVersion,
          this.clock.now().toISOString(),
          changeNote,
          options.idempotencyKey ?? null,
          subjects.length,
          eventCount,
          censorCount
        );
      const versionId = Number(info.lastInsertRowid);
      const insertSubject = this.db.prepare(
        `INSERT INTO subjects (version_id, anon_id, group_label, time, status, censor_reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const s of subjects) {
        insertSubject.run(
          versionId,
          s.anonId.trim(),
          s.group.trim(),
          s.time,
          s.status,
          s.status === "censored" ? s.censorReason!.trim() : null
        );
      }
      this.db.prepare("UPDATE datasets SET current_version = ? WHERE id = ?").run(
        nextVersion,
        datasetId
      );
      this.db.prepare("COMMIT").run();
      return { version: this.getVersion(datasetId, nextVersion), created: true };
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  private versionMatches(versionId: number, subjects: SubjectInput[]): boolean {
    const rows = this.listSubjects(versionId);
    if (rows.length !== subjects.length) return false;
    const byId = new Map(rows.map((r) => [r.anon_id, r]));
    return subjects.every((s) => {
      const r = byId.get(s.anonId.trim());
      const expectedReason = s.status === "censored" ? s.censorReason!.trim() : "";
      return (
        r &&
        r.group_label === s.group.trim() &&
        r.time === s.time &&
        r.status === s.status &&
        (r.censor_reason ?? "") === expectedReason
      );
    });
  }

  findVersion(datasetId: number, version: number): VersionRecord | undefined {
    return this.db
      .prepare("SELECT * FROM dataset_versions WHERE dataset_id = ? AND version = ?")
      .get(datasetId, version) as VersionRecord | undefined;
  }

  getVersion(datasetId: number, version: number): VersionRecord {
    const row = this.findVersion(datasetId, version);
    if (!row) throw new AppError("NOT_FOUND", `version ${version} of dataset ${datasetId} not found`);
    return row;
  }

  getCurrentVersion(datasetId: number): VersionRecord {
    const dataset = this.getDataset(datasetId);
    return this.getVersion(datasetId, dataset.current_version);
  }

  listVersions(datasetId: number): VersionRecord[] {
    this.getDataset(datasetId);
    return this.db
      .prepare("SELECT * FROM dataset_versions WHERE dataset_id = ? ORDER BY version")
      .all(datasetId) as unknown as VersionRecord[];
  }

  listSubjects(versionId: number, limit?: number, offset?: number): SubjectRecord[] {
    if (limit === undefined) {
      return this.db
        .prepare("SELECT * FROM subjects WHERE version_id = ? ORDER BY time, id")
        .all(versionId) as unknown as SubjectRecord[];
    }
    return this.db
      .prepare("SELECT * FROM subjects WHERE version_id = ? ORDER BY time, id LIMIT ? OFFSET ?")
      .all(versionId, limit, offset ?? 0) as unknown as SubjectRecord[];
  }

  listSubjectsPage(versionId: number, limit: number, offset: number): Page<SubjectRecord> {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM subjects WHERE version_id = ?").get(versionId) as {
        c: number;
      }
    ).c;
    return { items: this.listSubjects(versionId, limit, offset), total, limit, offset };
  }

  saveReport(
    versionId: number,
    kind: "curve" | "logrank",
    params: unknown,
    result: unknown
  ): { id: number; created: boolean } {
    const requestHash = stableHash(JSON.stringify(params));
    const existing = this.db
      .prepare("SELECT id FROM analyses WHERE version_id = ? AND kind = ? AND request_hash = ?")
      .get(versionId, kind, requestHash) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const info = this.db
      .prepare(
        `INSERT INTO analyses (version_id, created_at, params_json, kind, result_json, request_hash)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        versionId,
        this.clock.now().toISOString(),
        JSON.stringify(params),
        kind,
        JSON.stringify(result),
        requestHash
      );
    return { id: Number(info.lastInsertRowid), created: true };
  }

  listReports(versionId: number, limit: number, offset: number): Page<{
    id: number;
    kind: string;
    created_at: string;
    params_json: string;
  }> {
    const total = (
      this.db.prepare("SELECT COUNT(*) AS c FROM analyses WHERE version_id = ?").get(versionId) as {
        c: number;
      }
    ).c;
    const items = this.db
      .prepare(
        "SELECT id, kind, created_at, params_json FROM analyses WHERE version_id = ? ORDER BY id LIMIT ? OFFSET ?"
      )
      .all(versionId, limit, offset) as {
      id: number;
      kind: string;
      created_at: string;
      params_json: string;
    }[];
    return { items, total, limit, offset };
  }

  getReport(id: number): {
    id: number;
    version_id: number;
    kind: string;
    params_json: string;
    result_json: string;
  } {
    const row = this.db
      .prepare("SELECT id, version_id, kind, params_json, result_json FROM analyses WHERE id = ?")
      .get(id) as
      | { id: number; version_id: number; kind: string; params_json: string; result_json: string }
      | undefined;
    if (!row) throw new AppError("NOT_FOUND", `report ${id} not found`);
    return row;
  }
}

// Small deterministic FNV-1a hash used as an idempotency key (not cryptographic).
export function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
    return h.toString(16).padStart(8, "0");
  }

