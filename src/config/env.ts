import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  INTERNAL_API_TOKEN: z.string().optional(),
  REQUEST_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  DATABASE_PATH: z.string().default("./data/orchestrator.sqlite"),
  PROJECTS_CONFIG_PATH: z.string().default("./projects.yaml"),
  WORKSPACE_ROOT: z.string().default("./workspaces"),
  REPO_CACHE_ROOT: z.string().default("./repo-cache"),
  LOG_ROOT: z.string().default("./logs"),
  WORKER_ENABLED: z.coerce.boolean().default(true),
  WORKER_ID: z.string().default("local-worker"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  TASK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(3600),
  TASK_HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(15),
  TASK_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
  FEISHU_CONNECTION_MODE: z.enum(["webhook", "polling"]).default("polling"),
  FEISHU_APP_ID: z.string().optional(),
  FEISHU_APP_SECRET: z.string().optional(),
  FEISHU_VERIFICATION_TOKEN: z.string().optional(),
  FEISHU_ENCRYPT_KEY: z.string().optional(),
  FEISHU_PUBLIC_BASE_URL: z.string().optional(),
  FEISHU_ALLOWED_CHAT_IDS: z.string().default(""),
  FEISHU_POLLING_CHAT_IDS: z.string().default(""),
  FEISHU_POLLING_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  FEISHU_POLLING_LOOKBACK_SECONDS: z.coerce.number().int().positive().default(300),
  FEISHU_POLLING_PAGE_SIZE: z.coerce.number().int().positive().max(50).default(20),
  FEISHU_PROGRESS_STREAM_ENABLED: z.coerce.boolean().default(true),
  FEISHU_PROGRESS_MIN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_OWNER: z.string().optional(),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  CONFIG_COMMAND_ALLOWLIST: z.string().default("npm,npm.cmd,pnpm,yarn,yarn.cmd,corepack"),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  CODEX_HISTORY_ENABLED: z.coerce.boolean().default(true),
  CODEX_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(24000)
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source = process.env): AppEnv {
  return envSchema.parse(source);
}
