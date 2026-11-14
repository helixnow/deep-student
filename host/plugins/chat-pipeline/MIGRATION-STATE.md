# L03 恢复进度（未完成）

TESTMAP 实际行状态：451 条，367 ported、79 pending、5 approved obsolete，merged 0。生成表头待协调者刷新。测试总数包含补充回归和保留的未完成模拟测试，不能代替 TESTMAP 完成数。

## WP-026 续作恢复点（2026-11-06）

实现提交 `4da26bec5`；旧会话已正式 wp-done 部分交付（board `WP-026.report.md`，
2026-11-05T19:06:15.002Z），原 gate 五项全绿、Node 576 passed、Electron 11 passed。
本次按恢复要求合入 main `1defd30af`（合并提交 `e53edfa8d`），复核新 kernel 基线。
L04/WP-168、L06/WP-169 仍未 main，精确接口及消费端类型适配缺口见 BLOCKERS 顶节。
按 C1 指令本包部分报告后结束，余下79条原测试逐条仍以 TESTMAP 的 pending 行为准，
属于后续独立包范围；并非全部因接口阻塞。下方为历史阶段记录，不能据其旧接口描述重做已提交实现。

## 本次落实

- PipelineContext 初始化、ID、单调计时、工具结果 dirty 标记，8 条原 pending 测试接到生产服务。
- F4 time/util 接线；F7 nativeTokenizer 必需注入；预算通过 settings 服务实时取值。
- u64 使用 number/bigint 无损表示及 V8 原生 JSON source/rawJSON 快照往返，取消 MAX_SAFE_INTEGER 钳制。
- 完成块验收使用真实 chatSession 更新块、L07 API 查询 connector 账本；2 条原 DB pending 测试接线。
- L04 ChatV2Error 已发布，原错误类型测试迁移。
- 修复 null 产物路径、执行快照引用共享/负预算/缺省 Option、500 UTF-8 字节流式参数阈值；验证 watchdog abort 与 timer 清理。
- 35 条只测字面量或测试内模拟的旧 ported 退回 pending，保留断言；未将模拟类包装成生产实现来增加完成数。
- main 发布 vfsRepo 后补齐检索页图的真实 blob 解析/注入构建，保留跳过、预算及日志语义；Linux 测试临时目录统一用 os.tmpdir()。
- 四条块结构/索引与助手元数据测试改为公共服务的真实 SQLite 往返，保留 Rust 原断言。
- sidecar 前移及保存点的本 lane 写入选择逻辑已实现并发布最小 ReplaySidecarWriter 接口；未发布的 L04 写入器仅在测试中替代，原崩溃/重试测试保持 pending。
- L05 `agentVfsResolver` 已合入 main 并由本插件必需注入；新增 `resolveHistoryContextSnapshot` 对齐 history.rs:578–712，经真实 L05/L11/L13/L18 插件验证旧轮 OCR-only 模式恢复原图、文件文本/XML、inline 回退、失败日志与引用顺序。L04 variant_handlers.rs:1241 仍须自行接入实际模型能力分支；完整历史加载仍受 replay API 阻塞。

## 仍待完成（逐项测试名见 TESTMAP）

| Rust 文件 | pending | 工作/依赖证据 |
|---|---:|---|
| pipeline.rs | 2 | 自有内存清空/恢复编排未实现；需经 L04 会话元数据接口保存冻结工具顺序及 microcompact anchor。 |
| pipeline/compaction.rs | 9 | 三条已在 compaction-commit.test.ts 移植；其余逐项见 TESTMAP。下文旧接口缺失结论以 BLOCKERS/WP-025、WP-026 核实为准。 |
| pipeline/compaction/memory_flush.rs | 6 | 自有 worker/队列主流程未完成，含五条 P4 状态撤回；receipt 清理必须经 L17 公开 API。 |
| pipeline/history.rs | 10 | 自有单变体重放本体已实现并测试；L04 sidecar 批量读取等在分支发布待main，额外 IDs-only/conn 读取口见 BLOCKERS。未绑定真仓储前不改状态。 |
| pipeline/hooks.rs | 0 | immutableShellCommandGuard 与 isLocalShellExecuteTool 都已main发布并真实委托；原catastrophe测试使用真实公开分类/guard。完整准入hook仍须实现，不能由此推导整个工具调用完成。 |
| pipeline/llm_content_crash_tests.rs | 13 | 新增真实 L03 保存/加载路径覆盖11种场景但L04仓储仍为测试端口，保持pending；缺列兼容和multi-variant fanout崩溃窗口尚未真实接入。旧模拟断言保留。 |
| pipeline/llm_content_retry_gap_tests.rs | 7 | 新增真实 L03 早写/保存点/当前消息排除路径覆盖7种场景；保留新user ID导致旧sidecar与双user请求的Rust现状，待真L04仓储集成后改状态。 |
| pipeline/multi_variant.rs | 3 | 自有多变体历史重放待完成，sidecar 依赖同上。 |
| pipeline/persistence.rs | 2 | 即时保存、增量保存、dirty rollback及一次重试已实现；原50/51次写入和延迟COMMIT失败断言通过真实F3事务验证。L04 owner构建/CRUD为外部测试端口，未绑定真提供方前保持pending。 |
| pipeline/tool_loop.rs | 12 | L02 hooks owner guard 已真实接入；自有 admitted dispatcher/工具循环/kill-switch 门禁尚未完成，完整 unified stream 仍待 L02。 |
| pipeline_tests.rs | 13 | D6 五条空占位已批准 obsolete；剩余 L04 类型方法、SearchInput、另两条未批准旧测试见 BLOCKERS.md。 |
| prompt_builder.rs | 2 | 项目 AGENTS.md 加载/边界检查依赖 L04 agents_md 行为；公开 api.ts 尚无对应方法。 |

上表同时记录未发布的依赖和自有剩余实现，**不表示只剩真实阻塞，更不表示迁移完成**。

2026-11-04 C1 续派更新：上表的接口缺失描述属于旧快照；L04 分支已发布 registry/context factory、
sidecar/compaction/user-message builder/anchor/类型构造器/agents_md，L02 分支已发布 llmStreamEvents。
以 BLOCKERS.md 的逐项新核实为准。C1 最新授权后，`2bdbf55f6` 已正确合并测试夹具冲突：
保留 notes 新服务名、L05/L18 真插件与 setupStorage，main 集成障碍解除。

C1 后续需求：已发布完整 getBlockTypeForToolStatic（纯函数/服务/PipelineContext 共用）；
8 条 F4 canonical_tools 原测试及 2 条 prompt_contracts 原测试经真实公开面验证。
逐 ID 去向见 BLOCKERS.md，F4/L13 自行更新其 TESTMAP；difficulty rubric 无生产证据仍 pending。
F4 special-token 共享模块已由 main `a33e27417` 集成，正文/思考与variant adapter实际消费，未复制实现。

P1 新进展：createPersistence 完成即时/增量/dirty rollback/一次重试；createHistoryLoader 完成单变体
历史本体与10条原测试场景，另18条 crash/retry 场景进入真实L03路径。L04仓储只在测试提供端口，
仍保留原pending，最新 L04 分支796ec7c9d已补 getMessageBlocksWithConn/listBlockPositionsWithConn，
保存端口待main集成；历史额外 getCompactionSummaryMessageIdsWithConn 仍待公开。
完整 execute/多变体/flush 仍未完成。
L02 llmStreamEvents 已main集成，createStreamHooksGuard 通过真L02公开取消和owner接口验证；原cleanup测试ported。

普通回答续作：最终保存本体及 PreparedTextTurn 执行阶段已实现；fake仅为外部统一流提供方，测试实际调用并经
L03/F3事务落库、终态发生在提交后。完整请求execute入口仍未完成，不等同L04/X5要求的SendPipelinePort。

L02后续：main已有统一流服务，createUnifiedTextStream现真实调用其公开方法；网络测试只脚本化远端HTTP，
不替L02 request/transport/hooks。取消通过其registry而非猜造signal输入字段。L04真实事务owner绑定仍待集成。

## 后续接续

1. 为 L04 sidecar/compaction 及 L02 流式调用补最小消费接口与测试替身，完成本 lane 调用编排；待对方发布时改为 ctx 服务调用。
2. 继续实现工具 admission/kill-switch 与历史重放，逐条替换模拟测试。
3. 复核尚未覆盖的 summary/context-compiler/retrieval-images 主流程，以及固定 Rust regex 等价性。
