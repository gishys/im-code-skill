import { findProject } from "../config/projects.js";
import { buildTaskCard } from "../feishu/cards.js";
import type { FeishuClient } from "../feishu/client.js";
import type { FeishuMessageEvent } from "../feishu/events.js";
import type { AssetService } from "../inputs/asset-service.js";
import { isAutoApproved } from "./approval.js";
import { parseTaskMessage } from "./parser.js";
import type { TaskService } from "./service.js";
import type { ProjectConfig, TaskFormInput, TaskRecord } from "../types.js";

export class TaskIngestionService {
  constructor(
    private readonly projects: ProjectConfig[],
    private readonly tasks: TaskService,
    private readonly feishu: FeishuClient,
    private readonly assets: AssetService,
    private readonly workspaceRoot: string
  ) {}

  async ingestFeishuMessage(event: FeishuMessageEvent): Promise<TaskRecord> {
    const dedupeKey = event.eventId ?? event.messageId;
    if (dedupeKey) {
      const existing = this.tasks.tryGetTaskByFeishuEventId(dedupeKey);
      if (existing) {
        return existing;
      }
    }

    const parsed = parseTaskMessage(event.text);
    const project = findProject(this.projects, parsed.projectName);
    const autoApproved = isAutoApproved(project, parsed, event.userId);
    const shouldQueueAfterAssets = parsed.executionMode === "plan" || autoApproved;
    const task = this.tasks.createTask({
      parsed,
      rawText: event.text,
      feishuEventId: dedupeKey,
      feishuChatId: event.chatId,
      feishuMessageId: event.messageId,
      feishuUserId: event.userId,
      autoApproved,
      deferQueue: event.assets.length > 0
    });

    if (event.assets.length > 0) {
      try {
        await this.assets.saveAssets(task.id, this.workspaceRoot, event.assets, event.messageId);
      } catch (error) {
        this.tasks.markFailed(task.id, "input_assets", errorMessage(error));
        throw error;
      }
      if (shouldQueueAfterAssets) {
        this.tasks.enqueueTask(task.id);
      }
    }

    if (event.chatId) {
      const messageId = await this.feishu.sendTaskCard(event.chatId, buildTaskCard(this.tasks.getTask(task.id)));
      if (messageId) {
        this.tasks.setStreamMessageId(task.id, messageId);
      }
    }

    return this.tasks.getTask(task.id);
  }

  async ingestPendingAssets(event: FeishuMessageEvent): Promise<{ savedCount: number; activeDraftId?: string }> {
    const result = await this.assets.savePendingAssets({
      chatId: event.chatId,
      userId: event.userId,
      messageId: event.messageId,
      assets: event.assets
    });
    return {
      savedCount: result.saved.length,
      activeDraftId: result.activeDraft?.id
    };
  }

  async ingestTaskForm(input: {
    form: TaskFormInput;
    draftId?: string;
    feishuEventId?: string;
    feishuChatId?: string;
    feishuMessageId?: string;
    feishuUserId?: string;
    sendInitialCard?: boolean;
  }): Promise<TaskRecord> {
    const selectedAssets = this.assets.resolveSelectedPendingAssets({
      draftId: input.draftId,
      chatId: input.feishuChatId,
      userId: input.feishuUserId,
      assetIds: input.form.selectedAssetIds ?? []
    });
    const attachmentSummary = this.assets.buildAttachmentSummary(selectedAssets);
    const description = [
      input.form.description,
      attachmentSummary,
      input.form.attachmentNote ? `附件说明：${input.form.attachmentNote}` : undefined
    ]
      .filter(Boolean)
      .join("\n\n");
    const project = findProject(this.projects, input.form.projectName);
    const parsed = {
      projectName: input.form.projectName,
      taskType: input.form.taskType,
      scope: input.form.scope,
      executionMode: input.form.executionMode,
      description
    };
    const autoApproved = isAutoApproved(project, parsed, input.feishuUserId);
    const shouldQueueAfterAssets = parsed.executionMode === "plan" || autoApproved;
    const task = this.tasks.createTask({
      parsed,
      rawText: taskFormToRawText(input.form),
      feishuEventId: input.feishuEventId,
      feishuChatId: input.feishuChatId,
      feishuMessageId: input.feishuMessageId,
      feishuUserId: input.feishuUserId,
      autoApproved,
      deferQueue: selectedAssets.length > 0
    });

    if (selectedAssets.length > 0) {
      try {
        await this.assets.linkPendingAssetsToTask({
          taskId: task.id,
          workspaceRoot: this.workspaceRoot,
          assets: selectedAssets
        });
      } catch (error) {
        this.tasks.markFailed(task.id, "input_assets", errorMessage(error));
        throw error;
      }
      this.tasks.updateTaskInputText(task.id, {
        rawText: taskFormToRawText(input.form, attachmentSummary),
        parsedDescription: description
      });
      if (shouldQueueAfterAssets) {
        this.tasks.enqueueTask(task.id);
      }
    }
    if (input.draftId) {
      this.assets.markDraftSubmitted(input.draftId);
    }

    if (input.sendInitialCard === false && input.feishuMessageId) {
      this.tasks.setStreamMessageId(task.id, input.feishuMessageId);
    } else if (input.feishuChatId) {
      const messageId = await this.feishu.sendTaskCard(input.feishuChatId, buildTaskCard(this.tasks.getTask(task.id)));
      if (messageId) {
        this.tasks.setStreamMessageId(task.id, messageId);
      }
    }

    return this.tasks.getTask(task.id);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function taskFormToRawText(form: TaskFormInput, attachmentSummary?: string): string {
  return [
    `项目：${form.projectName}`,
    `模式：${form.executionMode}`,
    `类型：${form.taskType}`,
    `范围：${form.scope}`,
    `描述：${form.description}`,
    attachmentSummary,
    form.attachmentNote ? `附件说明：${form.attachmentNote}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}
