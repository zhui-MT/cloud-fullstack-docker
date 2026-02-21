# Round 5 Release Checklist (Executed)

- Executed at: 2026-02-21
- Commit: `ea780f2`
- Scope: Phase 5 (interactive plots, downloadable artifacts, pre-release acceptance)

## 1) 可部署（Deployable）

- [ ] `docker compose up -d --build` 成功
  - Status: **BLOCKED**
  - Evidence: Docker daemon unavailable (`Cannot connect to the Docker daemon at unix:///Users/zhui/.docker/run/docker.sock`).
- [ ] `docker compose ps` 显示 `frontend/backend/db` 健康
  - Status: **BLOCKED**
  - Reason: same daemon issue.
- [ ] 容器内健康检查与 HTTP smoke
  - Status: **BLOCKED**
  - Reason: compose 未能启动。

## 2) 可复现（Reproducible）

- [x] 后端测试全通过（含配置、上传解析、rRunner）
  - Command: `cd backend && npm test`
  - Result: `7 passed, 0 failed`
- [x] 回归测试通过（固定 `config_rev` 数据稳定）
  - Command: `cd backend && npm run test:summary`
  - Result: regression `PASS`
- [x] artifact 元数据可追溯 `config_rev`
  - Evidence: regression check includes CSV header meta and PNG payload metadata assertions.
- [x] 性能摘要已更新
  - File: `docs/ROUND5_TEST_SUMMARY.md`
  - Metrics: analysis `p50=1.37ms p95=2.26ms max=3.42ms`; download `p50=0.23ms p95=0.44ms max=0.75ms`

## 3) 可回滚（Rollback-ready）

- [x] 无 destructive DB migration（本轮仅 API/前端/测试与文档）
- [x] 具备可回滚基线 tag
  - Current HEAD tags: `baseline-v1`
- [ ] 发布 tag（例如 `release/round5`）
  - Status: **PENDING** (manual release step)
- [ ] 镜像层回滚演练（切回上一 tag 后 compose 验证）
  - Status: **PENDING/BLOCKED** (requires Docker daemon)

## 4) Blocking Items

1. 启动 Docker Desktop（或可用 Docker daemon）后，重跑：

```bash
cd /Users/zhui/Desktop/cs/cloud-fullstack-docker
docker compose up -d --build
docker compose ps
curl -fsS http://localhost:4000/api/health
```

2. 执行发布 tag 与回滚演练：

```bash
git tag release/round5
git checkout baseline-v1
# run compose + health checks
```

## 5) Conclusion

- **Reproducibility gate: PASS**
- **Deployability gate: BLOCKED (environment)**
- **Rollback gate: PARTIAL (pending Docker + release tag execution)**
