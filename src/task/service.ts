import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ParsedTaskMessage, TaskRecord, TaskStage, TaskStatus } from "../types.js";

function now(): string {
  return new Date().toISOString();
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    feishuEventId: row.feishu_event_id as string | null,
    feishuChatId: row.feishu_chat_id as string | null,
    feishuMessageId: row.feishu_message_id as string | null,
    feishuUserId: row.feishu_user_id as string | null,
    projectName: String(row.project_name),
    taskType: row.task_type as TaskRecord["taskType"],
    scope: row.scope as TaskRecord["scope"],
    executionMode: (row.execution_mode as TaskRecord["executionMode"] | null) ?? "agent",
    rawText: String(row.raw_text),
    parsedDescription: String(row.parsed_description),
    status: row.status as TaskStatus,
    approvalStatus: row.approval_status as TaskRecord["approvalStatus"],
    autoApproved: Boolean(row.auto_approved),
    currentStage: row.current_stage as TaskStage,
    failureStage: row.failure_stage as string | null,
    failureSummary: row.failure_summary as string | null,
    workspacePath: row.workspace_path as string | null,
    artifactPath: row.artifact_path as string | null,
    artifactFileKey: row.artifact_file_key as string | null,
    planSummary: row.plan_summary as string | null,
    planArtifactPath: row.plan_artifact_path as string | null,
    inputAssetsJson: row.input_assets_json as string | null,
    streamMessageId: row.stream_message_id as string | null,
    githubPrUrl: row.github_pr_url as string | null,
    githubBranch: row.github_branch as string | null,
    githubCommitSha: row.github_commit_sha as string | null,
    lockedBy: row.locked_by as string | null,
    lockedAt: row.locked_at as string | null,
    heartbeatAt: row.heartbeat_at as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at as string | null,
    finishedAt: row.finished_at as string | null
  };
}

export class TaskService {
  constructor(private readonly db: DatabaseSync) {}

  createTask(input: {
    parsed: ParsedTaskMessage;
    rawText: string;
    feishuEventId?: string;
    feishuChatId?: string;
    feishuMessageId?: string;
    feishuUserId?: string;
    autoApproved: boolean;
    deferQueue?: boolean;
  }): TaskRecord {
    const id = `task-${randomUUID()}`;
    const timestamp = now();
    const isPlan = input.parsed.executionMode === "plan";
    const status: TaskStatus = isPlan
      ? input.deferQueue
        ? "created"
        : "queued"
      : input.autoApproved
        ? input.deferQueue
          ? "created"
          : "queued"
        : "waiting_approval";
    const approvalStatus = isPlan ? "auto_approved" : input.autoApproved ? "auto_approved" : "pending";
    const currentStage = isPlan ? (input.deferQueue ? "received" : "queued") : input.autoApproved ? (input.deferQueue ? "received" : "queued") : "approval";

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, feishu_event_id, feishu_chat_id, feishu_message_id, feishu_user_id,
          project_name, task_type, scope, execution_mode, raw_text, parsed_description, status,
          approval_status, auto_approved, current_stage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.feishuEventId ?? null,
        input.feishuChatId ?? null,
        input.feishuMessageId ?? null,
        input.feishuUserId ?? null,
        input.parsed.projectName,
        input.parsed.taskType,
        input.parsed.scope,
        input.parsed.executionMode,
        input.rawText,
        input.parsed.description,
        status,
        approvalStatus,
        isPlan || input.autoApproved ? 1 : 0,
        currentStage,
        timestamp,
        timestamp
      );

    this.addEvent(id, "task_created", currentStage, "Task created");
    return this.getTask(id);
  }

  getTask(id: string): TaskRecord {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Task not found: ${id}`);
    }
    return rowToTask(row);
  }

  tryGetTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : undefined;
  }

  tryGetTaskByFeishuEventId(feishuEventId: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE feishu_event_id = ?").get(feishuEventId) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : undefined;
  }

  approveTask(id: string, feishuUserId?: string): TaskRecord {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'queued', approval_status = 'approved', current_stage = 'queued', updated_at = ?
         WHERE id = ? AND status = 'waiting_approval'`
      )
      .run(timestamp, id);
    this.db
      .prepare("INSERT INTO approvals (id, task_id, action, feishu_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), id, "approved", feishuUserId ?? null, timestamp);
    this.addEvent(id, "approved", "queued", "Task approved by user");
    return this.getTask(id);
  }

  approvePlanAsAgent(id: string, feishuUserId?: string): TaskRecord {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks
         SET execution_mode = 'agent', status = 'queued', approval_status = 'approved',
             current_stage = 'queued', updated_at = ?, finished_at = NULL
         WHERE id = ? AND execution_mode = 'plan' AND status = 'plan_ready'`
      )
      .run(timestamp, id);
    this.db
      .prepare("INSERT INTO approvals (id, task_id, action, feishu_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), id, "approved_plan_as_agent", feishuUserId ?? null, timestamp);
    this.addEvent(id, "approved_plan_as_agent", "queued", "Plan approved for agent execution");
    return this.getTask(id);
  }

  cancelTask(id: string, feishuUserId?: string): TaskRecord {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'canceled', approval_status = 'rejected', current_stage = 'failed', updated_at = ?, finished_at = ?
         WHERE id = ? AND status IN ('waiting_approval', 'queued', 'plan_ready')`
      )
      .run(timestamp, timestamp, id);
    this.db
      .prepare("INSERT INTO approvals (id, task_id, action, feishu_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), id, "canceled", feishuUserId ?? null, timestamp);
    this.addEvent(id, "canceled", "failed", "Task canceled by user");
    return this.getTask(id);
  }

  updateStage(id: string, stage: TaskStage, message: string): void {
    const timestamp = now();
    this.db.prepare("UPDATE tasks SET current_stage = ?, updated_at = ? WHERE id = ?").run(stage, timestamp, id);
    this.addEvent(id, "stage_changed", stage, message);
  }

  markRunning(id: string, workerId: string): void {
    const timestamp = now();
    this.db
      .prepare("UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?, heartbeat_at = ?, locked_by = ? WHERE id = ?")
      .run(timestamp, timestamp, timestamp, workerId, id);
  }

  markSucceeded(id: string, update: { artifactPath?: string; artifactFileKey?: string; githubPrUrl?: string; githubBranch?: string; githubCommitSha?: string }): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'succeeded', current_stage = 'done', artifact_path = COALESCE(?, artifact_path),
         artifact_file_key = COALESCE(?, artifact_file_key), github_pr_url = COALESCE(?, github_pr_url),
         github_branch = COALESCE(?, github_branch), github_commit_sha = COALESCE(?, github_commit_sha),
         updated_at = ?, finished_at = ? WHERE id = ?`
      )
      .run(update.artifactPath ?? null, update.artifactFileKey ?? null, update.githubPrUrl ?? null, update.githubBranch ?? null, update.githubCommitSha ?? null, timestamp, timestamp, id);
    this.addEvent(id, "succeeded", "done", "Task succeeded");
  }

  markPlanReady(id: string, update: { planSummary: string; planArtifactPath?: string }): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'plan_ready', current_stage = 'done',
         plan_summary = ?, plan_artifact_path = COALESCE(?, plan_artifact_path),
         updated_at = ?, finished_at = ? WHERE id = ?`
      )
      .run(update.planSummary, update.planArtifactPath ?? null, timestamp, timestamp, id);
    this.addEvent(id, "plan_ready", "done", "Plan is ready");
  }

  markFailed(id: string, stage: string, summary: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', current_stage = 'failed', failure_stage = ?, failure_summary = ?,
         updated_at = ?, finished_at = ? WHERE id = ?`
      )
      .run(stage, summary, timestamp, timestamp, id);
    this.addEvent(id, "failed", "failed", summary, { stage });
  }

  setStreamMessageId(id: string, messageId: string): void {
    this.db.prepare("UPDATE tasks SET stream_message_id = ?, updated_at = ? WHERE id = ?").run(messageId, now(), id);
  }

  enqueueTask(id: string): TaskRecord {
    const timestamp = now();
    this.db
      .prepare("UPDATE tasks SET status = 'queued', current_stage = 'queued', updated_at = ? WHERE id = ? AND status = 'created'")
      .run(timestamp, id);
    this.addEvent(id, "queued", "queued", "Task queued");
    return this.getTask(id);
  }

  updateTaskInputText(id: string, input: { rawText: string; parsedDescription: string }): TaskRecord {
    this.db
      .prepare("UPDATE tasks SET raw_text = ?, parsed_description = ?, updated_at = ? WHERE id = ?")
      .run(input.rawText, input.parsedDescription, now(), id);
    return this.getTask(id);
  }

  addEvent(taskId: string, eventType: string, stage: string | null, message: string, metadata?: unknown): void {
    this.db
      .prepare(
        "INSERT INTO task_events (id, task_id, event_type, stage, message, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(randomUUID(), taskId, eventType, stage, message, metadata ? JSON.stringify(metadata) : null, now());
  }
}
