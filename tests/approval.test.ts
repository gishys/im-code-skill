import { describe, expect, it } from "vitest";
import { isAutoApproved } from "../src/task/approval.js";
import type { ProjectConfig } from "../src/types.js";

const project: ProjectConfig = {
  name: "demo-app",
  default_branch: "main",
  frontend: {
    repo: "git@github.com:example/demo.git",
    artifact_paths: ["dist"]
  },
  package: {
    format: "zip",
    name_template: "{project}-{scope}-{taskId}-{timestamp}.zip"
  },
  auto_approve_rules: {
    users: ["ou_ok"],
    task_types: ["bug"],
    scopes: ["frontend"]
  }
};

describe("isAutoApproved", () => {
  it("requires user, type and scope to match", () => {
    expect(
      isAutoApproved(
        project,
        {
          projectName: "demo-app",
          taskType: "bug",
          scope: "frontend",
          executionMode: "agent",
          description: "fix"
        },
        "ou_ok"
      )
    ).toBe(true);
  });

  it("rejects non-whitelisted feature work", () => {
    expect(
      isAutoApproved(
        project,
        {
          projectName: "demo-app",
          taskType: "feature",
          scope: "frontend",
          executionMode: "agent",
          description: "add"
        },
        "ou_ok"
      )
    ).toBe(false);
  });
});
