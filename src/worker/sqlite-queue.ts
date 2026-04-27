import type { DatabaseSync } from "node:sqlite";
import type { TaskRecord } from "../types.js";
import { TaskService } from "../task/service.js";

export class SqliteQueue {
  private readonly tasks: TaskService;

  constructor(private readonly db: DatabaseSync) {
    this.tasks = new TaskService(db);
  }

  claimNext(workerId: string, lockTimeoutSeconds: number): TaskRecord | undefined {
    const cutoff = new Date(Date.now() - lockTimeoutSeconds * 1000).toISOString();
    const row = this.db
      .prepare(
        `SELECT id FROM tasks
         WHERE status = 'queued'
            OR (status = 'running' AND heartbeat_at < ?)
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(cutoff) as { id: string } | undefined;

    if (!row) {
      return undefined;
    }

    this.tasks.markRunning(row.id, workerId);
    return this.tasks.getTask(row.id);
  }

  heartbeat(taskId: string, workerId: string): void {
    this.db
      .prepare("UPDATE tasks SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND locked_by = ?")
      .run(new Date().toISOString(), new Date().toISOString(), taskId, workerId);
  }

  recoverInterrupted(lockTimeoutSeconds: number): number {
    const cutoff = new Date(Date.now() - lockTimeoutSeconds * 1000).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'interrupted', current_stage = 'failed', updated_at = ?, finished_at = ?
         WHERE status = 'running' AND heartbeat_at < ?`
      )
      .run(new Date().toISOString(), new Date().toISOString(), cutoff);
    return Number(result.changes);
  }
}
