import { describe, expect, it } from "vitest";
import { parseTaskMessage } from "../src/task/parser.js";

describe("parseTaskMessage", () => {
  it("parses structured Chinese task messages", () => {
    const result = parseTaskMessage(`项目：demo-app
类型：bug
范围：前端
描述：修复登录按钮无响应`);

    expect(result).toEqual({
      projectName: "demo-app",
      taskType: "bug",
      scope: "frontend",
      description: "修复登录按钮无响应"
    });
  });

  it("supports fullstack feature requests", () => {
    const result = parseTaskMessage(`project: demo-app
type: feature
scope: fullstack
description: add export flow`);

    expect(result.taskType).toBe("feature");
    expect(result.scope).toBe("fullstack");
  });

  it("reports missing required fields in Chinese", () => {
    expect(() => parseTaskMessage("测试机器人")).toThrow("缺少必填字段");
  });
});
