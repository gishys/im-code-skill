import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { FeishuClient } from "../src/feishu/client.js";

describe("FeishuClient downloads", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces Feishu permission errors when downloading message resources", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).includes("/auth/v3/tenant_access_token/internal")) {
          return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "tenant-token", expire: 7200 });
        }
        return jsonResponse(
          {
            code: 99991672,
            msg: "Access denied. One of the following scopes is required: [im:message.history:readonly, im:message:readonly, im:message]."
          },
          400
        );
      })
    );

    const client = new FeishuClient(testEnv());

    await expect(
      client.downloadMessageResource({
        messageId: "om_1",
        fileKey: "img_1",
        resourceType: "image",
        destination: "unused"
      })
    ).rejects.toThrow("app is missing message resource permission");
  });

  it("uses Feishu's file resource type for videos", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "tenant-token", expire: 7200 });
      }
      return jsonResponse({ code: 234001, msg: "Invalid request param." }, 400);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new FeishuClient(testEnv());

    await expect(
      client.downloadMessageResource({
        messageId: "om_1",
        fileKey: "file_1",
        resourceType: "video",
        destination: "unused"
      })
    ).rejects.toThrow("Invalid request param");
    expect(String(fetchMock.mock.calls[1][0])).toContain("type=file");
  });
});

function testEnv() {
  return loadEnv({
    FEISHU_APP_ID: "cli_test",
    FEISHU_APP_SECRET: "secret"
  });
}

function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
