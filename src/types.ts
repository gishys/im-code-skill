export type TaskType = "feature" | "bug";
export type TaskScope = "frontend" | "backend" | "fullstack";
export type TaskExecutionMode = "plan" | "agent";

export type TaskStatus =
  | "created"
  | "plan_ready"
  | "waiting_approval"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "interrupted";

export type TaskStage =
  | "received"
  | "approval"
  | "queued"
  | "planning"
  | "cloning"
  | "codex_running"
  | "testing"
  | "building"
  | "packaging"
  | "creating_pr"
  | "uploading"
  | "done"
  | "failed";

export interface RepoConfig {
  repo: string;
  install?: string;
  test?: string;
  build?: string;
  artifact_paths: string[];
}

export interface ProjectConfig {
  name: string;
  default_branch: string;
  frontend?: RepoConfig;
  backend?: RepoConfig;
  package: {
    format: "zip";
    name_template: string;
  };
  auto_approve_rules?: {
    users?: string[];
    task_types?: TaskType[];
    scopes?: Exclude<TaskScope, "fullstack">[];
  };
}

export interface ParsedTaskMessage {
  projectName: string;
  taskType: TaskType;
  scope: TaskScope;
  executionMode: TaskExecutionMode;
  description: string;
}

export interface TaskFormInput extends ParsedTaskMessage {
  attachmentNote?: string;
  selectedAssetIds?: string[];
}

export interface TaskRecord {
  id: string;
  feishuEventId?: string | null;
  feishuChatId?: string | null;
  feishuMessageId?: string | null;
  feishuUserId?: string | null;
  projectName: string;
  taskType: TaskType;
  scope: TaskScope;
  executionMode: TaskExecutionMode;
  rawText: string;
  parsedDescription: string;
  status: TaskStatus;
  approvalStatus: "auto_approved" | "pending" | "approved" | "rejected";
  autoApproved: boolean;
  currentStage: TaskStage;
  failureStage?: string | null;
  failureSummary?: string | null;
  workspacePath?: string | null;
  artifactPath?: string | null;
  artifactFileKey?: string | null;
  planSummary?: string | null;
  planArtifactPath?: string | null;
  inputAssetsJson?: string | null;
  streamMessageId?: string | null;
  githubPrUrl?: string | null;
  githubBranch?: string | null;
  githubCommitSha?: string | null;
  lockedBy?: string | null;
  lockedAt?: string | null;
  heartbeatAt?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export type InputAssetType = "image" | "video" | "file";

export interface InputAsset {
  id: string;
  taskId: string;
  assetType: InputAssetType;
  feishuFileKey: string;
  fileName: string;
  mimeType?: string | null;
  localPath?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
}

export interface TaskDraft {
  id: string;
  feishuChatId: string;
  feishuUserId: string;
  sourceMessageId?: string | null;
  formMessageId?: string | null;
  status: "active" | "submitted" | "expired";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface PendingInputAsset {
  id: string;
  draftId?: string | null;
  feishuChatId: string;
  feishuUserId: string;
  feishuMessageId?: string | null;
  assetType: InputAssetType;
  feishuFileKey: string;
  fileName: string;
  mimeType?: string | null;
  status: "pending" | "linked" | "expired";
  linkedTaskId?: string | null;
  linkedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  label?: string;
}
