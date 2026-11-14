# L05-agent-workspace 测试去向（`host/plugins/agent-workspace`）

<!-- BEGIN GENERATED:testmap:header -->
每个原 Rust 测试一行（`<src-tauri 相对路径>::<内联模块…>::<测试名>`），去向列填写：
- `pending`（默认）
- `ported:<ts 测试文件路径>` —— 该文件中须有标题包含 Rust 测试名的用例（ledger 校验）
- `merged:<目标>` —— 并入的 TS 用例（`<路径>` 或 `<路径>::<用例名>`）
- `obsolete:<理由>` —— 需协调者在 `migration/approvals.json` 批准后才计入 B 级

只改"去向"列；行由 `npm run migration:scaffold -- --refresh` 按 Rust 源码重建，去向按 id 保留。

Lane L05-agent-workspace：401 行（真实测试 401）· obsolete 21 · pending 21 · ported 359
<!-- END GENERATED:testmap:header -->


### Rust 死代码（obsolete，21 行）

按 `docs/dev/electron-migration/quality.md` §8 与协调者裁定，以下 Rust 模块本身没有生产调用方，测试标记 `obsolete:dead-in-rust`，对应 TS 模块与测试已删除：

- `chat_v2/adapters/llm_adapter.rs`（12 行）：文件头第 3 行明确标注“此模块当前未被使用”，生产 pipeline 使用 `pipeline/llm_adapter.rs` 的内嵌实现。
- `chat_v2/adapters/tool_adapter.rs`（5 行）与 `vfs_rag_adapter.rs`（4 行）：`adapters/mod.rs:3-7` 注明三个适配器“全部为死代码”，第 12-27 行仅带 `deprecated` 重导出，全仓无生产调用方。

### 已移植但未接入（pending，11 行）

按 `docs/dev/electron-migration/quality.md` §3.3 与新接线门禁，以下测试所测模块尚无生产调用方，因此去向保持 `pending`：

- `tests/vfs-resolver.test.ts`：L03 消费已合入 main，10 行改为 ported；2 行非多模态 OCR 降级仍待 L04 `handlers/variant_handlers.rs:1241` 的 Host 调用点，保持 pending。
- `tests/workspace-completion-outbox.test.ts`（9 行）：`index.ts` 已发布 `agentCompletionOutbox`；仍待 L04 `completion_dispatcher.rs` 与 `handlers/workspace_handlers.rs` 的完成闭包/dispatcher 消费，保持 pending。

### Windows 原生能力待 L05 接线与目标平台验证（pending，5 行；2026-11-05 复核）

`windows_runtime_root_and_file_identities_use_handle_information` 需要 opened-handle identity/reparse API；
`appcontainer_writes_only_inside_selected_cwd`、`appcontainer_blocks_protected_subdirectory_writes`、
`appcontainer_denies_network_without_capability`、`cancellation_prevents_late_process_launch`
需要 AppContainer/ACL/Job Object/原生 cancellation event。F7 正式 API 已随 main 合入，
包括 readAt/refreshInformation/runFullAccessJob/acquireAclMutex；L05 handle/ACL/helper 接线
及 Windows 目标平台验证仍缺，不能将平台跳过或测试内注入的 native runtime 记为已完成。
具体能力见 `native-needs.md`。

当前行状态（WP-063 开工逐行计数）：370 ported / 0 merged / 21 obsolete / 10 pending。
生成表头及前文 9+2 pending 说明是旧记录；56c84575c 已有 9+2 候选映射，本包不重新判定。
新增 `tests/workspace-inbox-recovery.test.ts` 是 X3-L05-02 的 Host 恢复接缝回归，
不替换 `coordinator.rs:1218,1275` 原测试映射或断言、不减少 pending。

### X6-PR-agent-workspace-workspace-injector-1：确认未接入的 5 行

核对 Rust `pipeline/tool_loop.rs:483,2384–2396` 与当前 Host：WorkspaceInjector/InjectionThrottle
只有本 lane 模块和测试使用，L03 尚无生产调用；不是 dead-in-rust。5 个原测试改为 pending，
断言未变。已从 api.ts 发布原类/常量及最小 WorkspaceInjectionCoordinator（hasPendingMessages/drainInbox），
L03 每次 pipeline 执行持有同一个 throttle、跨检查点复用，不能每次重建。待 L03 真正消费后改回 ported。

WP-149（2026-11-06）复核：L03 WP-061/623da2d24 与 092/c59014033 已在 main 6898abaae 的祖先链上，5 行改回 ported，
断言和测试未改。生产调用链：`chat-pipeline/index.ts:237` execute → `composed()`（:196，每次 execute 新组合）
→ `src/execution-runtime.ts:362,378` 取真实 `agentWorkspace`（本 lane `index.ts:117` provide 的 WorkspaceCoordinator）
构造 `WorkspaceInjectionRuntime`（`src/workspace-injection.ts:23` new WorkspaceInjector，:31 formatInjectedMessages）；
`src/tool-loop.ts:224` 每次 executeWithTools 建一个 InjectionThrottle（对应 Rust tool_loop.rs:483），
:650 各工具检查点以同一 throttle、max=2 调 checkAndInject（tool_loop.rs:2384–2396）；
`src/execute.ts:362` idle 检查点新建 throttle、max=3（pipeline.rs:1156–1164）。
`chat-pipeline/tests/workspace-injection-entry.test.ts:147` 经真实 execute/本 lane provider 断言前 4 次工具检查
共用同一 throttle、冷却拦截与 2 批上限生效，idle/续跑另有 throttle；:100 断言截断/短消息格式化进入 HTTP 请求。
reset_count 在 Rust 与 TS 生产中都没有调用方，原测试仍按原样保留该断言。
job 20261105182230-b4296a：workspace-injector 5 + workspace-injection-entry 22，27 passed / 0 failed / 0 skipped。
行状态：370 ported / 21 obsolete / 10 pending → 375 ported / 21 obsolete / 5 pending（余 Windows 5 项）。

### 协调者指令 1：L03 resolver 消费核对

此前执行 `git merge --no-edit main` 得到 `8176f4199`，该版本没有
`host/plugins/chat-pipeline/src/history-vfs-context.ts`，也没有 `agentVfsResolver` 消费。
只读核对 L03 检查点 `4354a8b13`：`index.ts:154–157` 发布
`resolveHistoryContextSnapshot`，`:355` inject `agentVfsResolver`，
`src/history-vfs-context.ts:98` 调用 `resolveContextRefDataToContent(data, true)`，
对应 Rust `pipeline/history.rs:578–712`（调用点 `:671`）。
本次续作已合入 L03 单元，当前 `chat-pipeline/index.ts:172–174` 提供真实服务方法，
`:374` inject `agentVfsResolver`，`src/history-vfs-context.ts:98` 仍传 true；
`chat-pipeline/tests/history-vfs-context.test.ts` 使用真实 Host/VFS 验证图片恢复、XML 转义与模式重写。
本 lane 的调用链为 `index.ts` provider → `vfs-resolver/index.ts:51–55` →
`resolveVfsRefToContent` → `resolveVfsRefToBlocks` → 各资源解析器。

原 Rust `vfs_resolver.rs:2868–3037` 的 12 个测试与 TS 标题、断言逐项核对如下；
下表保留上一轮逐项依据；其中 10 个“待 L03 合入”项的合入条件现已满足，已依协调者指令改为 ported。
两项 false/OCR 分支未改标；原测试全部断言保留，不能以 true 调用宣称覆盖 false 分支：

| 测试 | 接线依据 / 剩余条件 |
|---|---|
| `test_escape_xml_attr` | 资源标签转义；待 L03 合入 |
| `test_escape_xml_content` | 资源正文转义；待 L03 合入 |
| `test_infer_media_type` | 图片资源 MIME 推断；待 L03 合入 |
| `test_resolved_content` | 批量解析创建、添加文本/图片并合并 ResolvedContent；待 L03 合入 |
| `test_default_image_mode_keeps_source_without_implicit_ocr` | 多模态图片解析 helper；待 L03 合入。历史入口先把 image 模式改为显式 image，不声称执行了原测试的 null 参数 |
| `test_non_multimodal_image_request_downgrades_to_ocr` | L03 固定 true，无法覆盖 false 降级；待 L04 variant 调用 |
| `test_default_pdf_mode_is_text_only` | PDF 模式 helper；待 L03 合入。保留原测试 true/false 两组断言，历史入口重写 text+image，不声称执行了 null/false 参数 |
| `test_non_multimodal_pdf_image_request_downgrades_to_ocr` | L03 固定 true，无法覆盖 false 降级；待 L04 variant 调用 |
| `textbook_default_keeps_native_text_without_ocr_duplicate` | 教材解析经过 getTextbookTextBlocks；待 L03 合入 |
| `exam_default_omits_card_ocr_but_explicit_ocr_includes_it` | exam 引用模式不被历史入口重写；待 L03 合入 |
| `test_resolve_question_image_blob_from_hash_field` | 题目集图片 blob hash 分支；待 L03 合入 |
| `test_resolve_question_image_blob_from_file_id` | 题目集图片 file-id 分支；待 L03 合入 |

outbox 9 项 g03 与 Windows 原生能力 5 项仍按原阻塞保留 pending。

除上表 401 个 Rust 测试外，本 lane 另有 66 个宿主接缝测试（Rust 无对应测试）：
`runtime-paths` 1、`runtime-roots` 8、`tools-git` 1、`tools-shell-preflight` 3、
`utf8-paged-read` 1、`workspace-card-read-scope` 4、`workspace-executor` 8、
`vfs-resolver-branches` 5、`tools-code-navigation` 1、`workspace-subagent-task` 1、
`vfs-resolver-wiring` 1、`completion-outbox-wiring` 1、`workspace-coordinator` 2。
本次 C1/R2 续作增加 `workspace-storage-wiring` 1（真实 SQLite receiver/维护重开）、
`runtime-root-errors` 13（W1 全前缀与记录解码）、`runtime-directory-cursor` 1（W5）、
`public-api-wiring` 2（L04 manager/events 与 L03/L19 公共接线）。
另增 `runtime-roots-service` 2（L13 会话/技能感知根定位与撤销）、`native-regex-wiring` 1
（X4 W08 经真实 Context 提供、卸载、替换 Rust regex 服务）。
本次新增 `runtime-root-errors` 1（非法字段＋后续截断的错误优先级）、
`transform-sandbox-wiring` 1（F7 候选异步接缝）、`transform-sandbox-linux` 1（真实 bwrap 策略隔离）；
它们不将 Windows 原生 5 项或 L24 的 e2e 改为 ported。
`workspace-delete-wiring` 另有 3 项：真实 L21/F3 忙锁前无副作用、整段 worker 清理持有许可、
回调失败也 release。L04 deleteSessionV2 候选未合 main，仅此端口使用替身，不记为三插件整链完成。
`workspace-journal-wiring` 新增 2 项：真实 F3 SQLite 准备失败不删文件/metadata且关闭借用，
重建取消旧 ready intent，以及 foreign_keys 设置失败的精确前缀/句柄释放。原 401 行状态不变。
F7 合入后 `transform-sandbox-linux` 另增 1 项真实 Context provider 的限额/env/cancel/reap 验证；
这不是 Windows/macOS 平台签收，Windows 5 项仍 pending。
它们验证宿主注入面（storage/settings/logger、事件与执行器接线），不改变 Rust 测试去向。

2026-11-04 C1 04:25Z 指令确认 21 项 obsolete 已逐 ID 批准；本 lane 不改审批文件和独立验收勾选。
本轮提交前已合入 `migration/approvals.d/C1-app.json` 与 ledger 分片读取；21 项审批机器可核验，
ledger --check 退出 0。R2-W4 仅审批子项解除，pending、统计刷新及 B 验收仍未闭合。

本轮验证、21 个 obsolete 完整 ID 与接线依赖见 [MIGRATION-REPORT.md](MIGRATION-REPORT.md)。

## 测试

<!-- BEGIN GENERATED:testmap:rows -->
| Rust 测试 | 种类 | 位置 | 去向 |
|---|---|---|---|
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_generate_block_id_format` | test | L491 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_generate_block_id_uniqueness` | test | L498 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_block_id_created_once` | test | L513 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_finalized_before_content` | test | L552 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_multiple_tool_calls_unique_block_ids` | test | L576 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_tool_result_removes_from_map` | test | L614 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_tool_result_unknown_call_id` | test | L655 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_disabled_no_block` | test | L668 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_thinking_ended_no_new_block` | test | L700 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_content_block_created_once` | test | L732 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_finalize_all_clears_tool_blocks` | test | L758 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs::tests::test_content_ended_prevents_double_finalize` | test | L784 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_image_gen_options_serialization` | test | L649 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_image_gen_options_default` | test | L672 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_start_payload_format` | test | L684 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_web_search_start_payload_format` | test | L699 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs::tests::test_constants` | test | L715 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_generate_block_id` | test | L348 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_filter_by_relevance_empty` | test | L358 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_filter_by_relevance_filters_low_scores` | test | L365 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs::tests::test_filter_by_relevance_relative_threshold` | test | L401 | obsolete:dead-in-rust adapters/mod.rs:3-7 标注三个适配器均为死代码且仅由 mod.rs 带 deprecated 重导出，全仓无生产调用方（llm_adapter.rs:3 另注“此模块当前未被使用”） |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::media_transcription_approval_names_external_provider_and_file` | test | L1278 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::test_approval_flow` | tokio::test | L1295 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::dstu_purge_user_rejection_is_delivered_and_never_remembered` | tokio::test | L1320 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::test_approval_timeout` | tokio::test | L1361 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::test_remembered_choices` | test | L1385 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::reject_all_pending_drains_all_waiters_with_rejection` | tokio::test | L1427 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::cancel_without_session_refuses_ambiguous_cross_session_match` | tokio::test | L1477 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::cancel_delivers_explicit_cancellation_decision_to_waiter` | tokio::test | L1504 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::cancel_with_session_delivers_cancellation_decision` | tokio::test | L1530 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::medium_readonly_shell_can_be_session_remembered_with_precise_scope` | test | L1550 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::remembered_shell_approval_cannot_change_operand_payload_or_environment` | test | L1604 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::remembered_wrapper_approval_cannot_swap_inner_command` | test | L1696 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::arbitrary_runner_and_path_executable_cannot_be_remembered` | tokio::test | L1743 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::session_remember_for_regular_tools_keeps_tool_level_semantics` | test | L1782 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::response_tool_name_cannot_poison_shell_session_or_setting_scope` | tokio::test | L1807 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::file_manager_approval_descriptions_name_the_reviewed_action` | test | L1854 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::skill_lifecycle_approval_descriptions_name_the_target_skill` | test | L1874 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::mcp_manage_approval_descriptions_name_server_and_transport` | test | L1910 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::custom_agent_approval_descriptions_name_the_target_persona` | test | L1948 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::permission_presets_only_remember_relaxed_medium_for_current_session` | test | L1976 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_manager.rs::tests::high_and_cautious_approvals_cannot_be_remembered` | test | L2011 | ported:host/plugins/agent-workspace/tests/approval-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::note_replace_different_content_same_scope` | test | L3438 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::qbank_batch_delete_scope_is_exact_sorted_and_never_remembered` | test | L3448 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::note_set_different_noteid_different_scope` | test | L3486 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::mindmap_edit_nodes_different_nodes_same_scope` | test | L3496 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::source_namespace_prevents_collapse` | test | L3506 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::mcp_different_servers_have_distinct_scopes` | test | L3525 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::unknown_tool_returns_none` | test | L3543 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::file_write_uses_path` | test | L3550 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::workspace_artifact_write_uses_root_and_path_without_content` | test | L3565 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::file_mutation_tools_ignore_broad_bypass_and_use_precise_scope` | test | L3581 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::workbench_actions_use_precise_scope_and_high_actions_are_single_use` | test | L3644 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::workbench_action_scope_ignores_only_volatile_observation_revision` | test | L3663 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::execute_command_scope_includes_every_operand` | test | L3694 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_scope_includes_runtime_root_and_cwd` | test | L3710 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_scope_supports_builtin_local_shell_execute_name` | test | L3742 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::runtime_approval_scope_exposes_shell_summary` | test | L3762 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::arbitrary_external_mcp_command_alias_uses_shell_policy_boundaries` | test | L3794 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_scope_canonicalizes_root_and_working_dir_aliases` | test | L3813 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::normalized_shell_runtime_location_uses_optional_default_root` | test | L3841 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_scope_includes_full_environment_plan_without_exposing_values` | test | L3878 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_scope_binds_execution_controls_and_aliases` | test | L3916 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_environment_values_are_redacted_at_boundary` | test | L3969 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_command_secret_forms_are_redacted_without_changing_raw_hash` | test | L3990 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::backend_env_plan_change_invalidates_complete_shell_scope` | test | L4018 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::external_mcp_builtin_command_never_claims_local_sandbox` | test | L4036 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::arbitrary_code_and_path_executables_are_single_use_and_effectful` | test | L4061 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::medium_readonly_shell_commands_are_not_never_remembered` | test | L4092 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::wrapper_payloads_are_hashed_and_classified_by_effective_command` | test | L4134 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::write_capable_path_operands_cannot_escape_runtime_root` | test | L4181 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_scope_isolates_skill_root_id_injection` | test | L4227 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_scope_distinguishes_network_permission` | test | L4272 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::execute_command_chaining_is_isolated` | test | L4298 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::script_runners_do_not_collapse_to_prefix` | test | L4341 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_analysis_detects_windows_path_script_runner` | test | L4379 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::missing_id_returns_none_fail_closed` | test | L4394 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::snake_case_note_id_works` | test | L4414 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::camel_case_preferred_over_snake_case` | test | L4423 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::setting_key_v2_is_stable_and_valid` | test | L4430 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::v1_v2_different_keys` | test | L4440 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::newly_covered_tools` | test | L4449 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::unknown_mcp_file_like_tool_uses_stable_path_scope` | test | L4480 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::unknown_mcp_tool_without_stable_identity_stays_fail_closed` | test | L4509 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::normalize_tool_name_strips_prefixes` | test | L4523 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::never_remember_approval_covers_privilege_tools` | test | L4531 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::marketplace_scan_is_non_privileged_but_install_is_single_use` | test | L4547 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::never_remember_is_not_coupled_to_builtin_prefix` | test | L4589 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::windows_script_runners_do_not_collapse_to_prefix` | test | L4626 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::automation_propose_scope_disables_remember` | test | L4669 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::skill_install_runtime_scope_carries_provenance_summary` | test | L4688 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::skill_install_scope_fingerprint_uses_expected_sha256` | test | L4709 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::skill_workshop_apply_runtime_scope_carries_proposal_summary` | test | L4721 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::skill_workshop_apply_scope_fingerprint_binds_reviewed_content_and_revision` | test | L4741 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::skill_lifecycle_runtime_scopes_are_never_remember_and_fingerprint_bound` | test | L4761 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::mcp_manage_runtime_scopes_are_never_remember_and_fingerprint_bound` | test | L4817 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::custom_agent_runtime_scopes_are_never_remember_and_fingerprint_bound` | test | L4898 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::skill_set_enabled_scope_binds_skill_and_direction` | test | L4967 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::dstu_purge_is_single_use_and_path_scoped` | test | L4991 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::phase5_high_deletes_are_single_use_and_id_scoped` | test | L5008 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::phase7_governance_writes_are_single_use_and_argument_scoped` | test | L5049 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::file_manager_commit_scope_binds_root_and_preview_hash` | test | L5072 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::immutable_guard_denies_catastrophic_commands_across_shells` | test | L5098 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::immutable_guard_asks_for_unresolvable_recursive_deletes` | test | L5142 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::immutable_guard_asks_for_high_risk_or_ambiguous_commands` | test | L5160 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::immutable_guard_allows_ordinary_structured_commands` | test | L5190 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_command_sensitivity_downgrades_pure_readonly_to_medium` | test | L5211 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/approval_scope.rs::tests::shell_command_sensitivity_keeps_effectful_or_ambiguous_commands_high` | test | L5235 | ported:host/plugins/agent-workspace/tests/approval-scope.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::windows_runtime_root_and_file_identities_use_handle_information` | test | L2608 | pending |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::backend_skill_trust_rejects_same_size_script_replacement` | test | L2639 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::sanitizes_session_dir` | test | L2686 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::session_runtime_root_migrates_legacy_directory_once` | test | L2695 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::session_runtime_root_rejects_symlink_rebinding` | test | L2722 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::ambiguous_legacy_session_names_are_never_migrated_or_deleted` | test | L2743 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::authorized_root_ids_are_stable` | test | L2763 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::normalizes_runtime_relative_path` | test | L2770 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::rejects_runtime_relative_path_escapes` | test | L2782 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::canonicalizes_authorized_directory_and_rejects_non_dirs` | test | L2789 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::authorized_runtime_roots_are_read_only_and_global` | test | L2805 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::configured_workspace_roots_are_read_only_and_marked_configured` | test | L2828 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::configured_workspace_root_is_writable_only_when_explicitly_requested` | test | L2848 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::critical_workspace_locations_cannot_receive_write_access` | test | L2863 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::tampered_persisted_critical_workspace_is_downgraded_to_read_only` | test | L2877 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::legacy_workspace_record_deserializes_as_read_only` | test | L2901 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::skill_package_runtime_roots_are_read_only_and_scoped_by_skill_id` | test | L2911 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::canonicalizes_workspace_directory_and_rejects_non_dirs` | test | L2933 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::persisted_root_binding_rejects_directory_replacement` | test | L2949 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::stale_workspace_binding_is_listed_but_not_configured` | test | L2970 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::concurrent_authorized_root_updates_do_not_lose_records` | test | L2996 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::approval_binding_token_changes_with_workspace_and_directory_identity` | test | L3026 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::shell_binding_changes_when_support_readable_roots_change` | test | L3119 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::write_backup_roundtrip_restores_original_content` | test | L3132 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::write_backup_refs_are_unique_for_same_file_name` | test | L3163 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::write_backup_rejects_oversized_sources_before_streaming` | test | L3173 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::restore_rejects_backup_refs_outside_backup_area` | test | L3188 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::persisted_root_identity_deserializes_across_operating_systems` | test | L3254 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::remove_artifact_file_only_deletes_regular_files_inside_root` | test | L3285 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::irreversible_session_delete_leaves_no_backup_copy` | test | L3306 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::stale_undo_rejects_restore_and_delete` | test | L3323 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::deleting_symlink_artifact_removes_link_not_referent` | test | L3353 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::session_runtime_cleanup_removes_artifacts_temp_and_backups` | test | L3370 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::backup_file_names_are_sanitized` | test | L3395 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::assesses_windows_authorized_root_risk` | test | L3403 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::assesses_risk_on_canonical_paths_with_verbatim_prefix` | test | L3437 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::canonicalize_resolves_parent_traversal_before_risk_assessment` | test | L3471 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::authorize_runtime_root_path_is_idempotent` | test | L3486 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::runtime_root_kinds_serialize_for_frontend_contract` | test | L3513 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::full_access_absolute_cwd_binding_does_not_require_workspace_root` | test | L3541 | ported:host/plugins/agent-workspace/tests/runtime-roots.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::effective_runtime_root_id_prefers_explicit_then_preferred_then_workspace` | test | L3559 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::explicit_runtime_root_id_from_args_reads_snake_and_camel` | test | L3577 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::runtime_directory_page_exposes_folders_and_visible_truncation` | test | L3598 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::runtime_directory_page_rejects_paths_outside_bound_root` | test | L3638 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::runtime_directory_pagination_crosses_scan_cap_and_terminates` | test | L3649 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::runtime_directory_cursor_past_end_terminates_empty` | test | L3678 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/runtime_roots.rs::tests::redact_path_for_display_masks_home_prefix` | test | L3690 | ported:host/plugins/agent-workspace/tests/runtime-paths.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs::tests::text_search_is_bounded_and_filters_extensions` | test | L596 | ported:host/plugins/agent-workspace/tests/tools-code-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs::tests::search_skips_generated_and_hidden_directories` | test | L616 | ported:host/plugins/agent-workspace/tests/tools-code-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs::tests::outlines_rust_and_typescript_declarations` | test | L639 | ported:host/plugins/agent-workspace/tests/tools-code-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs::tests::outline_marks_truncated_only_when_an_extra_symbol_exists` | test | L664 | ported:host/plugins/agent-workspace/tests/tools-code-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs::tests::executor_contract_is_low_readonly` | test | L678 | ported:host/plugins/agent-workspace/tests/tools-code-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs::tests::normalization_rejects_absolute_escape_and_hidden_paths` | test | L943 | ported:host/plugins/agent-workspace/tests/tools-file-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs::tests::preview_hash_binds_expected_hashes_and_destination` | test | L963 | ported:host/plugins/agent-workspace/tests/tools-file-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs::tests::delete_trash_path_is_backend_derived` | test | L986 | ported:host/plugins/agent-workspace/tests/tools-file-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs::tests::conversions_are_deterministic` | test | L994 | ported:host/plugins/agent-workspace/tests/tools-file-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs::tests::manifest_never_claims_partial_success` | test | L1008 | ported:host/plugins/agent-workspace/tests/tools-file-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs::tests::sensitivity_and_concurrency_match_product_contract` | test | L1036 | ported:host/plugins/agent-workspace/tests/tools-file-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::posix_quoting_wraps_and_escapes_single_quotes` | test | L830 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::powershell_quoting_doubles_single_quotes` | test | L844 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::platform_quoting_is_posix_off_windows` | test | L856 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::status_and_branch_list_commands_are_fixed` | test | L861 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::diff_command_supports_staged_and_quoted_paths` | test | L872 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::log_command_embeds_validated_limit` | test | L898 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::branch_commands_quote_names_and_delete_uses_safe_dash_d` | test | L904 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::commit_commands_are_add_then_commit_with_quoted_operands` | test | L929 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::paths_must_be_relative_and_non_empty` | test | L942 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::commit_requires_non_empty_paths` | test | L958 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::diff_paths_are_optional_but_still_validated` | test | L976 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::branch_names_reject_option_injection_and_whitespace` | test | L987 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::unknown_fields_are_rejected` | test | L997 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::sensitivity_matrix_matches_read_medium_write_high` | test | L1004 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::concurrency_is_readonly_for_reads_and_serial_for_writes` | test | L1055 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/git_executor.rs::tests::can_handle_matches_all_five_tools_with_any_namespace` | test | L1074 | ported:host/plugins/agent-workspace/tests/tools-git.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::truncates_stdout_by_bytes` | test | L2455 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::truncated_utf8_output_keeps_valid_utf8_prefix` | test | L2463 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::shell_kind_marker_discards_probe_stderr_and_reports_actual_shell` | test | L2478 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::windows_init_failure_exit_code_is_reported_unsigned_and_hex` | test | L2491 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::failure_error_for_llm_includes_exit_code_and_stderr_tail` | test | L2500 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::failure_error_for_llm_explains_powershell_startup_failure` | test | L2530 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::failure_error_for_llm_marks_timeout_and_unknown_exit` | test | L2547 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::failure_error_for_llm_truncates_long_stderr_by_tail` | test | L2576 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::posix_syntax_hints_cover_common_bash_isms` | test | L2596 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::failure_error_includes_powershell_hints_only_for_windows_shell` | test | L2627 | ported:host/plugins/agent-workspace/tests/tools-shell-output.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_plan_inherit_default_only_applies_when_requested` | test | L2680 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_plan_full_access_inherit_still_strips_sensitive_keys` | test | L2700 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::command_audit_never_returns_embedded_credentials` | test | L2722 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::command_audit_hash_matches_preflight_newline_normalization` | test | L2752 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::craft_full_access_presets_select_unsandboxed_backend` | test | L2764 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::bounded_pipe_drain_counts_but_does_not_retain_unbounded_output` | tokio::test | L2807 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::drain_timeout_preserves_already_captured_output_as_a_warning` | tokio::test | L2828 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::cancellation_terminates_and_reaps_sandbox_process_tree` | tokio::test | L2877 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::successful_foreground_exit_still_kills_background_group` | tokio::test | L2910 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::skills_directory_commands_are_denied_by_predicate` | test | L2942 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::every_existing_skill_base_is_added_to_hard_write_protection` | test | L2958 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::refuses_skill_package_roots_as_shell_cwd` | test | L2981 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_policy_blocks_explicit_sensitive_values` | test | L2999 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::sensitive_env_key_detection_uses_credential_boundaries` | test | L3010 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_allowlist_rejects_new_sensitive_key_families` | test | L3054 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_policy_defaults_to_minimal_inheritance` | test | L3074 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_plan_hash_changes_with_redacted_values_without_exposing_them` | test | L3090 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_policy_blocks_execution_control_and_path_overrides` | test | L3106 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::inherited_path_drops_empty_and_relative_entries` | test | L3140 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::runtime_read_roots_include_active_developer_toolchain` | test | L3161 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::env_policy_uses_allowlist_mode_without_values_in_audit` | test | L3179 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::injects_skill_dir_for_skill_package_roots_and_audits_without_path` | test | L3202 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::rejects_skill_dir_injection_for_non_skill_roots` | test | L3240 | ported:host/plugins/agent-workspace/tests/tools-shell-env.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::network_policy_classifies_obvious_network_commands` | test | L3258 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::network_policy_audit_has_no_external_target` | test | L3274 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::network_policy_audit_reports_hard_enforcement` | test | L3291 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::danger_network_audit_marks_boundary_as_unenforced` | test | L3311 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::network_policy_detects_powershell_network_cmdlets` | test | L3332 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::readonly_roots_block_write_capable_commands` | test | L3358 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::minimal_env_prefers_the_trusted_xcode_toolchain` | test | L3423 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::wrapper_classification_uses_the_effective_command` | test | L3445 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::writable_root_rejects_absolute_and_parent_escape_operands` | test | L3475 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::execution_argument_aliases_match_approval_normalization` | test | L3519 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::file_snapshot_summary_detects_created_modified_deleted_without_content` | test | L3535 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::blocking_snapshot_helper_preserves_snapshot_contents` | tokio::test | L3577 | ported:host/plugins/agent-workspace/tests/tools-shell-execute.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::classifies_readonly_prefix_as_low_risk_candidate` | test | L733 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::classifies_write_capable_prefixes_as_dangerous` | test | L746 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::full_access_preflight_reports_backend_approval_bypass_for_network_shell` | test | L762 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::only_craft_full_access_presets_select_unsandboxed_preflight` | test | L783 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::preflight_without_admitted_authority_remains_fail_closed` | test | L812 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::skills_directory_commands_are_flagged_for_blocking` | test | L824 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::cwd_must_exist_and_be_a_directory` | test | L840 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::platform_contract_matches_executor_backends` | test | L859 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::preflight_command_audit_redacts_secrets_but_hashes_the_original` | test | L894 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs::tests::preflight_tool_arguments_cross_audit_boundaries_redacted` | test | L909 | ported:host/plugins/agent-workspace/tests/tools-shell-preflight.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs::tests::language_mapping_covers_initial_server_set` | test | L744 | ported:host/plugins/agent-workspace/tests/tools-lsp-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs::tests::source_positions_are_one_based_and_convert_to_utf16` | test | L761 | ported:host/plugins/agent-workspace/tests/tools-lsp-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs::tests::executor_contract_is_medium_readonly` | test | L769 | ported:host/plugins/agent-workspace/tests/tools-lsp-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs::tests::result_uris_are_relative_and_external_locations_are_removed` | test | L785 | ported:host/plugins/agent-workspace/tests/tools-lsp-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs::tests::rust_analyzer_completes_initialize_handshake_when_installed` | tokio::test | L801 | ported:host/plugins/agent-workspace/tests/tools-lsp-navigation.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs::tests::handles_expected_tool_names` | test | L241 | ported:host/plugins/agent-workspace/tests/tools-runtime-root-request.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs::tests::sensitivity_is_high` | test | L249 | ported:host/plugins/agent-workspace/tests/tools-runtime-root-request.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs::tests::critical_paths_are_rejected_by_agent_policy` | test | L258 | ported:host/plugins/agent-workspace/tests/tools-runtime-root-request.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs::tests::parse_args_requires_path_and_purpose` | test | L265 | ported:host/plugins/agent-workspace/tests/tools-runtime-root-request.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs::tests::broad_payload_includes_warning` | test | L272 | ported:host/plugins/agent-workspace/tests/tools-runtime-root-request.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::linux_tests::bwrap_args_readonly_root_and_writable_remount_and_no_network` | test | L862 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::linux_tests::bwrap_args_allow_network_omits_unshare_net` | test | L909 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::linux_tests::bwrap_args_mask_protected_read_dirs_and_files` | test | L925 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::linux_tests::bwrap_args_strict_read_mode_uses_empty_root_and_rebinds_only_allowed_path` | test | L958 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::linux_tests::bwrap_args_pass_paths_with_spaces_verbatim` | test | L986 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::linux_tests::effect_report_exposes_resource_limits_and_contract` | test | L1009 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::profile_denies_network_and_protects_write_roots` | test | L1048 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::seatbelt_blocks_write_outside_writable_roots` | tokio::test | L1082 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::seatbelt_allows_shell_operators_interpreters_and_children_inside_root` | tokio::test | L1106 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::seatbelt_allows_script_runner_while_network_is_denied` | tokio::test | L1138 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::seatbelt_denies_network_even_to_loopback` | tokio::test | L1198 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::timeout_kills_descendant_process_group` | tokio::test | L1220 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::seatbelt_profile_is_private_temp_file_and_not_inline_argv` | test | L1278 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::danger_backend_is_explicit_unsandboxed_posix_shell_with_limits` | test | L1313 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::payload_validation_rejects_write_root_other_than_cwd` | test | L2141 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::payload_parent_comparison_uses_windows_path_semantics` | test | L2159 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::spawn_failure_cleanup_removes_unconsumed_payload` | test | L2171 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::full_access_helper_cwd_stays_at_payload_root` | test | L2192 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::unsandboxed_effect_report_honestly_reports_no_resource_limits` | test | L2212 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::powershell_contract_uses_trusted_binary_encoded_script_and_utf8` | test | L2226 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::git_bash_contract_exposes_install_root_and_initializes_path` | test | L2258 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::windows_argv_quoting_preserves_quotes_and_trailing_backslashes` | test | L2277 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::job_limits_bound_cpu_and_active_processes` | test | L2284 | ported:host/plugins/agent-workspace/tests/tools-shell-sandbox-windows.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::appcontainer_writes_only_inside_selected_cwd` | test | L2309 | pending |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::appcontainer_blocks_protected_subdirectory_writes` | test | L2334 | pending |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::appcontainer_denies_network_without_capability` | test | L2369 | pending |
| `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::cancellation_prevents_late_process_launch` | test | L2406 | pending |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::page_rejects_mid_char_offset` | test | L244 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::page_rejects_offset_past_eof` | test | L253 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::page_at_eof_returns_empty_block` | test | L259 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::page_snaps_end_to_char_boundary_and_makes_progress` | test | L269 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::expected_hash_is_case_insensitive` | test | L279 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::budget_fit_keeps_cursor_on_final_body` | test | L286 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::successive_pages_reconstruct_full_text` | test | L319 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::parse_offset_and_max_bytes_defaults` | test | L336 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs::tests::budget_fit_refuses_a_non_advancing_page` | test | L350 | ported:host/plugins/agent-workspace/tests/utf8-paged-read.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::normalizes_safe_relative_path` | test | L1084 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::rejects_escape_paths` | test | L1096 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::sanitizes_session_dir` | test | L1103 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::overwrite_backups_land_in_temp_backup_area` | test | L1111 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::sensitivity_marks_artifact_write_medium` | test | L1128 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::hidden_and_secret_paths_are_private_by_default` | test | L1143 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::existing_path_resolution_rejects_symlinked_private_targets` | test | L1165 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::directory_list_stops_after_requested_limit` | test | L1184 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::directory_list_filters_hidden_and_secret_entries` | test | L1199 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::file_read_streams_full_hash_but_keeps_only_visible_prefix` | test | L1219 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::file_read_rejects_mid_utf8_offset` | test | L1240 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::file_read_rejects_offset_past_eof` | test | L1249 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::file_read_at_eof_returns_empty_visible` | test | L1258 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::file_read_pages_reconstruct_full_utf8_and_hash_is_whole_file` | test | L1269 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::file_read_result_budget_is_disabled` | test | L1301 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::file_read_rejects_oversized_sparse_files_before_allocating` | test | L1314 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::atomic_write_replaces_or_preserves_existing_content` | test | L1323 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::apply_edits_single_unique_replacement` | test | L1336 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::apply_edits_rejects_non_unique_without_replace_all` | test | L1348 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::apply_edits_rejects_missing_old_string` | test | L1363 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::apply_edits_rejects_empty_and_noop_edits` | test | L1374 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::apply_edits_applies_multiple_edits_sequentially` | test | L1383 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs::tests::apply_edits_is_atomic_on_any_failure` | test | L1395 | ported:host/plugins/agent-workspace/tests/tools-workspace-fs.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_escape_xml_attr` | test | L2868 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_escape_xml_content` | test | L2876 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_infer_media_type` | test | L2883 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_resolved_content` | test | L2893 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_default_image_mode_keeps_source_without_implicit_ocr` | test | L2910 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_non_multimodal_image_request_downgrades_to_ocr` | test | L2918 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_default_pdf_mode_is_text_only` | test | L2928 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_non_multimodal_pdf_image_request_downgrades_to_ocr` | test | L2939 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::textbook_default_keeps_native_text_without_ocr_duplicate` | test | L2951 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::exam_default_omits_card_ocr_but_explicit_ocr_includes_it` | test | L2983 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_resolve_question_image_blob_from_hash_field` | test | L3002 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/vfs_resolver.rs::tests::test_resolve_question_image_blob_from_file_id` | test | L3014 | ported:host/plugins/agent-workspace/tests/vfs-resolver.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::legacy_skill_resolves_to_real_worker_profile` | test | L475 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::built_in_tools_use_real_executor_names` | test | L490 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::built_in_profile_tools_are_registry_builtins` | test | L511 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::explorer_extra_tools_are_headless_read_only_subset` | test | L527 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::description_is_trimmed_and_empty_becomes_none` | test | L542 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::persisted_profile_round_trips_as_runtime_config` | test | L566 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::overrides_are_normalized_and_directly_consumable` | test | L577 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::resolve_with_custom_falls_back_to_directory_and_applies_overrides` | test | L597 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::legacy_agent_row_is_runtime_consumable` | test | L662 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::persona_model_validation_requires_exact_enabled_generation_config_id` | test | L675 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs::tests::computed_hash_is_stable_and_content_locked` | test | L710 | ported:host/plugins/agent-workspace/tests/workspace-agent-profile.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_migration_creates_completion_outbox_table` | test | L412 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_enqueue_is_idempotent_by_run_id` | test | L443 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_claim_grace_period_skips_fresh_rows` | test | L465 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_claim_excludes_already_claimed_and_terminal` | test | L510 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_reclaim_expired_claims_returns_rows_to_pending` | test | L542 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_release_claim_and_owner_guards` | test | L585 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_terminal_states_reject_further_transitions` | test | L631 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_completion_message_exists_matches_by_run_id` | test | L662 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs::tests::g03_target_state_check_constraint` | test | L699 | ported:host/plugins/agent-workspace/tests/workspace-completion-outbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs::tests::drain_inbox_marks_exact_drained_messages_processed` | test | L1218 | ported:host/plugins/agent-workspace/tests/workspace-coordinator.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs::tests::peek_inbox_is_read_only_and_matches_drain_order` | test | L1275 | ported:host/plugins/agent-workspace/tests/workspace-coordinator.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs::tests::close_workspace_cancels_active_sleeps` | test | L1330 | ported:host/plugins/agent-workspace/tests/workspace-coordinator.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/coordinator.rs::tests::register_agent_quota_ignores_terminal_agents` | test | L1360 | ported:host/plugins/agent-workspace/tests/workspace-coordinator.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::parses_regular_definition_with_comma_separated_tools` | test | L483 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::parses_inline_array_tools` | test | L518 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::out_of_whitelist_tools_are_dropped_not_fatal` | test | L544 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::custom_profile_maps_losslessly_to_grant_scopes` | test | L567 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::chatanki_write_and_workspace_document_tools_stay_blocked_fail_closed` | test | L638 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::chatanki_mixed_readonly_and_write_declaration_keeps_only_readonly` | test | L699 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::built_in_name_conflict_is_skipped` | test | L722 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::missing_name_is_skipped` | test | L733 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::invalid_name_characters_are_skipped` | test | L740 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::empty_body_keeps_base_instructions` | test | L753 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::invalid_base_is_skipped_and_missing_dir_is_empty` | test | L767 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::skills_field_is_parsed_for_runtime_snapshot` | test | L782 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::reasoning_effort_is_parsed_for_runtime_use` | test | L795 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs::tests::unsupported_permission_and_context_fields_are_rejected` | test | L815 | ported:host/plugins/agent-workspace/tests/workspace-custom-agents.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/database.rs::tests::validate_workspace_id_accepts_generated_ids` | test | L609 | ported:host/plugins/agent-workspace/tests/workspace-database.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/database.rs::tests::validate_workspace_id_rejects_path_escapes` | test | L617 | ported:host/plugins/agent-workspace/tests/workspace-database.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/database.rs::tests::workspace_database_new_rejects_traversal_ids` | test | L632 | ported:host/plugins/agent-workspace/tests/workspace-database.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/database.rs::tests::prepare_failure_keeps_workspace_file_and_metadata` | test | L642 | ported:host/plugins/agent-workspace/tests/workspace-database.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/database.rs::tests::ready_failure_is_reported_and_next_call_recovers` | test | L675 | ported:host/plugins/agent-workspace/tests/workspace-database.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/inbox.rs::tests::test_push_and_drain` | test | L149 | ported:host/plugins/agent-workspace/tests/inbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/inbox.rs::tests::test_max_inbox_size_rejects_new_messages` | test | L164 | ported:host/plugins/agent-workspace/tests/inbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/inbox.rs::tests::test_multiple_agents` | test | L207 | ported:host/plugins/agent-workspace/tests/inbox.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/injector.rs::tests::throttle_enforces_cooldown_between_injections` | test | L185 | ported:host/plugins/agent-workspace/tests/workspace-injector.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/injector.rs::tests::throttle_enforces_max_injections_per_round` | test | L217 | ported:host/plugins/agent-workspace/tests/workspace-injector.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/injector.rs::tests::fresh_throttle_per_call_would_not_throttle_but_shared_one_does` | test | L246 | ported:host/plugins/agent-workspace/tests/workspace-injector.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/injector.rs::tests::format_truncates_long_message_content` | test | L278 | ported:host/plugins/agent-workspace/tests/workspace-injector.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/injector.rs::tests::format_keeps_short_message_content_intact` | test | L296 | ported:host/plugins/agent-workspace/tests/workspace-injector.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::initial_check_wakes_when_result_arrived_before_sleep` | test | L1298 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::initial_check_wakes_when_agents_already_terminal` | test | L1326 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::initial_check_does_not_wake_without_conditions` | test | L1348 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::agent_status_wake_treats_cancelled_as_terminal` | test | L1370 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::executor_flow_initial_check_then_wait_completes_immediately` | tokio::test | L1390 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::cancel_all_active_cancels_and_is_idempotent` | test | L1422 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::cancel_all_active_aborts_timeout_tasks` | tokio::test | L1454 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs::tests::restore_and_activate_sleeps_is_idempotent` | test | L1473 | ported:host/plugins/agent-workspace/tests/workspace-sleep-manager.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::is_valid_transition_pending_outbound` | test | L678 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::is_valid_transition_running_outbound` | test | L698 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::is_valid_transition_terminal_states_reject_outbound` | test | L718 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::is_valid_transition_unknown_edges` | test | L745 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::is_valid_transition_same_state_idempotent` | test | L777 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::update_status_happy_path_pending_to_running_to_completed` | test | L791 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::update_status_rejects_completed_to_running` | test | L809 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::update_status_rejects_pending_to_completed_skip` | test | L837 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::update_status_idempotent_same_state` | test | L851 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::update_status_not_found_returns_error` | test | L868 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::mark_running_rejected_on_terminal_task` | test | L877 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::mark_running_preserves_first_started_at` | test | L912 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::cancelled_task_excluded_from_restore` | test | L940 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::running_to_unknown_transition_via_db` | test | L967 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::unknown_preserves_result_summary_when_reason_absent` | test | L992 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs::tests::sweep_orphaned_running_converts_only_dead_owners` | test | L1008 | ported:host/plugins/agent-workspace/tests/workspace-subagent-task.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::create_modify_and_rollback_restore_exact_contents` | test | L695 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::binary_write_is_hash_bound_and_rollback_restores_exact_bytes` | test | L728 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::move_delete_and_rollback_restore_tree` | test | L770 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::external_shell_change_set_rolls_back_created_modified_and_deleted_files` | test | L804 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::change_set_rollback_reports_partial_failure_and_continues` | test | L838 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::rejects_path_escape_protected_paths_and_stale_hashes` | test | L878 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::stale_rollback_never_overwrites_user_edits` | test | L916 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
| `crates/dstu-agent/src/chat_v2/workspace_change_set.rs::tests::rejects_symlink_traversal` | test | L939 | ported:host/plugins/agent-workspace/tests/workspace-change-set.test.ts |
<!-- END GENERATED:testmap:rows -->
