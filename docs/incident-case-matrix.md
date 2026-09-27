# Incident Case Matrix（Day 3 · Stage 1）

> Day 3 Stage 1 设计稿；Stage 2 已新增 INC-002～INC-012 静态 Fixture。全部案例使用模拟数据，不代表真实生产事故。运行结果仍须分别验证。

## 使用边界与判定规则

- **Ground Truth 隔离：**下文的“真实根因”仅供测试数据作者和评测程序使用。当前答案文件位于仓库内 `evaluation/expected_cases.json`，由评测测试读取；Incident Fixture Tool Adapter 只读取各案例目录中的五份数据文件，受限真实 Demo 不开放通用文件读取工具。不得把本文件、真实根因、预期状态或评测答案放入 Incident Agent 的提示词或工具返回，也不得把答案写进 `incident.json`。如果通用 MiniClaw 管理员 Agent 获得整个仓库的文件访问权限，这不是文件级隔离保证。
- **证据设计：**每个案例至少提供一条可观察线索；前 10 个案例尽量由两种独立来源互相印证，并用相同时间窗口或 request ID 对齐。工具的正常结果同样是证据，例如“数据库查询耗时正常”可排除慢查询。Git Diff 只表示可见的代码/配置变更，不自动证明它就是根因。
- **状态口径：**本矩阵的“预期状态”是**调查阶段结束时**的状态。INC-001～INC-010 应在证据足够时到达 `DIAGNOSED`，这是中间状态，不是已修复；若后续提出高风险动作，仍须进入 `AWAITING_APPROVAL`，只在获批且实际执行成功后才可能 `RESOLVED`。INC-011 和 INC-012 应在无法可靠诊断时从 `INVESTIGATING` 转为 `ESCALATED`。普通证据冲突或不足不应记为 `FAILED`。`demo_stage4.py` 曾在 INC-001 诊断后脚本化**拒绝回滚**，所以该演示终态为 `ESCALATED`；[真实 LLM 调查 Demo](demo.md) 没有发起处置，终态为 `DIAGNOSED`。
- **工具结果口径：**“正常/无相关变更”表示工具成功返回可核对的正常数据；“空”表示确无记录；“缺失/失败”表示关键数据不可用，三者不能混为一谈。Stage 2 Loader 支持空 Trace（INC-012），但仍要求 Logs、Metrics 非空，Git Diff 有有效日期。某案例不需要四个工具都异常，也不要求 Agent 每次固定调用四个工具。
- **简明指标：**5xx 是服务器错误；p95 是约 95% 请求都不超过的耗时；缓存命中率是从缓存直接拿到结果的比例。数字只用于模拟前后变化，应在后续 Fixture 中保持一致。

## 案例总览

| Case ID | 故障模式                    | 调查阶段预期状态 |
| ------- | --------------------------- | ---------------- |
| INC-001 | 数据库连接池配置错误        | `DIAGNOSED`      |
| INC-002 | Redis / Cache 不可用        | `DIAGNOSED`      |
| INC-003 | 上游依赖持续返回 5xx        | `DIAGNOSED`      |
| INC-004 | 错误部署引入功能回归        | `DIAGNOSED`      |
| INC-005 | 过密任务触发 CPU 异常       | `DIAGNOSED`      |
| INC-006 | 请求数据未释放导致内存压力  | `DIAGNOSED`      |
| INC-007 | 环境配置指向错误地址        | `DIAGNOSED`      |
| INC-008 | 缓存 TTL 过短导致命中率异常 | `DIAGNOSED`      |
| INC-009 | 数据库缺失索引导致慢查询    | `DIAGNOSED`      |
| INC-010 | DNS 解析变慢导致依赖延迟    | `DIAGNOSED`      |
| INC-011 | 同一请求的证据互相冲突      | `ESCALATED`      |
| INC-012 | 缺少判定根因的关键证据      | `ESCALATED`      |

## INC-001 · 数据库连接池配置错误

- **Service：**`payment-service`。
- **Alert：**`POST /payments` 的 HTTP 5xx 比例超过 5%。
- **真实根因（仅 Ground Truth）：**数据库连接池 `max_connections` 从 50 被改成 5，正常流量下请求排队并在 2000 ms 获取连接超时。
- **Logs：**同一时段的 `database connection timeout after 2000 ms`，以及对应 request ID 的 HTTP 500。
- **Metrics：**活跃连接卡在 5、等待请求从 0 升到两位数；数据库查询本身仍约 40 ms，5xx 随后升高。
- **Trace：**失败请求的 `db.acquire_connection` span 接近 2000 ms 并报错；早先成功请求只需十几毫秒。
- **Git Diff：**合成配置差异显示 `max_connections: 50 → 5`，时间早于告警；须与其他证据结合判断。
- **Agent 预期最终状态：**调查阶段 `DIAGNOSED`；现有完整 Demo 因回滚审批被拒，最终 `ESCALATED`。
- **价值：**用现有 Fixture 作基线，让初学者看懂“连接等待慢”和“SQL 执行慢”是两回事。

## INC-002 · Redis / Cache 不可用

- **Service：**`session-service`。
- **Alert：**登录会话读取失败率升高。
- **真实根因（仅 Ground Truth）：**Redis 实例不可连接，导致读取会话时连接被拒绝。
- **Logs：**`cache connect refused`，并记录失败的会话读取 request ID；不要只写模糊的“登录失败”。
- **Metrics：**缓存连接错误数陡增，登录失败率同步上升；应用 CPU 和数据库耗时正常。
- **Trace：**同一 request ID 的 `redis.get` span 快速报连接错误，随后请求失败；无需把所有请求都设为失败。
- **Git Diff：**无相关变更，返回正常的“本服务在故障窗口没有相关部署/配置差异”记录。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**检验 Agent 能把外部缓存不可用与应用自身代码变更区分开。

## INC-003 · 上游依赖返回 5xx

- **Service：**`checkout-service`；上游为模拟的 `shipping-api`。
- **Alert：**结算请求的 HTTP 502 比例升高。
- **真实根因（仅 Ground Truth）：**`shipping-api` 在故障窗口持续返回 HTTP 503，结算服务把依赖失败转换为 502。
- **Logs：**包含上游名称、HTTP 503 和 request ID 的调用失败日志；本服务对应请求返回 502。
- **Metrics：**上游 5xx 比例升高，本服务 502 随后升高；本地 CPU、数据库指标正常。
- **Trace：**失败请求在 `shipping-api` span 收到 503，之前的本地校验 span 正常。
- **Git Diff：**无相关变更；不要伪造一个“必然有部署”的解释。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**练习从调用链找出故障边界，避免把“我返回 502”误判成“我自己产生了最初的 503”。

## INC-004 · 错误部署回归

- **Service：**`order-service`。
- **Alert：**新版本上线后，使用优惠券的下单请求 500 增多。
- **真实根因（仅 Ground Truth）：**新版本把可为空的优惠券字段当作必填字段处理，旧客户端请求触发异常。
- **Logs：**只有缺少该字段的旧客户端请求出现字段访问异常；普通下单仍成功，日志带版本号和 request ID。
- **Metrics：**新版本上线后优惠券下单 5xx 上升，普通下单 5xx 仍低；CPU、内存正常。
- **Trace：**失败请求停在 `validate_coupon` 或订单校验 span，尚未调用数据库或外部依赖。
- **Git Diff：**合成代码差异显示字段读取由“缺失时用默认值”改为“直接读取”；记录部署时间和版本。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**让 Agent 同时利用“只影响一类请求”和“变更前后时间”，避免把所有上线后的故障都泛称为部署问题。

## INC-005 · CPU 异常

- **Service：**`report-service`。
- **Alert：**CPU 持续超过 90%，报表接口 p95 耗时升高。
- **真实根因（仅 Ground Truth）：**定时统计任务的运行间隔被错误缩短，大量任务重叠占用 CPU。
- **Logs：**同一分钟内重复启动的统计任务及重叠执行记录；请求超时日志在后面出现。
- **Metrics：**任务启动次数和 CPU 同时激增；内存稳定，数据库等待数无明显增加。
- **Trace：**报表请求在本地计算 span 上耗时增长，没有单一缓慢的数据库或上游 span。
- **Git Diff：**合成调度配置差异显示 `interval_seconds: 60 → 1`，时间早于 CPU 上升。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**认识 CPU 忙与数据库慢、依赖慢的不同表现；根因是过密任务而非单纯“机器不够”。

## INC-006 · 内存压力

- **Service：**`image-service`。
- **Alert：**图片处理服务内存持续上涨并出现请求失败。
- **真实根因（仅 Ground Truth）：**新代码将处理后的图片缓冲区留在长期存活的列表中，处理完也不释放。
- **Logs：**处理图片数持续增加，后期出现内存分配失败或进程重启日志；早期请求仍成功。
- **Metrics：**内存随处理请求数持续上升，重启后下降又再次上涨；CPU 不必异常，失败率在内存接近上限后升高。
- **Trace：**同类图片处理请求在后期变慢或中断；Trace 不必直接“看见”内存泄漏。
- **Git Diff：**合成代码差异显示新增长期列表并在每次请求后追加缓冲区，但没有释放路径。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**练习观察随时间累积的故障，而非只看一次失败请求。

## INC-007 · 环境配置错误

- **Service：**`notify-service`。
- **Alert：**生产环境短信发送失败率升高。
- **真实根因（仅 Ground Truth）：**生产环境的短信 API 地址被误设为测试环境地址，测试环境拒绝生产凭证。
- **Logs：**发送请求返回鉴权失败，并安全地记录目标环境标识或域名；不得包含凭证值。
- **Metrics：**短信发送失败率升高，但网络连接时间和本地资源指标正常。
- **Trace：**依赖 span 成功连到测试环境地址后收到鉴权失败响应，而不是 DNS/连接超时。
- **Git Diff：**合成环境配置差异显示生产配置中的 API 地址指向测试环境；只展示地址类别，不放密钥。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**区分“地址配错”与“服务不可达”，并训练不把凭证写进可观察证据。

## INC-008 · 缓存命中率异常

- **Service：**`catalog-service`。
- **Alert：**商品列表接口变慢，数据库读取量升高。
- **真实根因（仅 Ground Truth）：**缓存 TTL 从 300 秒误改为 1 秒，大量请求失去缓存保护；Redis 本身可用。
- **Logs：**频繁出现同一商品列表键的 `cache miss`；没有 Redis 连接错误。
- **Metrics：**缓存命中率从高位明显下降，数据库读取量和接口 p95 同时升高；Redis 连接错误为 0。
- **Trace：**请求的 `redis.get` 成功但返回 miss，随后执行正常速度的数据库查询；单次 SQL 并不慢。
- **Git Diff：**合成配置差异显示 `ttl_seconds: 300 → 1`。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**与 INC-002 对照：缓存服务正常也可能因配置让缓存几乎不起作用。

## INC-009 · 数据库慢查询

- **Service：**`search-service`。
- **Alert：**订单搜索接口 p95 耗时升高。
- **真实根因（仅 Ground Truth）：**一次数据库迁移删除了搜索所需的索引，查询开始扫描更多记录。
- **Logs：**订单搜索 SQL 的慢查询记录及 request ID；没有连接获取超时。
- **Metrics：**数据库查询 p95 从几十毫秒升到秒级，连接池等待数仍接近 0；接口耗时同步上升。
- **Trace：**`db.acquire_connection` 很快，`db.search_orders` span 很慢，定位到 SQL 执行阶段。
- **Git Diff：**合成迁移差异显示删除搜索字段上的索引，并有早于告警的迁移时间。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**与 INC-001 对照：连接池等待和 SQL 执行耗时要分别看。

## INC-010 · DNS / 依赖延迟

- **Service：**`profile-service`；依赖为模拟的 `avatar-api`。
- **Alert：**个人资料接口 p95 耗时升高，偶发超时。
- **真实根因（仅 Ground Truth）：**解析 `avatar-api` 域名的 DNS 响应在故障窗口变慢；成功连接后依赖处理仍快。
- **Logs：**少量 `DNS lookup timeout` 或解析耗时过长日志，带依赖名和 request ID；不伪造上游 5xx。
- **Metrics：**DNS 查询耗时 p95 上升，接口 p95 随之上升；上游成功连接后的响应耗时和 5xx 比例正常。
- **Trace：**慢请求的 DNS/连接建立 span 占大部分时间，后续 `avatar-api` 处理 span 较短。
- **Git Diff：**无相关变更。
- **Agent 预期最终状态：**`DIAGNOSED`。
- **价值：**将“找到依赖很慢”和“依赖处理请求很慢”分开，也与 INC-003 的上游 5xx 区分。

## INC-011 · Evidence Conflict

- **Service：**`checkout-service`；涉及模拟的 `shipping-api` 和缓存。
- **Alert：**结算请求偶发 502，单一根因尚不能从可见证据确定。
- **真实根因（仅 Ground Truth）：**`shipping-api` 返回 503；同一 request ID 的缓存超时日志被错误关联到该请求。此答案只供评测，Agent 不得获知“日志错关联”这一隐藏事实。
- **Logs：**针对 request ID `req-conflict-11` 报 `cache timeout`，看起来支持缓存故障。
- **Metrics：**缓存错误率与上游 5xx 都在邻近时间上升；采样粒度不足以确定该请求首先失败在哪里。
- **Trace：**同一个 `req-conflict-11` 的缓存 span 标记成功，随后 `shipping-api` span 返回 503，与 Logs 对该请求的描述冲突。
- **Git Diff：**无相关变更，不能裁决两份证据谁正确。
- **Agent 预期最终状态：**`ESCALATED`；应说明冲突、保留两种假设、请求核对 request ID/采样或补采证据，不应高置信度归因或执行处置。
- **价值：**检验 Agent 是否在“有很多证据”时仍能承认矛盾，而不是挑一条最顺眼的证据编结论。

## INC-012 · Evidence Insufficient

- **Service：**`email-worker`。
- **Alert：**待发送邮件队列持续增长。
- **真实根因（仅 Ground Truth）：**工作节点磁盘空间耗尽，无法写入任务临时文件；现有四类工具结果**无法**确定这一点。
- **Logs：**只有通用的 `job failed` 和队列重试记录，没有底层文件写入错误或磁盘指标。
- **Metrics：**队列长度上升、处理成功数下降；CPU、内存正常，但没有磁盘剩余空间指标。
- **Trace：**没有足以定位工作节点内部失败点的 span；若工具返回空记录，应明确是“未采集到 Trace”，不能解释成“Trace 正常”。
- **Git Diff：**无相关变更；不能从“没有变更”推出磁盘故障。
- **Agent 预期最终状态：**`ESCALATED`；应说明当前只知道工作任务失败，建议补采工作节点磁盘、文件写入错误或更细粒度 Trace，不应猜测真实根因。
- **价值：**检验 Agent 能否在资料不够时停下，提出具体补证方向，而不是为了填满 Diagnosis 编造答案。

## 后续制作 Fixture 时的验收约束

1. 每个 Case 的 `incident.json` 只含告警事实，不含本文件的 Ground Truth；答案在 `evaluation/expected_cases.json` 中，不由 Incident Fixture Tool Adapter 读取。
2. Logs、Metrics、Trace 的时间和 request ID 必须互相对得上；INC-011 的冲突是**有意设计并标记在本文件中**的唯一例外，不能把制作错误当作冲突案例。
3. 每个工具返回值都要标清“正常、空、失败/缺失”中的哪一种；目前仅 Trace 支持真正空数组，不要把其他来源的空数组宣称为可运行。
4. 前 10 个案例的评测重点是有证据支撑的根因类型和引用，不是强制逐字复述 Ground Truth；INC-011/012 的评测重点是避免无根据的确定性诊断与未审批处置。
5. 任何高风险处置都必须继续经过 Approval Gate；本矩阵不预设获批或修复成功。
