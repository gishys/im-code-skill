import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { FeishuClient } from "../feishu/client.js";
import type { FeishuMessageEvent } from "../feishu/events.js";
import type { InputAsset, PendingInputAsset, TaskDraft } from "../types.js";

const pendingAssetTtlMs = 2 * 60 * 60 * 1000;
const defaultCandidateLimit = 20;

function now(): string {
  return new Date().toISOString();
}

function expiresAt(): string {
  return new Date(Date.now() + pendingAssetTtlMs).toISOString();
}

function rowToDraft(row: Record<string, unknown>): TaskDraft {
  return {
    id: String(row.id),
    feishuChatId: String(row.feishu_chat_id),
    feishuUserId: String(row.feishu_user_id),
    sourceMessageId: row.source_message_id as string | null,
    formMessageId: row.form_message_id as string | null,
    status: row.status as TaskDraft["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: String(row.expires_at)
  };
}

function rowToPendingAsset(row: Record<string, unknown>): PendingInputAsset {
  return {
    id: String(row.id),
    draftId: row.draft_id as string | null,
    feishuChatId: String(row.feishu_chat_id),
    feishuUserId: String(row.feishu_user_id),
    feishuMessageId: row.feishu_message_id as string | null,
    assetType: row.asset_type as PendingInputAsset["assetType"],
    feishuFileKey: String(row.feishu_file_key),
    fileName: String(row.file_name),
    mimeType: row.mime_type as string | null,
    status: row.status as PendingInputAsset["status"],
    linkedTaskId: row.linked_task_id as string | null,
    linkedAt: row.linked_at as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class AssetService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly feishu: FeishuClient
  ) {}

  createDraft(input: { chatId: string; userId: string; sourceMessageId?: string }): TaskDraft {
    this.expireOldDraftsAndAssets();
    const id = `draft-${randomUUID()}`;
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO task_drafts
         (id, feishu_chat_id, feishu_user_id, source_message_id, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(id, input.chatId, input.userId, input.sourceMessageId ?? null, timestamp, timestamp, expiresAt());
    return this.getDraft(id);
  }

  getDraft(id: string): TaskDraft {
    const row = this.db.prepare("SELECT * FROM task_drafts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`任务草稿不存在：${id}`);
    }
    return rowToDraft(row);
  }

  tryGetActiveDraft(chatId: string, userId: string): TaskDraft | undefined {
    this.expireOldDraftsAndAssets();
    const row = this.db
      .prepare(
        `SELECT * FROM task_drafts
         WHERE feishu_chat_id = ? AND feishu_user_id = ? AND status = 'active' AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(chatId, userId, now()) as Record<string, unknown> | undefined;
    return row ? rowToDraft(row) : undefined;
  }

  setDraftFormMessageId(draftId: string, messageId: string): void {
    this.db.prepare("UPDATE task_drafts SET form_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now(), draftId);
  }

  markDraftSubmitted(draftId: string): void {
    this.db.prepare("UPDATE task_drafts SET status = 'submitted', updated_at = ? WHERE id = ?").run(now(), draftId);
  }

  async savePendingAssets(input: {
    chatId?: string;
    userId?: string;
    messageId?: string;
    assets: FeishuMessageEvent["assets"];
  }): Promise<{ saved: PendingInputAsset[]; activeDraft?: TaskDraft }> {
    if (!input.chatId || !input.userId || input.assets.length === 0) {
      return { saved: [] };
    }

    this.expireOldDraftsAndAssets();
    const activeDraft = this.tryGetActiveDraft(input.chatId, input.userId);
    const timestamp = now();
    const saved: PendingInputAsset[] = [];

    for (const asset of input.assets) {
      const id = `asset-${randomUUID()}`;
      this.db
        .prepare(
          `INSERT OR IGNORE INTO pending_input_assets
           (id, draft_id, feishu_chat_id, feishu_user_id, feishu_message_id, asset_type,
            feishu_file_key, file_name, mime_type, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          id,
          activeDraft?.id ?? null,
          input.chatId,
          input.userId,
          input.messageId ?? null,
          asset.assetType,
          asset.feishuFileKey,
          asset.fileName,
          asset.mimeType ?? null,
          timestamp,
          timestamp
        );

      const row = this.db
        .prepare("SELECT * FROM pending_input_assets WHERE feishu_message_id IS ? AND feishu_file_key = ?")
        .get(input.messageId ?? null, asset.feishuFileKey) as Record<string, unknown> | undefined;
      if (row) {
        saved.push(rowToPendingAsset(row));
      }
    }

    return { saved: labelAssets(saved), activeDraft };
  }

  getPendingAssetCandidates(input: { draftId?: string; chatId?: string; userId?: string; limit?: number }): PendingInputAsset[] {
    this.expireOldDraftsAndAssets();
    const draft = input.draftId ? this.getDraft(input.draftId) : undefined;
    const chatId = input.chatId ?? draft?.feishuChatId;
    const userId = input.userId ?? draft?.feishuUserId;
    if (!chatId || !userId) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM pending_input_assets
         WHERE feishu_chat_id = ?
           AND feishu_user_id = ?
           AND status = 'pending'
           AND created_at >= ?
           AND (? IS NULL OR draft_id IS NULL OR draft_id = ?)
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(chatId, userId, new Date(Date.now() - pendingAssetTtlMs).toISOString(), draft?.id ?? null, draft?.id ?? null, input.limit ?? defaultCandidateLimit) as Array<
      Record<string, unknown>
    >;

    return labelAssets(rows.map(rowToPendingAsset));
  }

  resolveSelectedPendingAssets(input: { draftId?: string; chatId?: string; userId?: string; assetIds: string[] }): PendingInputAsset[] {
    const assetIds = unique(input.assetIds);
    if (assetIds.length === 0) {
      return [];
    }
    const candidates = this.getPendingAssetCandidates(input);
    const byId = new Map(candidates.map((asset) => [asset.id, asset]));
    const selected = assetIds.map((id) => byId.get(id)).filter(Boolean) as PendingInputAsset[];
    if (selected.length !== assetIds.length) {
      throw new Error("选择的附件已过期、已被其他任务关联，或不属于当前会话/提交人，请刷新附件列表后重试。");
    }
    return selected;
  }

  async saveAssets(taskId: string, workspaceRoot: string, assets: FeishuMessageEvent["assets"], sourceMessageId?: string): Promise<InputAsset[]> {
    const saved: InputAsset[] = [];
    for (const asset of assets) {
      const localPath = `${workspaceRoot}/${taskId}/inputs/${safeFileName(asset.fileName)}`;
      await this.downloadAsset(asset, localPath, sourceMessageId);
      const info = await stat(localPath).catch(() => undefined);
      const sha256 = createHash("sha256").update(`${asset.feishuFileKey}:${asset.fileName}`).digest("hex");
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO input_assets
           (id, task_id, asset_type, feishu_file_key, file_name, mime_type, local_path, size_bytes, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, taskId, asset.assetType, asset.feishuFileKey, asset.fileName, asset.mimeType ?? null, localPath, info?.size ?? null, sha256, now());
      saved.push({
        id,
        taskId,
        assetType: asset.assetType,
        feishuFileKey: asset.feishuFileKey,
        fileName: asset.fileName,
        mimeType: asset.mimeType ?? null,
        localPath,
        sizeBytes: info?.size ?? null,
        sha256
      });
    }
    this.updateTaskInputAssetsJson(taskId);
    return saved;
  }

  async linkPendingAssetsToTask(input: { taskId: string; workspaceRoot: string; assets: PendingInputAsset[] }): Promise<InputAsset[]> {
    const linked: InputAsset[] = [];
    for (const asset of input.assets) {
      const localPath = `${input.workspaceRoot}/${input.taskId}/inputs/${safeFileName(`${asset.label ?? "附件"}-${asset.fileName}`)}`;
      await this.downloadAsset(asset, localPath, asset.feishuMessageId ?? undefined);
      const info = await stat(localPath).catch(() => undefined);
      const sha256 = createHash("sha256").update(`${asset.feishuFileKey}:${asset.fileName}`).digest("hex");
      const id = randomUUID();
      const timestamp = now();
      const update = this.db
        .prepare(
          `UPDATE pending_input_assets
           SET status = 'linked', linked_task_id = ?, linked_at = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(input.taskId, timestamp, timestamp, asset.id);
      if (update.changes !== 1) {
        throw new Error(`附件已被其他任务关联，请刷新附件列表后重试：${asset.fileName}`);
      }
      this.db
        .prepare(
          `INSERT INTO input_assets
           (id, task_id, asset_type, feishu_file_key, file_name, mime_type, local_path, size_bytes, sha256, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.taskId, asset.assetType, asset.feishuFileKey, asset.fileName, asset.mimeType ?? null, localPath, info?.size ?? null, sha256, timestamp);
      linked.push({
        id,
        taskId: input.taskId,
        assetType: asset.assetType,
        feishuFileKey: asset.feishuFileKey,
        fileName: asset.fileName,
        mimeType: asset.mimeType ?? null,
        localPath,
        sizeBytes: info?.size ?? null,
        sha256
      });
    }
    this.updateTaskInputAssetsJson(input.taskId);
    return linked;
  }

  buildAttachmentSummary(assets: PendingInputAsset[]): string | undefined {
    if (assets.length === 0) {
      return undefined;
    }
    return ["附件清单：", ...assets.map((asset) => `- ${asset.label ?? assetTypeLabel(asset.assetType)}：${asset.fileName}`)].join("\n");
  }

  private updateTaskInputAssetsJson(taskId: string): void {
    const rows = this.db
      .prepare("SELECT * FROM input_assets WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Array<Record<string, unknown>>;
    const payload = labelAssets(
      rows.map((row) => ({
        id: String(row.id),
        draftId: null,
        feishuChatId: "",
        feishuUserId: "",
        feishuMessageId: null,
        assetType: row.asset_type as PendingInputAsset["assetType"],
        feishuFileKey: String(row.feishu_file_key),
        fileName: String(row.file_name),
        mimeType: row.mime_type as string | null,
        status: "linked",
        linkedTaskId: taskId,
        linkedAt: null,
        createdAt: String(row.created_at),
        updatedAt: String(row.created_at)
      }))
    );
    this.db.prepare("UPDATE tasks SET input_assets_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(payload), now(), taskId);
  }

  private expireOldDraftsAndAssets(): void {
    const timestamp = now();
    this.db
      .prepare("UPDATE task_drafts SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at <= ?")
      .run(timestamp, timestamp);
    this.db
      .prepare("UPDATE pending_input_assets SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?")
      .run(timestamp, new Date(Date.now() - pendingAssetTtlMs).toISOString());
  }

  private async downloadAsset(
    asset: Pick<InputAsset, "assetType" | "feishuFileKey">,
    localPath: string,
    sourceMessageId?: string
  ): Promise<string> {
    if (sourceMessageId) {
      return this.feishu.downloadMessageResource({
        messageId: sourceMessageId,
        fileKey: asset.feishuFileKey,
        resourceType: asset.assetType,
        destination: localPath
      });
    }
    return this.feishu.downloadFile(asset.feishuFileKey, localPath);
  }
}

export function formatAssetCandidateOption(asset: PendingInputAsset): string {
  const label = asset.label ?? assetTypeLabel(asset.assetType);
  return `${label} ${formatTime(asset.createdAt)} ${truncate(asset.fileName, 28)}`;
}

function labelAssets<T extends Pick<PendingInputAsset, "assetType">>(assets: T[]): Array<T & { label: string }> {
  const counts: Record<PendingInputAsset["assetType"], number> = {
    image: 0,
    video: 0,
    file: 0
  };
  return assets.map((asset) => {
    counts[asset.assetType] += 1;
    return { ...asset, label: `${assetTypeLabel(asset.assetType)}${counts[asset.assetType]}` };
  });
}

function assetTypeLabel(type: PendingInputAsset["assetType"]): string {
  if (type === "image") return "图";
  if (type === "video") return "视频";
  return "文件";
}

function safeFileName(fileName: string): string {
  return fileName.replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
