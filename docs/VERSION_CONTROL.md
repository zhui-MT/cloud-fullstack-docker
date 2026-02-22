# VERSION CONTROL GUIDE

## Baseline

- baseline tag: `baseline-v1`
- view baseline: `git show baseline-v1 --stat`

## Daily Workflow

1. 检查当前变更
   - `git status -sb`
2. 生成进度快照
   - `scripts/progress_monitor.sh`
   - 产物：`docs/PROGRESS_STATUS.md` + `docs/PROGRESS_STATUS.json` + `docs/PROGRESS_TREND.md` + `docs/PROGRESS_METRICS.prom`
   - 如需和历史快照比较：`PREV_JSON_FILE=<old.json> scripts/progress_monitor.sh`
   - 严格门禁：`STRICT_MODE=1 scripts/progress_monitor.sh`（有 blocker 时返回非 0）
   - 趋势报告：`docs/PROGRESS_TREND.md`（来自 `docs/progress_history/*.json`）
   - 历史保留：`HISTORY_RETENTION_DAYS=14 scripts/progress_monitor.sh`
3. 执行审查门禁
   - `scripts/review_gate.sh round-name`
4. 运行集成烟测（容器启动后）
   - `scripts/compose_smoke.sh`
5. 创建快照提交与标签
   - `scripts/vc_snapshot.sh "feat: round-name update"`

## Safe Rollback Workflow

1. 确保工作区干净（或先做 snapshot）
2. 创建回滚分支到指定提交/tag
   - `scripts/vc_rollback.sh baseline-v1`
3. 在回滚分支验证
   - `docker compose --env-file .env.example config`
4. 确认后再决定是否合并回主线

## Notes

- `vc_rollback.sh` 不会直接改写 `main`，会新建 rollback 分支。
- 如需回到最新开发，执行 `git switch main`。
- CI 定时监控工作流：`.github/workflows/progress-monitor.yml`。
