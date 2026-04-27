import type { ParsedTaskMessage, TaskScope, TaskType } from "../types.js";

const keyAliases: Record<string, keyof ParsedTaskMessage | "type" | "scope"> = {
  项目: "projectName",
  project: "projectName",
  项目名: "projectName",
  类型: "type",
  type: "type",
  任务类型: "type",
  范围: "scope",
  scope: "scope",
  修改范围: "scope",
  描述: "description",
  description: "description",
  需求描述: "description",
  问题描述: "description"
};

function normalizeType(value: string): TaskType {
  const normalized = value.trim().toLowerCase();
  if (["bug", "缺陷", "问题", "修复"].includes(normalized)) {
    return "bug";
  }
  if (["需求", "feature", "新增", "功能"].includes(normalized)) {
    return "feature";
  }
  throw new Error(`不支持的任务类型：${value}。请使用 bug 或 需求。`);
}

function normalizeScope(value: string): TaskScope {
  const normalized = value.trim().toLowerCase();
  if (["前端", "frontend", "fe"].includes(normalized)) {
    return "frontend";
  }
  if (["后端", "backend", "be"].includes(normalized)) {
    return "backend";
  }
  if (["前后端", "全栈", "fullstack", "both"].includes(normalized)) {
    return "fullstack";
  }
  throw new Error(`不支持的修改范围：${value}。请使用 前端、后端 或 前后端。`);
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

  return fields as ParsedTaskMessage;
}
