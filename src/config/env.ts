import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  },
  z.string().optional()
);

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  INTERNAL_API_TOKEN: optionalNonEmptyString,
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
  FEISHU_APP_ID: optionalNonEmptyString,
  FEISHU_APP_SECRET: optionalNonEmptyString,
  FEISHU_VERIFICATION_TOKEN: optionalNonEmptyString,
  FEISHU_ENCRYPT_KEY: optionalNonEmptyString,
  FEISHU_PUBLIC_BASE_URL: optionalNonEmptyString,
  FEISHU_ALLOWED_CHAT_IDS: z.string().default(""),
  FEISHU_POLLING_CHAT_IDS: z.string().default(""),
  FEISHU_POLLING_INTERVAL_SECONDS: z.coerce.number().int().positive().default(10),
  FEISHU_POLLING_LOOKBACK_SECONDS: z.coerce.number().int().positive().default(300),
  FEISHU_POLLING_PAGE_SIZE: z.coerce.number().int().positive().max(50).default(20),
  FEISHU_PROGRESS_STREAM_ENABLED: z.coerce.boolean().default(true),
  FEISHU_PROGRESS_MIN_INTERVAL_SECONDS: z.coerce.number().int().positive().default(5),
  GITHUB_TOKEN: optionalNonEmptyString,
  GITHUB_OWNER: optionalNonEmptyString,
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  CONFIG_COMMAND_ALLOWLIST: z.string().default("npm,npm.cmd,pnpm,yarn,yarn.cmd,corepack"),
  CODEX_COMMAND: z.string().default("codex"),
  CODEX_PROXY_URL: optionalNonEmptyString,
  CODEX_SANDBOX_MODE: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
  CODEX_BYPASS_APPROVALS_AND_SANDBOX: z.coerce.boolean().default(false),
  CODEX_JSON_EVENTS_ENABLED: z.coerce.boolean().default(true),
  CODEX_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(1800),
  CODEX_STARTUP_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  CODEX_HISTORY_ENABLED: z.coerce.boolean().default(true),
  CODEX_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(24000)
}).superRefine((env, context) => {
  if (env.NODE_ENV !== "production") {
    return;
  }
  const requiredProductionKeys: Array<keyof typeof env> = [
    "FEISHU_VERIFICATION_TOKEN",
    "FEISHU_ENCRYPT_KEY",
    "FEISHU_ALLOWED_CHAT_IDS",
    "INTERNAL_API_TOKEN"
  ];
  for (const key of requiredProductionKeys) {
    if (!env[key]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} is required when NODE_ENV=production`
      });
    }
  }
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source = process.env): AppEnv {
  return envSchema.parse(source);
}
