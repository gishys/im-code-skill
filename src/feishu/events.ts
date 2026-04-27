import type { InputAsset } from "../types.js";

export interface FeishuMessageEvent {
  eventId?: string;
  chatId?: string;
  messageId?: string;
  userId?: string;
  text: string;
  assets: Array<Pick<InputAsset, "assetType" | "feishuFileKey" | "fileName" | "mimeType">>;
}

export interface FeishuActionEvent {
  action:
    | "approve"
    | "approve_plan_as_agent"
    | "cancel"
    | "status"
    | "retry"
    | "open_task_form"
    | "submit_task_form"
    | "refresh_task_form_assets"
    | "open_help";
  taskId?: string;
  draftId?: string;
  userId?: string;
  chatId?: string;
  messageId?: string;
  formValues: Record<string, string>;
}

function parseMessageText(content: unknown): string {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.text === "string") {
        return parsed.text;
      }
      if (parsed.file_key || parsed.fileKey || parsed.image_key || parsed.imageKey || parsed.media_key || parsed.mediaKey) {
        return "";
      }
      return content;
    } catch {
      return content;
    }
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return "";
}

export function parseFeishuMessageEvent(body: unknown): FeishuMessageEvent | undefined {
  const root = body as Record<string, unknown>;
  const event = (root.event ?? root) as Record<string, unknown>;
  const message = (event.message ?? {}) as Record<string, unknown>;
  const sender = (event.sender ?? {}) as Record<string, unknown>;
  const senderId = (sender.sender_id ?? {}) as Record<string, unknown>;
  const chatId = (message.chat_id ?? event.open_chat_id) as string | undefined;
  const messageId = (message.message_id ?? event.message_id) as string | undefined;
  const eventId = (root.event_id ?? root.uuid) as string | undefined;
  const userId = (senderId.open_id ?? event.open_id) as string | undefined;
  const text = parseMessageText(message.content ?? event.content);

  if (!text && !messageId) {
    return undefined;
  }

  const assets = extractAssets(message);
  return { eventId, chatId, messageId, userId, text, assets };
}

export function parseFeishuActionEvent(body: unknown): FeishuActionEvent | undefined {
  const root = body as Record<string, unknown>;
  const event = (root.event ?? root) as Record<string, unknown>;
  const action = (event.action ?? root.action ?? {}) as Record<string, unknown>;
  const value = (action.value ?? {}) as Record<string, unknown>;
  const user = (event.operator ?? event.user ?? {}) as Record<string, unknown>;
  const context = (event.context ?? root.context ?? {}) as Record<string, unknown>;
  const userId = (user.open_id ?? user.user_id) as string | undefined;
  const chatId = (event.open_chat_id ?? event.chat_id ?? context.open_chat_id ?? context.chat_id) as string | undefined;
  const messageId = (event.open_message_id ?? event.message_id ?? context.open_message_id ?? context.message_id) as string | undefined;
  const actionName = value.action as FeishuActionEvent["action"] | undefined;
  const taskId = value.taskId as string | undefined;
  const draftId = value.draftId as string | undefined;
  const formValues = normalizeFormValues(action.form_value ?? action.formValue ?? event.form_value ?? root.form_value);

  if (!actionName) {
    return undefined;
  }
  return { action: actionName, taskId, draftId, userId, chatId, messageId, formValues };
}

export function isFeishuCardActionEvent(body: unknown): boolean {
  const root = body as Record<string, unknown>;
  const header = (root.header ?? {}) as Record<string, unknown>;
  return root.type === "card.action.trigger" || header.event_type === "card.action.trigger" || Boolean(parseFeishuActionEvent(body));
}

function normalizeFormValues(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    result[key] = normalizeFormValue(raw);
  }
  return result;
}

function normalizeFormValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(normalizeFormValue).filter(Boolean).join(",");
  }
  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeFormValue).filter(Boolean).join(",");
    }
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const multiValue = record.values ?? record.selected_values ?? record.selectedOptions ?? record.selected_options ?? record.options;
    if (Array.isArray(multiValue)) {
      return multiValue.map(normalizeFormValue).filter(Boolean).join(",");
    }
    const singleValue = record.value ?? record.text ?? record.content;
    if (singleValue && typeof singleValue === "object") {
      return normalizeFormValue(singleValue);
    }
    return String(singleValue ?? "");
  }
  return String(value ?? "");
}

function extractAssets(message: Record<string, unknown>): FeishuMessageEvent["assets"] {
  const directAsset = extractContentAsset(message);
  const files = (message.files ?? message.attachments ?? []) as Array<Record<string, unknown>>;
  const listedAssets = files
    .map((file) => ({
      assetType: normalizeAssetType(String(file.file_type ?? file.type ?? "file")),
      feishuFileKey: String(file.file_key ?? file.fileKey ?? ""),
      fileName: String(file.file_name ?? file.name ?? "attachment"),
      mimeType: file.mime_type ? String(file.mime_type) : null
    }))
    .filter((file) => file.feishuFileKey);
  return directAsset ? [directAsset, ...listedAssets] : listedAssets;
}

function extractContentAsset(message: Record<string, unknown>): FeishuMessageEvent["assets"][number] | undefined {
  const content = parseJsonObject(message.content);
  if (!content || Array.isArray(content)) {
    return undefined;
  }
  const fileKey = content.file_key ?? content.fileKey ?? content.image_key ?? content.imageKey ?? content.media_key ?? content.mediaKey;
  if (!fileKey) {
    return undefined;
  }
  const msgType = String(message.message_type ?? message.msg_type ?? content.file_type ?? content.type ?? "file");
  const assetType = normalizeAssetType(msgType);
  return {
    assetType,
    feishuFileKey: String(fileKey),
    fileName: String(content.file_name ?? content.name ?? `${String(message.message_id ?? "attachment")}-${assetType}`),
    mimeType: content.mime_type ? String(content.mime_type) : null
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> | unknown[] | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAssetType(value: string): "image" | "video" | "file" {
  const normalized = value.toLowerCase();
  if (normalized.includes("image") || normalized.includes("img")) {
    return "image";
  }
  if (normalized.includes("video")) {
    return "video";
  }
  return "file";
}
