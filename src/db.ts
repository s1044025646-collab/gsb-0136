import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let dbInstance: DatabaseSync | null = null;

/** Idempotent migrations; safe to run on every startup. */
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      time_unit TEXT NOT NULL,
      observation_window TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dataset_versions (
      id INTEGER PRIMARY KEY,
      dataset_id INTEGER NOT NULL REFERENCES datasets(id),
      version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      change_note TEXT NOT NULL,
      UNIQUE(dataset_id, version)
    );
    CREATE TABLE IF NOT EXISTS observations (
      version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      subject_id TEXT NOT NULL,
      grp TEXT NOT NULL,
      time REAL NOT NULL,
      event INTEGER NOT NULL,
      censor_reason TEXT,
      PRIMARY KEY (version_id, subject_id, grp)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY,
      version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      grp TEXT NOT NULL,
      ci_method TEXT NOT NULL,
      tau REAL,
      params_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(version_id, grp, params_hash)
    );
    CREATE TABLE IF NOT EXISTS comparisons (
      id INTEGER PRIMARY KEY,
      version_id INTEGER NOT NULL REFERENCES dataset_versions(id),
      group1 TEXT NOT NULL,
      group2 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(version_id, group1, group2)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY,
      analysis_id INTEGER REFERENCES analyses(id),
      comparison_id INTEGER REFERENCES comparisons(id),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

export function getDb(path: string): DatabaseSync {
  if (!dbInstance) dbInstance = openDb(path);
  return dbInstance;
}

export function resetDbInstance(): void {
  dbInstance = null;
}

/** Deterministic injected time so tests/demos are reproducible. */
export type Clock = () => Date;

export function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
