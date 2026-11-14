# L03-chat-pipeline 行为规格（`host/plugins/chat-pipeline/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 0 个 · 发出事件 0 种 · 契约：`contracts/ipc/L03-chat-pipeline.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [ ] Option → null 还是缺省（`skip_serializing_if`）：
- [ ] u64/i64 超过 2^53 的表示：
- [ ] 字段顺序（serde_json preserve_order）：
- [ ] f32 精度：
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：
- [ ] 取消：CancellationToken / drop → AbortSignal，取消点一致：
- [ ] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：
- [ ] 时间与 ID：生成方式、格式、时区：
- [ ] 不对含 HashMap 的结构做序列化后比对：

## WP-026 中央准入 dispatcher 组合（2026-11-06）

范围：复用已有 ApprovalGateHook/ToolRounds 算法，把 L04 registry/context 与 L05/L06 owner 接到
`composeToolRounds`。`api.ts` 增补 `bindToolRuntime(authority,todo)` 及两个最小 owner 消费接口。
自动组合仅在原子 owner 全部可用时成立，缺口详见 BLOCKERS；本节不勾选完整生产验收。

| Rust | TS 落点 / 行为 |
|---|---|
| tool_loop.rs:79–109 | ToolRounds.admittedDispatcher/initFromExecutionContext：读取子 context 的 session/message/block/variant/round/技能/feature/取消/题目模型，回到同一个 executeSingleTool；父 shell 标记不输入新 admission |
| tool_loop.rs:3445–3467 | executeSingleTool 仍逐次创建 ToolAdmission，走已有 beforeTool；拒绝不进入 registry |
| tool_loop.rs:3469–3521 | tool-executor-binding.ts 调 createExecutionContext；填实际 services/main/anki/vfs/llm/chat DB 与调用字段；admitted_tool_dispatcher 永远为当前 ToolRounds 的同一个非空对象；L04 registry 继续拥有 scoped cancellation/timeout/result budget |
| tool_loop.rs:3523–3582 | executeSingleTool 保留 final kill/cancel → registry.execute → taskAuditAfterTool；错误 emit/log/result 原有顺序不改 |
| hooks.rs:278–398,431–535,669–780 | tool-runtime.ts 直接绑定 chatState.killSwitch、L04 execution policy、L06 trusted automation、L05 local/external 分类/guard/command policy/root binding/effective sensitivity/ApprovalManager |
| hooks.rs:544,915,963；repo.rs:2851,2898,2915 | 明确等待 L04 authority/Plan 原子方法，消费契约与缺失诊断已接；不增加默认 allow 或另一套 SQL |
| runtime_roots.rs:1414–1499 | preferredRuntimeRootId 仅组合 getSessionWithConn/getGroupWithConn，同一连接、trim、缺行 None 与三条 warn 保留；L05 完成 root/环境绑定 |
| tool_loop.rs:2204–2230 | todo get → 有 list 才 owner persist(None variant) → debug；错误 warn 继续。L06 save 出口仍缺 |
| tool_loop.rs:3478 | windowEmitter 在同一 BackendEventsSink 上返回真实 WindowRef，保留原 emit 实现及批处理；L04 context 不再将 backendEvents 对象当作窗口 |

边界：内部 ToolCall 已由 L02/owner 解码，L04 unknown 参数类型在 dispatcher 收窄为 JsonValue；
不新增 IPC/持久化解码器。计划状态解码留给 L04，审批参数始终经 L05 redaction/scope。
chat 块仍经 L04 saveToolBlock 与原 pre/post/final persistence，无 SQL、新事务或时钟算法。
日志保留原 gate/registry，并增加缺 owner 的明确诊断。main/anki 同主库依据 lib.rs:3503。

测试 `tool-dispatch-binding.test.ts`：注册表/context/策略/审批真实；外域未公开原子 owner 和 leaf 为
明确 fixture。验证字段、dispatcher 身份、工具块保存、子调用 policy/kill/cancel 零 leaf 效果、
继承的 shell 标记仍需真实 ApprovalManager。该证据等级为接缝测试 + Rust 审读，
尚不能代替“真实已注册工具→第二轮 HTTP”和“真实父 shell 批准→子命令再审批”的完整安装链验收。

## WP-025 单轮真实 send 接线证据（2026-11-06）

本节覆盖合法普通会话、禁用工具、无图片/工作区/目标、关闭记忆与检索、锁定标题的单轮；
复用main `6898abaae`已有生产实现。旧阶段“未实现execute/仓储未发布”的描述不再适用于该路径。

### 实际组合原件与服务签名

- 可复用组合：`tests/chat-host.ts:20–72` + `tests/fixtures/finalization.profile.json`，
  `createPipelineHost({llm:true,diagnostics:true})` 加载真实L04/L02/L01/L05/L11/L13/L12，
  F3真实迁移的chat_v2/mistakes/vfs库与F4 backgroundTasks；仅远端HTTP/SSE脚本化。
  notes空端口不被本包输入使用；未提供chatToolRuntime，不需要工具roster。
- L04 `ChatSessionService.createMessageSender(deps: MessageSenderDeps): MessageSender`；
  `createSendExecution(pipeline: SendPipelinePort,state: ChatV2State): ChatSendExecution`，
  后者提供`runSendMessage(window,request,registration): Promise<string>`。
  **真实命令**由`chat/index.ts:304–319`注册，经`MessageSender.send/start`直接调用
  与createSendExecution相同的`runSendMessagePipelineOwned`，而非调用另造的工厂替身。
- L03 `ChatPipelineExecution.execute(window: WindowRef,request: PipelineSendRequest,
  cancellation: AbortSignal,state: ChatV2State|null): Promise<string>`（api.ts），
  `index.ts:237–240`→`composed()`→`PipelineExecution`。无prepared-only/singleShot替代。
- L02 `LlmModel2Streaming.callUnifiedModel2Stream(input: UnifiedModel2StreamInput):
  Promise<StandardModel2Output>`；input没有signal，取消经
  `LLMManager.requestCancelStream(streamEvent: string): Promise<void>`。
  `llm/src/model2_streaming_service.ts:45–124`→buildModel2Request→prepareModel2Async→
  establishModel2/readModel2→L01适配器；真实配置通过`save_api_configurations`写入。
- L02 `llmContextCompiler@1` 已在main（`llm/api.ts`的ContextCompilerLlmOwner）：
  `callRawPromptWithConfigIdAndImagesCancellable(configId:string,prompt:string,images:ImagePayload[],
  callerType:'chat_v2',cancellation:AbortSignal):Promise<StandardModel2Output>`与
  `callDedicatedOcrFreeTextWithFallback(imagePath:string,cancellation:AbortSignal):Promise<string>`。
  `llm/index.ts:160–163`引用与`llmRawPrompt`/`llmOcrPages`相同方法；L03
  `execution-runtime.ts:340–347`已绑定这两个正式服务。普通文本只走L03 noImages，
  不强行调用视觉owner以制造调用计数，不改造这条已存在的等价组合。
- L04 owner：`buildUserMessage(params):UserMessageResult`、
  `createMessageWithConn(conn:SqlExecutor,message:ChatMessage):void`、
  `createBlockWithConn(conn:SqlExecutor,block:BlockInput):void`、
  `updateBlockReplayWithConn(conn:SqlExecutor,blockId:string,replay:BlockReplayData):void`；
  其他必需读口见`execution-runtime.ts:42–59`与`chat/api.ts:226–279`。
  所有chat表SQL留在L04；L03仅传F3事务句柄。

### Rust→TS分支与证据

| Rust生产分支 | 实际TS路径 | 命令回归事实 |
|---|---|---|
| send_message.rs:514–567,624–710 | chat/src/send-message.ts:131–150,200–222；register.ts:91 | kernel解码合法session/options；send立即返回指定助手ID；owned registration注入generation；后台完成才回收任务 |
| pipeline.rs:730–869 | execute.ts:193–214；freeze-execution.ts | 真实配置冻结后stream_start；HTTP到达时用户块已存在；输出model=wp025-model |
| pipeline.rs:1091–1136；context_compiler.rs:495–577 | execute.ts:336–347；context-compiler.ts:123–155 | 空历史、稳定system与user的runtime_facts分离；请求含完整user_query/injected_context；sidecar与实际请求文本逐字相等 |
| tool_loop.rs:1176–1243 | tool-loop.ts:440–450；llm/src/model2_streaming_service.ts | 真实统一流仅调用一次，disableTools=true，HTTP没有tools；不触发第二轮 |
| persistence.rs:860–960,1465–1505；pipeline.rs:1216–1217,871–944 | final-persistence.ts:45–76,118–180；execute.ts:242 | 用户、助手、块、sidecar共用同一事务；终态监听通过主连接已读到提交结果；usage为11/3/14 |
| pipeline.rs:997–1056 | execute.ts:215–240 | HTTP400业务错误：send仍返回准入ID；错误只由stream_error报告；用户保留、助手空块列表；无stream_complete |
| pipeline.rs:946–995,1143–1148；send_message.rs:860–882 | tool-loop.ts取消与finally；execute.ts:215–240；chat/register.ts:274 | 真实cancel命令使开放socket关闭，partial保存后唯一stream_cancelled；任务清空、无active stream、hook/pending消失；完整事件序列无晚事件 |

新增原件为`tests/send-command-composition.test.ts`的success/http-error/cancel三例。
事务观察用默认call-through spy（不替换实现），terminal时从真实主连接读取提交结果。
完成屏障是终态 + HTTP close + L04 trackedTaskCount=0；不把send返回ID当作落库完成。
原`execute-cancel.test.ts`全部断言保留（包括原九事件基序列、pending-tool分支、provider settle在终态前、
零usage、partial块、abort listener与pending清理）；新命令用例在基序列前增加真实L04 request_audit。

错误与日志沿用生产路径：400经L02 AppError→L03 LLM错误→stream_error；取消仍ChatV2Error.Cancelled，
partial保存失败warn继续；success/error/cancel三条pipeline日志与L04后台结算日志保持。
本包无生产实现或原移植测试改动；未作Rust动态差分、不变更TESTMAP资格，不签收D-003/全P1/C。
首轮新测试job `20261105175406-082ad4`为2pass/1fail/Errors 1：取消夹具漏传Rust必填
messageId，kernel按契约拒绝，导致等待终态超时。按send_message.rs:860–882补齐参数并在等待终态前
等待取消命令结果；未放宽30秒预算、未改生产行为。复验job `20261105175703-371fe7`三例通过，exit0。

## R2 P3/P6 与 X5-05 修正

- budget.rs:293–333：运行期 created_at/elapsed 使用单调时钟；createdAtUnix 单独取 Unix 秒。恢复时仅一次按 Unix 锚点计算停机耗时，之后继续单调累计，墙钟回拨不使运行期预算倒退。
- llm_adapter.rs:721：reset_stream_state 与 touch_activity 同用单调时钟，保留块 startedAt/endedAt 的 Unix 时间；不改变空闲超时阈值。
- budget.rs:1457–1470/1507：恢复两个原测试的 u64::MAX 输入，用 bigint 原样表示；保留 tool_calls 向 u32 收窄和 tokens/wall-clock u64 上限，不用 MAX_SAFE_INTEGER 替代。

## R2 P2 预算热路径与 P6 文件读取

- budget.rs:557/672–694/846–884/947–950/1007–1009：在插件安装时绑定 chatSession.database 的连接获取函数并恢复快照；创建（含轮换）、tryConsume 拒绝、recordUsage 达耗尽、release 解绑时 best-effort 落库。成功扣减且未超额不提前落盘，指纹不变跳过。
- 写入失败 warn，保持内存计数及未更新指纹，下次写入点重试；获取连接失败保留 `budget_snapshots: pool get failed:` 上下文。恢复连接失败 error 后继续插件启动。解绑先更新绑定/活跃数，再落快照和 debug。插件卸载只解除自身持久化绑定，不清任务树账本。
- budget.rs:573–600 使用 F3 独立短连接读取 settings，busy_timeout=2000；打开失败 warn/None，查询失败 warn/None，finally 关闭短连接。Rust `Connection::open` 不是只读打开：缺失文件会创建空库后查询失败；原向量必须在函数调用前验证文件不存在，不能预先打开来代替。
- R2 31b3d26af：F3 openFile 会自动 mkdir 父目录，L03 在调用前只读检查父目录；缺失/不可用时走原打开失败 warn 并返回 None，不调用会 mkdir 的平台入口。有效父目录下仍允许创建缺失库文件，没有恢复“必须只读”的错误要求。

## R2 P4/P5 memory-flush 处置

- policy 两条、legacy ledger、claim ordering、transaction rollback 五条仓储测试保留全部断言，但退回 pending；混合测试文件的 wiring 可达性不能代替 worker/compaction 生产调用证据。
- 删除未接线的跨域 DELETE：L03 不再直接写 memory_write_idempotency。L17 repository/idempotency.ts 已有 clearCompletedReceiptsWithPrefix，但当前 main 与 L17 分支 api.ts/MemoryService 尚未导出清理口；需由 L17 暴露该能力后再接入 worker，不能导入其 repository 实现。
- 上述 worker、压缩提交/队列编排仍是 L03 自有剩余工作，不以 P4 状态更正或 P5 删除 SQL 声称功能已完成。

## X5-03/04 生产事件绑定

- L03 StreamEventSink 的 meta 对象显式拆成 L04 emitter 的 variantId / skillStateVersion / roundId 参数，preparing 对接 emitToolCallPreparingWithMeta；禁止直接结构强转 emitter。
- start/preparing 登记块元数据，正文/思维链 chunk 使用 L04 普通 emitChunk 保留 100ms/4096 UTF-8 字节 batching（emitChunkWithMeta 会绕过 batching）；end/error 经 WithMeta 发送并由 L04 flush 尾部。
- 生产工厂 createSessionEventEmitter 使用 L04 BackendEventsSink→ctx.backendEvents，streamGeneration 传入 L04 原入口，插件卸载 dispose emitter；bindStreamingSink 和 createVariantStreamContext 都在 chatPipeline 服务发布。
- VariantStreamContext 的 start/chunk/end/error/preparing 立即传给绑定 sink，自动携带 variantId，保留原内存观察数组但不依赖回放数组发送。工具 preparing 的 skill/round 来自 VariantAdapterOptions（variant_adapter.rs:637–650）。
- 变体生命周期及终态状态机属于 L04 VariantExecutionContext，不在 L03 复制；本单元验证真实 Host emitter 的 variant_start/块流/variant_end 偏序，不宣称完整 execute/tool-loop E2E 已完成。

## C1 / L13 工具块类型映射

- 完整移植 context.rs:899–933 的真实映射：只剥离一次 `builtin-`，不 trim、不剥 `mcp_`/`builtin:`；workbench_* 与四个域写工具优先返回 workbench_ops，其余逐项匹配，未知返回 mcp_tool。
- `getBlockTypeForToolStatic` 由 api.ts 纯函数、chatPipeline 服务和 PipelineContext 静态方法共享同一实现；render_generative_ui 的两个原测试输入都进入完整映射，不为 L13 另写测试常量。
- 本函数无日志、事件、数据库副作用；映射本身不表示执行器已注册。

## C1 / F4 canonical_tools 与 prompt_contracts 原测试

- canonical_tools.rs 的 8 个原测试按原函数名及全部断言补入 canonical-tools.test.ts，经 api.ts 导出的真实 codec/schema/prepare 函数验证；生产 prepareExternalToolSchema 仍调用同一 prepareExternalTool。
- schema 缺省与 JSON null 都规范为 object/properties，保留原 description 默认空串；bridge/internal 名称来源、保留前缀和 route tuple 编码保持 Rust 语义，两个歧义路由不得碰撞。
- LATEX_RULES 从已有 prompt-builder 常量公开，生产 PromptBuilder.buildSplit 使用同一值；不新增/替换提示词。brief 已由 L01 api.ts 公开；difficulty rubric 当前没有可验证的 Host 生产消费面，不制造常量仅用于凑测试。
- special-token 17 条等待消费 F4 共享策略；最新 F4 分支 `5dc66e143` 已从 platform/util/{api,index}.ts 发布 `create_model_wrap_token_filter` / ModelWrapTokenStreamFilter，但尚未正常集成到本次 main。依 quality §10.7 等 main 集成后消费，不在 L03 复制过滤器。

## F4 wrap-token 策略实际接入（main a33e27417 后）

- tool_loop.rs:644–661 / multi_variant.rs:769–785/1219–1235：取冻结配置 providerType/providerScope/model 决定策略；无配置为 Disabled。正文/思考各创建独立 F4 ModelWrapTokenStreamFilter，不共享暂扣状态。
- createStreamingAdapter/createVariantStreamingAdapter 的可选 modelConfig 接收已冻结配置；显式传入的过滤器仍优先，默认 Disabled 也由 F4 实现。process/flush/reset 继续由已有 adapter 调用，不复制 17 条规则实现。

## L02 hooks 生命周期（tool_loop.rs:353–447/3882–3926）

- main 已集成 llmStreamEvents。createStreamHooksGuard 使用其 unregisterStreamHooksIfOwner 和 llm.clearCancelArtifacts，cleanup 顺序为 owner 注销→清取消 channel/pending→disarm；重复 cleanup 不操作。构造不自行注册，与 Rust new 一致。
- Drop 对应显式 await guard[Symbol.asyncDispose]()；空 key 的 dispose 跳过，cleanup 本身仍按 Rust 执行。按 run key 隔离旧任务，owner 身份不匹配不能注销新 hooks。无新增日志（Rust 此守卫无日志）。
- 测试加载真实 L02/L01 与 secrets/F3 服务，验证取消传播、hooks owner 移除、pending 消除、已移除旧 channel 不再收到新取消；AbortSignal 没有 tokio watch 的 has_changed/closed，使用公开取消行为验证同一注册表事实。

### WP-003 / D-003：partial 后取消的执行分支生命周期

| Rust 分支 / 隐式行为 | TS 对应要求 |
|---|---|
| pipeline.rs:1143–1148 外层 select 取消即 drop execute_with_tools | executeInternal 等工具循环取消退出及 finally 清理，不遗留 Promise.race loser；Cancelled 继续走原部分保存→唯一 stream_cancelled |
| tool_loop.rs:1163–1174 / 426–445 Drop 注销本轮 hooks | 取消同步撤销 owner hooks，finally 清 channel/pending；run-scoped key 不变 |
| select-drop 后不再 poll LLM future / 不再发 scoped 事件 | 本轮 sink 生命周期随 signal 失效；同时经真实 requestCancelStream 中止 HTTP，并等待调用 settle；不是仅隐藏事件 |
| 被 drop 的工具循环不再计算 usage、finalizeAll、执行待处理 tools 或进入下一轮 | 取消后的 await 恢复点抛 Cancelled，在结果处理前退出；保留 adapter 已收到文本供上层部分保存 |
| pipeline.rs:946–995 取消保存 / 日志 | 保留 LLM call cancelled、部分内容/保存日志、ChatV2Error.Cancelled；保存失败仍 warn，原终态及载荷不变 |

证据：新增 `tests/execute-cancel.test.ts` 经真实 chatPipeline/L02/L01/L04，HTTP partial 后保持连接打开，由取消关闭；完整事件序列、pending tool 不续发、provider settle/owner hooks 清理先于终态、原 usage 零值、部分保存及 signal listener/pending 清理。既有 X5 文件/断言不变；本项不改 Rust 测试去向。

## WP-061 WorkspaceInjector 检查点

原始链：pipeline.rs:1143–1217 → tool_loop.rs:468–483/2373–2422 →
workspace/injector.rs:66–114；context.rs:1334–1382；C11 落库/事件为 tool_loop.rs:2583–2768。

- 工具检查点在 post-tool-execution 保存后、重复空参数停机之后、task_completed 收尾之前。
  每次 execute_with_tools 仅创建一个 InjectionThrottle，多轮共享、最多2批；不在轮次中 reset。
- 初次工具循环成功后，空闲检查点新建独立 throttle（上限3），只检查一次；非空消息注入后，
  should_continue 或 context.workspace_injection_count>0 时续调 execute_with_tools(depth=0)，后者自然重建工具 throttle。
  Rust reset_count/reset_workspace_injection_count 仅定义/测试使用，生产不调用。
- L05 checkAndInject 独占判断冷却/批上限/空队列及 drain；不以 peek 替代消费、不重写 injector。
  工具检查错误按 Rust if-let-Ok 忽略；空闲检查错误 warn 后继续最终保存；续跑错误向上层传播。
- 非空格式化内容以 user 角色追加 chatHistory（metadata.workspace_injection/workspace_id），位于当前 user 和工具结果之前；
  不重排到工具尾、不把上轮普通回答补进历史。使用 L05 的字符安全4000截断与原格式。
- C11：先内存历史/计数，再 interleaved 块及顺序索引，立即写 L04 block、追加/创建助手消息，
  最后 start/chunk/end；三个数据库失败位置分别 warn，仍发事件并继续。最终保存保留注入块。
  Rust 首次无助手行时先写块会命中 FK（V20260130__init.sql:99），随后创建消息、最终保存补块；不调整顺序修原行为。
  toolOutput 使用 snake_case；start payload 使用 workspaceId/messageCount；skillStateVersion/roundId 沿 Rust。
- 取消保持 WP-003：等待 provider/hooks 清理后上层保存 partial、发唯一取消终态；已出队不回滚，
  取消前未到的注入检查点不消费；续跑取消使用 Workspace continuation cancelled 日志。
- 所有工作区读取/出队只经 L05 api.ts，chat 表只经 L04 WithConn；时钟/时间格式复用 F4。
  证据为真实 execute + agentWorkspace + L02/L01 HTTP + L04 数据库测试，非 A/B 差分，未计 C。

## D1 请求清单（WAVE2-BRIEF §8，2026-11-07，不改变行为）

- `src/request-manifest.ts` 的 `withRequestManifest` 包住 `llmModel2Streaming`，两个取用点都经过它：
  `composeExecution`（单轮工具循环与多变体 `variant-run` 共用的 `model2` 端口）和 `createUnifiedTextStream`。
  host 内没有别的 `llmModel2Streaming` 取用方。
- 每次请求在交给 L02 之前写一行 Host 日志：`[ChatV2::request-manifest] {json}`。内容只有 sha256 和 UTF-8 字节数，
  不含任何原文：system prompt 总体及各顶层标签段（标签外文本归入 `(untagged)`）；
  临时技能消息（metadata.kind=`skill_instruction`，带 skillId）；工作区注入消息（metadata.workspace_injection）；
  user 消息里的 `<injected_context>`（已解析引用、runtime facts、turn-volatile 块，按顶层标签分段，图片计数）；
  `custom_tools` 总体及逐个工具；其余 context 键逐个；整段 history。不写 chat_v2 库，也不写别的落库数据。
- 记录的是 chat-pipeline 交给 L02 的输入。L02 之后的加工（相邻 user 合并、provider 适配）不在清单内。
- 生成清单失败只 warn `[ChatV2::request-manifest] skipped (stream_event=…)`，请求照常发出，输入对象不变；
  provider 自身的错误原样抛出。移动端同样只写日志，没有额外依赖。
- 测试：`tests/request-manifest.test.ts`（分段/分类、失败路径、真实 execute + L02/L01 HTTP 的两次请求与 L02 实际输入逐项比对）。

## L05 不可变 shell guard（hooks.rs:171–196/1615–1637）

- main 已有 `immutableShellCommandGuard(command,cwd,protectedRoots)` 及 decision/effect 类型。L03 真实调用它，cwd 固定 null，protectedRoots 仅 HOME（无 HOME 为 []）；执行器在 spawn 前另行带真实 roots 复核，不在管线检查点伪造 cwd。
- 必须先由 L05 `isLocalShellExecuteTool(name,args)` 判断 builtin/local 来源与 local_shell_execute 语义名；false 直接 None。只有 arguments.command 为字符串时才调用 guard，空字符串照原样交给 guard 返回 deny。
- L05 `10f01f55c` 的分类器已正常集成main；L03默认调用 api.ts 的 isLocalShellExecuteTool，不拿 executor.canHandle/schema 替代。原 catastrophe 测试移除分类替身，经真实服务调用真实分类器/guard，保留本地deny与外部None两条Rust断言；补充参数类型分支测试仍允许显式分类端口。
- 本 wrapper 无日志/数据库/事件副作用，与 Rust helper 一致；不复制 L05 shell 词法/危险命令规则。

## Finalizer 解析收尾（finalizer.rs:133–143, 766–791）

- `artifacts` 缺省/null 返回空数组；元素 `path` 必须是字符串（null 不是有效路径）；可选 sha256/root_id 缺省/null 保留 None。
- 错误保留 `invalid artifacts declaration: ` 和 serde 的缺字段/类型上下文；解析失败不得进入文件定位。
- 后端 batch_manifest 解析失败记录工具名及解析原因，然后继续收集下一份证据；不把畸形证据当作成功清单。
- `finalizationWireReport` 省略空 exceptions/checks_run，内存报告保留两个数组。

## 平台公共语义接线（quality.md §2）

- F4 time 已发布：budget 快照使用 `toRfc3339` 的 AutoSi/+00:00；摘要消息使用 chrono serde 的 AutoSi/Z。
- F4 util 已发布：trim 直接引用平台实现；split_whitespace 仍需按 Rust White_Space 分割，平台尚未导出 split 方法。
- F7 tokenizer 已发布：生产 `estimateTokensWithModel` 必须调用注入的 nativeTokenizer；独立启发式估算仍对应 Rust 无 feature 路径。
- 预算默认设置读取接入注入的 `ctx.settings.get`，每次创建账本读取实时值；读取失败按 budget.rs:597 warn 并返回 None 以使用默认值。

## PipelineContext 初始化（context.rs:279–519）

- 属于 L03 自有实现，不再以 L04 未提供 PipelineContext 为阻塞。
- 保留前端消息 ID（包括空字符串）；仅缺省/null 时生成 `msg_` + UUID v4；初始化时冻结 runtime_facts。
- 拷贝 options/user_context_refs/path_map；attachments 恒为空；列表、Map、dirty Set 初始为空；token_usage 使用 Rust 默认 tiktoken 来源；其他 Option 初始 None。
- start_time 使用单调时钟；elapsed_ms 向下取整；取消令牌保留同一个 AbortSignal。
- add_tool_results 先将非 None block_id 标 dirty，再按输入顺序追加结果；web_search item 按字符串 id 后到覆盖，无 id 则追加。
- 此单元无数据库、事件或日志副作用；通过 chatPipeline.createPipelineContext 提供。

## 执行快照解码（types.rs:1387–1414, context_compiler.rs:868）

- 非可选字段缺失时整体返回 None；imageBudget/historyImageBudget 是 usize，不接受负数或小数。
- planner.activeModel/fallbackFrom 是 Option，缺省与 null 等价。
- 反序列化得到独立所有权，修改后续消息元数据不得改变已冻结的 capabilitySnapshot/planner。
- 无日志、事件或持久化副作用；现有 chatPipeline 快照 codec 方法直接调用此实现。

## 旧契约测试状态纠正

`pipeline-contract.test.ts` 中仅构造字面量/JSON.stringify 的测试不满足 quality.md §3.1。
已将 SendOptions 默认、MessageSources 默认、检索选项改为验证生产 PipelineContext 输出。
其余纯字面量测试暂退回 pending（断言保留），需要 L04 发布类型构造/codec 或改为真实服务持久化测试；
`context_limit_application` 的调用路径属本 lane 自有工作，继续迁移，不列作依赖阻塞。

另有 llm-content-crash / llm-content-retry-gap 共 20 条测试只有测试内 Timeline/BlockRow 模拟，
没有调用生产代码，全部退回 pending。`chat/api.ts:107–121` 目前未发布 replay sidecar 读写接口；
需要 L04 提供读 llm_content/tool_call_id/round_text 和写 replay sidecar 的接口，
L03 自有的首发前保存/重试时序仍需实现，不能把整个执行时序宣称为已阻塞或已完成。

## 预算整数精度（budget.rs:112–140, 355–515, 607–665）

- settings 接受 `+5`，拒绝 0、负数及大于 u64::MAX；合法大数不钳到 2^53。
- u64 在安全区间返回 number，超过安全区间保留 bigint；加法按 u64::MAX 饱和，剩余量按零饱和；子预算工具次数仅按 u32::MAX 收窄。
- SQLite JSON 快照保持 Rust 未加引号的十进制数字。使用 V8 原生 JSON reviver source/rawJSON 保留大整数，不经浮点数往返。
- 缺失/损坏快照仍走原 warn 后继续分支，写入失败仍带 root 上下文抛错；不得为了精度改变事务或副作用顺序。

## 流式回归（variant_adapter.rs:607–744, helpers.rs:419）

- 工具 preparing start 按 tool_call_id 去重，参数缓冲达 500 **UTF-8 字节**后发 chunk；完成收集时 flush，take 后清空。
- usage 走共用 API usage 解析；每轮 reset 保留已落下的 interleaved blocks，清空本轮文本与解析状态。
- watchdog 超时结束时同时取消 provider AbortController 并清除定时器。

## 完成块验收接线（finalizer.rs:895–1025）

- 取最后一个 output.task_completed === true 的工具结果；没有则返回 None，不查询 DB。
- 入参 artifacts 解析失败 warn 后按空申报继续；随后依次读取 batch_manifest、todo 输出及 L07 connector 账本。
- connector 查询错误作为不可验收证据（OutcomeUnknown），不抛出；默认无 runtime locator 与 Rust main_db=None 一致。
- 先改内存 tool_results 和 interleaved_blocks，再标记 dirty，最后调用 L04 chatSession.updateBlock；更新失败 warn 后保留 dirty，末轮保存可重试。
- 通过注入 chatSession 获取真实 DB；connector 查询仅 import L07 api.ts 的 sessionSideEffectSummary，不写其表。
- pipeline_tests.rs:1075 的错误 Display 用 L04 已发布 ChatV2Error 验证，保留 Cancelled/LLM/工具三条原断言；不再列为 L04 未提供。

## 契约真实往返（pipeline_tests.rs:16,93,619–778,832–873,1229–1272）

- 通过已发布 chatSession.createMessage/getMessage 验证 role、blockIds、attachments、sources、toolResults，使用迁移完备 SQLite。
- 保留 Rust 的字段值、None/缺省、snake_case role/camelCase DTO 断言；查询返回的是生产反序列化结果。
- source 数组长度为 1、memory 为 None；错误结果 success=false/error 文案和 durationMs 不丢失。
- 不新增 L04 类型构造器或复制仓储实现；本单元仅替换测试内字面量验证路径。
- pipeline_tests.rs:358–510 的用户块、助手 sources/toolResults 元数据及 block_index 顺序通过 L04 createBlock/getBlock/getMessageBlocks 和 createMessage/getMessage 的真实 SQLite 往返验证；生成 ID 使用现有 chatPipeline.generateBlockId。原断言全部保留，不把 L04 尚未导出的构造/状态变更方法测试混为已完成。
- MessageBlock.block_index 在 Rust agent.rs:358 为 serde skip；L04 getBlock/getMessageBlocks 只返回 wire block。测试通过公开 database.getConnSafe 只读验证该存储字段，再验证公开读取顺序与存储索引一致；不新增生产 SQL 或复制 L04 仓储。
- `test_context_snapshot_serialization` 验证 L04 message metadata 的真实 SQLite 往返；`test_send_context_ref_serialization` 验证 PipelineContext 产出的引用副本。
- `pipeline_tests.rs:1128` 实际仅断言 effective_max_tool_rounds，不依赖 LLM 环境；移植 None/0/30/500 四条断言。

## 剩余 str::trim 调用对齐

model_selection.rs:140–145、images.rs:133/330/500、memory_flush.rs:187、tool_loop.rs:1045/3863
以及 canonical tool/authority 解析均使用 Rust Unicode White_Space：NEL U+0085 属空白，BOM U+FEFF 不属空白。
统一调用 F4 rustTrim；不改变原来的“只判断为空”和“返回已去空白文本”之间的区别。
canonical tool-name 解码同时改用平台 decodeUtf8Strict：Node TextDecoder 的默认 BOM 消耗行为不等价于 Rust String::from_utf8；非法 UTF-8 仍返回 None。

## 检索页图真实解析（context_compiler/retrieval_images.rs:288–366）

- 通过 L13 `VfsDatabase.getConnSafe/blobsDir` 与 L11 `vfsRepo.blobs.getBlobPath` 解析原始 blob；无 VFS/连接失败按候选数返回 None，不查其他路径。
- 查询/读盘失败按 Rust `.ok()?` 静默跳过；超过 4 MiB 记原 warn（大小、hash 前 12 字节），非图片跳过；合法图片按原字节 STANDARD base64 编码，不依赖存储的 MIME 声明。
- 预算为零/无候选立即返回 None；按检索顺序只解析 remaining × 2 个候选；解析失败不扣预算，成功按序 commit 去重后构建现有瞬态消息，非空时记原 info。
- 不写数据库，不发事件；仅返回当前工具环的注入消息，保留已有轮尾插入语义。服务新增解析/构建入口；整个工具环仍依赖 BLOCKERS 中的 L02/L04 接口。

## Sidecar 写入编排（context.rs:1184；persistence.rs:423–537）

- liveUserLlmContent 只返回冻结 compiledCurrentUserMessage.content；未编译/空串返回 None，空白/多字节文本不规范化。
- 早写：无 live 内容先 debug 并返回，不取连接；getConnSafe 错误传播。读取用户块失败按 `.ok()?` 视为缺失；按 L04 返回顺序取首个 content 块，缺失 debug 后返回。仅写 llmContent，另两列为 None；写入错误传播，成功后 debug。
- 保存点：可选 userBlockId 和 live 内容均存在才写用户旁路；随后按工具结果输入顺序取非 None blockId、dirty 集合内的块及非空 toolCallId，roundText 按该调用 ID 精确查询。失败立即传播，不清 dirty、不提交/回滚调用者事务、不提前发事件。
- 最小消费接口 `ReplaySidecarWriter.updateBlockReplayWithConn` 发布于本 lane api.ts，接受 F3 SqlExecutor（与调用者事务共用连接）。L04 负责实际列更新及缺列兼容；本 lane 不复制其 SQL。测试替身只记录这个未发布接口的调用，验证 L03 控制流；真实崩溃/重试原测试仍 pending。
- 该服务方法已发布给上层调用；execute_internal 的完整阶段 4.6→5、首次发送及最终保存仍依赖 L02/L04，未注册残缺发送命令。阶段 4.6 的 warn 由该完整编排接入时记录，不把本方法的错误传播改成静默成功。

## P1 即时/增量保存与一次重试（persistence.rs:552–849；context.rs:766–787）

- 即时保存先取连接/Unix 毫秒，交给 L04 buildUserMessage 构建；只在用户 meta 追加后端 userMessageOrigin。先 message 后 block，原方法不包额外事务、不检查 skipUserMessageSave。
- 增量保存无 interleaved blocks 时直接返回。BEGIN IMMEDIATE 后：按 skip 选择重建用户或找已有 content 块；从 L04 只读 anki_cards 的 (block_index,id)，与 interleaved 序号稳定合并/去重；保存无 meta 的助手消息。
- 首次保存写全部块，以遍历序号覆盖 blockIndex；后续只写 dirty ID（同 ID 替换也置 dirty）。块就位后写 sidecar：用户完整编译文本，工具仅 dirty 且非空 toolCallId，roundText 保留空串。
- 只有 COMMIT 成功才清 dirty 并设置 intermediateSaveCommitted；写失败回滚并 warn，COMMIT 失败 error，保持 dirty。F3 AsyncTransaction 负责 COMMIT 失败的实际 rollback；若事务仍 active，L03 显式 rollback 并记录失败。开始/提交失败转 ChatV2Error.Database，写入错误原样传播。
- saveIntermediateResultsWithRetry：第一次失败 warn，等待 200ms，再试一次；成功 info，二次失败 error 后返回 false，不终止调用流程。无新增取消点。
- 最小消费端口 PipelinePersistenceStore 只传 SqlExecutor，不在生产路径写 chat 表 SQL。L04 已发布的 buildUserMessage/createMessageWithConn/createBlockWithConn/updateBlockReplayWithConn 待 main 集成；还明确需要 getMessageBlocksWithConn 与 IDs-only listBlockPositionsWithConn（或同义能力）。外部端口替身仅放测试，真实 F3 事务和 L03 保存时序不替代；对应原测试未真实绑定前保持 pending。

## P1 最终保存（persistence.rs:860–1549；pipeline.rs:495–518）

- BEGIN IMMEDIATE；用户保存/跳过与早写一致。助手块优先 interleaved，其次 generated（thinking/检索/其他），否则手动 thinking/检索/content；非interleaved再追加工具块。检索仅rag/memory/webSearch且非空，复用streaming块ID，时间戳为本次Unix毫秒减elapsed/duration。
- 最终保存的工具映射与 context 静态映射有差异：剥 builtin-/mcp_、支持graph_search，其他专用块保持原pipeline.rs:495映射，不以新映射替代Rust既有差异。
- 先读取现存anki_cards payload，再尽力读取现有message.blockIds，保留前端追加ID（排除anki）；anki按原blockIndex稳定插回，统一最终位置。首个保存message或retry update成功后写所有pipeline块；重插外部anki失败error后继续，其他失败传播。
- 助手meta保存chatParams全部9键（None为null）、显示模型回退规则、冻结快照、sources条件、toolResults、始终usage、非空contextSnapshot、去skill正文的before/after快照、reasoning items、技能锚点及web search items；inboundOrigin仅用户。交给L04 owner规范化持久化，L03不复制normalizeMessageMeta。
- 块就位后写完整sidecar。COMMIT成功后才incrementResourceRefs→triggerAutoMemoryExtraction→onTurnCommitted；写/提交失败不执行任何post-commit副作用。refs按Rust ContextSnapshot.all_resource_ids顺序与去重语义处理。开始/提交/回滚与保存信息各保持原日志和错误上下文。
- 新接口createFinalPersistence(store,effects).saveResults完成L03本体；owner的getMessageWithConn/updateMessageWithConn及post-commit业务端口必须真实绑定才能算普通execute落库完成。测试只替L04 CRUD与外域effects，F3事务、L03块合并/元数据/时序均真实执行；原pending状态不冒升。

## X7-L03-MULTIMODAL-TEXT-TAG / X7-L03-MULTIMODAL-IMAGE-TAG

- Rust dstu-core/models.rs:108–123 使用内部标签 `type`，Text为 `{type:'text',text}`，ImageUrl为 `{type:'image_url',mediaType,base64}`；不是外部标签对象。L03直接复用L02 Model2HistoryMessage的multimodal_content元素类型，无双形态兼容。
- textPart/imagePart 从api.ts公开，既有retrieval页图与canonical图片组装继续共用工厂。collectRuntimeImages/overrideMessageImagesWithCanonical/retainSelectedImagesForMultimodal/stripAllImages/countRequestImages 全部按 part.type 分支并读取平铺字段。
- 修正原测试只改变访问路径：images.rs的原图base64保留、canonical优先、预算裁剪与text回退断言全部保留；retrieval_images.rs:495的引用标签/页码、image/png与cGFnZQ==断言保留。新增multimodal-wire.test.ts经公开构造器和真实chatPipeline服务验证完整字段集合与L02类型可赋值性。
- 无日志/DB/事件语义变更，不以序列化形状修正宣称完整发送已实现。

## P1 已编译文本回合执行阶段（pipeline.rs:838–1055；tool_loop.rs:1245–1410/1545–1786）

- `createPreparedTextExecution(...).execute(turn,emitter,signal)` 接收已冻结配置、已编译当前用户文本和系统提示，显式 disableTools=true；它是完整 execute 的待组合阶段，**不等价**于 L04 SendPipelinePort.execute(window,request,cancellation,state)，不注册 send/retry 命令。
- 本体实际执行 stream_start→即时用户保存→真实L03 history loader→早写→外部统一流调用→L03最终保存事务→stream_complete。取消/错误实际从adapter回收内容，尝试最终保存，再发唯一cancelled/error终态，失败保存warn不覆盖原错误；仅成功路径继续goal/metadata外域端口。
- 使用main真实L02 hooks/cancel服务登记run key并finally owner清理；内容/推理/usage/签名/WebSearch hooks由真实adapter消费。LLM最小端口是UnifiedTextStream.call，测试fake只替此外部服务，不以singleShot代替。此端口尚无L02生产实现，故不宣称全链路已接入。
- 无输出瞬时错误最多2次1s/2s重试，已有正文/思考禁止重试；等待可取消。每次请求读timeout_ms（正u64向上整秒，默认600s）、auto_cancel（仅0/false关），沿用已有watchdog与7200s绝对上限。成功API usage优先，缺失按token_resources.rs串联prompt估算；失败保留已上报usage。
- 测试实际调用fake provider并通过真实F3事务写SQLite，验证user sidecar在provider前已写、同一block ID持久化、partial保存、terminal在commit后、owner注销。L04仓储仍只为外部端口替身，不能因此关闭P1/X5整项。
- 源码缺口修复（2026-11-11 Node 审计）：tool_loop.rs:1296 的 stream_has_output 只在首次失败后计算；1398–1443 的重试失败后不再重算。Node 的工具循环和 prepared text 阶段现均在每次失败后检查正文/思考输出，已输出则不再自动重试，保留部分回答并走原错误保存/终态。execute-entry 的真实 HTTP/SSE 回归覆盖首次空输出失败、重试输出正文后 idle timeout，prepared-text-execution 覆盖相同时序的端口错误；不改变其余重试预算或 Rust 测试资格。
- 尚未实现/接入：入口冻结/完整context compiler与prompt外域装配、工具轮分派/第二轮、workspace继续、请求/回复压缩、生产usage/goal/metadata/提交后memory接口绑定。上述步骤不得由该文本阶段静默代替；调用者必须完成准备与完整dispatcher后才可发布通用execute。

## L02 已集成统一流消费（tool_loop.rs:811–847/1176–1243）

- 本次确认main已含`44e7e8a76`及其前序公开的`llmModel2Streaming`真实服务；候选`ccd8c907f`不是main祖先，不能因此签收候选后继的llmHttp/image_paths/collector.ended。本单元只消费main现有API。
- `createUnifiedTextStream(sink,window)`调用`callUnifiedModel2Stream`，hooks仍由TextTurnExecution在llmStreamEvents预先注册。透传原sink/window/streamEvent/messageId，subject空、chainOfThought=true、taskContext=chat_v2、disableTools=true；model2OverrideId优先modelId，保留显式空串；systemPrompt使用已构造稳定段，不让options覆盖。逐字段传temperature/topP/frequency/presence/maxTokens/reasoningEffort/thinkingBudget/contextLimit。
- 组装context保留memory/rag/web功能开关的默认true及prefetched来源；未执行压缩检查则chat_v2_compaction_checked=false，不假造已校验。当前仅无工具文本阶段，不注入custom_tools。
- L02输入没有signal字段。调用前安装本地AbortSignal监听，取消经`llm.requestCancelStream(streamEvent)`写真实取消channel/pending registry；pre-aborted亦先登记取消。finally移除listener并等待取消请求，L02传输层负责中止HTTP和清理自身取消注册；外层L03 owner guard仍负责hooks。
- Legacy→Model2出站转换保留内部type标签的多模态part、reasoning/签名/工具ID/输出、文档/图片；metadata/args由unknown逐字段校验为JSON，不用as unknown as断言。L02纯对象AppError的message保持Display文案，不压成[object Object]。
- 本lane测试加载真实L02/L01/F3服务，本地HTTP只模拟远端SSE供应商；验证真实选模型/HTTP/body/hooks/保存/终态及在途socket取消。L04事务仓储尚未main集成，测试仍仅替owner CRUD，不据此声称完整SendPipelinePort/普通send已注册。
- 首次网络用例把system content错误预期为字符串；按Rust model2_pipeline.rs:5378–5383订正为精确text part数组及cache_control:{type:'ephemeral'}，不改L02生产实现或弱化系统提示正文断言。初次作业20261104124915-cdb403退出1，此失败记录保留，后续复验另报。

## P1 历史重放（history.rs:8–568/828–1119；compaction.rs:1497–1595）

- 先借 chat/VFS 连接（VFS 失败 warn 后无图重放），按会话顺序取全部 ID，排除当前 user/assistant；不按 contextLimit 截条数、不 microcompact 历史输出。先过滤所有 compaction_summary 载体，再按 active record/有效非空摘要/tail 边界取视图，失败各记原 warn 并回退原始历史。
- 批量 hydration/replay 读口由 L04 提供。只过滤其他变体拥有的块，共享块保留；active 缺失/悬空回退 message.blockIds。相邻 user/assistant 的 active variant artifacts 替换 user 上旧 derived artifacts。
- workspace_injection 插在本轮 user 前；turn/tool 技能锚定按原顺序恢复，digest 不符/正文缺失各 warn，不伪造新正文；digest mismatch 聚合去重后用独立 IMMEDIATE 事务请求前缀换代，失败 warn 不阻断历史加载。
- 用户 sidecar 先 find_map 首个 Some 再过滤空串（首块空串遮蔽后块），空白保留；同时解析快照图像但有 sidecar 时不重复文本。工具原 ID/roundText/thoughtSignature/reasoning/meta 回填，缺失 ID 使用 tc_ + 全部 blk_ 替换；失败优先 Error 文案，成功检索输出使用现有脱敏实现。
- thinking 在工具前按换行合并并消费；无工具时所有 thinking 直接拼接。仅文本/图片/文档/有效 thinking 全空时跳过；纯用户附件占位。旧图片取 previewUrl 第二个逗号段；文档只解析 data:，文本标准 base64+严格 UTF8，二进制委托 docs，失败 debug 后保留 base64。
- assistant 恢复 responseWebSearchItems 与 __final_assistant__ reasoning item；末尾摘要 prepend，再按原 validate/repair 分支补悬挂调用、去孤儿结果。正常加载 info 数量、工具重放 debug，所有日志保留。
- PipelineHistoryStore 是待集成的 L04 最小端口；额外需要 getCompactionSummaryMessageIdsWithConn 与 getMessageBlocksWithConn。测试只替 owner 读取口，加载/排除/过滤/格式/时序全由生产 PipelineHistoryLoader 执行；未绑定真实 L04 读口前原测试仍 pending。

## L05 VFS resolver 消费（history.rs:578–712）

- 原调用点为历史加载 `load_chat_history_pass` 的用户消息分支（history.rs:240），内部第 671 行调用 `resolve_context_ref_data_to_content(..., true)`；不是当前发送的 formattedBlocks 处理路径。
- 无 meta/contextSnapshot/userRefs 时原文和空图片列表原样返回。按引用顺序经 L11 ResourceRepository 读取；缺失/读取失败各记原 warn 后继续，无 data 记 debug 后继续。
- resource.data 按 VfsContextRefData 的 serde 形状解码，失败回退 inline note/translation/essay；inline 标题缺省为 typeId，保留原始文本包装，不额外转义（Rust 原行为）。未知类型 debug 后跳过。
- 引用模式：旧 image 注入模式覆盖为 image；file/textbook 覆盖为 text+image；其他类型保持原模式。经注入 agentVfsResolver 调用 resolveContextRefDataToContent，固定 multimodal=true，让当前 context compiler 在模型冻结之后决定 OCR 降级，不沿用旧轮 OCR-only 模式。
- 文本/图片按引用与 resolver 输出顺序累积；非空记原 info；文本以双换行连接并用 `\n\n---\n\n` 拼接用户原文。不写 VFS/聊天数据库，不发事件。
- L04 另有独立调用点 `handlers/variant_handlers.rs:1241`，需由 L04 接入；L24 chatanki_executor.rs:9991/10104 也直接消费 resolver。L03 不复制 L05 的 XML/媒体类型/OCR/PDF/题图解析实现。
## P1 执行入口契约（接口先行，2026-11-04）

`api.ts::ChatPipelineExecution` 发布命令层目标接口，`SendPipelinePort` 为其 execute 子集；
`ExecutableChatPipelineService` 为组合后的目标服务类型。当前 helper service 尚不冒充该运行时。

| Rust入口 | Host契约 | 调用方/生命周期 |
|---|---|---|
| pipeline.rs:599 | execute(window,request,cancellation,state) | L04注册stream/持有StreamGuard；返回助手ID，完成保存及终态后settle |
| pipeline.rs:705 | executeWithEmitter(emitter,request,cancellation,state) | L06 headless/L05复用；2+ parallelModelIds原文Validation，副作用前拒绝 |
| handlers/send_message.rs:1175–1207,1628–1657 | executeWithExistingUser同execute参数 | Rust无同名独立函数；语义为保持原request及ID，仅置skipUserMessageSave=true后execute；删除/恢复仍归L04 |
| pipeline/multi_variant.rs:86 | executeMultiVariant(window,request,modelIds,cancellation,state) | 共享user/assistant根，逐variant取消注册，返回助手ID |
| pipeline/multi_variant.rs:3053 | executeVariantRetry(window,sessionId,messageId,variantId,modelId,userContent,userAttachments,sharedContext,options,cancellation) | 返回void；沿用已恢复共享上下文 |
| pipeline/compaction.rs:431 | runCompactionForSession(sessionId,modelId,reason,excludeIds,contextLimit,memoryEnabled,cancellation) | nullable参数保留Rust Option；软失败返回outcome，硬DB/事务失败reject |

standard-v2 §2本批范围：入口签名已核；编排分支、生产日志/错误、同conn owner绑定、清理/取消、生产行为测试仍待后续实现。
`tests/execution-contract.test.ts`仅验证消费端类型（参数次序、nullability、返回值），不是运行时等价证据，不改变TESTMAP。
2026-11-04复查main/ad11a8394仍未含L04候选WithConn仓储和registry；已通知L04/C1优先正常集成，并请求final/history所需追加方法。

### P1 请求冻结实现（普通回答入口的前置步骤）

生产服务 `freezeExecutionContext` → `src/freeze-execution.ts` 使用真实 L02 llm/llmOcrModels 与 L12 planGeneration。
canonical builder由请求compiler提供，未把描述符构建、图片水合或整个execute宣称完成。

| Rust context_compiler.rs分支 | TS落点 |
|---|---|
| 67–90 OCR发现失败默认空；只排除专用OCR | getFreeTextOcrCandidatesByPriority的默认空处理、dedicatedIds |
| 92–104 config错误转Llm；strict精确模型不回退 | getApiConfigs错误映射、resolveStrictRequestedModel |
| 107–143 普通模型失败先默认分配再能力候选 | select(requestedId)→select(null)，原warn含requested/fallback IDs |
| 145–193 retry canonical复用、能力快照与无模型错误 | canonicalContentForFreeze、planGeneration及原中文Llm错误 |
| 194–209 能力选择；strict禁止换模型；send参数覆盖 | selectGenerationConfig、strict ID比较、applySendOverrides |
| 211–236 OCR通用视觉候选优先、去重、favorite/builtin/id排序 | auxiliary候选序列 |
| 237–257 冻结选项/显示名/canonical/执行快照 | 请求局部ctx赋值，快照墙钟Date.now与Rust Utc一致 |

- 边界：读取L02已解码ApiConfig，内部strictModelId对应types.rs:2157的serde(skip)，不添加IPC字段；完整config保留provider/auth，避免把GenerationModelConfig子集误当可请求配置。
- 所有权/运行时：此阶段无message/block SQL、无stream事件；只修改请求局部状态，L02负责配置读取。配置与重放canonical拷贝保留冻结所有权。
- 测试：`freeze-execution.test.ts`经真实Host服务验证模型优先级、删除模型回退、strict失败、canonical重放与能力路由；不是完整send验收。首轮测试因Cordis未声明注入的直接属性访问失败，已按既有可选依赖方式改ctx.get；新fixture另补ApiConfig必填isReasoning/isEmbedding/isReranker，未改业务断言。
- 次轮5/6通过：视觉fixture使用空key且非authMode=none，被L02真实凭证规则判为disabled；按config_resolution.ts:48–70补齐测试key，保留vision/route原断言。同时实际修改并保存L02配置再检验已冻结config不变，避免只修改读出副本的弱证据。

### P1 冻结上下文编译（2026-11-04，阶段实现）

生产入口：`ChatPipelineService.compileFrozenContext`→`src/context-compiler.ts`；图片读取入口：`resolveCanonicalImagePayloads`→`src/canonical-image-payloads.ts`。

| Rust分支 | Host落点/行为 |
|---|---|
| prompt.rs:448–520 | buildCurrentUserMessage；当前ctx.runtimeFacts不重算；无图/图文交替均保留文本fallback，volatile在user injected_context，不另造system |
| context_compiler.rs:495–514,581–608 | 缺冻结快照原Other错误；克隆历史、附当前canonical metadata；按消息/图片slot水合 |
| :603–671 | 真实VFS连接/BlobRepository查路径，异步读文件；缺失/读取失败返回None slot；非图片bytes拒绝、MIME不符warn并使用sniff结果 |
| :515–568 | 文本模型先复用派生产物，再按current/pinned/近期和独立history预算选择；noImages/MM直发/TM预处理三分支 |
| :674–757 | 每次编译共享75秒单调deadline；当前消息优先；辅助MM成功/空/失败/超时/取消分别保留原行为和warn |
| :759–815 | OCR逐图45秒且受共享deadline约束；非空结果拼接；仅当前message持久化可复用artifact，不保存unavailable占位 |
| :818–829 | strip所有图片，已复用覆盖与本次selected合并；unavailable→OCR→auxiliary→text路由优先级 |
| :570–577 | 成功后发布compiledCurrentUserMessage、重编译history、executionRoute；取消不发布半编译history |

- Owner边界：水合已消费L11真实blobs/getConnSafe，无owner SQL；缺blob_hash的file-id/resource-id后备查询通过必需`CanonicalFileBlobLookup`提供，已精确请求L11出口。辅助MM与OCR以`ContextCompilationPorts`必需方法表达，已请求L02原高层调用；不以singleShot替代。这个内部编译方法不等于完整execute注册。
- 入站边界：历史canonical由types.rs:1333–1384逐tag核必填、Option与默认bool，错误使整Vec返回None，未知字段忽略；本次消费不再对仅有type的对象作CanonicalContentPart断言。生成契约created_at仍为number，拒绝已不精确整数；超安全i64的完整D3表示尚待契约推进，未签收。
- 运行时：配置快照/历史为本次编译克隆；阶段取消经runPreprocessStage向owner AbortSignal传递，finally清timer/listener并abort子阶段；文件IO异步。完整execute外层select/资源生命周期仍属待接入口。
- 证据：`context-compiler.test.ts`通过真实Host→L02冻结→L11 SQLite/blob，视觉模型/OCR远端调用为明确脚本owner port；覆盖文本、图片预算、派生产物复用、fallback顺序、取消、坏图片及畸形canonical。未改变原Rust移植测试和TESTMAP状态。
- 初次作业20261104140147-654265退出1（6pass/2fail）：新测试未计strip_all_images对image_base64=None的归一化，且误把auxiliary RuntimeImage的canonical_mime当直接MM的sniffed MIME。按images.rs:224–249和strip_all_images修正精确预期；生产未改为迁就测试。复验20261104140741-c785e3退出0，compiler9+原images9全部通过，无Errors。typecheck早期作业20261104140147-ff44b6退出0，最终变更以后续selfgate为准。

### P1 L02高层调用侧接线与OCR临时文件生命周期

- L02确认`c2d193f13`中的ContextCompilerLlmOwner仅候选类型，不是已provide服务。L03 `ContextCompilerLlmCalls`明确表示必需消费契约；`bindContextCompilationPorts(owner,fileBlob)`必须传实际owner实例，不查询虚构服务，也不将unified/singleShot/prepareCandidates替代高层业务。
- `context-compiler-owner.ts`按context_compiler.rs:727透传configId/prompt/ImagePayload[]/`chat_v2`/同一AbortSignal，返回的StandardModel2Output仅取assistant_message。精确模型匹配、校验、内部重试、usage归L02，不在L03复制。
- 按:832–859使用F4共享decodeBase64Standard，保留`invalid image base64: <Rust DecodeError>`；PNG/WEBP/GIF后缀分别映射，其余jpg。临时文件使用paths.os.temp下独占目录和0600文件，异步写入后将路径与原signal交给高层dedicated OCR；所有退出路径finally删除本次独占目录，清理失败按Rust tempfile Drop的best-effort规则不覆盖业务错误。
- caller侧Promise取消竞速等价drop owner future；即使外部promise未settle也移除本地listener并清理temp。编译器取消/超时分支等待本次OCR端口的异步清理后再退出，避免终态早于临时文件释放；该端口契约要求abort后settle，内置binding用取消竞速保证此点。
- `context-compiler-owner.test.ts`通过真实Host服务验证raw参数、文件有效期间字节/后缀、成功/错误清理、严格base64以及compiler取消后的文件释放。L02高层owner本身为显式脚本测试边界，不增加PORTED或声称完整L02视觉链/execute已运行。
