import { createHash } from "node:crypto";
import { access, mkdir, readdir, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";

export interface GitRepoResult {
  branch: string;
  commitSha?: string;
}

const cacheLocks = new Map<string, Promise<void>>();

export async function cloneRepo(repo: string, branch: string, destination: string): Promise<void> {
  const normalizedRepo = normalizeRepoUrl(repo);
  await runGit(["clone", "--depth", "1", "--branch", branch, normalizedRepo, destination]);
}

export async function prepareCachedRepoWorktree(options: {
  repo: string;
  branch: string;
  destination: string;
  cacheRoot: string;
  worktreeBranch?: string;
  allowStaleCacheOnFetchFailure?: boolean;
}): Promise<void> {
  const repo = normalizeRepoUrl(options.repo);
  const cacheDir = repoCacheDir(resolve(options.cacheRoot), repo);
  const destination = resolve(options.destination);
  await withCacheLock(cacheDir, async () => {
    await ensureRepoCache(repo, options.branch, cacheDir, options.allowStaleCacheOnFetchFailure ?? false);
  });

  await mkdir(dirname(destination), { recursive: true });
  const target = `origin/${options.branch}`;
  if (await destinationExists(destination)) {
    if (await isGitRepository(destination)) {
      await reuseExistingWorktree(destination, target, options.worktreeBranch);
      return;
    }
    if (await isEmptyDirectory(destination)) {
      await rmdir(destination);
    } else {
      throw new Error(`Git worktree target already exists and is not a Git repository: ${destination}`);
    }
  }
  const args = options.worktreeBranch
    ? ["worktree", "add", "-B", options.worktreeBranch, destination, target]
    : ["worktree", "add", "--detach", destination, target];
  await runGit(args, { cwd: cacheDir });
}

async function destinationExists(destination: string): Promise<boolean> {
  try {
    await access(destination);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDirectory(destination: string): Promise<boolean> {
  try {
    return (await readdir(destination)).length === 0;
  } catch {
    return false;
  }
}

async function reuseExistingWorktree(destination: string, target: string, branch?: string): Promise<void> {
  if (branch) {
    await runGit(["checkout", "-B", branch, target], { cwd: destination });
  } else {
    await runGit(["checkout", "--detach", target], { cwd: destination });
  }
  await runGit(["reset", "--hard", target], { cwd: destination });
  await runGit(["clean", "-fd"], { cwd: destination });
}

async function ensureRepoCache(repo: string, branch: string, cacheDir: string, allowStaleCacheOnFetchFailure: boolean): Promise<void> {
  await mkdir(dirname(cacheDir), { recursive: true });
  const exists = await isGitRepository(cacheDir);
  if (!exists) {
    await runGit(["clone", "--no-checkout", repo, cacheDir]);
  }
  try {
    await runGit(["fetch", "origin", branch, "--prune"], { cwd: cacheDir });
  } catch (error) {
    if (exists && allowStaleCacheOnFetchFailure) {
      return;
    }
    throw error;
  }
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

export function normalizeRepoUrl(repo: string): string {
  let normalized = repo.trim();
  normalized = normalized.replace(/^(["'`]|%22|%27)+/i, "").replace(/(["'`]|%22|%27)+$/i, "");
  normalized = normalized.trim();
  if (!normalized) {
    throw new Error("仓库地址为空，请检查项目配置。");
  }
  if (/\s/.test(normalized)) {
    throw new Error(`仓库地址包含空白字符，请检查项目配置：${normalized}`);
  }
  return normalized;
}

async function runGit(args: string[], options: { cwd?: string } = {}): Promise<void> {
  try {
    await execa("git", args, { ...options, all: true });
  } catch (error) {
    throw buildGitError(args, error);
  }
}

function buildGitError(args: string[], error: unknown): Error {
  const output = extractGitOutput(error);
  const message = output.toLowerCase();
  const command = `git ${args.join(" ")}`;
  const repo = args.find((arg) => /^https?:\/\//.test(arg) || /^git@/.test(arg));

  if (message.includes("couldn't connect to server") || message.includes("failed to connect") || message.includes("timed out")) {
    return new Error(`无法连接 GitHub，仓库准备失败。请检查网络、代理或改用可访问的 SSH/HTTPS 地址。\n命令：${command}\n仓库：${repo ?? "unknown"}`);
  }
  if (message.includes("authentication failed") || message.includes("permission denied")) {
    return new Error(`Git 仓库鉴权失败。请检查 GitHub Token、SSH key 或仓库权限。\n命令：${command}\n仓库：${repo ?? "unknown"}`);
  }
  if (message.includes("repository not found") || message.includes("not found")) {
    return new Error(`Git 仓库不存在或当前凭据无权访问。请检查项目配置中的仓库地址。\n命令：${command}\n仓库：${repo ?? "unknown"}`);
  }
  if (message.includes("%22") || (repo ? /["'`]/.test(repo) : false)) {
    return new Error(`Git 仓库地址疑似包含多余引号，请检查项目配置。\n命令：${command}\n仓库：${repo ?? "unknown"}`);
  }
  return new Error(`Git 命令执行失败。\n命令：${command}\n${output}`);
}

function extractGitOutput(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }
  const record = error as Record<string, unknown>;
  return [record.all, record.stderr, record.stdout, record.shortMessage, record.message].filter((value) => typeof value === "string" && value.length > 0).join("\n");
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
