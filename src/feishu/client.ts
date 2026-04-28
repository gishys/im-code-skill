import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AppEnv } from "../config/env.js";

interface TenantAccessToken {
  token: string;
  expiresAt: number;
}

export interface FeishuPolledMessage {
  messageId: string;
  chatId: string;
  senderId?: string;
  createTime: string;
  msgType: string;
  content: unknown;
  raw: Record<string, unknown>;
}

export class FeishuClient {
  private tenantToken?: TenantAccessToken;

  constructor(private readonly env: AppEnv) {}

  async sendText(chatId: string, text: string): Promise<string | undefined> {
    return this.sendMessage(chatId, "text", { text });
  }

  async sendTaskCard(chatId: string, card: object): Promise<string | undefined> {
    return this.sendMessage(chatId, "interactive", card);
  }

  async updateTaskCard(messageId: string, card: object): Promise<void> {
    const token = await this.getTenantAccessToken();
    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ content: JSON.stringify(card) })
    }).then((response) => this.assertFeishuOk(response, "update message card"));
  }

  async uploadFile(filePath: string): Promise<string | undefined> {
    const token = await this.getTenantAccessToken();
    const form = new FormData();
    const file = await import("node:fs/promises").then((fs) => fs.readFile(filePath));
    form.append("file_type", "stream");
    form.append("file_name", basename(filePath));
    form.append("file", new Blob([file]), basename(filePath));
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form
    });
    const json = (await this.parseFeishuJson(response, "upload file")) as { data?: { file_key?: string } };
    return json.data?.file_key;
  }

  async sendFile(chatId: string, fileKey: string): Promise<string | undefined> {
    return this.sendMessage(chatId, "file", { file_key: fileKey });
  }

  async downloadFile(fileKey: string, destination: string): Promise<string> {
    const token = await this.getTenantAccessToken();

    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/files/${encodeURIComponent(fileKey)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(await this.formatFeishuDownloadError(response, `download Feishu file ${fileKey}`));
    }
    if (!response.body) {
      throw new Error(`Feishu download Feishu file ${fileKey} failed: HTTP ${response.status}, empty response body`);
    }

    await writeResponseBody(response, destination);
    return destination;
  }

  async downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    resourceType: "image" | "file" | "video";
    destination: string;
  }): Promise<string> {
    const token = await this.getTenantAccessToken();
    const resourceType = input.resourceType === "image" ? "image" : "file";
    const search = new URLSearchParams({ type: resourceType });
    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(input.messageId)}/resources/${encodeURIComponent(input.fileKey)}?${search.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );
    if (!response.ok) {
      throw new Error(await this.formatFeishuDownloadError(response, `download Feishu ${input.resourceType} ${input.fileKey}`));
    }
    if (!response.body) {
      throw new Error(`Feishu download Feishu ${input.resourceType} ${input.fileKey} failed: HTTP ${response.status}, empty response body`);
    }

    await writeResponseBody(response, input.destination);
    return input.destination;
  }

  async listChatMessages(input: {
    chatId: string;
    startTime: string;
    endTime: string;
    pageSize: number;
  }): Promise<FeishuPolledMessage[]> {
    const token = await this.getTenantAccessToken();

    const search = new URLSearchParams({
      container_id_type: "chat",
      container_id: input.chatId,
      start_time: input.startTime,
      end_time: input.endTime,
      page_size: String(input.pageSize)
    });
    const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?${search.toString()}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Failed to poll Feishu messages: ${response.status}`);
    }

    const json = (await response.json()) as { data?: { items?: Array<Record<string, unknown>> } };
    return (json.data?.items ?? []).map((item) => {
      const sender = (item.sender ?? {}) as Record<string, unknown>;
      const senderId = (sender.id ?? sender.sender_id ?? {}) as Record<string, unknown>;
      const body = (item.body ?? {}) as Record<string, unknown>;
      return {
        messageId: String(item.message_id ?? ""),
        chatId: String(item.chat_id ?? input.chatId),
        senderId: (senderId.open_id ?? senderId.user_id) as string | undefined,
        createTime: String(item.create_time ?? "0"),
        msgType: String(item.msg_type ?? ""),
        content: body.content ?? item.content,
        raw: item
      };
    });
  }

  private async sendMessage(chatId: string, msgType: string, content: object): Promise<string | undefined> {
    const token = await this.getTenantAccessToken();
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content)
      })
    });
    const json = (await this.parseFeishuJson(response, `send ${msgType} message`)) as { data?: { message_id?: string } };
    return json.data?.message_id;
  }

  private async getTenantAccessToken(): Promise<string> {
    if (!this.env.FEISHU_APP_ID || !this.env.FEISHU_APP_SECRET) {
      throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are required");
    }
    if (this.tenantToken && this.tenantToken.expiresAt > Date.now() + 60_000) {
      return this.tenantToken.token;
    }
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this.env.FEISHU_APP_ID,
        app_secret: this.env.FEISHU_APP_SECRET
      })
    });
    const json = (await this.parseFeishuJson(response, "get tenant access token")) as { tenant_access_token?: string; expire?: number };
    if (!json.tenant_access_token) {
      throw new Error("Feishu tenant_access_token is missing in auth response");
    }
    this.tenantToken = {
      token: json.tenant_access_token,
      expiresAt: Date.now() + (json.expire ?? 7200) * 1000
    };
    return this.tenantToken.token;
  }

  private async assertFeishuOk(response: Response, action: string): Promise<void> {
    await this.parseFeishuJson(response, action);
  }

  private async parseFeishuJson(response: Response, action: string): Promise<unknown> {
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`Feishu ${action} failed: HTTP ${response.status}, non-JSON response: ${text.slice(0, 500)}`);
    }

    const code = Number(json.code ?? 0);
    if (!response.ok || code !== 0) {
      throw new Error(`Feishu ${action} failed: HTTP ${response.status}, code=${json.code}, msg=${formatLogMessage(json.msg ?? json.message)}`);
    }
    return json;
  }

  private async formatFeishuDownloadError(response: Response, action: string): Promise<string> {
    const text = await response.text();
    let json: Record<string, unknown> | undefined;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    } catch {
      return `Feishu ${action} failed: HTTP ${response.status}, non-JSON response: ${text.slice(0, 500)}`;
    }

    if (Number(json?.code) === 99991672) {
      return [
        `Feishu ${action} failed: 飞书应用缺少消息资源读取权限 (app is missing message resource permission)`,
        "请在飞书开放平台 -> 权限管理中开通任一权限 [im:message.history:readonly, im:message:readonly, im:message]",
        "保存后重新发布应用版本，并在企业管理后台/授权页面重新授权该应用，否则 tenant_access_token 仍不包含新权限",
        `HTTP ${response.status}, code=${json?.code}, msg=${formatLogMessage(json?.msg ?? json?.message)}`
      ].join("; ");
      return [
        `Feishu ${action} failed: 飞书应用缺少消息资源读取权限 (app is missing message resource permission)`,
        "请在飞书开放平台开通任一权限 [im:message.history:readonly, im:message:readonly, im:message] 后重新发布/授权",
        `HTTP ${response.status}, code=${json?.code}, msg=${formatLogMessage(json?.msg ?? json?.message)}`
      ].join("; ");
    }

    return `Feishu ${action} failed: HTTP ${response.status}, code=${json?.code}, msg=${formatLogMessage(json?.msg ?? json?.message)}`;
  }
}

async function writeResponseBody(response: Response, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const stream = createWriteStream(destination);
  await response.body!.pipeTo(
    new WritableStream({
      write(chunk) {
        stream.write(chunk);
      },
      close() {
        stream.close();
      },
      abort(reason) {
        stream.destroy(reason);
      }
    })
  );
}

function formatLogMessage(value: unknown): string {
  const text = String(value ?? "");
  if (!text) {
    return "";
  }

  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  const ascii = text
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = ascii.length > 0 ? ascii : "[non-ascii Feishu message omitted]";
  return urls.length > 0 ? `${cleaned} urls=${urls.join(",")}` : cleaned;
}

export function localInputPath(root: string, taskId: string, fileName: string): string {
  return join(root, taskId, "inputs", fileName);
}
