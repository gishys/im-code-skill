# Feishu Codex Orchestrator

飞书机器人到 Codex 的前后端自动交付编排服务。它接收飞书需求或 bug，持久化任务，按白名单自动或人工确认后执行 Codex、测试、构建、打包、创建 GitHub PR，并把结果回传飞书。

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

首期默认不需要 Redis，任务队列由 SQLite 承担。生产环境建议把 `data/`、`logs/`、`workspaces/` 挂载为持久化目录。

## 配置文件

主要配置来自 `.env` 和 `projects.yaml`：

- `.env`：服务端口、SQLite 路径、飞书应用、GitHub、Codex、worker 参数。
- `projects.yaml`：项目名称、前端/后端仓库、默认分支、安装/测试/构建命令、产物目录、白名单规则。

`.env.example` 已对每个配置项写了详细注释。实际使用时复制为 `.env` 后填写真实值。

## 有公网 IP/域名

适合生产环境。

1. 准备公网 HTTPS 域名，例如 `https://codex-bot.example.com`。
2. 使用 Nginx、Caddy 或 API Gateway 转发到本服务端口。
3. 飞书事件订阅地址填写：

```text
https://codex-bot.example.com/feishu/events
```

4. 飞书交互卡片请求地址填写：

```text
https://codex-bot.example.com/feishu/actions
```

5. `.env` 中配置：

```env
FEISHU_CONNECTION_MODE=webhook
FEISHU_PUBLIC_BASE_URL=https://codex-bot.example.com
```

## 无公网 IP

可选三种方式。

方式一：内网穿透。

适合本地开发或小团队测试。使用 Cloudflare Tunnel、frp、ngrok 等生成 HTTPS 地址，再把飞书事件订阅地址和交互卡片地址配置到隧道域名。

```env
FEISHU_CONNECTION_MODE=webhook
FEISHU_PUBLIC_BASE_URL=https://your-tunnel-domain
```

方式二：主动轮询。本项目默认使用该模式。

适合完全不能开放入站连接的内网环境。服务主动拉取飞书消息、多维表格或审批记录。

```env
FEISHU_CONNECTION_MODE=polling
FEISHU_PUBLIC_BASE_URL=
FEISHU_POLLING_CHAT_IDS=oc_xxx
FEISHU_POLLING_INTERVAL_SECONDS=10
```

polling 模式下，飞书按钮回调无法直接进入内网服务，因此支持使用文本命令处理审批：

```text
确认执行：task-xxx
取消任务：task-xxx
查看状态：task-xxx
```

服务会把每个 chat 的最后处理消息时间记录到 SQLite 的 `polling_offsets` 表，重启后继续从 offset 之后轮询。

方式三：飞书多维表格/审批。

用户在飞书表格或审批中提交任务，服务定时读取新增记录并创建任务，适合审计流程更强的企业环境。

## Feishu Message Format

推荐方式：在飞书里发送：

```text
表单
```

机器人会返回“填写 Codex 任务表单”卡片。用户在卡片中选择项目、类型、范围，填写描述和附件说明后提交。

文本方式仍然支持：

```text
项目：demo-app
类型：bug
范围：前端
描述：修复登录页按钮点击无响应，并参考附件截图。
```

支持 `前端`、`后端`、`前后端`；支持飞书图片、视频和文件附件作为 AI 输入素材。

附件最佳实践：

- 先把图片、视频、文件直接发送到当前飞书会话。
- 再发送 `表单` 或点击“填写任务表单”。
- 点击表单里的“刷新附件列表”，在“选择附件”多选框中勾选要关联到本任务的附件。
- 在表单的“附件清单与说明”中写清用途。
- 示例：`图1是当前效果，图2是期望效果，视频1是复现路径，日志文件是后端错误日志。`

群聊中只展示同一会话、同一提交人、未被其他任务关联且 2 小时内上传的附件，避免中间插入其他成员消息时误关联。

## Endpoints

- `GET /health`
- `POST /feishu/events`
- `POST /feishu/actions`
- `GET /tasks/:id`

## Repository Cache

Tasks use a shared local cache under `REPO_CACHE_ROOT` and an isolated task
worktree under `WORKSPACE_ROOT/<task-id>`. Before each task starts, the worker
fetches the configured default branch into the cache, then creates a fresh
worktree from `origin/<default_branch>`. Plan-only tasks use a detached worktree;
agent tasks use the task branch, such as `codex/task-...`.

## Verification

```bash
npm run typecheck
npm test
npm run build
```
