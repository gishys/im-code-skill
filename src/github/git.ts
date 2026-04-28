import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execa } from "execa";

export interface GitRepoResult {
  branch: string;
  commitSha?: string;
}

const cacheLocks = new Map<string, Promise<void>>();

export async function cloneRepo(repo: string, branch: string, destination: string): Promise<void> {
  await execa("git", ["clone", "--depth", "1", "--branch", branch, repo, destination], { all: true });
}

export async function prepareCachedRepoWorktree(options: {
  repo: string;
  branch: string;
  destination: string;
  cacheRoot: string;
  worktreeBranch?: string;
}): Promise<void> {
  const cacheDir = repoCacheDir(options.cacheRoot, options.repo);
  await withCacheLock(cacheDir, async () => {
    await ensureRepoCache(options.repo, options.branch, cacheDir);
  });

  await mkdir(dirname(options.destination), { recursive: true });
  const target = `origin/${options.branch}`;
  const args = options.worktreeBranch
    ? ["worktree", "add", "-B", options.worktreeBranch, options.destination, target]
    : ["worktree", "add", "--detach", options.destination, target];
  await execa("git", args, { cwd: cacheDir, all: true });
}

async function ensureRepoCache(repo: string, branch: string, cacheDir: string): Promise<void> {
  await mkdir(dirname(cacheDir), { recursive: true });
  const exists = await isGitRepository(cacheDir);
  if (!exists) {
    await execa("git", ["clone", "--no-checkout", repo, cacheDir], { all: true });
  }
  await execa("git", ["fetch", "origin", branch, "--prune"], { cwd: cacheDir, all: true });
}

async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await access(dir);
  } catch {
    return false;
  }
  const result = await execa("git", ["rev-parse", "--git-dir"], { cwd: dir, all: true, reject: false });
  return result.exitCode === 0;
}

async function withCacheLock(cacheDir: string, operation: () => Promise<void>): Promise<void> {
  const previous = cacheLocks.get(cacheDir) ?? Promise.resolve();
  let release!: () => void;
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  cacheLocks.set(cacheDir, current);
  await previous;
  try {
    await operation();
  } finally {
    release();
    if (cacheLocks.get(cacheDir) === current) {
      cacheLocks.delete(cacheDir);
    }
  }
}

function repoCacheDir(cacheRoot: string, repo: string): string {
  const hash = createHash("sha256").update(repo).digest("hex").slice(0, 16);
  const label = repo
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return join(cacheRoot, `${label || "repo"}-${hash}`);
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
