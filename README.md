# BioID Proteomics Analyst (Docker)

BioID 蛋白组分析平台（当前为 Phase 5 可发布候选版），支持四类核心图形 API + 前端交互展示，并提供 `PNG/SVG/CSV` 下载与 `config_rev` 追溯。

## 1. Phase 5 Scope

已完成：
- 图形 API：`PCA`、`Correlation Heatmap`、`Volcano`、`GO/KEGG Enrichment`
- 前端交互：分组筛选、阈值滑杆、TopN 切换
- 下载能力：`PNG` / `SVG` / `CSV`
- artifact 追溯：下载响应或 payload 包含 `config_rev` 与 artifact 元数据
- 回归测试 + 性能测试摘要

## 2. Runtime Architecture

当前仓库可运行栈（docker-compose）：
- `frontend`：React + Vite
- `api`：Node.js + Express（构建源：`./backend`）
- `postgres`：配置与上传元数据
- `redis`：队列/缓存预留
- `r-engine`：R runtime（默认 `limma` 栈；可选安装 `clusterProfiler` 富集栈）
- `minio`：artifact 存储预留
- `minio-init`：启动时自动创建 `UPLOAD_BLOB_BUCKET`

## 3. Quick Start

```bash
cd /Users/zhui/Desktop/cs/cloud-fullstack-docker
docker compose up -d --build
```

访问：
- Frontend: `http://localhost:5173`
- Backend Health: `http://localhost:4000/api/health`

集成烟测：

```bash
scripts/compose_smoke.sh
```

当前烟测包含：
- `/api/health`
- `/api/analysis` + artifact 下载
- `POST /api/session` + `POST /api/upload`
- `GET /api/upload/:id` + `/mapped-rows` 分页
- `GET /api/session/:id/uploads` 会话上传列表
- `DELETE /api/upload/:id` 单条删除与回查
- `DELETE /api/session/:id/uploads` 批量删除与回查

如果只在本机裸跑 `backend`（未启动 postgres），可跳过 health 检查：

```bash
SKIP_HEALTH=1 scripts/compose_smoke.sh
```

如只做 compose 配置/构建校验（不跑 API 链路）：

```bash
SKIP_API=1 scripts/compose_smoke.sh
```

如只做运行态回归（跳过镜像重建）：

```bash
SKIP_BUILD=1 scripts/compose_smoke.sh
```

如需放宽上传存储模式断言（默认 `blob`）：

```bash
EXPECT_STORAGE_MODE=db scripts/compose_smoke.sh
```

如需启用 `r-engine` 富集重依赖（`clusterProfiler` + `org.Hs.eg.db`）：

```bash
export R_ENGINE_INSTALL_ENRICHMENT_PACKAGES=1
docker compose up -d --build r-engine
```

## 4. Key APIs (Phase 5)

### 4.1 Analysis

`GET /api/analysis?config_rev=rev-0005`

返回：
- `views.pca.data`
- `views.correlation.data`
- `views.volcano.data`
- `views.enrichment.data`
- 每个 view 含 `downloads.csv/svg/png` 与 `artifact_meta`

### 4.2 Artifact Download

- `GET /api/artifacts/:id/download`：下载 `CSV` 或 `SVG`，响应头包含 `X-Artifact-Meta`
- `GET /api/artifacts/:id/png`：返回 PNG 渲染 payload（SVG + metadata），由前端转为 PNG 下载
- `GET /api/artifacts/:id/meta`：查询 artifact 元数据

### 4.3 Session + Upload (Round 2)

- `POST /api/session`：创建会话，返回 `sessionId`
- `POST /api/upload`：上传结果表并自动识别 `FragPipe / DIA-NN / MaxQuant` 与 `protein/peptide`
  - 请求格式：`multipart/form-data`
  - 字段：`file` + `sessionId`（兼容 `session_id`）
  - 响应包含摘要：`sampleCount`、`entityCount`、`availableColumns`、`warnings`
  - 完整 `mappedRows` 默认落地到后端 blob 存储（本地文件实现），响应返回 `storage.mode/key`
- `GET /api/upload/:id`：读取上传解析详情（摘要 + 预览 + 持久化后的统一 schema 行数）
- `GET /api/upload/:id/mapped-rows?limit=200&offset=0`：分页读取完整标准化行
- `DELETE /api/upload/:id`：删除上传记录并清理关联 blob（失败时返回 warning 并继续删除 DB 记录）
- `GET /api/session/:id/uploads?limit=50&offset=0`：按会话分页列出上传历史
- `DELETE /api/session/:id/uploads`：批量删除该会话下所有上传（含 blob 清理）

示例：

```bash
curl -X POST http://localhost:4000/api/session \
  -H 'content-type: application/json' \
  -d '{"name":"demo-round2"}'

curl -X POST http://localhost:4000/api/upload \
  -F "sessionId=<your-session-id>" \
  -F "file=@backend/samples/fragpipe_protein.tsv"

curl http://localhost:4000/api/upload/<upload-id>
curl "http://localhost:4000/api/upload/<upload-id>/mapped-rows?limit=100&offset=0"
curl "http://localhost:4000/api/session/<session-id>/uploads?limit=20&offset=0"
curl -X DELETE "http://localhost:4000/api/upload/<upload-id>"
curl -X DELETE "http://localhost:4000/api/session/<session-id>/uploads"
```

Blob 存储切换（MinIO/S3）：

```bash
export UPLOAD_BLOB_BACKEND=s3
export UPLOAD_BLOB_BUCKET=bioid-artifacts
export UPLOAD_BLOB_ENDPOINT=http://localhost:9000
export UPLOAD_BLOB_REGION=us-east-1
export UPLOAD_BLOB_ACCESS_KEY_ID=minioadmin
export UPLOAD_BLOB_SECRET_ACCESS_KEY=minioadmin123
export UPLOAD_BLOB_FORCE_PATH_STYLE=true
export UPLOAD_BLOB_POLICY=private
```

启用后，`POST /api/upload` 返回 `storage.mode=blob` 且 `mappedRows` 通过对象存储读写。

如果不使用对象存储，可切回本地文件模式：

```bash
export UPLOAD_BLOB_BACKEND=fs
export UPLOAD_BLOB_DIR=./backend/reports
```

## 5. Reproducibility

- 同一 `config_rev` 下，分析输出是确定性的（deterministic）
- 下载文件名与 artifact metadata 绑定 `config_rev`
- `POST /api/config` 与 `GET /api/config/:session_id` 提供 `config_hash` 与 `reproducibility_token`

## 6. Tests

后端测试：

```bash
cd backend
npm test
npm run test:summary
```

`npm run test:summary` 会执行：
- 回归测试：`scripts/regression.js`
- 性能测试：`scripts/performance.js`
- 生成摘要：`docs/ROUND5_TEST_SUMMARY.md`

前端构建验证：

```bash
cd frontend
npm install
npm run build
```

CI（GitHub Actions）：

- Workflow: `.github/workflows/compose-smoke.yml`
- 执行内容：
  - `cd backend && npm test`
  - `docker buildx` 构建 `r-engine`（`cache-from/cache-to: type=gha`）
  - `SKIP_API=1 SKIP_BUILD=1 scripts/compose_smoke.sh`（配置烟测）
- Workflow: `.github/workflows/full-smoke-nightly.yml`
- 执行内容：
  - 每日 `03:00 UTC`（以及手动触发）执行 full-stack compose 启动
  - 通过 `scripts/compose_up_retry.sh` 对 `compose up -d --build` 做重试
  - `SKIP_BUILD=1 scripts/compose_smoke.sh`（运行态 API 全链路）
  - 通过 `scripts/collect_compose_logs.sh` 采集并上传 `compose-logs` artifact（`ps/logs/images/config/events`）
  - 手动触发可选 `install_enrichment=1`，启用 `clusterProfiler/org.Hs.eg.db` 构建
- Workflow: `.github/workflows/full-smoke-enrichment-weekly.yml`
- 执行内容：
  - 每周 `04:00 UTC`（周日）执行 enrichment 栈 full-smoke（固定 `R_ENGINE_INSTALL_ENRICHMENT_PACKAGES=1`）
  - 同样使用 `compose_up_retry` + `collect_compose_logs`，artifact 名称为 `compose-logs-enrichment`
- Workflow: `.github/workflows/api-round4.yml`
- 执行内容：
  - `cd api && npm ci && npm test`
  - `cd api && npm run ci:round4`
    - 启动 `api/scripts/mock_r_engine.js`
    - 启动 `api`（memory queue/store + `R_ENGINE_URL` 指向 mock）
    - 执行 `api/scripts/e2e_round4.sh`，断言：
      - `EXPECT_RUNTIME=R`
      - `ASSERT_GO_KEGG=1`
      - `EXPECT_GO_ID=GO:0006954`
      - `EXPECT_KEGG_ID=hsa04060`
      - `EXPECT_LOGS="Running limma + clusterProfiler via R runtime,Remote r-engine completed"`

## 7. Phase 5 Acceptance Snapshot

来自 `docs/ROUND5_TEST_SUMMARY.md`（2026-02-21 最新一次）：
- Regression: **PASS**
- Analysis API latency (local loopback): `p50=1.37ms`, `p95=2.26ms`, `max=3.42ms`
- Download API latency (local loopback): `p50=0.23ms`, `p95=0.44ms`, `max=0.75ms`

发布门禁执行结果见：`docs/ROUND5_RELEASE_CHECKLIST.md`

## 8. Release Checklist

### 8.1 可部署（Deployable）

- [ ] `docker compose up -d --build` 成功，`frontend/api/postgres/redis/r-engine/minio` 全部健康
- [ ] `GET /api/health` 返回 `ok=true`
- [ ] 前端四个图均可渲染，交互控件可用
- [ ] 四图均可下载 `PNG/SVG/CSV`
- [ ] 下载文件名/响应元数据中可追溯 `config_rev`

### 8.2 可复现（Reproducible）

- [ ] 相同 `config_rev` 多次请求，核心数据一致
- [ ] `npm test` 全通过
- [ ] `npm run test:summary` 生成最新 `docs/ROUND5_TEST_SUMMARY.md`
- [ ] `POST /api/config` + `GET /api/config/:session_id` 的 `config_hash/reproducibility_token` 一致

### 8.3 可回滚（Rollback-ready）

- [ ] 发布前打 Git tag（例如 `release/round5`）
- [ ] 保留上一个稳定镜像 tag（`frontend`/`backend`）
- [ ] 数据库变更可逆（当前 Round 5 无新增 destructive migration）
- [ ] 回滚流程演练：
  - [ ] 切回上一 tag
  - [ ] `docker compose up -d --build`
  - [ ] 验证 `/api/health` 与关键页面

## 9. Monitoring & Version Control

审查与版本控制脚本：

- `scripts/review_gate.sh <round-name>`：执行本地审查门禁（文档同步、compose 配置、脚本语法）。
- `scripts/progress_monitor.sh [output-file]`：生成当前开发进度快照（改动规模、测试状态、门禁、烟测、阻塞项），同时输出 JSON 版本与上次快照差异。
- `scripts/vc_snapshot.sh "<commit-message>"`：创建快照提交并自动打 tag。
- `scripts/vc_rollback.sh <commit-or-tag>`：创建安全 rollback 分支（不会直接改写 `main`）。

示例：

```bash
cd /Users/zhui/Desktop/cs/cloud-fullstack-docker
scripts/review_gate.sh round-2
scripts/progress_monitor.sh
scripts/vc_snapshot.sh "feat: round-2 upload parser"
scripts/vc_rollback.sh baseline-v1
```

默认输出：
- `docs/PROGRESS_STATUS.md`
- `docs/PROGRESS_STATUS.json`

可通过环境变量控制执行项：

```bash
# 跳过测试，仅看工作区+门禁+运行态
RUN_TESTS=0 scripts/progress_monitor.sh

# 跳过 compose 烟测
RUN_SMOKE=0 scripts/progress_monitor.sh

# 指定 JSON 输出路径
JSON_OUTPUT_FILE=docs/progress/latest.json scripts/progress_monitor.sh

# 指定用于差异对比的上一份 JSON
PREV_JSON_FILE=docs/progress/previous.json scripts/progress_monitor.sh

# 严格模式：存在 blocker 时返回非 0（可做 CI gate）
STRICT_MODE=1 scripts/progress_monitor.sh

# 历史归档与趋势输出
SAVE_HISTORY=1 HISTORY_DIR=docs/progress_history TREND_OUTPUT_FILE=docs/PROGRESS_TREND.md scripts/progress_monitor.sh
```

CI 定时快照：`.github/workflows/progress-monitor.yml`（支持 `workflow_dispatch` 与 nightly cron）。

详细说明见 `docs/VERSION_CONTROL.md`。

## 10. References

- FragPipe-Analyst: https://fragpipe-analyst.nesvilab.org/
