# REVIEW LOG

## Review 1

### Input
- Round:
- Goal:
- Files:
- Validation:

### Findings
- Blockers:
- Risks:
- Notes:

### Decision
- Status: pass / conditional / fail
- Required fixes:
- Next round focus:


## Review 2

### Input
- Round: monitor-round-current
- Goal: 监察与版本控制机制落地审查
- Files: scripts/*, docs/REVIEW_PROTOCOL.md, docs/VERSION_CONTROL.md
- Validation: scripts/review_gate.sh monitor-round-current

### Findings
- Blockers: none
- Risks: 仓库存在其他模块未合并改动（backend/r-engine/frontend），建议分支隔离并分轮提交
- Notes: 门禁脚本运行通过，治理工具可用

### Decision
- Status: pass
- Required fixes: none
- Next round focus: 对 backend/r-engine 变更做单独审查与分批提交

## Review 3

### Input
- Round: monitor-round-backend-phase5
- Goal: 审查当前 backend/r-engine/README 变更是否可发布
- Files: backend/*, r-engine/*, README.md, docker-compose.yml
- Validation:
  - `backend: npm test` (pass)
  - `backend: npm run test:summary` (pass)
  - `backend/scripts/e2e_round4.sh` (pass, JS_FALLBACK)
  - `scripts/review_gate.sh review-current-dirty` (pass)

### Findings
- Blockers:
  1) 运行栈与实现栈不一致：`docker-compose.yml` 当前 `api` 服务使用 `./api`，但 Phase 4/5 新接口与测试在 `backend/server.js`。按当前 compose 启动不会提供 Phase 5 API。
  2) 文档与部署状态冲突：`README.md` 写明 `redis/r-engine/minio` 未启用，但 `docker-compose.yml` 已启用三者，文档会误导部署与验收。
- Risks:
  - `r-engine/analysis.R` 富集逻辑硬编码 `org.Hs.eg.db` + `hsa`，与“全物种”目标不一致。
  - 当前 E2E 成功依赖 `JS_FALLBACK`，不代表真实 R pipeline 已在运行态可用。
  - `review_gate.sh` 仅覆盖基础门禁，尚未验证“compose服务是否指向当前主后端实现”。
- Notes:
  - 现有单测和 summary 测试在本机 Node 环境全部通过。

### Decision
- Status: fail (release-blocked)
- Required fixes:
  1) 统一 runtime entry：要么 compose 切到 `backend`，要么将 backend Phase 5 能力合并到 `api`。
  2) 修正 README 与 compose 的描述一致性。
  3) 增加一条集成验证：`docker compose` 运行后真实调用 `GET /api/analysis` 和 artifact 下载链路。
- Next round focus:
  1) 收敛服务入口（api vs backend）。
  2) 追加容器内 E2E 验证脚本。
  3) 再次执行 release checklist 并更新状态。

## Review 4

### Input
- Round: monitor-remediation-followup
- Goal: 复核 Review 3 阻断修复是否生效
- Files: docker-compose.yml, scripts/compose_smoke.sh, README.md, docs/*
- Validation:
  - `docker compose --env-file .env.example config` (pass)
  - `scripts/review_gate.sh review3-remediation-v2` (pass)
  - `SKIP_HEALTH=1 scripts/compose_smoke.sh` with local backend (pass)

### Findings
- Blockers: none (code-level blockers fixed)
- Risks:
  - 尚未在真实 `docker compose up` 运行态执行 smoke（当前机器 Docker daemon 未启动）。
  - R pipeline 真实执行依赖容器内 R 包环境，当前本机验证仍可能走 fallback 路径。
- Notes:
  - `api` 服务已统一为 `./backend` 入口。
  - README 与 compose 现状已一致。

### Decision
- Status: conditional
- Required fixes:
  - 启动 Docker daemon 后执行：`docker compose up -d --build && scripts/compose_smoke.sh`
- Next round focus:
  - 运行态验收与 release checklist 更新。

## Review 5

### Input
- Round: monitor-runtime-remediation-2026-02-21
- Goal: 完成 Docker 运行态验收并关闭 Review 4 的 conditional 状态
- Files: `docker-compose.yml`, `r-engine/Dockerfile`, `scripts/compose_smoke.sh`
- Validation:
  - `docker compose --env-file .env.example up -d`
  - `docker compose --env-file .env.example ps`
  - `SKIP_BUILD=1 scripts/compose_smoke.sh`
  - `scripts/review_gate.sh runtime-acceptance-rerun`

### Findings
- Blockers: none
- Risks:
  - `r-engine` 全量 Bioconductor 构建链路仍较重，且已观察到外部镜像源偶发 `SSL connect error`，建议把 Bioc 包安装改为按需或单独镜像层。
  - `compose_smoke.sh` 默认仍会执行构建；当前已加 `SKIP_BUILD=1` 作为运行态回归路径。
- Notes:
  - 已修复 `api` 健康检查（容器内无 `curl`）为 Node `fetch`。
  - 已修复 `frontend` 健康检查 `localhost` IPv6 偏好导致误判，改为 `127.0.0.1`。
  - 六服务均为 healthy，运行态 smoke 全通过。

### Decision
- Status: pass
- Required fixes: none
- Next round focus:
  - 收敛 `r-engine` Dockerfile 的重依赖安装策略，降低构建抖动。

## Review 6

### Input
- Round: monitor-r-engine-build-profile-2026-02-21
- Goal: 复核 `r-engine` 轻量默认构建 + 可选富集构建策略是否可运行、可回归
- Files: `r-engine/Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, `docs/DEVLOG.md`
- Validation:
  - `docker compose --env-file .env.example build r-engine`
  - `docker compose --env-file .env.example up -d r-engine`
  - `docker compose --env-file .env.example ps`
  - `SKIP_BUILD=1 scripts/compose_smoke.sh`

### Findings
- Blockers: none
- Risks:
  - `docker compose up -d --build r-engine` 在长编译阶段两次出现退出码 `130`（外部中断），full build 稳定性仍受环境影响。
  - 轻量默认模式不包含 `clusterProfiler/org.Hs.eg.db`，如直接调用 GO/KEGG 富集需显式开启安装开关。
- Notes:
  - 轻量模式镜像构建成功，`r-engine` 运行态 `healthy`。
  - 六服务运行态 smoke（`SKIP_BUILD=1`）通过，当前主链路可用。

### Decision
- Status: pass
- Required fixes: none
- Next round focus:
  1) 优化 full build 触发策略（默认跳过重建，nightly 再执行）。
  2) 继续削减 `r-engine` 镜像层依赖并记录构建时延改善。
