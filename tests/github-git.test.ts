import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { normalizeRepoUrl, prepareCachedRepoWorktree } from "../src/github/git.js";

vi.mock("execa", () => ({
  execa: vi.fn()
}));

const execaMock = vi.mocked(execa);
let tempRoot: string;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "repo-cache-test-"));
  execaMock.mockReset();
  execaMock.mockResolvedValue({ exitCode: 0, stdout: "", all: "" } as never);
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("prepareCachedRepoWorktree", () => {
  it("clones a missing cache, fetches the branch, and creates a task branch worktree", async () => {
    await prepareCachedRepoWorktree({
      repo: "git@github.com:example/demo-frontend.git",
      branch: "main",
      cacheRoot: join(tempRoot, "repo-cache"),
      destination: join(tempRoot, "workspaces", "task-1", "frontend"),
      worktreeBranch: "codex/task-1"
    });

    const calls = execaMock.mock.calls as unknown as Array<[string, string[], Record<string, unknown>?]>;
    const cloneCall = calls.find((call) => call[1][0] === "clone");
    expect(cloneCall?.[1]).toEqual(["clone", "--no-checkout", "git@github.com:example/demo-frontend.git", expect.any(String)]);

    const cacheDir = String(cloneCall?.[1][3]);
    expect(execaMock).toHaveBeenCalledWith("git", ["fetch", "origin", "main", "--prune"], { cwd: cacheDir, all: true });
    expect(execaMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-B", "codex/task-1", join(tempRoot, "workspaces", "task-1", "frontend"), "origin/main"],
      { cwd: cacheDir, all: true }
    );
  });

  it("reuses an existing cache and creates a detached plan worktree", async () => {
    const cacheRoot = join(tempRoot, "repo-cache");
    const cacheDir = join(cacheRoot, "github.com-example-demo-frontend-23730ded93fa2663");
    await mkdir(cacheDir, { recursive: true });

    await prepareCachedRepoWorktree({
      repo: "git@github.com:example/demo-frontend.git",
      branch: "main",
      cacheRoot,
      destination: join(tempRoot, "workspaces", "task-1", "frontend")
    });

    expect(execaMock).not.toHaveBeenCalledWith("git", expect.arrayContaining(["clone"]), expect.anything());
    expect(execaMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "--detach", join(tempRoot, "workspaces", "task-1", "frontend"), "origin/main"],
      { cwd: cacheDir, all: true }
    );
  });

  it("reuses an existing detached worktree on retry", async () => {
    const cacheRoot = join(tempRoot, "repo-cache");
    const cacheDir = join(cacheRoot, "github.com-example-demo-frontend-23730ded93fa2663");
    const destination = join(tempRoot, "workspaces", "task-1", "frontend");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(destination, { recursive: true });

    await prepareCachedRepoWorktree({
      repo: "git@github.com:example/demo-frontend.git",
      branch: "main",
      cacheRoot,
      destination
    });

    expect(execaMock).not.toHaveBeenCalledWith("git", expect.arrayContaining(["worktree", "add"]), expect.anything());
    expect(execaMock).toHaveBeenCalledWith("git", ["checkout", "--detach", "origin/main"], { cwd: destination, all: true });
    expect(execaMock).toHaveBeenCalledWith("git", ["reset", "--hard", "origin/main"], { cwd: destination, all: true });
    expect(execaMock).toHaveBeenCalledWith("git", ["clean", "-fd"], { cwd: destination, all: true });
  });

  it("reuses an existing branch worktree on retry", async () => {
    const cacheRoot = join(tempRoot, "repo-cache");
    const cacheDir = join(cacheRoot, "github.com-example-demo-frontend-23730ded93fa2663");
    const destination = join(tempRoot, "workspaces", "task-1", "frontend");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(destination, { recursive: true });

    await prepareCachedRepoWorktree({
      repo: "git@github.com:example/demo-frontend.git",
      branch: "main",
      cacheRoot,
      destination,
      worktreeBranch: "codex/task-1"
    });

    expect(execaMock).not.toHaveBeenCalledWith("git", expect.arrayContaining(["worktree", "add"]), expect.anything());
    expect(execaMock).toHaveBeenCalledWith("git", ["checkout", "-B", "codex/task-1", "origin/main"], { cwd: destination, all: true });
    expect(execaMock).toHaveBeenCalledWith("git", ["reset", "--hard", "origin/main"], { cwd: destination, all: true });
    expect(execaMock).toHaveBeenCalledWith("git", ["clean", "-fd"], { cwd: destination, all: true });
  });

  it("resolves relative cache and worktree paths before running git from the cache directory", async () => {
    await prepareCachedRepoWorktree({
      repo: "git@github.com:example/demo-frontend.git",
      branch: "main",
      cacheRoot: "repo-cache",
      destination: join("workspaces", "task-1", "frontend")
    });

    const calls = execaMock.mock.calls as unknown as Array<[string, string[], Record<string, unknown>?]>;
    const cloneCall = calls.find((call) => call[1][0] === "clone");
    const worktreeCall = calls.find((call) => call[1][0] === "worktree");
    expect(cloneCall?.[1][3]).toBe(resolve("repo-cache", "github.com-example-demo-frontend-23730ded93fa2663"));
    expect(worktreeCall?.[1][3]).toBe(resolve("workspaces", "task-1", "frontend"));
  });

  it("strips encoded quote characters from configured repository URLs", async () => {
    await prepareCachedRepoWorktree({
      repo: " https://github.com/example/demo-frontend.git%22 ",
      branch: "main",
      cacheRoot: join(tempRoot, "repo-cache"),
      destination: join(tempRoot, "workspaces", "task-1", "frontend")
    });

    const calls = execaMock.mock.calls as unknown as Array<[string, string[], Record<string, unknown>?]>;
    const cloneCall = calls.find((call) => call[1][0] === "clone");
    expect(cloneCall?.[1][2]).toBe("https://github.com/example/demo-frontend.git");
  });

  it("uses an existing cache for plan worktrees when fetch cannot reach GitHub", async () => {
    const cacheRoot = join(tempRoot, "repo-cache");
    const cacheDir = join(cacheRoot, "github.com-example-demo-frontend-23730ded93fa2663");
    await mkdir(cacheDir, { recursive: true });
    execaMock.mockImplementation((async (_command: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "fetch") {
        const error = new Error("fetch failed") as Error & { all: string };
        error.all = "fatal: unable to access 'https://github.com/example/demo-frontend.git/': Failed to connect to github.com port 443: Couldn't connect to server";
        throw error;
      }
      return { exitCode: 0, stdout: "", all: "" } as never;
    }) as never);

    await expect(
      prepareCachedRepoWorktree({
        repo: "git@github.com:example/demo-frontend.git",
        branch: "main",
        cacheRoot,
        destination: join(tempRoot, "workspaces", "task-1", "frontend"),
        allowStaleCacheOnFetchFailure: true
      })
    ).resolves.toBeUndefined();

    expect(execaMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "--detach", join(tempRoot, "workspaces", "task-1", "frontend"), "origin/main"],
      { cwd: cacheDir, all: true }
    );
  });

  it("reports a readable network error when no cache exists", async () => {
    execaMock.mockImplementation((async (_command: unknown, args: unknown) => {
      if (Array.isArray(args) && args[0] === "clone") {
        const error = new Error("clone failed") as Error & { all: string };
        error.all = "fatal: unable to access 'https://github.com/example/demo-frontend.git/': Failed to connect to github.com port 443: Couldn't connect to server";
        throw error;
      }
      return { exitCode: 0, stdout: "", all: "" } as never;
    }) as never);

    await expect(
      prepareCachedRepoWorktree({
        repo: "https://github.com/example/demo-frontend.git",
        branch: "main",
        cacheRoot: join(tempRoot, "repo-cache"),
        destination: join(tempRoot, "workspaces", "task-1", "frontend"),
        allowStaleCacheOnFetchFailure: true
      })
    ).rejects.toThrow("无法连接 GitHub");
  });
});

describe("normalizeRepoUrl", () => {
  it("removes surrounding raw and URL-encoded quotes", () => {
    expect(normalizeRepoUrl('"https://github.com/example/demo.git%22')).toBe("https://github.com/example/demo.git");
  });

  it("rejects repository URLs with whitespace inside them", () => {
    expect(() => normalizeRepoUrl("https://github.com/example/demo.git bad")).toThrow("仓库地址包含空白字符");
  });
});
