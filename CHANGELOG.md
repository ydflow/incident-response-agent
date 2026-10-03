# 故障智巡变更记录

## v0.3.0 — 本地受控演示预览

- 专用鉴权的 Webhook / Alertmanager v4 告警接入、归一化、脱敏、SQLite 持久化与服务/环境/指纹/时间窗口聚合；投递幂等与故障聚合分别处理，恢复告警不直接解决调查。
- 独立 LIVE 命名空间与只读本地 Provider；运行中资源槽演示服务提供真实日志/指标。Trace/Git 明确 unsupported。
- 五类通用 Markdown Runbook、BM25 检索及带版本/哈希/原文位置的知识快照，与观测 Evidence 分离。
- 有幂等键的持久化调查任务、原子领取、租约 fencing、重启恢复、有限重试/预算；沿用原受限 Pi 会话、领域模型、状态机与可信宿主审批。
- Console 现场列表、任务/报告、证据/知识引用、真实事件与只读回放；保留原十二案例、历史与模拟审批。
- 人工演示恢复声明与新一轮只读效果验证；没有有效证据不宣布恢复，verified 不自动 RESOLVED。
- 发布审查修复跨平台 Python 连接、恢复验证失败后误入普通调查重试、历史 API 校验缺失及并发导出覆盖风险；产品版本集中为 v0.3.0，上游包版本不变。

兼容：SQLite schema 69→70→71 增量迁移，旧表/行与 Fixture、十种事件格式保留。参见[迁移说明](docs/v0.3.0-migration.md)。

验收限制：当前真实模型请求超时，最终诊断未通过；全仓 Windows 存在与 HEAD 相同的失败。第 9 步 PR 的 Ubuntu CI 与实际发布状态见[进度](docs/v0.3.0-progress.md)。发布定位为 GitHub prerelease，不声称稳定模型诊断或生产可用。详见[审查结果](docs/v0.3.0-review.md)与[版本说明](docs/releases/v0.3.0.md)。

第 9 步首轮 [Ubuntu CI](https://github.com/ydflow/incident-response-agent/actions/runs/37092209558) completed/success：全新 checkout 安装、构建/类型/格式/文档/Runner 自检通过，TS 3087 passed/23 原有 skipped/0 failed，Python 72 passed，移动端 9/原 Console 桌面 6 passed。最新 PR 提交仍须完成相同 CI 后才合并。
