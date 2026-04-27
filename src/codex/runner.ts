import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import type { AppEnv } from "../config/env.js";
import type { TaskRecord } from "../types.js";

export interface CodexRunResult {
  logPath: string;
  summary: string;
}

export async function runCodex(env: AppEnv, task: TaskRecord, repoDirs: string[], workspace: string): Promise<CodexRunResult> {
  await mkdir(join(workspace, "logs"), { recursive: true });
  const promptPath = join(workspace, "codex-prompt.md");
  const logPath = join(workspace, "logs", "codex.log");
  const prompt = buildCodexPrompt(task, repoDirs);
  await writeFile(promptPath, prompt, "utf8");

  const result = await execa(env.CODEX_COMMAND, ["exec", "--", prompt], {
    cwd: workspace,
    all: true,
    timeout: env.CODEX_TIMEOUT_SECONDS * 1000,
    reject: false
  });
  await writeFile(logPath, result.all ?? "", "utf8");

  if (result.exitCode !== 0) {
    throw new Error(`Codex failed with exit code ${result.exitCode}`);
  }

  return {
    logPath,
    summary: tail(result.all ?? "", 1200)
  };
}

function buildCodexPrompt(task: TaskRecord, repoDirs: string[]): string {
  return [
    `You are implementing a Feishu-submitted ${task.taskType}.`,
    `Task ID: ${task.id}`,
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
  ].join("\n");
}

function tail(value: string, max: number): string {
  return value.length <= max ? value : value.slice(value.length - max);
}
