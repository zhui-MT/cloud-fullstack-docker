# REVIEW PROTOCOL

用于多 Codex 并行开发时的统一审查门禁。

## 1) 你每轮给我的最小信息

- 本轮目标（1 句话）
- 修改文件列表
- 关键 diff（或完整 patch）
- 本地验证命令与结果

如果没有这些信息，我只能做部分审查，无法给出完整结论。

## 2) 我的审查输出格式（固定）

1. 完成度评分（范围/质量/验证）
2. 阻断问题（必须先修）
3. 可接受风险（可带到下一轮）
4. 下一轮任务单（最多 5 条）

## 3) 强制门禁（未通过即不放行）

- 功能门禁：本轮目标对应功能可实际运行
- 验证门禁：至少一条成功验证链路
- 回归门禁：不能破坏已完成功能
- 文档门禁：README/DEVLOG 必须同步更新
- 可复现门禁：关键参数、命令、版本可追溯

## 4) 当前项目专用检查点

- Compose 六服务：frontend/api/r-engine/redis/postgres/minio
- 所有服务存在健康检查与依赖关系
- API 契约逐步收敛到：
  - POST /api/session
  - POST /api/upload
  - POST /api/config
  - POST /api/run/:module
  - GET /api/job/:id
  - GET /api/artifact/:id
- 分析参数必须支持配置版本（config_rev/config_hash）

## 5) 失败处理策略

- 阻断问题存在时：只允许修阻断，不扩功能
- 验证不完整时：先补验证，再合入下一轮
- 需求偏移时：回到 README 目标范围重新对齐

