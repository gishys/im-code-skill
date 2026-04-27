import { describe, expect, it } from "vitest";
import { parsePollingCommand } from "../src/feishu/poller.js";

describe("parsePollingCommand", () => {
  it("parses Chinese approval command", () => {
    expect(parsePollingCommand("确认执行：task-123")).toEqual({
      action: "approve",
      taskId: "task-123"
    });
  });

  it("parses status command", () => {
    expect(parsePollingCommand("status task-abc")).toEqual({
      action: "status",
      taskId: "task-abc"
    });
  });

  it("ignores regular task messages", () => {
    expect(parsePollingCommand("项目：demo-app")).toBeUndefined();
  });
});
