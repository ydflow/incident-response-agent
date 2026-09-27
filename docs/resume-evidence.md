# 线上服务故障排查与处置 Agent：简历描述与证据对照

核对范围：用户提供的简历截图中**本项目**的简介和四条项目要点；不评价截图中的其他项目、开源贡献或个人信息。路径均相对仓库根目录。这里的“真实”指**代码、自动化测试或 2026-09-26 的真实模型 Demo 已留下可复核记录**，不指真实生产事故。Fixture 是模拟数据，处置 Executor 是模拟实现。源码证明项目能力，不单独证明个人开发归属、项目起始日期或生产效果。

面试时先打开 [真实 Demo 记录](demo.md)，再按下列源码顺序展示；不要把 [Case Matrix](incident-case-matrix.md) 或 `evaluation/expected_cases.json` 交给运行中的 Incident Agent。重复执行真实 LLM Demo 会产生新的模型调用，输出可能变化；核心 CI 测试不需要外部 LLM。

## 1. MiniClaw Runtime / Tool Calling

- **简历描述：**“基于 Pi Agent Runtime……统一管理”；“MCP 与工具调用”。
- **解决的问题：**把模型提出的工具调用送到有参数校验的具体 handler，并把结果返回 Agent，而不是在 Prompt 中假装调用。
- **真实代码位置：**MiniClaw 基座的 `container/agent-runner/src/pi-index.ts` 中 `runTurn` 注册 `createMcpTools`；`container/agent-runner/src/runtime/pi/pi-runtime.ts` 中 `PiRuntimeAdapter.createSession` 创建 Pi 会话；`container/agent-runner/src/runtime/pi/pi-tools.ts` 中 `adaptClaudeMcpToolsToPi` 校验参数并调用 handler。本项目的 `scripts/demo-incident-live.ts` 用同一个 Adapter 建会话并限定可用工具。
- **测试位置：**`incident_agent/tests/workflow_tool_harness.ts` 直接经过 Pi Tool 适配器；`incident_agent/tests/test_workflow_acceptance.py` 验证收集结果；真实 LLM 记录见 [demo.md](demo.md)。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py -q`；手动 LLM 展示用 `py -3.13 -m incident_agent.demo_live INC-001`（需要已配置凭据，非 CI 命令）。
- **项目当前边界：**Pi Runtime、会话与通用工具框架属于 MiniClaw 基座。本项目接入 Incident 工具；确定性的 Workflow 测试不调用 LLM，真实 Demo 只跑过 INC-001/011/012 各一次。不能把上游 Runtime 的全部能力写成自己新增。
- **面试展示 / 追问：**打开上述三个 TS 文件和 `docs/demo.md`；准备回答“ToolCall 从 Pi 到你的 handler 经过了哪几层？Pi 自带的 Agent Loop 与你写的 Incident Workflow 有何区别？”

## 2. Evidence Tool：`query_logs`

- **简历描述：**“Logs……只读数据定义查询契约”。
- **解决的问题：**按 Incident ID 读取模拟日志并关联请求，避免模型凭空编造异常。
- **真实代码位置：**`container/agent-runner/src/incident-evidence-tools.ts` 的 `createIncidentEvidenceTools` 注册 `query_logs`；`loadIncidentFixture` 校验五份 Fixture；`query` 把日志条目封装为 `Evidence`；`mcp-tools.ts` 通过 `runSafe` 和 `withIncidentToolEvents` 接入。
- **测试位置：**`tests/incident-evidence-tools.test.ts`；`incident_agent/tests/workflow_tool_harness.ts` 和 `test_workflow_acceptance.py` 验证真实 ToolCall 返回的日志与 Fixture 相同。
- **验证命令：**`npx vitest run tests/incident-evidence-tools.test.ts`；`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py -q`。
- **项目当前边界：**读取仓库中的合成 `logs.json`，没有连接真实日志平台；错误或超时结果不算 Evidence。
- **面试展示 / 追问：**打开 `incident-evidence-tools.ts` 的 `query` 与 `INC-001/logs.json`；回答“日志里的 request ID 怎样与 Trace 对上？空日志和工具失败有什么区别？”

## 3. Evidence Tool：`query_metrics`

- **简历描述：**“Metrics……只读数据定义查询契约”。
- **解决的问题：**让 Agent 对照故障前后数值，而非仅凭错误日志判断根因。
- **真实代码位置：**同一 `createIncidentEvidenceTools` 注册 `query_metrics`；`query` 返回 Fixture `samples`，`loadIncidentFixture` 校验时间顺序和有限数值。
- **测试位置：**`tests/incident-evidence-tools.test.ts`；12 个 `test_case_workflow_acceptance` 均比对返回指标与对应 Fixture。
- **验证命令：**`npx vitest run tests/incident-evidence-tools.test.ts`；`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py -q`。
- **项目当前边界：**数值是设计的样本点，不是 Prometheus 等实时监控；模型对趋势的解释仍需要与其他证据核对。
- **面试展示 / 追问：**打开 `INC-001/metrics.json` 和 `INC-012/metrics.json`；回答“连接池等待与 SQL 查询慢如何区分？指标异常为何不足以定位 INC-012？”

## 4. Evidence Tool：`query_trace`

- **简历描述：**“Trace……只读数据定义查询契约”。
- **解决的问题：**按请求链路定位哪一个 span 变慢或失败，并与日志交叉验证。
- **真实代码位置：**同一 `createIncidentEvidenceTools` 注册 `query_trace`；`query` 返回 `traces`；Loader 检查 span 起止时间和 `duration_ms`。INC-012 的空 Trace `[]` 被允许返回。
- **测试位置：**`tests/incident-evidence-tools.test.ts`；`test_workflow_acceptance.py` 对照 `trace.json`，并检查 INC-011 的同一 span 冲突及 INC-012 空结果。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py -q`。
- **项目当前边界：**是静态模拟 Trace，不接入真实分布式追踪系统；空 Trace 不等于依赖正常。
- **面试展示 / 追问：**打开 `INC-011/trace.json` 与 `logs.json`；回答“同一 request/span 的两种说法冲突时为什么不能自动选一个？”

## 5. Evidence Tool：`query_git_diff`

- **简历描述：**“Git Diff……只读数据定义查询契约”。
- **解决的问题：**把告警前后的代码或配置变化作为可核对的候选原因。
- **真实代码位置：**同一 `createIncidentEvidenceTools` 注册 `query_git_diff`；`loadIncidentFixture` 检查 patch 的 `Date` 不晚于告警；`query` 返回 `git_diff` Evidence。
- **测试位置：**`tests/incident-evidence-tools.test.ts`；`incident_agent/tests/test_inc001_fixture.py` 检查连接池配置差异与时间线；12 个 Workflow 用例逐一比对 patch。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_inc001_fixture.py incident_agent/tests/test_workflow_acceptance.py -q`。
- **项目当前边界：**工具读取 `git_diff.patch` Fixture，**没有执行真实 `git diff` 或查询部署平台**；“无相关变更”也是正常工具结果。
- **面试展示 / 追问：**打开 `INC-001/git_diff.patch` 与 Loader；回答“为什么有变更不代表一定是根因？如何防止告警后的变更被误用？”

## 6. Incident

- **简历描述：**“故障事件、来源、时间窗”。
- **解决的问题：**用固定 ID、服务、告警和带时区的开始时间作为一次调查的入口。
- **真实代码位置：**`incident_agent/models.py` 的 `Incident`；每个 `incident_agent/fixtures/INC-xxx/incident.json`；`incident_agent/state_machine.py` 的 `IncidentLifecycle` 以 Incident 初始化。
- **测试位置：**`incident_agent/tests/test_models.py` 的 Incident 合法/非法 6 例；`test_inc001_fixture.py` 检查告警不直泄根因；`test_state_machine.py` 检查状态不可从输入字段伪造。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_models.py incident_agent/tests/test_inc001_fixture.py incident_agent/tests/test_state_machine.py -q`。
- **项目当前边界：**Incident 来自静态 Fixture 或测试构造，不接生产告警 Webhook；模型不能任意写状态。
- **面试展示 / 追问：**打开 `models.py` 的 `Incident` 和 `INC-001/incident.json`；回答“为什么 `started_at` 必须带时区？为什么 `incident.json` 不能含答案？”

## 7. Evidence

- **简历描述：**“证据链组织”。
- **解决的问题：**让一条证据可追溯到 Incident、来源、时间和关联请求，并限制诊断只能引用已收集证据。
- **真实代码位置：**`incident_agent/models.py` 的 `Evidence`；`container/agent-runner/src/incident-evidence-collection.ts` 的 `InMemoryIncidentEvidence`；`incident-tool-events.ts` 的 `evidenceMetadata` / `withIncidentToolEvents`；`incident_agent/workflow.py` 的 `InvestigationWorkflow.run` 校验 Evidence ID 与事件。
- **测试位置：**`test_models.py` 的 Evidence 6 例；`test_workflow_acceptance.py` 验证内容等于 Fixture、ID 对应 ToolCall；`test_timeout_recovery.py` 验证超时不覆盖先前证据。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_models.py incident_agent/tests/test_workflow_acceptance.py incident_agent/tests/test_timeout_recovery.py -q`。
- **项目当前边界：**Evidence 内容仍是模拟数据；JSONL 的 `EvidenceCollected` 记录元数据和 ID，不存完整原始日志/指标正文。
- **面试展示 / 追问：**打开 Evidence 模型、收集器和事件包装器；回答“如何证明某条 Evidence 是工具实际返回，而非模型写进答案的 ID？”

## 8. Diagnosis

- **简历描述：**“根因假设、缓解建议”。
- **解决的问题：**把有依据的根因、置信度、证据引用和建议变成可校验对象。
- **真实代码位置：**`incident_agent/models.py` 的 `Diagnosis`；`incident_agent/workflow.py` 的 `InvestigationWorkflow.run` 校验 Incident ID 与 Evidence ID，然后发 `DiagnosisCreated`；真实 Demo 的 `scripts/demo-incident-live.ts` 解析并校验模型决定。
- **测试位置：**`test_models.py` 的 Diagnosis 6 例；`test_workflow_acceptance.py` 前 10 个 Case 检查有 Diagnosis、非空证据引用和 `DIAGNOSED`；`docs/demo.md` 记录 INC-001 真实模型结果。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_models.py incident_agent/tests/test_workflow_acceptance.py -q`；已有模型记录见 `docs/demo.md`。
- **项目当前边界：**自动化测试使用 ScriptedEvidencePlanner，不证明任意真实 LLM 都稳定诊断；`DIAGNOSED` 不等于修复完成，建议不等于执行。
- **面试展示 / 追问：**打开 `Diagnosis`、`InvestigationWorkflow.run` 和 INC-001 Demo；回答“无证据 ID 的诊断为什么被拒绝？置信度如何得到，能否当作校准概率？”

## 9. Incident State Machine

- **简历描述：**“状态化诊断工作流”。
- **解决的问题：**阻止从新告警直接跳到已解决等非法状态，并区分证据不足的人工复核与系统内部失败。
- **真实代码位置：**`incident_agent/state_machine.py` 的 `IncidentStatus`、`_ALLOWED_TRANSITIONS`、`IncidentLifecycle.transition_to`；`incident_agent/workflow.py` 只把调查阶段推进到 `DIAGNOSED` 或 `ESCALATED`。
- **测试位置：**`incident_agent/tests/test_state_machine.py` 验证合法、非法和终态转换；12 个 Workflow 用例验证调查终态；`test_timeout_recovery.py` 验证超时后仍在调查态。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_state_machine.py incident_agent/tests/test_workflow_acceptance.py -q`。
- **项目当前边界：**正式状态是 `RECEIVED/INVESTIGATING/DIAGNOSED/AWAITING_APPROVAL/RESOLVED/ESCALATED/FAILED`；“根因假设”“缓解建议”“回放”不是独立状态。调查 Workflow 没有自动完成审批到修复的全程编排。
- **面试展示 / 追问：**打开转换表和 `transition_to`；回答“为什么 `DIAGNOSED → RESOLVED` 被禁止？证据冲突为何不是 `FAILED`？”

## 10. SAFE / ASK / BLOCK

- **简历描述：**“将高风险动作限制在获批后”。
- **解决的问题：**在执行器之前用确定性规则区分只读调查、需人工审批与禁止动作。
- **真实代码位置：**`container/agent-runner/src/incident-approval-gate.ts` 的 `POLICY`、`IncidentApprovalGate.decision`、`runSafe`、`requestRemediation`、`blockProbe`；`mcp-tools.ts` 注册四个 SAFE 查询、三个 ASK 模拟处置和 BLOCK 探针。
- **测试位置：**`tests/incident-approval-gate.test.ts` 测默认拒绝和边界；`incident_agent/tests/test_approval_boundary.py` 的 6 个核心用例经 Pi Tool 适配器验证 ASK；`tests/incident-remediation-tools.test.ts` 验证三种工具。
- **验证命令：**`npx vitest run tests/incident-approval-gate.test.ts tests/incident-remediation-tools.test.ts`；`py -3.13 -m pytest incident_agent/tests/test_approval_boundary.py -q`。
- **项目当前边界：**策略覆盖本项目列出的工具；`delete_database` 仅为永远 BLOCK 的安全探针，没有删除执行器。ASK 动作的 Executor 只是模拟，不触及真实服务。
- **面试展示 / 追问：**打开 `POLICY` 和 `decision`；回答“未知工具名或策略读取失败会怎样？为什么不能只靠系统提示词约束高风险操作？”

## 11. Human-in-the-loop Approval Gate

- **简历描述：**“人工审批边界”。
- **解决的问题：**Agent 只能提出高风险请求，可信宿主必须显式 `allow` 才能进入模拟 Executor；`reject` 后不得再次执行同一请求。
- **真实代码位置：**`incident-approval-gate.ts` 的 `InMemoryApprovalStore`、`requestRemediation`、`allow`、`reject`；`incident-remediation-tools.ts` 的 `createIncidentRemediationTools`。`allow/reject` 没有注册为 Agent 工具。
- **测试位置：**`incident_agent/tests/approval_boundary_harness.ts` 和 `test_approval_boundary.py`；`tests/incident-approval-gate.test.ts` 覆盖批准、拒绝及异常状态；`scripts/demo-inc001-reject.ts` 是**脚本化**拒绝演示。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_approval_boundary.py -q`；`npx vitest run tests/incident-approval-gate.test.ts`。
- **项目当前边界：**没有接入真实审批 UI/IM、真实服务重启或配置发布。2026-09-26 的三次真实 LLM Demo 都未主动提出处置 ToolCall，不能称其动态验证了审批分支。
- **面试展示 / 追问：**打开 `requestRemediation → allow/reject → executor`；回答“审批 ID 和人类操作者在哪校验？进程重启后待审批请求会怎样？”

## 12. Fail-Closed

- **简历描述：**“权限拦截”“审批前不产生副作用”。
- **解决的问题：**策略未知、读取出错、审批存储不可用、审批记录异常或没有人类操作者时，默认不调用 Executor。
- **真实代码位置：**`incident-approval-gate.ts` 的 `decision` 对异常回退 `BLOCK`；`requestRemediation` 在存储失败时返回 `blocked`；`allow` 对 ID、操作者、记录状态、请求一致性和策略逐项复核。
- **测试位置：**`tests/incident-approval-gate.test.ts` 的策略/存储故障、异常审批状态测试；`test_approval_boundary.py` 验证未审批与拒绝后 `executor_called=False`。
- **验证命令：**`npx vitest run tests/incident-approval-gate.test.ts`；`py -3.13 -m pytest incident_agent/tests/test_approval_boundary.py -q`。
- **项目当前边界：**这是 Incident 模拟工具的本地前置执行边界；不等于 MiniClaw 所有工具、真实基础设施或宿主权限都已全局 Fail-Closed。
- **面试展示 / 追问：**打开 `decision` 和 `allow` 的失败分支；回答“如果审批存储返回伪造的 APPROVED，为什么仍不能执行？”

## 13. AgentEvent

- **简历描述：**“写入调用 Trace”“可追溯性设计”。
- **解决的问题：**把创建、状态变化、ToolCall、ToolResult、Evidence、诊断、审批与失败记录为类型明确的事件，便于事后核对顺序。
- **真实代码位置：**`incident_agent/events.py` 的 `EventType`、`AgentEvent`、`InMemoryEventStore`；`container/agent-runner/src/incident-agent-events.ts` 的对应 TS 契约；`incident-tool-events.ts` 的 `withIncidentToolEvents` 在 handler 边界发事件。
- **测试位置：**`incident_agent/tests/test_events.py` 验证模型与事件存储；`tests/incident-agent-events.test.ts` 验证 TS 事件；`test_workflow_acceptance.py` 对每个 Case 检查 4 组 ToolCalled/ToolResult、4 条 EvidenceCollected。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_events.py incident_agent/tests/test_workflow_acceptance.py -q`；`npx vitest run tests/incident-agent-events.test.ts`。
- **项目当前边界：**AgentEvent 是本项目的故障调查事件，不等于 MiniClaw/Pi 的所有通用流事件；`ToolResult` 事件记状态，不保存完整工具响应正文。
- **面试展示 / 追问：**打开两个 `AgentEvent` 定义和 `withIncidentToolEvents`；回答“为什么事件要带 `tool_call_id`？哪些失败会产生 `ToolFailed`？”

## 14. JSONL Trace

- **简历描述：**“调用 Trace”“故障回放”。
- **解决的问题：**把每个事件逐行追加到磁盘，调查结束后仍能按顺序检查发生了什么。
- **真实代码位置：**`incident_agent/events.py` 的 `JsonlEventStore._persist`；`container/agent-runner/src/incident-agent-events.ts` 的 `JsonlIncidentEvents.persist`；`incident_agent/demo_live.py` 让 Python 生命周期与 TS 工具事件写入同一个 Case 的 JSONL。
- **测试位置：**`incident_agent/tests/test_events.py` 的追加验证；`test_timeout_recovery.py` 检查失败原因落盘；`test_replay_acceptance.py` 使用录制的 `INC-001.jsonl`；[demo.md](demo.md) 列出三次真实模型 JSONL 的路径及行数。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_events.py incident_agent/tests/test_replay_acceptance.py -q`；查看已有 Demo：`Get-Content data/incident-e2e/INC-011-20260926T124630Z-00f9f28c/INC-011.jsonl`。
- **项目当前边界：**JSONL 是本地文件，不是生产级集中日志/不可篡改审计系统；`data/` 被 Git 忽略，真实 Demo 的原始输出不在 PR 中。
- **面试展示 / 追问：**打开 `JsonlEventStore`、`JsonlIncidentEvents` 与一份本地 JSONL；回答“如何避免把 TS 已落盘的事件再写一遍？Replay 怎么发现乱序或坏行？”

## 15. Timeout Recovery

- **简历描述：**“3 次工具超时均保留已收集证据与失败原因”。
- **解决的问题：**调查工具卡住时给出机器可读的 `tool_timeout`，保留既有 Evidence 和 Event，允许同一调查继续查询其他工具。
- **真实代码位置：**`container/agent-runner/src/incident-tool-events.ts` 的 `IncidentToolTimeoutError`、`runWithDeadline`、`withIncidentToolEvents`；`incident-evidence-collection.ts` 的 `InMemoryIncidentEvidence`。
- **测试位置：**`incident_agent/tests/timeout_recovery_harness.ts` 为日志/指标/Trace 人工构造延迟，经过 Pi Tool 适配器；`test_timeout_recovery.py` 的 3 个核心用例核对 JSONL `ToolFailed`、原证据保留和后续查询成功。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_timeout_recovery.py -q`。
- **项目当前边界：**测试用 20 ms 人工超时覆盖 `query_logs/query_metrics/query_trace`；它不证明真实外部依赖故障、无限重试或 LLM 自动恢复策略，也未把 `query_git_diff` 算作第四个超时核心用例。
- **面试展示 / 追问：**打开 `runWithDeadline` 与 Harness 的 `delayUntilAborted`；回答“超时是返回错误还是丢弃 Evidence？先前的 Evidence 为什么不会被清空？”

## 16. Replay

- **简历描述：**“回放评测”。
- **解决的问题：**从已落盘的事件重建调查过程，验证状态与事件顺序，而不再次触发模型、工具或执行器。
- **真实代码位置：**`incident_agent/replay.py` 的 `load_events`、`apply_event`、`reconstruct_runs`、`render_replay`；`ReplayLoadError` 与 `ReplayOrderError` 报告坏行或非法顺序。
- **测试位置：**`incident_agent/tests/test_replay_acceptance.py` 的 3 个核心用例针对录制的 `tests/fixtures/INC-001.jsonl`，包括禁用 subprocess/socket/状态写入后仍可 Replay；`test_replay.py` 是额外辅助测试，覆盖重复追加的两次 run、坏行、乱序和拒绝后伪执行。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_replay_acceptance.py incident_agent/tests/test_replay.py -q`。已有 `data/incident-runs/INC-001.jsonl` 时可运行 `py -3.13 -m incident_agent.replay INC-001`。
- **项目当前边界：**Replay 是**只读重建**，不是重新调用 LLM 评估全部 12 个 Case；3 个核心 Replay 用例主要核对 INC-001 的录制事件，其他场景由 Workflow/Timeout/Approval 测试分别验证。
- **面试展示 / 追问：**打开 `apply_event`、`reconstruct_runs` 和录制 JSONL；回答“`ActionExecuted` 之前没有 allow 会怎样？Replay 为什么不能调用 Executor？”

## 17. 十二个 Deterministic Fixtures

- **简历描述：**“12 条模拟故障”。
- **解决的问题：**用可复现的输入覆盖不同故障模式，而不是每次依赖随机 LLM 或真实线上系统。
- **真实代码位置：**`incident_agent/fixtures/INC-001` 至 `INC-012`，每个目录都有 `incident.json/logs.json/metrics.json/trace.json/git_diff.patch`；`container/agent-runner/src/incident-evidence-tools.ts` 的统一 `loadIncidentFixture`；`incident_agent/evaluation/generate_fixtures.py` 可按固定值重建 INC-002～012；`evaluation/expected_cases.json` 仅供测试评测。
- **测试位置：**`incident_agent/tests/test_workflow_acceptance.py` 参数化 12 个 Case，逐一验证 Loader/Tool/Evidence/State；`test_inc001_fixture.py` 单独核验首个案例时间线。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py incident_agent/tests/test_inc001_fixture.py -q`。
- **项目当前边界：**10 个可推导故障、1 个证据冲突、1 个证据不足，都是合成数据；Ground Truth 在评测文件中，Fixture 工具不读取它。通用 admin-home Agent 若挂载整个仓库，可能通过通用文件工具读到评测文件，这不属于受限 Incident Tool 的隔离保证。
- **面试展示 / 追问：**打开任意两个不同故障的五份文件和 `loadIncidentFixture`；回答“如何保证时间线一致？为什么 Ground Truth 不在 `incident.json`？”

## 18. Escalation Case：INC-011 Evidence Conflict

- **简历描述：**“证据冲突样本降级为人工复核”。
- **解决的问题：**同一请求的日志称缓存超时，Trace 却显示相同缓存 span 正常、另有上游 503；模型不应强行从冲突材料中选单一确定根因。
- **真实代码位置：**`incident_agent/fixtures/INC-011/logs.json`、`metrics.json`、`trace.json`、`git_diff.patch`；`incident_agent/workflow.py` 的 `Escalation` 分支；`incident_agent/tests/test_workflow_acceptance.py` 的 `ScriptedEvidencePlanner.plan` 先检查同一 span 冲突。
- **测试位置：**`test_workflow_acceptance.py::test_case_workflow_acceptance[INC-011-None-ESCALATED]`（参数化 ID 以 pytest 实际收集输出为准）；[demo.md](demo.md) 记录真实 LLM 一次执行后 `root_cause=null`、最终 `ESCALATED`。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py -k INC-011 -q`；真实 Demo 如需重跑：`py -3.13 -m incident_agent.demo_live INC-011`。
- **项目当前边界：**测试知道“应该升级”，但 Agent 不会收到隐藏解释；真实 LLM 的一次成功 Escalation 不保证所有模型/提示词都稳定如此。
- **面试展示 / 追问：**同时打开该 Case 的日志和 Trace，再打开 `docs/demo.md`；回答“为何 Metrics 同时升高仍不能消除冲突？要请人工补什么证据？”

## 19. Escalation Case：INC-012 Evidence Insufficient

- **简历描述：**“证据不足样本降级为人工复核”。
- **解决的问题：**只有任务失败和队列堆积现象，没有异常细节、因果 Trace 或相关变更时，不编造依赖或主机故障根因。
- **真实代码位置：**`incident_agent/fixtures/INC-012/logs.json` 仅有重试消息，`metrics.json` 显示堆积，`trace.json` 是 `[]`，`git_diff.patch` 无相关变更；`InvestigationWorkflow.run` 接受 `Escalation` 并转 `ESCALATED`。
- **测试位置：**`test_workflow_acceptance.py` 的 INC-012 分支检查空 Trace、模糊日志和 `ESCALATED`；[demo.md](demo.md) 记录真实 LLM 一次执行时 `root_cause=null`。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py -k INC-012 -q`；真实 Demo 如需重跑：`py -3.13 -m incident_agent.demo_live INC-012`。
- **项目当前边界：**可确认失败与积压，不能从 Agent 可见证据推出确定根因；文档不披露评测答案，避免把答案反向写进展示 Prompt。
- **面试展示 / 追问：**打开该 Case 五份 Fixture；回答“空 Trace 与工具读取失败有何不同？下一步采集哪些具体信息？”

## 20. 十八个 Schema Tests

- **简历描述：**“数据校验库 Schema 测试为 18/18 通过”。
- **解决的问题：**拦住空字段、无时区时间、非法置信度和重复证据引用。
- **真实代码位置：**`incident_agent/models.py` 的 `Incident/Evidence/Diagnosis` Pydantic 模型及 `evidence_ids_must_be_unique`。
- **测试位置：**`incident_agent/tests/test_models.py`，三个模型各 3 个合法 + 3 个非法参数化用例，共 18 个，文件级 `pytestmark = pytest.mark.core`。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_models.py -q`。
- **项目当前边界：**只验证这三个模型的字段契约，不证明根因诊断正确，也不等同于真实 API/数据库 Schema 兼容性。
- **面试展示 / 追问：**打开三个模型和三组参数化测试；回答“为什么重复 Evidence ID 无效？带时区时间有什么作用？”

## 21. 十二个 Workflow Acceptance Tests

- **简历描述：**“12 条模拟故障，冲突或不足升级人工”。
- **解决的问题：**确定性检查 Fixture → Pi Tool 适配层 → Evidence → Workflow/State → Diagnosis 或 Escalation 的整条调查路径。
- **真实代码位置：**`incident_agent/workflow.py` 的 `InvestigationWorkflow.run`；`incident_agent/tests/workflow_tool_harness.ts` 经真实 `createMcpTools`、SAFE Gate、Pi Tool 适配器取证；`test_workflow_acceptance.py` 的 `MiniClawToolGateway`、`ScriptedEvidencePlanner`。
- **测试位置：**`incident_agent/tests/test_workflow_acceptance.py` 的 `CASES` 和参数化 `test_case_workflow_acceptance`，12 个 Case 一案一测。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_workflow_acceptance.py -q`。
- **项目当前边界：**模型决策由读取可见 Evidence 的确定性 test double 驱动；它不是 12 次真实 LLM 成功率测试，也没有 Mock 掉 Tool、Evidence、State 与 Event 路径。
- **面试展示 / 追问：**打开 Workflow、Harness 和 Planner；回答“为什么 CI 不用真实 LLM？如何确保 Planner 没按 Case ID 直接查答案？”

## 22. 六个 Approval Tests

- **简历描述：**“6 个高风险请求均在审批前被拒绝”。
- **解决的问题：**验证重启、回滚、改配置三类 ASK 动作，在未审批和人工拒绝两种情景下都不调用 Executor。
- **真实代码位置：**`incident-approval-gate.ts` 的 `requestRemediation`、`allow`、`reject`；`incident-remediation-tools.ts` 的三种模拟工具。
- **测试位置：**`incident_agent/tests/test_approval_boundary.py` 的 6 个核心用例（3 动作 × 2 情景）；`approval_boundary_harness.ts` 记录 `executor_called`；额外的 `tests/incident-approval-gate.test.ts` 检验允许后模拟执行。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_approval_boundary.py -q`。
- **项目当前边界：**三例未审批是 `approval_required/AWAITING_APPROVAL`，不是“被拒绝”；另三例由模拟人类显式 `reject`。6 是自动化用例数，不是 6 次真实模型提出的请求；不触及真实服务。
- **面试展示 / 追问：**打开六个测试函数及 Harness；回答“pending 与 rejected 的区别？已拒绝审批 ID 后再次 allow 会发生什么？”

## 23. 三个 Timeout Tests

- **简历描述：**“3 次工具超时均保留已收集证据与失败原因”。
- **解决的问题：**针对三类查询分别确认超时事件、错误码、旧 Evidence 和随后可继续查询。
- **真实代码位置：**`incident-tool-events.ts` 的 deadline 与 `ToolFailed` 记录；`incident-evidence-collection.ts` 的按 Incident 保存证据。
- **测试位置：**`incident_agent/tests/test_timeout_recovery.py` 中 `test_query_logs_timeout_keeps_prior_evidence`、`test_query_metrics_timeout_keeps_prior_evidence`、`test_query_trace_timeout_keeps_prior_evidence`；TS Harness 注入延迟。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_timeout_recovery.py -q`。
- **项目当前边界：**三个都是受控模拟超时用例，不是三次线上超时事故；验证“继续调查”，不验证自动重试或修复。
- **面试展示 / 追问：**打开三个测试名和 `assert_timeout_keeps_incident_and_evidence`；回答“测试为何要先收一条证据，再制造超时？”

## 24. 三个 Replay Tests

- **简历描述：**“3 个回放测试”。
- **解决的问题：**确认录制历史可重建、顺序匹配，且 Replay 不触发活的 LLM、Tool、Executor 或状态写入。
- **真实代码位置：**`incident_agent/replay.py` 的 `load_events`、`reconstruct_runs`、`render_replay`。
- **测试位置：**`incident_agent/tests/test_replay_acceptance.py` 的三个核心函数；`incident_agent/tests/fixtures/INC-001.jsonl` 为固定输入。
- **验证命令：**`py -3.13 -m pytest incident_agent/tests/test_replay_acceptance.py -q`。
- **项目当前边界：**核心三例都针对 INC-001 录制历史；不能表述为对 12 Case 全部做了 Replay。其他 Replay 边界测试属于完整集的辅助测试。
- **面试展示 / 追问：**打开固定 JSONL 和第三个测试中的 monkeypatch；回答“若 Replay 调用了 subprocess 或 socket，测试怎样失败？”

## 25. 四十二个 Core Tests

- **简历描述：**截图中的“42 个模拟断言全部通过”。
- **解决的问题：**固定一个可复现的 MVP 验收集合，避免把仓库其他测试数量混入项目指标。
- **真实代码位置：**`pytest.ini` 注册 `core` marker；五个核心测试文件分别设置 `pytestmark = pytest.mark.core`；相关业务实现分布于上述文件。
- **测试位置：**`test_models.py` 18、`test_workflow_acceptance.py` 12、`test_approval_boundary.py` 6、`test_timeout_recovery.py` 3、`test_replay_acceptance.py` 3；共 42 个 pytest 用例。
- **验证命令：**`py -3.13 -m pytest -m core -q`；完整辅助集为 `py -3.13 -m pytest -q`。当前分支最近一次已核验结果分别为 `42 passed, 27 deselected` 和 `69 passed`；GitHub PR #6 的 `validate` 后续也已通过。
- **项目当前边界：**42 是**测试用例数**，不是 42 个断言、生产事件或真实 LLM 回合；27 个未标记 core 的合理辅助用例仍在完整集。
- **面试展示 / 追问：**打开 `pytest.ini`、五个文件顶部的 marker，再运行核心命令；回答“为什么核心测试不用真实 LLM？为什么完整集是 69 而核心是 42？”

---

## Resume Mismatch：截图措辞与当前证据

以下仅审计截图中**本项目**的文字。建议优先**改简历**，因为本次任务不改代码，且不应为了保留夸大措辞去补造实现。

| 截图中的表述                                                           | 核对结果                                                                                                                                                                                        | 应改代码还是改简历                                                                                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “基于 Pi Agent Runtime、结构化记忆与持久化会话能力……统一管理故障事件”  | Pi Runtime、Workspace Memory、持久化会话是 MiniClaw 基座能力；本项目真实 E2E Demo 在临时目录建会话，结束后清理，未证明 Incident 证据写入或检索结构化记忆。                                      | **改简历：**“复用 MiniClaw Pi Agent Runtime 接入故障工具，并以 Incident/Evidence/Diagnosis 与 AgentEvent 组织调查”；若要称“故障记忆/持久化调查会话”，先单独实现并验证。 |
| “来源、时间窗、证据链接和查询状态的统一管理”                           | `Incident` 只有 `started_at`，没有完整时间窗字段；`Evidence` 的 `correlation_id` 和 ToolResult 的状态分别存在不同对象或事件中，没有统一的“查询上下文”持久化模型。                               | **改简历：**“用 Incident ID、Evidence 来源/时间戳/关联 ID 和 ToolResult 状态串联调查记录”；若要称统一时间窗或查询上下文，需先实现相应模型和查询接口。                   |
| “从告警接入、只读取证、状态化诊断、人工审批到故障回放评测的完整闭环”   | 各环节有实现与测试，但调查 Workflow 返回 `DIAGNOSED/ESCALATED`；真实 LLM Demo 没有主动提出高风险动作。脚本化拒绝 Demo 与真实调查是分开的；未证明一个自动 E2E 流程贯通到审批和修复。             | **改简历：**“构建模拟故障调查、审批门与只读回放的可验证链路”；若要称完整闭环，需补真实 Agent 请求处置后的受控审批 E2E、状态续接与记录。                                 |
| “将‘告警→取证→根因假设→缓解建议→人工审批’拆为可回放状态步骤”           | 状态机没有“根因假设”“缓解建议”“回放”这些状态；它们分别是诊断内容、建议和离线读取流程。                                                                                                          | **改简历：**“以 RECEIVED→INVESTIGATING→DIAGNOSED/ESCALATED 管理调查状态，高风险请求另经 AWAITING_APPROVAL”；不要把所有业务步骤都称作状态。                              |
| “6 个高风险请求均在审批前被拒绝”                                       | 6 个是 3 类动作 × 2 个测试情景：未审批返回待审批 3 个，人工拒绝 3 个；两种情景 Executor 均未调用。                                                                                              | **改简历：**“6 个审批边界测试覆盖重启、回滚、改配置的未审批与人工拒绝情景，均未调用模拟 Executor”。                                                                     |
| “故障回放评测……正常、证据冲突、重复告警、工具超时与高风险动作的回放集” | 3 个核心 Replay 测试只回放 INC-001；冲突/不足由 Workflow 测试，超时由 Timeout 测试，审批由 Approval 测试；辅助 Replay 测试覆盖追加的多次 run 和坏记录。不能把这些不同测试都归为一个 Replay 集。 | **改简历：**分别写“12 案例 Workflow 评测”“3 项 INC-001 Replay 核验”“3 项 Timeout / 6 项 Approval 边界测试”。若要原句成立，需新增多场景录制事件与 Replay 验收。          |
| “42 个模拟断言全部通过”                                                | `pytest -m core` 收集的是 42 个**测试用例**，每个用例可能含多条断言；完整集为 69 个。                                                                                                           | **改简历：**“42 项核心自动化测试通过（18 Schema、12 Workflow、6 Approval、3 Timeout、3 Replay）”。                                                                      |
| “将……四类只读数据定义查询契约并写入调用 Trace”                         | 四种 Fixture 查询确实通过 ToolCall 执行；AgentEvent/JSONL 保存工具名、调用 ID、状态与 Evidence ID，未保存全部原始 ToolResult 内容。                                                             | **改简历：**“为四类 Fixture 数据实现只读工具，并将 ToolCall/结果状态及 Evidence 引用记录为 JSONL AgentEvent”。                                                          |
| “核心设计与开发：2026.02—至今”及可能暗示个人独立 Ownership 的措辞      | 仓库代码、PR 与本次测试能证明当前项目实现，不能单独证明 2026.02 起始时间或每一项均由本人独立完成。                                                                                              | **先补归属/时间材料，或改简历：**仅保留本人可说明的开发阶段与职责；不要从源码反推个人贡献起点。                                                                         |

**Ground Truth 边界：**答案位于仓库内 `evaluation/expected_cases.json`，只供评测测试读取；[Case Matrix](incident-case-matrix.md) 已按此位置更新。仓库内明文答案对受限 Incident Tool 不可见，但对挂载整个仓库的通用管理 Agent 并非文件级隔离。2026-09-27 的 clean clone 核验还说明：没有单独配置 Provider 时，真实 LLM Demo 只记录 `FAILED`，不能把失败 Trace 当作成功调查证据；详见 [demo.md](demo.md)。
