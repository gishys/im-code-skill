import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { schemaSql } from "../src/db/schema.js";
import type { FeishuClient } from "../src/feishu/client.js";
import { AssetService } from "../src/inputs/asset-service.js";
import { TaskService } from "../src/task/service.js";
import type { ProjectConfig } from "../src/types.js";

const projects: ProjectConfig[] = [
  {
    name: "demo-app",
    default_branch: "main",
    frontend: {
      repo: "git@github.com:example/demo.git",
      artifact_paths: ["dist"]
    },
    package: {
      format: "zip",
      name_template: "{project}-{scope}-{taskId}-{timestamp}.zip"
    }
  }
];

const fakeFeishu = {
  async sendTaskCard() {
    return "om_card";
  },
  async sendText() {
    return "om_text";
  },
  async updateTaskCard() {
    return undefined;
  },
  async downloadFile() {
    return "";
  },
  async downloadMessageResource() {
    return "";
  }
} as unknown as FeishuClient;

describe("Feishu card actions", () => {
  it("requires security-sensitive Feishu settings in production", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      })
    ).toThrow(/FEISHU_VERIFICATION_TOKEN/);

    expect(() =>
      loadEnv({
        NODE_ENV: "production",
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:",
        FEISHU_VERIFICATION_TOKEN: "verify",
        FEISHU_ENCRYPT_KEY: "encrypt",
        FEISHU_ALLOWED_CHAT_IDS: "oc_group",
        INTERNAL_API_TOKEN: "internal"
      })
    ).not.toThrow();
  });

  it("protects internal task details when an API token is configured", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const tasks = new TaskService(db);
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        executionMode: "plan",
        taskType: "bug",
        scope: "frontend",
        description: "fix"
      },
      rawText: "raw",
      autoApproved: true
    });
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:",
        INTERNAL_API_TOKEN: "secret-token"
      }),
      projects,
      tasks,
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const rejected = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
    const accepted = await app.inject({
      method: "GET",
      url: `/tasks/${task.id}`,
      headers: { authorization: "Bearer secret-token" }
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual(expect.objectContaining({ id: task.id }));
  });

  it("rejects Feishu callbacks when the verification token is wrong", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:",
        FEISHU_VERIFICATION_TOKEN: "expected-token"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: { token: "wrong-token", type: "url_verification", challenge: "challenge" }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: { token: "expected-token", type: "url_verification", challenge: "challenge" }
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ challenge: "challenge" });
  });

  it("accepts encrypted Feishu URL verification callbacks", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:",
        FEISHU_VERIFICATION_TOKEN: "expected-token",
        FEISHU_ENCRYPT_KEY: "encrypt-key"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: {
        encrypt: encryptFeishuPayload("encrypt-key", {
          token: "expected-token",
          type: "url_verification",
          challenge: "challenge"
        })
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ challenge: "challenge" });
  });

  it("stores pure attachment messages as pending assets instead of creating tasks", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: {
        event: {
          sender: { sender_id: { open_id: "ou_a" } },
          message: {
            chat_id: "oc_group",
            message_id: "om_img",
            message_type: "image",
            content: JSON.stringify({ image_key: "img_1", file_name: "screen.png" })
          }
        }
      }
    });

    const taskCount = db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number };
    const pendingCount = db.prepare("SELECT COUNT(*) AS count FROM pending_input_assets").get() as { count: number };

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ pendingAssets: 1 }));
    expect(taskCount.count).toBe(0);
    expect(pendingCount.count).toBe(1);
  });

  it("does not auto-update an active form card when attachments arrive", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const updateTaskCard = vi.fn(async () => undefined);
    const sendText = vi.fn(async () => "om_text");
    const assets = new AssetService(db, {
      ...fakeFeishu,
      updateTaskCard,
      sendText
    } as unknown as FeishuClient);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });
    assets.setDraftFormMessageId(draft.id, "om_form");
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: {
        ...fakeFeishu,
        updateTaskCard,
        sendText
      } as unknown as FeishuClient,
      assets
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/events",
      payload: {
        event: {
          sender: { sender_id: { open_id: "ou_a" } },
          message: {
            chat_id: "oc_group",
            message_id: "om_img",
            message_type: "image",
            content: JSON.stringify({ image_key: "img_1", file_name: "screen.png" })
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(updateTaskCard).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("oc_group", expect.stringContaining("刷新"));
  });

  it("warns when attachment notes are submitted without selected attachments", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const assets = new AssetService(db, fakeFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "submit_task_form", draftId: draft.id },
            form_value: {
              projectName: "demo-app",
              taskType: "bug",
              scope: "frontend",
              description: "修复登录按钮",
              attachmentNote: "图1是当前效果"
            }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        toast: expect.objectContaining({
          type: "warning",
          content: expect.stringContaining("还没有选择要关联的附件")
        })
      })
    );
  });

  it("marks a submitted task failed when selected attachments cannot be downloaded", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const failingFeishu = {
      ...fakeFeishu,
      updateTaskCard: vi.fn(async () => undefined),
      downloadMessageResource: vi.fn(async () => {
        throw new Error("Feishu attachment download failed: missing permissions");
      })
    } as unknown as FeishuClient;
    const assets = new AssetService(db, failingFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a" });
    await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_img",
      assets: [{ assetType: "image", feishuFileKey: "img_1", fileName: "screen.png", mimeType: "image/png" }]
    });
    const candidate = assets.getPendingAssetCandidates({ draftId: draft.id })[0];
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: failingFeishu,
      assets
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "submit_task_form", draftId: draft.id },
            form_value: {
              projectName: "demo-app",
              taskType: "bug",
              scope: "frontend",
              description: "fix",
              selectedAssetIds: candidate.id
            }
          }
        }
      }
    });

    const row = db.prepare("SELECT status, failure_stage, failure_summary FROM tasks ORDER BY created_at DESC LIMIT 1").get() as {
      status: string;
      failure_stage: string;
      failure_summary: string;
    };
    const draftRow = db.prepare("SELECT status FROM task_drafts WHERE id = ?").get(draft.id) as { status: string };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ toast: expect.objectContaining({ type: "warning" }) }));
    expect(row.status).toBe("failed");
    expect(row.failure_stage).toBe("input_assets");
    expect(row.failure_summary).toContain("missing permissions");
    expect(draftRow.status).toBe("submitted");
  });

  it("sends help as a new card for form help clicks", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const sendTaskCard = vi.fn(async () => "om_help");
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: {
        ...fakeFeishu,
        sendTaskCard
      } as unknown as FeishuClient,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "open_help" }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(sendTaskCard).toHaveBeenCalledWith("oc_group", expect.objectContaining({ header: expect.any(Object) }));
    expect(response.json()).toEqual(
      expect.objectContaining({
        toast: expect.objectContaining({
          content: "已把填写说明发送到会话底部"
        })
      })
    );
    expect(response.json()).not.toHaveProperty("card");
  });

  it("updates the existing form card when refreshing assets", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const updateTaskCard = vi.fn(async () => undefined);
    const assets = new AssetService(db, fakeFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: {
        ...fakeFeishu,
        updateTaskCard
      } as unknown as FeishuClient,
      assets
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "refresh_task_form_assets", draftId: draft.id },
            form_value: {
              projectName: "demo-app",
              executionMode: "agent",
              taskType: "bug",
              scope: "frontend",
              description: "keep this description"
            }
          }
        }
      }
    });

    const updatedCard = (updateTaskCard.mock.calls as unknown[][])[0][1] as { elements: Array<Record<string, unknown>> };
    const form = updatedCard.elements.find((element) => element.tag === "form") as { elements: Array<Record<string, unknown>> };
    const description = form.elements.find((element) => element.name === "description") as { default_value?: string };
    expect(response.statusCode).toBe(200);
    expect(updateTaskCard).toHaveBeenCalledWith("om_form", expect.objectContaining({ header: expect.any(Object) }));
    expect(description.default_value).toBe("keep this description");
    expect(response.json()).toEqual(
      expect.objectContaining({
        toast: expect.objectContaining({
          content: "附件列表已刷新"
        })
      })
    );
    expect(response.json()).not.toHaveProperty("card");
  });

  it("sends an image preview card without replacing the active form card", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const sendTaskCard = vi.fn(async () => "om_preview");
    const updateTaskCard = vi.fn(async () => undefined);
    const feishu = {
      ...fakeFeishu,
      sendTaskCard,
      updateTaskCard
    } as unknown as FeishuClient;
    const assets = new AssetService(db, feishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const saved = await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_img",
      assets: [{ assetType: "image", feishuFileKey: "img_1", fileName: "screen.png", mimeType: "image/png" }]
    });
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu,
      assets
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "preview_task_form_asset", draftId: draft.id, assetId: saved.saved[0]!.id }
          }
        }
      }
    });

    const previewCard = (sendTaskCard.mock.calls as unknown[][])[0][1] as { elements: Array<Record<string, unknown>> };
    expect(response.statusCode).toBe(200);
    expect(updateTaskCard).not.toHaveBeenCalled();
    expect(sendTaskCard).toHaveBeenCalledWith("oc_group", expect.objectContaining({ header: expect.any(Object) }));
    expect(previewCard.elements).toEqual([expect.objectContaining({ tag: "img", img_key: "img_1", preview: true })]);
  });

  it("renders the mobile web form with per-image preview controls", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const assets = new AssetService(db, fakeFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_img",
      assets: [
        { assetType: "image", feishuFileKey: "img_1", fileName: "screen.png", mimeType: "image/png" },
        { assetType: "file", feishuFileKey: "file_1", fileName: "notes.txt", mimeType: "text/plain" }
      ]
    });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets
    });

    const response = await app.inject({
      method: "GET",
      url: `/forms/tasks/${draft.id}?token=${draft.formToken}`
    });
    const html = response.body;

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(html).toContain("填写 Codex 任务表单");
    expect(html).toContain("screen.png");
    expect(html).toContain("data-preview=");
    expect(html).toContain("notes.txt");
    expect(html).toContain('<option value="fullstack" selected>');
    expect(html).toContain("100svh");
    expect(html).toContain("keepFieldVisible");
    expect(html).toContain('behavior: "auto"');
    expect(html).toContain("returnToFeishuConversation");
    expect(html).toContain("任务已提交，正在返回飞书会话");
    expect(html).not.toContain("window.scrollTo(0, 0)");
    expect(html).toContain("不可预览");
  });

  it("rotates mobile web form tokens when the form is opened", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const assets = new AssetService(db, fakeFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets
    });

    const response = await app.inject({
      method: "GET",
      url: `/forms/tasks/${draft.id}?token=${draft.formToken}`
    });
    const rotated = assets.getDraft(draft.id);
    const oldTokenResponse = await app.inject({
      method: "GET",
      url: `/forms/tasks/${draft.id}/assets?token=${draft.formToken}`
    });
    const newTokenResponse = await app.inject({
      method: "GET",
      url: `/forms/tasks/${draft.id}/assets?token=${rotated.formToken}`
    });

    expect(response.statusCode).toBe(200);
    expect(rotated.formToken).not.toBe(draft.formToken);
    expect(response.body).toContain(`token=${rotated.formToken}`);
    expect(oldTokenResponse.statusCode).toBe(403);
    expect(newTokenResponse.statusCode).toBe(200);
  });

  it("rejects mobile web forms with an invalid token", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const assets = new AssetService(db, fakeFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets
    });

    const response = await app.inject({ method: "GET", url: `/forms/tasks/${draft.id}?token=bad` });

    expect(response.statusCode).toBe(403);
  });

  it("submits the mobile web form and links selected attachments", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const updateTaskCard = vi.fn(async () => undefined);
    const feishu = {
      ...fakeFeishu,
      updateTaskCard,
      async downloadMessageResource(input: { destination: string }) {
        await mkdir(dirname(input.destination), { recursive: true });
        await writeFile(input.destination, "asset");
        return input.destination;
      }
    } as unknown as FeishuClient;
    const assets = new AssetService(db, feishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    assets.setDraftFormMessageId(draft.id, "om_form");
    const saved = await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_img",
      assets: [{ assetType: "image", feishuFileKey: "img_1", fileName: "screen.png", mimeType: "image/png" }]
    });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu,
      assets
    });

    const response = await app.inject({
      method: "POST",
      url: `/forms/tasks/${draft.id}/submit?token=${draft.formToken}`,
      payload: {
        projectName: "demo-app",
        executionMode: "plan",
        taskType: "bug",
        scope: "frontend",
        description: "fix from web",
        selectedAssetIds: [saved.saved[0]!.id],
        attachmentNote: "图1是当前效果"
      }
    });
    const inputCount = db.prepare("SELECT COUNT(*) AS count FROM input_assets").get() as { count: number };

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ ok: true, taskId: expect.any(String) }));
    expect(inputCount.count).toBe(1);
    expect(updateTaskCard).toHaveBeenCalledWith("om_form", expect.objectContaining({ header: expect.any(Object) }));
  });

  it("forces mobile web form submissions to plan mode even when agent is posted", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const assets = new AssetService(db, fakeFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets
    });

    const response = await app.inject({
      method: "POST",
      url: `/forms/tasks/${draft.id}/submit?token=${draft.formToken}`,
      payload: {
        projectName: "demo-app",
        executionMode: "agent",
        taskType: "bug",
        scope: "frontend",
        description: "force plan from web"
      }
    });
    const row = db.prepare("SELECT execution_mode, status FROM tasks").get() as { execution_mode: string; status: string };

    expect(response.statusCode).toBe(200);
    expect(row).toEqual({ execution_mode: "plan", status: "queued" });
  });

  it("proxies pending image previews for the mobile web form", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const feishu = {
      ...fakeFeishu,
      async downloadMessageResource(input: { destination: string }) {
        await mkdir(dirname(input.destination), { recursive: true });
        await writeFile(input.destination, "image-bytes");
        return input.destination;
      }
    } as unknown as FeishuClient;
    const assets = new AssetService(db, feishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const saved = await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_img",
      assets: [{ assetType: "image", feishuFileKey: "img_1", fileName: "screen.png", mimeType: "image/png" }]
    });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu,
      assets
    });

    const response = await app.inject({
      method: "GET",
      url: `/forms/tasks/${draft.id}/assets/${saved.saved[0]!.id}/preview?token=${draft.formToken}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.body).toBe("image-bytes");
  });

  it("refreshes mobile web form assets after the form is opened", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const assets = new AssetService(db, fakeFeishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets
    });

    await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_video",
      assets: [{ assetType: "video", feishuFileKey: "video_1", fileName: "recording.mp4", mimeType: "video/mp4" }]
    });
    const response = await app.inject({
      method: "GET",
      url: `/forms/tasks/${draft.id}/assets?token=${draft.formToken}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        ok: true,
        assets: [expect.objectContaining({ assetType: "video", fileName: "recording.mp4" })]
      })
    );
  });

  it("proxies pending video previews for the mobile web form", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const feishu = {
      ...fakeFeishu,
      async downloadMessageResource(input: { destination: string }) {
        await mkdir(dirname(input.destination), { recursive: true });
        await writeFile(input.destination, "video-bytes");
        return input.destination;
      }
    } as unknown as FeishuClient;
    const assets = new AssetService(db, feishu);
    const draft = assets.createDraft({ chatId: "oc_group", userId: "ou_a", sourceMessageId: "om_source" });
    const saved = await assets.savePendingAssets({
      chatId: "oc_group",
      userId: "ou_a",
      messageId: "om_video",
      assets: [{ assetType: "video", feishuFileKey: "video_1", fileName: "recording.mp4", mimeType: "video/mp4" }]
    });
    const app = createApp({
      env: loadEnv({ PORT: "3005", WORKER_ENABLED: "false", DATABASE_PATH: ":memory:" }),
      projects,
      tasks: new TaskService(db),
      feishu,
      assets
    });

    const response = await app.inject({
      method: "GET",
      url: `/forms/tasks/${draft.id}/assets/${saved.saved[0]!.id}/preview?token=${draft.formToken}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("video/mp4");
    expect(response.body).toBe("video-bytes");
  });

  it("defaults submitted forms to plan mode", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const updateTaskCard = vi.fn(async () => undefined);
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: {
        ...fakeFeishu,
        updateTaskCard
      } as unknown as FeishuClient,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "submit_task_form" },
            form_value: {
              projectName: "demo-app",
              taskType: "bug",
              scope: "frontend",
              description: "修复登录按钮"
            }
          }
        }
      }
    });

    const row = db.prepare("SELECT execution_mode, status FROM tasks").get() as { execution_mode: string; status: string };
    expect(response.statusCode).toBe(200);
    expect(updateTaskCard).toHaveBeenCalledWith("om_form", expect.objectContaining({ header: expect.any(Object) }));
    expect(response.json()).not.toHaveProperty("card");
    expect(row).toEqual({ execution_mode: "plan", status: "queued" });
  });

  it("ignores the no-attachment placeholder value when submitting a form", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "submit_task_form" },
            form_value: {
              projectName: "demo-app",
              taskType: "bug",
              scope: "frontend",
              description: "fix",
              selectedAssetIds: "__no_pending_assets__"
            }
          }
        }
      }
    });

    const row = db.prepare("SELECT status, input_assets_json FROM tasks").get() as { status: string; input_assets_json: string | null };
    expect(response.statusCode).toBe(200);
    expect(row).toEqual({ status: "queued", input_assets_json: null });
  });

  it("does not fail the Feishu callback when card update is rejected", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: {
        ...fakeFeishu,
        updateTaskCard: vi.fn(async () => {
          throw new Error("invalid card");
        })
      } as unknown as FeishuClient,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "submit_task_form" },
            form_value: {
              projectName: "[\"demo-app\"]",
              taskType: "[\"bug\"]",
              scope: "[\"frontend\"]",
              description: "测试表单"
            }
          }
        }
      }
    });

    const row = db.prepare("SELECT execution_mode, status FROM tasks").get() as { execution_mode: string; status: string };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ toast: expect.objectContaining({ type: "success" }) }));
    expect(row).toEqual({ execution_mode: "plan", status: "queued" });
  });

  it("keeps explicit agent submissions on the approval path", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks: new TaskService(db),
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "submit_task_form" },
            form_value: {
              projectName: "demo-app",
              executionMode: "agent",
              taskType: "bug",
              scope: "frontend",
              description: "修复登录按钮"
            }
          }
        }
      }
    });

    const row = db.prepare("SELECT execution_mode, status FROM tasks").get() as { execution_mode: string; status: string };
    expect(response.statusCode).toBe(200);
    expect(row).toEqual({ execution_mode: "agent", status: "waiting_approval" });
  });

  it("converts a ready plan to an agent task from the card action", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const tasks = new TaskService(db);
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        executionMode: "plan",
        taskType: "bug",
        scope: "frontend",
        description: "修复登录按钮"
      },
      rawText: "raw",
      autoApproved: true
    });
    tasks.markPlanReady(task.id, { planSummary: "Plan body" });
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks,
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "approve_plan_as_agent", taskId: task.id }
          }
        }
      }
    });

    const row = db.prepare("SELECT execution_mode, status, plan_summary FROM tasks WHERE id = ?").get(task.id) as {
      execution_mode: string;
      status: string;
      plan_summary: string;
    };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        card: expect.objectContaining({
          type: "raw",
          data: expect.objectContaining({ header: expect.any(Object) })
        })
      })
    );
    expect(row).toEqual({ execution_mode: "agent", status: "queued", plan_summary: "Plan body" });
  });

  it("queues a new plan revision from plan feedback", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const tasks = new TaskService(db);
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        executionMode: "plan",
        taskType: "bug",
        scope: "frontend",
        description: "fix empty state"
      },
      rawText: "raw",
      autoApproved: true
    });
    tasks.addPlanVersion({
      taskId: task.id,
      threadId: task.threadId,
      planPath: "/tmp/plan-v1.md",
      summary: "Plan v1"
    });
    tasks.markPlanReady(task.id, { planSummary: "Plan v1" });
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks,
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_form",
          operator: { open_id: "ou_a" },
          action: {
            form_value: {
              planFeedback: "Add a rollback step and check backend migrations."
            },
            value: { action: "revise_plan", taskId: task.id }
          }
        }
      }
    });

    const row = db.prepare("SELECT execution_mode, status, current_stage, parsed_description FROM tasks WHERE id = ?").get(task.id) as {
      execution_mode: string;
      status: string;
      current_stage: string;
      parsed_description: string;
    };
    const message = db.prepare("SELECT message_type, content FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(task.id) as {
      message_type: string;
      content: string;
    };
    expect(response.statusCode).toBe(200);
    expect(row.execution_mode).toBe("plan");
    expect(row.status).toBe("queued");
    expect(row.current_stage).toBe("queued");
    expect(row.parsed_description).toContain("Add a rollback step");
    expect(message).toEqual({ message_type: "revise_plan", content: "Add a rollback step and check backend migrations." });
  });

  it("requeues a failed task from the retry card action", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const tasks = new TaskService(db);
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        executionMode: "agent",
        taskType: "bug",
        scope: "frontend",
        description: "fix clone failure"
      },
      rawText: "raw",
      autoApproved: true
    });
    tasks.markFailed(task.id, "cloning", "clone failed");
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks,
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_failed",
          operator: { open_id: "ou_a" },
          action: {
            value: { action: "retry", taskId: task.id }
          }
        }
      }
    });

    const row = db.prepare("SELECT status, current_stage, failure_stage, failure_summary FROM tasks WHERE id = ?").get(task.id) as {
      status: string;
      current_stage: string;
      failure_stage: string | null;
      failure_summary: string | null;
    };
    expect(response.statusCode).toBe(200);
    expect(row).toEqual({ status: "queued", current_stage: "queued", failure_stage: null, failure_summary: null });
  });

  it("continues a failed task with extra context and requeues it", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(schemaSql);
    const tasks = new TaskService(db);
    const task = tasks.createTask({
      parsed: {
        projectName: "demo-app",
        executionMode: "agent",
        taskType: "bug",
        scope: "frontend",
        description: "fix clone failure"
      },
      rawText: "raw",
      autoApproved: true
    });
    tasks.markFailed(task.id, "cloning", "clone failed");
    const app = createApp({
      env: loadEnv({
        PORT: "3005",
        WORKER_ENABLED: "false",
        DATABASE_PATH: ":memory:"
      }),
      projects,
      tasks,
      feishu: fakeFeishu,
      assets: new AssetService(db, fakeFeishu)
    });

    const response = await app.inject({
      method: "POST",
      url: "/feishu/actions",
      payload: {
        event: {
          open_chat_id: "oc_group",
          open_message_id: "om_failed",
          operator: { open_id: "ou_a" },
          action: {
            form_value: {
              description: "The local worker has been authorized; reuse the existing worktree."
            },
            value: { action: "continue_task", taskId: task.id }
          }
        }
      }
    });

    const row = db.prepare("SELECT status, current_stage, failure_stage, failure_summary, parsed_description FROM tasks WHERE id = ?").get(task.id) as {
      status: string;
      current_stage: string;
      failure_stage: string | null;
      failure_summary: string | null;
      parsed_description: string;
    };
    const message = db.prepare("SELECT message_type, content FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(task.id) as {
      message_type: string;
      content: string;
    };
    expect(response.statusCode).toBe(200);
    expect(row.status).toBe("queued");
    expect(row.current_stage).toBe("queued");
    expect(row.failure_stage).toBeNull();
    expect(row.failure_summary).toBeNull();
    expect(row.parsed_description).toContain("reuse the existing worktree");
    expect(message).toEqual({ message_type: "continue_task", content: "The local worker has been authorized; reuse the existing worktree." });
  });
});

function encryptFeishuPayload(encryptKey: string, payload: Record<string, unknown>): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const iv = Buffer.from("0123456789abcdef");
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]).toString("base64");
}
