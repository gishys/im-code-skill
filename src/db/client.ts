import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schemaSql } from "./schema.js";

const taskColumns = [
  ["thread_id", "TEXT REFERENCES delivery_threads(id) ON DELETE SET NULL"],
  ["changeset_id", "TEXT REFERENCES changesets(id) ON DELETE SET NULL"],
  ["current_plan_version_id", "TEXT"],
  ["delivery_status", "TEXT NOT NULL DEFAULT 'active'"],
  ["execution_mode", "TEXT NOT NULL DEFAULT 'agent'"],
  ["plan_summary", "TEXT"],
  ["plan_artifact_path", "TEXT"]
] as const;

const taskDraftColumns = [["form_token", "TEXT NOT NULL DEFAULT ''"]] as const;

export class DbClient {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    prepareLegacySchema(this.db);
    ensureTaskColumns(this.db);
    ensureTaskDraftColumns(this.db);
    this.db.exec(schemaSql);
  }

  close(): void {
    this.db.close();
  }
}

function prepareLegacySchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS delivery_threads (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'feishu',
      project_name TEXT NOT NULL,
      goal_summary TEXT NOT NULL,
      feishu_chat_id TEXT,
      feishu_user_id TEXT,
      status TEXT NOT NULL,
      current_changeset_id TEXT,
      current_pull_request_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS changesets (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES delivery_threads(id) ON DELETE CASCADE,
      project_name TEXT NOT NULL,
      branch TEXT,
      commit_sha TEXT,
      artifact_path TEXT,
      test_summary TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function ensureTaskDraftColumns(db: DatabaseSync): void {
  if (!tableExists(db, "task_drafts")) {
    return;
  }
  const columns = new Set((db.prepare("PRAGMA table_info(task_drafts)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of taskDraftColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE task_drafts ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function ensureTaskColumns(db: DatabaseSync): void {
  if (!tableExists(db, "tasks")) {
    return;
  }
  const columns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of taskColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
