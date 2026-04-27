# 飞书 × Codex 前后端自动交付编排项目完整方案

## 1. 目标概述

本项目新建一个独立编排服务，作为飞书机器人、GitHub、Codex、前后端仓库和构建产物之间的自动化中枢。

用户在飞书里提交需求或 bug，机器人解析任务并生成执行计划。任务命中白名单时自动执行，否则需要用户在飞书交互卡片中确认。执行完成后，系统会创建 GitHub PR，并将部署包、PR 链接、测试结果和日志摘要回传到飞书原会话。

首期默认约束：

- 飞书入口使用机器人消息和交互卡片。
- 前端和后端是两个独立 GitHub 仓库。
- 自动执行策略为“仅白名单自动”。
- 部署包首期直接上传为飞书文件。
- 项目配置使用 YAML 文件维护。
- 任务状态和执行数据使用 SQLite 持久化。

## 2. 推荐技术栈

### 2.1 后端服务

推荐使用 Node.js + TypeScript + Fastify。

- Runtime：Node.js 20 LTS 或更新 LTS。
- 语言：TypeScript。
- Web 框架：Fastify。
- 配置校验：Zod。
- YAML 解析：yaml。
- 日志：Pino。
- 队列：首期不使用 Redis，采用 SQLite-backed lightweight queue；后续高并发时再可选迁移 BullMQ + Redis。
- 数据库：SQLite。
- ORM/查询层：Drizzle ORM 或 Prisma。
- 命令执行：execa。
- 压缩打包：archiver。
- Git 操作：优先调用 `git` CLI，GitHub PR 使用 Octokit。
- 测试框架：Vitest，外加通用测试编排器，用于根据前端/后端项目类型自动发现并执行已有测试命令。

选择理由：

- TypeScript 适合做飞书、GitHub、Codex 等多系统集成，类型约束能减少协议拼接错误。
- Fastify 轻量、性能好，适合 Webhook 和内部 API。
- Pino 日志结构化好，方便按任务 ID 追踪。
- SQLite 部署简单，非常适合单机编排服务首版。
- 首期不引入 Redis，可以显著降低安装、配置、运维和本地调试复杂度。

### 2.1.1 队列选型：首期不使用 Redis

首期可以不使用 Redis。

推荐实现 SQLite-backed lightweight queue：

- 使用 `tasks.status` 作为任务状态机。
- 使用 `tasks.locked_by`、`tasks.locked_at`、`tasks.heartbeat_at` 控制 worker 领取任务。
- Worker 通过事务领取 `queued` 任务，将其更新为 `running`。
- 服务启动时扫描超时 `running` 任务，将其标记为 `interrupted` 或重新入队。
- 单机部署时限制 worker 并发，例如默认 `WORKER_CONCURRENCY=1` 或 `2`。

适用场景：

- 单机部署。
- 任务量不高到中等。
- 希望减少 Redis 安装和配置。
- 可以接受简单队列语义，不需要复杂延迟队列、优先级队列和分布式 worker。

未来迁移 Redis 的触发条件：

- 多实例部署。
- worker 并发明显增加。
- 需要任务优先级、延迟重试、分布式锁或更强的队列观测能力。
- SQLite 锁等待成为瓶颈。

### 2.2 飞书集成

推荐使用飞书开放平台 HTTP API + 官方事件回调协议。

需要实现：

- 事件订阅回调接收。
- URL verification 处理。
- Encrypt Key 解密处理。
- Verification Token 校验。
- 机器人消息解析。
- 交互卡片发送与按钮回调处理。
- 文件上传和文件消息发送。

建议封装为 `FeishuClient`：

- `sendText(chatId, text)`
- `sendTaskCard(task)`
- `updateTaskCard(task)`
- `uploadFile(filePath)`
- `sendFile(chatId, fileKey)`

### 2.2.1 飞书连接方式：有公网 IP 与无公网 IP

飞书事件回调通常要求飞书开放平台能够访问服务地址。因此需要同时支持两种部署形态。

#### 方式 A：有公网 IP 或公网域名

推荐生产使用。

架构：

```text
Feishu Open Platform
  -> HTTPS domain
  -> Nginx/Caddy/API Gateway
  -> Orchestrator Service
  -> SQLite + workspace
```

要求：

- 服务具备公网 HTTPS 域名。
- 使用 Nginx、Caddy 或云厂商 API Gateway 终止 TLS。
- 飞书事件订阅地址配置为公网 HTTPS URL。
- 严格校验 Verification Token、Encrypt Key 和请求签名。
- 使用防火墙、WAF 或反向代理限流保护入口。

优点：

- 稳定、正式、符合飞书事件回调模型。
- 适合长期生产运行。

缺点：

- 需要域名、证书、公网入口和基础运维。

#### 方式 B：没有公网 IP

可用于本地开发、内网部署或没有公网资源的场景。

推荐三种方案，按优先级选择：

1. 内网穿透隧道
   - 使用 Cloudflare Tunnel、frp、ngrok、花生壳等工具暴露临时 HTTPS 地址。
   - 飞书事件订阅配置到隧道地址。
   - 适合开发、测试、小团队内网服务。

2. 主动轮询模式
   - 不使用飞书事件订阅。
   - 服务定时调用飞书 API 拉取指定群、机器人会话或工单来源的新消息。
   - 适合无法开放入站连接的环境。
   - 缺点是实时性较弱，并且受飞书 API 权限和频率限制影响。

3. 飞书多维表格/审批作为任务入口
   - 用户在飞书表格或审批中提交任务。
   - 编排服务定时拉取新增记录。
   - 适合企业内网、审计要求强、网络入口受限的场景。

首期建议：

- 生产默认实现“有公网 IP/域名”的 Webhook 模式。
- 同时保留 polling adapter 接口，便于无公网 IP 时切换为主动轮询。
- 本地开发可使用 Cloudflare Tunnel 或 frp。

配置示例：

```yaml
feishu:
  connection_mode: webhook # webhook | polling
  public_base_url: https://codex-bot.example.com
  polling:
    enabled: false
    interval_seconds: 10
```

### 2.3 GitHub 集成

推荐使用 Git CLI + Octokit。

- Git CLI 负责 clone、checkout、branch、commit、diff、push。
- Octokit 负责创建 PR、查询 PR 状态、追加评论。

认证方式：

- 首期可使用 GitHub Personal Access Token。
- 生产推荐 GitHub App，权限更细、审计更清晰。

### 2.4 Codex 执行集成

推荐首期通过 Codex CLI 作为外部命令执行。

Worker 为每个任务创建独立 workspace：

```text
workspaces/
  task-20260427-xxxx/
    frontend/
    backend/
    artifacts/
    logs/
```

Codex 执行时输入：

- 用户原始需求。
- 系统生成的执行计划。
- 项目配置。
- 目标仓库路径。
- 输出约束，例如必须运行测试、必须给出变更摘要。

需要做超时、日志捕获、退出码判断和失败摘要提取。

### 2.5 构建与部署包

构建命令来自 `projects.yaml`。

每个项目可配置：

- install 命令。
- test 命令。
- build 命令。
- artifact 路径。
- package 名称模板。

部署包命名建议：

```text
{project}-{scope}-{taskId}-{gitShortSha}-{timestamp}.zip
```

### 2.6 管理与运维

首期推荐：

- `.env` 管理密钥。
- `projects.yaml` 管理项目。
- Docker Compose 启动服务。
- SQLite 文件挂载到持久化目录。
- 日志按任务 ID 写入文件，同时输出结构化控制台日志。

后续可扩展：

- 管理后台。
- 多租户项目配置。
- 对象存储。
- Kubernetes worker 池。
- GitHub App 替代 token。

## 3. 是否需要 SQLite 持久化

需要。

原因是该系统不是简单的同步 webhook，而是一个长流程编排系统。它会产生大量中间状态和可追踪数据，包括：

- 飞书消息事件。
- 任务创建记录。
- 用户确认/取消/重试操作。
- 白名单命中结果。
- Codex 执行状态。
- Git 分支、commit、PR 链接。
- 测试结果。
- 构建结果。
- 部署包路径和飞书 file key。
- 失败阶段和错误摘要。
- 任务日志索引。

如果只放内存，服务重启后会丢失任务状态，飞书按钮回调也无法稳定恢复上下文。因此首期应使用 SQLite 做持久化。

SQLite 适用边界：

- 单机部署。
- 并发任务量不高到中等。
- 数据主要是任务状态和审计记录。
- 希望部署简单，不想引入完整数据库运维。

后续迁移边界：

- 多实例同时写入。
- 大量并发任务。
- 需要复杂查询、报表和权限后台。
- 需要高可用数据库。

当出现上述情况时，可迁移到 PostgreSQL。

## 4. SQLite 数据模型建议

### 4.1 tasks

任务主表。

字段建议：

- `id`
- `feishu_event_id`
- `feishu_chat_id`
- `feishu_message_id`
- `feishu_user_id`
- `project_name`
- `task_type`
- `scope`
- `raw_text`
- `parsed_description`
- `status`
- `approval_status`
- `auto_approved`
- `current_stage`
- `failure_stage`
- `failure_summary`
- `workspace_path`
- `artifact_path`
- `artifact_file_key`
- `input_assets_json`
- `stream_message_id`
- `github_pr_url`
- `github_branch`
- `github_commit_sha`
- `created_at`
- `updated_at`
- `started_at`
- `finished_at`

### 4.2 task_events

任务事件流水。

字段建议：

- `id`
- `task_id`
- `event_type`
- `stage`
- `message`
- `metadata_json`
- `created_at`

用途：

- 记录状态变化。
- 支持飞书“查看状态”。
- 支持失败排查和审计。

### 4.3 task_logs

日志索引表。

字段建议：

- `id`
- `task_id`
- `stage`
- `log_path`
- `tail_excerpt`
- `created_at`

大日志不建议直接塞进 SQLite，建议写文件，数据库只保存索引和摘要。

### 4.4 approvals

审批记录表。

字段建议：

- `id`
- `task_id`
- `action`
- `feishu_user_id`
- `reason`
- `created_at`

### 4.5 artifacts

部署包记录表。

字段建议：

- `id`
- `task_id`
- `name`
- `local_path`
- `size_bytes`
- `sha256`
- `feishu_file_key`
- `created_at`

### 4.6 input_assets

用户输入附件表，用于记录飞书消息中的图片、视频和其他文件。

字段建议：

- `id`
- `task_id`
- `asset_type`
- `feishu_file_key`
- `file_name`
- `mime_type`
- `local_path`
- `size_bytes`
- `sha256`
- `created_at`

用途：

- 保存图片、视频等 AI 输入素材。
- 记录下载后的本地路径。
- 为 Codex prompt 提供附件清单和上下文说明。
- 支持后续审计和问题复现。

## 5. 项目配置文件建议

`projects.yaml` 示例：

```yaml
projects:
  - name: demo-app
    default_branch: main
    frontend:
      repo: git@github.com:example/demo-frontend.git
      install: npm ci
      test: npm test
      build: npm run build
      artifact_paths:
        - dist
    backend:
      repo: git@github.com:example/demo-backend.git
      install: npm ci
      test: npm test
      build: npm run build
      artifact_paths:
        - dist
    package:
      format: zip
      name_template: "{project}-{scope}-{taskId}-{timestamp}.zip"
    auto_approve_rules:
      users:
        - ou_xxx
      task_types:
        - bug
      scopes:
        - frontend
        - backend
```

配置加载时必须做校验：

- 项目名唯一。
- repo 必填。
- scope 与仓库配置匹配。
- 命令不能为空。
- artifact_paths 必须配置。
- 白名单规则必须显式配置，不能默认全部自动执行。

## 6. 核心任务流程

### 6.1 飞书消息进入

1. 校验飞书 token 和签名。
2. 解密事件。
3. 去重处理 `event_id`。
4. 解析消息文本。
5. 识别并下载图片、视频和文件附件。
6. 匹配项目配置。
7. 创建 task 记录和 input_assets 记录。
8. 回复任务理解卡片。

### 6.2 审批判断

1. 根据项目、用户、任务类型、范围判断是否命中白名单。
2. 命中白名单则进入 queued。
3. 未命中白名单则进入 waiting_approval。
4. 用户点击“确认执行”后进入 queued。
5. 用户点击“取消任务”后进入 canceled。

### 6.3 Worker 执行

1. 从队列取任务。
2. 创建隔离 workspace。
3. clone 前端/后端目标仓库。
4. 创建任务分支。
5. 准备文本、图片、视频等输入上下文。
6. 调用 Codex 修改代码。
7. 运行通用测试编排器。
8. 运行构建。
9. 收集产物并压缩。
10. 提交代码并 push。
11. 创建 GitHub PR。
12. 上传部署包到飞书。
13. 回传最终卡片。

### 6.5 流式进度更新

飞书消息可以增加“近实时”的流式体验，但实现方式不是标准 SSE 直连用户，而是服务端持续更新同一张飞书任务卡片，必要时追加阶段性消息。

推荐策略：

- 任务创建后发送一张任务卡片，保存 `stream_message_id`。
- Worker 每进入一个阶段就更新卡片，例如 queued、cloning、codex_running、testing、building、packaging、creating_pr、uploading、done。
- Codex 执行期间定期汇总 stdout/stderr 的新增摘要，每 3 到 10 秒更新一次卡片。
- 为避免触发飞书频率限制，卡片更新需要节流和合并。
- 关键节点可额外发送消息，例如“测试失败”“部署包已上传”。

卡片内容建议：

- 当前阶段。
- 已耗时。
- 最近日志摘要。
- Codex 当前动作摘要。
- 测试/构建状态。
- PR 链接。
- 部署包状态。

配置示例：

```yaml
progress_stream:
  enabled: true
  min_update_interval_seconds: 5
  max_log_excerpt_chars: 1200
```

### 6.6 图片和视频输入

飞书消息应支持图片和视频作为 AI 输入。

处理流程：

1. 从飞书事件中识别图片、视频或文件消息。
2. 使用飞书文件 API 下载附件。
3. 写入任务 workspace 的 `inputs/` 目录。
4. 在 `input_assets` 表中记录 file key、类型、大小、hash 和本地路径。
5. 将附件清单、用户文本描述、项目上下文一起传给 Codex。

AI 使用方式：

- 图片：可用于 UI bug 截图、设计稿、报错截图、页面效果对比。
- 视频：可用于复现交互 bug、理解操作路径、观察动画或页面状态变化。
- 其他文件：可用于需求文档、接口说明、日志文件。

实现注意：

- 限制单个附件和总附件大小。
- 视频可先提取关键帧和基础元信息，再交给 AI 分析。
- 对图片和视频文件做 hash，避免重复下载。
- 附件路径必须只在任务 workspace 内。
- prompt 中必须明确附件用途，例如“这些图片是用户提供的 bug 截图”。

### 6.4 失败处理

任何阶段失败都要：

1. 更新 `tasks.status = failed`。
2. 写入 `failure_stage`。
3. 写入 `failure_summary`。
4. 保存日志摘要。
5. 飞书回传失败卡片。
6. 保留 workspace 供排查。

## 7. 关键技术问题与解决方案

### 7.1 飞书事件重复投递

问题：

飞书事件可能重复投递，同一条消息可能创建多个任务。

解决：

- 使用 `feishu_event_id` 或 `message_id` 做唯一约束。
- 收到重复事件时直接返回成功，不重复创建任务。

### 7.2 飞书回调安全

问题：

Webhook 暴露公网后可能被伪造调用；无公网 IP 时又无法直接接收飞书事件。

解决：

- 校验 Verification Token。
- 支持 Encrypt Key 解密。
- 校验飞书请求签名。
- 所有按钮回调必须校验任务和用户权限。
- 有公网 IP/域名时使用 HTTPS Webhook、反向代理限流和入口审计。
- 无公网 IP 时使用 Cloudflare Tunnel/frp/ngrok 等隧道，或切换为主动轮询飞书消息/多维表格记录。

### 7.3 长任务无法同步响应

问题：

Codex 修改、测试、构建可能耗时数分钟到数十分钟，不能阻塞飞书 HTTP 回调。

解决：

- Webhook 只创建任务并快速返回。
- 后台 worker 异步执行。
- 飞书通过卡片更新和消息通知进度。
- 对卡片更新做节流，模拟流式体验，避免高频更新触发飞书接口限制。

### 7.4 Codex 执行不可控

问题：

Codex 修改代码可能失败、超时、没有运行测试，或修改范围过大。

解决：

- 每个任务独立 workspace。
- 使用超时控制。
- 捕获 stdout/stderr。
- 在 prompt 中明确限制修改范围和验收要求。
- 将用户上传的图片、视频、文档整理为附件上下文，明确输入含义和期望输出。
- 执行后检查 git diff。
- 若没有代码变化或变化超范围，标记失败并回传。

### 7.4.1 多模态输入处理

问题：

用户可能通过飞书发送截图、录屏、设计稿或日志文件。如果只读取文本，会丢失关键信息。

解决：

- 支持飞书图片、视频和文件消息。
- 下载附件到任务 workspace 的 `inputs/` 目录。
- 图片直接作为 AI 上下文输入。
- 视频先保存原文件，并可提取关键帧、时长、分辨率等元信息。
- prompt 中列出附件路径、类型和用户描述。
- 限制大小、数量和可接受 MIME 类型。

### 7.4.2 通用测试框架

问题：

AI 生成代码的质量不稳定。不同前端/后端仓库的测试技术栈不同，如果只写死某一种测试命令，泛化能力不足。

解决：

实现一个通用测试编排器，而不是绑定单一测试框架。

测试编排器职责：

- 优先执行 `projects.yaml` 中显式配置的测试命令。
- 如果未配置，则根据项目文件自动发现测试生态。
- 识别前端项目：package.json、vite、next、react、vue、angular、playwright、cypress。
- 识别后端项目：package.json、pom.xml、build.gradle、go.mod、pyproject.toml、requirements.txt、Cargo.toml。
- 先执行低成本检查，再执行完整测试。
- 收集退出码、日志摘要、测试报告路径和覆盖率文件。

推荐测试层次：

- Static check：类型检查、lint、格式检查，只读执行，不自动改文件。
- Unit test：单元测试。
- Integration smoke：服务启动、健康检查、关键接口 smoke test。
- Build verification：构建命令和产物存在性校验。
- Optional e2e：Playwright/Cypress 等端到端测试，按项目配置启用。

通用命令发现规则：

- Node.js：优先 `npm test`、`npm run test`、`npm run typecheck`、`npm run lint`、`npm run build`。
- Java：优先 `mvn test` 或 `gradle test`。
- Go：优先 `go test ./...`。
- Python：优先 `pytest`，其次 `python -m unittest`。
- Rust：优先 `cargo test`。

实现原则：

- 自动发现只作为兜底，生产项目应显式配置测试命令。
- 测试失败不得继续创建最终成功状态。
- 可以允许“测试失败但创建 draft PR”，但飞书和 PR 必须明确标记失败。
- 不让 AI 自己决定是否跳过测试，是否跳过必须由配置或用户确认决定。

### 7.5 命令执行安全

问题：

构建命令和测试命令来自配置，如果拼接不当可能产生命令注入风险。

解决：

- 项目配置只允许管理员修改。
- 命令执行使用 `execa`。
- 避免把用户输入直接拼接进 shell。
- workspace 使用任务级临时目录。
- 限制执行超时和产物大小。

### 7.6 Git 分支冲突

问题：

多个任务可能生成相同分支名。

解决：

- 分支名包含任务 ID 和时间戳。
- 示例：`codex/task-20260427-abc123`。
- 创建前检查远端分支是否存在。

### 7.7 PR 内容质量

问题：

PR 如果缺少上下文，审核人难以判断变更。

解决：

PR 描述必须包含：

- 飞书任务来源。
- 原始需求。
- 变更摘要。
- 测试结果。
- 构建产物说明。
- 飞书任务 ID。

### 7.8 部署包过大

问题：

飞书文件上传可能有大小限制，大包上传失败。

解决：

- 首期配置最大包大小。
- 超限则标记失败并提示。
- 后续支持对象存储，飞书只发送下载链接。

### 7.9 构建产物路径不稳定

问题：

不同项目产物目录不一致，打包时可能找不到文件。

解决：

- 每个项目显式配置 `artifact_paths`。
- 构建后检查路径存在。
- 不存在则失败并回传具体路径。

### 7.10 SQLite 并发写入

问题：

SQLite 单写多读，高并发 worker 同时写入可能锁表。

解决：

- 开启 WAL 模式。
- 单机首期限制 worker 并发数。
- 数据库写入使用短事务。
- 任务日志大文本写文件，不塞入数据库。
- 并发规模上来后迁移 PostgreSQL。

### 7.10.1 SQLite 队列可靠性

问题：

不用 Redis 后，任务队列能力需要由 SQLite 承担。如果领取任务、心跳和恢复机制设计不好，会出现任务重复执行或卡死。

解决：

- `queued` 任务通过事务领取，并写入 `locked_by`、`locked_at`。
- Worker 定期更新 `heartbeat_at`。
- 服务启动和定时巡检时，回收心跳超时任务。
- 所有任务执行步骤都写入 `task_events`。
- 外部副作用操作要尽量幂等，例如重复创建 PR 前先查询已有任务分支或 PR。
- 首期使用低并发，默认 1 到 2 个 worker。

### 7.11 任务恢复

问题：

服务重启时，正在执行的任务可能停在中间状态。

解决：

- 启动时扫描 `running` 状态任务。
- 超过心跳时间的任务标记为 `interrupted`。
- 飞书提示可重新执行。
- Worker 定期写入任务心跳时间。

### 7.12 敏感信息泄漏

问题：

日志可能包含 token、仓库地址、环境变量或构建密钥。

解决：

- 日志脱敏。
- `.env` 不入库。
- PR 描述不输出 secret。
- 飞书回传只展示日志 tail 摘要。
- 完整日志仅保留在服务端受控目录。

### 7.13 多仓库一致性

问题：

前后端同时修改时，可能一个仓库成功 PR，另一个失败。

解决：

- 前后端分别创建分支和 PR。
- 任务状态记录每个 repo 的阶段。
- 如果部分失败，飞书明确提示成功和失败仓库。
- PR 描述中互相引用关联任务。

### 7.14 白名单策略风险

问题：

自动执行可能对重要项目或分支造成风险。

解决：

- 白名单默认关闭。
- 只允许配置明确用户、项目、任务类型和范围。
- 禁止自动执行生产分支直接部署。
- 非白名单必须人工确认。

## 8. 建议目录结构

```text
.
├── src/
│   ├── app.ts
│   ├── config/
│   │   ├── env.ts
│   │   └── projects.ts
│   ├── db/
│   │   ├── schema.ts
│   │   └── client.ts
│   ├── feishu/
│   │   ├── client.ts
│   │   ├── events.ts
│   │   └── cards.ts
│   ├── github/
│   │   ├── git.ts
│   │   └── pull-request.ts
│   ├── codex/
│   │   └── runner.ts
│   ├── worker/
│   │   ├── queue.ts
│   │   └── task-runner.ts
│   ├── testing/
│   │   ├── detector.ts
│   │   └── runner.ts
│   ├── inputs/
│   │   └── asset-service.ts
│   ├── artifact/
│   │   └── packager.ts
│   └── task/
│       ├── parser.ts
│       ├── approval.ts
│       └── service.ts
├── tests/
├── projects.yaml
├── .env.example
├── package.json
├── tsconfig.json
└── docker-compose.yml
```

## 9. 实施里程碑

### M1：基础框架

- 初始化 Node.js + TypeScript 项目。
- 接入 Fastify。
- 加载 `.env` 和 `projects.yaml`。
- 建立 SQLite schema。
- 实现任务创建和状态流转。

### M2：飞书接入

- 实现飞书事件回调。
- 实现消息解析。
- 实现图片、视频和文件附件下载。
- 实现任务卡片。
- 实现进度卡片节流更新。
- 实现确认、取消、查看状态、重新执行按钮。

### M3：Worker 执行

- 实现任务队列。
- 实现 workspace 创建。
- 实现 Git clone、branch、commit、push。
- 实现 Codex CLI 调用。
- 实现通用测试编排器、构建、打包。

### M4：GitHub 与部署包回传

- 实现 GitHub PR 创建。
- 实现部署包上传飞书。
- 实现最终结果卡片。
- 实现失败摘要回传。

### M5：测试与加固

- 补齐单元测试。
- 增加模拟飞书事件集成测试。
- 增加任务恢复。
- 增加日志脱敏。
- 增加并发限制和超时控制。

## 10. 验收标准

- 飞书中提交白名单 bug 后，系统能自动创建任务、执行 Codex、测试、构建、开 PR，并回传部署包。
- 飞书中提交包含图片或视频的任务后，系统能下载附件并作为 AI 输入上下文。
- 没有公网 IP 时，系统能通过隧道或主动轮询模式接入飞书任务。
- 任务执行中，飞书卡片能近实时展示当前阶段和日志摘要。
- 非白名单任务必须等待用户点击“确认执行”。
- 任务状态可通过飞书按钮查看。
- 任一失败阶段都能返回明确失败原因、失败阶段、任务 ID 和日志摘要。
- 服务重启后，历史任务和已完成任务仍可查询。
- SQLite 中能完整追踪任务主状态、事件流水、审批记录、产物记录和日志索引。
