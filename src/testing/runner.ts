import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { detectTestCommands } from "./detector.js";

export interface TestRunResult {
  ok: boolean;
  logPath: string;
  summary: string;
}

export async function runProjectChecks(projectDir: string, explicitCommands: string[], workspace: string): Promise<TestRunResult> {
  const commands = explicitCommands.length > 0 ? explicitCommands.map((command) => ({ label: command, command })) : detectTestCommands(projectDir);
  const logs: string[] = [];
  let ok = true;

  for (const item of commands) {
    const result = await execa(item.command, {
      cwd: projectDir,
      shell: true,
      all: true,
      reject: false
    });
    logs.push(`$ ${item.command}\n${result.all ?? ""}`);
    if (result.exitCode !== 0) {
      ok = false;
      break;
    }
  }

  const output = logs.join("\n\n");
  const logPath = join(workspace, "logs", `tests-${Date.now()}.log`);
  await writeFile(logPath, output, "utf8");
  return {
    ok,
    logPath,
    summary: output.length <= 1200 ? output : output.slice(output.length - 1200)
  };
}
