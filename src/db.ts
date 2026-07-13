/**
 * SQLite persistence layer (better-sqlite3, WAL mode).
 *
 * One database holds: claims, claim links, audit trail, enforcer session
 * state (JSON blob in kv), and the embedding cache.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  belief REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'asserted'
    CHECK (status IN ('asserted','verified','refuted','committed','retracted')),
  proof_confidence REAL,
  source TEXT,
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS claim_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES claims(id),
  to_id INTEGER NOT NULL REFERENCES claims(id),
  relation TEXT NOT NULL
    CHECK (relation IN ('supports','contradicts','refines','derived_from')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  claim_id INTEGER,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embeddings (
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (hash, model)
);
CREATE TABLE IF NOT EXISTS formalizations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  axioms TEXT NOT NULL,
  conjecture TEXT NOT NULL,
  backend TEXT NOT NULL,
  result TEXT NOT NULL,
  proof_confidence REAL,
  fidelity REAL,
  gloss TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_audit_claim ON audit(claim_id);
CREATE INDEX IF NOT EXISTS idx_formalizations_claim ON formalizations(claim_id);
`;

/** Resolve the database path: EFH_DB_PATH env override, else XDG data dir. */
export function defaultDbPath(): string {
  if (process.env.EFH_DB_PATH) return process.env.EFH_DB_PATH;
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "efh-core", "efh.db");
}

export function openDb(path: string = defaultDbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function kvGet(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function kvSet(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
