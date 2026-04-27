import { loadDotenv } from "./config/dotenv.js";
import { loadEnv } from "./config/env.js";
import { loadProjectsConfig } from "./config/projects.js";
import { DbClient } from "./db/client.js";
import { FeishuClient } from "./feishu/client.js";
import { AssetService } from "./inputs/asset-service.js";
import { PollingStateStore } from "./feishu/polling-state.js";
import { FeishuPoller } from "./feishu/poller.js";
import { TaskService } from "./task/service.js";
import { TaskIngestionService } from "./task/ingestion.js";
import { SqliteQueue } from "./worker/sqlite-queue.js";
import { TaskRunner } from "./worker/task-runner.js";
import { createApp } from "./app.js";

loadDotenv();
const env = loadEnv();
const projects = loadProjectsConfig(env.PROJECTS_CONFIG_PATH);
const db = new DbClient(env.DATABASE_PATH);
const tasks = new TaskService(db.db);
const feishu = new FeishuClient(env);
const assets = new AssetService(db.db, feishu);
const app = createApp({ env, projects, tasks, feishu, assets });
const ingestion = new TaskIngestionService(projects, tasks, feishu, assets, env.WORKSPACE_ROOT);

console.log(
  JSON.stringify({
    service: "feishu-codex-orchestrator",
    port: env.PORT,
    feishuConnectionMode: env.FEISHU_CONNECTION_MODE,
    feishuEventsUrl: env.FEISHU_PUBLIC_BASE_URL ? `${env.FEISHU_PUBLIC_BASE_URL}/feishu/events` : null,
    feishuActionsUrl: env.FEISHU_PUBLIC_BASE_URL ? `${env.FEISHU_PUBLIC_BASE_URL}/feishu/actions` : null
  })
);

if (env.FEISHU_CONNECTION_MODE === "polling") {
  const pollingState = new PollingStateStore(db.db);
  const poller = new FeishuPoller(env, feishu, pollingState, ingestion, tasks);
  poller.start();
}

if (env.WORKER_ENABLED) {
  const queue = new SqliteQueue(db.db);
  const runner = new TaskRunner(env, projects, tasks, feishu);
  queue.recoverInterrupted(env.TASK_LOCK_TIMEOUT_SECONDS);
  startWorkerLoop(queue, runner);
}

await app.listen({ host: env.HOST, port: env.PORT });

function startWorkerLoop(queue: SqliteQueue, runner: TaskRunner): void {
  let active = 0;
  setInterval(() => {
    while (active < env.WORKER_CONCURRENCY) {
      const task = queue.claimNext(env.WORKER_ID, env.TASK_LOCK_TIMEOUT_SECONDS);
      if (!task) {
        break;
      }
      active += 1;
      runner
        .run(task)
        .catch((error) => {
          tasks.markFailed(task.id, "worker", error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          active -= 1;
        });
    }
  }, 1000);
}
