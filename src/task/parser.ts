import type { ParsedTaskMessage, TaskExecutionMode, TaskScope, TaskType } from "../types.js";

const keyAliases: Record<string, keyof ParsedTaskMessage | "type" | "scope" | "mode"> = {
  project: "projectName",
  projectName: "projectName",
  "项目": "projectName",
  "项目名": "projectName",
  type: "type",
  "类型": "type",
  "任务类型": "type",
  scope: "scope",
  "范围": "scope",
  "修改范围": "scope",
  mode: "mode",
  executionMode: "mode",
  execution_mode: "mode",
  "模式": "mode",
  "执行模式": "mode",
  description: "description",
  "描述": "description",
  "需求描述": "description",
  "问题描述": "description"
};

function normalizeType(value: string): TaskType {
  const normalized = value.trim().toLowerCase();
  if (["bug", "缺陷", "问题", "修复"].includes(normalized)) {
    return "bug";
  }
  if (["feature", "需求", "功能", "新增"].includes(normalized)) {
    return "feature";
  }
  throw new Error(`不支持的任务类型：${value}。请使用 bug 或 feature。`);
}

function normalizeScope(value: string): TaskScope {
  const normalized = value.trim().toLowerCase();
  if (["前端", "frontend", "fe"].includes(normalized)) {
    return "frontend";
  }
  if (["后端", "backend", "be"].includes(normalized)) {
    return "backend";
  }
  if (["全栈", "fullstack", "both"].includes(normalized)) {
    return "fullstack";
  }
  throw new Error(`不支持的修改范围：${value}。请使用 前端、后端 或 全栈。`);
}

function normalizeExecutionMode(value: string): TaskExecutionMode {
  const normalized = value.trim().toLowerCase();
  if (["plan", "planning", "方案", "先出方案", "只出方案"].includes(normalized)) {
    return "plan";
  }
  if (["agent", "execute", "run", "执行", "直接执行"].includes(normalized)) {
    return "agent";
  }
  throw new Error(`不支持的执行模式：${value}。请使用 plan 或 agent。`);
}

export function parseTaskMessage(text: string): ParsedTaskMessage {
  const fields: Partial<ParsedTaskMessage> = {};
  const descriptionLines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (!match) {
      descriptionLines.push(line);
      continue;
    }

    const alias = keyAliases[match[1].trim()];
    if (!alias) {
      descriptionLines.push(line);
      continue;
    }

    const value = match[2].trim();
    if (alias === "type") {
      fields.taskType = normalizeType(value);
    } else if (alias === "scope") {
      fields.scope = normalizeScope(value);
    } else if (alias === "mode") {
      fields.executionMode = normalizeExecutionMode(value);
    } else if (alias === "description") {
      fields.description = value;
    } else {
      fields[alias] = value as never;
    }
  }

  if (descriptionLines.length > 0) {
    fields.description = [fields.description, ...descriptionLines].filter(Boolean).join("\n");
  }

  const missing: string[] = [];
  if (!fields.projectName) missing.push("项目");
  if (!fields.taskType) missing.push("类型");
  if (!fields.scope) missing.push("范围");
  if (!fields.description) missing.push("描述");
  if (missing.length > 0) {
    throw new Error(`缺少必填字段：${missing.join("、")}`);
  }

  return { ...fields, executionMode: fields.executionMode ?? "agent" } as ParsedTaskMessage;
}
