import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schemaSql } from "./schema.js";

const taskColumns = [
  ["execution_mode", "TEXT NOT NULL DEFAULT 'agent'"],
  ["plan_summary", "TEXT"],
  ["plan_artifact_path", "TEXT"]
] as const;

export class DbClient {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(schemaSql);
    ensureTaskColumns(this.db);
  }

  close(): void {
    this.db.close();
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
