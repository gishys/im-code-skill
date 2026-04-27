import type { DatabaseSync } from "node:sqlite";

export class PollingStateStore {
  constructor(private readonly db: DatabaseSync) {}

  getLastMessageTime(sourceKey: string, lookbackSeconds: number): string {
    const row = this.db
      .prepare("SELECT last_message_time FROM polling_offsets WHERE source_key = ?")
      .get(sourceKey) as { last_message_time: string } | undefined;
    if (row?.last_message_time) {
      return row.last_message_time;
    }
    return String(Math.floor(Date.now() / 1000) - lookbackSeconds);
  }

  update(sourceKey: string, lastMessageTime: string, lastMessageId?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO polling_offsets (source_key, last_message_time, last_message_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET
           last_message_time = excluded.last_message_time,
           last_message_id = excluded.last_message_id,
           updated_at = excluded.updated_at`
      )
      .run(sourceKey, lastMessageTime, lastMessageId ?? null, now);
  }
}
