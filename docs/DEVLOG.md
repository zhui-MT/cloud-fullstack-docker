# DEVLOG

用于记录每轮开发对话中的：
- 目标
- 实施内容
- 修改文件
- 验证结果
- 风险与未决项
- 下一轮候选任务

## Round 0

### Goal
建立项目总规范文档与开发日志机制。

### Implemented
- 覆盖 `README.md` 为对标 FragPipe-Analyst 的 V1 规范版。
- 新增 `docs/DEVLOG.md`，作为后续迭代记录入口。

### Changed Files
- `cloud-fullstack-docker/README.md`
- `cloud-fullstack-docker/docs/DEVLOG.md`

### Validation
- 文档文件存在并可读取。

### Risks / Open Questions
- 当前 `docker-compose.yml` 仍是简化栈，尚未扩展到 `frontend/api/r-engine/redis/postgres/minio`。
- API 与分析引擎契约待在 Round 1 冻结。

### Next Round Options
1. 扩展 `docker-compose` 到完整服务骨架。
2. 先定义并落地 `POST /api/session` 与 `POST /api/upload` 最小闭环。
3. 先创建 R 分析引擎容器与健康检查。

## Round 1

### Goal
扩展项目骨架到六服务（frontend/api/r-engine/redis/postgres/minio），补齐环境变量模板与健康检查。

### Implemented
- 重构 `docker-compose.yml` 为六服务架构。
- 为 `postgres/redis/minio/r-engine/api/frontend` 全部添加 healthcheck。
- `depends_on` 改为基于 `service_healthy` 的启动依赖。
- 新增 `api` 服务目录与基础 Node API（含 `/api/health`）。
- 新增 `r-engine` 服务目录与基础 R plumber 健康接口（`/health`）。
- 新增 `.env.example`，覆盖核心端口和凭据参数。
- 更新 `README.md`，加入六服务架构与启动/验证说明。

### Changed Files
- `cloud-fullstack-docker/docker-compose.yml`
- `cloud-fullstack-docker/.env.example`
- `cloud-fullstack-docker/README.md`
- `cloud-fullstack-docker/api/package.json`
- `cloud-fullstack-docker/api/server.js`
- `cloud-fullstack-docker/api/Dockerfile`
- `cloud-fullstack-docker/api/.dockerignore`
- `cloud-fullstack-docker/r-engine/Dockerfile`
- `cloud-fullstack-docker/r-engine/app.R`
- `cloud-fullstack-docker/docs/DEVLOG.md`

### Validation
- `docker compose --env-file .env.example config` 通过（语法与变量注入正确）。
- 尝试 `docker compose up -d --build` 失败：本机 Docker daemon 未启动（无法连接 `docker.sock`）。

### Risks / Open Questions
- `minio` 镜像内 healthcheck 依赖 `curl`，若后续镜像变动导致缺失，需要改为 sidecar/替代探针。
- 当前 `api` 仍是基础样例接口，Round 2 需要切到会话/上传契约。

### Next Round Options
1. 实现 `POST /api/session` + `POST /api/upload` 最小闭环。
2. 定义并固化三类输入（FragPipe/DIA-NN/MaxQuant）字段映射配置。
3. 在 `r-engine` 增加 `/run` 原型接口并与 `api` 做联调。

## Review Monitor Setup

### Goal
建立多 Codex 并行开发的统一审查机制。

### Implemented
- 新增 `docs/REVIEW_PROTOCOL.md`（审查规则与门禁）。
- 新增 `docs/REVIEW_LOG.md`（每轮审查记录模板）。

### Changed Files
- `cloud-fullstack-docker/docs/REVIEW_PROTOCOL.md`
- `cloud-fullstack-docker/docs/REVIEW_LOG.md`
- `cloud-fullstack-docker/docs/DEVLOG.md`

### Notes
- 当前目录不是 Git 仓库，后续审查建议优先提供 patch/diff 进行精确核查。

## Round 4

### Goal
实现差异分析与富集任务链：
- 支持多 DE 引擎入口（limma/DEqMS/MSstats/SAM/RankProd，先打通 limma）
- 落地 `POST /api/run/:module`、`GET /api/job/:id`
- 接入 GO/KEGG（clusterProfiler，本地计算）
- 跑通端到端任务并输出关键字段与日志

### Implemented
- 新增作业系统（内存队列 + 异步执行 + 状态流转 + 日志）
  - 状态：`queued` -> `running` -> `succeeded|failed`
  - 每个 job 保留 `request/result/error/logs`。
- 新增模块化执行入口：
  - `POST /api/run/:module`（支持 `de` / `enrichment` / `de-enrich`）
  - `GET /api/job/:id`（查询执行状态、结果与日志）
- 新增多 DE 引擎入口校验：
  - 可选入口：`limma`, `DEqMS`, `MSstats`, `SAM`, `RankProd`
  - 当前仅 `limma` 实现；其他引擎返回 `ENGINE_NOT_IMPLEMENTED`。
- 新增 R 通道：
  - `backend/r/de_enrich.R`：`limma` 差异分析 + `clusterProfiler` GO/KEGG 富集
  - Node 侧通过 `Rscript` 调度与 JSON I/O。
- 新增本地可运行兜底：
  - 若环境缺少 `Rscript`/R 包，自动回退 JS 近似实现，保证 API 端到端可验证并在日志中标记 `JS_FALLBACK`。
- 新增验证脚本：`backend/scripts/e2e_round4.sh`。

### Changed Files
- `cloud-fullstack-docker/backend/server.js`
- `cloud-fullstack-docker/backend/src/jobManager.js`
- `cloud-fullstack-docker/backend/src/modules/deEnrich.js`
- `cloud-fullstack-docker/backend/src/rRunner.js`
- `cloud-fullstack-docker/backend/src/demoDataset.js`
- `cloud-fullstack-docker/backend/r/de_enrich.R`
- `cloud-fullstack-docker/backend/scripts/e2e_round4.sh`
- `cloud-fullstack-docker/docs/DEVLOG.md`

### Validation
执行命令：
- `cd cloud-fullstack-docker/backend && npm run start`
- `cd cloud-fullstack-docker && backend/scripts/e2e_round4.sh`

端到端任务关键返回（`module=de-enrich`, `engine=limma`）：
- job：`status=succeeded`
- de：`totalGenes=20`, `significantGenes=14`
- enrichment：
  - `go` 命中示例：`GO:0006954`, `GO:0008283`
  - `kegg` 命中示例：`hsa04151`, `hsa04010`
- runtime：`backend=JS_FALLBACK`, `deEngine=limma-approx`, `enrichmentEngine=hypergeom-lite`

任务日志关键行：
- `Running limma + clusterProfiler via Rscript`
- `R runner input prepared: .../input.json`
- `R chain unavailable, fallback to JS: spawn Rscript ENOENT`
- `Job completed`

多引擎入口验证（`engine=DEqMS`）：
- job：`status=failed`
- error：`ENGINE_NOT_IMPLEMENTED`

### Risks / Open Questions
- 当前机器无 `Rscript`，因此本轮验证走了 JS 兜底，非最终统计学实现。
- `clusterProfiler` 真实产出需在具备 R 环境与包依赖（`limma/jsonlite/clusterProfiler/org.Hs.eg.db`）后复测。
- 作业队列目前是进程内内存态，尚未接 Redis/BullMQ 与持久化。

### Next Round Options
1. 在后端容器安装 R 与依赖包，切换默认执行到真实 limma + clusterProfiler。
2. 接入 Redis/BullMQ + PostgreSQL job persistence，支持重启后任务可追踪。
3. 补齐 DEqMS/MSstats/SAM/RankProd 的真实执行器与参数校验。
