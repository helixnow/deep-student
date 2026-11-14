# L03 公开接口缺口与测试处置请求

本 lane 0 个 IPC 命令；交付入口为 `chatPipeline`。2026-11-04 C1 续派后重新核对提供方分支公开面。
TESTMAP 实际 367 ported / 79 pending / 5 approved obsolete；P4 撤回五条仓储误报，D6 仅豁免五条已批准空占位；hook cleanup 已通过真实 L02 服务，catastrophe 已通过真实 L05 分类/guard。

## WP-026 中央 dispatcher 原子依赖核实（2026-11-06）

续作核实：旧会话已于 `2026-11-05T19:06:15.002Z` 提交 board 的 `WP-026.report.md`，
原正式 gate 为 `4da26bec5 / main 4f5c83b1c`、`ok=true`；Electron 原 job
`20261105185530-3fa5f2` 为 11 passed / exit 0，无 Errors。恢复后合入 main `1defd30af`
得到 `e53edfa8d`，仅带入 F1 kernel 更新；`git show main:host/plugins/chat/api.ts` 与
`agent-orchestration/api.ts` 仍无下列原子读写出口。

C1 已派 L04/WP-168 与 L06/WP-169。L04 通知的正式时间参数是
`consumeSessionPlanBinding(sessionId:string,bindingKey:string,now:ParsedDateTime):boolean`，
值级出口为 `newPendingPlan(summary)`、`bindPlanToCall(plan,bindingKey)`、
`markPlanApproved(plan,ttlSecs:bigint)`、`markPlanExpired(plan)`、`isPlanBatchActive(plan,now)`、
`isPlanActiveForBinding(plan,bindingKey,now)`，Plan/SessionAuthority 使用 camelCase、缺 plan 省略。
这些是供方接口约定，尚非本次 main 已发布证据。下表的 `Date`/`createPendingPlan` 是
WP-026 已提交的最小消费端口；后续包须在 `src/tool-runtime.ts:20–24,32–42,91–94` 适配真实值级出口，
并将 `approval-gate.ts` 的 now/Plan 判断接到平台 ParsedDateTime 与 L04 值方法，避免经 Date 丢失纳秒/闰秒。
不能仅因三仓储方法发布就宣称现有自动绑定已闭合。L06 仍需接 `tool-runtime.ts:100–107` 的保存调用。
按 C1 本包收尾指令，供方消费、三条完整生产组合证据及其余79条原 pending 留待独立新包；
不将本 lane 自有剩余工作统称外域阻塞。

已按 main `136320e68` 的 `git show main:<owner>/api.ts` 核实：L04 registry/context 三工厂、L07 executor 注册表、
L05 分类/有效敏感度/shell scope/ApprovalManager、L06 trusted automation 均已公开。
**组合适配归 L03**；历史“整个 chatToolRuntime 等 L04 提供”的结论由本节取代。

L03 已增加 `src/tool-runtime.ts`，生产 `composeToolRounds` 会绑定真实 owner；
`ToolRounds.admittedDispatcher` 同一对象贯穿顶层/子调用，每次重新创建 ToolAdmission。
`src/tool-executor-binding.ts` 调用真实 L04 createExecutionContext/registry.execute，保留服务、
窗口、DB、技能、feature、variant/round/runId、取消信号及 crash-save。可通过
`chatPipeline.bindToolRuntime(authority,todo)` 显式消费相同绑定。

仍缺的原子方法（不是缺整个业务引擎）：

| owner / 必需签名 | Rust 实现 / 实际消费点 | 当前处置 |
|---|---|---|
| L04 `getSessionAuthorityState(sessionId): AuthorityState` | repo.rs:2851–2860；hooks.rs:544,915 → approval-gate.ts beforeTool 两次读取 | 不以默认 Craft 代替授权读取 |
| L04 `createPendingPlan(summary,bindingKey): PendingPlan`（含 markApproved）；plan 的 isActiveForBinding | types.rs:597–649；hooks.rs:1447–1448,1528 → approval-gate.ts:358,381 | 不复制 L04 值/解码实现 |
| L04 `setSessionPlanState(sessionId,plan|null): ChatSession` | repo.rs:2898–2910；hooks.rs request_plan_gate → approval-gate.ts:360,368,382 | 不自行更新 chat metadata |
| L04 `consumeSessionPlanBinding(sessionId,bindingKey,now:Date): boolean` | repo.rs:2915–2940；hooks.rs:963 → approval-gate.ts:292 | 必须 owner IMMEDIATE 事务重读/清除/提交，不用两次独立 CRUD |
| L06 `agentTodo.persistTodoList(sessionId,messageId,variantId|null,list): void` | todo_executor.rs:213–261；tool_loop.rs:2204–2230 → tool-round.ts persistTodoList | 已有 get/load/restore，无 save 公开面 |

缺任一时 `composeChatToolRuntime` 明确记录缺的方法并保持工具运行时不可用，不安装假策略。
已通过 coord 向 C1 即时投递 `WP-026-owner-request.md`，请拆上述原子 owner 方法并正常合入 main。
`tests/tool-dispatch-binding.test.ts` 是 owner 接缝回归：真实 registry/context/审批/分类/策略，
未发布 authority/Plan/todo 与 leaf executor 明确为测试端口；未 provide chatToolRuntime、未替换 registry.execute。
这不替代 brief 要求的三条完整生产安装链证据；其验收仍受上述依赖阻塞，TESTMAP 79 pending 不变。

## WP-025 当前单轮接线核实（2026-11-06）

基线 main `6898abaae`，已用 `git show main:host/plugins/{chat,llm}/api.ts` 及 chat/index.ts 核实：

- **无本包外域阻塞**：L03 `index.ts:194–240` 已组合完整 `PipelineExecution`；L04
  `index.ts:304–319` 在 chatPipeline/llm/backgroundTasks 就绪时注册真实 send；
  `src/send-message.ts:200–222` 经 owned StreamGuard 启动后台 execute。
  公开 `createSendExecution(pipeline,state)` 与命令复用同一 `runSendMessagePipelineOwned`，
  命令不是通过测试手工登记，也不要求再造执行入口。
- L04 `api.ts:226–279` 的构建器、WithConn、历史/sidecar 与会话元数据方法已在 main，
  `resolveExecutionOwnerStore` 绑定真实 owner；早期“17方法未发布/待合入”已解除。
- L02 `llmContextCompiler@1`（api.ts `ContextCompilerLlmOwner`）已由 `llm/index.ts:160`
  provide。它委托同一 `rawPrompt` / `ocrPages` 实例；L03 `execution-runtime.ts:340–347`
  已经直接消费这两个公开服务构成相同 owner 端口，无需添加第二套编译器或兼容层。
  本包文本输入走 L03 compiler 的 noImages 分支；不将其冒称 MM/OCR 网络分支验收。
- `tests/send-command-composition.test.ts` 为本包三路径原件：真实配置命令→真实 send，
  HTTP成功/HTTP400业务失败/partial取消；逐一检查编译文本与sidecar相等、同一事务句柄、
  终态时主连接可读用户/助手、tracked任务归零、stream/hook/cancel清理。
  旧 `execute-entry.test.ts` 的 owner-port夹具结果仅作历史阶段证据，新组合不使用它。
- D-003仍交C2/X5独立签收；WP-092页图结论复用；D47坏行append、工具第二轮/roster/D13、
  多变体与79条pending均不作为本包前置。本包不签收全P1或C。

下文带旧日期的“未发布/未实现”叙述保留为历史阶段记录；单轮发送的现状以本节及SPEC的WP-025接线表为准。

## WP-092 原集成页图失败复验（2026-11-05）

- 起点 `623da2d24aa47c66c19cbe4ac8309dd0f03e137d`；合入 main
  `4dc4c8ed984e79f932fcff234e2aad0b8a4fd0ff` 后候选为
  `909ab6fff7d38f3429f77611c05ee58e8522754f`。
- 历史原件 `.oc-runs/integrate-auto-2026-11-05T161013139Z.log:43–44`
  （主仓库只读）仅记录 `retrieval-image-resolution.test.ts` 中
  `page_image_message_marks_retrieval_hit_and_carries_labels: resolves real VFS blobs in order`
  失败标题。`gate-runner.mjs:18–34` 只在内存收集 stdout/stderr，
  `lib/gate-excerpt.mjs:45–53` 将摘录替换为失败标题；此路径没有保存完整测试输出。
  因而历史失败的耗时、异常/断言位置与根因均未知，不能据当前通过推断原来是超时。
- 原输入、断言、4 MiB 大小上限、图片预算与默认 30 秒测试预算均保留。
  定向 Node job `20261105165522-a60e12`：2 passed / 0 failed / 0 skipped，exit 0；
  本次首例 16952ms（仅本次实测）。原始输出与元数据位于
  `/home/dsdev/.oc-jobs/done/20261105165522-a60e12.log` / `.json`。
- main 已有真实 L02 统一流/取消、L04 WithConn，以及 L13 `VfsDatabase.getConnSafe/blobsDir`
  与 L11 `BlobRepository.getBlobPath/storeBlob` 公开面。页图生产调用为
  `index.ts:387–392` / `src/execution-runtime.ts:239–240` → `src/retrieval-images.ts:250–290`；
  本例使用真实迁移库和 blob 文件，本轮未发现需要修改的页图生产缺陷。
- D-003 仍由 C2 正常集成后交 X5 独立取消复验；本 lane 自检不签收 X5。
  C11 历史坏行仍归 D47/WP-097；WP-025 应先核实既有 execute 的真实能力，
  下方早期“完整 execute 尚未实现/WithConn 未发布”等历史文字不能作为重建依据。

## WP-003 依赖核实（2026-11-05）

main `967f43c75` 的 `llm/api.ts` 已有 `llmModel2Streaming.callUnifiedModel2Stream`，
以及 `LLMManager.requestCancelStream/clearCancelArtifacts`（UnifiedModel2StreamInput 没有 signal 字段）。
取消通过已有 registry 到底层 AbortSignal；不申请新接口。L04 WithConn 已可由真实执行入口消费，
本包 `execute-cancel.test.ts` 不再安装旧的 owner repository fixture。
下列早期缺口清单保留历史依据；上述「main 未集成」说法不再适用于 WP-003。
本包无外部依赖阻塞；X5 D-003 独立签收仍待修复进入 main 后复验。

## WP-061 更新（2026-11-05）

- 原 L05 WorkspaceCoordinator/WorkspaceInjector 运行时缺口已过时：main api.ts:14公开真实Injector/Throttle；
  create/hasPendingMessages/drainInbox/peekInbox均已发布。本包两个生产检查点真实消费，新建workspace可独立工作。
- X3-L05-02历史实例恢复inbox缺陷归L05；本包不绕过/重写恢复，不把新建成功当历史恢复通过。
- L04/L05/L06 `chatToolRuntime`完整生产组合仍需owner；本包工具轮的外部executor端口为测试夹具，
  L03门禁、工具循环、注入与L05队列均真实。普通回答的idle注入不依赖该工具runtime。
- C11即时追加使用L04 `getMessageWithConn/createMessageWithConn/appendBlockIdToMessageWithConn`；
  后者仅操作block_ids_json，避免整条update重写meta。正常有效行与缺失助手行已验证。
  **尚缺L04精确业务入口**：`appendWorkspaceInjectionBlockIdWithConn(conn, sessionId, messageId, blockId): void`，
  对齐tool_loop.rs:2718–2768（仅读block_ids_json；NULL/非法Vec JSON→[]；缺行创建；原错误前缀）。
  当前append接口使用SQLite json_insert，坏JSON会报错、NULL不会追加；Rust则回退[]。当前组合还会hydrate整条message。
  这是owner API的已知历史坏行差异，不能称该分支等价；不在L03复制SQL或改L04文件。
- WAVE0本包5命令/5场景未运行A/B。X5需提供README列出的参数化环回LLM端点；X7需终态/任务清理捕获屏障，
  否则send准入ID后立刻采库不代表最终状态。kill-switch/subagent只读/DB故障等外层分支交L04/L02/X3语料续包，见equivalence/README。
- 环境分词器已可用：起点工具轮job20261105152629-3e8a23三例实际运行通过，旧“tiktoken缺失”不再是本包阻塞。

## C1 普通回答 execute 续作边界（历史阶段，现状见WP-025）

已实现 `createFinalPersistence(store,effects).saveResults(ctx)`：最终块优先级、metadata、前端追加块/Anki位置、
同事务sidecar、提交后refs/memory/skills效果调用；普通成功/写失败/COMMIT失败/retry更新测试通过。
已实现 `createPreparedTextExecution(deps).execute(turn,emitter,signal)`：明确接收已冻结/已编译且disableTools=true的
文本回合阶段，实际调用外部UnifiedTextStream、L03历史/早写/最终事务、单一终态，并覆盖取消/部分失败/重连。
**这仍不是** L04 的 `SendPipelinePort.execute(window,request,cancellation,state)`，不能据此注册send IPC或宣称X5-03关闭。
入口模型/能力冻结、完整context compiler/prompt外域装配、工具轮/第二轮、workspace继续、compaction仍需L03实现；
main现有L02 llmModel2Streaming已可消费（不等于其未决usage/工具注册全部签收），L04事务接口仍待main集成。
没有以singleShot降级，也没有让fake替代L03执行/保存本体。

`createUnifiedTextStream(sink,window)` 已把prepared阶段接到main真实`llmModel2Streaming.callUnifiedModel2Stream`，
仅远端HTTP/SSE用本地脚本服务器；调用L02自己的模型选择、request builder、L01 provider适配和collector。
取消桥接至`llm.requestCancelStream(streamEvent)`，未向UnifiedModel2StreamInput添加不存在的signal字段。
候选`ccd8c907f`祖先检查对当前main退出1；当前main公开面已包含相同unified方法的前序实现，
分支后继差异主要为llmHttp、image_paths、collector.ended，L03此单元不依赖这些候选字段。
L04 CRUD仍只在测试通过明确owner端口替代；这不是完整send IPC或真实L04持久化接线的验收证据。

L04加急夹具：main新增llm inject injectionBudget，现已在 `411e1f1db` 的chat-host.ts用F3真实
InjectionBudgetManager/defaultBudgetConfig/newInjectionItem提供，最小guard作业20261104113603-676e5f退出0，2passed无Errors。

## X7 多模态wire修复证据

`a7fec7ffa` 修复 X7-L03-MULTIMODAL-TEXT-TAG / X7-L03-MULTIMODAL-IMAGE-TAG：
microcompact.ts 的 MultimodalContentPart 直接别名L02公开union，textPart/imagePart输出内部type标签；
images.ts的收集/替换/预算裁剪/去图与retrieval-images.ts计数全部读取type和平铺字段，无旧双形态兼容。
生产入口为api.ts公开构造器和chatPipeline.buildRetrievalPageImageMessage/overrideMessageImagesWithCanonical等。
原images测试继续断言相同raw/canonical base64和MIME，原retrieval_images标签/页码/image/png/cGFnZQ==断言不变，
仅访问路径按Rust models.rs:108–123纠正。新增测试断言完整字段集合、L02类型可赋值性及真实服务组装。
作业20261104115742-ceecd0：4文件21passed、exit0、无Errors；20261104115806-685f9b typecheck exit0。
这是TS生产入口+Rust源码证据，不称Rust/TS动态差分C级通过；完整execute仍见上节未完成边界。
**pending 不等于外部阻塞**：完整 execute/tool-loop、history 重放、增量保存/重试、compaction/flush worker 是 L03 自有剩余工作。

## 提供方状态与 L03 自有续作

| 提供方 | 已发布/仍缺的公开能力 | Rust 调用依据与 L03 续作 | 影响 |
|---|---|---|---|
| L04 chat | L04 分支 api.ts 已有 getHistoryBlocksWithReplayWithConn/updateBlockReplayWithConn/getBlockReplayMapWithConn/clearBlockLlmContentWithConn/buildUserMessage 与 conn 级 createMessage/createBlock 导出 | history.rs:75–81/219–249；persistence.rs:423–586。须完成 L03 真实历史转换、写入器绑定、首发前保存、增量事务和 dirty rollback；不再称 sidecar/构建器未实现 | history 10、multi_variant 3、crash 13、retry_gap 7、persistence 2，共35条 |
| L04 chat | 分支已发布 createCompactionWithConn/getActiveCompactionWithConn/setSessionLastCompactionWithConn 等 | compaction.rs 的 view 与 run_compaction 主编排仍需 L03 实现，包括事务内重读、摘要/lineage/flush 队列顺序 | compaction 12条；完整 L02 摘要生成仍缺 |
| L04 chat | 分支已发布 get/setMicrocompactAnchor、get/advanceToolFacePrefix、mergeFrozenToolSchemaOrder | helpers.rs:951–1011/1034–1073/1276–1300；L03 内存缓存/恢复编排仍未实现 | pipeline.rs 2条 |
| L04 chat / L05 | L04候选已发布createExecutionContext/createExecutorRegistry；L05 immutableShellCommandGuard和isLocalShellExecuteTool均已main公开并被L03消费，原catastrophe已通过；原子plan consume仍需对齐 | tool_loop.rs:4742–5630、hooks.rs:171–196；L03 admitted dispatcher/准入/重试/主循环仍是自有工作，不再以分类器缺失阻塞P1 | tool_loop 12条；原catastrophe已ported，非完整hooks签收 |
| L02 llm | main 已发布 llmStreamEvents 与 llmModel2Streaming.callUnifiedModel2Stream/WithConfig；createUnifiedTextStream使用前者，候选后继的llmHttp等不混入 | tool_loop.rs:360–447/811–847/1176–1243；L03 owner guard与统一流消费已实现；完整工具循环/请求准备仍自有未完成 | stream_guard 已ported；完整execute、工具轮/压缩与外域usage落盘仍未闭合 |
| L17 memory / L11 VFS | main MemoryService已公开extractCompactionSegment/applyFlushExtraction及receipt查询/清理 | compaction/memory_flush.rs:1201–1412；L03需消费owner API实现persist extraction→逐fact进度→complete账本→best-effort cleanup，不复制receipt SQL | memory_flush.rs 1条；P4/P5 worker自有未完成 |
| L04 chat | 分支已导出 loadAgentsInstructions/readAgentsMdFile/truncateAgentsMdContent/AgentsMdError | prompt_builder.rs:1599–1654；需完成 L03 prompt 调用与测试 | prompt_builder 2条 |
| L04 chat | 分支已导出 MessageBlock/ChatMessage 构造与状态方法、ContextSnapshot 构造/引用方法；请求 codec 仍需核实 | pipeline_tests.rs:33/253–321/1795–1897；可在正常集成后直接迁移本 lane 测试，不再将其全部列为接口缺失 | pipeline_tests 10条，详见下列名单 |
| L08 mcp | SearchInput 构造/codec 入口 | pipeline_tests.rs:782；mcp/api.ts:24 仅接口，doSearch 是会执行网络搜索的方法，不能以空替身冒充构造逻辑 | pipeline_tests.rs test_search_input_construction 1 条 |

L04 类型能力消费待办的 10 条：
- test_send_message_request_serialization
- test_message_block_creation
- test_message_block_set_status
- test_message_block_set_error
- test_message_block_append_content
- test_chat_message_new_user
- test_chat_message_new_assistant
- test_context_snapshot_initialization
- test_context_snapshot_add_retrieval_refs
- test_context_snapshot_all_resource_ids

原来归在类型能力下的用户块结构、助手 sources/toolResults 元数据、block_index 顺序四条，
已通过现有 L04 公共 CRUD 接口的真实 SQLite 往返验证并标 ported；block_index 是 serde skip 字段，
测试以公开数据库句柄只读核验存储值和返回顺序，不再列为接口阻塞。

尚未完成的自有主流程还包括 summary/context compiler 的完整编排、tool-loop dispatch/roster、multi-variant fanout。
L07 registerToolExecutors、L15 scoped、L12 unit builder 已有 main 接线证据，不能作为未发布服务继续等待。

L03 已发布 `BlockReplayData` / `ReplaySidecarWriter.updateBlockReplayWithConn` 最小消费接口，
并实现 `PipelineContext.liveUserLlmContent`、`chatPipeline.persistUserLlmContentEarly`、
`chatPipeline.persistReplaySidecar`。写入器由调用者显式传入；L04 分支已有可绑定的 updateBlockReplayWithConn。
新增测试用真实 L04 普通块存储及仅记录调用的 writer 替身验证 L03 选择/过滤/异常传播，
不代表真实 replay SQL 已接线，不改变上述 35 条 pending。完整发送/重放及增量保存事务仍待接入。

### 当前集成障碍（不是接口不存在）

C1 最新授权后已在 `2bdbf55f6` 正确合并冲突：使用 main 新 notes 名，同时保留本 lane 的
L05/L18 真实插件夹具和 setupStorage。合并阻塞已解除，未 stash/reset 或丢弃工作。
L04/L02 新符号的发布分支与 main 集成状态仍须分别核实，不能再把旧合并冲突视为当前阻塞。
独立 ACCEPTANCE.md/X5 文档未改勾选。R2 c53af794f 已撤回只读 settings 文件要求；本 lane
readBudgetSettingFromFile 保持 Rust Connection::open 的“文件不存在则创建”行为，没有新增只读限制。

### L05 guard 与 X5 fixture 复核（本轮）

- `tests/chat-host.ts` 的真实 F4 `createPaths({dataDir:root,platform})` 已在 `1f39f5d83`；
  X5要求的 stream-sink-wiring 两例队列作业 `20261104073614-29a529` 退出0，无Errors。
  未重做 binder，也未删减断言。
- `chatPipeline.immutableCommandGuardForToolCall(call,classifier)` 按 hooks.rs:171–196 委托真实
  L05 `immutableShellCommandGuard(command,null,[HOME])`；无command字符串返回None，分类false直接None。
  classifier最小签名 `(name:string,args:JsonValue)=>boolean` 对齐 L05 私有实现。
- L05 已从 api.ts 导出已有 `isLocalShellExecuteTool` 并正常main集成，其源位置
  `src/approval-scope/classification.ts:117–120`，Rust `approval_scope.rs:141–145`。
  它依赖 toolSourceNamespace(name,args) 判断 builtin/local 来源，不能用 canHandle/schema 或仅工具名前缀替代。
  生产wrapper默认使用真实分类器；原 catastrophe_guard_is_wired_only_to_backend_local_shell
  已去掉分类替身并通过，改为ported。完整准入/工具循环仍未完成。

## C1 / L13 映射交付与 F4 逐 ID 证据

L13 可 import `getBlockTypeForToolStatic` from `chat-pipeline/api.ts`，或调用
`ctx.chatPipeline.getBlockTypeForToolStatic`。实现为 context.rs:899–933 的完整映射，
`PipelineContext` 静态方法也复用同一函数。真实入口测试：
`host/plugins/chat-pipeline/tests/tool-block-type.test.ts::block_type_mapping_for_render_generative_ui_is_generative_ui`。
L13 修改自己的 TESTMAP；L03 不越界改状态。

以下为 F4 候选去向，未修改 F4 TESTMAP，也没有将新增测试计入 L03 的 451 条。
canonical 的 Rust ID 前缀为 `crates/dstu-core/src/canonical_tools.rs::tests::`，
TS 文件为 `host/plugins/chat-pipeline/tests/canonical-tools.test.ts`，用例名逐字等于下列 ID 后缀。
它们导入 api.ts 的生产函数；`prepareExternalToolSchema` 仍使用同一 prepareExternalTool 实现。

| 原 ID 后缀 | 真实公开函数 | 保留的原断言 |
|---|---|---|
| canonical_tool_name_codec_round_trips_invalid_names | encodeToolNameForApi / decodeToolNameFromApi | mcp.tools.fetch:url 编码为 ds_tool_ 前缀并逐字往返 |
| canonical_tool_name_codec_preserves_valid_names | 同上 | lookup_weather 编码不变且解码相同 |
| canonical_tool_name_codec_reencodes_reserved_prefix_names | 同上 | ds_tool_fetch 不原样透传、仍为保留前缀编码且解回原名 |
| build_openai_function_tool_schema_normalizes_missing_parameters | buildOpenAiFunctionToolSchema | 缺省参数为 type=object、properties={}，完整 schema 精确比较 |
| build_openai_function_tool_schema_normalizes_non_object_parameters | 同上 | JSON null 参数同样规范化，完整 schema 精确比较 |
| prepare_external_tool_for_legacy_pipeline_uses_bridge_name_source | prepareExternalTool | bridge/internal 名为 fetch:url；API 名解码以 mcp.tools.fetch:url 开头 |
| prepare_external_tool_for_chat_pipeline_uses_internal_name_source | 同上 | bridge/internal/server 三字段及完整 route tuple 精确相等 |
| external_route_tuple_encoding_prevents_tool_server_boundary_collisions | 同上 | 原测试的两组工具/服务器边界歧义均不碰撞 |

prompt 的 Rust ID 前缀为 `crates/dstu-core/src/prompt_contracts.rs::tests::`：

| 原 ID 后缀 | 生产面 / 测试去向 | 结论 |
|---|---|---|
| latex_rules_contains_core_constraints | api.ts 导出的 LATEX_RULES；`host/plugins/chat-pipeline/tests/prompt-contracts.test.ts::latex_rules_contains_core_constraints` | 四条原约束全部断言，另通过真实 chatPipeline.buildSystemPrompt 验证生产使用同一规则 |
| latex_output_brief_is_consistent_with_full_rules | L01 llm-providers/api.ts 的 LATEX_OUTPUT_BRIEF/_EN；同 TS 文件同名用例 | 中英四条原断言全部保留；F4 分支已有 `host/platform/util/tests/prompt-contracts.test.ts` 同名用例，可选其一，不能重复计数 |
| difficulty_rubric_covers_all_levels | 当前 Host 未检出 DIFFICULTY_RUBRIC 生产实现/公开消费面 | 继续 pending；不添加孤立常量再以测试字面量冒充闭合。Rust 使用方为 dstu-vision/{vlm_grounding_service.rs:1140,llm_structurer.rs:376,exam_sheet_service.rs:1777} 与 dstu-qbank/question_import_service.rs:3384/3436；需相应生产 prompt 接入证据 |

special-token：F4 `5dc66e143` 已经 main `a33e27417` 集成。L03 两种 adapter 的 modelConfig 选项
调用共享 `create_model_wrap_token_filter(provider_type, provider_scope, model)`，正文/推理各独立实例；
Disabled 也走共享实现。wrap-token-wiring.test.ts 通过真实服务/sink 验证 torn wrappers、reset、
独立思考/正文、非目标路由 literal 保留和 variant 流。17 个原向量仍由 F4 维护，不复制实现。

### R2 P4/P5 的新增自有待办

- 五条仓储测试退回 pending：policy×2、legacy ledger、claim ordering、transaction rollback；全部原断言仍运行。
- 已移除 L03 对 memory_write_idempotency 的 DELETE。L17 私有仓储有 clearCompletedReceiptsWithPrefix，
  最新 L17 分支 `6a0e276be` 已发布 cleanupFlushReceipts(segmentId)、queryFlushReceipts/getFlushReceipt、
  extractCompactionSegment/applyFlushExtraction/flushSegment；这些方法现已正常main集成。
  后续属于L03真实worker消费，不再报接口缺失，不复制receipt SQL。删除越界SQL不等于flush worker已完成。

### P1 保存编排续作（历史阶段；真实绑定已由WP-025核实）

`chatPipeline.createPersistence(store)` 已提供 saveUserMessageImmediately、persistUserLlmContentEarly、
saveIntermediateResults、saveIntermediateResultsWithRetry；PipelineContext.addInterleavedBlock 负责
同 ID 替换/保序/dirty 标记。两个原 persistence 测试已用真实 F3 SQLite 事务验证，L04 端口替身
仅提供消息构建/CRUD；生产选择/时序/rollback/200ms 一次重试均调用 L03 实现，因此继续推进但不改 ported。
L04 分支 `796ec7c9d` 已发布 buildUserMessage/createMessageWithConn/createBlockWithConn/updateBlockReplayWithConn，
并新增 `getMessageBlocksWithConn(conn,messageId)` 与
`listBlockPositionsWithConn(conn,messageId,type): [blockIndex,id][]`（仅 ID/位置，不读 payload）。
上述保存端口已齐，为待 main 正常集成的候选；不能再称这两个读取方法未发布。
它们对应 persistence.rs:737–753 的同事务读取，不用不带 conn 的 CRUD 或全 payload hydration 替代。
F3 `begin({behavior:'immediate'})/commit/rollback` 已足够正常事务与延迟约束回滚测试；其 commit 自带回滚，
双重故障时原错误/回滚错误分别暴露仍属平台诊断接缝，当前未声称穷尽该极端路径。

`chatPipeline.createHistoryLoader(store).loadChatHistory(ctx)` 已实现单变体历史加载本体：
当前消息排除、压缩视图、块/旁路 hydration、工具轮/thinking/meta、VFS 图像、旧附件、workspace/技能锚点、
digest 换代信号、active variant artifacts、工具链修复均经过生产实现。10 条 history 原测试已有实际路径测试
（其中两条编辑测试位于 sidecar-save-replay.test.ts）；另18条 crash/retry 场景进入真实 L03 保存/加载，
仓储仅由外部 L04 端口替代，仍保持 pending。未覆盖成真实 fanout 的 multi_variant_crash 和缺列兼容场景
没有用测试内部 no-op 冒充完成；旧20条模拟测试原断言保留，但不计完成证据。
legacy 空首 sidecar 场景的原测试用手工 bare_fallback 与块内容脱钩；真实历史回退会拼接全部 content 块。
新增生产测试用空第二块验证“首空遮蔽后非空”算子顺序，未据此声称旧模拟 fixture 的不同 fallback 已等价移植。
L04候选`b316d7426`已补齐`getCompactionSummaryMessageIdsWithConn(conn,sessionId)`（按blocks JOIN messages的DISTINCT IDs，不从compaction记录表猜）、
`getMessageWithConn/updateMessageWithConn/markAvailableSkillsSnapshotStaleWithConn`的service与api出口，待正常main集成后直接绑定。
与已有getActiveCompactionWithConn/getHistoryBlocksWithReplayWithConn配合；不再报“尚未实现”。

### P1 context编译阶段（本轮）

`compileFrozenContext`本体已接服务：稳定runtime facts/当前消息、canonical水合、图片预算、派生产物复用、MM直发、辅助MM→OCR、取消/失败、最终请求状态发布。
`resolveCanonicalImagePayloads`经真实L11 BlobRepository及异步文件读取验证图片magic与MIME，保留缺失slot。
两个待owner接线点已精确请求：L02 raw-image-prompt cancellable及dedicated-OCR高层fallback；L11按file id优先、resource_id后备的blob hash只读方法。
L11候选`09c504019`已提供`ctx.vfsRepo.files.getBlobHashByFileOrResourceId(conn,sourceId)`，精确id优先/无deleted过滤/NULL返回null/SQL错误原抛；待R12-09正常联合集成后直接绑定现有CanonicalFileBlobLookup，L03调用侧已保留Rust `.ok()`处理。
L02已确认无完整运行出口，`c2d193f13`仅ContextCompilerLlmOwner候选类型；raw usage/F7编码依赖仍归owner推进。
L03已实现必需owner实例到compiler ports的调用侧binding，含chat_v2 caller标记、严格base64、OCR临时文件写入/取消清理；不因此把候选类型登记为已provide。
编译器显式接收owner ports；测试中仅视觉远端操作由脚本port提供，L03算法和L11 SQLite/blob读取真实，不把此阶段当完整execute注册。
新增持久化canonical消费前补必填字段/Option/默认bool核验，防止畸形source_image_ids触发崩溃；created_at当前生成契约为number，仅接收无损安全整数，超安全i64的D3端到端契约仍未签收。

## D6 五条已批准；另两条仍 pending

以下均在 pipeline_tests.rs；五条空占位审批已随 main 集成到 migration/approvals.d/C1-app.json，
已按精确 ID 更新 obsolete；其余两条未获批仍 pending：

| 测试 | 证据 |
|---|---|
| test_execute_graph_retrieval_integration | L897–909：ignored，函数体只有注释，无可执行断言 |
| test_execute_web_search_integration | L911–923：ignored，函数体只有注释，无可执行断言 |
| test_parallel_retrievals_integration | L925–934：ignored，函数体只有注释，无可执行断言 |
| test_execute_with_tools_basic | L1090–1107：ignored，函数体只有注释，无可执行断言 |
| test_execute_with_tools_error_handling | L1109–1125：ignored，函数体只有注释，无可执行断言 |
| test_retrieval_error_does_not_propagate | L877–889：仅断言本地空 Vec 和序列化；提及的预调用检索路径已由 retrieval.rs 注释说明删除 |
| test_context_limit_application | L514–531：仅构造 SendOptions 和 unwrap_or(20)；当前 history.rs:7/73–75 明确加载全部未压缩历史，不能复活旧 20 条裁剪行为 |

context_limit_application 与 retrieval_error_does_not_propagate 仍请求指定现行替代验收行为，未一并豁免。

## 其他接线缺口

- L05 resolver 消费端已按 `history.rs:578–712` 接入：`index.ts` inject
  `agentVfsResolver` / `vfsRepo`，`chatPipeline.resolveHistoryContextSnapshot` →
  `src/history-vfs-context.ts` → `agentVfsResolver.resolveContextRefDataToContent(data, true)`。
  main 的 `9468df833` 已合入 L05 服务发布；测试通过 profile 加载真实 L05 插件、L18 docs 与
  L11/L13 数据库/文件，不替代被测 resolver。类型使用 L05 api.ts 的 AgentVfsResolver。
  L03 完整 `load_chat_history_pass` 仍受上面的 L04 replay 接口阻塞，因此不把 history 10 条 pending 改标。
- L04 独立消费点为 `handlers/variant_handlers.rs:1241`，使用实际模型的 `is_multimodal`；
  L03 历史恢复按 Rust 固定传 true，不能替代 L04 的非多模态降级路径。L24 还需处理
  `src/chat_v2/tools/chatanki_executor.rs:9991/10104` 的直接 resolver 调用。

- retrieval_images.rs 的真实 blob 解析阻塞已解除：main 已发布 `vfsRepo`，
  `resolveRetrievalPageImages/buildRetrievalPageImageInjection` 已接入 L13 VFS 与 L11 BlobRepository，
  真实迁移库/文件测试覆盖 MIME 嗅探、失败保位、预算/去重、探测上限及维护模式。
  上层完整工具循环仍受 L02/L04 接口缺口约束。
- `chat/api.ts` 尚未发布 runtime root 定位能力；完成块 API 接受明确传入的 ArtifactLocator，
  缺失 locator 时保持 Rust 的 OutcomeUnknown 分支，不伪造验收成功。

## P1 execute 已发布后的 owner 清单（2026-11-04历史，WP-025更正单轮前置）

`chatPipeline.execute/executeWithEmitter/executeWithExistingUser` 已实现（见 LANE.md「P1 执行入口进度」）。生产运行仍取决于：

| 提供方 | 缺的公开能力 | Rust 依据 | 当前行为 |
|---|---|---|---|
| L04 chat | 17个必需owner方法已全部在main，见api.ts:226–279与execution-runtime.ts:42–59 | persistence.rs/history.rs/helpers.rs:1034–1300 | 已绑定真实owner，WP-025命令组合核验；仅实际缺方法的宿主仍副作用前拒绝 |
| L04 chat | executor registry（createExecutorRegistry/assembleExecutorRegistry，分支已有） | tool_loop.rs:2781–3590 | 批次2 依赖；模型返回工具调用时以 Tool 错误终止 |
| L04 chat | goals（goalGetWithConn/goalAddUsageWithConn）、会话元数据写入（title/summary_hash/tags_hash + upsert_auto_tags 同事务）、loadAgentsInstructions + 运行根解析 | pipeline.rs:414；summary.rs:241；prompt.rs:194–230 | 跳过并 warn 一次 |
| L02 llm | callAgentCompactionRawPrompt（compaction.rs:1041/1112，已 coord 请求）；callAgentChatTitleRawPrompt（辅助 MM/OCR 已改用 main 的 llmRawPrompt/llmOcrPages） | summary.rs:209；context_compiler.rs:721–859 | 标题不生成；辅助 MM/OCR 回退为“图片不可用”观察 |
| F3 | llm_usage `record_llm_usage_cache_ext` 服务 | tool_loop.rs:1560–1700 | chat_v2 轮级用量不入账，warn 一次 |
| L07/L04 | builtin `SchemaToolRegistry::new_with_builtin_tools`（attempt_completion/todo/goal schema） | tools/registry.rs:23–220 | schema_tool_ids 非空时不注入，warn 一次 |
| L17 memory | 画像/分类摘要读取、learner_profile、对话后自动记忆提取 | prompt.rs:236–377；prompt_builder.rs:1037；persistence.rs:1559–1700 | 跳过并 warn 一次 |
| L11 vfs | `getBlobHashByFileOrResourceId`；canonical VFS 页图解析（resolve_canonical_vfs_images 的仓储读） | context_compiler.rs:261–420/603–671 | 无 blob_hash 的图片槽为 None；当前请求退回 formattedBlocks 描述符 |
| L06 orchestration | `applyTurnOverrides` 未进 api.ts 服务 | state.rs:897–936 | Super 回合覆盖不执行 |
| L05 workspace | main 已发布且 WP-061 已消费 WorkspaceCoordinator/WorkspaceInjector | pipeline.rs:1154–1215；tool_loop.rs:2387–2425 | 新建workspace真实注入；历史恢复X3-L05-02归L05 |
| infra | `tiktoken` 已按D11安装，WP-061已实测工具轮；不再是环境阻塞 | token_budget.rs tiktoken 特性 | 本包沿用真实分词器配置；取消仍保留原零usage；其他压缩分支资格仍须各原测试复核 |
| L04+L05+L06 | `chatToolRuntime` 服务（api.ts `ChatToolRuntime`）：L04 executor registry.execute + ChatExecutionContext 构造、concurrencyClass；L05 approval_scope 分类（isLocalShell/isExternalMcp/isPrivilegeEscalation/neverRemember/redactForDisplay/runtimeRootBinding/runtimeScopeKey/runtimeApprovalScope/本地 shell 审批绑定）、shell_command_policy、tool_approval_policy.resolve_effective_sensitivity、ApprovalManager.registerWithPermissionPreset；L04 授权态读取/plan 态写入/plan 原子消费、todo 持久化；L06 trusted automation 校验与预授权、grants 存活门 | tool_loop.rs:2781–3585；hooks.rs:254–1010 | 未提供时工具调用以 Tool 错误结束本轮；L03 侧门禁/顺序/重试/持久化已实现并经契约测试 |
| L04 chat | `createParallelExecutionManager`（VariantExecutionContext/ParallelExecutionManager）进 main；变体上下文暴露可登记的 AbortController；`updateSessionSkillState`（update_session_skill_state_v2） | multi_variant.rs:86–3297；variant_context.rs | 缺失时多变体三入口在任何效果前拒绝 |
| F3 | `llmUsage` 服务（recordLlmUsageCacheExtWithIdentity/cacheDebugEnabled），L02 对 `chat_v2_variant` 强制要求 | model2_pipeline 用量记账 | 缺失时每个变体的统一流调用直接失败 |
