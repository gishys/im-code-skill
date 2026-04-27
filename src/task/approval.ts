import type { ParsedTaskMessage, ProjectConfig } from "../types.js";

export function isAutoApproved(project: ProjectConfig, task: ParsedTaskMessage, feishuUserId?: string | null): boolean {
  const rules = project.auto_approve_rules;
  if (!rules) {
    return false;
  }

  const userAllowed = Boolean(feishuUserId && rules.users?.includes(feishuUserId));
  const typeAllowed = Boolean(rules.task_types?.includes(task.taskType));
  const scopeAllowed =
    task.scope === "fullstack"
      ? Boolean(rules.scopes?.includes("frontend") && rules.scopes?.includes("backend"))
      : Boolean(rules.scopes?.includes(task.scope));

  return userAllowed && typeAllowed && scopeAllowed;
}
