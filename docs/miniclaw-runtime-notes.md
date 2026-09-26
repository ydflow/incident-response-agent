# MiniClaw Runtime Notes

> 范围：当前仓库 `main` 的生产 Pi Runner。MiniClaw 主体是 TypeScript/Node.js；`container/agent-runner/src/index.ts` 是保留的旧 Claude Runner，不是容器默认执行入口。以下是静态源码阅读结论，未启动模型或容器。目标业务链 `Incident → Agent → ToolCall → Tool Executor → ToolResult → Evidence → Diagnosis` 中，后两项尚没有专用实现。

## Program Entry

- 根 `package.json` 的 `start` 是 `node dist/index.js`。后端从 `src/index.ts:19724` 的 `main()` 启动，并在 `src/index.ts:21548` 调用。入口初始化数据库、状态、渠道及队列。`src/index.ts:20639` 把 `processGroupMessages` 注册给 `GroupQueue`；消息由 `processGroupMessages` (`src/index.ts:5595`) 汇集后调用 `runAgent` (`src/index.ts:9461`)。
- `runAgent` 按执行模式选择 `runHostAgent` 或 `runContainerAgent` (`src/index.ts:9603-9647`)。Host 进程运行 `dist/pi-index.js` (`src/container-runner.ts:2705-2709,2793-2799`)；Docker 的 `entrypoint.sh:162-163` 运行 `/tmp/dist/pi-index.js`。
- Runner 入口是 `container/agent-runner/src/pi-index.ts:427` 的 `main()`。它读取 `ContainerInput`、创建 `McpContext`，循环调用 `runTurn`。这层 `while (true)` 是多条输入的会话循环，不等于模型内部的 Agent Loop。

## Agent Loop

- `runTurn` (`container/agent-runner/src/pi-index.ts:295-425`) 先加载 Owner Profile 与 Workspace Memory，组装本轮 prompt，再创建工具、Provider 配置和 `PiRuntimeAdapter`。
- `runPiQueryAttempt` (`container/agent-runner/src/runtime/pi/pi-runner.ts:230`) 创建会话、订阅事件并调用 `session.prompt`；它还处理 IPC follow-up、关闭和中断 (`:271-341`)。
- `PiRuntimeAdapter.createSession` (`container/agent-runner/src/runtime/pi/pi-runtime.ts:49-171`) 调用依赖包的 `createAgentSession`。已安装的 `@earendil-works/pi-coding-agent/dist/core/agent-session.js:744-750` 调用 `agent.prompt`，并在需要时 `agent.continue`；真正的模型与工具循环位于其嵌套依赖 `@earendil-works/pi-agent-core/dist/agent-loop.js:78-160` 的 `runLoop`。这个循环不在 MiniClaw 自有的 `while (true)` 中。依赖包被 Git 忽略，重装或升级后行号需重新核对。

## LLM Call

- MiniClaw 自有代码在 `PiRuntimeSession.prompt` (`container/agent-runner/src/runtime/pi/pi-session.ts:197-207`) 调用 Pi 的 `AgentSession.prompt`。Provider 由 `resolvePiProvider` (`runtime/pi/pi-provider.ts:27-100`) 选取或注册。
- 已安装 Pi 包 `@earendil-works/pi-coding-agent/dist/core/sdk.js:170-191` 把流式请求交给 `modelRuntime.streamSimple`。对于 `anthropic-messages` Provider，已安装 `@earendil-works/pi-ai/dist/api/anthropic-messages.js:380-393` 中的 `client.messages.create(..., stream: true)` 才发出实际请求。换 Provider 时网络调用位置会改变；依赖包位于被 Git 忽略的 `node_modules`，升级后行号可能改变。
- `src/sdk-query.ts:92-155` 另有无工具的短查询，用于宿主侧辅助任务，不是生产会话的工具循环。

## Tool Registration

- 定义契约在 `container/agent-runner/src/mcp-tool-types.ts:13-34`：名称、描述、Zod 输入结构和异步 handler。`createMcpTools(ctx)` 在 `mcp-tools.ts:480` 构造内置工具数组。例如 `get_channel_context` 在 `:578-601`，其 handler 返回 `content` 文本块。
- `runTurn` 在 `pi-index.ts:327-348` 调用 `createMcpTools(ctx)`，再经 `adaptClaudeMcpToolsToPi` (`runtime/pi/pi-tools.ts:64-89`) 转成 Pi 的 `defineTool`，加入 `customTools`。`PiRuntimeAdapter.createSession` 在 `pi-runtime.ts:121-170` 把允许的内置工具名和自定义工具交给 `createAgentSession`。`Bash` 等名称被映射为 Pi 的 `bash` 等内置工具。

## Tool Execution

- 模型 ToolCall 由 Pi Agent Core 的 `executeToolCalls` 分派，可走顺序或并行执行（已安装依赖 `agent-loop.js:287-370`）。MiniClaw 自定义工具在 `pi-tools.ts:75-85` 校验参数后调用 `tool.handler(params, { signal, toolCallId })`；这才进入 `mcp-tools.ts` 中相应 handler。
- 部分 handler 只在 Runner 内读取上下文；需要宿主权限或服务的 handler 使用 `pollIpcResult` (`mcp-tools.ts:93-120`) 写 IPC 请求并轮询结果。宿主在 `src/index.ts:11290` 调用 `processTaskIpc` (`:11564`)，按 `data.type` 分派，例如 Workspace Memory 的 `:11962-12144`，完成后写回结果文件。
- **没有统一的 Python 工具函数执行器。** Docker 镜像安装了 `python3` (`container/Dockerfile:39-43`)，Pi 内置 `bash` 可在有权限的运行环境里启动 Python 命令；具体 Python 代码仍须以后另行实现并接入。不能把 Bash 调 Python 说成已有故障诊断 Tool。

## Tool Result Return

- 自定义 handler 返回 `McpToolResult.content` (`mcp-tool-types.ts:7-20`)；`adaptClaudeMcpToolsToPi` 将它转换为 Pi 的文本/图像 `content` 与 `details` (`pi-tools.ts:27-60,77-85`)。Pi Agent Core 创建 `toolResult` 消息并加入下一轮 `currentContext.messages`（已安装依赖 `agent-loop.js:113-129,534-551`）；Pi Session 同时在 `agent-session.js:367-379` 持久化它。
- `PiRuntimeSession` 把 `tool_execution_start/update/end` 映射为 RuntimeEvent (`pi-session.ts:89-114`)，`runPiQueryAttempt` 再把它们转为宿主可见的 `tool_use_start/tool_progress/tool_use_end` (`pi-runner.ts:93-127`)。这是观察/展示路径，不是 ToolResult 回模型的路径。当前 Pi 映射没有单独发出 `tool_result` 事件。
- 注意：`McpToolResult.isError` 在现有 Pi 适配器的返回值中没有作为顶层错误标记传递 (`pi-tools.ts:77-85`)；它保存在 `details` 里。抛异常与返回 `{isError:true}` 的可观察语义不可直接视为等价。

## Session / Context

- 宿主用 `src/db.ts:7743-7753` 的 `getSession` 和 `:7784-7815` 的 `setSession` 维护 Workspace/Agent 到 session ID 的映射；`src/index.ts:9489,9554-9567,9676-9688` 在运行前取 ID，在成功输出后更新。
- Runner 用 `sessionDir` 和 `sessionId` (`pi-index.ts:338-345`)；`PiRuntimeAdapter` 查找已有 JSONL 并 `SessionManager.open`，否则 `create` (`pi-runtime.ts:23-34,112-120`)。当前轮的 Owner、Memory、渠道上下文在 `pi-index.ts:306-325` 拼入 prompt。Pi 依赖负责模型消息历史与自动压缩 (`pi-runtime.ts:54-59`)。

## Existing Hooks / Events

- **Hooks：** 共享流协议有 `hook_started/hook_progress/hook_response` (`shared/stream-event.ts:19-21`)，宿主 UI 可消费 (`src/index.ts:696-706`)；这些字段不能证明生产 Pi 路径已经注册某个业务 Hook。已安装 Pi SDK 支持 `tool_call` 前置与 `tool_result` 后置扩展回调（依赖 `agent-session.js:225-269`），而本仓库 `pi-index.ts` 未显式注册故障诊断 Hook。
- **Events：** `runtime/types.ts:41-106` 定义文本、工具、用量、压缩、结果、错误等 RuntimeEvent；`pi-session.ts:51-155` 负责映射，`pi-runner.ts:72-220` 转为 StreamEvent。
- **Trace：** 有 `toolUseId`、session ID、流事件和 UI 展示，也有 Workspace Memory 的 `retrievalTrace` (`src/index.ts:12064-12072`)。源码中没有贯穿 Incident、Evidence、Diagnosis 的专用业务追踪对象；Pi 路径也未单独发 `tool_result` 流事件。不能把现有 UI trace 等同于可审计的故障证据链。
- **错误处理：** `mcp-tools.ts:93-120` 的 IPC 读取只吞 `ENOENT`、超时则抛错；各 handler 也可返回 `isError`。`pi-runner.ts:315-334` 传播致命错误或 prompt 拒绝；`pi-index.ts:519-530` 转成 `status:error`。
- **Timeout：** IPC 默认 30 秒 (`mcp-tools.ts:93-120`)，部分操作覆盖；宿主 Runner 有活动超时 (`src/container-runner.ts:1912-1944,2842-2868`)；Pi SDK Provider 还有 HTTP idle timeout（依赖 `sdk.js:178-191`）。它们作用层级不同，不构成统一的故障诊断时限。

## Recommended Extension Points

1. **先做定义与阅读：** Agent Profile 的身份/运行策略 (`src/routes/agent-profiles.ts`、`src/agent-profile-runtime.ts`) 和已加载的 Skill 路径 (`pi-index.ts:355-358`) 可承载诊断流程说明；这不会凭空增加读日志能力。
2. **将来做受控诊断工具：** 参考 `mcp-tool-types.ts`、`mcp-tools.ts` 和 `pi-tools.ts` 的工具契约、参数校验及返回格式。若需要访问宿主侧日志/指标服务，参考 `pollIpcResult → processTaskIpc` 的权限边界。Python 可实现独立的只读采集/分析程序，再通过明确的工具适配接入；当前尚无该实现。
3. **将来建立业务对象：** 独立定义 Incident ID、ToolCall ID、Evidence 来源/时间/原始引用、Diagnosis 与证据关系；使用现有 `toolCallId/sessionId` 做关联，但不要把自然语言答复当结构化 Evidence。
4. **Hook 需要先验证：** Pi 依赖提供 `tool_call/tool_result` 扩展接口，可研究其注册与阻断语义，再决定是否用于高风险处置动作。当前代码没有现成的故障处置审批 Hook。

## Files We Should Avoid Modifying

- `container/agent-runner/src/runtime/pi/pi-runtime.ts`、`pi-runner.ts`、`pi-session.ts`：会话创建、事件转换与输入收口核心。
- `container/agent-runner/src/pi-index.ts`、`src/container-runner.ts`：生产进程启动、IPC、Host/Docker 边界。
- `src/index.ts`、`src/db.ts`、`src/group-queue.ts`：宿主路由、权限、持久化与队列，改动面广。
- `container/agent-runner/src/index.ts`：旧 Runner 参考实现，当前不应作为新增能力的落点。
- `node_modules/` 内 Pi 包：安装产物；应通过受支持扩展契约接入，而不是直接改依赖代码。
