# Round 5 Release Checklist (Executed)

- Executed at: 2026-02-21
- Commit: `ac66cac`
- Scope: Phase 5 (interactive plots, downloadable artifacts, pre-release acceptance)

## 1) 可部署（Deployable）

- [x] 镜像可构建（`r-engine`）
  - Command: `docker compose --env-file .env.example build r-engine`
  - Result: `Successfully built b5fdf01bd8c2`, `Successfully tagged cloud-fullstack-docker-r-engine:latest`
- [x] 服务可启动并健康
  - Command: `docker compose --env-file .env.example up -d --no-build`
  - Evidence: `docker compose --env-file .env.example ps` 显示 `frontend/api/postgres/redis/r-engine/minio` 全部 `healthy`
- [x] 关键健康检查通过
  - `GET http://localhost:4000/api/health` -> `{"ok":true,...}`
  - `GET http://localhost:8000/health` -> `{"ok":[true],"service":["r-engine"]}`
  - `GET http://localhost:5173` -> `200`
- [x] 运行态 smoke 通过
  - Command: `SKIP_BUILD=1 scripts/compose-smoke.sh`
  - Result: `PASS: compose smoke checks passed.`
  - Coverage: analysis + artifact csv/meta + session/upload/list/delete 全链路

## 2) 可复现（Reproducible）

- [x] API 测试全通过（含配置、上传解析、rRunner）
  - Command: `cd services/api && npm test`
  - Result: `33 passed, 0 failed`
- [x] 回归测试通过（固定 `config_rev` 数据稳定）
  - Command: `cd services/api && npm run test:summary`
  - Result: regression `PASS`
- [x] 前端构建通过
  - Command: `cd services/frontend && npm run build`
  - Result: build `PASS`
- [x] artifact 元数据可追溯 `config_rev`
  - Evidence: regression checks + `compose-smoke.sh` 的 artifact csv/meta 验证均通过
- [x] 性能摘要已更新
  - File: `docs/round5-test-summary.md`
  - Metrics: analysis `p50=2.64ms p95=4.11ms max=7.02ms`; download `p50=0.46ms p95=0.90ms max=1.13ms`

## 3) 可回滚（Rollback-ready）

- [x] 无 destructive DB migration（本轮仅 API/前端/测试与文档）
- [x] 具备可回滚基线 tag
  - Available tag: `baseline-v1`
- [ ] 发布 tag（例如 `release/round5`）
  - Status: **PENDING**（待发布动作）
- [ ] 镜像层回滚演练（切回上一 tag 后 compose 验证）
  - Status: **PENDING**（环境已可用，待执行演练）

## 4) Pending Items

1. 发布前打 tag（示例）：

```bash
cd /Users/zhui/Desktop/cs/cloud-fullstack-docker
git tag release/round5
```

2. 执行回滚演练：

```bash
git checkout baseline-v1
docker compose --env-file .env.example up -d --build
curl -fsS http://localhost:4000/api/health
```

## 5) Conclusion

- **Reproducibility gate: PASS**
- **Deployability gate: PASS**
- **Rollback gate: PARTIAL (pending release tag + rollback drill execution)**
