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
    this.db.exec(schemaSql);
    ensureTaskColumns(this.db);
    ensureTaskDraftColumns(this.db);
  }

  close(): void {
    this.db.close();
  }
}

export function ensureTaskDraftColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(task_drafts)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of taskDraftColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE task_drafts ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function ensureTaskColumns(db: DatabaseSync): void {
  const columns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of taskColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
  }
}
