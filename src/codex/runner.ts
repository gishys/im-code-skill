import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { AppEnv } from "../config/env.js";
import type { CodexRunType, TaskRecord } from "../types.js";

export interface CodexRunResult {
  runId: string;
  runType: CodexRunType;
  promptPath: string;
  logPath: string;
  summaryPath: string;
  handoffPath?: string;
  exitCode: number;
  summary: string;
  startedAt: string;
  finishedAt: string;
}

export interface CodexProgressUpdate {
  chunk: string;
  output: string;
}

export interface CodexRunOptions {
  onProgress?: (update: CodexProgressUpdate) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
}

export async function runCodex(env: AppEnv, task: TaskRecord, repoDirs: string[], workspace: string, options: CodexRunOptions = {}): Promise<CodexRunResult> {
  const paths = await prepareRunWorkspace(workspace, "execute");
  const promptPath = paths.promptPath;
  const logPath = paths.logPath;
  const summaryPath = paths.summaryPath;
  const prompt = buildCodexPrompt(task, repoDirs, env.CODEX_CONTEXT_MAX_CHARS, paths.handoffPath);
  await writeFile(promptPath, prompt, "utf8");

  const startedAt = new Date().toISOString();
  const result = await runCodexCommand(env, workspace, prompt, options);
  const finishedAt = new Date().toISOString();
  const output = redactSecrets(result.all ?? "");
  const summary = tail(output, 1200);
  await writeFile(logPath, output, "utf8");
  await writeFile(summaryPath, summary, "utf8");

  return {
    runId: paths.runId,
    runType: "execute",
    promptPath,
    logPath,
    summaryPath,
    handoffPath: paths.handoffPath,
    exitCode: result.exitCode ?? 0,
    summary,
    startedAt,
    finishedAt
  };
}

export async function runCodexPlan(env: AppEnv, task: TaskRecord, repoDirs: string[], workspace: string, options: CodexRunOptions = {}): Promise<CodexRunResult & { planPath: string }> {
  const paths = await prepareRunWorkspace(workspace, "plan");
  const promptPath = paths.promptPath;
  const logPath = paths.logPath;
  const summaryPath = paths.summaryPath;
  const planPath = join(paths.runDir, "plan.md");
  const prompt = buildCodexPlanPrompt(task, repoDirs, env.CODEX_CONTEXT_MAX_CHARS, paths.handoffPath);
  await writeFile(promptPath, prompt, "utf8");

  const startedAt = new Date().toISOString();
  const result = await runCodexCommand(env, workspace, prompt, options);
  const finishedAt = new Date().toISOString();
  const output = redactSecrets(result.all ?? "");
  const summary = tail(output, 2000);
  await writeFile(logPath, output, "utf8");
  await writeFile(planPath, output, "utf8");
  await writeFile(summaryPath, summary, "utf8");

  return {
    runId: paths.runId,
    runType: "plan",
    promptPath,
    logPath,
    summaryPath,
    handoffPath: paths.handoffPath,
    exitCode: result.exitCode ?? 0,
    planPath,
    summary,
    startedAt,
    finishedAt
  };
}

async function runCodexCommand(env: AppEnv, workspace: string, prompt: string, options: CodexRunOptions): Promise<{ all?: string; exitCode?: number | null }> {
  let output = "";
  let progressQueue = Promise.resolve();
  let canceled = false;
  const child = execa(env.CODEX_COMMAND, ["exec", "--", prompt], {
    cwd: workspace,
    all: true,
    timeout: env.CODEX_TIMEOUT_SECONDS * 1000,
    reject: false
  });

  const cancelTimer = options.shouldCancel
    ? setInterval(() => {
        Promise.resolve(options.shouldCancel?.())
          .then((shouldCancel) => {
            if (!shouldCancel || canceled) {
              return;
            }
            canceled = true;
            output += "\n[task canceled by user]\n";
            child.kill("SIGTERM");
          })
          .catch(() => {
            // Cancellation checks are best-effort; the run should continue if the check itself fails.
          });
      }, 1000)
    : undefined;

  child.all?.on("data", (data: Buffer | string) => {
    const chunk = redactSecrets(data.toString());
    output += chunk;
    const streamedOutput = tail(output, 4000);
    progressQueue = progressQueue
      .then(() =>
        options.onProgress?.({
          chunk,
          output: streamedOutput
        })
      )
      .catch(() => {
        // Progress callbacks are best-effort; the Codex run should continue even if card updates fail.
      });
  });

  try {
    const result = await child;
    await progressQueue;
    return {
      ...result,
      exitCode: canceled ? 130 : result.exitCode,
      all: output || result.all
    };
  } finally {
    if (cancelTimer) {
      clearInterval(cancelTimer);
    }
  }
}

function buildCodexPrompt(task: TaskRecord, repoDirs: string[], maxChars: number, handoffPath: string): string {
  return compactPrompt([
    `You are implementing a Feishu-submitted ${task.taskType}.`,
    `Task ID: ${task.id}`,
    `Delivery thread ID: ${task.threadId ?? "unknown"}`,
    `Current plan version ID: ${task.currentPlanVersionId ?? "none"}`,
    `Context handoff file: ${handoffPath}`,
    `Project: ${task.projectName}`,
    `Scope: ${task.scope}`,
    "",
    "User request:",
    task.parsedDescription,
    "",
    "Repository directories:",
    ...repoDirs.map((dir) => `- ${dir}`),
    "",
    "Constraints:",
    "- Keep changes scoped to the request.",
    "- Use existing project patterns.",
    "- Do not rewrite unrelated files.",
    "- Run or preserve the configured tests when possible.",
    "- Include image/video/file inputs from the inputs directory when they are relevant."
  ].join("\n"), maxChars, handoffPath);
}

function buildCodexPlanPrompt(task: TaskRecord, repoDirs: string[], maxChars: number, handoffPath: string): string {
  return compactPrompt([
    `You are planning a Feishu-submitted ${task.taskType}.`,
    `Task ID: ${task.id}`,
    `Delivery thread ID: ${task.threadId ?? "unknown"}`,
    `Context handoff file: ${handoffPath}`,
    `Project: ${task.projectName}`,
    `Scope: ${task.scope}`,
    "",
    "User request:",
    task.parsedDescription,
    "",
    "Repository directories:",
    ...repoDirs.map((dir) => `- ${dir}`),
    "",
    "Plan-only constraints:",
    "- Do not edit files.",
    "- Do not create commits, branches, pull requests, packages, or deployments.",
    "- Inspect the repository as needed and return an implementation plan only.",
    "- Include goal, affected areas, proposed changes, risks, and test scenarios.",
    "- Keep the plan decision-complete enough that a later agent run can execute it."
  ].join("\n"), maxChars, handoffPath);
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

async function prepareRunWorkspace(workspace: string, runType: CodexRunType): Promise<{
  runId: string;
  runDir: string;
  promptPath: string;
  logPath: string;
  summaryPath: string;
  handoffPath: string;
}> {
  const runId = `run-${randomUUID()}`;
  const runDir = join(workspace, "codex-runs", runId);
  await mkdir(runDir, { recursive: true });
  const handoffPath = join(runDir, "handoff.md");
  await writeFile(handoffPath, `# Context handoff\n\nRun type: ${runType}\n`, "utf8");
  return {
    runId,
    runDir,
    promptPath: join(runDir, "prompt.md"),
    logPath: join(runDir, "output.log"),
    summaryPath: join(runDir, "summary.md"),
    handoffPath
  };
}

function compactPrompt(prompt: string, maxChars: number, handoffPath: string): string {
  if (prompt.length <= maxChars) {
    return prompt;
  }
  const headBudget = Math.max(4000, Math.floor(maxChars * 0.45));
  const tailBudget = Math.max(4000, Math.floor(maxChars * 0.45));
  return [
    prompt.slice(0, headBudget),
    "",
    `...[context compacted because it exceeded ${maxChars} characters; full context should be reconstructed from persisted task history and ${handoffPath}]...`,
    "",
    prompt.slice(prompt.length - tailBudget)
  ].join("\n");
}

function redactSecrets(value: string): string {
  return value
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(cookie:\s*)[^\n]+/gi, "$1[REDACTED]")
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*\s*=\s*)[^\s]+/gi, "$1[REDACTED]");
}
