import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { AppEnv } from "../config/env.js";
import { findProject } from "../config/projects.js";
import type { FeishuClient } from "../feishu/client.js";
import { buildTaskCard } from "../feishu/cards.js";
import { packageArtifacts } from "../artifact/packager.js";
import { runCodex, runCodexPlan } from "../codex/runner.js";
import { buildTaskBranch, cloneRepo, commitAll, createBranch, pushBranch } from "../github/git.js";
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
        await cloneRepo(repo.config.repo, project.default_branch, repo.dir);
      }

      this.tasks.updateStage(task.id, "planning", "Generating implementation plan");
      await this.progress(this.tasks.getTask(task.id), "Codex is generating a plan");
      const result = await runCodexPlan(this.env, this.tasks.getTask(task.id), repoWorks.map((item) => item.dir), workspace);
      await assertReposClean(repoWorks);

      this.tasks.markPlanReady(task.id, {
        planSummary: result.summary,
        planArtifactPath: result.planPath
      });
      await this.progress(this.tasks.getTask(task.id), "Plan is ready");
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      this.tasks.markFailed(task.id, this.tasks.getTask(task.id).currentStage, summary);
      await this.progress(this.tasks.getTask(task.id), summary);
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
        await cloneRepo(repo.config.repo, project.default_branch, repo.dir);
        await createBranch(repo.dir, branch);
      }

      this.tasks.updateStage(task.id, "codex_running", "Running Codex");
      await this.progress(this.tasks.getTask(task.id), "Codex is editing code");
      await runCodex(this.env, this.tasks.getTask(task.id), repoWorks.map((item) => item.dir), workspace);

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
          if (prUrl) prUrls.push(prUrl);
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
      await this.progress(this.tasks.getTask(task.id), "Task succeeded");
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      this.tasks.markFailed(task.id, this.tasks.getTask(task.id).currentStage, summary);
      await this.progress(this.tasks.getTask(task.id), summary);
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

  private async progress(task: TaskRecord, logExcerpt: string): Promise<void> {
    if (!this.env.FEISHU_PROGRESS_STREAM_ENABLED || !task.feishuChatId) {
      return;
    }
    const card = buildTaskCard(task, { logExcerpt });
    if (task.streamMessageId) {
      await this.feishu.updateTaskCard(task.streamMessageId, card);
      return;
    }
    const messageId = await this.feishu.sendTaskCard(task.feishuChatId, card);
    if (messageId) {
      this.tasks.setStreamMessageId(task.id, messageId);
    }
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
