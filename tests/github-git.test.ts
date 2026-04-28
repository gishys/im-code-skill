import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execa } from "execa";
import { prepareCachedRepoWorktree } from "../src/github/git.js";

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
});
