import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { FeishuClient } from "../feishu/client.js";
import type { FeishuMessageEvent } from "../feishu/events.js";

export class AssetService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly feishu: FeishuClient
  ) {}

  async saveAssets(taskId: string, workspaceRoot: string, assets: FeishuMessageEvent["assets"]): Promise<void> {
    for (const asset of assets) {
      const safeName = asset.fileName.replace(/[^\w.\-]+/g, "_");
      const localPath = `${workspaceRoot}/${taskId}/inputs/${safeName}`;
      await this.feishu.downloadFile(asset.feishuFileKey, localPath);
      const info = await stat(localPath).catch(() => undefined);
      const sha256 = createHash("sha256").update(`${asset.feishuFileKey}:${safeName}`).digest("hex");
      this.db
        .prepare(
          `INSERT INTO input_assets
           (id, task_id, asset_type, feishu_file_key, file_name, mime_type, local_path, size_bytes, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          taskId,
          asset.assetType,
          asset.feishuFileKey,
          asset.fileName,
          asset.mimeType ?? null,
          localPath,
          info?.size ?? null,
          sha256,
          new Date().toISOString()
        );
    }
  }
}
