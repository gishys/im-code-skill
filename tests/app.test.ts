import { DatabaseSync } from "node:sqlite";
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
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ toast: expect.objectContaining({ type: "warning" }) }));
    expect(row.status).toBe("failed");
    expect(row.failure_stage).toBe("input_assets");
    expect(row.failure_summary).toContain("missing permissions");
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
            value: { action: "refresh_task_form_assets", draftId: draft.id }
          }
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(updateTaskCard).toHaveBeenCalledWith("om_form", expect.objectContaining({ header: expect.any(Object) }));
    expect(response.json()).toEqual(
      expect.objectContaining({
        toast: expect.objectContaining({
          content: "附件列表已刷新"
        })
      })
    );
    expect(response.json()).not.toHaveProperty("card");
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
    expect(row).toEqual({ execution_mode: "agent", status: "queued", plan_summary: "Plan body" });
  });
});
