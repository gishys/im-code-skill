import Fastify from "fastify";
import type { AppEnv } from "./config/env.js";
import type { ProjectConfig } from "./types.js";
import type { FeishuClient } from "./feishu/client.js";
import { parseFeishuActionEvent, parseFeishuMessageEvent } from "./feishu/events.js";
import { buildHelpCard, buildTaskCard, buildTaskFormCard } from "./feishu/cards.js";
import { TaskService } from "./task/service.js";
import { AssetService } from "./inputs/asset-service.js";
import { TaskIngestionService } from "./task/ingestion.js";
import type { TaskFormInput, TaskScope, TaskType } from "./types.js";

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

    const event = parseFeishuMessageEvent(body);
    if (!event) {
      request.log.info({ body }, "Ignored non-message Feishu event");
      return reply.code(202).send({ ok: true, ignored: true });
    }

    if (["表单", "填写表单", "任务表单", "form"].includes(event.text.trim().toLowerCase())) {
      if (event.chatId) {
        await input.feishu.sendTaskCard(event.chatId, buildTaskFormCard(input.projects));
      }
      return { ok: true, form: true };
    }

    if (["测试机器人", "帮助", "格式", "ping", "test", "help"].includes(event.text.trim().toLowerCase())) {
      try {
        if (event.chatId) {
          await input.feishu.sendTaskCard(event.chatId, buildHelpCard({ reason: "机器人已连接，请发送结构化任务消息。" }));
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
      if (event.chatId) {
        try {
          await input.feishu.sendTaskCard(event.chatId, buildHelpCard({ reason: `消息格式不完整或无法识别：${summary}` }));
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

    if (action.action === "open_help") {
      return buildHelpCard();
    }
    if (action.action === "open_task_form") {
      return buildTaskFormCard(input.projects);
    }
    if (action.action === "submit_task_form") {
      const form = parseTaskFormInput(action.formValues);
      if (!form.ok) {
        return buildTaskFormCard(input.projects, {
          reason: form.error,
          values: action.formValues
        });
      }

      try {
        const task = await ingestion.ingestTaskForm({
          form: form.value,
          feishuEventId: action.messageId ? `form:${action.messageId}:${Date.now()}` : `form:${Date.now()}`,
          feishuChatId: action.chatId,
          feishuMessageId: action.messageId,
          feishuUserId: action.userId
        });
        return buildTaskCard(task);
      } catch (error) {
        return buildTaskFormCard(input.projects, {
          reason: error instanceof Error ? error.message : String(error),
          values: action.formValues
        });
      }
    }

    if (!action.taskId) {
      return reply.code(400).send({ error: "Missing taskId" });
    }
    if (action.action === "approve") {
      return input.tasks.approveTask(action.taskId, action.userId);
    }
    if (action.action === "cancel") {
      return input.tasks.cancelTask(action.taskId, action.userId);
    }
    if (action.action === "status") {
      return input.tasks.getTask(action.taskId);
    }
    return reply.code(409).send({ error: "Retry is not implemented in MVP", taskId: action.taskId });
  });

  return app;
}

function parseTaskFormInput(values: Record<string, string>): { ok: true; value: TaskFormInput } | { ok: false; error: string } {
  const projectName = values.projectName?.trim();
  const taskType = normalizeTaskType(values.taskType);
  const scope = normalizeScope(values.scope);
  const description = values.description?.trim();
  const attachmentNote = values.attachmentNote?.trim();

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
      taskType: normalizedTaskType,
      scope: normalizedScope,
      description,
      attachmentNote
    }
  };
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
