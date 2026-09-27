# Day 3：真实 MiniClaw + LLM E2E Demo

运行日期：2026-09-26。每个 Case 各执行一次真实模型回合；没有使用测试 Fake LLM，也没有重试、补发纠正提示或把 Ground Truth 放进 Prompt。模型为当前 MiniClaw 配置的 `step-3.5-flash/step-5-preview`，通过项目的 `PiRuntimeAdapter`、真实 MCP Tool Layer、Fixture Loader、Evidence Collector、IncidentLifecycle、AgentEvent 与 JSONL Event Store 运行。Agent 的临时工作目录与仓库隔离，只开放四个查询工具和三个受 Approval Gate 管控的模拟处置工具；没有开放文件读取工具。

## 运行命令

在 `miniclaw-main` 目录执行，使用已配置的本地模型凭据；命令和本文均不包含 API Key：

```powershell
py -3.13 -m incident_agent.demo_live INC-001
py -3.13 -m incident_agent.demo_live INC-011
py -3.13 -m incident_agent.demo_live INC-012
```

每条命令只调用模型一次。`incident_agent/demo_live.py` 创建并记录 Incident 状态，再由 `scripts/demo-incident-live.ts` 调用真实 Pi Runtime。每次运行独立保存 `run.json` 和 `INC-xxx.jsonl`，位于 Git 忽略的 `data/incident-e2e/` 目录。`run.json` 保存完整模型回答、ToolCalls、Evidence 和事件；下面是本次实际结果的摘要。

## INC-001：支付服务连接池

- **ToolCalls：** `query_logs`、`query_metrics`、`query_trace`、`query_git_diff`，各有一次真实 `ToolCalled` / `ToolResult`。Pi 流式回调重复通知了同一个 `query_logs` 起始 ID，但 Event Store 只有一次真实调用；本次 `run.json` 的原始 `tool_calls` 数组保留了那些重复回调。
- **Evidence：** `INC-001:logs` 记录连接获取超时和 HTTP 500；`INC-001:metrics` 显示连接池使用数触及 5、等待请求增加、获取连接耗时升高，而数据库查询耗时基本正常；`INC-001:trace` 指向 `db.acquire_connection` 超时；`INC-001:git_diff` 显示告警前 `max_connections` 从 50 改为 5。四条都由查询工具从 Fixture 返回并产生 `EvidenceCollected`。
- **最终 Diagnosis：** 模型认为连接池配置缩小导致正常流量下连接耗尽，进而使支付请求失败；置信度 `0.97`，引用上述四条 Evidence。建议核实配置后回滚并观察指标；这是建议，**没有执行回滚**。
- **State：** `RECEIVED → INVESTIGATING → DIAGNOSED`。
- **AgentEvent / JSONL：** 16 条事件，文件为 `data/incident-e2e/INC-001-20260926T124551Z-ba34cc2c/INC-001.jsonl`；同目录 `run.json` 保存原始结果。包括 `IncidentCreated`、`StatusChanged`、4 组工具调用/结果、4 条 `EvidenceCollected` 和 `DiagnosisCreated`。
- **高风险 Remediation / Approval Gate：** 模型没有调用处置工具；`ApprovalRequested`、`ActionExecuted` 均为 0，Executor 调用为 `false`。本轮没有发生需要审批的请求，因此没有动态触发审批路径。

## INC-011：日志与 Trace 冲突

- **ToolCalls：** `query_logs`、`query_metrics`、`query_trace`、`query_git_diff`，各一次。
- **Evidence：** `INC-011:logs` 把同一请求的 `cache-get-10` 描述为缓存超时；`INC-011:trace` 却显示该 span 为 `OK`、50 ms，另一个 `shipping-api` span 返回 503，最终 checkout 返回 502。`INC-011:metrics` 同时显示缓存错误率和 shipping 5xx 升高；`INC-011:git_diff` 在故障窗口没有相关变更。四条 Evidence 都由 Fixture 工具实际收集。
- **最终 Escalation：** 模型指出日志和 Trace 对同一缓存调用的说法相反，且指标无法单独证明两类异常的因果关系；返回 `decision=escalate`、`root_cause=null`，要求人工核对缓存与 shipping 链路，未强行选一个根因。
- **State：** `RECEIVED → INVESTIGATING → ESCALATED`。
- **AgentEvent / JSONL：** 15 条事件，文件为 `data/incident-e2e/INC-011-20260926T124630Z-00f9f28c/INC-011.jsonl`；同目录 `run.json` 保存原始结果。包括 4 组工具调用/结果、4 条 `EvidenceCollected` 和最终 `StatusChanged`，没有 `DiagnosisCreated`。
- **高风险 Remediation / Approval Gate：** 没有处置 ToolCall；`ApprovalRequested`、`ActionExecuted` 均为 0，Executor 调用为 `false`。

## INC-012：邮件任务失败但关键线索缺失

- **ToolCalls：** `query_logs`、`query_metrics`、`query_trace`、`query_git_diff`，各一次。
- **Evidence：** `INC-012:logs` 只有“job failed; retry scheduled”，没有异常类型；`INC-012:metrics` 显示待处理任务从 20 增至 420、每分钟成功数从 100 降至 2，CPU 和内存基本稳定；`INC-012:trace` 返回空数组；`INC-012:git_diff` 没有相关改动。空 Trace 仍是一次真实查询结果，不代表找到了根因。
- **最终 Escalation：** 模型认为现有数据能确认任务堆积，却无法确认失败的是邮件提供商、认证、网络还是其他依赖；返回 `decision=escalate`、`root_cause=null`，建议人工补充异常日志和下游调用信息。
- **State：** `RECEIVED → INVESTIGATING → ESCALATED`。
- **AgentEvent / JSONL：** 15 条事件，文件为 `data/incident-e2e/INC-012-20260926T124738Z-49e3466d/INC-012.jsonl`；同目录 `run.json` 保存原始结果。包括 4 组工具调用/结果、4 条 `EvidenceCollected` 和最终 `StatusChanged`，没有 `DiagnosisCreated`。
- **高风险 Remediation / Approval Gate：** 没有处置 ToolCall；`ApprovalRequested`、`ActionExecuted` 均为 0，Executor 调用为 `false`。

## 结果核对与边界

三份 JSONL 分别有 16、15、15 行，逐行验证为 `AgentEvent`，ID 与本次内存事件顺序一致。三次模型决定均引用已收集的 Evidence ID。三轮均没有发生高风险处置请求，因此本次 E2E **只证实模型没有越过审批边界，没有实测“模型主动请求处置后被 Gate 拦截”的分支**。该分支由现有 Approval 自动化测试覆盖；这里没有为展示审批效果而伪造一笔模型 ToolCall。

## Clean Clone 复现边界（2026-09-27）

从 GitHub `feature/evaluation-suite` 分支全新克隆后，使用新建 Python 虚拟环境和独立 npm 缓存安装根目录、Agent Runner 与 Web 依赖；`npm run build:all` 通过，本地服务返回 HTTP 200，Approval 测试为 `6 passed`，核心测试为 `42 passed, 27 deselected`。完整安装步骤见根目录 [README](../README.md)。

新克隆没有模型 Provider 配置（启用数量为 0），所以该环境中的 `INC-001` 真实 LLM 命令返回 `live_runner_failed`、终态 `FAILED`，未发生 ToolCall 或 Evidence 收集。它生成了仅含 `IncidentCreated` 与两条 `StatusChanged` 的 JSONL，Replay 能如实重建这次**失败**；这不算新克隆 E2E 调查通过。上文 INC-001/011/012 的成功调查结果来自 **2026-09-26 已配置 Provider 的运行环境**。复现真实模型调查时，需按 README 在新克隆中配置自己的有效 Provider 凭据，再重新核对 ToolCalls、Evidence、终态与 Trace；不要复制或提交已有环境的 API Key。
