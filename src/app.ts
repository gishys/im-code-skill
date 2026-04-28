import Fastify from "fastify";
import type { AppEnv } from "./config/env.js";
import type { PendingInputAsset, ProjectConfig, TaskDraft, TaskExecutionMode, TaskFormInput, TaskScope, TaskType } from "./types.js";
import type { FeishuClient } from "./feishu/client.js";
import { parseFeishuActionEvent, parseFeishuMessageEvent, type FeishuActionEvent } from "./feishu/events.js";
import { buildAssetPreviewCard, buildHelpCard, buildTaskCard, buildTaskFormCard } from "./feishu/cards.js";
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
    return input.tasks.getTaskDetails(id);
  });

  app.get("/threads/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const thread = input.tasks.tryGetThread(id);
    if (!thread) {
      return reply.code(404).send({ error: "Thread not found" });
    }
    return input.tasks.getThreadDetails(id);
  });

  app.get("/changesets/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const changeset = input.tasks.tryGetChangeset(id);
    if (!changeset) {
      return reply.code(404).send({ error: "Changeset not found" });
    }
    return input.tasks.getChangesetDetails(id);
  });

  app.get("/forms/tasks/:draftId", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const token = getToken(request.query);
    const draft = input.assets.verifyDraftFormToken(draftId, token);
    if (!draft) {
      return reply.code(403).type("text/html; charset=utf-8").send(renderMessagePage("表单不可用", "任务表单已过期或链接无效，请回到飞书重新打开表单。"));
    }
    const assetCandidates = input.assets.getPendingAssetCandidates({ draftId: draft.id });
    return reply
      .type("text/html; charset=utf-8")
      .send(renderTaskFormPage({ draftId: draft.id, token: draft.formToken, projects: input.projects, assets: assetCandidates }));
  });

  app.post("/forms/tasks/:draftId/submit", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const token = getToken(request.query);
    const draft = input.assets.verifyDraftFormToken(draftId, token);
    if (!draft) {
      return reply.code(403).send({ ok: false, error: "任务表单已过期或链接无效，请回到飞书重新打开表单。" });
    }
    const form = parseTaskFormInput(normalizeWebFormValues(request.body));
    if (!form.ok) {
      return reply.code(400).send({ ok: false, error: form.error });
    }
    if (form.value.attachmentNote && (form.value.selectedAssetIds ?? []).length === 0) {
      return reply.code(400).send({ ok: false, error: "已填写附件说明，但还没有选择要关联的附件。" });
    }

    try {
      const task = await ingestion.ingestTaskForm({
        form: form.value,
        draftId: draft.id,
        feishuEventId: draft.formMessageId ? `webform:${draft.formMessageId}:${Date.now()}` : `webform:${draft.id}:${Date.now()}`,
        feishuChatId: draft.feishuChatId,
        feishuMessageId: draft.formMessageId ?? undefined,
        feishuUserId: draft.feishuUserId,
        sendInitialCard: draft.formMessageId ? false : true
      });
      if (draft.formMessageId) {
        await input.feishu.updateTaskCard(draft.formMessageId, buildTaskCard(task)).catch((error) => {
          request.log.warn({ err: error, taskId: task.id }, "Failed to update Feishu form card after web form submission");
        });
      }
      return { ok: true, taskId: task.id };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/forms/tasks/:draftId/assets", async (request, reply) => {
    const { draftId } = request.params as { draftId: string };
    const token = getToken(request.query);
    const draft = input.assets.verifyDraftFormToken(draftId, token);
    if (!draft) {
      return reply.code(403).send({ ok: false, error: "Form is expired or unavailable" });
    }
    return {
      ok: true,
      assets: input.assets.getPendingAssetCandidates({ draftId: draft.id })
    };
  });

  app.get("/forms/tasks/:draftId/assets/:assetId/preview", async (request, reply) => {
    const { draftId, assetId } = request.params as { draftId: string; assetId: string };
    const token = getToken(request.query);
    const draft = input.assets.verifyDraftFormToken(draftId, token);
    if (!draft) {
      return reply.code(403).send("任务表单已过期或链接无效");
    }
    const asset = input.assets.getPendingAssetForDraft({ draftId: draft.id, assetId });
    if (!asset || (asset.assetType !== "image" && asset.assetType !== "video")) {
      return reply.code(404).send("图片附件不存在或不可预览");
    }
    try {
      const preview = await input.assets.readPendingAssetPreview(asset);
      return reply.type(preview.contentType).send(preview.body);
    } catch (error) {
      request.log.warn({ err: error, draftId, assetId }, "Failed to preview pending asset");
      if (error instanceof Error && error.message.includes("message resource permission")) {
        return reply.code(502).send(error.message);
      }
      return reply.code(502).send("预览失败，请刷新附件列表");
    }
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
  if (action.action === "preview_task_form_asset") {
    const asset = input.assets
      .getPendingAssetCandidates({
        draftId: action.draftId,
        chatId: action.chatId,
        userId: action.userId
      })
      .find((candidate) => candidate.id === action.assetId && candidate.assetType === "image");
    if (!asset) {
      return toastOnly("未找到可预览的图片，请刷新附件列表后重试", "warning");
    }
    const card = buildAssetPreviewCard(asset);
    if (action.chatId) {
      await input.feishu.sendTaskCard(action.chatId, card);
      return toastOnly("已发送图片预览");
    }
    return cardActionResponse(card, "已打开图片预览");
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
  if (action.action === "approve_plan") {
    return cardActionResponse(buildTaskCard(input.tasks.approveLatestPlan(action.taskId, action.userId)), "Latest plan approved for execution");
  }
  if (["revise_plan", "continue_task", "add_followup_task", "create_pr", "split_pr", "view_history"].includes(action.action)) {
    const task = input.tasks.getTask(action.taskId);
    input.tasks.addTaskMessage({
      threadId: task.threadId,
      taskId: task.id,
      role: "user",
      messageType: action.action,
      content: action.formValues.description || action.formValues.feedback || action.action,
      metadata: { formValues: action.formValues }
    });
    return cardActionResponse(buildTaskCard(task), `${action.action} recorded`);
  }
  return reply.code(409).send({ error: "Retry is not implemented in MVP", taskId: action.taskId });
}

async function sendNewTaskForm(
  input: {
    env: AppEnv;
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
      assetCandidates,
      formUrl: draft ? taskFormUrl(input.env, draft) : undefined
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
        await input.feishu.sendText(chatId, `已暂存 ${result.savedCount} 个附件。请回到正在填写的任务表单，点击“刷新附件列表”后选择附件。`);
        return;
      }
    }
    await input.feishu.sendText(chatId, `已暂存 ${result.savedCount} 个附件。请点击“填写任务表单”，在表单中选择要关联的附件。`);
  } catch (error) {
    console.warn("Failed to notify Feishu pending asset update", error);
  }
}

function formCardInput(
  input: { env: AppEnv; assets: AssetService },
  action: FeishuActionEvent,
  reason?: string
): {
  reason?: string;
  values?: Record<string, string>;
  draftId?: string;
  assetCandidates: ReturnType<AssetService["getPendingAssetCandidates"]>;
  formUrl?: string;
} {
  const draft = action.draftId ? input.assets.getDraft(action.draftId) : undefined;
  return {
    reason,
    values: action.formValues,
    draftId: action.draftId,
    assetCandidates: input.assets.getPendingAssetCandidates({
      draftId: action.draftId,
      chatId: action.chatId,
      userId: action.userId
    }),
    formUrl: draft ? taskFormUrl(input.env, draft) : undefined
  };
}

function taskFormUrl(env: AppEnv, draft: TaskDraft): string | undefined {
  if (!env.FEISHU_PUBLIC_BASE_URL) {
    return undefined;
  }
  const base = env.FEISHU_PUBLIC_BASE_URL.replace(/\/+$/, "");
  return `${base}/forms/tasks/${encodeURIComponent(draft.id)}?token=${encodeURIComponent(draft.formToken)}`;
}

function getToken(query: unknown): string | undefined {
  const token = (query as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? token : undefined;
}

function normalizeWebFormValues(body: unknown): Record<string, string> {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      result[key] = value.map((item) => String(item)).filter(Boolean).join(",");
    } else {
      result[key] = String(value ?? "");
    }
  }
  return result;
}

function renderMessagePage(title: string, message: string): string {
  return htmlPage(title, `<main class="shell"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`);
}

function renderTaskFormPage(input: { draftId: string; token: string; projects: ProjectConfig[]; assets: PendingInputAsset[] }): string {
  const submitUrl = `/forms/tasks/${encodeURIComponent(input.draftId)}/submit?token=${encodeURIComponent(input.token)}`;
  const assetsUrl = `/forms/tasks/${encodeURIComponent(input.draftId)}/assets?token=${encodeURIComponent(input.token)}`;
  const projectOptions = input.projects.map((project) => `<option value="${escapeHtml(project.name)}">${escapeHtml(project.name)}</option>`).join("");
  const assetRows = input.assets.length
    ? input.assets.map((asset) => renderAssetRow(input.draftId, input.token, asset)).join("")
    : `<p class="empty">暂无可关联附件。</p>`;

  return htmlPage(
    "填写 Codex 任务表单",
    `
<main class="shell">
  <header class="page-header">
    <h1>填写 Codex 任务表单</h1>
    <p>请填写任务信息，图片可先预览再勾选。</p>
  </header>
  <form id="task-form" class="task-form">
    <label>项目<select name="projectName" required>${projectOptions}</select></label>
    <label>执行模式<select name="executionMode" required><option value="plan">先出方案</option><option value="agent">直接执行</option></select></label>
    <label>任务类型<select name="taskType" required><option value="bug">Bug 修复</option><option value="feature">功能需求</option></select></label>
    <label>修改范围<select name="scope" required><option value="frontend">前端</option><option value="backend">后端</option><option value="fullstack">全栈</option></select></label>
    <label>描述<textarea name="description" required rows="5" placeholder="请写清：要改什么、如何复现、期望结果、验收标准"></textarea></label>
    <section class="asset-section">
      <h2>关联附件</h2>
      <button id="refresh-assets" class="secondary" type="button">刷新附件</button>
      <div id="asset-list" class="asset-list">${assetRows}</div>
    </section>
    <label>附件清单与说明（可选）<textarea name="attachmentNote" rows="3" placeholder="例如：图 1 是当前效果，图 2 是期望效果"></textarea></label>
    <button class="submit" type="submit">提交任务</button>
    <p id="status" class="status" role="status"></p>
  </form>
</main>
<div id="preview-modal" class="modal" hidden>
  <div class="modal-panel">
    <button id="preview-close" class="close" type="button">关闭</button>
    <img id="preview-image" alt="附件预览" />
    <p id="preview-loading" class="status">加载预览中...</p>
    <video id="preview-video" controls playsinline preload="metadata" hidden></video>
    <p id="preview-error" class="status error"></p>
  </div>
</div>
<script>
const form = document.getElementById("task-form");
const statusEl = document.getElementById("status");
const assetList = document.getElementById("asset-list");
const refreshButton = document.getElementById("refresh-assets");
const modal = document.getElementById("preview-modal");
const image = document.getElementById("preview-image");
const video = document.getElementById("preview-video");
const previewLoading = document.getElementById("preview-loading");
const previewError = document.getElementById("preview-error");
const assetsUrl = "${assetsUrl}";
const draftId = "${escapeHtml(input.draftId)}";
const token = "${escapeHtml(input.token)}";
function escapeHtmlClient(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function shortAssetNameClient(value) {
  value = String(value || "attachment");
  return value.length > 34 ? value.slice(0, 33) + "..." : value;
}
function assetLabel(asset) {
  const date = new Date(asset.createdAt);
  const time = Number.isNaN(date.getTime()) ? "" : String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  return String(asset.label || "附件") + (time ? " " + time : "");
}
function previewUrl(asset) {
  return "/forms/tasks/" + encodeURIComponent(draftId) + "/assets/" + encodeURIComponent(asset.id) + "/preview?token=" + encodeURIComponent(token);
}
function renderAssetRowClient(asset, checked) {
  const canPreview = asset.assetType === "image" || asset.assetType === "video";
  const previewControl = canPreview
    ? '<button type="button" class="preview" data-preview="' + escapeHtmlClient(previewUrl(asset)) + '" data-type="' + escapeHtmlClient(asset.assetType) + '">预览</button>'
    : '<span class="not-previewable">不可预览</span>';
  return '<label class="asset-row">' +
    '<input type="checkbox" name="selectedAssetIds" value="' + escapeHtmlClient(asset.id) + '"' + (checked ? " checked" : "") + ' />' +
    '<span class="asset-main"><strong>' + escapeHtmlClient(assetLabel(asset)) + '</strong><span>' + escapeHtmlClient(shortAssetNameClient(asset.fileName)) + '</span></span>' +
    previewControl +
    '</label>';
}
async function openPreview(url, type) {
  previewError.textContent = "";
  previewLoading.hidden = false;
  image.hidden = true;
  video.hidden = true;
  if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
  if (video.dataset.objectUrl) URL.revokeObjectURL(video.dataset.objectUrl);
  delete image.dataset.objectUrl;
  delete video.dataset.objectUrl;
  image.removeAttribute("src");
  video.removeAttribute("src");
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("is-open"));
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("preview failed");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const target = type === "video" || blob.type.startsWith("video/") ? video : image;
    target.hidden = false;
    target.src = objectUrl;
    target.dataset.objectUrl = objectUrl;
  } catch (error) {
    previewLoading.hidden = true;
    previewError.textContent = "预览失败，请刷新附件列表。";
  }
}
function bindPreviewButtons() {
  document.querySelectorAll("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => openPreview(button.dataset.preview, button.dataset.type));
  });
}
bindPreviewButtons();
function closePreview() {
  modal.classList.remove("is-open");
  window.setTimeout(() => {
    modal.hidden = true;
    if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    if (video.dataset.objectUrl) URL.revokeObjectURL(video.dataset.objectUrl);
    delete image.dataset.objectUrl;
    delete video.dataset.objectUrl;
    image.removeAttribute("src");
    video.pause();
    video.removeAttribute("src");
  }, 140);
}
document.getElementById("preview-close").addEventListener("click", closePreview);
modal.addEventListener("click", (event) => {
  if (event.target === modal) closePreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.hidden) closePreview();
});
image.addEventListener("load", () => {
  previewLoading.hidden = true;
});
video.addEventListener("loadedmetadata", () => {
  previewLoading.hidden = true;
});
image.addEventListener("error", () => {
  previewError.textContent = "预览失败，请刷新附件列表。";
});
video.addEventListener("error", () => {
  previewLoading.hidden = true;
  previewError.textContent = "预览失败，请刷新附件列表。";
});
refreshButton.addEventListener("click", refreshAssets);
async function refreshAssets() {
  const selected = new Set(new FormData(form).getAll("selectedAssetIds").map(String));
  refreshButton.disabled = true;
  refreshButton.textContent = "刷新中...";
  try {
    const response = await fetch(assetsUrl, { headers: { Accept: "application/json" } });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.ok) throw new Error(json.error || "刷新失败");
    assetList.innerHTML = json.assets.length
      ? json.assets.map((asset) => renderAssetRowClient(asset, selected.has(asset.id))).join("")
      : '<p class="empty">暂无可关联附件。</p>';
    bindPreviewButtons();
  } catch (error) {
    assetList.innerHTML = '<p class="empty error">附件列表刷新失败，请稍后重试。</p>';
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = "刷新附件";
  }
}
function updateViewport() {
  const viewport = window.visualViewport;
  const height = Math.max(320, Math.floor(viewport ? viewport.height : window.innerHeight));
  const width = Math.floor(viewport ? viewport.width : window.innerWidth);
  document.documentElement.style.setProperty("--viewport-height", height + "px");
  document.documentElement.style.setProperty("--viewport-width", width + "px");
  const bottomInset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
  const keyboardOpen = Boolean(viewport && window.innerHeight - viewport.height > 80);
  document.documentElement.style.setProperty("--keyboard-inset", bottomInset + "px");
  document.documentElement.classList.toggle("keyboard-open", keyboardOpen);
  const active = document.activeElement;
  if (keyboardOpen && active && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
    window.setTimeout(() => keepFieldVisible(active), 40);
  }
}
function keepFieldVisible(element) {
  const viewport = window.visualViewport;
  const visibleTop = viewport ? viewport.offsetTop : 0;
  const visibleBottom = visibleTop + (viewport ? viewport.height : window.innerHeight);
  const rect = element.getBoundingClientRect();
  const margin = 18;
  if (rect.top < visibleTop + margin || rect.bottom > visibleBottom - margin) {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
updateViewport();
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", updateViewport);
  window.visualViewport.addEventListener("scroll", updateViewport);
}
window.addEventListener("resize", updateViewport);
document.querySelectorAll("input,select,textarea").forEach((element) => {
  element.addEventListener("focus", () => {
    window.setTimeout(updateViewport, 40);
    window.setTimeout(() => keepFieldVisible(element), 140);
    window.setTimeout(() => keepFieldVisible(element), 320);
  });
  element.addEventListener("blur", () => {
    window.setTimeout(updateViewport, 80);
    window.setTimeout(updateViewport, 260);
    window.setTimeout(updateViewport, 520);
  });
});
function returnToFeishuConversation() {
  const tryClose = () => {
    try {
      window.close();
    } catch {
      // Some in-app browsers ignore close requests; the visible status remains as fallback.
    }
  };
  if (window.history.length > 1) {
    window.history.back();
    window.setTimeout(tryClose, 800);
    return;
  }
  tryClose();
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.className = "status";
  statusEl.textContent = "提交中...";
  const data = new FormData(form);
  const selectedAssetIds = data.getAll("selectedAssetIds").map(String);
  const payload = Object.fromEntries(data.entries());
  payload.selectedAssetIds = selectedAssetIds;
  const response = await fetch("${submitUrl}", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.ok) {
    statusEl.className = "status error";
    statusEl.textContent = json.error || "提交失败，请稍后重试。";
    return;
  }
  form.querySelectorAll("input,select,textarea,button").forEach((element) => element.disabled = true);
  statusEl.className = "status success";
  statusEl.textContent = "任务已提交，正在返回飞书会话...";
  window.setTimeout(returnToFeishuConversation, 650);
});
</script>`
  );
}

function renderAssetRow(draftId: string, token: string, asset: PendingInputAsset): string {
  const label = webAssetLabel(asset);
  const previewUrl = `/forms/tasks/${encodeURIComponent(draftId)}/assets/${encodeURIComponent(asset.id)}/preview?token=${encodeURIComponent(token)}`;
  const previewButton =
    asset.assetType === "image" || asset.assetType === "video"
      ? `<button type="button" class="preview" data-preview="${escapeHtml(previewUrl)}">预览</button>`
      : `<span class="not-previewable">不可预览</span>`;
  return `
<label class="asset-row">
  <input type="checkbox" name="selectedAssetIds" value="${escapeHtml(asset.id)}" />
  <span class="asset-main"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(shortAssetName(asset.fileName))}</span></span>
  ${previewButton}
</label>`;
}

function webAssetLabel(asset: PendingInputAsset): string {
  const date = new Date(asset.createdAt);
  const time = Number.isNaN(date.getTime()) ? "" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${asset.label ?? "附件"} ${time}`.trim();
}

function shortAssetName(value: string): string {
  return value.length > 34 ? `${value.slice(0, 33)}...` : value;
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    html { width: 100%; min-height: 100%; overflow-x: hidden; scroll-padding-top: 16px; scroll-padding-bottom: calc(var(--keyboard-inset, 0px) + 96px); background: #f5f7fb; }
    body { width: 100%; min-height: 100%; overflow-x: hidden; margin: 0; background: #f5f7fb; color: #1f2329; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .shell { width: min(100%, 720px); min-height: var(--viewport-height, 100svh); margin: 0 auto; padding: 20px max(16px, env(safe-area-inset-left)) calc(40px + env(safe-area-inset-bottom) + var(--keyboard-inset, 0px)) max(16px, env(safe-area-inset-right)); overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .page-header { margin-bottom: 18px; }
    h1 { margin: 0 0 6px; font-size: 22px; line-height: 1.3; }
    h2 { margin: 0 0 10px; font-size: 16px; }
    p { margin: 0; color: #646a73; line-height: 1.6; }
    .task-form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; font-size: 14px; font-weight: 600; }
    select, textarea { width: 100%; min-width: 0; border: 1px solid #d0d3d9; border-radius: 8px; padding: 11px 12px; background: #fff; color: #1f2329; font: inherit; font-size: 16px; }
    textarea { resize: vertical; min-height: 92px; }
    .asset-section { display: grid; gap: 8px; }
    .asset-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .asset-list { display: grid; gap: 8px; }
    .asset-row { grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px; border: 1px solid #d8dbe2; border-radius: 8px; background: #fff; }
    .asset-row input { width: 20px; height: 20px; }
    .asset-main { display: grid; gap: 2px; min-width: 0; }
    .asset-main strong, .asset-main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .asset-main span { color: #646a73; font-weight: 400; font-size: 13px; }
    .preview, .submit, .close, .secondary { border: 0; border-radius: 8px; padding: 9px 12px; font: inherit; font-weight: 600; }
    .preview { background: #e8f0ff; color: #1456d9; }
    .secondary { background: #eef0f4; color: #1f2329; }
    .submit { width: 100%; margin-top: 4px; padding: 13px; background: #1456d9; color: #fff; }
    .not-previewable { color: #8f959e; font-size: 13px; }
    .empty { padding: 14px; border: 1px dashed #c9cdd4; border-radius: 8px; background: #fff; }
    .status { min-height: 22px; font-size: 14px; color: #646a73; }
    .status.error { color: #c02a1d; }
    .status.success { color: #207a3c; }
    .modal { position: fixed; inset: 0; z-index: 10; display: grid; align-items: end; min-height: var(--viewport-height, 100svh); background: rgba(0, 0, 0, .45); padding: 16px; opacity: 0; transition: opacity .14s ease-out; }
    .modal.is-open { opacity: 1; }
    .modal[hidden] { display: none; }
    .modal-panel { max-height: 88vh; overflow: auto; border-radius: 12px 12px 8px 8px; background: #fff; padding: 12px; transform: translateY(12px); transition: transform .14s ease-out; }
    .modal.is-open .modal-panel { transform: translateY(0); }
    .close { margin-bottom: 10px; background: #eef0f4; color: #1f2329; }
    #preview-image, #preview-video { display: block; width: 100%; max-height: 76vh; object-fit: contain; border-radius: 8px; background: #0f1115; }
    #preview-image[hidden], #preview-video[hidden] { display: none; }
    @media (min-width: 640px) { .modal { align-items: center; } .modal-panel { width: min(720px, 100%); margin: 0 auto; } }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function cardActionResponse(card: object, content: string, type: "success" | "warning" | "info" = "success") {
  return {
    toast: {
      type,
      content
    },
    card: {
      type: "raw",
      data: card
    }
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
