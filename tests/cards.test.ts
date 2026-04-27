import { describe, expect, it } from "vitest";
import { buildTaskCard, buildTaskFormCard } from "../src/feishu/cards.js";
import type { PendingInputAsset, ProjectConfig, TaskRecord } from "../src/types.js";

const projects: ProjectConfig[] = [
  {
    name: "demo-app",
    default_branch: "main",
    frontend: {
      repo: "git@github.com:example/demo-frontend.git",
      artifact_paths: ["dist"]
    },
    package: {
      format: "zip",
      name_template: "{project}-{scope}-{taskId}-{timestamp}.zip"
    }
  }
];

describe("buildTaskFormCard", () => {
  it("sets name on every interactive element inside the form", () => {
    const card = buildTaskFormCard(projects, {
      draftId: "draft-1",
      assetCandidates: [pendingAsset("asset-1", "image")]
    }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };

    expect(form).toBeTruthy();
    for (const element of form.elements) {
      if (["input", "select_static", "multi_select_static", "button"].includes(String(element.tag))) {
        expect(element.name).toEqual(expect.any(String));
        expect(String(element.name)).not.toHaveLength(0);
      }
    }
  });

  it("renders pending assets as a multi-select field", () => {
    const card = buildTaskFormCard(projects, {
      draftId: "draft-1",
      assetCandidates: [pendingAsset("asset-1", "image")]
    }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const select = form.elements.find((element) => element.tag === "multi_select_static") as { options: Array<{ value: string }> };

    expect(select.options).toEqual([expect.objectContaining({ value: "asset-1" })]);
  });

  it("keeps the attachment selector visible when there are no pending assets", () => {
    const card = buildTaskFormCard(projects, { draftId: "draft-1" }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const select = form.elements.find((element) => element.name === "selectedAssetIds") as {
      tag: string;
      options: Array<{ value: string }>;
    };

    expect(select).toEqual(
      expect.objectContaining({
        tag: "multi_select_static",
        options: [expect.objectContaining({ value: "__no_pending_assets__" })]
      })
    );
  });

  it("keeps non-submit buttons outside the form container", () => {
    const card = buildTaskFormCard(projects, { draftId: "draft-1" }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const formButtons = form.elements.filter((element) => element.tag === "button") as Array<{ value?: { action?: string } }>;
    const actionBlocks = card.elements.filter((element) => element.tag === "action") as Array<{ actions: Array<{ value?: { action?: string } }> }>;

    expect(formButtons.some((button) => button.value?.action === "open_help")).toBe(false);
    expect(formButtons.some((button) => button.value?.action === "refresh_task_form_assets")).toBe(false);
    expect(formButtons).toEqual([expect.objectContaining({ value: expect.objectContaining({ action: "submit_task_form" }) })]);
    expect(actionBlocks.some((block) => block.actions.some((button) => button.value?.action === "open_help"))).toBe(true);
    expect(actionBlocks.some((block) => block.actions.some((button) => button.value?.action === "refresh_task_form_assets"))).toBe(true);
  });

  it("renders the execution mode field without forcing a card-level default", () => {
    const card = buildTaskFormCard(projects, { draftId: "draft-1" }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const mode = form.elements.find((element) => element.name === "executionMode") as { initial_option?: { value: string } };

    expect(mode).toBeTruthy();
    expect(mode.initial_option).toBeUndefined();
  });

  it("renders plan-ready tasks with a convert-to-agent action", () => {
    const card = buildTaskCard(taskRecord({ executionMode: "plan", status: "plan_ready", planSummary: "Plan body" })) as {
      elements: Array<{ tag: string; actions?: Array<{ value?: { action?: string } }> }>;
    };
    const actionBlock = card.elements.find((element) => element.tag === "action");

    expect(actionBlock?.actions?.some((button) => button.value?.action === "approve_plan_as_agent")).toBe(true);
    expect(actionBlock?.actions?.some((button) => button.value?.action === "approve")).toBe(false);
  });
});

function pendingAsset(id: string, assetType: PendingInputAsset["assetType"]): PendingInputAsset {
  return {
    id,
    draftId: "draft-1",
    feishuChatId: "oc_a",
    feishuUserId: "ou_a",
    feishuMessageId: `om_${id}`,
    assetType,
    feishuFileKey: `file_${id}`,
    fileName: `${id}.png`,
    mimeType: "image/png",
    status: "pending",
    createdAt: "2026-04-27T12:00:00.000Z",
    updatedAt: "2026-04-27T12:00:00.000Z",
    label: "图1"
  };
}

function taskRecord(input: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-1",
    feishuEventId: null,
    feishuChatId: "oc_a",
    feishuMessageId: "om_a",
    feishuUserId: "ou_a",
    projectName: "demo-app",
    taskType: "bug",
    scope: "frontend",
    executionMode: "agent",
    rawText: "raw",
    parsedDescription: "description",
    status: "queued",
    approvalStatus: "auto_approved",
    autoApproved: true,
    currentStage: "queued",
    failureStage: null,
    failureSummary: null,
    workspacePath: null,
    artifactPath: null,
    artifactFileKey: null,
    planSummary: null,
    planArtifactPath: null,
    inputAssetsJson: null,
    streamMessageId: null,
    githubPrUrl: null,
    githubBranch: null,
    githubCommitSha: null,
    lockedBy: null,
    lockedAt: null,
    heartbeatAt: null,
    createdAt: "2026-04-27T12:00:00.000Z",
    updatedAt: "2026-04-27T12:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...input
  };
}
