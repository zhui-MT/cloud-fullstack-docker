# VERSION CONTROL GUIDE

## Baseline

- baseline tag: `baseline-v1`
- view baseline: `git show baseline-v1 --stat`

## Daily Workflow

1. 检查当前变更
   - `git status -sb`
2. 执行审查门禁
   - `scripts/review_gate.sh round-name`
3. 运行集成烟测（容器启动后）
   - `scripts/compose_smoke.sh`
4. 创建快照提交与标签
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
