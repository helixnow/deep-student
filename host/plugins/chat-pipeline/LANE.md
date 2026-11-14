# L03-chat-pipeline：Chat 管线

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L03-chat-pipeline（Chat 管线） |
| 目录 | `host/plugins/chat-pipeline/` |
| Rust 范围（lanes.md） | chat_v2 的 pipeline、prompt_builder、budget、context、finalizer |
| 主要提供 | `chat.pipeline@1` |
| 主要消费 | L02、L04、L05、L07 |
| 特别注意 | tool_loop、压缩、context_compiler、多变体、前缀快照 fork，以及取消与重试缺口测试 |
| 规模（本目录） | 47635 行 · 42 个文件 · 0 个命令（前端调用 0） · 451 个测试 |
| 规模（整条 lane，inventory） | 47635 行 · 42 个文件 · 0 个命令（前端 0） · 451 个测试 |
| 契约 | [`contracts/ipc/L03-chat-pipeline.json`](../../../contracts/ipc/L03-chat-pipeline.json)（F5 尚未生成，生成后 `npm run migration:scaffold -- --refresh` 更新本表） |
| 服务草稿 | [`contracts/services/DRAFT-L03-chat-pipeline.md`](../../../contracts/services/DRAFT-L03-chat-pipeline.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-agent/src/chat_v2/budget.rs` | 1614 | 14 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/context.rs` | 1612 | 10 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/finalizer.rs` | 2190 | 35 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline.rs` | 1406 | 2 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/authority_mode.rs` | 797 | 14 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction.rs` | 3117 | 17 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction/budget.rs` | 307 | 7 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction/memory_flush.rs` | 1412 | 9 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction/prompts.rs` | 922 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction/segmentation.rs` | 601 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/compaction/test_fixtures.rs` | 101 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/constants.rs` | 116 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/context_compiler.rs` | 906 | 1 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/context_compiler/images.rs` | 850 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/context_compiler/model_selection.rs` | 375 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/context_compiler/preprocess.rs` | 166 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/context_compiler/retrieval_images.rs` | 579 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/helpers.rs` | 2369 | 23 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/history.rs` | 2079 | 13 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/hooks.rs` | 1651 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/llm_adapter.rs` | 1900 | 10 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/llm_content_crash_tests.rs` | 605 | 13 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/llm_content_retry_gap_tests.rs` | 455 | 7 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/multi_variant.rs` | 3994 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/parallel_exec_tests.rs` | 343 | 21 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/persistence.rs` | 1781 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_fork_finale_tests.rs` | 518 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_fork_tests.rs` | 384 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/prefix_generation_restore_tests.rs` | 539 | 3 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/prefix_snapshot_tests.rs` | 235 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/prompt.rs` | 523 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/retrieval.rs` | 495 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/roster.rs` | 109 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/skill_replay_digest_tests.rs` | 752 | 7 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/skill_replay_edit_delete_tests.rs` | 485 | 7 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/stream_filter_core.rs` | 165 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/summary.rs` | 468 | 12 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/token_resources.rs` | 325 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/tool_loop.rs` | 5630 | 33 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline/variant_adapter.rs` | 859 | 3 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/pipeline_tests.rs` | 2243 | 98 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/prompt_builder.rs` | 1657 | 21 |  |

### 命令（0）

本目录没有 `#[tauri::command]`；职责是向其他插件提供服务（见服务草稿）。

### 发出的事件（0）

无（静态未检出 `emit` / `emit_to` / `emit_filter` 调用）。
<!-- END GENERATED:lane -->

## 备注

### WP-263 memory-flush 账本创建时机（2026-11-06）

X7 G2 差异“A 的 chat_v2.db 有 chat_v2_compaction_memory_flushes，B 没有”的根因：B 的
`execution-runtime.ts` 把 `scheduleMemoryFlushRecovery` 固定为 null，也没有启动期恢复。
Rust 在 lib.rs:1561–1564 启动时 spawn `recover_pending_memory_flushes`，pipeline.rs:608 每次 execute
调 `schedule_memory_flush_recovery`，二者经 memory_flush.rs:618–624 的 has_claimable 预检走到
:434 ensure 建表。现由 `src/memory-flush-recovery.ts` 移植 :572–635（running 守卫、30s 共享退避、预检
warn），index.ts 构造时 spawn，execute 入口与压缩提交后（compaction.rs:1324）共用同一实例。
预检为真之后的 claim/抽取/写入 worker（:637–733、:752–876）仍未实现，保持原“缺 worker”warn，账本行留 pending。
回归：`tests/memory-flush-recovery-entry.test.ts` 跑 WAVE0 `chat.stream.success.answer`（X5 LLM 服务）。

### WP-026 中央 dispatcher 组合（2026-11-06）

L03 已完成 registry/context 与现有门禁的组合适配、单一 admitted dispatcher 子调用回入；
入口 `composeToolRounds → composeChatToolRuntime`，显式绑定入口 `chatPipeline.bindToolRuntime`。
L04/L05/L06/L07 已发布分类、审批、registry/context、注册及 trusted automation 均直接复用。
实际缺口缩为 L04 authority/Plan 三仓储操作及 Plan 值构造，L06 todo 保存公开口，精确签名见 BLOCKERS 顶节。
owner 接缝回归不冒充完整 send 生产证据；保留79条 pending、原取消序列及预算算法。
历史“由 L04 实现整个 chatToolRuntime”已更正为 L03 组合责任。

### WP-025 单轮真实 send 组合（2026-11-06）

main `6898abaae` 已包含 execute/composed、L04真实send条件注册/owned StreamGuard、
L02配置/统一流与compiler owner、L04 WithConn。本包复用现有实现，新增
`tests/send-command-composition.test.ts` 三条命令级组合回归：成功、HTTP业务失败、partial取消。
实际调用链、服务签名、事务/事件证据见SPEC「WP-025」及BLOCKERS顶节。
原`execute-cancel.test.ts`两条完整序列保持不变；TESTMAP 367/79/5不变。
下文早期“没有完整execute/WithConn未进main”的状态已过时，不作为后续重造或等待理由。
WP-092页图证据复用；D-003由C2/X5独立签收；本包仅单轮无工具回答，不代表全P1或C完成。

### WP-092 原集成页图失败最窄复验（2026-11-05）

固定候选 `909ab6fff` = WP-061 `623da2d24` + main `4dc4c8ed9`。
`tests/retrieval-image-resolution.test.ts` 原文件定向 Node job `20261105165522-a60e12`
退出0，2/2通过；没有修改生产实现、测试输入/断言/预算或 TESTMAP 资格。
历史集成仅保存失败标题，不能还原其异常、耗时或根因；原件及调用链见 BLOCKERS 的 WP-092 节。
正式 gate 与 Electron 回执随本包 wp-done 报告交付。D-003 仍待 C2 组合验证及 X5 独立签收。

### WP-061 WorkspaceInjector 真实消费（2026-11-05）

main 已公开 L05 api.ts 的 WorkspaceInjector/InjectionThrottle 与 agentWorkspace provider。
`src/execution-runtime.ts` 按 Rust Option 语义取真实provider，`src/execute.ts` 空闲检查点与
`src/tool-loop.ts`→`src/tool-round.ts` 工具后检查点均消费；`src/workspace-injection.ts` 承接C11内存/落库/事件。
工具循环同一throttle上限2；空闲独立上限3且只检查一次；续跑新生命周期。Rust生产不调用reset_count，不造reset调用。
`tests/workspace-injection-entry.test.ts` 使用真实execute/L05/L04/L02/L01 HTTP，覆盖请求字节、队列消费、
冷却/批上限、task_completed顺序、错误及取消，额外消费5命令v0语料的Node命令入口；无关tool executor为owner端口夹具。
`equivalence/workspace.json` 有5命令/5场景，外层owner见README；未运行A/B，未计C。
WP-003提交45763faf7的取消实现保留；D-003仍待C2集成后X5独立复验。L03 TESTMAP仍367/79/5，L05五条映射由L05自行复核。
下文workspace“未发布/未消费”的文字是历史快照，本节取代它们；仍缺桌面chatToolRuntime组合与历史恢复修复见BLOCKERS。

### WP-003 / D-003（2026-11-05）

本包只修单变体 `execute_with_tools` 的取消退出：外层不再遗留 Promise.race loser；
本轮取消同步撤销 hooks/原始流事件出口，经 L02 `requestCancelStream` 中止真实 HTTP，
等待 provider 和 finally 清理，再由上层回收 partial、落库、发唯一取消终态。
真实入口回归在 `tests/execute-cancel.test.ts`；Rust 证据见 SPEC「WP-003 / D-003」。
main `967f43c75` 已有 L04 WithConn 入口及 L02 可取消统一流，本包测试直接消费，未覆写仓储方法。
下文关于上述接口尚未 main 集成的描述是历史快照，不构成本包阻塞。
TESTMAP 实际为 367 ported / 79 pending / 5 approved obsolete；本包不改变任何 Rust 测试去向。
X5 保留原断言，修复提交供其合入 main 后定向复验；P1 其余事项、D12/D13 等待后续工作包。

## v2 排雷清单

### 当前执行优先级（architect 2026-11-04）

只推进P1：入口契约→普通回答真实组合→工具循环→多变体/压缩。api.ts已发布ChatPipelineExecution/SendPipelinePort消费契约并通知L04；类型与工厂不计完整execute完成。请求冻结已接真实L02/L12，待普通回答入口消费。C1确认X7两项原预期复验通过，不再重修；tiktoken缺包由infra处理，不加heuristic fallback。main/ad11a8394的L04事务公开面仍缺，已向C1/L04精确请求正常集成及final/history追加方法；其他X6/X7项延后，除阻塞他人/正确性高危外不中断P1。

P1续作：context compiler本体与真实Blob水合已接服务（SPEC分支表）；定向20261104140741-c785e3退出0/18pass。L04 `b316d7426`已补齐四项WithConn候选，等待正常main集成；不再称这些方法未实现。L05 `66a7c1eea`公开WorkspaceInjector/InjectionThrottle/MAX_INJECTED_MESSAGE_CHARS候选，X6-PR-0005/0006/0007归入P1工具循环同一throttle跨检查点消费，未接前保留pending。14:02Z main红灯的两条tiktoken缺包已按fulltest要求escalate（2026-11-04T140927086Z-L03-chat-pipeline），依赖owner修复；gate-excerpt故障按架构师通知不改业务代码。

### P1 执行入口进度（接管 2026-11-04 23:00 CST）

**批次1（单变体普通回答）已实现**：`chatPipeline.execute / executeWithEmitter / executeWithExistingUser` 已作为服务方法发布（api.ts `ChatPipelineService` 继承这三个签名，签名与 L04 已消费的契约完全一致，未改）。
- 编排：`src/execute.ts`（pipeline.rs:599/705/1062：多变体开关与 fail-fast、冻结模型、显示名解析、stream_start、首发前保存用户消息、历史加载、检索 no-op、系统提示拆分、冻结编译、llm_content 前移、工具环、save_results、回合末压缩、success/cancel/error 三类收尾与日志）。
- 工具环：`src/tool-loop.ts`（tool_loop.rs:468–2510：轮次上限/心跳、环内压缩检查点、技能首轮冻结注入+锚点 digest、skill_injection_audit 事件、当前 user/工具结果/环内技能/检索页图拼装、llm_context 全键、vision_quality、schema_tool_ids+attempt_completion、MCP 策略过滤与名称映射、工具面冻结与会话基线回写、run-scoped stream event、hooks guard、idle/total 看门狗、无输出瞬时重试与 reconnect、COMPACTION_REQUIRED/输入溢出恢复、用量估算与记账、取消映射、错误分类、内部取消短路、web search 来源/items、最终轮 reasoning item）。
- 生产组合：`src/execution-runtime.ts` 每次调用从服务图组装；L04 仓储方法（REQUIRED_OWNER_METHODS 17 个）缺任一即在任何事件/写入前以 ChatV2Error 拒绝，不用替身。
- 测试：`tests/execute-entry.test.ts` 经 `host.ctx.chatPipeline.execute` 走真实 L02 统一流 + L01 HTTP/SSE（本地脚本服务器），断言请求体、两轮历史重放、落库先于终态、部分输出失败、取消、跳过用户保存、多变体 fail-fast、缺 owner 时零事件零写入。L04 仓储由测试 owner 端口夹具补到真实 chatSession 上（main 尚未集成 L04 WithConn 面）。

批次1 自检：`821d0434a`（基线 main 879e0a56b）lane-gate 5 项全部通过。

**批次4（压缩）已实现**：`chatPipeline.runCompactionForSession` 发布（api.ts 原签名）。`src/compaction-run.ts` 移植 compaction.rs:250–1415：冷却（manual/overflow 豁免）、专用压缩模型覆盖（getModelAssignments.compactionModelConfigId）、NoModel 无回退、会话互斥锁、usable<4096、稀疏会话守卫、manual/overflow/auto 三种 tail 选择、增量 middle、head 锚、摘要请求预算、分块渲染与转义、标识符审计、memory flush 分段入账、逐块摘要+修复重试+静态降级（manual 失败即 failed）、取消、summary→单事务（血缘检查→摘要消息/块→compaction 记录→last_compaction_id→available_skills 换代→flush 账本）→post-commit 顺序、started/finished 反馈事件。execute 的回合末/环内/COMPACTION_REQUIRED/输入溢出四个入口已改为调用该运行时（compact_for_request 的 LockBusy 等待 120s、取消优先）。
- 边界：血缘检查用 L04 `getActiveCompactionWithConn(tx)` 的 id 代替 Rust 直接读 `last_compaction_id`（仅在 last_compaction_id 指向已不存在记录的损坏状态下有差异）；摘要调用依赖 L02 `callAgentCompactionRawPrompt`（未发布时按 Rust LLM 失败分支处理）；post-commit 的 memory-flush worker（L03 自有 P4/P5）尚未组装，账本行保持 pending 可恢复。
- 测试：`tests/compaction-entry.test.ts` 经服务入口覆盖 owner 缺失拒绝、noModel、usableTooSmall、sessionTooShort→冷却→manual 绕过、空会话 noCompactibleRange 且无写入。需要 token 估算的 12 条 Rust 测试仍 pending：运行环境缺 `tiktoken` 包（infra 已知问题，main 基线同样失败），加之摘要 owner 调用未发布。

批次4 自检：`8e28f01d2`（基线 main 4525e11ac）lane-gate 5 项全部通过。

**批次2（工具轮）已实现，生产待 owner 提供 `chatToolRuntime`**：`src/tool-round.ts` 移植 tool_loop.rs:1823–2442（预保存、空必填参数拦截与连续重复停机、工具执行、load_skills 渐进披露与环内技能锚定+digest、工具块、attempt_completion 终止+finalizer+skill_usage、心跳、todo 持久化、reasoning/thought_signature/Responses item 配对、round text、VL 检索页图预算、检查点 B、后保存）与 2781–3585（名称反向映射+_serverId、依赖排序、并行分段与有界并发、截断参数拦截、文档 resource_id 修正与 create 捕获、只读工具瞬时重试共享块 id、execute_single_tool、AdmittedToolDispatcher 子调用重入）；`src/approval-gate.ts` 移植 hooks.rs ApprovalGateHook（KillSwitch→grant→树预算→执行白名单→trusted automation→功能开关→不可变命令守卫→用户命令规则→shell 审批绑定→敏感度→Ask/Plan/Craft 门与 plan_gate 等待→审批需求→trusted 预授权→会话记忆/审批请求与等待/超时/取消→绑定复核→执行前复核与 plan 原子消费→admission 记账）与 TaskAuditHook（before_turn/before_compaction 日志、after_tool 审计标注）。
- 消费契约 `ChatToolRuntime`（api.ts 导出，服务名 `chatToolRuntime`）：L04 registry.execute/上下文、并发等级、VFS 文件存在、todo 持久化，以及 `ApprovalGatePorts`（approval_scope/tool_policy/shell_command_policy/headless/grants/授权态/计划态/审批管理器等 owner 调用）。未提供时 execute 在模型返回工具调用时以 `ChatV2Error::Tool` 结束（批次1行为不变）。已向 L04/L05/L06 发 coord 请求。
- 测试：`tests/tool-round-entry.test.ts` 经 `chatPipeline.execute` 走真实 L02 工具调用解析：低敏工具放行并把结果送入第二轮请求、Ask 模式拦截中敏写工具（结构化拒绝、执行器零调用）、空必填参数不执行。检查点 B 必然走 tiktoken，因此 describe 以分词器依赖存在为条件；以 `NODE_PATH=/tmp/l03-tk/node_modules`（私有安装 tiktoken）验证 3/3 通过，作业 20261104155230-51e95f。

批次2 自检：`27ea99dc6`（基线 main 1e893eb61）lane-gate 全部通过。grants 存活门（hooks.rs:340）改为直接调用 L04 chat api.ts 的 lookupGrantForSession/ensureGrantLive/grantDenialMessage（命名空间探测；L04 未进 main 前注册表为空，等同 Rust None 分支）。`executeVariantsRetryBatch` 与 `VariantRetrySpec` 已加入 ChatPipelineExecution 契约（multi_variant.rs:2831），实现随多变体批次。
压缩提交路径 Rust 测试 3 条（sparse guard / 手动摘要失败不替换历史 / 静态降级 e2e）已移植到 `tests/compaction-commit.test.ts`，依赖分词器条件执行，私有 tiktoken 验证 3/3（作业 20261104160726-550b07）。

批次1/2/4、grants 接线与 retry batch 契约已于 2026-11-05 凌晨随 `merge ds-mig/L03-chat-pipeline` 进入 main（6cb7aad13/e014fffbb/a27a04e7b/9ea8435e5/ddd6ffc50 均为 main 祖先）。

**批次3（多变体）已实现**：`src/variant-run.ts` 移植 multi_variant.rs 全部入口：execute_multi_variant（vision_quality 自动、变体数上限、配置解析、首发用户消息保存、逐变体冻结快照、助手骨架消息、并行 join 与 panic→fail、工具面按变体索引收敛、单事务保存用户/检索/变体块与助手消息、汇总 usage 的 stream_complete、active 变体记忆提取）、execute_single_variant_with_config（逐变体冻结编译、源用户 canonical 复用、共享上下文提示、变体工具环：工具轮复用 L03 门禁/执行、渐进披露、环内技能锚定、页图、COMPACTION_REQUIRED 重编译、空闲/总时长超时、取消）、execute_variants_retry_batch、execute_variant_retry、update_variant_after_retry、load_variant_chat_history（history-loader.ts）。服务方法 executeMultiVariant/executeVariantRetry/executeVariantsRetryBatch 已发布；execute 的 parallelModelIds≥2 分支路由到它。
- 依赖：L04 `chatSession.createParallelExecutionManager`（VariantExecutionContext，L04 分支已有、main 未有）缺失时在任何效果前以 Other 拒绝；L02 的 `chat_v2_variant` 统一流要求 F3 `llmUsage` 服务（main 无 provider），否则每个变体以 LLM 错误结束。
- 取消键直接登记 L04 `VariantExecutionContext.cancelController()`（批量重试走 registerExistingTokenOwned + StreamGuard 代际清理）；重试成功后经 `chatSession.updateSessionSkillStateV2` 还原技能态（结果按 Rust 丢弃）；变体共享上下文提示中的 Canvas/画像/待办/目标为 owner 缺口（warn 一次）。缺 owner 的门禁测试改为用 `tests/owner-gate.ts` 显式移除对应方法搭建宿主，不依赖 L04 是否进 main。
- 上下文编译的辅助多模态/专用 OCR 已改为调用 main 上的 L02 `llmRawPrompt.callRawPromptWithConfigIdAndImagesCancellable` 与 `llmOcrPages.callDedicatedOcrFreeTextWithFallback`。
- 测试：`tests/variant-entry.test.ts`（服务入口：缺 owner 零副作用拒绝、两模型并行落库与激活、单变体重试排除本轮历史并重新激活、空批次校验错误），L04 变体上下文与 F3 usage 以 owner 端口夹具提供（`tests/variant-owner-port.ts`）。

**批次1的明确边界（未完成，不冒充）**：
- 未提供 `chatToolRuntime` 时，模型返回工具调用以 `ChatV2Error::Tool('tool round execution requires the chatToolRuntime owner service, which is not installed')` 结束本轮。
- 下列 owner 能力 main 未发布，按 Rust 的 Option=None 语义跳过，并在首次调用时 warn 一次（MissingCapabilityLog）：用户画像/学习者画像注入（L17）、AGENTS.md 注入（L04 loadAgentsInstructions+运行根）、活跃目标注入与目标用量（L04 goals）、会话标题/标签生成（L02 chat-title 原始提示 + L04 写入器）、llm_usage 轮级记账（F3）、builtin SchemaToolRegistry（schema_tool_ids 注入）、自动记忆提取（L17）、辅助多模态观察/专用 OCR（L02 owner）、canonical VFS 页图（L11）、Super 会话回合覆盖（L06 applyTurnOverrides 未进 api.ts）、workspace 空闲期注入（L05 coordinator）。清单见 BLOCKERS.md。

### 核验口径 / 恢复点

- C1 派发索引基线：`2ee9a9cbe`。本次核验代码固定于 **`c6ee8ed3de478e6a5f1e3b6264ba1b2da9e0ed73`**；以下“当前”均指此 SHA，不把其他 lane 分支候选当已消费。
- 读取的 X6 报告分支快照：`f5822bce6ab6c1ae41a0f08dfadcd55f2f3d1952`。可复查：`git show f5822bce6:scripts/electron-migration/gate-checks/reports/<gate>.json`，gate 为下列五类。原 JSON 保持在 X6，不复制/改写报告。
- 派发索引：single-writer 0；unchecked-decode 1；prod-reachable 9；assert-parity 30；log-parity 25（含 info）。X6 当前快照的 prod-reachable 已缩为 **1 finding**（另有 unknown），与派发时9项不同；保留全部历史索引以免短会话丢项，不把报告收缩当业务修复。
- 状态：`候选非缺陷（已核）` 只表示所列原断言/日志事实已有证据，不是 lane 验收；`缺口待修` 为当前已确认问题；`待逐项审读` 尚未签收。info/unknown/数量均不直接作为失败结论。
- 本单元只登记和审读，**不批量改 TESTMAP、不增凑数 expect、不修改独立 ACCEPTANCE 勾选**。实际 TESTMAP 仍为364 ported /82 pending /5 approved obsolete；D6已批准空占位不重开。
- 优先顺序沿用 C1：P1普通回答入口/完整execute与tool-loop → 同根真实持久化与错误/取消收尾 → P4/P5 flush worker → 下列边界与测试证据修补。已复核关闭的P2/P3/P6和X5局部项不重写。

### 0. C2 冻结稳定 ID 对照（编号补充，不新增整改或签收）

- 冻结报告：`0119143715c0bab2d8f698b7c1d58651358e85be`，源码基线`2ee9a9cbe`；C1原文为`/home/dsdev/dev/deep-student/.oc-runs/messages/C1-app-2026-11-04T124916977Z.md:445–508`，本次逐项核对该原文。
- 下表稳定ID为后续提交/复验主编号；§3–5中的PR/A/L序号及旧长ID只保留为历史别名。证据、原Rust断言/日志、owner请求和状态仍沿用对应条目，**不因换号关闭、重开或重新计数**。修复提交用稳定ID并带同根R2-P1/P2/P4/P5等已有finding；main后独立复验前不称完成。
- owner裁定以C2 `037376b1e` / `X6-OWN-C2-20261104`为准：118/118已裁定；五个qbank本地表归L14，questions/history归L11，settings按DB、APKG按独立namespace判断。本lane无SW候选，不据旧owner报告搬表；反证必须精确到表及Rust调用。D1仍要求正式owner业务接口先发布、同conn消费。
- PR九项原文均粗关联同一组`memory_flush.rs::tests::{memory_flush_segment_id_is_stable_and_boundary_scoped,long_memory_flush_input_is_split_without_omitting_the_middle,memory_flush_split_prefers_rendered_block_boundaries}`。这不是逐符号调用证据，不因此把三个纯函数测试或整个文件降A；按§3/P4核验实际调用。AP组合assert/子串匹配、LP计数仍只作人工线索，既有obsolete/query_rewriter不复活。
- 本次未收到UD稳定编号；§2原别名原样保留，不猜造`X6-UD-*`。UD先核词法/出站/已有严格校验，精确例外只沿已批准5式，不另扩豁免。

| 稳定 ID | 现有条目 / 同根 finding | C1原文行 |
|---|---|---:|
| X6-PR-0008 | §3 P4/PR01 claimNextPendingMemoryFlushWithConn | 445 |
| X6-PR-0009 | §3 P4/PR02 completeMemoryFlushWithConn；P5 | 446 |
| X6-PR-0010 | §3 P4/PR03 enqueueMemoryFlushWithConn | 447 |
| X6-PR-0011 | §3 P4/PR04 ensureMemoryFlushLedgerWithConn | 448 |
| X6-PR-0012 | §3 P4/PR05 hasClaimableMemoryFlushWithConn | 449 |
| X6-PR-0013 | §3 P4/PR06 MEMORY_FLUSH_LEASE_MS | 450 |
| X6-PR-0014 | §3 P4/PR07 MEMORY_FLUSH_LEDGER_TABLE | 451 |
| X6-PR-0015 | §3 P4/PR08 MEMORY_FLUSH_SEGMENT_MAX_CHARS | 452 |
| X6-PR-0016 | §3 P4/PR09 readMemoryFlushPolicyWithConn | 453 |
| X6-AP-0157 | §4 A01 context.test-41 | 454 |
| X6-AP-0158 | §4 A06 finalizer.test-301；P1 finalizer证据 | 455 |
| X6-AP-0159 | §4 A07 finalizer.test-454；P1 finalizer证据 | 456 |
| X6-AP-0160 | §4 A08 compaction-outcome.test-63；P1-compaction | 457 |
| X6-AP-0161 | §4 A09 preprocess.test-6 | 458 |
| X6-AP-0162 | §4 A10 skill-injection.test-180 | 459 |
| X6-AP-0163 | §4 A11 skill-injection.test-263 | 460 |
| X6-AP-0164 | §4 A12 parallel-exec.test-95 | 461 |
| X6-AP-0165 | §4 A13 tool-face.test-323 | 462 |
| X6-AP-0166 | §4 A14 variant-adapter.test-25；X5-03生命周期证据 | 463 |
| X6-AP-0167 | §4 A15 history.test-29 | 464 |
| X6-AP-0168 | §4 A16 history.test-48子项a（Rust test_tool_results_to_messages） | 465 |
| X6-AP-0169 | §4 A18 llm-adapter.test-272 | 466 |
| X6-AP-0170 | §4 A19 llm-adapter.test-293 | 467 |
| X6-AP-0171 | §4 A20 pipeline-contract.test-87 | 468 |
| X6-AP-0172 | §4 A17 history.test-48子项b（Rust test_tool_results_to_messages_format） | 469 |
| X6-AP-0173 | §4 A21 pipeline-unit.test-69；与A24同根 | 470 |
| X6-AP-0174 | §4 A22 pipeline-unit.test-73；与A24同根 | 471 |
| X6-AP-0175 | §4 A23 pipeline-unit.test-77；与A24同根 | 472 |
| X6-AP-0176 | §4 A24 pipeline-unit.test-81 | 473 |
| X6-AP-0177 | §4 A25 tool-face.test-19 | 474 |
| X6-AP-0178 | §4 A26 tool-face.test-38 | 475 |
| X6-AP-0179 | §4 A27 tool-face.test-46 | 476 |
| X6-AP-0180 | §4 A28 tool-face.test-51 | 477 |
| X6-AP-0181 | §4 A29 tool-face.test-54 | 478 |
| X6-AP-0182 | §4 A30 tool-face.test-99（Rust test_token_usage_accumulate） | 479 |
| X6-AP-0183 | §4 A02 context.test-285（子串关联） | 480 |
| X6-AP-0184 | §4 A03 context.test-303（子串关联） | 481 |
| X6-AP-0185 | §4 A04 context.test-204；L05 sandbox contract请求 | 482 |
| X6-AP-0186 | §4 A05 context.test-70 | 483 |
| X6-LP-0110 | §5 L01 repository/budget.ts error；R2-P2 | 484 |
| X6-LP-0111 | §5 L02 api.ts warn；finalizer | 485 |
| X6-LP-0112 | §5 L03 skill-tool-policy.ts warn；P1 | 486 |
| X6-LP-0113 | §5 L04 skill-tool-policy.ts error；P1 | 487 |
| X6-LP-0114 | §5 L05 compaction-outcome.ts warn；P1-compaction | 488 |
| X6-LP-0115 | §5 L06 compaction-outcome.ts error；P1-compaction | 489 |
| X6-LP-0116 | §5 L07 repository/memory-flush.ts warn；P4/P5 | 490 |
| X6-LP-0117 | §5 L08 execution-snapshot.ts warn；P1-context-compiler | 491 |
| X6-LP-0118 | §5 L09 canonical-tools.ts warn | 492 |
| X6-LP-0119 | §5 L10 hooks.ts warn；P1-hooks | 493 |
| X6-LP-0120 | §5 L11 hooks.ts error；P1-hooks | 494 |
| X6-LP-0121 | §5 L12 multi-variant.ts warn；P1-multi-variant | 495 |
| X6-LP-0122 | §5 L13 multi-variant.ts error；P1-multi-variant | 496 |
| X6-LP-0123 | §5 L14 incremental-persistence.ts warn；P1-persistence | 497 |
| X6-LP-0124 | §5 L15 incremental-persistence.ts error；P1-persistence | 498 |
| X6-LP-0125 | §5 L16 retrieval.ts warn（cfg证据） | 499 |
| X6-LP-0126 | §5 L17 retrieval.ts error（cfg证据） | 500 |
| X6-LP-0127 | §5 L18 summary.ts warn；P1-summary | 501 |
| X6-LP-0128 | §5 L19 summary.ts error；P1-summary | 502 |
| X6-LP-0129 | §5 L20 stream-hooks-guard.ts warn；P1-tool-loop | 503 |
| X6-LP-0130 | §5 L21 stream-hooks-guard.ts error；P1-tool-loop | 504 |
| X6-LP-0131 | §5 L22 variant-adapter.ts warn | 505 |
| X6-LP-0132 | §5 L23 prompt-builder.ts warn；P1-prompt-profile | 506 |
| X6-LP-0133 | §5 L24 LANE.md warn汇总；P1 | 507 |
| X6-LP-0134 | §5 L25 LANE.md error汇总；P1 | 508 |

### 1. single-writer（0候选）

X6派发与当前报告均为0，不等于全lane表所有权已全面签收。历史P5跨owner receipt DELETE已在`9dcccfe04`删除；**P5业务仍未闭合**。D1/D4：L03只把F3事务的同一个SqlExecutor传给所有者业务`*WithConn`，禁止重写SQL拼写、移repo或自行操作memory/chat表逃检测。测试夹具SQL和生产SQL须分开人工核验。

### 2. unchecked-decode（1候选）

| Finding ID / 派发索引 | 当前SHA核验 / Rust证据 | owner / 状态与下一步 |
|---|---|---|
| `X6-unchecked-decode-chat-pipeline-context-202`；`src/context.ts:202` double-assertion [info] | `sendContextRefToContextRef` 仍有 `ref.injectModes as unknown as ContextRef['injectModes']`；这是请求引用→持久化引用转换，不是JSON.parse。Rust `chat_v2/resource_types.rs:316–323`克隆已反序列化的inject_modes；`dstu-vfs/vfs/types.rs:2433–2465`规定image/pdf枚举。当前函数自身没有紧邻严格decoder，不能仅凭“生成__De类型”注释断言运行时JSON相同 | 归P1上下文入站边界；**缺口待修**：确认kernel/服务入口的enum规范化保证，覆盖unit-enum对象形式及缺省/null，再改为真实字段转换或消费L04已发布的引用codec。需L04/F5明确输入为raw `SendContextRef__De`还是canonical DTO；不要求对方开放任意SQL，不为去as而加无校验断言 |

### 3. prod-reachable（9项历史索引，归并已有P4）

共同位置：`tests/memory-flush.test.ts:1`，声明来自`repository/memory-flush.ts`。当前`index.ts`只接`src/memory-flush.ts`两个纯函数，无仓储worker消费；不是“import即接线”。Rust公共证据：`pipeline/compaction/memory_flush.rs:572–618,737–865`恢复/claim/worker，原测试`:1005,1024,1091,1125,1175`。已有5条错误ported在`9dcccfe04`退回pending，全部原断言保留，不重复处理状态。

| 历史索引 / 复用finding | 符号 | 当前核验 / 修复状态 |
|---|---|---|
| P4/PR01 | claimNextPendingMemoryFlushWithConn | 仓储仅被tests导入；顺序claim算法有测试但真实worker未接，pending |
| P4/PR02 | completeMemoryFlushWithConn | 同上；完成账本与后续L17 cleanup的生产顺序未闭合，合并P5 |
| P4/PR03 | enqueueMemoryFlushWithConn | 同上；必须由compaction原子提交事务调用，不能孤立注册改变事务 |
| P4/PR04 | ensureMemoryFlushLedgerWithConn | WP-263：已经 hasClaimable 预检被启动/execute/压缩后恢复真实调用；旧ordinal迁移测试仍pending |
| P4/PR05 | hasClaimableMemoryFlushWithConn | WP-263：`src/memory-flush-recovery.ts` 预检真实消费；预检后的 worker 仍未接 |
| P4/PR06 | MEMORY_FLUSH_LEASE_MS | 测试与未接仓储共享常量；常量本身不是“需新增生产调用”的业务，随真实claim入口闭合 |
| P4/PR07 | MEMORY_FLUSH_LEDGER_TABLE | 测试schema/查询引用；不能为了常量reachable把任意SQL迁进index |
| P4/PR08 | MEMORY_FLUSH_SEGMENT_MAX_CHARS | 当前X6唯一finding；仓储与`src/memory-flush.ts:7`各有12000定义，tests:82使用仓储值，split生产函数使用src值。纯split已接服务但测试常量未复用同源；**需按真实常量引用修复/复核**，不因此自动撤回整个split测试，也不宣称worker完成 |
| P4/PR09 | readMemoryFlushPolicyWithConn | 两条policy原测试仍运行但无worker消费；需保留缺表/畸形fail-closed和privacy/off分支，pending |

Owner接口与精确顺序：L17 main现已发布`extractCompactionSegment(segmentText,signal)`、`applyFlushExtraction(extraction,options)`、`queryFlushReceipts/getFlushReceipt`、`cleanupFlushReceipts(segmentId):number`；P4/P5不再称接口全缺。L03需实现“persist extraction→逐fact进度→complete账本→best-effort cleanup”；privacy/off先skip再清该段receipt；cleanup失败warn继续且不回滚completed/skipped。L04 compaction记录写入与enqueue共用F3事务。**此表未接入任何新worker，P4/P5仍open**。

### 4. assert-parity（30项逐ID索引）

下表旧ID展开为 **`X6-assert-parity-chat-pipeline-<ID后缀>`**，仅作历史别名；主编号以§0 C2稳定ID为准。同文件/行命中多个Rust测试时保留原子项，不合并其稳定ID。TS位置均为派发基线锚点，按测试名定位当前实现，避免新增用例导致行号漂移。Rust路径简写：`R=src-tauri/crates/dstu-agent/src/chat_v2/`。本表不以语法expect数自动改完成状态。

| # / ID后缀 | TS基线位置 / 测试名 | Rust证据 | 当前核验与处置 |
|---|---|---|---|
| A01 `context.test-41` | context.test.ts:41 sanitize_strips_local_paths_and_diagnostics_but_keeps_web_urls | R/context.rs:1453–1492 | **候选非缺陷（已核）**：完整toEqual排除retrievalPlan/capabilitySnapshot及5个本地字段，保留snippet/readResourceId/web URL，另断言原imageUrl未改；两条expect承载全部11条原事实，真实Host服务路径 |
| A02 `context.test-285` | context.test.ts:285 test_get_combined_user_content_with_images | R/pipeline_tests.rs:1997（报告匹配） | 子串匹配了test_get_combined_user_content；当前同文件:268精确同名用例已有8条事实。with_images须对其自己的Rust原测试核验，不能拿另一用例8条计数直接判缺；**待校正关联** |
| A03 `context.test-303` | context.test.ts:303 test_get_combined_user_content_empty_refs | 同上 | 同类子串误配，精确同名原8条见:268；empty_refs独立断言仍保留，**待校正关联** |
| A04 `context.test-204` | context.test.ts:204 test_runtime_facts_describes_non_interactive_shell_limits | R/pipeline_tests.rs:2191–2214 | **缺口待修**：TS固定macos，未像Rust取当前平台，且未对L05 platform_sandbox_contract的backend/shell_kind/output_encoding逐项交叉验证；只把encoding比utf-8不能替代跨实现事实。请求L05真实sandbox contract公开口，已有平台能力不自造 |
| A05 `context.test-70` | context.test.ts:70 test_runtime_facts_platform_contract_covers_desktop_platforms | R/pipeline_tests.rs:2218–2241 | **候选非缺陷（已核）**：4个toMatchObject覆盖mac2、win3、linux5、android2全部12个字段事实；仅契约值验证，不称Win/macOS原生执行已验证 |
| A06 `finalizer.test-301` | finalizer.test.ts:301 verdict_serializes_snake_case | R/finalizer.rs:1635 | 计数因5值循环+exception而少，但**真实性缺口**：当前断言自造字面量/JSON，不走finalizationWireReport生产codec；归P1 finalizer证据，待修生产调用，不补无意义expect |
| A07 `finalizer.test-454` | finalizer.test.ts:454 g07b_try_finalize_collects_batch_manifest_from_tool_outputs | R/finalizer.rs:2007 | TS调用collectBatchManifests/finalizeTask，未等同原try_finalize的completion块注入链；5个值断言在，原6条与真实completion路径仍需逐条核，**待审/修** |
| A08 `compaction-outcome.test-63` | compaction-outcome.test.ts:63 compaction_outcome_status_and_reason_codes | R/pipeline/compaction.rs:2000 | 有11项reason循环，语法数不是运行断言数；compacted/notNeeded/skipped/failed的各predicate/token估值仍须逐项对应原19条，**待逐项审读**；完整压缩归P1 |
| A09 `preprocess.test-6` | preprocess.test.ts:6 unavailable_visual_placeholder_is_never_a_reusable_artifact | R/pipeline/context_compiler/preprocess.rs:86–94 | **候选非缺陷（已核）**：两个tuple toEqual分别验证文本和reusable标志，覆盖4条原事实，真实finalizeVisualObservation |
| A10 `skill-injection.test-180` | skill-injection.test.ts:180 test_p1_8_in_loop_skills_insert_after_round_last_tool_result | R/pipeline/helpers.rs:2288 | TS已有轮尾/缺尾回退/多批顺序8条；原10条的具体中间tool位置需逐项查，**待逐项审读** |
| A11 `skill-injection.test-263` | skill-injection.test.ts:263 gate_signal_collects_only_digest_mismatches_deduped | R/pipeline/history.rs:1201 | 当前match/mismatch/missing与重复signal用例存在，但原8条中的其余边界尚未逐条签收；**待逐项审读**，不以history-loader新测试自动替代 |
| A12 `parallel-exec.test-95` | parallel-exec.test.ts:95 cancelled_errors_are_never_retryable | R/pipeline/parallel_exec_tests.rs:211–222 | **候选非缺陷（已核）**：循环恰为原6个字符串，六次调用同一生产isTransientToolError断言false |
| A13 `tool-face.test-323` | tool-face.test.ts:323 failed_round_without_reported_usage_does_not_change_totals | R/pipeline/tool_loop.rs:4544–4551 | **候选非缺陷（已核）**：返回null+整个accumulated与before深等覆盖prompt/completion/total不变三事实且更广 |
| A14 `variant-adapter.test-25` | variant-adapter.test.ts:25 retains_incremental_variant_text_when_adapter_drops_before_complete | R/pipeline/variant_adapter.rs:781–813 | **证据缺口待修**：TS两次读content但第二次未显式len，且未以作用域drop/引用释放模拟原适配器结束；不能只数5/6，需验证同一生命周期不变量，关联X5-03而非重做已修sink |
| A15 `history.test-29` | history.test.ts:29 test_content_block_filter | R/pipeline_tests.rs:535–615 | **候选非缺陷（已核）**：精确等于正文1正文2已排除“思考内容”，覆盖原等值+not contains两事实 |
| A16 `history.test-48` 子项a | history.test.ts:48 test_tool_results_to_messages_format 被匹配为 test_tool_results_to_messages | R/pipeline_tests.rs:1035 | **关联误配**：精确test_tool_results_to_messages在:39，5条存在；不要给format用例套另一测试计数 |
| A17 `history.test-48` 子项b | 同位置真实 test_tool_results_to_messages_format | R/pipeline_tests.rs:1356–1394 | **缺口待修**：TS换成call_abc/web_search而Rust为call_123/rag；role assistant/tool两条没断言。结构深等只覆盖其他字段，不能拿新版fixture代替原向量 |
| A18 `llm-adapter.test-272` | llm-adapter.test.ts:272 test_adapter_tool_call_collection | R/pipeline_tests.rs:1144 | TS实际收集/清空及ID序列已覆盖；原5条工具名/数量要对照，报告基线行已漂移，**待逐项审读** |
| A19 `llm-adapter.test-293` | llm-adapter.test.ts:293 test_tool_call_conversion_from_message | R/pipeline_tests.rs:1191 | arguments整对象断言覆盖query/top_k，但长度/初始条件须逐原4条核验，**待逐项审读** |
| A20 `pipeline-contract.test-87` | pipeline-contract.test.ts:87 test_tool_result_info_with_duration | R/pipeline_tests.rs:1229–1246 | **缺口待修**：Rust success=true、duration=1500、error=None；TS持久化真实，但改成250且只断言duration。应恢复原向量及两个事实，不改生产算法迁就测试 |
| A21 `pipeline-unit.test-69` | pipeline-unit.test.ts:69 test_truncate_text_within_limit | R/pipeline_tests.rs:1398（报告匹配） | 子串匹配，当前短中文例有意义但不是原Hello向量；与下三项同根test_truncate_text合并审读 |
| A22 `pipeline-unit.test-73` | pipeline-unit.test.ts:73 test_truncate_text_exceeds_limit | 同上 | 子串匹配；现中文max5与原中文max10不同，不独立计四条缺失；保留补充用例，修精确原测试 |
| A23 `pipeline-unit.test-77` | pipeline-unit.test.ts:77 test_truncate_text_exact_limit | 同上 | 子串匹配；原“12345”、max5向量不在此用例，合并A24 |
| A24 `pipeline-unit.test-81` | pipeline-unit.test.ts:81 test_truncate_text | R/pipeline_tests.rs:1398–1411 | **缺口待修**：当前emoji/零上限/空串为补充，原Hello、中文长度缩短+省略号、12345边界向量应恢复到同名生产测试；不删现有补充断言 |
| A25 `tool-face.test-19` | tool-face.test.ts:19 test_parse_api_usage_openai_format | R/pipeline_tests.rs:1419–1436 | **候选非缺陷（已核）**：!非空类型断言不产生运行检查，但随后的prompt字段读取/精确值断言对null会失败；其余6字段原值全在，不为显式Some再凑expect |
| A26 `tool-face.test-38` | tool-face.test.ts:38 test_parse_api_usage_deepseek_format | R/pipeline_tests.rs:1463–1479 | **缺口待修**：目前仅total/reasoning，缺prompt=1234、completion=567、source=api事实；非空隐含不能覆盖这些值 |
| A27 `tool-face.test-46` | tool-face.test.ts:46 test_parse_api_usage_partial_openai | R/pipeline_tests.rs:1494–1505 | **候选非缺陷（已核）**：两个字段访问/断言隐含非空并覆盖原1000/0 |
| A28 `tool-face.test-51` | tool-face.test.ts:51 test_parse_api_usage_anthropic_cache_read | R/pipeline_tests.rs:1509–1521 | **候选非缺陷（已核）**：cachedTokens字段读取及800断言同时验证Some和cache值 |
| A29 `tool-face.test-54` | tool-face.test.ts:54 test_parse_api_usage_responses_format | R/pipeline_tests.rs:1525 | 五字段原向量在，须核第六条是否只是Some/还含total；**待逐项审读** |
| A30 `tool-face.test-99` | tool-face.test.ts:99 test_token_usage_accumulate_mixed_source 被匹配为 test_token_usage_accumulate | R/pipeline_tests.rs:1641 | **关联误配**：精确test_token_usage_accumulate在:90，prompt/completion/total/source/reasoning五事实全在；mixed另有自身测试，不因子串命中补无关断言 |

### 5. log-parity（25项索引；全部info，不能用总数签收）

原无finding的旧ID展开为 **`X6-log-parity-chat-pipeline-<ID后缀>`**，仅作历史别名；主编号以§0 C2稳定ID为准。同一文件行的warn/error分别记录子项，保留各自稳定ID。Rust位置为真实源文件，不把文件级聚合强行分摊给每个helper。

| # / ID后缀或已有finding | TS基线锚点 / 候选 | 原Rust证据 | 当前SHA核验 / 状态 |
|---|---|---|---|
| L01 P2（复用） | repository/budget.ts:1 error | budget.rs:357–360,670–797,819–830 | P2真实创建/超额/解绑落盘与恢复日志已在src/budget.ts及主入口，R2已签收P2；Rust Mutex/RwLock poison的4处日志不适用JS单线程锁模型，不在repo伪造同数量error。文件合计只作线索，未重开P2 |
| L02 `api-1` | api.ts:1 warn | finalizer.rs各warn，特别:766–791/895–1025 | api只做类型/导出，真实5处warn在src/finalizer.ts与completion-finalizer.ts（解析batch、todo、申报、落库及降级），当前已检出；需按具体分支测试签收，不能在api补log。关联已有完成块接线 |
| L03/L04 P1（复用） | src/skill-tool-policy.ts:1 warn/error | pipeline.rs:599–1055 | 当前文件只实现skill工具匹配；完整execute的warn/error不归纯匹配helper。text-execution已覆盖部分成功/取消/错误日志，P1全入口尚未完成；**合并P1待办** |
| L05/L06 P1-compaction | src/compaction-outcome.ts:1 warn/error | pipeline/compaction.rs:run_compaction_for_session及:1497–1595 | outcome纯值/summary-commit-post无对应业务日志；history-loader已有compaction view warn，完整压缩主编排仍未接。不能仅因文件计数为0新增日志；**P1未完成** |
| L07 P4/P5（复用） | repository/memory-flush.ts:1 warn | pipeline/compaction/memory_flush.rs:572–865 | 仓储无worker并非所有warn都应放repo；策略关闭/失败/backoff/完成清receipt日志需随真实worker接入，**P4/P5 open** |
| L08 P1-context-compiler | src/execution-snapshot.ts:1 warn | pipeline/context_compiler.rs:63–258及后续compile分支 | 当前只codec，完整freeze/aux-MM/OCR编排未接，warn跟随那些分支补，不为codec静默None策略凭空加warn；**待完整编排** |
| L09 `canonical-tools-1` | src/canonical-tools.ts:1 warn | pipeline/helpers.rs；dstu-core/canonical_tools.rs:40–165 | 核心codec/schema/prepare纯函数无warn；helpers整文件还含watchdog/tool-chain/skill持久化。实际watchdog/history-replay/history-loader已各有日志；其他helpers主线仍待审，不能据全文件13条分摊到canonical |
| L10/L11 P1-hooks | src/hooks.ts:1 warn/error | pipeline/hooks.rs:254–1110等ApprovalGateHook | guard helper:171–196原本无log，真实guard已消费；完整KillSwitch/grant/budget/authority/approval前置链仍未完整实现，**P1待办**；不把有类型及default hook名当已闭合 |
| L12/L13 P1-multi-variant | src/multi-variant.ts:1 warn/error | pipeline/multi_variant.rs:86,3053及各失败分支 | 当前为canonical retry纯选择，fanout/取消/保存主编排仍待实现；X5-03只关闭variant即时发射子项，不关闭整个多变体 |
| L14/L15 P1-persistence | src/incremental-persistence.ts:1 warn/error | pipeline/persistence.rs:598–705/860–925/1502–1549 | 当前incremental含开始/写回滚/COMMIT/回滚失败/一次重试日志；后新增final-persistence.ts含最终保存日志（bd9117184），旧报告3个citing文件计数不含完整新增映射。外部存储绑定/提交后memory流程仍待，**不自动签收全文件** |
| L16/L17 `retrieval-1` | src/retrieval.ts:1 warn/error | pipeline/retrieval.rs:27–45及:46 cfg(any()) | 当前有效execute_retrievals只info跳过预检索；报告warn/error来自已cfg(any())移除的旧路径，**候选非缺陷（已核cfg）**，不复活旧检索；真实工具检索归各owner |
| L18/L19 P1-summary | src/summary.ts:1 warn/error | pipeline/summary.rs生成/解析/存储失败分支 | 当前parse/fallback/shouldGenerate纯方法和debug已存在，完整后台生成/写标题tags未接；**随P1 summary实现补warn/error**，不能因为fallback可测标整项完成 |
| L20/L21 P1-tool-loop | src/stream-hooks-guard.ts:1 warn/error | pipeline/tool_loop.rs:353–447与整个tool loop | RAII守卫本身无warn/error；真实L02 owner cleanup已有生产服务测试。整文件的重试/工具/压缩日志属于未完成tool-loop，**不在guard伪造日志、不重开已修cleanup** |
| L22 `variant-adapter-1` | src/variant-adapter.ts:1 warn | pipeline/variant_adapter.rs:260,754 | TS当前1处warn，需逐条核对另一处flush/解析分支；**待逐位置审读**，与X5已签收发射分开，不能仅凭2>1宣判 |
| L23 P1-prompt-profile | src/prompt-builder.ts:1 warn | prompt_builder.rs:1057,1069 | 两warn属于load learner profile外域读取，而当前builder接收调用者提供profile；**读取接线/错误策略待实现**，不在纯格式化函数补假warn；请求L17 profile读取公开面及错误传播规则 |
| L24/L25 P1（复用汇总） | LANE.md:1 log-warn-deficit-plugin / log-error-deficit-plugin | lane所属Rust各warn/error | 156/52对34/8为历史文件聚合，无一一分支意义；按上面具体条目与P1/P4/P5清单推进，不写重复汇总日志、不靠多打log凑总数 |

### 6. Owner请求与主线合并（当前可复核状态）

1. **L04 / P1**：当前main的chatSession仍只有普通CRUD。分支`796ec7c9d`已发布同事务消息/块/sidecar/buildUserMessage及getMessageBlocksWithConn/listBlockPositionsWithConn，等待正常集成后绑定；额外历史需求`getCompactionSummaryMessageIdsWithConn(conn,sessionId):string[]`，只返回本会话含compaction_summary块的消息ID。最终保存需要`getMessageWithConn`及`updateMessageWithConn`保留原错误/事务顺序。不能以不带conn的CRUD替代D1。
2. **L02 / P1**：当前SHA已包含`llmModel2Streaming.callUnifiedModel2Stream[WithConfig]`、llmStreamEvents（`host/plugins/llm/api.ts:197–229`），原“完整unified尚未发布”描述已过时；下一单元接真实统一流到既有PreparedTextTurn并补完整请求入口，不再以该接口缺失停工。不能降级singleShot。
3. **L05 / hooks**：main已公开isLocalShellExecuteTool和immutableShellCommandGuard，原catastrophe已真实消费，**不再请求/复造分类器**。A04另需跨平台sandbox contract证据；尚未在Win/macOS运行的原生能力不签收。
4. **L17 / P4/P5**：main MemoryService已公开抽取、apply、receipt查询/清理；L03 worker是自有未完成项。严格保留成功/skip后cleanup与失败warn继续。仅当确实需要跨owner同事务时请求接收SqlExecutor的业务方法，不恢复receipt原始SQL。
5. **F4/F5 / UD01**：确认入站枚举对象形式在何处规范化；如已严格decode，消费canonical类型并去掉双断言；否则实现真实字段解码。不存在“用as替as”的修复。
6. X7多模态tag两项已在`a7fec7ffa`/`6135fc446`修复，当前L03 union复用L02内部type标签；本清单不重做。injectionBudget夹具`411e1f1db`已修，最新lane-gate在`c6ee8ed3d`对main`d84e29565`五项通过；该历史结果不冒充后续改动签收。

本次登记仍有明确未修/未接项，**不能回复“无剩余工作”**。后续按finding小单元提交，保留原assert/日志事实，提交→merge main→lane-gate；不为此候选清单额外手动重跑全仓测试。
