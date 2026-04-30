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
  const output = localizeCodexOutput(redactSecrets(result.all ?? ""));
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
  const runType: CodexRunType = task.currentPlanVersionId ? "revise_plan" : "plan";
  const paths = await prepareRunWorkspace(workspace, runType);
  const promptPath = paths.promptPath;
  const logPath = paths.logPath;
  const summaryPath = paths.summaryPath;
  const planPath = join(paths.runDir, "plan.md");
  const prompt = buildCodexPlanPrompt(task, repoDirs, env.CODEX_CONTEXT_MAX_CHARS, paths.handoffPath);
  await writeFile(promptPath, prompt, "utf8");

  const startedAt = new Date().toISOString();
  const result = await runCodexCommand(env, workspace, prompt, options);
  const finishedAt = new Date().toISOString();
  const output = localizeCodexOutput(redactSecrets(result.all ?? ""));
  const summary = tail(output, 2000);
  await writeFile(logPath, output, "utf8");
  await writeFile(planPath, output, "utf8");
  await writeFile(summaryPath, summary, "utf8");

  return {
    runId: paths.runId,
    runType,
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
  let sawOutput = false;
  let jsonLineBuffer = "";
  const child = execa(env.CODEX_COMMAND, buildCodexExecArgs(env), {
    cwd: workspace,
    all: true,
    env: buildCodexProcessEnv(env),
    input: prompt,
    timeout: env.CODEX_TIMEOUT_SECONDS * 1000,
    reject: false
  });

  const startupTimer = setTimeout(() => {
    if (sawOutput || canceled) {
      return;
    }
    canceled = true;
    output += `\n[Codex 在 ${env.CODEX_STARTUP_TIMEOUT_SECONDS} 秒内没有输出]\n`;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5000);
  }, env.CODEX_STARTUP_TIMEOUT_SECONDS * 1000);

  const cancelTimer = options.shouldCancel
    ? setInterval(() => {
        Promise.resolve(options.shouldCancel?.())
          .then((shouldCancel) => {
            if (!shouldCancel || canceled) {
              return;
            }
            canceled = true;
            output += "\n[任务已由用户取消]\n";
            child.kill("SIGTERM");
          })
          .catch(() => {
            // Cancellation checks are best-effort; the run should continue if the check itself fails.
          });
      }, 1000)
    : undefined;

  child.all?.on("data", (data: Buffer | string) => {
    sawOutput = true;
    const chunk = localizeCodexOutput(redactSecrets(readCodexProgressChunk(data.toString(), env.CODEX_JSON_EVENTS_ENABLED, (nextBuffer) => {
      jsonLineBuffer = nextBuffer;
    }, jsonLineBuffer)));
    if (!chunk.trim()) {
      return;
    }
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
    if (jsonLineBuffer.trim()) {
      const finalChunk = localizeCodexOutput(redactSecrets(formatCodexJsonLine(jsonLineBuffer)));
      output += finalChunk ? `${finalChunk}\n` : "";
      jsonLineBuffer = "";
    }
    await progressQueue;
    return {
      ...result,
      exitCode: canceled ? 130 : result.exitCode,
      all: output || result.all
    };
  } finally {
    clearTimeout(startupTimer);
    if (cancelTimer) {
      clearInterval(cancelTimer);
    }
  }
}

function buildCodexExecArgs(env: AppEnv): string[] {
  const args = ["exec", "--skip-git-repo-check", "--ignore-rules", "--color", "never"];
  if (env.CODEX_JSON_EVENTS_ENABLED) {
    args.push("--json");
  }
  if (env.CODEX_BYPASS_APPROVALS_AND_SANDBOX) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", env.CODEX_SANDBOX_MODE);
  }
  args.push("--", "-");
  return args;
}

function readCodexProgressChunk(chunk: string, jsonEnabled: boolean, setBuffer: (value: string) => void, previousBuffer: string): string {
  if (!jsonEnabled) {
    return chunk;
  }
  const combined = previousBuffer + chunk;
  const lines = combined.split(/\r?\n/);
  setBuffer(lines.pop() ?? "");
  return lines.map((line) => formatCodexJsonLine(line)).filter(Boolean).join("\n") + "\n";
}

function formatCodexJsonLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const event = JSON.parse(trimmed) as unknown;
    return formatCodexJsonEvent(event);
  } catch {
    return trimmed;
  }
}

function formatCodexJsonEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return typeof event === "string" ? event : "";
  }
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const directText = firstString(record.delta, record.text, record.message, record.content);
  if (directText) {
    return directText;
  }
  const item = record.item && typeof record.item === "object" ? (record.item as Record<string, unknown>) : undefined;
  const itemText = item ? firstString(item.text, item.message, item.content) : undefined;
  if (itemText) {
    return itemText;
  }
  const command = firstString(record.command, item?.command);
  if (command) {
    return type ? `[${type}] ${command}` : command;
  }
  const status = firstString(record.status, record.state);
  if (type && status) {
    return `[${type}] ${status}`;
  }
  return type ? `[${type}]` : "";
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function buildCodexProcessEnv(env: AppEnv): NodeJS.ProcessEnv {
  const processEnv: NodeJS.ProcessEnv = { ...process.env };
  if (!env.CODEX_PROXY_URL) {
    return processEnv;
  }

  processEnv.HTTP_PROXY = env.CODEX_PROXY_URL;
  processEnv.HTTPS_PROXY = env.CODEX_PROXY_URL;
  processEnv.ALL_PROXY = env.CODEX_PROXY_URL;
  processEnv.http_proxy = env.CODEX_PROXY_URL;
  processEnv.https_proxy = env.CODEX_PROXY_URL;
  processEnv.all_proxy = env.CODEX_PROXY_URL;
  return processEnv;
}

function buildCodexPrompt(task: TaskRecord, repoDirs: string[], maxChars: number, handoffPath: string): string {
  return compactPrompt([
    `你正在处理一个由飞书提交的${task.taskType}任务。`,
    `任务 ID：${task.id}`,
    `交付线程 ID：${task.threadId ?? "unknown"}`,
    `当前方案版本 ID：${task.currentPlanVersionId ?? "none"}`,
    `上下文交接文件：${handoffPath}`,
    `项目：${task.projectName}`,
    `范围：${task.scope}`,
    "",
    "用户需求：",
    task.parsedDescription,
    "",
    task.planSummary ? "已确认的方案摘要：" : undefined,
    task.planSummary ? task.planSummary : undefined,
    "",
    "代码仓库目录：",
    ...repoDirs.map((dir) => `- ${dir}`),
    "",
    "执行约束：",
    "- 使用简体中文输出最终摘要。",
    "- 改动范围保持在用户需求内。",
    "- 遵循项目已有模式。",
    "- 不要重写无关文件。",
    "- 尽可能运行或保留已配置的测试。",
    "- inputs 目录里的图片、视频或文件与需求相关时，需要纳入判断。"
  ].filter((line) => line !== undefined).join("\n"), maxChars, handoffPath);
}

function buildCodexPlanPrompt(task: TaskRecord, repoDirs: string[], maxChars: number, handoffPath: string): string {
  const isRevision = Boolean(task.currentPlanVersionId);
  return compactPrompt([
    `你正在${isRevision ? "修订" : "制定"}一个由飞书提交的${task.taskType}实施方案。`,
    `任务 ID：${task.id}`,
    `交付线程 ID：${task.threadId ?? "unknown"}`,
    `当前方案版本 ID：${task.currentPlanVersionId ?? "none"}`,
    `上下文交接文件：${handoffPath}`,
    `项目：${task.projectName}`,
    `范围：${task.scope}`,
    "",
    "用户需求：",
    task.parsedDescription,
    "",
    task.planSummary ? "待修订的当前方案摘要：" : undefined,
    task.planSummary ? task.planSummary : undefined,
    "",
    "代码仓库目录：",
    ...repoDirs.map((dir) => `- ${dir}`),
    "",
    "仅生成方案的约束：",
    "- 使用简体中文输出。",
    "- 不要编辑文件。",
    "- 不要创建提交、分支、Pull Request、产物包或部署。",
    "- 可按需检查代码仓库，但最终只返回实施方案。",
    "- 方案需包含目标、影响范围、拟改动内容、风险和测试场景。",
    "- 方案要足够明确，后续 Agent 可直接据此执行。",
    "- 如果这是一次修订，请明确回应用户反馈，并输出完整的替代方案。"
  ].filter((line) => line !== undefined).join("\n"), maxChars, handoffPath);
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

function localizeCodexOutput(value: string): string {
  return value
    .replace(
      /ERROR codex_core::session: failed to record rollout items: thread ([^\s]+) not found/g,
      "错误 Codex 会话记录失败：线程 $1 不存在"
    )
    .replace(/failed to record rollout items: thread ([^\s]+) not found/g, "Codex 会话记录失败：线程 $1 不存在")
    .replace(/tokens used/g, "消耗 token")
    .replace(/Codex produced no output within (\d+) seconds/g, "Codex 在 $1 秒内没有输出")
    .replace(/task canceled by user/g, "任务已由用户取消");
}
