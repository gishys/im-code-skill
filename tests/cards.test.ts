import { describe, expect, it } from "vitest";
import { buildAssetPreviewCard, buildTaskCard, buildTaskFormCard } from "../src/feishu/cards.js";
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

  it("renders a mobile web form entry without an outer attachment refresh when a form URL is provided", () => {
    const card = buildTaskFormCard(projects, {
      draftId: "draft-1",
      assetCandidates: [pendingAsset("asset-1", "image")],
      formUrl: "https://example.test/forms/tasks/draft-1?token=t"
    }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form");
    const actionBlocks = card.elements.filter((element) => element.tag === "action") as Array<{ actions: Array<{ url?: string; value?: { action?: string } }> }>;

    expect(form).toBeUndefined();
    expect(actionBlocks.some((block) => block.actions.some((button) => button.url === "https://example.test/forms/tasks/draft-1?token=t"))).toBe(true);
    expect(actionBlocks.some((block) => block.actions.some((button) => button.value?.action === "refresh_task_form_assets"))).toBe(false);
  });

  it("renders compact image preview buttons without embedding images in the form card", () => {
    const card = buildTaskFormCard(projects, {
      draftId: "draft-1",
      assetCandidates: [pendingAsset("asset-1", "image"), pendingAsset("asset-2", "file")]
    }) as { elements: Array<Record<string, unknown>> };
    const images = card.elements.filter((element) => element.tag === "img");
    const actionBlocks = card.elements.filter((element) => element.tag === "action") as Array<{ actions: Array<{ value?: { action?: string; assetId?: string } }> }>;

    expect(images).toEqual([]);
    expect(
      actionBlocks.some((block) =>
        block.actions.some((button) => button.value?.action === "preview_task_form_asset" && button.value.assetId === "asset-1")
      )
    ).toBe(true);
  });

  it("renders a focused image preview card", () => {
    const card = buildAssetPreviewCard(pendingAsset("asset-1", "image")) as { elements: Array<Record<string, unknown>> };

    expect(card.elements).toEqual([expect.objectContaining({ tag: "img", img_key: "file_asset-1", preview: true })]);
  });

  it("keeps the attachment selector visible but disabled when there are no pending assets", () => {
    const card = buildTaskFormCard(projects, { draftId: "draft-1" }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const select = form.elements.find((element) => element.name === "selectedAssetIds") as {
      tag: string;
      options: Array<{ value: string }>;
      disabled?: boolean;
    };

    expect(select).toEqual(
      expect.objectContaining({
        tag: "multi_select_static",
        disabled: true,
        options: []
      })
    );
  });

  it("keeps help outside the form container and refresh as a form-submit button", () => {
    const card = buildTaskFormCard(projects, { draftId: "draft-1" }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const formButtons = form.elements.filter((element) => element.tag === "button") as Array<{ value?: { action?: string } }>;
    const actionBlocks = card.elements.filter((element) => element.tag === "action") as Array<{ actions: Array<{ value?: { action?: string } }> }>;

    expect(formButtons.some((button) => button.value?.action === "open_help")).toBe(false);
    expect(formButtons).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ action: "refresh_task_form_assets" }) }),
      expect.objectContaining({ value: expect.objectContaining({ action: "submit_task_form" }) })
    ]);
    expect(actionBlocks.some((block) => block.actions.some((button) => button.value?.action === "open_help"))).toBe(true);
    expect(actionBlocks.some((block) => block.actions.some((button) => button.value?.action === "refresh_task_form_assets"))).toBe(false);
  });

  it("renders the execution mode field without forcing a card-level default", () => {
    const card = buildTaskFormCard(projects, { draftId: "draft-1" }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const mode = form.elements.find((element) => element.name === "executionMode") as { initial_option?: { value: string } };

    expect(mode).toBeTruthy();
    expect(mode.initial_option).toBeUndefined();
  });

  it("defaults the scope field to fullstack on new task forms", () => {
    const card = buildTaskFormCard(projects, { draftId: "draft-1" }) as { elements: Array<Record<string, unknown>> };
    const form = card.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const scope = form.elements.find((element) => element.name === "scope") as { initial_index?: number };

    expect(scope.initial_index).toBe(2);
  });

  it("renders plan-ready tasks with a convert-to-agent action", () => {
    const card = buildTaskCard(taskRecord({ executionMode: "plan", status: "plan_ready", planSummary: "Plan body" })) as {
      elements: Array<{ tag: string; actions?: Array<{ value?: { action?: string } }> }>;
    };
    const actionBlock = card.elements.find((element) => element.tag === "action");

    expect(actionBlock?.actions?.some((button) => button.value?.action === "approve_plan_as_agent")).toBe(true);
    expect(actionBlock?.actions?.some((button) => button.value?.action === "approve")).toBe(false);
  });

  it("renders plan revision feedback controls for plan-ready tasks", () => {
    const card = buildTaskCard(taskRecord({ executionMode: "plan", status: "plan_ready", planSummary: "Plan body" })) as {
      elements: Array<{
        tag: string;
        name?: string;
        text?: { content?: string };
        elements?: Array<{ name?: string; value?: { action?: string }; text?: { content?: string }; label?: { content?: string } }>;
      }>;
    };
    const reviewText = card.elements.find((element) => element.tag === "div" && element.text?.content?.includes("方案确认"));
    const form = card.elements.find((element) => element.tag === "form" && element.name === "plan_review_form");
    const reviseButton = form?.elements?.find((element) => element.value?.action === "revise_plan");

    expect(reviewText?.text?.content).toContain("修改意见");
    expect(form?.elements?.some((element) => element.name === "planFeedback")).toBe(true);
    expect(reviseButton?.text?.content).toBe("修改方案");
  });

  it("allows cancellation while a task is executing", () => {
    const card = buildTaskCard(taskRecord({ status: "running", currentStage: "codex_running" })) as {
      elements: Array<{ tag: string; actions?: Array<{ value?: { action?: string } }> }>;
    };
    const actions = card.elements.find((element) => element.tag === "action")?.actions ?? [];

    expect(actions.map((button) => button.value?.action)).toEqual(["cancel", "status"]);
  });

  it("shows confirmation only while waiting for approval", () => {
    const card = buildTaskCard(taskRecord({ status: "waiting_approval", approvalStatus: "pending", autoApproved: false })) as {
      elements: Array<{ tag: string; actions?: Array<{ value?: { action?: string } }> }>;
    };
    const actions = card.elements.find((element) => element.tag === "action")?.actions ?? [];

    expect(actions.map((button) => button.value?.action)).toEqual(["approve", "cancel", "status"]);
  });

  it("shows a retry action after a task fails", () => {
    const card = buildTaskCard(taskRecord({ status: "failed", currentStage: "failed", failureSummary: "clone failed" })) as {
      elements: Array<{ tag: string; name?: string; actions?: Array<{ value?: { action?: string } }>; elements?: Array<{ name?: string; value?: { action?: string } }> }>;
    };
    const actions = card.elements.find((element) => element.tag === "action")?.actions ?? [];
    const continueForm = card.elements.find((element) => element.tag === "form" && element.name === "failed_continue_form");

    expect(actions.map((button) => button.value?.action)).toEqual(["status", "retry"]);
    expect(continueForm?.elements?.some((element) => element.name === "description")).toBe(true);
    expect(continueForm?.elements?.some((element) => element.value?.action === "continue_task")).toBe(true);
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
