import type { PendingInputAsset, ProjectConfig, TaskRecord } from "../types.js";

const taskTypeLabel: Record<string, string> = {
  bug: "Bug 修复",
  feature: "功能需求"
};

const executionModeLabel: Record<string, string> = {
  plan: "先出方案",
  agent: "直接执行"
};

const scopeLabel: Record<string, string> = {
  frontend: "前端",
  backend: "后端",
  fullstack: "全栈"
};

const statusLabel: Record<string, string> = {
  created: "已创建",
  plan_ready: "方案已就绪",
  waiting_approval: "等待确认",
  queued: "排队中",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  canceled: "已取消",
  interrupted: "已中断"
};

const stageLabel: Record<string, string> = {
  received: "已接收",
  approval: "等待确认",
  queued: "排队中",
  planning: "生成方案",
  cloning: "准备代码",
  codex_running: "Codex 执行中",
  testing: "测试中",
  building: "构建中",
  packaging: "打包中",
  creating_pr: "创建 PR",
  uploading: "上传产物",
  done: "完成",
  failed: "失败"
};

export function buildTaskCard(task: TaskRecord, extra?: { logExcerpt?: string }): object {
  const inputAssetCount = countInputAssets(task.inputAssetsJson);
  const lines = [
    `**任务 ID**：${task.id}`,
    `**项目**：${task.projectName}`,
    `**模式**：${executionModeLabel[task.executionMode] ?? task.executionMode}`,
    `**类型**：${taskTypeLabel[task.taskType] ?? task.taskType}`,
    `**范围**：${scopeLabel[task.scope] ?? task.scope}`,
    `**状态**：${statusLabel[task.status] ?? task.status}`,
    `**阶段**：${stageLabel[task.currentStage] ?? task.currentStage}`,
    inputAssetCount > 0 ? `**关联附件**：${inputAssetCount} 个` : undefined,
    task.planSummary ? `**方案摘要**：\n${task.planSummary}` : undefined,
    task.githubPrUrl ? `**PR**：${task.githubPrUrl}` : undefined,
    task.artifactFileKey ? "**部署包**：已上传到飞书" : undefined,
    task.failureSummary ? `**失败原因**：${task.failureSummary}` : undefined,
    extra?.logExcerpt ? `**日志摘要**：\n${extra.logExcerpt}` : undefined
  ].filter(Boolean);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `Codex 任务：${statusLabel[task.status] ?? task.status}` },
      template: task.status === "failed" ? "red" : task.status === "succeeded" || task.status === "plan_ready" ? "green" : "blue"
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: lines.join("\n") }
      },
      ...buildPlanReviewElements(task),
      ...buildFailedContinuationElements(task),
      {
        tag: "action",
        actions: taskActionsForStatus(task)
      }
    ]
  };
}

export function buildHelpCard(input?: { reason?: string }): object {
  const reason = input?.reason ? `**提示**：${input.reason}\n\n` : "";
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Codex 任务帮助" },
      template: "blue"
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            `${reason}` +
            "发送“表单”可打开任务表单。表单里可选择“先出方案”或“直接执行”。\n\n" +
            "也可以发送结构化文本：\n" +
            "```text\n" +
            "项目：demo-app\n" +
            "模式：agent\n" +
            "类型：bug\n" +
            "范围：前端\n" +
            "描述：请说明要改什么、如何复现、期望结果\n" +
            "```"
        }
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "填写任务表单" },
            type: "primary",
            value: { action: "open_task_form" }
          }
        ]
      }
    ]
  };
}

export function buildTaskFormCard(
  projects: ProjectConfig[],
  input?: { reason?: string; values?: Record<string, string>; draftId?: string; assetCandidates?: PendingInputAsset[]; formUrl?: string }
): object {
  const projectOptions = projects.map((project) => ({
    text: { tag: "plain_text", content: project.name },
    value: project.name
  }));
  const selectedAssetIds = parseSelectedAssetIds(input?.values?.selectedAssetIds);
  const assetCandidates = input?.assetCandidates ?? [];
  const assetOptions = assetCandidates.map((asset) => ({
    text: { tag: "plain_text", content: formatAssetOption(asset) },
    value: asset.id
  }));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "填写 Codex 任务表单" },
      template: input?.reason ? "orange" : "blue"
    },
    elements: input?.formUrl
      ? buildTaskFormEntryElements(input.formUrl, assetCandidates, input.reason, input.draftId)
      : [
      ...(input?.reason
        ? [
            {
              tag: "div",
              text: { tag: "lark_md", content: `**提示**：${input.reason}` }
            }
          ]
        : []),
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            "请填写任务信息后提交。\n\n" +
            "**附件处理方式**：图片、视频、文件请先直接发送到当前会话；然后点击“刷新附件列表”，在表单里选择要关联的附件。"
        }
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            assetCandidates.length > 0
              ? `已检测到 **${assetCandidates.length}** 个可关联附件，请在表单中选择。`
              : "未检测到可关联附件。"
        }
      },
      {
        tag: "hr"
      },
      {
        tag: "form",
        name: "task_form",
        elements: [
          {
            tag: "select_static",
            name: "projectName",
            required: true,
            placeholder: { tag: "plain_text", content: "请选择项目" },
            initial_index: initialIndex(projectOptions, input?.values?.projectName),
            options: projectOptions
          },
          {
            tag: "select_static",
            name: "executionMode",
            required: true,
            placeholder: { tag: "plain_text", content: "请选择执行模式" },
            initial_index: optionOf(
              [
                ["plan", "先出方案"],
                ["agent", "直接执行"]
              ],
              input?.values?.executionMode
            ),
            options: [
              { text: { tag: "plain_text", content: "先出方案" }, value: "plan" },
              { text: { tag: "plain_text", content: "直接执行" }, value: "agent" }
            ]
          },
          {
            tag: "select_static",
            name: "taskType",
            required: true,
            placeholder: { tag: "plain_text", content: "请选择任务类型" },
            initial_index: optionOf(
              [
                ["bug", "Bug 修复"],
                ["feature", "功能需求"]
              ],
              input?.values?.taskType
            ),
            options: [
              { text: { tag: "plain_text", content: "Bug 修复" }, value: "bug" },
              { text: { tag: "plain_text", content: "功能需求" }, value: "feature" }
            ]
          },
          {
            tag: "select_static",
            name: "scope",
            required: true,
            placeholder: { tag: "plain_text", content: "请选择修改范围" },
            initial_index: optionOf(
              [
                ["frontend", "前端"],
                ["backend", "后端"],
                ["fullstack", "全栈"]
              ],
              input?.values?.scope ?? "fullstack"
            ),
            options: [
              { text: { tag: "plain_text", content: "前端" }, value: "frontend" },
              { text: { tag: "plain_text", content: "后端" }, value: "backend" },
              { text: { tag: "plain_text", content: "全栈" }, value: "fullstack" }
            ]
          },
          {
            tag: "input",
            name: "description",
            required: true,
            multiline: true,
            label: { tag: "plain_text", content: "描述" },
            placeholder: {
              tag: "plain_text",
              content: "请写清：要改什么、如何复现、期望结果、验收标准"
            },
            default_value: input?.values?.description ?? ""
          },
          {
            tag: "multi_select_static",
            name: "selectedAssetIds",
            placeholder: { tag: "plain_text", content: "请选择要关联到本任务的附件" },
            selected_values: selectedAssetIds.filter((id) => assetOptions.some((option) => option.value === id)),
            disabled: assetOptions.length === 0,
            options: assetOptions
          },
          {
            tag: "input",
            name: "attachmentNote",
            multiline: true,
            label: { tag: "plain_text", content: "附件清单与说明（可选）" },
            placeholder: {
              tag: "plain_text",
              content: "例如：图 1 是当前效果，图 2 是期望效果"
            },
            default_value: input?.values?.attachmentNote ?? ""
          },
          {
            tag: "button",
            name: "refreshAssets",
            action_type: "form_submit",
            text: { tag: "plain_text", content: "刷新附件列表" },
            value: { action: "refresh_task_form_assets", draftId: input?.draftId }
          },
          {
            tag: "button",
            name: "submit",
            action_type: "form_submit",
            text: { tag: "plain_text", content: "提交任务" },
            type: "primary",
            value: { action: "submit_task_form", draftId: input?.draftId }
          }
        ]
      },
      ...buildAssetPreviewButtonElements(assetCandidates, input?.draftId),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "查看填写说明" },
            value: { action: "open_help" }
          }
        ]
      }
      ]
  };
}

function buildTaskFormEntryElements(formUrl: string, assetCandidates: PendingInputAsset[], reason?: string, draftId?: string): object[] {
  return [
    ...(reason
      ? [
          {
            tag: "div",
            text: { tag: "lark_md", content: `**提示**：${reason}` }
          }
        ]
      : []),
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content:
          "请打开移动端任务表单填写信息并选择附件。\n\n" +
          (assetCandidates.length > 0
            ? `已检测到 **${assetCandidates.length}** 个可关联附件，表单中可逐项预览图片后勾选。`
            : "暂未检测到可关联附件。")
      }
    },
    {
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "打开任务表单" },
          type: "primary",
          url: formUrl
        }
      ]
    }
  ];
}

export function buildAssetPreviewCard(asset: PendingInputAsset): object {
  const title = formatAssetOption(asset);
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: "blue"
    },
    elements: [
      {
        tag: "img",
        img_key: asset.feishuFileKey,
        alt: { tag: "plain_text", content: title },
        preview: true
      }
    ]
  };
}

function taskActions(task: TaskRecord): object[] {
  if (task.status === "execution_review" || task.status === "needs_input") {
    return [
      {
        tag: "button",
        text: { tag: "plain_text", content: "继续处理" },
        type: "primary",
        value: { action: "continue_task", taskId: task.id }
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "查看历史" },
        value: { action: "view_history", taskId: task.id }
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "取消任务" },
        type: "danger",
        value: { action: "cancel", taskId: task.id }
      }
    ];
  }
  if (task.executionMode === "plan" && task.status === "plan_ready") {
    return [
      {
        tag: "button",
        text: { tag: "plain_text", content: "转为 Agent 执行" },
        type: "primary",
        value: { action: "approve_plan_as_agent", taskId: task.id }
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "取消任务" },
        type: "danger",
        value: { action: "cancel", taskId: task.id }
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "查看状态" },
        value: { action: "status", taskId: task.id }
      }
    ];
  }

  return [
    {
      tag: "button",
      text: { tag: "plain_text", content: "确认执行" },
      type: "primary",
      value: { action: "approve", taskId: task.id }
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "取消任务" },
      type: "danger",
      value: { action: "cancel", taskId: task.id }
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "查看状态" },
      value: { action: "status", taskId: task.id }
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "重新执行" },
      value: { action: "retry", taskId: task.id }
    }
  ];
}

function taskActionsForStatus(task: TaskRecord): object[] {
  if (task.status === "execution_review" || task.status === "needs_input") {
    return [
      primaryButton("continue_task", task.id, "继续处理"),
      plainButton("view_history", task.id, "查看历史"),
      dangerButton("cancel", task.id, "取消任务")
    ];
  }

  if (task.executionMode === "plan" && task.status === "plan_ready") {
    return [
      primaryButton("approve_plan_as_agent", task.id, "转为 Agent 执行"),
      dangerButton("cancel", task.id, "取消任务"),
      statusButton(task.id)
    ];
  }

  if (task.status === "waiting_approval") {
    return [
      primaryButton("approve", task.id, "确认执行"),
      dangerButton("cancel", task.id, "取消任务"),
      statusButton(task.id)
    ];
  }

  if (task.status === "created" || task.status === "queued" || task.status === "running") {
    return [dangerButton("cancel", task.id, "取消任务"), statusButton(task.id)];
  }

  if (task.status === "failed") {
    return [statusButton(task.id), primaryButton("retry", task.id, "再次执行")];
  }

  return [statusButton(task.id)];
}

function buildPlanReviewElements(task: TaskRecord): object[] {
  if (task.executionMode !== "plan" || task.status !== "plan_ready") {
    return [];
  }
  return [
    {
      tag: "hr"
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "**方案确认**\n确认后会转为 Agent 执行；如需调整，请填写修改意见并提交，系统会生成新的方案版本。"
      }
    },
    {
      tag: "form",
      name: "plan_review_form",
      elements: [
        {
          tag: "input",
          name: "planFeedback",
          multiline: true,
          label: { tag: "plain_text", content: "修改意见" },
          placeholder: { tag: "plain_text", content: "例如：缩小范围、补充回滚步骤，或调整测试方案" }
        },
        {
          tag: "button",
          name: "revisePlan",
          action_type: "form_submit",
          text: { tag: "plain_text", content: "修改方案" },
          value: { action: "revise_plan", taskId: task.id }
        }
      ]
    }
  ];
}

function buildFailedContinuationElements(task: TaskRecord): object[] {
  if (task.status !== "failed" && task.status !== "interrupted") {
    return [];
  }
  return [
    {
      tag: "hr"
    },
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "**继续会话**\n可以补充新的要求、授权说明或报错背景，提交后任务会带着这些上下文重新排队。"
      }
    },
    {
      tag: "form",
      name: "failed_continue_form",
      elements: [
        {
          tag: "input",
          name: "description",
          multiline: true,
          label: { tag: "plain_text", content: "补充说明" },
          placeholder: { tag: "plain_text", content: "例如：已授权本机执行，请复用现有 worktree 后继续。" }
        },
        {
          tag: "button",
          name: "continueTask",
          action_type: "form_submit",
          text: { tag: "plain_text", content: "继续会话" },
          type: "primary",
          value: { action: "continue_task", taskId: task.id }
        }
      ]
    }
  ];
}

function primaryButton(action: string, taskId: string, content: string): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    type: "primary",
    value: { action, taskId }
  };
}

function dangerButton(action: string, taskId: string, content: string): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    type: "danger",
    value: { action, taskId }
  };
}

function plainButton(action: string, taskId: string, content: string): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content },
    value: { action, taskId }
  };
}

function statusButton(taskId: string): object {
  return plainButton("status", taskId, "查看状态");
}

function initialIndex(options: Array<{ value: string }>, value?: string): number | undefined {
  const index = options.findIndex((option) => option.value === value);
  return index >= 0 ? index : undefined;
}

function optionOf(options: Array<[string, string]>, value?: string): number | undefined {
  const index = options.findIndex(([candidate]) => candidate === value);
  return index >= 0 ? index : undefined;
}

function parseSelectedAssetIds(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function formatAssetOption(asset: PendingInputAsset): string {
  const label = asset.label ?? "附件";
  const date = new Date(asset.createdAt);
  const time = Number.isNaN(date.getTime()) ? "" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const name = asset.fileName.length > 28 ? `${asset.fileName.slice(0, 27)}…` : asset.fileName;
  return `${label} ${time} ${name}`;
}

function buildAssetPreviewButtonElements(assets: PendingInputAsset[], draftId?: string): object[] {
  const imageAssets = assets.filter((asset) => asset.assetType === "image");
  if (imageAssets.length === 0) {
    return [];
  }

  const actionBlocks = chunk(imageAssets, 6).map((assetsInRow) => ({
    tag: "action",
    actions: assetsInRow.map((asset) => ({
      tag: "button",
      text: { tag: "plain_text", content: `预览${asset.label ?? "图片"}` },
      value: { action: "preview_task_form_asset", draftId, assetId: asset.id }
    }))
  }));

  return [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: "**图片预览**：先点按钮查看，再在附件选择框中勾选对应图片。"
      }
    },
    ...actionBlocks
  ];
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function countInputAssets(value?: string | null): number {
  if (!value) {
    return 0;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
