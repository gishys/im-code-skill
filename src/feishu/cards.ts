import type { ProjectConfig, TaskRecord } from "../types.js";

const taskTypeLabel: Record<string, string> = {
  bug: "Bug 修复",
  feature: "新增需求"
};

const scopeLabel: Record<string, string> = {
  frontend: "前端",
  backend: "后端",
  fullstack: "前后端"
};

const statusLabel: Record<string, string> = {
  created: "已创建",
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
  cloning: "拉取仓库",
  codex_running: "Codex 修改代码",
  testing: "运行测试",
  building: "构建项目",
  packaging: "打包产物",
  creating_pr: "创建 PR",
  uploading: "上传飞书文件",
  done: "完成",
  failed: "失败"
};

export function buildTaskCard(task: TaskRecord, extra?: { logExcerpt?: string }): object {
  const lines = [
    `**任务 ID**：${task.id}`,
    `**项目**：${task.projectName}`,
    `**类型**：${taskTypeLabel[task.taskType] ?? task.taskType}`,
    `**范围**：${scopeLabel[task.scope] ?? task.scope}`,
    `**状态**：${statusLabel[task.status] ?? task.status}`,
    `**阶段**：${stageLabel[task.currentStage] ?? task.currentStage}`,
    task.githubPrUrl ? `**PR**：${task.githubPrUrl}` : undefined,
    task.artifactFileKey ? `**部署包**：已上传到飞书` : undefined,
    task.failureSummary ? `**失败原因**：${task.failureSummary}` : undefined,
    extra?.logExcerpt ? `**最近日志**：\n${extra.logExcerpt}` : undefined
  ].filter(Boolean);

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `Codex 任务：${statusLabel[task.status] ?? task.status}` },
      template: task.status === "failed" ? "red" : task.status === "succeeded" ? "green" : "blue"
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: lines.join("\n") }
      },
      {
        tag: "action",
        actions: [
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
        ]
      }
    ]
  };
}

export function buildHelpCard(input?: { reason?: string }): object {
  const reason = input?.reason ? `**提示**：${input.reason}\n\n` : "";
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "Codex 任务助手" },
      template: "blue"
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            `${reason}` +
            "**请按下面格式发送任务：**\n" +
            "```text\n" +
            "项目：demo-app\n" +
            "类型：bug\n" +
            "范围：前端\n" +
            "描述：修复登录页按钮点击无响应，并参考附件截图。\n" +
            "```\n" +
            "**字段说明**\n" +
            "- 项目：必须匹配系统配置里的项目名，例如 `demo-app`\n" +
            "- 类型：`bug` 或 `需求`\n" +
            "- 范围：`前端`、`后端` 或 `前后端`\n" +
            "- 描述：要改什么、如何复现、期望结果、验收标准"
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
      },
      {
        tag: "hr"
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content:
            "**附件支持**\n" +
            "- 图片：页面截图、报错截图、设计稿、UI 对比图\n" +
            "- 视频：操作录屏、交互问题、动画或复现路径\n" +
            "- 文件：需求文档、接口说明、日志文件\n\n" +
            "发送附件时，请在 `描述` 中说明附件用途，例如：`第一张图是当前效果，第二张图是期望效果`。"
        }
      }
    ]
  };
}

export function buildTaskFormCard(projects: ProjectConfig[], input?: { reason?: string; values?: Record<string, string> }): object {
  const projectOptions = projects.map((project) => ({
    text: { tag: "plain_text", content: project.name },
    value: project.name
  }));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "填写 Codex 任务表单" },
      template: input?.reason ? "orange" : "blue"
    },
    elements: [
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
          content: "请填写任务信息后提交。图片、视频、文件请直接发送到当前会话，并在“附件说明”中写清用途。"
        }
      },
      {
        tag: "hr"
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: "**项目**" }
      },
      {
        tag: "select_static",
        name: "projectName",
        placeholder: { tag: "plain_text", content: "请选择项目" },
        initial_option: projectOptions.find((option) => option.value === input?.values?.projectName),
        options: projectOptions
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: "**类型**" }
      },
      {
        tag: "select_static",
        name: "taskType",
        placeholder: { tag: "plain_text", content: "请选择任务类型" },
        initial_option: optionOf(
          [
            ["bug", "Bug 修复"],
            ["feature", "新增需求"]
          ],
          input?.values?.taskType
        ),
        options: [
          { text: { tag: "plain_text", content: "Bug 修复" }, value: "bug" },
          { text: { tag: "plain_text", content: "新增需求" }, value: "feature" }
        ]
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: "**范围**" }
      },
      {
        tag: "select_static",
        name: "scope",
        placeholder: { tag: "plain_text", content: "请选择修改范围" },
        initial_option: optionOf(
          [
            ["frontend", "前端"],
            ["backend", "后端"],
            ["fullstack", "前后端"]
          ],
          input?.values?.scope
        ),
        options: [
          { text: { tag: "plain_text", content: "前端" }, value: "frontend" },
          { text: { tag: "plain_text", content: "后端" }, value: "backend" },
          { text: { tag: "plain_text", content: "前后端" }, value: "fullstack" }
        ]
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: "**描述**" }
      },
      {
        tag: "input",
        name: "description",
        multiline: true,
        placeholder: {
          tag: "plain_text",
          content: "请写清：要改什么、如何复现、期望结果、验收标准"
        },
        default_value: input?.values?.description ?? ""
      },
      {
        tag: "div",
        text: { tag: "lark_md", content: "**附件说明（可选）**" }
      },
      {
        tag: "input",
        name: "attachmentNote",
        multiline: true,
        placeholder: {
          tag: "plain_text",
          content: "例如：第一张图是当前效果，视频是复现路径，日志文件是后端错误日志"
        },
        default_value: input?.values?.attachmentNote ?? ""
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "提交任务" },
            type: "primary",
            value: { action: "submit_task_form" }
          },
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

function optionOf(options: Array<[string, string]>, value?: string) {
  const option = options.find(([candidate]) => candidate === value);
  return option ? { text: { tag: "plain_text", content: option[1] }, value: option[0] } : undefined;
}
