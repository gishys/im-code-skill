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
    const task = this.tasks.createTask({
      parsed,
      rawText: event.text,
      feishuEventId: dedupeKey,
      feishuChatId: event.chatId,
      feishuMessageId: event.messageId,
      feishuUserId: event.userId,
      autoApproved
    });

    if (event.assets.length > 0) {
      await this.assets.saveAssets(task.id, this.workspaceRoot, event.assets);
    }

    if (event.chatId) {
      const messageId = await this.feishu.sendTaskCard(event.chatId, buildTaskCard(task));
      if (messageId) {
        this.tasks.setStreamMessageId(task.id, messageId);
      }
    }

    return task;
  }

  async ingestTaskForm(input: {
    form: TaskFormInput;
    feishuEventId?: string;
    feishuChatId?: string;
    feishuMessageId?: string;
    feishuUserId?: string;
  }): Promise<TaskRecord> {
    const description = input.form.attachmentNote
      ? `${input.form.description}\n\n附件说明：${input.form.attachmentNote}`
      : input.form.description;
    const project = findProject(this.projects, input.form.projectName);
    const parsed = {
      projectName: input.form.projectName,
      taskType: input.form.taskType,
      scope: input.form.scope,
      description
    };
    const autoApproved = isAutoApproved(project, parsed, input.feishuUserId);
    const task = this.tasks.createTask({
      parsed,
      rawText: taskFormToRawText(input.form),
      feishuEventId: input.feishuEventId,
      feishuChatId: input.feishuChatId,
      feishuMessageId: input.feishuMessageId,
      feishuUserId: input.feishuUserId,
      autoApproved
    });

    if (input.feishuChatId) {
      const messageId = await this.feishu.sendTaskCard(input.feishuChatId, buildTaskCard(task));
      if (messageId) {
        this.tasks.setStreamMessageId(task.id, messageId);
      }
    }

    return task;
  }
}

function taskFormToRawText(form: TaskFormInput): string {
  return [
    `项目：${form.projectName}`,
    `类型：${form.taskType}`,
    `范围：${form.scope}`,
    `描述：${form.description}`,
    form.attachmentNote ? `附件说明：${form.attachmentNote}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}
