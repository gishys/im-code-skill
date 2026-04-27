import Fastify from "fastify";
import type { AppEnv } from "./config/env.js";
import type { ProjectConfig, TaskExecutionMode, TaskFormInput, TaskScope, TaskType } from "./types.js";
import type { FeishuClient } from "./feishu/client.js";
import { parseFeishuActionEvent, parseFeishuMessageEvent, type FeishuActionEvent } from "./feishu/events.js";
import { buildHelpCard, buildTaskCard, buildTaskFormCard } from "./feishu/cards.js";
import { TaskService } from "./task/service.js";
import { AssetService } from "./inputs/asset-service.js";
import { TaskIngestionService } from "./task/ingestion.js";

export function createApp(input: {
  env: AppEnv;
  projects: ProjectConfig[];
  tasks: TaskService;
  feishu: FeishuClient;
  assets: AssetService;
}) {
  const app = Fastify({ logger: true });
  const ingestion = new TaskIngestionService(input.projects, input.tasks, input.feishu, input.assets, input.env.WORKSPACE_ROOT);

  app.get("/health", async () => ({
    ok: true,
    connectionMode: input.env.FEISHU_CONNECTION_MODE,
    port: input.env.PORT,
    feishuEventsPath: "/feishu/events",
    feishuActionsPath: "/feishu/actions",
    publicEventsUrl: input.env.FEISHU_PUBLIC_BASE_URL ? `${input.env.FEISHU_PUBLIC_BASE_URL}/feishu/events` : null,
    publicActionsUrl: input.env.FEISHU_PUBLIC_BASE_URL ? `${input.env.FEISHU_PUBLIC_BASE_URL}/feishu/actions` : null
  }));

  app.get("/", async () => ({
    ok: true,
    service: "feishu-codex-orchestrator",
    health: "/health",
    feishuEvents: "/feishu/events"
  }));

  app.get("/tasks/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const task = input.tasks.tryGetTask(id);
    if (!task) {
      return reply.code(404).send({ error: "Task not found" });
    }
    return task;
  });

  app.post("/feishu/events", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (body.type === "url_verification") {
      return { challenge: body.challenge };
    }

    const cardAction = parseFeishuActionEvent(body);
    if (cardAction) {
      return handleCardAction(cardAction, input, reply);
    }

    const event = parseFeishuMessageEvent(body);
    if (!event) {
      request.log.info({ body }, "Ignored non-message Feishu event");
      return reply.code(202).send({ ok: true, ignored: true });
    }

    if (!event.text.trim() && event.assets.length > 0) {
      const result = await ingestion.ingestPendingAssets(event);
      await notifyPendingAssets(input, result, event.chatId);
      return { ok: true, pendingAssets: result.savedCount };
    }

    if (isFormCommand(event.text)) {
      if (event.chatId) {
        await sendNewTaskForm(input, {
          chatId: event.chatId,
          userId: event.userId,
          sourceMessageId: event.messageId
        });
      }
      return { ok: true, form: true };
    }

    if (isHelpCommand(event.text)) {
      try {
        if (event.chatId) {
          await input.feishu.sendTaskCard(event.chatId, buildHelpCard({ reason: "机器人已连接，请发送结构化任务消息，或点击按钮填写任务表单。" }));
        }
      } catch (error) {
        request.log.error({ err: error }, "Failed to send Feishu ping reply");
        return reply.code(200).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return { ok: true, ping: true };
    }

    let task;
    try {
      task = await ingestion.ingestFeishuMessage(event);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      if (event.assets.length > 0) {
        await ingestion.ingestPendingAssets(event);
      }
      if (event.chatId) {
        try {
          const reason =
            event.assets.length > 0
              ? `附件已暂存，但任务信息不完整或无法识别：${summary}。请点击“填写任务表单”，并在表单中选择这些附件。`
              : `消息格式不完整或无法识别：${summary}`;
          await input.feishu.sendTaskCard(event.chatId, buildHelpCard({ reason }));
        } catch (sendError) {
          request.log.error({ err: sendError }, "Failed to send Feishu parse-error reply");
        }
      }
      request.log.warn({ err: error }, "Failed to ingest Feishu message");
      return reply.code(200).send({ ok: false, error: summary });
    }

    return { ok: true, taskId: task.id, status: task.status };
  });

  app.post("/feishu/actions", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (body.type === "url_verification" || body.challenge) {
      return { challenge: body.challenge };
    }

    const action = parseFeishuActionEvent(body);
    if (!action) {
      return reply.code(400).send({ error: "Invalid action payload" });
    }
    request.log.info(
      {
        action: action.action,
        taskId: action.taskId,
        draftId: action.draftId,
        hasChatId: Boolean(action.chatId),
        formKeys: Object.keys(action.formValues)
      },
      "Received Feishu card action"
    );

    return handleCardAction(action, input, reply);
  });

  return app;
}

async function handleCardAction(
  action: FeishuActionEvent,
  input: {
    env: AppEnv;
    projects: ProjectConfig[];
    tasks: TaskService;
    feishu: FeishuClient;
    assets: AssetService;
  },
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }
) {
  const ingestion = new TaskIngestionService(input.projects, input.tasks, input.feishu, input.assets, input.env.WORKSPACE_ROOT);

  if (action.action === "open_help") {
    if (action.chatId) {
      await input.feishu.sendTaskCard(action.chatId, buildHelpCard());
      return toastOnly("已把填写说明发送到会话底部");
    }
    return cardActionResponse(buildHelpCard(), "已打开填写说明");
  }
  if (action.action === "open_task_form") {
    if (action.chatId) {
      await sendNewTaskForm(input, {
        chatId: action.chatId,
        userId: action.userId,
        sourceMessageId: action.messageId
      });
      return toastOnly("已把任务表单发送到会话底部");
    }
    return cardActionResponse(buildTaskFormCard(input.projects), "请填写任务表单");
  }
  if (action.action === "refresh_task_form_assets") {
    if (action.messageId) {
      await input.feishu.updateTaskCard(action.messageId, buildTaskFormCard(input.projects, formCardInput(input, action, "附件列表已刷新")));
      return toastOnly("附件列表已刷新");
    }
    return cardActionResponse(buildTaskFormCard(input.projects, formCardInput(input, action, "附件列表已刷新")), "附件列表已刷新");
  }
  if (action.action === "submit_task_form") {
    const form = parseTaskFormInput(action.formValues);
    if (!form.ok) {
      return updateCurrentCardOrRespond(
        input,
        action,
        buildTaskFormCard(input.projects, formCardInput(input, action, form.error)),
        form.error,
        "warning"
      );
    }

    if (form.value.attachmentNote && (form.value.selectedAssetIds ?? []).length === 0) {
      const message = "已填写附件说明，但还没有选择要关联的附件。请先发送图片/视频/文件，点击“刷新附件列表”后勾选附件；如果不需要附件，请清空附件说明。";
      return updateCurrentCardOrRespond(
        input,
        action,
        buildTaskFormCard(input.projects, formCardInput(input, action, message)),
        message,
        "warning"
      );
    }

    try {
      const task = await ingestion.ingestTaskForm({
        form: form.value,
        draftId: action.draftId,
        feishuEventId: action.messageId ? `form:${action.messageId}:${Date.now()}` : `form:${Date.now()}`,
        feishuChatId: action.chatId,
        feishuMessageId: action.messageId,
        feishuUserId: action.userId,
        sendInitialCard: false
      });
      return updateCurrentCardOrRespond(input, action, buildTaskCard(task), "任务已提交");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return updateCurrentCardOrRespond(
        input,
        action,
        buildTaskFormCard(input.projects, formCardInput(input, action, message)),
        message,
        "warning"
      );
    }
  }

  if (!action.taskId) {
    return reply.code(400).send({ error: "Missing taskId" });
  }
  if (action.action === "approve") {
    return cardActionResponse(buildTaskCard(input.tasks.approveTask(action.taskId, action.userId)), "已确认执行");
  }
  if (action.action === "approve_plan_as_agent") {
    return cardActionResponse(buildTaskCard(input.tasks.approvePlanAsAgent(action.taskId, action.userId)), "已转为 Agent 执行");
  }
  if (action.action === "cancel") {
    return cardActionResponse(buildTaskCard(input.tasks.cancelTask(action.taskId, action.userId)), "已取消任务");
  }
  if (action.action === "status") {
    return cardActionResponse(buildTaskCard(input.tasks.getTask(action.taskId)), "已刷新状态");
  }
  return reply.code(409).send({ error: "Retry is not implemented in MVP", taskId: action.taskId });
}

async function sendNewTaskForm(
  input: {
    projects: ProjectConfig[];
    feishu: FeishuClient;
    assets: AssetService;
  },
  context: { chatId: string; userId?: string; sourceMessageId?: string }
): Promise<void> {
  const draft = context.userId
    ? input.assets.createDraft({
        chatId: context.chatId,
        userId: context.userId,
        sourceMessageId: context.sourceMessageId
      })
    : undefined;
  const assetCandidates = draft ? input.assets.getPendingAssetCandidates({ draftId: draft.id }) : [];
  const messageId = await input.feishu.sendTaskCard(
    context.chatId,
    buildTaskFormCard(input.projects, {
      draftId: draft?.id,
      assetCandidates
    })
  );
  if (draft && messageId) {
    input.assets.setDraftFormMessageId(draft.id, messageId);
  }
}

async function notifyPendingAssets(
  input: {
    projects: ProjectConfig[];
    feishu: FeishuClient;
    assets: AssetService;
  },
  result: { savedCount: number; activeDraftId?: string },
  chatId?: string
): Promise<void> {
  if (!chatId || result.savedCount === 0) {
    return;
  }
  try {
    if (result.activeDraftId) {
      const draft = input.assets.getDraft(result.activeDraftId);
      if (draft.formMessageId) {
        await input.feishu.updateTaskCard(
          draft.formMessageId,
          buildTaskFormCard(input.projects, {
            draftId: draft.id,
            assetCandidates: input.assets.getPendingAssetCandidates({ draftId: draft.id }),
            reason: `检测到 ${result.savedCount} 个新附件，请确认附件列表后提交。`
          })
        );
        return;
      }
    }
    await input.feishu.sendText(chatId, `已暂存 ${result.savedCount} 个附件。请点击“填写任务表单”，在表单中选择要关联的附件。`);
  } catch (error) {
    console.warn("Failed to notify Feishu pending asset update", error);
  }
}

function formCardInput(
  input: { assets: AssetService },
  action: FeishuActionEvent,
  reason?: string
): { reason?: string; values?: Record<string, string>; draftId?: string; assetCandidates: ReturnType<AssetService["getPendingAssetCandidates"]> } {
  return {
    reason,
    values: action.formValues,
    draftId: action.draftId,
    assetCandidates: input.assets.getPendingAssetCandidates({
      draftId: action.draftId,
      chatId: action.chatId,
      userId: action.userId
    })
  };
}

function cardActionResponse(card: object, content: string, type: "success" | "warning" | "info" = "success") {
  return {
    toast: {
      type,
      content
    },
    card
  };
}

async function updateCurrentCardOrRespond(
  input: { feishu: FeishuClient },
  action: FeishuActionEvent,
  card: object,
  content: string,
  type: "success" | "warning" | "info" = "success"
) {
  if (!action.messageId) {
    return cardActionResponse(card, content, type);
  }
  try {
    await input.feishu.updateTaskCard(action.messageId, card);
  } catch (error) {
    console.warn("Failed to update Feishu card in action callback", error);
  }
  return toastOnly(content, type);
}

function toastOnly(content: string, type: "success" | "warning" | "info" = "success") {
  return {
    toast: {
      type,
      content
    }
  };
}

function parseTaskFormInput(values: Record<string, string>): { ok: true; value: TaskFormInput } | { ok: false; error: string } {
  const projectName = values.projectName?.trim();
  const parsedExecutionMode = normalizeExecutionMode(values.executionMode);
  const executionMode = parsedExecutionMode ?? "plan";
  const taskType = normalizeTaskType(values.taskType);
  const scope = normalizeScope(values.scope);
  const description = values.description?.trim();
  const attachmentNote = values.attachmentNote?.trim();
  const selectedAssetIds = values.selectedAssetIds
    ? values.selectedAssetIds
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item && item !== "__no_pending_assets__")
    : [];

  if (values.executionMode && !parsedExecutionMode) {
    return { ok: false, error: "执行模式无法识别，请选择“先出方案”或“直接执行”。" };
  }

  const missing: string[] = [];
  if (!projectName) missing.push("项目");
  if (!taskType) missing.push("类型");
  if (!scope) missing.push("范围");
  if (!description) missing.push("描述");
  if (missing.length > 0) {
    return { ok: false, error: `请补充必填字段：${missing.join("、")}` };
  }

  const normalizedTaskType = taskType;
  const normalizedScope = scope;
  if (!normalizedTaskType || !normalizedScope || !projectName || !description) {
    return { ok: false, error: "表单字段无法识别，请重新选择类型和范围。" };
  }

  return {
    ok: true,
    value: {
      projectName,
      executionMode,
      taskType: normalizedTaskType,
      scope: normalizedScope,
      description,
      attachmentNote,
      selectedAssetIds
    }
  };
}

function normalizeExecutionMode(value?: string): TaskExecutionMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["plan", "planning", "先出方案", "方案", "只出方案"].includes(normalized)) return "plan";
  if (["agent", "execute", "run", "直接执行", "执行"].includes(normalized)) return "agent";
  return undefined;
}

function normalizeTaskType(value?: string): TaskType | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["bug", "bug 修复", "缺陷", "问题", "修复"].includes(normalized)) return "bug";
  if (["feature", "新增需求", "需求", "新增", "功能"].includes(normalized)) return "feature";
  return undefined;
}

function normalizeScope(value?: string): TaskScope | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["frontend", "前端", "fe"].includes(normalized)) return "frontend";
  if (["backend", "后端", "be"].includes(normalized)) return "backend";
  if (["fullstack", "前后端", "全栈", "both"].includes(normalized)) return "fullstack";
  return undefined;
}

function isFormCommand(text: string): boolean {
  return ["表单", "填写表单", "任务表单", "form"].includes(text.trim().toLowerCase());
}

function isHelpCommand(text: string): boolean {
  return ["测试机器人", "帮助", "格式", "ping", "test", "help"].includes(text.trim().toLowerCase());
}
