import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./schema.js";

export interface Clock {
  now(): Date;
}

export const defaultClock: Clock = { now: () => new Date() };

export function openDatabase(filePath: string, clock: Clock = defaultClock): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  runMigrations(db, clock);
  return db;
}

export function runMigrations(db: DatabaseSync, clock: Clock = defaultClock): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const appliedRows = db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[];
  const applied = new Set(appliedRows.map((r) => r.id));
  const newlyApplied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    const tx = db.exec.bind(db);
    void tx;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        migration.id,
        clock.now().toISOString()
      );
      db.exec("COMMIT");
      newlyApplied.push(migration.id);
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return newlyApplied;
}
