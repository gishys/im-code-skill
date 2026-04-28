import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { schemaSql } from "../src/db/schema.js";
import { AssetService } from "../src/inputs/asset-service.js";
import { TaskService } from "../src/task/service.js";
import type { FeishuClient } from "../src/feishu/client.js";
import type { FeishuMessageEvent } from "../src/feishu/events.js";

const fakeFeishu = {
  async downloadFile(_fileKey: string, destination: string) {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "asset");
    return destination;
  },
  async downloadMessageResource(input: { destination: string }) {
    await mkdir(dirname(input.destination), { recursive: true });
    await writeFile(input.destination, "asset");
    return input.destination;
  }
} as FeishuClient;

describe("AssetService", () => {
  it("keeps pending attachment candidates scoped to the same chat and user", async () => {
    const { assets } = createServices();
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });

    await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_a",
      assets: [inputAsset("file_a", "a.png", "image")]
    });
    await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_b",
      messageId: "om_b",
      assets: [inputAsset("file_b", "b.png", "image")]
    });

    const candidates = assets.getPendingAssetCandidates({ draftId: draft.id });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({ feishuUserId: "ou_a", fileName: "a.png" }));
  });

  it("creates a form token and validates active draft access", () => {
    const { assets } = createServices();
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });

    expect(draft.formToken).toHaveLength(64);
    expect(assets.verifyDraftFormToken(draft.id, draft.formToken)).toEqual(expect.objectContaining({ id: draft.id }));
    expect(assets.verifyDraftFormToken(draft.id, "bad-token")).toBeUndefined();
  });

  it("shows pending attachments from the same chat and user even when they belong to another draft", async () => {
    const { assets } = createServices();
    const firstDraft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });
    await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_a",
      assets: [inputAsset("file_a", "a.png", "image")]
    });
    const secondDraft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });

    const candidates = assets.getPendingAssetCandidates({ draftId: secondDraft.id });

    expect(firstDraft.id).not.toBe(secondDraft.id);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual(expect.objectContaining({ fileName: "a.png" }));
  });

  it("links selected pending assets to a task and prevents reuse", async () => {
    const { assets, tasks, db } = createServices();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "feishu-assets-"));
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });
    await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_a",
      assets: [inputAsset("file_a", "a.png", "image")]
    });
    const candidate = assets.getPendingAssetCandidates({ draftId: draft.id })[0];
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        taskType: "bug",
        scope: "frontend",
        executionMode: "agent",
        description: "fix"
      },
      rawText: "项目：demo-app",
      autoApproved: false
    });

    await assets.linkPendingAssetsToTask({
      taskId: task.id,
      workspaceRoot,
      assets: [candidate]
    });

    const inputCount = db.prepare("SELECT COUNT(*) AS count FROM input_assets WHERE task_id = ?").get(task.id) as { count: number };
    expect(inputCount.count).toBe(1);
    expect(() =>
      assets.resolveSelectedPendingAssets({
        draftId: draft.id,
        chatId: "oc_group",
        userId: "ou_a",
        assetIds: [candidate.id]
      })
    ).toThrow("已过期、已被其他任务关联");
  });
});

function createServices() {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql);
  return {
    db,
    assets: new AssetService(db, fakeFeishu),
    tasks: new TaskService(db)
  };
}

function inputAsset(fileKey: string, fileName: string, assetType: FeishuMessageEvent["assets"][number]["assetType"]) {
  return {
    assetType,
    feishuFileKey: fileKey,
    fileName,
    mimeType: "image/png"
  };
}
