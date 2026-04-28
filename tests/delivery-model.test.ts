import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexPlan } from "../src/codex/runner.js";
import { loadEnv } from "../src/config/env.js";
import { schemaSql } from "../src/db/schema.js";
import { TaskService } from "../src/task/service.js";

describe("delivery thread model", () => {
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
      await writeFile(join(workspace, "exec"), "console.log(process.argv.join(' '));\n", "utf8");
      const env = loadEnv({
        CODEX_COMMAND: "node",
        CODEX_CONTEXT_MAX_CHARS: "900",
        CODEX_TIMEOUT_SECONDS: "10"
      });
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
        workspace
      );

      expect(result.runId).toEqual(expect.stringMatching(/^run-/));
      expect(await readFile(result.promptPath, "utf8")).toContain("context compacted");
      expect(await readFile(result.logPath, "utf8")).toContain("You are planning");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
