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
- 新增 `docs/devlog.md`，作为后续迭代记录入口。

### Changed Files
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

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
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/.env.example`
- `bioid-analytics/README.md`
- `bioid-analytics/api/package.json`
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/Dockerfile`
- `bioid-analytics/api/.dockerignore`
- `bioid-analytics/services/r-engine/Dockerfile`
- `bioid-analytics/services/r-engine/app.R`
- `bioid-analytics/docs/devlog.md`

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

## Round 2

### Goal
实现上传与解析最小闭环：
- `POST /api/session`
- `POST /api/upload`
- 支持 FragPipe / DIA-NN / MaxQuant 的 protein/peptide 文件识别与统一 schema 映射
- 返回解析摘要（样本数、实体数、可用列、警告）

### Implemented
- 新增会话接口 `POST /api/session`：
  - 创建 session 并返回 `sessionId/name/createdAt`。
- 新增上传接口 `POST /api/upload`（`multipart/form-data`）：
  - 参数：`sessionId`/`session_id` + `file`。
  - 校验 session 存在性。
  - 解析并识别来源工具/实体层级（protein/peptide）。
  - 写入 `uploads` 元数据并返回摘要和预览。
  - 完整标准化行优先落地到 blob 存储（本地文件实现），数据库仅保留回退字段与引用键。
- 新增查询接口 `GET /api/upload/:id`：
  - 返回上传详情（来源识别、解析摘要、source/sample columns、preview、mappedRowCount）。
- 新增分页接口 `GET /api/upload/:id/mapped-rows`：
  - 支持 `limit`/`offset` 分页读取完整标准化行。
- 新增会话列表接口 `GET /api/session/:id/uploads`：
  - 支持 `limit`/`offset` 分页查看同一 session 的上传历史与摘要。
- 新增删除接口 `DELETE /api/upload/:id`：
  - 删除上传记录并清理关联 blob。
  - 若 blob 删除失败，返回 warning 并仍删除数据库记录。
- 新增批量删除接口 `DELETE /api/session/:id/uploads`：
  - 批量删除会话下全部上传记录并清理关联 blob。
  - 若部分 blob 删除失败，返回 warning 并仍删除数据库记录。
- 新增对象存储后端适配：
  - `services/api/src/uploadBlobStore.js` 增加 `S3UploadBlobStore`（兼容 MinIO/S3）。
  - 通过环境变量选择 `UPLOAD_BLOB_BACKEND=fs|s3|minio`。
  - `POST /api/upload` 返回 `storage.mode/key`，便于排障与追踪。
  - `docker-compose.yml` 新增 `minio-init` 服务，自动创建 `UPLOAD_BLOB_BUCKET` 并设置 bucket policy。
  - `api` 服务注入完整 `UPLOAD_BLOB_*` 环境变量，支持容器内直连 MinIO。
  - 新增 `scripts/minio-init.sh`，支持 `UPLOAD_BLOB_POLICY=private|public-read`。
- 新增解析模块 `services/api/proteomicsParser.js`：
  - 自动识别分隔符（tab/comma）。
  - 自动识别来源：
    - FragPipe（protein/peptide）
    - DIA-NN（protein/peptide）
    - MaxQuant（protein/peptide）
  - 映射逻辑升级为表头大小写无关（case-insensitive），提升对不同导出样式的兼容性。
  - 统一映射字段：`entityType/sourceTool/accession/sequence/modifiedSequence/gene/proteinGroup/quantities`。
  - 生成摘要：
    - `sampleCount`
    - `entityCount`
    - `availableColumns`
    - `warnings`
- 新增样例数据：
  - `fragpipe-protein.tsv`
  - `diann-peptide.tsv`
  - `maxquant-protein.txt`
- 新增测试：
  - `test/upload.api.test.js`：跑通 `POST /api/session -> POST /api/upload`，覆盖 FragPipe / DIA-NN / MaxQuant 三类上传。
  - `test/upload.api.test.js`：新增 `GET /api/upload/:id` 回读持久化结果验证。
  - `test/upload.api.test.js`：新增 `GET /api/upload/:id/mapped-rows` 分页验证。
  - `test/proteomicsParser.test.js`：覆盖 FragPipe / DIA-NN / MaxQuant 三类识别，并验证表头大小写变化时映射稳定。
- 新增 blob 存储模块：`services/api/src/uploadBlobStore.js`
  - `FsUploadBlobStore`（默认）
  - `InMemoryUploadBlobStore`（测试）
  - `S3UploadBlobStore`（MinIO/S3）
- 新增 `test/uploadBlobStore.test.js`
  - 默认 `fs` 后端
  - `s3` 配置实例化
  - 缺失 bucket 的错误校验
- 更新 `scripts/compose-smoke.sh`
  - 新增会话/上传/上传详情/分页读取的冒烟检查。
  - 新增上传 `storage.mode` 断言（默认期望 `blob`）。
  - 新增 `GET /api/session/:id/uploads` 列表检查。
  - 新增 `DELETE /api/upload/:id` 与删除后列表检查。
  - 新增 `DELETE /api/session/:id/uploads` 批量删除检查。

### API Example

`POST /api/session`

Request:
```json
{
  "name": "round2-fragpipe-demo"
}
```

Response (`201`):
```json
{
  "sessionId": "2d5fe3bd-2e6f-4df1-a120-f8e8e7f7e9f2",
  "name": "round2-fragpipe-demo",
  "createdAt": "2026-02-21T14:15:16.123Z"
}
```

`POST /api/upload` (`multipart/form-data`)
- field `sessionId`: `2d5fe3bd-2e6f-4df1-a120-f8e8e7f7e9f2`
- field `file`: `fragpipe-protein.tsv`

Response (`201`):
```json
{
  "uploadId": 1,
  "sessionId": "2d5fe3bd-2e6f-4df1-a120-f8e8e7f7e9f2",
  "fileName": "fragpipe-protein.tsv",
  "detected": {
    "sourceTool": "FragPipe",
    "entityType": "protein",
    "delimiter": "tab"
  },
  "summary": {
    "rowCount": 3,
    "sampleCount": 2,
    "entityCount": 3,
    "availableColumns": [
      "entityType",
      "sourceTool",
      "accession",
      "gene",
      "quantities"
    ],
    "warnings": []
  },
  "preview": [
    {
      "entityType": "protein",
      "sourceTool": "FragPipe",
      "accession": "P12345",
      "sequence": null,
      "modifiedSequence": null,
      "gene": "TP53",
      "proteinGroup": null,
      "quantities": {
        "Intensity S1": 105000,
        "Intensity S2": 99000
      }
    }
  ]
}
```

`GET /api/upload/:id`

Response (`200`, 节选):
```json
{
  "uploadId": 1,
  "mappedRowCount": 2,
  "summary": {
    "sampleColumns": ["Sample_A", "Sample_B"],
    "sourceColumns": ["Precursor.Id", "Stripped.Sequence", "Modified.Sequence", "Protein.Group"]
  },
  "preview": [
    {
      "entityType": "peptide",
      "sourceTool": "DIA-NN",
      "sequence": "AAAAK",
      "accession": "P12345"
    }
  ]
}
```

`DELETE /api/upload/:id`

Response (`200`, 节选):
```json
{
  "ok": true,
  "uploadId": 1,
  "blobDeleted": true,
  "warnings": []
}
```

`DELETE /api/session/:id/uploads`

Response (`200`, 节选):
```json
{
  "ok": true,
  "sessionId": "2d5fe3bd-2e6f-4df1-a120-f8e8e7f7e9f2",
  "deletedCount": 2,
  "blobDeletedCount": 2,
  "warnings": []
}
```

### Changed Files
- `bioid-analytics/services/api/server.js`
- `bioid-analytics/services/api/src/uploadBlobStore.js`
- `bioid-analytics/services/api/proteomicsParser.js`
- `bioid-analytics/services/api/samples/fragpipe-protein.tsv`
- `bioid-analytics/services/api/samples/diann-peptide.tsv`
- `bioid-analytics/services/api/samples/maxquant-protein.txt`
- `bioid-analytics/services/api/test/upload.api.test.js`
- `bioid-analytics/services/api/test/proteomicsParser.test.js`
- `bioid-analytics/services/api/test/uploadBlobStore.test.js`
- `bioid-analytics/.env.example`
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/scripts/minio-init.sh`
- `bioid-analytics/scripts/compose-smoke.sh`
- `bioid-analytics/README.md`
- `bioid-analytics/db/init.sql`
- `bioid-analytics/docs/devlog.md`

### Validation
- 执行：`cd bioid-analytics/backend && npm test`
- 结果：`33 passed, 0 failed`
- 执行：`docker compose --env-file .env.example config`
- 结果：通过（包含 `minio-init` + `api` 的 blob 存储环境注入）。
  - 含端到端 API 单测验证：
    - `POST /api/session + POST /api/upload parses FragPipe protein sample` 通过
    - `POST /api/session + POST /api/upload parses DIA-NN peptide sample` 通过
    - `POST /api/session + POST /api/upload parses MaxQuant protein sample` 通过
    - `POST /api/upload accepts session_id field in multipart body` 通过
    - `GET /api/upload/:id returns persisted normalized rows and summary` 通过
    - `GET /api/upload/:id/mapped-rows supports pagination` 通过
    - `POST /api/upload falls back to db mode when blob save fails` 通过
    - `GET /api/upload/:id uses db fallback when blob read fails` 通过
    - `GET /api/session/:id/uploads lists uploads with pagination` 通过
    - `GET /api/session/:id/uploads returns 404 for unknown session` 通过
    - `DELETE /api/upload/:id removes upload and updates session list` 通过
    - `DELETE /api/upload/:id still deletes db row when blob delete fails` 通过
    - `DELETE /api/session/:id/uploads removes all uploads in a session` 通过
    - `DELETE /api/session/:id/uploads deletes db rows even when blob delete fails` 通过
    - `createDefaultUploadBlobStore returns S3UploadBlobStore when configured` 通过
  - 含三类解析识别验证：
    - FragPipe protein 通过
    - DIA-NN peptide 通过
    - MaxQuant protein 通过
- 执行（2026-02-21，Docker 实机 API 验证）：
  - `curl -X POST http://localhost:4000/api/session -d '{"name":"round2-live-curl"}'`
  - `curl -X POST http://localhost:4000/api/upload -F "sessionId=<sessionId>" -F "file=@services/api/samples/fragpipe-protein.tsv"`
- 结果（实机返回）：
  - `detected.sourceTool=FragPipe`
  - `detected.entityType=protein`
  - `summary.sampleCount=2`
  - `summary.entityCount=3`
  - `summary.availableColumns=["entityType","sourceTool","accession","gene","quantities"]`
  - `summary.warnings=[]`
  - `storage.mode=blob`
  - `storage.key=uploads/ae8f0b43-f4ea-48cf-bd01-174209cb552b/5.json`
- 执行（2026-02-21，MinIO 对象验证）：
  - `mc ls --recursive local/bioid-artifacts` 可检索到 `uploads/180282e3-96e1-49f6-8522-26ab51335e8b/6.json`
  - `DELETE /api/upload/6` 返回 `blobDeleted=true` 且 `warnings=[]`

### Risks / Open Questions
- 当前来源识别基于表头启发式规则，若用户导出列名有大幅定制，可能需要扩展 alias 映射表。
- `scripts/compose-smoke.sh` 默认会触发 `r-engine` build；首次依赖下载链较长，建议在 CI 中复用镜像缓存避免超时。

### Next Round Options
1. 为 `scripts/compose-smoke.sh` 增加可选 `SKIP_BUILD`，避免每次冒烟都重建 `r-engine`。
2. 增加样本名标准化与样本注释映射（condition/replicate）。
3. 为 FragPipe/DIA-NN/MaxQuant 补齐更多列别名与容错规则（大小写、空格、特殊分隔符）。

## Round 3

### Goal
进入第 3 阶段，实现数据清洗与预处理配置系统：
- filtering / imputation / normalization / batch correction 算法注册表与参数校验
- `config_rev` + `config_hash` 持久化
- 落地 `POST /api/config` 与 `GET /api/config/:session_id`
- 增加非法参数拦截与同配置可复现测试（固定 seed）

### Implemented
- 新增配置算法注册表：`src/configRegistry.js`
  - 覆盖四大阶段：`filtering` / `imputation` / `normalization` / `batch_correction`
  - 每个算法定义参数默认值与类型/区间校验
- 新增配置校验与标准化：`src/configValidation.js`
  - 统一校验 config 结构
  - 统一输出标准化 config（含固定 `seed`）
- 新增配置哈希与复现 token：`src/configHash.js`
  - 稳定序列化 + `sha256` 生成 `config_hash`
  - 基于 `config_hash + seed` 生成 `reproducibility_token`
- 新增配置仓储：`src/configRepository.js`
  - PostgreSQL 实现：按 `session_id` 持久化 `config_rev` / `config_hash` / `config_json`
  - 内存实现：用于无 DB 测试场景
  - 同一 `session_id` 下相同 `config_hash` 复用旧 revision（不递增）
- API 接口落地：`services/api/server.js`
  - `POST /api/config`：参数校验、计算 hash、持久化并返回 `config_rev/config_hash`
    - 入参兼容 `session_id` 与 `sessionId`
  - `GET /api/config/:session_id`：查询并返回会话最新配置
- 数据库初始化扩展：`db/init.sql`
  - 新增 `session_configs` 表及唯一约束：
    - `UNIQUE(session_id, config_rev)`
    - `UNIQUE(session_id, config_hash)`
- 新增测试：`services/api/test/config.api.test.js`
  - 非法参数拦截测试（`KNN.k=0` 返回 400）
  - 固定 seed 同配置可复现测试（同 hash、同 rev、同 token）

### Changed Files
- `bioid-analytics/services/api/server.js`
- `bioid-analytics/services/api/src/configRegistry.js`
- `bioid-analytics/services/api/src/configValidation.js`
- `bioid-analytics/services/api/src/configHash.js`
- `bioid-analytics/services/api/src/configRepository.js`
- `bioid-analytics/services/api/test/config.api.test.js`
- `bioid-analytics/services/api/package.json`
- `bioid-analytics/db/init.sql`
- `bioid-analytics/docs/devlog.md`

### Validation
执行命令：
- `cd bioid-analytics/backend && npm test`

结果：
- `POST /api/config blocks illegal params` 通过
- `same config with fixed seed is reproducible` 通过
- 总计：`2 passed, 0 failed`

### Risks / Open Questions
- `POST /api/config` 已兼容 `session_id/sessionId`，但与会话生命周期（`POST /api/session`）仍是弱耦合；后续可补会话权限边界策略。
- 当前 `session_configs` 仅保存“每个 session 的最新链式 revision”；后续若要支持回滚/比较，可补 `GET /api/config/:session_id/revisions`。

### Next Round Options
1. 补充配置 revision 历史查询与 diff API。
2. 将配置直接接入 `de/enrichment` 任务执行参数，形成端到端“配置 -> 分析结果”追溯链。
3. 为参数校验补更多边界测试（未知字段、空字符串、极值区间）。

## Review Monitor Setup

### Goal
建立多 Codex 并行开发的统一审查机制。

### Implemented
- 新增 `docs/review-protocol.md`（审查规则与门禁）。
- 新增 `docs/review-log.md`（每轮审查记录模板）。

### Changed Files
- `bioid-analytics/docs/review-protocol.md`
- `bioid-analytics/docs/review-log.md`
- `bioid-analytics/docs/devlog.md`

### Notes
- 当前目录不是 Git 仓库，后续审查建议优先提供 patch/diff 进行精确核查。

## Governance Hardening

### Goal
把“监察 + 版本控制”从文档约定升级为可执行脚本机制。

### Implemented
- 新增 `scripts/review-gate.sh`（本地审查门禁）。
- 新增 `scripts/vc-snapshot.sh`（快照提交 + 自动打 tag）。
- 新增 `scripts/vc-rollback.sh`（安全回滚分支，不直接改写 main）。
- 新增 `docs/version-control.md`（版本控制操作手册）。
- 更新 `README.md` 与 `docs/review-protocol.md` 的使用说明。

### Changed Files
- `bioid-analytics/scripts/review-gate.sh`
- `bioid-analytics/scripts/vc-snapshot.sh`
- `bioid-analytics/scripts/vc-rollback.sh`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/review-protocol.md`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

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
  - `services/api/r/de-enrich.R`：`limma` 差异分析 + `clusterProfiler` GO/KEGG 富集
  - Node 侧通过 `Rscript` 调度与 JSON I/O。
- 新增本地可运行兜底：
  - 若环境缺少 `Rscript`/R 包，自动回退 JS 近似实现，保证 API 端到端可验证并在日志中标记 `JS_FALLBACK`。
- 新增验证脚本：`services/api/scripts/e2e-round4.sh`。

### Changed Files
- `bioid-analytics/services/api/server.js`
- `bioid-analytics/services/api/src/jobManager.js`
- `bioid-analytics/services/api/src/modules/deEnrich.js`
- `bioid-analytics/services/api/src/rRunner.js`
- `bioid-analytics/services/api/src/demoDataset.js`
- `bioid-analytics/services/api/r/de-enrich.R`
- `bioid-analytics/services/api/scripts/e2e-round4.sh`
- `bioid-analytics/docs/devlog.md`

### Validation
执行命令：
- `cd bioid-analytics/backend && npm run start`
- `cd bioid-analytics && services/api/scripts/e2e-round4.sh`

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

## Round 5

### Goal
进入第 5 阶段：完成图形交互、下载和发布前验收。

### Implemented
- 后端新增分析 API：`GET /api/analysis`，返回 `PCA/Correlation/Volcano/Enrichment` 数据。
- 后端新增 artifact 下载/追溯 API：
  - `GET /api/artifacts/:id/download` (`CSV/SVG`)
  - `GET /api/artifacts/:id/png` (PNG 渲染 payload)
  - `GET /api/artifacts/:id/meta`
- artifact 元数据统一包含：`artifact_id/kind/format/file_name/config_rev/generated_at`。
- 前端重构为四图可视化面板，新增交互：
  - PCA 组别筛选
  - Volcano 阈值滑杆
  - Enrichment TopN 切换
- 前端实现 `PNG/SVG/CSV` 下载：
  - `SVG/CSV` 直接下载
  - `PNG` 由前端基于后端 SVG payload 转 Canvas 导出
- 回归与性能测试：
  - 新增 `services/api/scripts/regression.js`
  - 新增 `services/api/scripts/performance.js`
  - 新增 `services/api/scripts/generate-test-summary.js`
  - 新增 `npm run test:summary`
- 修复配置校验兼容性：`services/api/src/configValidation.js` 支持 registry 中 function/object 两类 validator。
- 更新 README 为最终运行说明，并加入发布检查清单（可部署/可复现/可回滚）。

### Changed Files
- `bioid-analytics/services/api/server.js`
- `bioid-analytics/services/api/lib/analysis.js`
- `bioid-analytics/services/api/src/configValidation.js`
- `bioid-analytics/services/api/scripts/regression.js`
- `bioid-analytics/services/api/scripts/performance.js`
- `bioid-analytics/services/api/scripts/generate-test-summary.js`
- `bioid-analytics/services/api/package.json`
- `bioid-analytics/services/frontend/src/App.jsx`
- `bioid-analytics/services/frontend/src/App.css`
- `bioid-analytics/docs/round5-test-summary.md`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

- 后端单测：`cd backend && npm test` 通过（7/7）
- 回归 + 性能：`cd backend && npm run test:summary` 通过
- 前端构建：`cd frontend && npm install && npm run build` 通过

性能摘要（本地 loopback，非容器压测）：
- Analysis API: p50=1.37ms, p95=2.26ms, max=3.42ms
- Download API: p50=0.23ms, p95=0.44ms, max=0.75ms

### Risks / Open Questions
- 当前 PNG 采用“后端返回 SVG payload + 前端转 Canvas”路径，后端未直接输出二进制 PNG。
- 性能数据为本地进程级基准，生产环境需结合容器和网络路径复测。
- artifact 仓库目前是进程内内存态，重启后不会保留历史下载 ID。

### Next Round Options
1. 接入持久化 artifact 存储（如 MinIO）并支持历史回放下载。
2. 增加 E2E 浏览器自动化用例（渲染与下载链路）。
3. 将性能测试扩展为容器内并发压测（含 p99 与错误率门限）。

## Round 6

### Goal
将第 4 阶段 R 计算链路从本地 `Rscript` 扩展为优先远程 `r-engine` 调用，贴合当前 `api + r-engine` 架构并保留本地 fallback。

### Implemented
- `r-engine` 新增差异+富集执行接口：
  - `POST /run/de-enrich`
  - 入口参数：`{ mode, payload }`
  - 计算：`limma` + `clusterProfiler` + `org.Hs.eg.db`
- `r-engine` 新增分析实现文件：`services/r-engine/analysis.R`。
- `r-engine` Dockerfile 增强：
  - 安装编译/系统依赖
  - 安装 `BiocManager`
  - 安装 `limma`, `clusterProfiler`, `org.Hs.eg.db`
- 后端 R 调度改造：`services/api/src/rRunner.js`
  - 优先走 `R_ENGINE_URL` 远程调用
  - 远程失败自动回退本地 `Rscript`
  - 保留最终 JS fallback（由模块层处理）
- 日志语义统一：`Rscript` 字样升级为 `R runtime`。
- E2E 脚本增强：`services/api/scripts/e2e-round4.sh`
  - 改为 JSON 解析方式提取字段（不依赖脆弱 sed）
  - 输出 `runtime` 和 `significantGenes`
  - 新增 `EXPECT_RUNTIME` 断言能力
- 新增自动化测试：`services/api/test/rRunner.test.js`（mock r-engine 验证远程路径）。

### Changed Files
- `bioid-analytics/services/r-engine/analysis.R`
- `bioid-analytics/services/r-engine/app.R`
- `bioid-analytics/services/r-engine/Dockerfile`
- `bioid-analytics/services/api/src/rRunner.js`
- `bioid-analytics/services/api/src/modules/deEnrich.js`
- `bioid-analytics/services/api/scripts/e2e-round4.sh`
- `bioid-analytics/services/api/test/rRunner.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 单测：
- 命令：`cd backend && npm test`
- 结果：`7 passed, 0 failed`（包含 `runRDeEnrich uses remote r-engine when R_ENGINE_URL is set`）

2) 端到端（本机无 Rscript 场景）：
- 命令：`cd bioid-analytics && services/api/scripts/e2e-round4.sh`
- 结果：`status=succeeded`，`runtime=JS_FALLBACK`（符合预期，因本机缺 `Rscript`）

3) 端到端（mock r-engine 场景）：
- 后端启动时设置：`R_ENGINE_URL=http://127.0.0.1:18080`
- 命令：`EXPECT_RUNTIME=R services/api/scripts/e2e-round4.sh`
- 结果：`status=succeeded`，`runtime=R`，日志包含：
  - `Trying remote r-engine: ...`
  - `[r-engine] {...}`
  - `Remote r-engine completed`

### Risks / Open Questions
- 当前环境 Docker daemon 未启动，无法在本轮内完成真实 `r-engine` 容器构建验证。
- `clusterProfiler` 依赖链较重，容器首次构建耗时较长；建议在 CI 做缓存。
- 目前主后端仍在 `backend` 目录，compose 使用的是 `api` 服务，后续需要做服务对齐（迁移或替换）。

### Next Round Options
1. 将 `backend` 能力并入 `api` 服务，消除双后端目录分叉。
2. 在 CI 增加 `r-engine` build + smoke test（`/health` + `/run/de-enrich`）。
3. 把 job queue 从内存态升级到 Redis/BullMQ 持久队列。

## Round 7

### Goal
继续完善配置系统可追溯能力，补齐配置 revision 历史查询与版本差异接口。

### Implemented
- 扩展配置仓储接口与实现：
  - `listRevisions(sessionId)`：列出会话所有 revision（升序）
  - `getConfigByRevision(sessionId, configRev)`：按 revision 读取配置
- 新增配置差异计算模块：
  - `services/api/src/configDiff.js`
  - 支持对象/数组递归比对，输出字段路径级变更（`path/from/to`）
- 新增 API：
  - `GET /api/config/:session_id/revisions`
  - `GET /api/config/:session_id/diff?from_rev=1&to_rev=2`
- 新增参数校验：
  - `from_rev/to_rev` 必须为正整数，否则返回 `400`
  - 任一 revision 不存在返回 `404`
- 扩展测试：
  - 新增 revision 历史与 diff 接口测试，验证 revision 递增与关键字段变更（`normalization.algorithm`）

### Changed Files
- `bioid-analytics/services/api/src/configRepository.js`
- `bioid-analytics/services/api/src/configDiff.js`
- `bioid-analytics/services/api/server.js`
- `bioid-analytics/services/api/test/config.api.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行命令：
- `cd bioid-analytics/backend && npm test`

结果：
- `10 passed, 0 failed`
- 包含新增子测试：`GET /api/config/:session_id/revisions and /diff return revision history and changes`

### Risks / Open Questions
- 目前 `revisions` 接口只返回元信息；如前端需要版本回看，可增加 `include_config=true` 可选参数。
- diff 为结构化字段级差异，尚未提供“语义级”变更分类（如算法切换/参数调整分组）。

### Next Round Options
1. 增加 `GET /api/config/:session_id/revisions/:rev`，支持指定 revision 全量回看。
2. 在 diff 返回中加入变更分类（`algorithm_changed`, `param_changed`）。
3. 将配置 revision 绑定到 job 执行入参，确保分析任务可按 revision 重放。

## Round 8

### Goal
将 `config_rev/config_hash` 绑定到 `/api/run/:module` 的 job 执行与查询结果，形成“配置版本 -> 任务执行”的追溯闭环，并补单测与 e2e 回归。

### Implemented
- `/api/run/:module` 增强为带配置上下文解析：
  - 支持按 `session_id + config_rev` 绑定配置
  - 支持按 `session_id + config_hash` 绑定配置
  - 支持仅 `session_id` 自动绑定最新配置
  - 支持 `config_rev + config_hash` 一致性校验（不一致返回 `409`）
- `JobManager` 扩展：
  - `createJob` 增加 `options`，保存 `configTrace` 与 `executionContext`
  - job 日志新增配置绑定信息
  - job 执行结果自动附加 `result.config_trace`
- `/api/job/:id` 返回新增 `config_trace` 字段。
- 配置仓储新增按 hash 查询能力：
  - `getConfigByHash(sessionId, configHash)`（PG + InMemory 实现）

### Changed Files
- `bioid-analytics/services/api/server.js`
- `bioid-analytics/services/api/src/jobManager.js`
- `bioid-analytics/services/api/src/configRepository.js`
- `bioid-analytics/services/api/test/run.config-trace.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 单测：
- 命令：`cd bioid-analytics/backend && npm test`
- 结果：`15 passed, 0 failed`
- 新增覆盖：
  - `POST /api/run/:module binds latest config trace from session`
  - `POST /api/run/:module supports explicit config_rev/config_hash binding and rejects mismatch`

2) E2E 回归（兼容性）：
- 命令：`cd bioid-analytics/backend && ./scripts/e2e-round4.sh`
- 结果：任务 `succeeded`，`runtime=JS_FALLBACK`，未带配置参数时行为保持兼容。

### Risks / Open Questions
- 默认 `node server.js` 在无 PostgreSQL 环境下，配置 API 仍依赖 `PgConfigRepository`，会导致本地“无 DB 直接绑配置跑 e2e”不可用。
- 当前 job 仅回传 `config_trace` 元信息，尚未将配置参数用于模块内部行为切换（暂为追溯绑定阶段）。

### Next Round Options
1. 增加无 DB 开发模式（自动切换 `InMemoryConfigRepository`）。
2. 将 `executionContext.config` 接入模块逻辑，实现“按配置版本重放”。
3. 在 `scripts/e2e-round4.sh` 增加可选配置绑定参数（`SESSION_ID/CONFIG_REV/CONFIG_HASH`）。

## Round 9

### Goal
让 `executionContext.config` 真正驱动 `de/enrichment` 计算逻辑，并验证不同 `config_rev` 可改变任务执行行为（不仅是元数据追溯）。

### Implemented
- 模块执行入口接入配置上下文：
  - `runDeModule/runEnrichmentModule/runDeEnrichModule` 读取 `executionContext.config`
  - 增加预处理流水线（最小实现）：
    - filtering：支持低方差过滤
    - imputation：`none` / 非 `none` 的缺失值填补（当前统一按最小值一半策略）
    - normalization：`no-normalization` / `median` / `z-score`
    - batch correction：基于样本批次字段做均值对齐（无批次时跳过并记日志）
- `runJsDe` 增加数值矩阵校验：
  - 若存在非数值（如 `null`）且未被填补，抛出 `INVALID_NUMERIC_MATRIX`
- 新增行为测试 `run.config-preprocessing.test.js`：
  - 同一 session 下 `config_rev=1`（`imputation=none`）任务失败
  - `config_rev=2`（`imputation=min-half`）任务成功
  - 证明配置版本已影响执行结果

### Changed Files
- `bioid-analytics/services/api/src/modules/deEnrich.js`
- `bioid-analytics/services/api/test/run.config-preprocessing.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行命令：
- `cd bioid-analytics/backend && npm test`

结果：
- `17 passed, 0 failed`
- 新增通过用例：`executionContext.config affects preprocessing and job outcome by revision`

### Risks / Open Questions
- 当前 imputation 的多算法入口在 fallback 中仍使用统一简化策略，尚未做算法级差异化实现。
- 预处理实现为“可验证链路”的最小版本，统计严谨性仍需与 R 正式流程对齐。

### Next Round Options
1. 将 `imputation` fallback 细分为算法级实现（`KNN/SVD/QRILC` 等）。
2. 将配置预处理参数同步传入 R runtime，统一 JS/R 行为。
3. 在 `/api/job/:id` 中增加“预处理摘要”（过滤数量、填补数量、归一化策略）。

## Round 10

### Goal
细化 JS fallback 的 imputation 算法分支（`KNN/SVD/QRILC/minprob/left-shift-gaussian/...`），并将预处理配置参数结构化透传到 R runtime，补齐一致性验证。

### Implemented
- `services/api/src/modules/deEnrich.js` 预处理链路增强：
  - imputation 从统一策略升级为算法分支实现：
    - `min-half`
    - `left-shift-gaussian`（基于 seed 的确定性噪声）
    - `minprob`
    - `QRILC`（近似实现）
    - `KNN`（基于行间距离）
    - `SVD`（低秩近似填补）
    - `BPCA`（迭代近似）
    - `missForest`（中位数近似）
    - `hybrid`（按缺失比例分配 MAR/MNAR 路径）
  - 增加 `preprocessing` 运行摘要（filtering/imputation/normalization/batch_correction 统计）
  - 增加 `preprocessing_config`（从 `executionContext.config` 透传的结构化配置）
  - 非数值矩阵校验保留，保障 `imputation=none` 场景能明确失败
- 新增测试：
  - `run.config-preprocessing.test.js`
    - 新增 `KNN vs SVD` 在同一缺失数据上的输出差异验证
  - `run.r-preprocess-passthrough.test.js`
    - 使用 mock `r-engine` 验证 `preprocessing_config` 与 `preprocessing` 已随请求透传到远端 R runtime

### Changed Files
- `bioid-analytics/services/api/src/modules/deEnrich.js`
- `bioid-analytics/services/api/test/run.config-preprocessing.test.js`
- `bioid-analytics/services/api/test/run.r-preprocess-passthrough.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行命令：
- `cd bioid-analytics/backend && npm test`

结果：
- `23 passed, 0 failed`
- 新增通过用例：
  - `different imputation algorithms (KNN vs SVD) lead to different DE outputs`
  - `preprocessing config is passed through to remote r-engine payload`

### Risks / Open Questions
- 目前 `QRILC/BPCA/missForest` 为工程近似实现，统计学精度仍需与 R 正式实现逐项对齐。
- JS 与 R 的预处理实现仍非完全同源，当前主要保证参数透传与行为可追溯。

### Next Round Options
1. 在 R pipeline 中消费 `preprocessing_config`，实现与 JS 同语义的预处理步骤。
2. 为每种 imputation 增加固定 seed 的基准回归快照（防止行为漂移）。
3. 在 `/api/job/:id` 增加可读化 preprocessing 报告字段供前端展示。

## Round 11

### Goal
在 R pipeline 中实际消费 `preprocessing_config`，并补充 JS/R 入口一致性回归测试。

### Implemented
- 新增/重构 R 预处理执行链（`services/r-engine/analysis.R`）：
  - 在进入 limma 前应用 `preprocessing_config`
  - 支持 filtering + imputation + normalization + batch correction 的可运行近似实现
  - 支持算法入口：
    - imputation: `none|min-half|left-shift-gaussian|minprob|QRILC|KNN|SVD|BPCA|missForest|hybrid`
  - 输出 `preprocessing` 摘要（含算法与 imputed_count 等）
- 后端本地 Rscript 路径对齐：
  - 新增 `services/api/r/analysis.R`（与 r-engine 分析核心保持同构）
  - `services/api/r/de-enrich.R` 改为加载 `analysis.R` 后执行 `run_de_enrich_pipeline`
- 新增回归测试：
  - `left-shift-gaussian` 固定 seed 确定性回归（同 seed 稳定，不同 seed 变化）
  - 远端 r-engine 透传验证增强（验证 `preprocessing` 摘要也透传）

### Changed Files
- `bioid-analytics/services/r-engine/analysis.R`
- `bioid-analytics/services/api/r/analysis.R`
- `bioid-analytics/services/api/r/de-enrich.R`
- `bioid-analytics/services/api/test/run.config-preprocessing.test.js`
- `bioid-analytics/services/api/test/run.r-preprocess-passthrough.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行命令：
- `cd bioid-analytics/backend && npm test`

结果：
- `26 passed, 0 failed`
- 新增通过用例：
  - `left-shift-gaussian imputation is deterministic for same seed and changes with different seed`
  - `preprocessing config is passed through to remote r-engine payload`（增强断言）

### Risks / Open Questions
- 当前 R 预处理仍是与 JS 对齐的“工程近似版”，与 Bioconductor 标准实现尚需逐项比对。
- `services/api/r/analysis.R` 与 `services/r-engine/analysis.R` 当前为同步副本，后续建议抽出共享源避免漂移。

### Next Round Options
1. 抽取单一 R 预处理核心文件，消除 services/api/r 与 r-engine 双份代码。
2. 对齐 R 端真实算法实现（例如 QRILC/BPCA/missForest）并增加统计回归基准。
3. 增加 job 返回中的 preprocessing 可视化摘要（供前端配置审计面板使用）。

## Round 13

### Goal
优化 `r-engine` 根上下文构建与防漂移保障，补齐可用于 CI 的 compose 冒烟检查路径。

### Implemented
- 新增仓库根级 `.dockerignore`：
  - 默认忽略全部上下文，仅放行 `r-engine` 运行文件与单一分析源 `services/api/r/analysis.R`。
  - 显著缩小 `r-engine` 构建上下文体积。
- 增强防漂移测试：
  - `services/api/test/r.analysis.source.test.js` 追加断言：
    - 根 `.dockerignore` 存在并包含关键放行规则
    - 单一分析源策略未被回退
- 补充 compose 冒烟脚本验证：
  - `scripts/compose-smoke.sh` 支持配置解析 + `r-engine` 构建检查
  - 本地可通过 `SKIP_API=1` 做轻量 CI 风格验证

### Changed Files
- `bioid-analytics/.dockerignore`
- `bioid-analytics/services/api/test/r.analysis.source.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 后端单测
- 命令：`cd backend && npm test`
- 结果：`29 passed, 0 failed`

2) Compose 轻量冒烟
- 命令：`SKIP_API=1 scripts/compose-smoke.sh`
- 结果：
  - compose config 通过
  - `r-engine` 构建通过
  - 冒烟脚本通过

3) 上下文体积观察
- `docker compose build r-engine` 输出显示构建上下文传输约 `20KB`（相比全仓库显著缩小）。

### Risks / Open Questions
- 当前 `.dockerignore` 采用“全忽略 + 白名单放行”策略；若后续 `r-engine` 依赖新增文件，需同步维护白名单。

### Next Round Options
1. 在 CI 中固定执行 `SKIP_API=1 scripts/compose-smoke.sh` 作为构建门禁。
2. 为 R 预处理输出新增 golden snapshot，对关键算法做回归比对。
3. 将 `preprocessing` 摘要透传到前端分析页面用于审计展示。

## Round 5 Acceptance Refresh

### Goal
在 Round 5 基础上执行一次可发布门禁复核，给出可部署/可复现/可回滚状态。

### Implemented
- 复跑后端全测试：`npm test`（33/33 通过）。
- 复跑回归 + 性能：`npm run test:summary`，刷新 `docs/round5-test-summary.md`。
- 复跑前端构建：`npm run build` 通过。
- 完成 `r-engine` 镜像构建（默认 profile，`R_ENGINE_INSTALL_ENRICHMENT_PACKAGES=0`）。
- 完成 compose 运行态验收（`up -d --no-build` + health + full smoke）。
- 生成发布门禁执行报告：`docs/round5-release-checklist.md`。
- 更新 README 与 Round 5 性能数字为最新实测值。

### Validation
- `cd backend && npm test` -> `33 passed, 0 failed`
- `cd backend && npm run test:summary` -> regression `PASS`
- `docker compose --env-file .env.example build r-engine` -> `Successfully built` / `Successfully tagged`
- `docker compose --env-file .env.example up -d --no-build` -> services healthy
- `docker compose --env-file .env.example ps` -> `frontend/api/postgres/redis/r-engine/minio` healthy
- `curl -fsS http://localhost:4000/api/health` -> `ok=true`
- `curl -fsS http://localhost:8000/health` -> `ok=true`
- `SKIP_BUILD=1 scripts/compose-smoke.sh` -> `PASS`
- `cd frontend && npm run build` -> `built`

### Gate Status
- Deployable: **PASS**
- Reproducible: **PASS**
- Rollback-ready: **PARTIAL**（待执行 release tag + 回滚演练）

## Governance Remediation (Review 3 Fixes)

### Goal
修复 Review 3 的发布阻断：统一 compose 后端入口并消除 README/compose 冲突。

### Implemented
- 将 `docker-compose.yml` 的 `api` 服务构建入口从 `./api` 切换为 `./services/api`。
- 调整 `api` 容器变量为 `PORT=4000`，并将代码挂载目录改为 `./services/api:/app`。
- 新增 `scripts/compose-smoke.sh`，用于集成验证：`/api/health`、`/api/analysis`、artifact 下载与 metadata 头。
- 更新 `README.md` 运行栈说明，明确六服务已启用，并加入 smoke 命令。
- 更新 `docs/review-protocol.md` 与 `docs/version-control.md`，纳入 compose smoke 检查。

### Changed Files
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/scripts/compose-smoke.sh`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/review-protocol.md`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/devlog.md`

## Round 7

### Goal
将第 4 阶段能力同步到 compose 主后端 `api` 服务，避免仅在 `backend` 目录可用。

### Implemented
- 在 `api` 服务落地作业链路：
  - `GET /api/modules`
  - `POST /api/run/:module`
  - `GET /api/job/:id`
- 新增 `api` 内部作业系统（内存队列 + job 状态 + 日志）：
  - `api/src/jobManager.js`
- 新增 `api` 分析模块：
  - `api/src/modules/deEnrich.js`
  - 支持 DE 引擎入口：`limma/DEqMS/MSstats/SAM/RankProd`
  - 当前仅 limma 实现，其他引擎返回 `ENGINE_NOT_IMPLEMENTED`
- 新增 `api` 数据与 R 调度模块：
  - `api/src/demoDataset.js`
  - `api/src/rRunner.js`（优先远程 `R_ENGINE_URL`，失败回退 JS）
- 重构 `api/server.js`：
  - 提供 `createApp/startServer` 便于测试
  - 保留原有 `/api/health` 与 `/api/messages`
- 新增 `api` 测试与 e2e 脚本：
  - `api/test/deEnrich.api.test.js`
  - `api/scripts/e2e-round4.sh`
- `api/package.json` 新增 `npm test`。

### Changed Files
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/package.json`
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/src/demoDataset.js`
- `bioid-analytics/api/src/rRunner.js`
- `bioid-analytics/api/src/modules/deEnrich.js`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/api/scripts/e2e-round4.sh`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) `api` 单测
- 命令：`cd api && npm test`
- 结果：`2 passed, 0 failed`
  - `POST /api/run/de-enrich and GET /api/job/:id works in api service`
  - `DEqMS is exposed but not implemented in api service`

2) `api` 端到端（无 R_ENGINE_URL）
- 命令：`cd bioid-analytics && api/scripts/e2e-round4.sh`
- 结果：`status=succeeded`, `runtime=JS_FALLBACK`, `significantGenes=14`

3) `api` 端到端（远程 R 通道，mock r-engine）
- 启动：`R_ENGINE_URL=http://127.0.0.1:18080 npm run start`
- 命令：`EXPECT_RUNTIME=R api/scripts/e2e-round4.sh`
- 结果：`status=succeeded`, `runtime=R`, `significantGenes=2`
- 日志关键行：
  - `Trying remote r-engine: ...`
  - `[r-engine] {...}`
  - `Remote r-engine completed`

### Risks / Open Questions
- `api` 与 `backend` 当前存在能力重叠，后续需要决定保留单一后端目录以降低维护成本。
- 真实 `r-engine` 容器路径待在 Docker daemon 可用后做完整构建与真包验证（当前 mock 验证已通过）。

### Next Round Options
1. 统一后端目录（`api` vs `backend`），避免双实现漂移。
2. 将 `api` 作业队列从内存态升级为 Redis/BullMQ。
3. 在 compose 下跑真实 `r-engine` build + `/run/de-enrich` smoke test。

## Remediation Validation

### Goal
验证 Review 3 修复项并补齐可执行的集成烟测流程。

### Validation
- `docker compose --env-file .env.example config`：通过（`api.build.context` 已指向 `./services/api`）。
- `scripts/review-gate.sh review3-remediation-v2`：通过。
- `SKIP_HEALTH=1 scripts/compose-smoke.sh`（本机 backend 裸跑场景）：通过。

### Notes
- `scripts/compose-smoke.sh` 默认会检查 `/api/health`，用于 compose 全栈场景。
- 本机未起 postgres 时可使用 `SKIP_HEALTH=1` 跳过 health 检查，仅验证 analysis/artifact 下载链路。

## Round 8

### Goal
继续推进任务编排：在 `api` 服务引入可切换队列模式（`memory` / `bullmq`），为后续 Redis 持久队列迁移做准备。

### Implemented
- 重构 `api` 作业管理器为双实现：
  - `InMemoryJobManager`（本地开发/测试默认）
  - `BullmqJobManager`（Redis 队列模式）
- 新增队列工厂：`createJobManager({ queueMode })`。
- `api/server.js` 接入队列模式配置：
  - `JOB_QUEUE_MODE`（默认 `memory`）
  - Redis 连接参数来自 `REDIS_HOST/REDIS_PORT`
  - `/api/run/:module`、`/api/job/:id` 改为异步 job manager 调用
- `BullmqJobManager` 行为：
  - 将模块任务投递到队列并由 worker 执行
  - `GET /api/job/:id` 可返回状态、结果、错误与日志
  - 状态映射：`waiting/delayed/paused -> queued`, `active -> running`, `completed -> succeeded`, `failed -> failed`
- Compose 与环境模板补齐：
  - `docker-compose.yml` 的 `api` 服务新增 `JOB_QUEUE_MODE: ${JOB_QUEUE_MODE:-bullmq}`
  - `.env.example` 新增 `JOB_QUEUE_MODE=bullmq`
- `api` 测试保持稳定：
  - 测试场景固定 `queueMode: memory`，避免依赖外部 Redis。

### Changed Files
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/package.json`
- `bioid-analytics/api/package-lock.json`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/.env.example`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 语法检查
- `node --check api/server.js`
- `node --check api/src/jobManager.js`
- 结果：通过

2) `api` 单测
- 命令：`cd api && npm test`
- 结果：`2 passed, 0 failed`

3) `api` 端到端（memory 模式）
- 启动：`cd api && JOB_QUEUE_MODE=memory npm run start`
- 验证：`cd .. && api/scripts/e2e-round4.sh`
- 结果：`status=succeeded`, `runtime=JS_FALLBACK`, `significantGenes=14`

### Risks / Open Questions
- 当前环境无可用 Redis 实例，未完成 `bullmq` 真连接路径的在线验证。
- `api` 与 `backend` 仍存在部分功能重叠，后续需确定单一后端主路径。

### Next Round Options
1. 启动 Redis（或在 CI）后补 `bullmq` 真实 E2E 验证（包括失败重试与日志查询）。
2. 把 `api` job 元数据落到 PostgreSQL，支持重启后 job 历史查询。
3. 收敛 `backend` 与 `api` 的重复实现，保留一个主服务目录。

### Round 8 Patch

#### Extra Implemented
- 新增 `ResilientJobManager`：
  - `JOB_QUEUE_MODE=bullmq` 但 Redis 不可用时，自动降级到 `memory` 队列继续接单。
  - `GET /api/modules` 新增 `queue` 状态字段，可观察是否进入 `memory-fallback`。
- `api/server.js` 支持注入 `redisOptions`（用于测试与可控退避参数）。
- BullMQ 连接参数补充 `connectTimeout` 与有限重试，减少不可用时阻塞。

#### Extra Validation
- `api` 单测更新为 `3 passed, 0 failed`，新增用例：
  - `bullmq mode falls back to memory when redis is unavailable`
- 验证点：
  - 初始 `GET /api/modules` 返回 `queue.mode=bullmq`
  - 触发任务后 Redis 连接失败自动降级
  - 再次 `GET /api/modules` 返回 `queue.mode=memory-fallback` 且 `fallbackActive=true`

## Round 9

### Goal
继续推进可追踪性：落地 job 持久化存储与历史查询接口，支撑重启后任务记录查询能力。

### Implemented
- 新增 job store 抽象：`api/src/jobStore.js`
  - `InMemoryJobStore`
  - `PgJobStore`
- `api/server.js` 接入 `JOB_STORE_MODE`：
  - `memory`（默认）
  - `postgres`
- `api/src/jobManager.js` 全链路接入 store 持久化：
  - `queued/running/succeeded/failed` 状态更新同步写入 store
  - bullmq worker 执行结果同步写入 store
- `GET /api/job/:id` 增加 store 回查：
  - queue 查不到时可从 store 读取
- 新增 `GET /api/jobs`：
  - 支持 `limit`（1-200）
  - 支持 `status`、`module` 过滤
  - 返回 `items/total/limit`
- 数据库 schema 增强：
  - `db/init.sql` 新增 `job_runs` 表
- `api/scripts/e2e-round4.sh` 增强：
  - 任务完成后额外输出 `jobs_total`
- BullMQ 弹性继续增强：
  - Redis 不可用时 `ResilientJobManager` 自动降级到 memory
  - `GET /api/modules` 返回 `queue.mode=memory-fallback` 状态

### Changed Files
- `bioid-analytics/api/src/jobStore.js`
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/api/scripts/e2e-round4.sh`
- `bioid-analytics/db/init.sql`
- `bioid-analytics/.env.example`
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 单测
- 命令：`cd api && npm test`
- 结果：`3 passed, 0 failed`
- 包含：`bullmq mode falls back to memory when redis is unavailable`

2) 端到端（memory queue + memory store）
- 启动：`cd api && JOB_QUEUE_MODE=memory JOB_STORE_MODE=memory npm run start`
- 验证：`cd .. && api/scripts/e2e-round4.sh`
- 结果：
  - `status=succeeded`
  - `runtime=JS_FALLBACK`
  - `significantGenes=14`
  - `jobs_total=1`

### Risks / Open Questions
- `JOB_STORE_MODE=postgres` 的在线验证仍依赖可用 PostgreSQL/compose 环境（当前未执行 docker 全栈联调）。
- job 重启恢复目前提供“历史可查”，尚未实现“中断任务重试恢复”。

### Next Round Options
1. 在 compose 全栈下验证 `JOB_QUEUE_MODE=bullmq + JOB_STORE_MODE=postgres` 真实路径。
2. 为 `GET /api/jobs` 增加分页游标（`cursor`）与时间范围过滤。
3. 增加 job 重试策略与失败重跑接口（如 `POST /api/job/:id/retry`）。

## Round 12

### Goal
消除 `services/api/r` 与 `r-engine` 的 R 分析代码漂移风险，收敛为单一分析源文件。

### Implemented
- 选定 `services/api/r/analysis.R` 作为唯一分析源。
- 删除重复副本：`services/r-engine/analysis.R`。
- 调整 `r-engine` 构建路径：
  - `docker-compose.yml` 中 `r-engine` 构建上下文改为仓库根目录。
  - `services/r-engine/Dockerfile` 改为从单一源复制：
    - `COPY services/api/r/analysis.R /app/analysis.R`
- 新增防漂移测试：
  - 校验 `services/r-engine/Dockerfile` 必须从 `services/api/r/analysis.R` 复制分析核心。
  - 校验 `services/r-engine/analysis.R` 不再存在。
  - 校验 compose 中 `r-engine` 构建上下文为根目录并使用 `services/r-engine/Dockerfile`。

### Changed Files
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/services/r-engine/Dockerfile`
- `bioid-analytics/services/r-engine/analysis.R` (deleted)
- `bioid-analytics/services/api/test/r.analysis.source.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 后端单测
- 命令：`cd backend && npm test`
- 结果：`29 passed, 0 failed`
- 新增通过用例：
  - `r-engine docker build uses services/api/r/analysis.R as single analysis source`

2) Compose 配置检查
- 命令：`docker compose config`
- 结果：通过；`r-engine.build.context` 为仓库根目录，`dockerfile` 为 `services/r-engine/Dockerfile`。

### Risks / Open Questions
- `r-engine` 构建上下文改为仓库根目录后，镜像构建上下文体积上升，可能影响首次构建耗时。
- 若后续继续扩展共享资产，建议补 `.dockerignore`（根目录级）以控制传输体积。

### Next Round Options
1. 增加根目录 `.dockerignore`，减少 `r-engine` 根上下文构建开销。
2. 在 CI 增加“单一源校验 + compose build smoke test”。
3. 将 `api` 服务也接入同一 R 分析源路径策略，统一后端族行为。

## Round 10

### Goal
继续推进任务编排可运维性：增加失败任务重试接口与 job 历史分页能力。

### Implemented
- 新增失败任务重试接口：
  - `POST /api/job/:id/retry`
  - 仅允许 `failed` 状态任务重试（否则返回 `409`）
  - 支持覆盖请求体：`{ request: {...} }`
  - 返回：`sourceJobId/retryJobId/statusUrl`
- 强化 job 历史查询：
  - `GET /api/jobs` 新增 `cursor` 分页
  - 返回新增 `nextCursor`（base64url 编码）
  - 支持参数：`limit/status/module/cursor`
- `jobStore` 升级：
  - `InMemoryJobStore` 和 `PgJobStore` 的 `listJobs` 统一返回 `{ items, nextCursor }`
  - PostgreSQL 查询排序增强：`ORDER BY created_at DESC, id DESC`
  - 支持基于 `(created_at, id)` 的游标翻页
- `server` 增强：
  - `GET /api/job/:id` 统一使用 `loadJob`（queue + store 回查）
  - `GET /api/modules` 保持 queue/store 模式可观测
- `api` 测试增强：
  - 新增 retry 成功重跑用例
  - 新增 cursor 翻页用例

### Changed Files
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/src/jobStore.js`
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/api/scripts/e2e-round4.sh`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) `api` 单测
- 命令：`cd api && npm test`
- 结果：`5 passed, 0 failed`
- 新增通过用例：
  - `POST /api/job/:id/retry retries failed jobs with override request`
  - `GET /api/jobs supports cursor paging`

2) 运行态验证（memory queue + memory store）
- 启动：`JOB_QUEUE_MODE=memory JOB_STORE_MODE=memory npm run start`
- `api/scripts/e2e-round4.sh`：
  - `status=succeeded`
  - `runtime=JS_FALLBACK`
  - `jobs_total=1`
- 手工验证：
  - `engine=DEqMS` 任务失败
  - `POST /api/job/:id/retry` 覆盖 `engine=limma` 后重试成功
  - `/api/jobs` 返回 `nextCursor`，下一页请求可继续获取历史项

### Risks / Open Questions
- `POST /api/job/:id/retry` 当前仅支持单次立即重投，尚未加入重试次数上限与审计字段（如 `retry_of` 持久化）。
- `JOB_STORE_MODE=postgres` 的在线联调仍需在可用 Postgres/compose 环境下执行。

### Next Round Options
1. 在 `job_runs` 表增加 `retry_of/retry_count` 字段，并把重试关系持久化。
2. 增加 `POST /api/job/:id/cancel`（队列中任务取消）与状态流约束。
3. 在 compose 全栈中验证 `bullmq + postgres store + r-engine` 真实链路。

## Round 11

### Goal
继续增强任务可追溯与恢复能力：为 retry 建立可持久化关系字段，并完善分页/重试接口行为。

### Implemented
- Job 元数据新增重试关系字段：
  - `retryOf`（来源任务 ID）
  - `retryCount`（重试层级，从 0 开始）
- `api/src/jobManager.js`：
  - `createJob(module, request, meta)` 支持传入重试元数据
  - memory/bullmq/resilient 三类 manager 全部透传并持久化 `retryOf/retryCount`
- `api/server.js`：
  - `POST /api/run/:module` 返回 `retryOf/retryCount`
  - `GET /api/job/:id` 返回 `retryOf/retryCount`
  - `POST /api/job/:id/retry` 自动设置：
    - `retryOf = sourceJob.id`
    - `retryCount = sourceJob.retryCount + 1`
- `api/src/jobStore.js`：
  - memory/pg store 模型新增 `retryOf/retryCount`
  - pg schema 自动迁移：`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- `db/init.sql`：
  - `job_runs` 表定义增加 `retry_of/retry_count`
  - 增量兼容迁移 SQL 同步加入
- 测试增强：
  - 新增 `retry` 非失败任务返回 `409` 用例
  - 更新 retry 成功用例断言 `retryOf/retryCount`

### Changed Files
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/src/jobStore.js`
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/db/init.sql`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) `api` 单测
- 命令：`cd api && npm test`
- 结果：`6 passed, 0 failed`
- 新增通过：`POST /api/job/:id/retry returns 409 for non-failed jobs`

2) 运行态验证（memory queue + memory store）
- 启动：`JOB_QUEUE_MODE=memory JOB_STORE_MODE=memory npm run start`
- 验证：
  - `POST /api/run/de-enrich {engine:DEqMS}` -> `failed`, `retryCount=0`
  - `POST /api/job/:id/retry {request:{engine:limma}}` -> `202`, 返回 `retryOf=sourceId`, `retryCount=1`
  - `GET /api/job/:retryId` -> `succeeded`, 且 `retryOf/retryCount` 字段正确

### Risks / Open Questions
- 当前 `retryCount` 仅按链路递增，尚未设置系统级重试上限策略。
- `JOB_STORE_MODE=postgres` 在线验证仍依赖可用 Postgres/compose 环境。

### Next Round Options
1. 增加重试次数上限与策略（按模块/按错误类型）。
2. 增加 `POST /api/job/:id/cancel` 与状态约束（queued/running）。
3. 在 PostgreSQL store 模式下补 E2E 验证与索引优化（`status`, `created_at`）。

## Round 12

### Goal
继续完善任务控制面：新增取消接口（`cancel`）并与重试审计字段协同，形成可观测的任务生命周期管理。

### Implemented
- 新增任务取消接口：
  - `POST /api/job/:id/cancel`
- 取消语义（当前实现）：
  - `queued`：立即取消，状态变为 `canceled`
  - `running`（in-memory）：记录 `cancelRequested`，任务结束后落 `canceled`
  - `running`（bullmq）：返回 `409`（当前不支持强制中断 active worker）
  - 终态（`succeeded/failed/canceled`）：返回 `409`
  - 不存在任务：返回 `404`
- `jobManager` 三实现统一补齐 `cancelJob`：
  - `InMemoryJobManager`
  - `BullmqJobManager`
  - `ResilientJobManager`
- 新增终态判定扩展：`canceled` 作为 terminal status。
- 与 Round 11 重试字段联动：
  - `retryOf/retryCount` 在 run/retry/job 查询响应中持续保留
  - `jobStore` memory/postgres 继续持久化这些字段

### Changed Files
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/src/jobStore.js`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/db/init.sql`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 单测
- 命令：`cd api && npm test`
- 结果：`8 passed, 0 failed`
- 新增通过用例：
  - `POST /api/job/:id/cancel cancels running in-memory jobs`
  - `POST /api/job/:id/cancel returns conflict for completed jobs and 404 for unknown`

2) 运行态验证（独立端口）
- 启动：`API_PORT=4101 JOB_QUEUE_MODE=memory JOB_STORE_MODE=memory npm run start`
- 实测：
  - `POST /api/run/de-enrich {engine:DEqMS}` -> `failed`, `retryCount=0`
  - `POST /api/job/:id/retry {request:{engine:limma}}` -> 返回 `retryOf/sourceId`, `retryCount=1`
  - `GET /api/job/:retryId` -> `succeeded` 且 `retryOf/retryCount` 正确
  - `POST /api/job/:retryId/cancel` -> `409 JOB_NOT_CANCELABLE`（终态不可取消）

### Risks / Open Questions
- BullMQ active job 的“强制取消”尚未实现（当前安全策略为返回 `409`）。
- `cancelRequested` 对于长任务依赖 runner 在结束点落地，暂不支持中断 CPU 密集型执行。

### Next Round Options
1. 设计 cooperative cancel token，让长任务在步骤间可提前退出。
2. 为 bullmq 增加 queued job cancel 的 E2E（Redis 在线场景）。
3. 在 `job_runs` 增加索引与审计字段（`canceled_at`, `canceled_by`, `retry_of` 索引）。

## Round 13

### Goal
继续完善任务运维能力：增加取消审计字段（`canceledAt/canceledBy`）并把取消行为扩展到三类 job manager。

### Implemented
- `api/src/jobManager.js`
  - `cancelJob(id, { canceledBy })` 支持取消人字段
  - memory manager：
    - queued 立即 `canceled`
    - running 标记 `cancelRequested`，执行完成后落 `canceled`
  - bullmq manager：
    - queued 支持取消并落 `canceled`
    - active 任务返回 `409`（当前不支持强制中断）
  - resilient manager：统一代理 cancel 到 primary/fallback
- `api/server.js`
  - 新增 `POST /api/job/:id/cancel`（已接入 `canceledBy`）
  - run/job 响应中新增 `canceledAt/canceledBy`
  - `createApp` 支持注入 `moduleRunners`（测试可替换）
- `api/src/jobStore.js`
  - memory/postgres store 新增字段：`canceledAt/canceledBy`
  - postgres schema 自动迁移新增列
  - 新增索引：
    - `idx_job_runs_status_created_at`
    - `idx_job_runs_retry_of`
- `db/init.sql`
  - `job_runs` 表定义与增量迁移补齐 `canceled_at/canceled_by` 及索引
- 测试增强：
  - running cancel 测试校验 `canceledBy/canceledAt`
  - queued cancel 测试
  - completed/unknown cancel 冲突与 404 测试

### Changed Files
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/server.js`
- `bioid-analytics/api/src/jobStore.js`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/db/init.sql`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 单测
- 命令：`cd api && npm test`
- 结果：`9 passed, 0 failed`

2) API 运行态验证（memory queue/store）
- `POST /api/run/de-enrich`（DEqMS） -> failed，`retryCount=0`
- `POST /api/job/:id/retry`（override limma） -> 返回 `retryOf` + `retryCount=1`
- `GET /api/job/:retryId` -> succeeded，字段一致
- `POST /api/job/:retryId/cancel` -> `409 JOB_NOT_CANCELABLE`

### Risks / Open Questions
- bullmq active job 仍无强制终止（需 cooperative cancel 或 worker 中断机制）。
- `canceledBy` 当前为自由文本，尚未接身份体系校验。

### Next Round Options
1. 增加 cooperative cancel token，让长任务在步骤边界可提前退出。
2. 为 `canceledBy` 接入会话/用户上下文来源。
3. 在 PostgreSQL 模式下补充 `retry_of/canceled_by` 维度查询接口。

## Round 14

### Goal
为当前 compose 烟测链路接入 CI，并收敛 `r-engine` 分析脚本单一来源约束，避免构建漂移导致测试不稳定。

### Implemented
- 复核并对齐 GitHub Actions 工作流（已存在）：
  - `.github/workflows/compose-smoke.yml`
  - `push/pull_request (main)` 触发
  - 执行 `cd backend && npm test`
  - 使用 `docker/setup-buildx-action` + `docker/build-push-action` 构建 `r-engine`
    - `cache-from: type=gha`
    - `cache-to: type=gha,mode=max`
  - 执行 `SKIP_API=1 scripts/compose-smoke.sh`
- 修复 `r-engine` 单一来源漂移：
  - `docker-compose.yml` 中 `r-engine.build.context` 改为仓库根目录，`dockerfile` 指向 `services/r-engine/Dockerfile`
  - `services/r-engine/Dockerfile` 改为：
    - `COPY services/r-engine/app.R /app/app.R`
    - `COPY services/api/r/analysis.R /app/analysis.R`
  - 保持 `services/r-engine/analysis.R` 删除状态（由测试持续校验）
- 文档同步：
  - `README.md` 新增 CI 工作流说明（Backend test + Buildx cache + smoke）

### Changed Files
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/services/r-engine/Dockerfile`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 后端单测
- 命令：`cd backend && npm test`
- 结果：`33 passed, 0 failed`
- 包含：
  - `POST /api/config blocks illegal params`
  - `same config with fixed seed is reproducible`
  - `r-engine docker build uses services/api/r/analysis.R as single analysis source`

2) compose 脚本与配置
- 命令：`bash -n scripts/compose-smoke.sh`
- 结果：语法通过
- 命令：`docker compose --env-file .env.example config`
- 结果：通过

### Risks / Open Questions
- GitHub Actions 中 `scripts/compose-smoke.sh` 仍会再次触发 `docker compose build r-engine`；当前已通过 Buildx 预热缓存降低影响，后续可考虑在脚本中增加可选 `SKIP_BUILD=1` 路径进一步缩短时长。
- 该 CI 路径为 `SKIP_API=1`（不覆盖运行态 API 链路），全栈运行态 E2E 仍建议在后续独立 workflow 增补。

### Next Round Options
1. 在 smoke 脚本增加 `SKIP_BUILD=1`，CI 仅执行配置检查并复用 Buildx 预构建结果。
2. 新增 compose 全栈 E2E workflow（启动 postgres/redis/services/r-engine/api 后执行完整 `scripts/compose-smoke.sh`）。
3. 为 `api` 服务补充与 `services/api/r/analysis.R` 相同的单一来源约束测试。

## Round 15

### Goal
完成运行态修复闭环：修复 compose 健康检查误判、稳定 smoke 验证路径，并确认六服务可健康启动。

### Implemented
- `docker-compose.yml`
  - `api` healthcheck 从 `curl` 改为 Node `fetch`（避免 `node:alpine` 无 `curl` 导致常驻 `starting`）
  - `frontend` healthcheck 地址改为 `127.0.0.1:5173`（避免 `localhost` 走 IPv6 造成误判）
  - `r-engine` build context 统一为 `./r-engine`（与当前 Dockerfile 的 `COPY app.R/analysis.R` 一致）
- `services/r-engine/Dockerfile`
  - 启动命令修正为 `pr <- plumber::pr(...); pr$run(...)`，消除 `pr_run` 未解析导致的启动失败
- `scripts/compose-smoke.sh`
  - 新增 `SKIP_BUILD=1` 选项，用于运行态回归时跳过耗时镜像构建

### Changed Files
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/services/r-engine/Dockerfile`
- `bioid-analytics/scripts/compose-smoke.sh`
- `bioid-analytics/docs/devlog.md`
- `bioid-analytics/docs/review-log.md`

### Validation
执行时间：2026-02-21

1) 服务启动与健康状态
- 命令：`docker compose --env-file .env.example up -d`
- 命令：`docker compose --env-file .env.example ps`
- 结果：`postgres/redis/minio/r-engine/api/frontend` 全部 `healthy`

2) 运行态烟测（跳过构建）
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS（health、analysis、artifact 下载、session/upload/delete 全链路通过）

3) 审查门禁
- 命令：`scripts/review-gate.sh runtime-acceptance-rerun`
- 结果：PASS

### Risks / Open Questions
- `r-engine` 全量 Bioconductor 依赖构建仍重且有外部源波动风险（曾观察到 `SSL connect error`）；建议在下一轮将 Bioc 包安装改为按需或预构建镜像层。

### Next Round Options
1. 拆分 `r-engine` 轻量运行镜像和重分析镜像（按任务类型切换）。
2. 在 CI 中默认使用 `SKIP_BUILD=1` 路径，将重构建放到独立 nightly job。
3. 给 `frontend` 增加一个显式 `/health` 路由，避免依赖首页响应判活。

## Round 16

### Goal
收敛 CI 烟测耗时：避免在 workflow 中重复执行 `r-engine` 构建。

### Implemented
- 调整 `.github/workflows/compose-smoke.yml`：
  - 保留 `docker/build-push-action` 的 Buildx 构建与 `gha` 缓存预热。
  - smoke 步骤改为：
    - `SKIP_API=1`
    - `SKIP_BUILD=1`
  - step 名称更新为 `Compose smoke (config only)`。
- 同步 `README.md` 的 CI 说明，明确 smoke 使用 `SKIP_API=1 SKIP_BUILD=1`。

### Changed Files
- `bioid-analytics/.github/workflows/compose-smoke.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) smoke（配置路径）
- 命令：`SKIP_API=1 SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS
  - `[smoke] compose config`
  - `[smoke] SKIP_BUILD=1, skip compose build`
  - `[smoke] SKIP_API=1, skip runtime API checks`

### Risks / Open Questions
- 当前 workflow 仍不覆盖运行态 API 链路（仅配置路径门禁）；完整链路需单独全栈 E2E 任务。

### Next Round Options
1. 新增 nightly full-smoke（含 `docker compose up -d` + 运行态 API 校验）。
2. 将 `backend npm test` 与 `compose-smoke` 拆成并行 job，缩短 PR 等待时间。
3. 为 full-smoke 增加超时与失败日志采集（`docker compose logs` artifact）。

## Round 17

### Goal
补齐 CI 运行态覆盖：在独立 workflow 中定时执行 full-stack compose + API smoke，并保留失败现场日志。

### Implemented
- 新增 `.github/workflows/full-smoke-nightly.yml`：
  - 触发方式：
    - `schedule`: 每日 `03:00 UTC`
    - `workflow_dispatch`: 手动触发
  - 执行路径：
    - `docker compose --env-file .env.example up -d --build`
    - `docker compose --env-file .env.example ps`
    - `SKIP_BUILD=1 scripts/compose-smoke.sh`（运行态链路）
  - 失败排查：
    - 采集 `ps/logs/images` 到 `/tmp/compose-logs`
    - 使用 `actions/upload-artifact@v4` 上传 `compose-logs`（保留 7 天）
  - 结束清理：
    - `docker compose down -v --remove-orphans`（`if: always()`）
- 同步 `README.md` CI 章节，新增 nightly full-smoke 说明。

### Changed Files
- `bioid-analytics/.github/workflows/full-smoke-nightly.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) compose 配置
- 命令：`docker compose --env-file .env.example config`
- 结果：通过

2) 运行态 smoke（本地）
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS（health/analysis/artifact/session/upload/delete 全链路通过）

3) 后端回归
- 命令：`cd backend && npm test`
- 结果：`33 passed, 0 failed`

### Risks / Open Questions
- full-stack nightly 仍依赖外部镜像/包源稳定性（特别是 R 依赖下载）；若出现偶发网络失败，建议后续补重试或预构建镜像策略。

### Next Round Options
1. 为 full-smoke workflow 增加失败重试（仅对 `compose up` 阶段）。
2. 将 `compose-smoke` 与 `full-smoke-nightly` 的日志采集脚本抽成复用脚本。
3. 增加 `workflow_dispatch` 输入参数（是否启用 enrichment 重依赖构建）。

## Round 18

### Goal
提高 nightly full-smoke 的抗抖动能力与排障一致性：为 `compose up` 增加重试，并把日志采集下沉为复用脚本。

### Implemented
- 新增 `scripts/compose-up-retry.sh`
  - 支持 `COMPOSE_UP_RETRIES`（默认 `1`）与 `COMPOSE_UP_RETRY_DELAY_SEC`（默认 `30`）。
  - 执行 `docker compose --env-file .env.example up -d --build` 的重试封装。
- 新增 `scripts/collect-compose-logs.sh`
  - 统一采集 `ps/logs/images/config` 到目标目录（默认 `/tmp/compose-logs`）。
- 更新 `.github/workflows/full-smoke-nightly.yml`
  - `Compose up` 步骤改为调用 `scripts/compose-up-retry.sh`。
  - `Collect compose logs` 步骤改为调用 `scripts/collect-compose-logs.sh /tmp/compose-logs`。
  - `workflow_dispatch` 新增输入：
    - `install_enrichment`（`0/1`）
  - 手动触发时可设置 `R_ENGINE_INSTALL_ENRICHMENT_PACKAGES=1`。
- 更新 `README.md` CI 章节，补充上述重试/日志脚本与手动输入说明。

### Changed Files
- `bioid-analytics/scripts/compose-up-retry.sh`
- `bioid-analytics/scripts/collect-compose-logs.sh`
- `bioid-analytics/.github/workflows/full-smoke-nightly.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 脚本语法
- 命令：`bash -n scripts/compose-up-retry.sh scripts/collect-compose-logs.sh`
- 结果：通过

2) 日志采集脚本
- 命令：`scripts/collect-compose-logs.sh /tmp/compose-logs-test`
- 结果：通过（生成 `ps.txt/services.log/images.txt/config.yml`）

3) 运行态 smoke
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS

4) 后端回归
- 命令：`cd backend && npm test`
- 结果：`33 passed, 0 failed`

### Risks / Open Questions
- `compose up` 重试可缓解临时网络抖动，但无法覆盖长期上游源不可用场景；后续仍建议引入预构建镜像或私有缓存源。

### Next Round Options
1. 给 `compose-up-retry.sh` 增加按错误类型快速失败（如配置错误不重试）。
2. 在 nightly 中上传 `docker compose events` 输出，增强时序定位能力。
3. 给 `install_enrichment` 触发路径补一次独立周跑（weekly）任务，避免日常 nightly 变慢。

## Round 19

### Goal
继续提高 CI 稳定性与可观测性：实现 `compose up` 快速失败、补齐 compose events 采集、并新增 weekly enrichment full-smoke。

### Implemented
- `scripts/compose-up-retry.sh`
  - 新增 preflight：
    - `docker info` 可用性检查
    - `docker compose config` 配置检查（失败直接退出，不重试）
  - 新增非重试错误匹配：
    - `COMPOSE_UP_NON_RETRYABLE_REGEX`
    - 命中后立即停止重试并失败返回
  - 每次 `compose up` 输出重定向到临时日志，失败时回放日志后再决策是否重试。
- `scripts/collect-compose-logs.sh`
  - 新增 `events` 采集：
    - `docker compose events --json --since --until > events.jsonl`
    - 支持 `timeout`（可用时）防止挂起
  - 现统一产出：`ps.txt/services.log/images.txt/config.yml/events.jsonl`
- 新增 `.github/workflows/full-smoke-enrichment-weekly.yml`
  - 触发：每周 `04:00 UTC`（周日）+ 手动触发
  - 固定 `R_ENGINE_INSTALL_ENRICHMENT_PACKAGES=1`
  - 复用 `scripts/compose-up-retry.sh` 与 `scripts/collect-compose-logs.sh`
  - 上传 artifact：`compose-logs-enrichment`
- 更新 `README.md` CI 章节：
  - nightly artifact 说明增加 `events`
  - 新增 weekly enrichment workflow 描述

### Changed Files
- `bioid-analytics/scripts/compose-up-retry.sh`
- `bioid-analytics/scripts/collect-compose-logs.sh`
- `bioid-analytics/.github/workflows/full-smoke-enrichment-weekly.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 脚本语法
- 命令：`bash -n scripts/compose-up-retry.sh scripts/collect-compose-logs.sh`
- 结果：通过

2) 快速失败路径（compose_up_retry）
- 命令：`COMPOSE_ENV_FILE=.env.missing COMPOSE_UP_RETRIES=3 scripts/compose-up-retry.sh`
- 结果：在 preflight `compose config` 阶段直接失败（未进入重试循环）

3) 日志采集脚本
- 命令：`scripts/collect-compose-logs.sh /tmp/compose-logs-test2`
- 结果：通过，输出包含 `events.jsonl`

4) 运行态 smoke
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS

5) 后端回归
- 命令：`cd backend && npm test`
- 结果：`33 passed, 0 failed`

### Risks / Open Questions
- `events.jsonl` 在部分 Docker 状态下可能只记录错误信息（如镜像缺失），但依然有助于定位构建/运行期异常。

### Next Round Options
1. 把 `COMPOSE_UP_NON_RETRYABLE_REGEX` 外置到 `.env.example`，便于 CI 无代码调整。
2. 在 weekly enrichment workflow 增加 `backend npm test` 前置门禁。
3. 对 `compose-logs` artifact 增加大小裁剪策略（避免极端日志过大）。

## Round 20

### Goal
继续收口 CI 配置化与门禁顺序：把 non-retryable 规则外置配置，并在 weekly enrichment 链路前置 backend 回归测试。

### Implemented
- 更新 `.env.example`
  - 新增 `COMPOSE_UP_NON_RETRYABLE_REGEX`，供 `scripts/compose-up-retry.sh` 读取并在 CI 中无代码调整。
- 更新 `.github/workflows/full-smoke-enrichment-weekly.yml`
  - `setup-node` 增加 npm cache（`services/api/package-lock.json`）
  - 新增前置步骤：
    - `Install backend dependencies`（`cd backend && npm ci`）
    - `Run backend tests`（`cd backend && npm test`）
  - 再执行 enrichment 栈 full-smoke，降低“明显回归却继续起全栈”的浪费。
- 更新 `README.md`
  - 补充 weekly enrichment workflow 的 backend 前置门禁说明。

### Changed Files
- `bioid-analytics/.env.example`
- `bioid-analytics/.github/workflows/full-smoke-enrichment-weekly.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) compose 配置
- 命令：`docker compose --env-file .env.example config`
- 结果：通过

2) 运行态 smoke
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS

3) 后端回归
- 命令：`cd backend && npm test`
- 结果：`33 passed, 0 failed`

### Risks / Open Questions
- weekly workflow 增加 `npm ci + npm test` 后总时长上升；若队列拥堵，可考虑把 test 结果通过 needs 复用给其它 workflow。

### Next Round Options
1. 为 `compose-logs` 增加大小上限（大日志仅保留 tail + 关键索引）。
2. 将 `COMPOSE_UP_NON_RETRYABLE_REGEX` 拆分为多条可读规则并在脚本内拼接。
3. 给 nightly/weekly workflow 增加 `concurrency`，避免同类任务并发互相抢占资源。

## Round 21

### Goal
完善 CI 稳定性细节：控制同类 workflow 并发冲突，并为 compose 日志 artifact 加体积裁剪。

### Implemented
- 更新 `scripts/collect-compose-logs.sh`
  - 新增日志裁剪参数：
    - `COMPOSE_LOG_MAX_FILE_BYTES`（默认 `5MB`）
    - `COMPOSE_LOG_TAIL_BYTES`（默认 `256KB`）
  - 对 `services.log` 与 `events.jsonl` 超限文件自动裁剪（保留尾部并写入截断说明）。
  - 新增 `manifest.txt`，记录关键输出文件字节数和裁剪配置。
- 更新 workflow 并发策略：
  - `.github/workflows/compose-smoke.yml`
    - `concurrency.group: compose-smoke-${{ github.ref }}`
    - `cancel-in-progress: true`
  - `.github/workflows/full-smoke-nightly.yml`
    - `concurrency.group: full-smoke-nightly`
    - `cancel-in-progress: false`
  - `.github/workflows/full-smoke-enrichment-weekly.yml`
    - `concurrency.group: full-smoke-enrichment-weekly`
    - `cancel-in-progress: false`
- 更新 `README.md`
  - CI 章节补充日志裁剪行为与可调参数说明。
  - 补充 nightly/weekly 并发策略说明。

### Changed Files
- `bioid-analytics/scripts/collect-compose-logs.sh`
- `bioid-analytics/.github/workflows/compose-smoke.yml`
- `bioid-analytics/.github/workflows/full-smoke-nightly.yml`
- `bioid-analytics/.github/workflows/full-smoke-enrichment-weekly.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-22

1) 脚本语法与 compose 配置
- 命令：`bash -n scripts/collect-compose-logs.sh scripts/compose-up-retry.sh`
- 结果：通过
- 命令：`docker compose --env-file .env.example config`
- 结果：通过

2) 日志裁剪验证
- 命令：`COMPOSE_LOG_MAX_FILE_BYTES=200 COMPOSE_LOG_TAIL_BYTES=80 scripts/collect-compose-logs.sh /tmp/compose-logs-trimtest`
- 结果：通过，`services.log/events.jsonl` 出现 `truncated` 头并保留尾部，`manifest.txt` 记录大小

3) 运行态 smoke
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS

4) 后端回归
- 命令：`cd backend && npm test`
- 结果：`33 passed, 0 failed`

### Risks / Open Questions
- 当前裁剪策略按“字节尾部”保留，JSON 行边界可能被截断；已在文件头写明 truncation 信息，后续可按行裁剪优化可读性。

### Next Round Options
1. 将 `manifest.txt` 增加 SHA256，便于 artifact 完整性对比。
2. 按文件类型细化裁剪阈值（例如 `events.jsonl` 单独更大阈值）。
3. 在 weekly workflow 增加 `concurrency` 与 schedule 说明到 `docs/review-protocol.md`。

## Round 22

### Goal
完成日志产物可追溯增强：为 `manifest` 增加 SHA256，支持 `services/events` 分文件阈值，并在 nightly/weekly workflow 输出可读 summary。

### Implemented
- 更新 `scripts/collect-compose-logs.sh`
  - 新增分文件阈值参数：
    - `COMPOSE_LOG_MAX_SERVICES_BYTES`
    - `COMPOSE_LOG_MAX_EVENTS_BYTES`
    - `COMPOSE_LOG_TAIL_SERVICES_BYTES`
    - `COMPOSE_LOG_TAIL_EVENTS_BYTES`
  - `manifest.txt` 增强：
    - 记录裁剪配置
    - 记录 `ps/services/images/config/events` 的 `bytes + sha256`
  - 增加 `sha256sum/shasum` 兼容逻辑（跨 Linux/macOS）
- 更新 workflow：
  - `.github/workflows/full-smoke-nightly.yml`
    - `Collect compose logs` 步骤传入分文件阈值（events 更高上限）
    - 新增 `Publish smoke summary`，把 `manifest` 摘要写入 `GITHUB_STEP_SUMMARY`
  - `.github/workflows/full-smoke-enrichment-weekly.yml`
    - 同步分文件阈值
    - 新增 `Publish smoke summary`
- 更新 `.env.example`
  - 补齐日志裁剪相关默认参数，便于 CI/本地直接覆盖。
- 更新 `README.md`
  - CI 章节补充：分文件裁剪、`manifest` 的 SHA256、workflow summary 可见性。

### Changed Files
- `bioid-analytics/scripts/collect-compose-logs.sh`
- `bioid-analytics/.github/workflows/full-smoke-nightly.yml`
- `bioid-analytics/.github/workflows/full-smoke-enrichment-weekly.yml`
- `bioid-analytics/.env.example`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-22

1) 脚本语法
- 命令：`bash -n scripts/collect-compose-logs.sh scripts/compose-up-retry.sh`
- 结果：通过

2) 分文件裁剪 + SHA256 验证
- 命令：`COMPOSE_LOG_MAX_SERVICES_BYTES=200 COMPOSE_LOG_TAIL_SERVICES_BYTES=80 COMPOSE_LOG_MAX_EVENTS_BYTES=400 COMPOSE_LOG_TAIL_EVENTS_BYTES=120 scripts/collect-compose-logs.sh /tmp/compose-logs-trimtest4`
- 结果：
  - `services.log/events.jsonl` 按各自阈值裁剪
  - `manifest.txt` 包含每个文件的 `bytes + sha256`

3) compose 配置与运行态 smoke
- 命令：`docker compose --env-file .env.example config`
- 结果：通过
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS

4) 后端回归
- 命令：`cd backend && npm test`
- 结果：`33 passed, 0 failed`

### Risks / Open Questions
- 当前裁剪策略仍是“字节尾部”保留，结构化日志（JSONL）可能出现截断行；如需机器解析严格性，可在后续改为按行裁剪并保留完整 JSON 边界。

### Next Round Options
1. 在 `manifest.txt` 中追加 `truncated=true/false` 标记，便于自动化判读。
2. 将 weekly/nightly 的裁剪参数抽到共享 env 配置块，减少 workflow 重复。
3. 在 `docs/review-protocol.md` 增补并发/summary 检查项。

## Round 4 (API Refresh)

### Goal
继续第 4 阶段实现收口（`api/` 服务）：
- 支持多 DE 引擎入口（`limma/DEqMS/MSstats/SAM/RankProd`，先打通 `limma`）
- 落地 `POST /api/run/:module`、`GET /api/job/:id`
- 接入 GO/KEGG（`clusterProfiler`，本地计算链路）
- 跑通端到端任务并输出关键结果字段与日志

### Implemented
- `api/src/modules/deEnrich.js`
  - 保持多引擎入口校验：`limma/DEqMS/MSstats/SAM/RankProd`
  - 仅 `limma` 落地，其他入口返回 `ENGINE_NOT_IMPLEMENTED`
  - `de/enrichment/de-enrich` 三模块全部接入取消上下文（`context.throwIfCanceled`）
  - JS fallback 在循环计算中加取消检查，避免取消后继续长计算
- `api/src/jobManager.js`
  - In-memory 任务执行新增协作取消控制器（`AbortController`）
  - running 任务收到 cancel 时触发 `abort()`，runner 可即时退出
  - 统一识别 `JOB_CANCELED/AbortError` 并落库为 `canceled`
- `api/src/rRunner.js`
  - R 执行链路升级为：
    - 先尝试远端 `R_ENGINE_URL`
    - 失败后尝试本地 `Rscript`（可关：`R_ENGINE_LOCAL_DISABLE=1`）
    - 均失败再抛错，由模块层回退 JS
  - 远端 `fetch` 与本地 `Rscript` 子进程都接入取消信号
- `api/r/local_de-enrich.R`
  - 新增本地 R 入口脚本：读取 stdin JSON，调用 `services/api/r/analysis.R::run_de_enrich_pipeline`
  - 输出统一 JSON（`ok/meta/result`），用于本地 clusterProfiler 计算链路
- `api/test/deEnrich.api.test.js`
  - running cancel 用例升级为协作式长任务，校验中途取消不会执行到“slow task finished”

### Changed Files
- `bioid-analytics/api/src/jobManager.js`
- `bioid-analytics/api/src/modules/deEnrich.js`
- `bioid-analytics/api/src/rRunner.js`
- `bioid-analytics/api/r/local_de-enrich.R`
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 单测
- 命令：`cd api && npm test`
- 结果：`9 passed, 0 failed`

2) 端到端任务（memory queue/store）
- 启动命令：`cd api && API_PORT=4101 JOB_QUEUE_MODE=memory JOB_STORE_MODE=memory npm run start`
- 执行命令：`API_URL=http://127.0.0.1:4101 api/scripts/e2e-round4.sh`
- 结果：PASS（job 首轮即 `succeeded`）

关键结果字段（`module=de-enrich`, `engine=limma`）：
- `status=succeeded`
- `result.de.summary.totalGenes=20`
- `result.de.summary.significantGenes=14`
- `result.enrichment.go[0].id=GO:0006954`
- `result.enrichment.kegg[0].id=hsa04151`
- `result.runtime.backend=JS_FALLBACK`
- `result.runtime.deEngine=limma-approx`
- `result.runtime.enrichmentEngine=hypergeom-lite`

关键日志行（同一 job）：
- `Running limma + clusterProfiler via R runtime`
- `R_ENGINE_URL is not configured, skipping remote r-engine`
- `Trying local Rscript runner: .../api/r/local_de-enrich.R`
- `Local Rscript runner failed: Rscript command not found`
- `R chain unavailable, fallback to JS: R runtime unavailable: local=Rscript command not found`
- `Job completed`

3) 多引擎入口校验（`DEqMS`）
- `POST /api/run/de-enrich {"engine":"DEqMS"}` -> job `failed`
- `error.code=ENGINE_NOT_IMPLEMENTED`

### Risks / Open Questions
- 当前机器无 `Rscript`，本轮 E2E 仍走 JS fallback；真实 `clusterProfiler` 产出需在具备 R 环境时复测。
- BullMQ active job 仍不支持强制终止（当前协作取消实现覆盖 in-memory runner）。

### Next Round Options
1. 在运行环境安装 `Rscript + clusterProfiler + org.Hs.eg.db`，验证本地 R 分支真实产出。
2. 为 BullMQ worker 引入可中断执行协议（跨进程 cancel token / heartbeat 终止）。
3. 为 `de/enrichment` 增加 R 分支的契约测试（字段完整性与 GO/KEGG 结果结构）。

## Round 4 (API Verification Boost)

### Goal
继续第 4 阶段验证闭环：
- 增加 `runtime=R` 自动化验证（避免仅覆盖 JS fallback）
- 强化 e2e 输出，直接给出关键结果字段与日志摘要

### Implemented
- `api/test/deEnrich.api.test.js`
  - 新增 mock r-engine HTTP 服务（`/run/de-enrich`）
  - 新增用例：`POST /api/run/de-enrich uses remote r-engine when available`
    - 断言 `runtime.backend=R`
    - 断言 `runtime.deEngine=limma`
    - 断言 `runtime.enrichmentEngine=clusterProfiler`
    - 断言 GO/KEGG 关键字段存在（`go[0].id`、`kegg[0].id`）
    - 断言日志含 `Remote r-engine completed` 且无 fallback
- `api/scripts/e2e-round4.sh`
  - 新增 `extract_highlights` 输出：
    - `status/module/engine/retryCount`
    - `runtimeBackend/deSignificantGenes/goTopId/keggTopId/errorCode`
    - `logHighlights`（关键日志摘要）
  - 终态判断扩展为 `succeeded|failed|canceled`
  - 新增 `ASSERT_GO_KEGG=1` 开关：对 `goTopId/keggTopId` 做非空断言
  - 新增 `EXPECT_GO_ID/EXPECT_KEGG_ID` 开关：对 top id 做精确匹配断言

### Changed Files
- `bioid-analytics/api/test/deEnrich.api.test.js`
- `bioid-analytics/api/scripts/e2e-round4.sh`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 单测
- 命令：`cd api && npm test`
- 结果：`10 passed, 0 failed`
- 新增通过用例：
  - `POST /api/run/de-enrich uses remote r-engine when available`

2) 端到端脚本（关键输出增强）
- 命令：`API_URL=http://127.0.0.1:4101 api/scripts/e2e-round4.sh`
- 输出新增示例：
  - `highlights={"status":"succeeded","module":"de-enrich","engine":"limma","runtimeBackend":"JS_FALLBACK","deSignificantGenes":14,"goTopId":"GO:0006954","keggTopId":"hsa04151","errorCode":null,...}`
- 命令：`API_URL=http://127.0.0.1:4101 ASSERT_GO_KEGG=1 api/scripts/e2e-round4.sh`
- 结果：通过（GO/KEGG 非空断言命中）
- 命令：`API_URL=http://127.0.0.1:4101 ASSERT_GO_KEGG=1 EXPECT_GO_ID=GO:0006954 EXPECT_KEGG_ID=hsa04151 api/scripts/e2e-round4.sh`
- 结果：通过（GO/KEGG top id 精确匹配）
- 命令：`bash -n api/scripts/e2e-round4.sh`
- 结果：语法通过

### Risks / Open Questions
- mock r-engine 用例验证了 API 合约与 R 分支路由，不等价于真实 `clusterProfiler` 生物学结果正确性；真实结果仍需在具备 R 包环境复测。

### Next Round Options
1. 在可用 R 环境执行一次 `EXPECT_RUNTIME=R` 的真实 e2e，并固化输出快照。
2. 在 CI 增加轻量 mock-r-engine 流水线，持续校验 R 分支协议兼容性。
3. 给 e2e 增加“日志关键字必须命中”断言开关（例如 `EXPECT_LOG=Remote r-engine completed`）。

## Progress Monitor

### Goal
提供可重复执行的“当前开发进度监控”入口，减少手工汇总成本并统一汇报口径。

### Implemented
- 新增 `scripts/progress-monitor.sh`：
  - 输出默认文件：`docs/PROGRESS_STATUS.md`
  - 采集项：`git` 变更规模、目录热度分布、最新 DEVLOG 节点、测试状态、review gate、compose smoke、运行中服务数、阻塞项
  - 支持开关：
    - `RUN_TESTS=0`：跳过 `api/backend` 测试
    - `RUN_GATE=0`：跳过 `review-gate`
    - `RUN_SMOKE=0`：跳过 `compose-smoke`
- 更新 `README.md` 与 `docs/version-control.md`，补充进度快照命令和常用开关示例。

### Changed Files
- `bioid-analytics/scripts/progress-monitor.sh`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 语法检查
- 命令：`bash -n scripts/progress-monitor.sh`
- 结果：通过

2) 快照生成
- 命令：`scripts/progress-monitor.sh`
- 结果：生成 `docs/PROGRESS_STATUS.md`

### Risks / Open Questions
- 默认会执行测试与烟测；在开发机器资源紧张或服务未启动时，建议先使用 `RUN_SMOKE=0` 或 `RUN_TESTS=0` 快速模式。

### Next Round Options
1. 增加 `--json` 输出，便于接入 CI 或看板系统。
2. 增加与上一份快照的 diff（新增阻塞项/解除阻塞项）。
3. 将关键指标（测试耗时、改动规模）做趋势线可视化。

## Progress Monitor v2

### Goal
把进度监控升级为可机读与可追踪：支持 JSON 输出、与上一快照差异对比，并接入 CI 定时执行。

### Implemented
- 升级 `scripts/progress-monitor.sh`：
  - 新增 JSON 产物（默认 `docs/PROGRESS_STATUS.json`）
  - 新增 `PREV_JSON_FILE` 比较逻辑，输出 `delta`（改动规模变化、阻塞项新增/解除、状态切换）
  - 新增临时文件自动清理（`trap cleanup EXIT`）
- 新增 CI 工作流：
  - `.github/workflows/progress-monitor.yml`
  - 触发：`push main`、`workflow_dispatch`、nightly cron
  - 产物：上传 `docs/PROGRESS_STATUS.md` 与 `docs/PROGRESS_STATUS.json`
  - 在 Actions Summary 展示 Markdown 快照
- 更新文档：
  - `README.md` 增加 JSON 与 `PREV_JSON_FILE` 用法
  - `docs/version-control.md` 增加进度快照产物与对比说明

### Changed Files
- `bioid-analytics/scripts/progress-monitor.sh`
- `bioid-analytics/.github/workflows/progress-monitor.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 语法检查
- 命令：`bash -n scripts/progress-monitor.sh`
- 结果：通过

2) 本地快照
- 命令：`RUN_SMOKE=0 scripts/progress-monitor.sh`
- 结果：生成 `docs/PROGRESS_STATUS.md` 与 `docs/PROGRESS_STATUS.json`

3) JSON 差异字段验证
- 命令：`rg -n '"delta"|overall_status|blockers' docs/PROGRESS_STATUS.json`
- 结果：包含 `overall_status`、`blockers` 与 `delta.since_previous_snapshot`

### Risks / Open Questions
- `push main` 触发会带来较高频快照任务；若后续 CI 成本上升，可改为 `schedule + manual`。

### Next Round Options
1. 增加 `--strict` 模式：存在 blocker 时脚本返回非 0，直接作为 CI gate。
2. 输出 Prometheus-friendly 指标文件（`key=value`）供监控系统拉取。
3. 在 JSON 中加入近 7 天趋势聚合（需保留历史快照目录）。

## Progress Monitor v3

### Goal
把进度监控升级为“可门禁 + 可趋势”：支持严格失败策略、历史快照归档、趋势聚合报告。

### Implemented
- 升级 `scripts/progress-monitor.sh`：
  - 新增 `STRICT_MODE=1`：当存在 blocker 或状态为 `BLOCKED_*` 时返回非 0
  - 新增历史归档：`SAVE_HISTORY=1` 时写入 `docs/progress_history/<timestamp>.md|json`，并刷新 `latest.md|json`
  - 新增趋势报告：自动生成 `docs/PROGRESS_TREND.md`（状态分布、平均改动量、阻塞占比、最近快照表）
  - JSON 新增 `monitor_config` 字段，记录 strict/history/trend 配置
  - 修正规则：`RUN_SMOKE=0` 时不再因为“无运行容器”误判 blocker
- 更新 CI：
  - `.github/workflows/progress-monitor.yml` 开启 `STRICT_MODE=1`
  - 上传新增产物：`docs/PROGRESS_TREND.md`、`docs/progress_history`
- 更新文档：
  - `README.md` 增加 strict/history/trend 示例
  - `docs/version-control.md` 增加 strict gate 与趋势说明

### Changed Files
- `bioid-analytics/scripts/progress-monitor.sh`
- `bioid-analytics/.github/workflows/progress-monitor.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 语法检查
- 命令：`bash -n scripts/progress-monitor.sh`
- 结果：通过

2) 严格模式快照（跳过 smoke）
- 命令：`STRICT_MODE=1 RUN_SMOKE=0 scripts/progress-monitor.sh`
- 结果：通过，生成：
  - `docs/PROGRESS_STATUS.md`
  - `docs/PROGRESS_STATUS.json`
  - `docs/PROGRESS_TREND.md`
  - `docs/progress_history/*.md|json`

3) 趋势与配置字段检查
- 命令：`rg -n '"monitor_config"|"delta"' docs/PROGRESS_STATUS.json && rg -n '^# Development Progress Trend|^## Summary' docs/PROGRESS_TREND.md`
- 结果：字段与趋势摘要存在

4) 严格模式 + smoke 运行态验证
- 命令：`STRICT_MODE=1 RUN_SMOKE=1 SMOKE_SKIP_BUILD=1 scripts/progress-monitor.sh`
- 结果：通过，`compose smoke=PASS`，`overall status=CODE_HEALTHY`

### Risks / Open Questions
- 历史快照目录会持续增长；建议后续加保留策略（按天数或按数量清理）。

### Next Round Options
1. 增加 `HISTORY_RETENTION_DAYS` 自动清理逻辑。
2. 增加 metrics 文件输出（便于 Prometheus/Grafana）。
3. 在趋势报告加入阻塞项 TopN。

## Round 4 (CI Gate Automation)

### Goal
把第 4 阶段 API 链路固化为 CI 门禁，持续验证：
- `POST /api/run/:module` + `GET /api/job/:id` 端到端可用
- limma + GO/KEGG 结果结构字段完整
- `runtime=R` 分支不会因环境差异漂移

### Implemented
- 新增 mock r-engine 脚本：
  - `api/scripts/mock-r-engine.js`
  - 提供 `/health` 与 `/run/de-enrich`，返回稳定的 limma + GO/KEGG 结果
- 新增 round4 CI 本地/流水线入口：
  - `api/scripts/ci-round4-mock-remote.sh`
  - 自动启动 mock r-engine 与 api，执行 `api/scripts/e2e-round4.sh` 并断言：
    - `EXPECT_RUNTIME=R`
    - `ASSERT_GO_KEGG=1`
    - `EXPECT_GO_ID=GO:0006954`
    - `EXPECT_KEGG_ID=hsa04060`
  - 支持 `LOG_DIR` 外部注入并自动创建目录，便于 CI artifact 收集
  - 失败时自动输出 `api.log` 与 `mock-r-engine.log`
- `api/package.json`
  - 新增脚本：`npm run ci:round4`
- 新增 GitHub Actions workflow：
  - `.github/workflows/api-round4.yml`
  - 在 `push/pull_request (main)` 执行：
    - `cd api && npm ci && npm test`
    - `cd api && npm run ci:round4`
  - 增加 `paths` 过滤，仅在 `api/**` 和相关文档/workflow 变更时触发
  - 新增 `api-round4-logs` artifact 上传（保留 7 天）
- `api/scripts/e2e-round4.sh`
  - 增加 `EXPECT_GO_ID` / `EXPECT_KEGG_ID` 精确匹配断言开关
  - 增加 `EXPECT_LOGS` 日志关键字断言开关（逗号分隔）
  - 增加 `EXPECT_LOGS_ORDERED=1`，按日志出现顺序匹配关键字序列
  - 增加 `EXPECT_LOGS_ABSENT`，断言禁止出现的日志关键字（逗号分隔）
- `README.md`
  - 新增 `api-round4` workflow 说明与断言项说明

### Changed Files
- `bioid-analytics/api/scripts/mock-r-engine.js`
- `bioid-analytics/api/scripts/ci-round4-mock-remote.sh`
- `bioid-analytics/api/scripts/e2e-round4.sh`
- `bioid-analytics/api/package.json`
- `bioid-analytics/.github/workflows/api-round4.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) round4 CI gate（本地模拟）
- 命令：`cd api && npm run ci:round4`
- 结果：PASS
- 关键输出：
  - `runtime=R significantGenes=3`
  - `goTopId=GO:0006954`
  - `keggTopId=hsa04060`
  - `logHighlights` 包含 `Remote r-engine completed`
- 断言项包含：
  - `EXPECT_LOGS="Running limma + clusterProfiler via R runtime,Remote r-engine completed"`
  - `EXPECT_LOGS_ORDERED=1`
  - `EXPECT_LOGS_ABSENT="fallback,R chain unavailable,Local Rscript runner failed"`

2) API 单测
- 命令：`cd api && npm test`
- 结果：`10 passed, 0 failed`

3) 脚本语法
- 命令：`bash -n api/scripts/e2e-round4.sh`
- 结果：通过
- 命令：`bash -n api/scripts/ci-round4-mock-remote.sh`
- 结果：通过

4) 日志目录与 artifact 预演
- 命令：`LOG_DIR=/tmp/api-round4-logs-local npm run ci:round4`
- 结果：通过，生成：
  - `/tmp/api-round4-logs-local/api.log`
  - `/tmp/api-round4-logs-local/mock-r-engine.log`

### Risks / Open Questions
- 当前 CI gate 使用 mock r-engine 验证协议与字段，不覆盖真实 `clusterProfiler` 统计结果正确性；真实 R 包链路仍建议保留 nightly/full-smoke 复测。

### Next Round Options
1. 在具备 R 依赖的 runner 上补一条真实 `Rscript` 分支用例，和 mock 分支并行验证。
2. 在 `api-round4.yml` 增加手动参数化触发（可切换 mock/real 两种模式）。
3. 为 `EXPECT_LOGS_ABSENT` 增加严格顺序反向检查（在关键路径间禁止插入异常日志）。

## Round 6 (r-engine Build Profile Hardening)

### Goal
降低 `r-engine` 默认构建复杂度并保留可选富集能力，同时完成运行态复验与审查闭环。

### Implemented
- `r-engine` 默认构建为轻量模式（核心 API 依赖 + `limma`）。
- 富集重依赖改为可选开关：
  - `R_ENGINE_INSTALL_ENRICHMENT_PACKAGES=0|1`
  - 打开后才安装 `clusterProfiler` 与 `org.Hs.eg.db`
- 在 `docker-compose.yml` 透传 `R_ENGINE_CRAN_REPO` 与 `R_ENGINE_INSTALL_ENRICHMENT_PACKAGES` 构建参数。
- 在 `.env.example` 增加默认值与注释，明确“默认轻量 / 可选全量”。
- README 新增：
  - `SKIP_BUILD=1 scripts/compose-smoke.sh`
  - 启用富集重依赖的构建方式

### Changed Files
- `bioid-analytics/services/r-engine/Dockerfile`
- `bioid-analytics/docker-compose.yml`
- `bioid-analytics/.env.example`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 镜像构建（轻量模式）
- 命令：`docker compose --env-file .env.example build r-engine`
- 结果：PASS（镜像构建成功）

2) 服务启动（复用已构建镜像）
- 命令：`docker compose --env-file .env.example up -d r-engine`
- 结果：PASS（`r-engine` 启动并进入 `healthy`）

3) 六服务运行态冒烟
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：PASS（全链路通过）

4) 异常记录
- 命令：`docker compose --env-file .env.example up -d --build r-engine`
- 结果：两次出现退出码 `130`（外部中断，均发生在长编译阶段；非业务逻辑断言失败）

### Risks / Open Questions
- `r-engine` 在 arm64 下仍存在构建耗时较长问题（`httpuv/stringi` 编译阶段明显）。
- 外部网络波动会放大 R 包下载失败概率，虽有重试机制但会延长构建时间。

### Next Round Options
1. 新增 CI 变量，默认运行态 smoke 走 `SKIP_BUILD=1`，仅夜间任务执行 full build。
2. 继续瘦身 `r-engine` apt 依赖（按包级别核减）并基于构建时间做 A/B 记录。
3. 把富集能力拆为单独镜像标签（`r-engine:core` / `r-engine:enrich`）降低日常迭代成本。

## Progress Monitor v4

### Goal
继续强化长期监控能力：增加历史保留策略、可抓取指标文件、趋势中的 blocker 热点统计。

### Implemented
- 升级 `scripts/progress-monitor.sh`：
  - 新增 `HISTORY_RETENTION_DAYS`（默认 14），自动清理过期历史快照
  - 新增 `METRICS_OUTPUT_FILE`（默认 `docs/PROGRESS_METRICS.prom`）
  - 新增 `BLOCKER_TOP_N`（默认 5），趋势报告展示 blocker 高频项
  - `PROGRESS_STATUS.md` 增加 metrics/retention 输出信息
  - `PROGRESS_METRICS.prom` 输出核心数值（overall、变更规模、测试状态、时延、blocker、运行服务、历史清理数）
- 升级 `.github/workflows/progress-monitor.yml`：
  - 透传 `HISTORY_RETENTION_DAYS=14`
  - 上传 `docs/PROGRESS_METRICS.prom` artifact
- 更新文档：
  - `README.md` 增加 retention/metrics 使用示例
  - `docs/version-control.md` 增加产物说明

### Changed Files
- `bioid-analytics/scripts/progress-monitor.sh`
- `bioid-analytics/.github/workflows/progress-monitor.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-21

1) 语法检查
- 命令：`bash -n scripts/progress-monitor.sh`
- 结果：通过

2) 严格模式 + 快速运行（跳过 smoke）
- 命令：`STRICT_MODE=1 RUN_SMOKE=0 scripts/progress-monitor.sh`
- 结果：通过，生成 `PROGRESS_STATUS/JSON/TREND/METRICS` 与 history 快照

3) 严格模式 + 运行态 smoke
- 命令：`STRICT_MODE=1 RUN_SMOKE=1 SMOKE_SKIP_BUILD=1 scripts/progress-monitor.sh`
- 结果：通过，`compose smoke=PASS`，`overall status=CODE_HEALTHY`

4) 字段验证
- 命令：`rg -n '^# HELP progress_|^progress_' docs/PROGRESS_METRICS.prom`
- 结果：指标文件生成且包含关键字段

### Risks / Open Questions
- 趋势报告目前基于本地 history 快照目录；若 CI 与本地分别运行，会形成两套历史，后续可考虑统一存储路径（artifact/对象存储）。

### Next Round Options
1. 增加 `HISTORY_RETENTION_COUNT`（按数量保留）与按天策略并行。
2. 输出 `progress_metrics.json`，便于非 Prometheus 消费方接入。
3. 在趋势报告中加入“测试耗时变化率”告警阈值。

## Progress Monitor v5

### Goal
补齐 history 保留上限与 JSON 指标产物，避免历史目录无限增长并提升外部系统接入能力。

### Implemented
- 升级 `scripts/progress-monitor.sh`：
  - 新增 `HISTORY_RETENTION_COUNT`（默认 200），按时间戳滚动保留最新 N 份历史快照
  - 历史清理改为“按天 + 按数量”双策略叠加，统一产出 `history_pruned_count`
  - 新增 `METRICS_JSON_FILE`（默认 `docs/PROGRESS_METRICS.json`）
  - 继续输出 `docs/PROGRESS_METRICS.prom`，并同步生成结构化 JSON 指标
  - 修复 Bash 3.2 下空数组 cleanup 的 `set -u` 兼容性问题
- 升级 `.github/workflows/progress-monitor.yml`：
  - 新增 `HISTORY_RETENTION_COUNT=200`
  - 上传 `docs/PROGRESS_METRICS.json` artifact
- 升级 `scripts/review-gate.sh`：
  - 排除 `README.html` / `README_files/` 导出产物，避免误判“代码变更未更新 DEVLOG”
- 更新文档：
  - `README.md` 增加 metrics JSON 和数量保留示例
  - `docs/version-control.md` 增加产物/参数说明

### Changed Files
- `bioid-analytics/scripts/progress-monitor.sh`
- `bioid-analytics/scripts/review-gate.sh`
- `bioid-analytics/.github/workflows/progress-monitor.yml`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-22

1) 语法检查
- 命令：`bash -n scripts/progress-monitor.sh`
- 结果：通过

2) 临时目录专项验证（双保留策略 + 指标）
- 命令（节选）：
  - 预置旧快照：`old.json/old.md`（2000-01-01 mtime）
  - 运行：`RUN_TESTS=0 RUN_GATE=0 RUN_SMOKE=0 SAVE_HISTORY=1 HISTORY_RETENTION_DAYS=1 scripts/progress-monitor.sh ...`
- 结果：
  - 旧快照被清理，目录仅保留新快照与 latest
  - `METRICS.prom` 中 `progress_history_pruned_count=2`
  - 趋势报告包含 `## Blocker Hotspots`

3) 严格模式回归
- 命令：`STRICT_MODE=1 RUN_SMOKE=0 scripts/progress-monitor.sh`
- 结果：通过，`overall status=CODE_HEALTHY`

4) review gate 误报修复验证
- 命令：`scripts/review-gate.sh monitor-readme-artifact-filter`
- 结果：通过（`README.html` / `README_files/` 不再触发 DEVLOG 阻断）

5) 严格模式 + 运行态 smoke
- 命令：`STRICT_MODE=1 RUN_SMOKE=1 SMOKE_SKIP_BUILD=1 scripts/progress-monitor.sh`
- 结果：通过，`review gate=PASS`，`compose smoke=PASS`，`overall status=CODE_HEALTHY`

### Risks / Open Questions
- 当前 count 保留按本地文件名时间戳排序，若历史目录混入非标准命名文件，可能影响滚动顺序。

### Next Round Options
1. 增加 `HISTORY_FILE_PATTERN` 仅匹配规范快照文件名。
2. 增加 JSON 指标到 CI summary 的摘要渲染。
3. 增加阻塞项严重度分级（quality/runtime/governance）。

## Round 23

### Goal
整理代码库可维护性（仓库噪音与关键脚本注释）并执行第一次运行态试运行。

### Implemented
- 仓库清理：
  - `.gitignore` 新增 `README.html` / `README_files/`，避免本地导出文件污染工作区。
- 门禁脚本注释：
  - `scripts/review-gate.sh` 增加说明注释，明确哪些路径按“非代码改动”处理。
- 监控脚本注释：
  - `scripts/progress-monitor.sh` 增加关键注释，覆盖：
    - prom/json 指标双产物默认策略
    - history 按天 + 按数量双重清理逻辑
    - strict mode 阻断语义
- 运行文档补充：
  - `README.md` 新增 `First Trial Run` 小节，给出首次启动与试运行命令序列。

### Changed Files
- `bioid-analytics/.gitignore`
- `bioid-analytics/scripts/review-gate.sh`
- `bioid-analytics/scripts/progress-monitor.sh`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-22

1) 服务拉起
- 命令：`docker compose --env-file .env.example up -d`
- 结果：`frontend/api/r-engine/redis/postgres/minio` 全部运行并健康

2) 运行态冒烟
- 命令：`SKIP_BUILD=1 scripts/compose-smoke.sh`
- 结果：`PASS: compose smoke checks passed.`

3) 关键接口检查
- 命令：`curl -fsS http://localhost:4000/api/health`
- 结果：`{"ok":true,...}`
- 命令：`curl -fsS http://localhost:8000/health`
- 结果：`{"ok":[true],"service":["r-engine"]}`
- 命令：`curl -fsS 'http://localhost:4000/api/analysis?config_rev=rev-0005'`
- 结果：返回分析 payload（含 `views.pca/correlation/volcano/enrichment`）

### Risks / Open Questions
- 当前工作区仍会因 `progress-monitor` 运行刷新 `docs/PROGRESS_*` 快照；如需保持干净工作区，建议在开发轮次中按策略提交或单独管理这些产物。

### Next Round Options
1. 将 `progress-monitor` 增加 `WRITE_REPORTS=0` 开关（仅控制台输出，不落盘）。
2. 把 `README` 的试运行流程抽成 `scripts/first_run.sh` 一键执行。
3. 增加“首次试运行基线截图/日志包”标准化产物目录。

## Round 24

### Goal
完成仓库重构收尾与阶段 C 全链路闭环：`upload -> /api/analysis/run -> /api/analysis/run/:runId -> artifacts`，并同步 CI/文档/测试。

### Implemented
- 目录与命名收尾：
  - `services/api/package.json`、`services/frontend/package.json` 包名更新为 `bioid-analytics-*`。
  - `docker-compose.yml` 保持 `name: bioid-analytics` 与 `bioid-analytics-*` 容器前缀。
  - `.env.example` 默认 bucket 为 `bioid-analytics-artifacts`。
- 阶段 C 后端收口：
  - `services/api/server.js` 在 schema 初始化中补齐 `session_configs` 表与索引，修复 `analysis/run` 在 pg-mem 下的 500。
  - `services/api/src/modules/de-enrich.js` 放宽 JS fallback 最小分组样本约束为每组至少 1 个样本，保证最小上传样本集可完成 run。
  - `services/api/test/r.analysis.source.test.js` 修复仓库根路径定位。
- 阶段 C 前端接入（`services/frontend/src/app.jsx`）：
  - 新增“运行分析”按钮，调用 `POST /api/analysis/run`。
  - 新增轮询 `GET /api/analysis/run/:runId` 到终态。
  - 新增四图结果卡片（PCA/Correlation/Volcano/Enrichment）与 CSV/SVG/PNG/Meta 下载。
  - 新增 PNG 下载前端渲染（读取 `/png` payload 中的 SVG 转 canvas 导出）。
  - 错误展示改为“中文主信息 + EN detail”。
  - localStorage key 从 `bioid.*` 迁移为 `bioid-analytics.*`，并做一次性旧 key 迁移。
- CI/workflow 同步：
  - `.github/workflows/compose-smoke.yml`、`full-smoke-enrichment-weekly.yml`、`progress-monitor.yml` 改为 `services/api` + `services/frontend`。
  - `progress-monitor` 脚本改为运行 `services/api` 测试 + `services/frontend` 构建。
- 文档同步：
  - 更新 `README.md`、`docs/review-protocol.md`、`docs/review-log.md`、`docs/round5-release-checklist.md`、`docs/version-control.md`。
  - 修复路径过替换残留（如 `services/frontend/api/services/r-engine`）。

### Changed Files
- `bioid-analytics/services/api/server.js`
- `bioid-analytics/services/api/src/modules/de-enrich.js`
- `bioid-analytics/services/api/test/r.analysis.source.test.js`
- `bioid-analytics/services/api/package.json`
- `bioid-analytics/services/api/package-lock.json`
- `bioid-analytics/services/frontend/src/app.jsx`
- `bioid-analytics/services/frontend/src/app.css`
- `bioid-analytics/services/frontend/src/i18n/zh-cn.js`
- `bioid-analytics/services/frontend/package.json`
- `bioid-analytics/services/frontend/package-lock.json`
- `bioid-analytics/.github/workflows/compose-smoke.yml`
- `bioid-analytics/.github/workflows/full-smoke-enrichment-weekly.yml`
- `bioid-analytics/.github/workflows/progress-monitor.yml`
- `bioid-analytics/scripts/progress-monitor.sh`
- `bioid-analytics/scripts/review-gate.sh`
- `bioid-analytics/README.md`
- `bioid-analytics/docs/review-protocol.md`
- `bioid-analytics/docs/review-log.md`
- `bioid-analytics/docs/round5-release-checklist.md`
- `bioid-analytics/docs/version-control.md`
- `bioid-analytics/docs/devlog.md`

### Validation
执行时间：2026-02-22

1) API 测试
- 命令：`cd services/api && npm test`
- 结果：`46 passed, 0 failed`

2) 前端构建
- 命令：`cd services/frontend && npm run build`
- 结果：`vite build passed`

3) Review Gate
- 命令：`bash scripts/review-gate.sh stage-c-closeout-20260222`
- 结果：首次运行因 DEVLOG 未更新失败；更新本节后复跑通过。
