import type { AppEnv } from "../config/env.js";
import type { TaskIngestionService } from "../task/ingestion.js";
import type { TaskService } from "../task/service.js";
import type { FeishuClient, FeishuPolledMessage } from "./client.js";
import type { FeishuMessageEvent } from "./events.js";
import { PollingStateStore } from "./polling-state.js";

export class FeishuPoller {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly chatIds: string[];

  constructor(
    private readonly env: AppEnv,
    private readonly feishu: FeishuClient,
    private readonly state: PollingStateStore,
    private readonly ingestion: TaskIngestionService,
    private readonly tasks: TaskService
  ) {
    this.chatIds = env.FEISHU_POLLING_CHAT_IDS.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  start(): void {
    if (this.chatIds.length === 0) {
      console.warn("FEISHU_CONNECTION_MODE=polling but FEISHU_POLLING_CHAT_IDS is empty; polling is idle.");
      return;
    }
    this.timer = setInterval(() => {
      this.pollOnce().catch((error) => {
        console.error("Feishu polling failed", error);
      });
    }, this.env.FEISHU_POLLING_INTERVAL_SECONDS * 1000);
    void this.pollOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  async pollOnce(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      for (const chatId of this.chatIds) {
        await this.pollChat(chatId);
      }
    } finally {
      this.running = false;
    }
  }

  private async pollChat(chatId: string): Promise<void> {
    const sourceKey = `chat:${chatId}`;
    const startTime = this.state.getLastMessageTime(sourceKey, this.env.FEISHU_POLLING_LOOKBACK_SECONDS);
    const endTime = String(Math.floor(Date.now() / 1000));
    const messages = await this.feishu.listChatMessages({
      chatId,
      startTime,
      endTime,
      pageSize: this.env.FEISHU_POLLING_PAGE_SIZE
    });

    const sorted = messages
      .filter((message) => message.messageId)
      .sort((a, b) => Number(a.createTime) - Number(b.createTime));

    for (const message of sorted) {
      await this.handleMessage(message);
      this.state.update(sourceKey, message.createTime, message.messageId);
    }
  }

  private async handleMessage(message: FeishuPolledMessage): Promise<void> {
    const command = parsePollingCommand(extractText(message.content));
    if (command) {
      await this.handleCommand(command, message);
      return;
    }

    const event = polledMessageToEvent(message);
    if (!event.text.trim()) {
      return;
    }
    try {
      await this.ingestion.ingestFeishuMessage(event);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      await this.feishu.sendText(message.chatId, `任务解析失败：${summary}`);
    }
  }

  private async handleCommand(command: PollingCommand, message: FeishuPolledMessage): Promise<void> {
    if (command.action === "approve") {
      const task = this.tasks.approveTask(command.taskId, message.senderId);
      await this.feishu.sendText(message.chatId, `已确认执行：${task.id}`);
      return;
    }
    if (command.action === "cancel") {
      const task = this.tasks.cancelTask(command.taskId, message.senderId);
      await this.feishu.sendText(message.chatId, `已取消任务：${task.id}`);
      return;
    }
    const task = this.tasks.tryGetTask(command.taskId);
    await this.feishu.sendText(message.chatId, task ? `任务状态：${task.id}\n${task.status}\n${task.currentStage}` : `任务不存在：${command.taskId}`);
  }
}

interface PollingCommand {
  action: "approve" | "cancel" | "status";
  taskId: string;
}

export function parsePollingCommand(text: string): PollingCommand | undefined {
  const normalized = text.trim();
  const match = normalized.match(/^(确认执行|approve|取消任务|cancel|查看状态|status)[:：\s]+(.+)$/i);
  if (!match) {
    return undefined;
  }
  const actionText = match[1].toLowerCase();
  const taskId = match[2].trim();
  if (actionText === "确认执行" || actionText === "approve") {
    return { action: "approve", taskId };
  }
  if (actionText === "取消任务" || actionText === "cancel") {
    return { action: "cancel", taskId };
  }
  return { action: "status", taskId };
}

function polledMessageToEvent(message: FeishuPolledMessage): FeishuMessageEvent {
  return {
    eventId: `polling:${message.messageId}`,
    chatId: message.chatId,
    messageId: message.messageId,
    userId: message.senderId,
    text: extractText(message.content),
    assets: extractPolledAssets(message)
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return parsed.text ?? "";
    } catch {
      return content;
    }
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text ?? "");
  }
  return "";
}

function extractPolledAssets(message: FeishuPolledMessage): FeishuMessageEvent["assets"] {
  const content = typeof message.content === "string" ? safeJson(message.content) : message.content;
  if (!content || typeof content !== "object") {
    return [];
  }
  const record = content as Record<string, unknown>;
  const fileKey = record.file_key ?? record.image_key ?? record.media_key;
  if (!fileKey) {
    return [];
  }
  const assetType = message.msgType.includes("image") ? "image" : message.msgType.includes("video") || message.msgType.includes("media") ? "video" : "file";
  return [
    {
      assetType,
      feishuFileKey: String(fileKey),
      fileName: String(record.file_name ?? `${message.messageId}-${assetType}`),
      mimeType: record.mime_type ? String(record.mime_type) : null
    }
  ];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
