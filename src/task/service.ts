import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ChangesetRecord,
  CodexRunRecord,
  DeliveryThreadRecord,
  ParsedTaskMessage,
  PlanVersionRecord,
  PullRequestRecord,
  TaskRecord,
  TaskStage,
  TaskStatus
} from "../types.js";

function now(): string {
  return new Date().toISOString();
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row.id),
    threadId: row.thread_id as string | null,
    changesetId: row.changeset_id as string | null,
    currentPlanVersionId: row.current_plan_version_id as string | null,
    deliveryStatus: row.delivery_status as TaskRecord["deliveryStatus"],
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

function rowToThread(row: Record<string, unknown>): DeliveryThreadRecord {
  return {
    id: String(row.id),
    source: "feishu",
    projectName: String(row.project_name),
    goalSummary: String(row.goal_summary),
    feishuChatId: row.feishu_chat_id as string | null,
    feishuUserId: row.feishu_user_id as string | null,
    status: row.status as DeliveryThreadRecord["status"],
    currentChangesetId: row.current_changeset_id as string | null,
    currentPullRequestId: row.current_pull_request_id as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToCodexRun(row: Record<string, unknown>): CodexRunRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    threadId: row.thread_id as string | null,
    runType: row.run_type as CodexRunRecord["runType"],
    status: row.status as CodexRunRecord["status"],
    promptPath: String(row.prompt_path),
    logPath: String(row.log_path),
    summaryPath: row.summary_path as string | null,
    handoffPath: row.handoff_path as string | null,
    exitCode: row.exit_code as number | null,
    summary: String(row.summary),
    createdAt: String(row.created_at),
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at)
  };
}

function rowToPlanVersion(row: Record<string, unknown>): PlanVersionRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    threadId: row.thread_id as string | null,
    version: Number(row.version),
    planPath: String(row.plan_path),
    summary: String(row.summary),
    status: row.status as PlanVersionRecord["status"],
    codexRunId: row.codex_run_id as string | null,
    createdAt: String(row.created_at)
  };
}

function rowToChangeset(row: Record<string, unknown>): ChangesetRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    projectName: String(row.project_name),
    branch: row.branch as string | null,
    commitSha: row.commit_sha as string | null,
    artifactPath: row.artifact_path as string | null,
    testSummary: row.test_summary as string | null,
    status: row.status as ChangesetRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function rowToPullRequest(row: Record<string, unknown>): PullRequestRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    changesetId: String(row.changeset_id),
    url: String(row.url),
    branch: row.branch as string | null,
    commitSha: row.commit_sha as string | null,
    status: row.status as PullRequestRecord["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class TaskService {
  constructor(private readonly db: DatabaseSync) {}

  createTask(input: {
    parsed: ParsedTaskMessage;
    rawText: string;
    threadId?: string;
    feishuEventId?: string;
    feishuChatId?: string;
    feishuMessageId?: string;
    feishuUserId?: string;
    autoApproved: boolean;
    deferQueue?: boolean;
  }): TaskRecord {
    const id = `task-${randomUUID()}`;
    const timestamp = now();
    const threadId =
      input.threadId ??
      this.createDeliveryThread({
        projectName: input.parsed.projectName,
        goalSummary: input.parsed.description,
        feishuChatId: input.feishuChatId,
        feishuUserId: input.feishuUserId
      }).id;
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
          id, thread_id, feishu_event_id, feishu_chat_id, feishu_message_id, feishu_user_id,
          project_name, task_type, scope, execution_mode, raw_text, parsed_description, status,
          approval_status, auto_approved, current_stage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        threadId,
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
    this.addTaskMessage({
      threadId,
      taskId: id,
      role: "user",
      messageType: "initial_request",
      content: input.parsed.description
    });
    return this.getTask(id);
  }

  createDeliveryThread(input: { projectName: string; goalSummary: string; feishuChatId?: string; feishuUserId?: string }): DeliveryThreadRecord {
    const id = `thread-${randomUUID()}`;
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO delivery_threads (
          id, source, project_name, goal_summary, feishu_chat_id, feishu_user_id, status, created_at, updated_at
        ) VALUES (?, 'feishu', ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(id, input.projectName, tail(input.goalSummary, 2000), input.feishuChatId ?? null, input.feishuUserId ?? null, timestamp, timestamp);
    return this.getThread(id);
  }

  getThread(id: string): DeliveryThreadRecord {
    const row = this.db.prepare("SELECT * FROM delivery_threads WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Thread not found: ${id}`);
    }
    return rowToThread(row);
  }

  tryGetThread(id: string): DeliveryThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM delivery_threads WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToThread(row) : undefined;
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
    const status = update.githubPrUrl ? "delivered" : "succeeded";
    const deliveryStatus = update.githubPrUrl ? "delivered" : "included_in_changeset";
    this.db
      .prepare(
        `UPDATE tasks SET status = ?, delivery_status = ?, current_stage = 'done', artifact_path = COALESCE(?, artifact_path),
         artifact_file_key = COALESCE(?, artifact_file_key), github_pr_url = COALESCE(?, github_pr_url),
         github_branch = COALESCE(?, github_branch), github_commit_sha = COALESCE(?, github_commit_sha),
         updated_at = ?, finished_at = ? WHERE id = ?`
      )
      .run(status, deliveryStatus, update.artifactPath ?? null, update.artifactFileKey ?? null, update.githubPrUrl ?? null, update.githubBranch ?? null, update.githubCommitSha ?? null, timestamp, timestamp, id);
    const task = this.getTask(id);
    if (task.threadId && update.githubPrUrl) {
      this.db.prepare("UPDATE delivery_threads SET status = 'delivered', updated_at = ? WHERE id = ?").run(timestamp, task.threadId);
    }
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

  addTaskMessage(input: { threadId?: string | null; taskId?: string | null; role: string; messageType: string; content: string; metadata?: unknown }): void {
    this.db
      .prepare(
        `INSERT INTO task_messages (id, thread_id, task_id, role, message_type, content, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), input.threadId ?? null, input.taskId ?? null, input.role, input.messageType, input.content, input.metadata ? JSON.stringify(input.metadata) : null, now());
  }

  addCodexRun(input: {
    id: string;
    taskId: string;
    threadId?: string | null;
    runType: CodexRunRecord["runType"];
    status: CodexRunRecord["status"];
    promptPath: string;
    logPath: string;
    summaryPath?: string | null;
    handoffPath?: string | null;
    exitCode?: number | null;
    summary: string;
    startedAt: string;
    finishedAt: string;
  }): CodexRunRecord {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO codex_runs (
          id, thread_id, task_id, run_type, status, prompt_path, log_path, summary_path, handoff_path,
          exit_code, summary, created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.threadId ?? null,
        input.taskId,
        input.runType,
        input.status,
        input.promptPath,
        input.logPath,
        input.summaryPath ?? null,
        input.handoffPath ?? null,
        input.exitCode ?? null,
        input.summary,
        timestamp,
        input.startedAt,
        input.finishedAt
      );
    this.addTaskMessage({
      threadId: input.threadId,
      taskId: input.taskId,
      role: "assistant",
      messageType: `codex_${input.runType}`,
      content: input.summary,
      metadata: { codexRunId: input.id, status: input.status }
    });
    return this.getCodexRun(input.id);
  }

  getCodexRun(id: string): CodexRunRecord {
    const row = this.db.prepare("SELECT * FROM codex_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Codex run not found: ${id}`);
    }
    return rowToCodexRun(row);
  }

  addPlanVersion(input: { taskId: string; threadId?: string | null; planPath: string; summary: string; codexRunId?: string | null }): PlanVersionRecord {
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM plan_versions WHERE task_id = ?").get(input.taskId) as { version: number };
    this.db.prepare("UPDATE plan_versions SET status = 'superseded' WHERE task_id = ? AND status = 'draft'").run(input.taskId);
    const id = `plan-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO plan_versions (id, thread_id, task_id, version, plan_path, summary, status, codex_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      )
      .run(id, input.threadId ?? null, input.taskId, row.version, input.planPath, input.summary, input.codexRunId ?? null, now());
    this.db.prepare("UPDATE tasks SET current_plan_version_id = ?, updated_at = ? WHERE id = ?").run(id, now(), input.taskId);
    return this.getPlanVersion(id);
  }

  approveLatestPlan(taskId: string, feishuUserId?: string): TaskRecord {
    const task = this.getTask(taskId);
    if (task.currentPlanVersionId) {
      this.db.prepare("UPDATE plan_versions SET status = 'approved' WHERE id = ?").run(task.currentPlanVersionId);
    }
    return this.approvePlanAsAgent(taskId, feishuUserId);
  }

  getPlanVersion(id: string): PlanVersionRecord {
    const row = this.db.prepare("SELECT * FROM plan_versions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Plan version not found: ${id}`);
    }
    return rowToPlanVersion(row);
  }

  addContextSnapshot(input: { taskId: string; threadId?: string | null; codexRunId?: string | null; snapshotPath: string; summary: string; tokenBudgetChars: number }): void {
    this.db
      .prepare(
        `INSERT INTO task_context_snapshots (id, thread_id, task_id, codex_run_id, snapshot_path, summary, token_budget_chars, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), input.threadId ?? null, input.taskId, input.codexRunId ?? null, input.snapshotPath, input.summary, input.tokenBudgetChars, now());
  }

  createOrUpdateChangeset(input: { threadId: string; taskId: string; projectName: string; branch?: string; commitSha?: string; artifactPath?: string; testSummary?: string }): ChangesetRecord {
    const existing = this.db
      .prepare("SELECT * FROM changesets WHERE thread_id = ? AND status IN ('open', 'ready_for_pr') ORDER BY created_at DESC LIMIT 1")
      .get(input.threadId) as Record<string, unknown> | undefined;
    const timestamp = now();
    const id = existing ? String(existing.id) : `changeset-${randomUUID()}`;
    if (existing) {
      this.db
        .prepare(
          `UPDATE changesets SET branch = COALESCE(?, branch), commit_sha = COALESCE(?, commit_sha),
           artifact_path = COALESCE(?, artifact_path), test_summary = COALESCE(?, test_summary),
           status = 'ready_for_pr', updated_at = ? WHERE id = ?`
        )
        .run(input.branch ?? null, input.commitSha ?? null, input.artifactPath ?? null, input.testSummary ?? null, timestamp, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO changesets (id, thread_id, project_name, branch, commit_sha, artifact_path, test_summary, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ready_for_pr', ?, ?)`
        )
        .run(id, input.threadId, input.projectName, input.branch ?? null, input.commitSha ?? null, input.artifactPath ?? null, input.testSummary ?? null, timestamp, timestamp);
    }
    this.db.prepare("INSERT OR IGNORE INTO changeset_tasks (changeset_id, task_id, created_at) VALUES (?, ?, ?)").run(id, input.taskId, timestamp);
    this.db
      .prepare("UPDATE tasks SET changeset_id = ?, delivery_status = 'included_in_changeset', updated_at = ? WHERE id = ?")
      .run(id, timestamp, input.taskId);
    this.db.prepare("UPDATE delivery_threads SET current_changeset_id = ?, status = 'running', updated_at = ? WHERE id = ?").run(id, timestamp, input.threadId);
    return this.getChangeset(id);
  }

  getChangeset(id: string): ChangesetRecord {
    const row = this.db.prepare("SELECT * FROM changesets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Changeset not found: ${id}`);
    }
    return rowToChangeset(row);
  }

  tryGetChangeset(id: string): ChangesetRecord | undefined {
    const row = this.db.prepare("SELECT * FROM changesets WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? rowToChangeset(row) : undefined;
  }

  recordPullRequest(input: { threadId: string; changesetId: string; url: string; branch?: string; commitSha?: string }): PullRequestRecord {
    const id = `pr-${randomUUID()}`;
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO pull_requests (id, thread_id, changeset_id, url, branch, commit_sha, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
      )
      .run(id, input.threadId, input.changesetId, input.url, input.branch ?? null, input.commitSha ?? null, timestamp, timestamp);
    this.db.prepare("UPDATE changesets SET status = 'pr_created', updated_at = ? WHERE id = ?").run(timestamp, input.changesetId);
    this.db
      .prepare("UPDATE tasks SET status = 'included_in_pr', delivery_status = 'included_in_pr', updated_at = ? WHERE changeset_id = ?")
      .run(timestamp, input.changesetId);
    this.db
      .prepare("UPDATE delivery_threads SET current_pull_request_id = ?, status = 'pr_created', updated_at = ? WHERE id = ?")
      .run(id, timestamp, input.threadId);
    return this.getPullRequest(id);
  }

  getPullRequest(id: string): PullRequestRecord {
    const row = this.db.prepare("SELECT * FROM pull_requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Pull request not found: ${id}`);
    }
    return rowToPullRequest(row);
  }

  getTaskDetails(id: string): object {
    const task = this.getTask(id);
    return {
      ...task,
      thread: task.threadId ? this.tryGetThread(task.threadId) : null,
      codexRuns: this.db.prepare("SELECT * FROM codex_runs WHERE task_id = ? ORDER BY created_at").all(id).map((row) => rowToCodexRun(row as Record<string, unknown>)),
      planVersions: this.db.prepare("SELECT * FROM plan_versions WHERE task_id = ? ORDER BY version").all(id).map((row) => rowToPlanVersion(row as Record<string, unknown>)),
      contextSnapshots: this.db.prepare("SELECT * FROM task_context_snapshots WHERE task_id = ? ORDER BY created_at").all(id),
      changeset: task.changesetId ? this.tryGetChangeset(task.changesetId) : null
    };
  }

  getThreadDetails(id: string): object {
    const thread = this.getThread(id);
    return {
      ...thread,
      tasks: this.db.prepare("SELECT * FROM tasks WHERE thread_id = ? ORDER BY created_at").all(id).map((row) => rowToTask(row as Record<string, unknown>)),
      messages: this.db.prepare("SELECT * FROM task_messages WHERE thread_id = ? ORDER BY created_at").all(id),
      changesets: this.db.prepare("SELECT * FROM changesets WHERE thread_id = ? ORDER BY created_at").all(id).map((row) => rowToChangeset(row as Record<string, unknown>)),
      pullRequests: this.db.prepare("SELECT * FROM pull_requests WHERE thread_id = ? ORDER BY created_at").all(id).map((row) => rowToPullRequest(row as Record<string, unknown>))
    };
  }

  getChangesetDetails(id: string): object {
    const changeset = this.getChangeset(id);
    return {
      ...changeset,
      tasks: this.db
        .prepare(
          `SELECT tasks.* FROM tasks
           INNER JOIN changeset_tasks ON changeset_tasks.task_id = tasks.id
           WHERE changeset_tasks.changeset_id = ?
           ORDER BY tasks.created_at`
        )
        .all(id)
        .map((row) => rowToTask(row as Record<string, unknown>)),
      pullRequests: this.db.prepare("SELECT * FROM pull_requests WHERE changeset_id = ? ORDER BY created_at").all(id).map((row) => rowToPullRequest(row as Record<string, unknown>))
    };
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

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}
