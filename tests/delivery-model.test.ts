import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexPlan } from "../src/codex/runner.js";
import { loadEnv } from "../src/config/env.js";
import { DbClient } from "../src/db/client.js";
import { schemaSql } from "../src/db/schema.js";
import { TaskService } from "../src/task/service.js";

describe("delivery thread model", () => {
  it("migrates legacy task tables before creating thread indexes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-db-"));
    const dbPath = join(workspace, "legacy.sqlite");
    try {
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          feishu_event_id TEXT UNIQUE,
          feishu_chat_id TEXT,
          feishu_message_id TEXT,
          feishu_user_id TEXT,
          project_name TEXT NOT NULL,
          task_type TEXT NOT NULL,
          scope TEXT NOT NULL,
          raw_text TEXT NOT NULL,
          parsed_description TEXT NOT NULL,
          status TEXT NOT NULL,
          approval_status TEXT NOT NULL,
          auto_approved INTEGER NOT NULL DEFAULT 0,
          current_stage TEXT NOT NULL,
          failure_stage TEXT,
          failure_summary TEXT,
          workspace_path TEXT,
          artifact_path TEXT,
          artifact_file_key TEXT,
          input_assets_json TEXT,
          stream_message_id TEXT,
          github_pr_url TEXT,
          github_branch TEXT,
          github_commit_sha TEXT,
          locked_by TEXT,
          locked_at TEXT,
          heartbeat_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
      `);
      legacy.close();

      const client = new DbClient(dbPath);
      try {
        const columns = new Set((client.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((column) => column.name));
        expect(columns.has("thread_id")).toBe(true);
        expect(client.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_thread'").get()).toBeTruthy();
      } finally {
        client.close();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("creates a delivery thread with the first task", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const tasks = new TaskService(db);
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        executionMode: "plan",
        taskType: "feature",
        scope: "frontend",
        description: "add dashboard filters"
      },
      rawText: "raw",
      feishuChatId: "oc_a",
      feishuUserId: "ou_a",
      autoApproved: true
    });

    expect(task.threadId).toEqual(expect.stringMatching(/^thread-/));
    const thread = tasks.getThread(task.threadId!);
    expect(thread).toEqual(expect.objectContaining({ projectName: "demo-app", status: "active" }));
  });

  it("records codex runs, plan versions, context snapshots, changesets, and PRs", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const tasks = new TaskService(db);
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        executionMode: "plan",
        taskType: "bug",
        scope: "frontend",
        description: "fix empty state"
      },
      rawText: "raw",
      autoApproved: true
    });
    const run = tasks.addCodexRun({
      id: "run-1",
      taskId: task.id,
      threadId: task.threadId,
      runType: "plan",
      status: "succeeded",
      promptPath: "/tmp/prompt.md",
      logPath: "/tmp/output.log",
      summaryPath: "/tmp/summary.md",
      exitCode: 0,
      summary: "Plan body",
      startedAt: "2026-04-28T00:00:00.000Z",
      finishedAt: "2026-04-28T00:00:01.000Z"
    });
    const plan = tasks.addPlanVersion({
      taskId: task.id,
      threadId: task.threadId,
      planPath: "/tmp/plan.md",
      summary: "Plan body",
      codexRunId: run.id
    });
    tasks.addContextSnapshot({
      taskId: task.id,
      threadId: task.threadId,
      codexRunId: run.id,
      snapshotPath: "/tmp/summary.md",
      summary: "Plan body",
      tokenBudgetChars: 24000
    });
    const changeset = tasks.createOrUpdateChangeset({
      threadId: task.threadId!,
      taskId: task.id,
      projectName: task.projectName,
      branch: "codex/task-1",
      commitSha: "abc123",
      artifactPath: "/tmp/artifact.zip",
      testSummary: "tests passed"
    });
    const pr = tasks.recordPullRequest({
      threadId: task.threadId!,
      changesetId: changeset.id,
      url: "https://github.com/example/demo/pull/1",
      branch: "codex/task-1",
      commitSha: "abc123"
    });

    expect(plan.version).toBe(1);
    expect(pr.status).toBe("draft");
    expect(tasks.getTaskDetails(task.id)).toEqual(
      expect.objectContaining({
        codexRuns: [expect.objectContaining({ id: "run-1" })],
        planVersions: [expect.objectContaining({ id: plan.id })],
        changeset: expect.objectContaining({ id: changeset.id })
      })
    );
    expect(tasks.getThreadDetails(task.threadId!)).toEqual(
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: task.id })],
        changesets: [expect.objectContaining({ id: changeset.id })],
        pullRequests: [expect.objectContaining({ id: pr.id })]
      })
    );
  });

  it("keeps each codex exec in an isolated run folder and compacts oversized prompts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-runs-"));
    try {
      await writeFile(join(workspace, "exec"), "process.stdout.write(`${process.env.HTTPS_PROXY}\\n`); process.stdin.pipe(process.stdout);\n", "utf8");
      const env = loadEnv({
        CODEX_COMMAND: "node",
        CODEX_CONTEXT_MAX_CHARS: "900",
        CODEX_PROXY_URL: "http://127.0.0.1:7897",
        CODEX_STARTUP_TIMEOUT_SECONDS: "10",
        CODEX_TIMEOUT_SECONDS: "10"
      });
      const progressChunks: string[] = [];
      const result = await runCodexPlan(
        env,
        {
          id: "task-1",
          threadId: "thread-1",
          changesetId: null,
          currentPlanVersionId: null,
          deliveryStatus: "active",
          feishuEventId: null,
          feishuChatId: null,
          feishuMessageId: null,
          feishuUserId: null,
          projectName: "demo-app",
          taskType: "feature",
          scope: "frontend",
          executionMode: "plan",
          rawText: "raw",
          parsedDescription: "x".repeat(4000),
          status: "queued",
          approvalStatus: "auto_approved",
          autoApproved: true,
          currentStage: "planning",
          failureStage: null,
          failureSummary: null,
          workspacePath: null,
          artifactPath: null,
          artifactFileKey: null,
          planSummary: null,
          planArtifactPath: null,
          inputAssetsJson: null,
          streamMessageId: null,
          githubPrUrl: null,
          githubBranch: null,
          githubCommitSha: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          createdAt: "2026-04-28T00:00:00.000Z",
          updatedAt: "2026-04-28T00:00:00.000Z",
          startedAt: null,
          finishedAt: null
        },
        [workspace],
        workspace,
        {
          onProgress: (update) => {
            progressChunks.push(update.chunk);
          }
        }
      );

      expect(result.runId).toEqual(expect.stringMatching(/^run-/));
      expect(result.runType).toBe("plan");
      expect(await readFile(result.promptPath, "utf8")).toContain("context compacted");
      expect(await readFile(result.logPath, "utf8")).toContain("你正在制定");
      expect(await readFile(result.logPath, "utf8")).toContain("http://127.0.0.1:7897");
      expect(progressChunks.join("")).toContain("你正在制定");

      const revision = await runCodexPlan(
        env,
        {
          id: "task-1",
          threadId: "thread-1",
          changesetId: null,
          currentPlanVersionId: "plan-1",
          deliveryStatus: "active",
          feishuEventId: null,
          feishuChatId: null,
          feishuMessageId: null,
          feishuUserId: null,
          projectName: "demo-app",
          taskType: "feature",
          scope: "frontend",
          executionMode: "plan",
          rawText: "raw",
          parsedDescription: "原始需求\n\n方案修改意见：补充回滚步骤。",
          status: "queued",
          approvalStatus: "auto_approved",
          autoApproved: true,
          currentStage: "planning",
          failureStage: null,
          failureSummary: null,
          workspacePath: null,
          artifactPath: null,
          artifactFileKey: null,
          planSummary: "Previous plan",
          planArtifactPath: null,
          inputAssetsJson: null,
          streamMessageId: null,
          githubPrUrl: null,
          githubBranch: null,
          githubCommitSha: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          createdAt: "2026-04-28T00:00:00.000Z",
          updatedAt: "2026-04-28T00:00:00.000Z",
          startedAt: null,
          finishedAt: null
        },
        [workspace],
        workspace
      );

      expect(revision.runType).toBe("revise_plan");
      expect(await readFile(revision.logPath, "utf8")).toContain("你正在修订");
      expect(await readFile(revision.promptPath, "utf8")).toContain("待修订的当前方案摘要");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps user-facing Codex summaries free of event and diagnostic noise", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "codex-summary-"));
    try {
      await writeFile(
        join(workspace, "exec"),
        [
          'const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\\n`);',
          'emit({ type: "thread.started" });',
          'emit({ type: "turn.started" });',
          `emit({ type: "item.started", command: "\\"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\\" -Command 'git status --short'" });`,
          'emit({ type: "message", text: "目标\\n确认 frontend 和 backend 仓库是否存在未提交代码。\\n\\n检查结果\\n- frontend：工作区干净\\n- backend：工作区干净" });',
          'process.stdout.write("ERROR codex_core::session: failed to record rollout items: thread 019ddd39-e771-7913-b04b-76206bb8656a not found\\n");',
          'process.stdout.write("2026-04-30T07:11:09.634178Z failed to record rollout items: thread 019ddd39-e771-7913-b04b-76206bb8656a not found\\n");'
        ].join("\n"),
        "utf8"
      );
      const env = loadEnv({
        CODEX_COMMAND: "node",
        CODEX_TIMEOUT_SECONDS: "10",
        CODEX_STARTUP_TIMEOUT_SECONDS: "10",
        CODEX_JSON_EVENTS_ENABLED: "true"
      });
      const progressChunks: string[] = [];
      const result = await runCodexPlan(env, baseTaskRecord(), [workspace], workspace, {
        onProgress: (update) => {
          progressChunks.push(update.chunk);
        }
      });
      const summary = await readFile(result.summaryPath, "utf8");

      expect(summary).toContain("目标");
      expect(summary).toContain("frontend：工作区干净");
      expect(summary).not.toContain("[thread.started]");
      expect(summary).not.toContain("PowerShell");
      expect(summary).not.toContain("会话记录失败");
      expect(progressChunks.join("\n")).toContain("目标");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function baseTaskRecord() {
  return {
    id: "task-1",
    threadId: "thread-1",
    changesetId: null,
    currentPlanVersionId: null,
    deliveryStatus: "active",
    feishuEventId: null,
    feishuChatId: null,
    feishuMessageId: null,
    feishuUserId: null,
    projectName: "demo-app",
    taskType: "feature",
    scope: "frontend",
    executionMode: "plan",
    rawText: "raw",
    parsedDescription: "check repo status",
    status: "queued",
    approvalStatus: "auto_approved",
    autoApproved: true,
    currentStage: "planning",
    failureStage: null,
    failureSummary: null,
    workspacePath: null,
    artifactPath: null,
    artifactFileKey: null,
    planSummary: null,
    planArtifactPath: null,
    inputAssetsJson: null,
    streamMessageId: null,
    githubPrUrl: null,
    githubBranch: null,
    githubCommitSha: null,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
    startedAt: null,
    finishedAt: null
  } as const;
}
