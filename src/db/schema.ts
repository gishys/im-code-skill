export const schemaSql = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  feishu_event_id TEXT UNIQUE,
  feishu_chat_id TEXT,
  feishu_message_id TEXT,
  feishu_user_id TEXT,
  project_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'agent',
  raw_text TEXT NOT NULL,
  parsed_description TEXT NOT NULL,
  status TEXT NOT NULL,
  approval_status TEXT NOT NULL,
  auto_approved INTEGER NOT NULL DEFAULT 0,
  current_stage TEXT NOT NULL,
  failure_stage TEXT,
  failure_summary TEXT,
  workspace_path TEXT,
  artifact_path TEXT,
  artifact_file_key TEXT,
  plan_summary TEXT,
  plan_artifact_path TEXT,
  input_assets_json TEXT,
  stream_message_id TEXT,
  github_pr_url TEXT,
  github_branch TEXT,
  github_commit_sha TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_lock ON tasks(status, locked_at);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  stage TEXT,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  log_path TEXT NOT NULL,
  tail_excerpt TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  feishu_user_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  local_path TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  feishu_file_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS input_assets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL,
  feishu_file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  local_path TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_drafts (
  id TEXT PRIMARY KEY,
  feishu_chat_id TEXT NOT NULL,
  feishu_user_id TEXT NOT NULL,
  source_message_id TEXT,
  form_message_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_drafts_lookup
  ON task_drafts(feishu_chat_id, feishu_user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS pending_input_assets (
  id TEXT PRIMARY KEY,
  draft_id TEXT REFERENCES task_drafts(id) ON DELETE SET NULL,
  feishu_chat_id TEXT NOT NULL,
  feishu_user_id TEXT NOT NULL,
  feishu_message_id TEXT,
  asset_type TEXT NOT NULL,
  feishu_file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  status TEXT NOT NULL,
  linked_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  linked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(feishu_message_id, feishu_file_key)
);

CREATE INDEX IF NOT EXISTS idx_pending_input_assets_candidates
  ON pending_input_assets(feishu_chat_id, feishu_user_id, status, created_at);

CREATE TABLE IF NOT EXISTS polling_offsets (
  source_key TEXT PRIMARY KEY,
  last_message_time TEXT NOT NULL,
  last_message_id TEXT,
  updated_at TEXT NOT NULL
);
`;
