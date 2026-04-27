import { execa } from "execa";

export interface GitRepoResult {
  branch: string;
  commitSha?: string;
}

export async function cloneRepo(repo: string, branch: string, destination: string): Promise<void> {
  await execa("git", ["clone", "--depth", "1", "--branch", branch, repo, destination], { all: true });
}

export async function createBranch(repoDir: string, branch: string): Promise<void> {
  await execa("git", ["checkout", "-b", branch], { cwd: repoDir, all: true });
}

export async function hasChanges(repoDir: string): Promise<boolean> {
  const result = await execa("git", ["status", "--porcelain"], { cwd: repoDir, all: true });
  return result.stdout.trim().length > 0;
}

export async function commitAll(repoDir: string, message: string): Promise<string | undefined> {
  if (!(await hasChanges(repoDir))) {
    return undefined;
  }
  await execa("git", ["add", "-A"], { cwd: repoDir, all: true });
  await execa("git", ["commit", "-m", message], { cwd: repoDir, all: true });
  const result = await execa("git", ["rev-parse", "HEAD"], { cwd: repoDir, all: true });
  return result.stdout.trim();
}

export async function pushBranch(repoDir: string, branch: string): Promise<void> {
  await execa("git", ["push", "-u", "origin", branch], { cwd: repoDir, all: true });
}

export function buildTaskBranch(taskId: string): string {
  return `codex/${taskId.slice(0, 24)}`;
}
