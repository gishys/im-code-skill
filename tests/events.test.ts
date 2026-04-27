import { describe, expect, it } from "vitest";
import { parseFeishuActionEvent } from "../src/feishu/events.js";

describe("parseFeishuActionEvent", () => {
  it("normalizes multi-select form values", () => {
    const event = parseFeishuActionEvent({
      event: {
        open_chat_id: "oc_group",
        open_message_id: "om_form",
        operator: { open_id: "ou_a" },
        action: {
          value: { action: "submit_task_form", draftId: "draft-1" },
          form_value: {
            selectedAssetIds: {
              selected_options: [{ value: "asset-1" }, { value: "asset-2" }]
            }
          }
        }
      }
    });

    expect(event).toEqual(
      expect.objectContaining({
        action: "submit_task_form",
        draftId: "draft-1",
        formValues: expect.objectContaining({
          selectedAssetIds: "asset-1,asset-2"
        })
      })
    );
  });

  it("normalizes JSON array string form values from mobile clients", () => {
    const event = parseFeishuActionEvent({
      event: {
        action: {
          value: { action: "submit_task_form" },
          form_value: {
            projectName: "[\"demo-app\"]",
            executionMode: "[\"plan\"]",
            taskType: "[\"bug\"]",
            scope: "[\"fullstack\"]",
            selectedAssetIds: "[\"asset-1\",\"asset-2\"]"
          }
        }
      }
    });

    expect(event?.formValues).toEqual(
      expect.objectContaining({
        projectName: "demo-app",
        executionMode: "plan",
        taskType: "bug",
        scope: "fullstack",
        selectedAssetIds: "asset-1,asset-2"
      })
    );
  });
});
