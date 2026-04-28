import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { AppEnv } from "../config/env.js";
import { findProject } from "../config/projects.js";
import type { FeishuClient } from "../feishu/client.js";
import { buildTaskCard } from "../feishu/cards.js";
import { packageArtifacts } from "../artifact/packager.js";
import { runCodex, runCodexPlan } from "../codex/runner.js";
import { buildTaskBranch, commitAll, prepareCachedRepoWorktree, pushBranch } from "../github/git.js";
import { createPullRequest, parseGitHubRepoName } from "../github/pull-request.js";
import { runProjectChecks } from "../testing/runner.js";
import { TaskService } from "../task/service.js";
import type { ProjectConfig, RepoConfig, TaskRecord } from "../types.js";

interface RepoWork {
  kind: "frontend" | "backend";
  config: RepoConfig;
  dir: string;
}

export class TaskRunner {
  private readonly progressTails = new Map<string, string>();
  private readonly lastProgressAt = new Map<string, number>();

  constructor(
    private readonly env: AppEnv,
    private readonly projects: ProjectConfig[],
    private readonly tasks: TaskService,
    private readonly feishu: FeishuClient
  ) {}

  async run(task: TaskRecord): Promise<void> {
    if (task.executionMode === "plan") {
      await this.runPlanTask(task);
      return;
    }
    await this.runAgentTask(task);
  }

  private async runPlanTask(task: TaskRecord): Promise<void> {
    const project = findProject(this.projects, task.projectName);
    const workspace = join(this.env.WORKSPACE_ROOT, task.id);
    const repoWorks = this.resolveRepos(task, project, workspace);

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(join(workspace, "logs"), { recursive: true });
      await this.progress(task, `Workspace ready: ${workspace}`);

      this.tasks.updateStage(task.id, "cloning", "Cloning repositories for planning");
      for (const repo of repoWorks) {
        await prepareCachedRepoWorktree({
          repo: repo.config.repo,
          branch: project.default_branch,
          destination: repo.dir,
          cacheRoot: this.env.REPO_CACHE_ROOT,
          allowStaleCacheOnFetchFailure: true
        });
      }

      this.tasks.updateStage(task.id, "planning", "Generating implementation plan");
      await this.progress(this.tasks.getTask(task.id), "Codex is generating a plan");
      const result = await runCodexPlan(this.env, this.tasks.getTask(task.id), repoWorks.map((item) => item.dir), workspace, {
        onProgress: (update) => this.progress(this.tasks.getTask(task.id), update.chunk)
      });
      const currentTask = this.tasks.getTask(task.id);
      this.tasks.addCodexRun({
        id: result.runId,
        taskId: task.id,
        threadId: currentTask.threadId,
        runType: result.runType,
        status: result.exitCode === 0 ? "succeeded" : "failed",
        promptPath: result.promptPath,
        logPath: result.logPath,
        summaryPath: result.summaryPath,
        handoffPath: result.handoffPath,
        exitCode: result.exitCode,
        summary: result.summary,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt
      });
      this.tasks.addContextSnapshot({
        taskId: task.id,
        threadId: currentTask.threadId,
        codexRunId: result.runId,
        snapshotPath: result.summaryPath,
        summary: result.summary,
        tokenBudgetChars: this.env.CODEX_CONTEXT_MAX_CHARS
      });
      if (result.exitCode !== 0) {
        throw new Error(`Codex plan failed with exit code ${result.exitCode}`);
      }
      await assertReposClean(repoWorks);
      const planVersion = this.tasks.addPlanVersion({
        taskId: task.id,
        threadId: currentTask.threadId,
        planPath: result.planPath,
        summary: result.summary,
        codexRunId: result.runId
      });

      this.tasks.markPlanReady(task.id, {
        planSummary: result.summary,
        planArtifactPath: result.planPath
      });
      this.tasks.addTaskMessage({
        threadId: currentTask.threadId,
        taskId: task.id,
        role: "system",
        messageType: "plan_version_created",
        content: `Plan version ${planVersion.version} is ready.`,
        metadata: { planVersionId: planVersion.id }
      });
      await this.progress(this.tasks.getTask(task.id), result.summary || "Plan is ready", { force: true, replace: true });
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      this.tasks.markFailed(task.id, this.tasks.getTask(task.id).currentStage, summary);
      await this.progress(this.tasks.getTask(task.id), summary, { force: true });
    }
  }

  private async runAgentTask(task: TaskRecord): Promise<void> {
    const project = findProject(this.projects, task.projectName);
    const workspace = join(this.env.WORKSPACE_ROOT, task.id);
    const branch = buildTaskBranch(task.id);
    const repoWorks = this.resolveRepos(task, project, workspace);

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(join(workspace, "logs"), { recursive: true });
      await this.progress(task, `Workspace ready: ${workspace}`);

      this.tasks.updateStage(task.id, "cloning", "Cloning repositories");
      for (const repo of repoWorks) {
        await prepareCachedRepoWorktree({
          repo: repo.config.repo,
          branch: project.default_branch,
          destination: repo.dir,
          cacheRoot: this.env.REPO_CACHE_ROOT,
          worktreeBranch: branch
        });
      }

      this.tasks.updateStage(task.id, "codex_running", "Running Codex");
      await this.progress(this.tasks.getTask(task.id), "Codex is editing code");
      const codexResult = await runCodex(this.env, this.tasks.getTask(task.id), repoWorks.map((item) => item.dir), workspace, {
        onProgress: (update) => this.progress(this.tasks.getTask(task.id), update.chunk)
      });
      const currentTask = this.tasks.getTask(task.id);
      this.tasks.addCodexRun({
        id: codexResult.runId,
        taskId: task.id,
        threadId: currentTask.threadId,
        runType: codexResult.runType,
        status: codexResult.exitCode === 0 ? "succeeded" : "failed",
        promptPath: codexResult.promptPath,
        logPath: codexResult.logPath,
        summaryPath: codexResult.summaryPath,
        handoffPath: codexResult.handoffPath,
        exitCode: codexResult.exitCode,
        summary: codexResult.summary,
        startedAt: codexResult.startedAt,
        finishedAt: codexResult.finishedAt
      });
      this.tasks.addContextSnapshot({
        taskId: task.id,
        threadId: currentTask.threadId,
        codexRunId: codexResult.runId,
        snapshotPath: codexResult.summaryPath,
        summary: codexResult.summary,
        tokenBudgetChars: this.env.CODEX_CONTEXT_MAX_CHARS
      });
      if (codexResult.exitCode !== 0) {
        throw new Error(`Codex failed with exit code ${codexResult.exitCode}`);
      }

      this.tasks.updateStage(task.id, "testing", "Running tests");
      for (const repo of repoWorks) {
        await runConfiguredCommand(repo.dir, repo.config.install);
        const test = await runProjectChecks(repo.dir, repo.config.test ? [repo.config.test] : [], workspace);
        if (!test.ok) {
          throw new Error(`Tests failed for ${repo.kind}:\n${test.summary}`);
        }
      }

      this.tasks.updateStage(task.id, "building", "Building projects");
      for (const repo of repoWorks) {
        await runConfiguredCommand(repo.dir, repo.config.build);
      }

      this.tasks.updateStage(task.id, "packaging", "Packaging artifacts");
      const artifactPaths = repoWorks.flatMap((repo) => repo.config.artifact_paths.map((artifactPath) => join(repo.dir, artifactPath)));
      const artifact = await packageArtifacts(this.tasks.getTask(task.id), project, artifactPaths, workspace);

      this.tasks.updateStage(task.id, "creating_pr", "Creating GitHub pull request");
      const prUrls: string[] = [];
      let commitSha: string | undefined;
      for (const repo of repoWorks) {
        const sha = await commitAll(repo.dir, `codex: ${task.taskType} ${task.id}`);
        if (!sha) {
          continue;
        }
        commitSha ??= sha;
        this.tasks.createOrUpdateChangeset({
          threadId: this.tasks.getTask(task.id).threadId ?? task.id,
          taskId: task.id,
          projectName: task.projectName,
          branch,
          commitSha: sha,
          artifactPath: artifact.path,
          testSummary: "Configured checks passed"
        });
        await pushBranch(repo.dir, branch);
        const owner = this.env.GITHUB_OWNER;
        if (owner) {
          const prUrl = await createPullRequest({
            token: this.env.GITHUB_TOKEN,
            owner,
            repo: parseGitHubRepoName(repo.config.repo),
            title: `[Codex] ${task.taskType}: ${task.projectName} ${repo.kind}`,
            body: buildPrBody(task, repo.kind, artifact.name),
            head: branch,
            base: project.default_branch,
            draft: true
          });
          if (prUrl) {
            prUrls.push(prUrl);
            const latestTask = this.tasks.getTask(task.id);
            const changeset = latestTask.changesetId ? this.tasks.getChangeset(latestTask.changesetId) : undefined;
            if (latestTask.threadId && changeset) {
              this.tasks.recordPullRequest({
                threadId: latestTask.threadId,
                changesetId: changeset.id,
                url: prUrl,
                branch,
                commitSha: sha
              });
            }
          }
        }
      }

      this.tasks.updateStage(task.id, "uploading", "Uploading artifact to Feishu");
      const fileKey = await this.feishu.uploadFile(artifact.path);
      if (task.feishuChatId && fileKey) {
        await this.feishu.sendFile(task.feishuChatId, fileKey);
      }

      this.tasks.markSucceeded(task.id, {
        artifactPath: artifact.path,
        artifactFileKey: fileKey,
        githubPrUrl: prUrls.join("\n") || undefined,
        githubBranch: branch,
        githubCommitSha: commitSha
      });
      await this.progress(this.tasks.getTask(task.id), codexResult.summary || "Task succeeded", { force: true, replace: true });
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      this.tasks.markFailed(task.id, this.tasks.getTask(task.id).currentStage, summary);
      await this.progress(this.tasks.getTask(task.id), summary, { force: true });
    }
  }

  private resolveRepos(task: TaskRecord, project: ProjectConfig, workspace: string): RepoWork[] {
    const repos: RepoWork[] = [];
    if ((task.scope === "frontend" || task.scope === "fullstack") && project.frontend) {
      repos.push({ kind: "frontend", config: project.frontend, dir: join(workspace, "frontend") });
    }
    if ((task.scope === "backend" || task.scope === "fullstack") && project.backend) {
      repos.push({ kind: "backend", config: project.backend, dir: join(workspace, "backend") });
    }
    if (repos.length === 0) {
      throw new Error(`No repository configured for scope ${task.scope}`);
    }
    return repos;
  }

  private async progress(task: TaskRecord, logExcerpt: string, options?: { force?: boolean; replace?: boolean }): Promise<void> {
    if (!this.env.FEISHU_PROGRESS_STREAM_ENABLED || !task.feishuChatId) {
      return;
    }
    const excerpt = this.bufferProgress(task.id, logExcerpt, Boolean(options?.replace));
    const now = Date.now();
    const minIntervalMs = this.env.FEISHU_PROGRESS_MIN_INTERVAL_SECONDS * 1000;
    const lastProgressAt = this.lastProgressAt.get(task.id) ?? 0;
    if (!options?.force && task.streamMessageId && now - lastProgressAt < minIntervalMs) {
      return;
    }
    this.lastProgressAt.set(task.id, now);
    const card = buildTaskCard(task, { logExcerpt: excerpt });
    if (task.streamMessageId) {
      await this.feishu.updateTaskCard(task.streamMessageId, card);
      return;
    }
    const messageId = await this.feishu.sendTaskCard(task.feishuChatId, card);
    if (messageId) {
      this.tasks.setStreamMessageId(task.id, messageId);
    }
  }

  private bufferProgress(taskId: string, logExcerpt: string, replace: boolean): string {
    const sanitized = sanitizeProgress(logExcerpt);
    const next = replace ? sanitized : [this.progressTails.get(taskId), sanitized].filter(Boolean).join("\n");
    const clipped = tail(next, 1800);
    this.progressTails.set(taskId, clipped);
    return clipped;
  }
}

async function runConfiguredCommand(cwd: string, command?: string): Promise<void> {
  if (!command) {
    return;
  }
  const result = await execa(command, { cwd, shell: true, all: true, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${command}\n${result.all ?? ""}`);
  }
}

async function assertReposClean(repoWorks: RepoWork[]): Promise<void> {
  for (const repo of repoWorks) {
    const result = await execa("git", ["status", "--porcelain"], { cwd: repo.dir, all: true, reject: false });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to inspect ${repo.kind} repository after planning:\n${result.all ?? ""}`);
    }
    if ((result.stdout ?? "").trim()) {
      throw new Error(`Plan mode modified files in ${repo.kind}; refusing to continue.\n${result.stdout}`);
    }
  }
}

function buildPrBody(task: TaskRecord, repoKind: string, artifactName: string): string {
  return [
    `Feishu task: ${task.id}`,
    `Project: ${task.projectName}`,
    `Repository: ${repoKind}`,
    `Mode: ${task.executionMode}`,
    `Type: ${task.taskType}`,
    `Scope: ${task.scope}`,
    "",
    "Request:",
    task.parsedDescription,
    "",
    `Artifact: ${artifactName}`,
    "",
    "Generated by Feishu Codex Orchestrator."
  ].join("\n");
}

function sanitizeProgress(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .join("\n");
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}
