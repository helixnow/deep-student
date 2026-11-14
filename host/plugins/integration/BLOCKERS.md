# L22 v2 阻塞（2026-11-04）

正常 main 基线：`2ee9a9cbe`（2026-11-06 WP-114 起为 `4dc4c8ed9` 之后的 merge）。TESTMAP 当前 19 条
`| pending |` 行（WP-114 核对：generative_ui 3、tool_pack 14、tools_integration 1、windows_shell_helper 1；
L20 四条已解除，见下文“已解除”）。2026-11-04 晚：L02 删除固定 throw 并让
`test_api_connection` 使用 L01 `llmCodexAuth`，Codex OAuth 2 条已解除阻塞，经生产命令移植到
`tests/llm-codex-connection.test.ts`；完整 ID 逐条列于
`REPORT.md` §7.1–7.6（本文件不替代 TESTMAP）。

| 类别 / owner | 测试 ID（同文件前缀） | 当前证据 / 所需接口 |
|---|---|---|
| 其他 lane / L17（+L13 调用点） | `generative_ui_executor_e2e` 3 条：`execute_with_default_backend_keeps_research_blocks_static`（L123）、`execute_with_research_session_emits_hpias_session_started`（L167）、`execute_hpias_stub_pipeline_emits_plan_generated`（L235） | WP-150 核对（2026-11-06）：旧表述“main 无实现/9 条等待”已过时，main 已有 `vfs/index.ts:83,219-220` 经 `agentTools` 注册 `GenerativeUiExecutor`，`memory/index.ts:109` 提供 `hpiasResearch`；其余 6 条已 ported。剩余 3 条是生产语义缺口：① `memory/src/hpias-service.ts:80-91` 不读 `DEEP_STUDENT_HPIAS_BACKEND`（`backendKindFromConfig` 只在测试里调用），默认就跑 stub 时间线，Rust `service.rs:88-106` 默认 Disabled 时不发任何事件；② 生产链路不发 `session_started`：Rust 执行器 `generative_ui_executor.rs:327-360` 在后端启用时先 `emit_session_started(session_id, question)`，再启动时间线（`orchestrator.rs:31-35` 跳过首条），TS `generative-ui.ts:149-152` 只调 `startFromIntent`，`runHpiasTimeline` 也跳过首条，所以没人发这条事件；③ L13 只把 `meta.title` 传给 `title`，没有 Rust `:440-441` 的 `title.or(extract_question_from_intent)`。真实注册实例实测（job `20261105182343-52d197`，临时探针未提交）：默认环境下 `research-report` 发出 `round_started, plan_generated, retrieval_completed`；`research-plan` 在 1.3s 内没有 `session_started`。所需接口见 REPORT §7.2。 |
| 其他 lane / L06 | `tool_pack_integration_tests` 14 条 | `agent-orchestration/src/tool-pack.ts:1-40` 只有常量/admission/subcontext，无 execute、取消/截止时间/并发聚合。需真实 `ToolPackExecutor.execute`，普通 registry 不等价。 |
| 其他 lane / L19 | `tools_integration_tests::test_tool_error_details_generation` | `mcp` registry 只有六元组 `callTool`，无 `call_tool_with_details` 的 ErrorDetails（Rust 测试第七项）。需 ToolNotFound/message/suggestions 的真实 registry 输出。 |
| 其他 lane / L05-F2 | `windows_shell_helper_e2e::helper_consumes_only_fixed_root_payload_and_executes_with_rewritten_temp` | `agent-workspace/api.ts` 未导出 helper arg/root，Electron 无 helper 子进程入口；Linux 不能代签 Windows 执行。需公开 helper 启动协议与目标平台验证，不能只测内部 payload helper 冒充 e2e。 |

## 已解除：L20 冲突解决 / 快照回退命令（WP-114，2026-11-06）

原阻塞行（`sync_r10_protocol_locks::p2_3_…_source_lock`、`sync_r12_conflict_fast_path` 2 条、
`sync_r11_history::r11_resolve_command_snapshots_and_new_commands_browse_and_rollback`）已解除：
main `4dc4c8ed9` 的 `host/plugins/sync/index.ts:219-221` 真实注册
`data_governance_resolve_record_conflict` / `data_governance_rollback_sync_snapshot_batch`。
4 行经 `tests/sync-conflict-fast-path.test.ts`、`tests/sync-history-e2e.test.ts` 走真实
F3 storage、L21 备份许可与 L20 命令表；冲突由 L20 `applyDownloadedChangesWithConflictGuard`
产生，竞争窗口由 worker 线程上的第二个 SQLite 连接复现。`blocked/` 下的原 `.txt` 副本已由
`69a368177` 移除，原文可用 `git show 69a368177^:host/plugins/integration/blocked/<文件>` 取回。

## 基线测试装配回归（不增加 pending 计数）

job `20261104093123-fa00f4` exit 1，9 failed files / 27 failed tests / 33 未执行；
堆栈 `sync/tests/test-db.ts:38-39`、`sync/tests/host-fixture.ts:23-24` 提供
`{deviceId}`，但当前 L11 `vfs-repos/index.ts:153` 需要 F4 的
`paths.dataSpaceDeviceId()`。L22 自有云测试 paths 夹具同样过期。
L22 将自有装配改用真实 F4 paths / F3 storage，不复制设备身份算法；已通知协调者
L20 公共 fixture 需要 owner 同步。禁止改失败断言或把初始化失败计作通过。

## 本 lane 自有范围（不是阻塞）

### L18 pin/unpin 的临时会话修改：已交付（2026-11-04）

`ctx.appCommandState.modifyTempSession(tempId, mutator): Promise<StreamContext>`（api.ts，服务
版本 1.1.0）按 `commands.rs:248-285` 实现：内存命中直接修改；未命中读 DB → 缺失
`NotFound("临时会话不存在")`、读失败 `Database("读取临时会话失败: …")`；修改、回填并按上限驱逐；
两路均持久化，失败 `Database("持久化临时会话失败: …")`。错误以 `CommandError(AppError)` 抛出。
仓储 `repository/temp-sessions.ts` 逐行对应 `dstu-storage/src/database/mod.rs:4169-4216`，
StreamContext serde 编解码在 `src/stream-context.ts`。测试：`tests/temp-session-modify.test.ts`
（真实迁移后的 mistakes 库 + 生产入口 ctx 服务）。L18 自己负责 `pinned_images:<id>` 设置。

**待裁定（单写者归属）**：`gate-checks/owner-rulings.json` 把 `temp_sessions` 判给 `chat`
（X6-OWN-C2-20261104，依据"D1 chat data incl. legacy chat"）。Rust 证据：该表的唯一写入/读取
调用方是 `src-tauri/src/commands.rs:166-171,248-285`（`persist_temp_session_to_db` /
`modify_temp_session`，仅被 `pin_images`/`unpin_images` 调用；`cache_temp_session`、
`get_or_restore_temp_session`、`remove_temp_session` 无调用者），即 L22 拥有的
`temp_sessions` 状态（`APP_STATE_OWNERS.temp_sessions`）。chat 插件没有任何 temp_sessions
代码。已请求 C2 把 `temp_sessions` 改判给 `integration`；裁定前 single-writer 报告会把
`repository/temp-sessions.ts` 记为 foreign-table-write（该检查不在集成门禁内）。

**残余（已知、不影响 pin/unpin）**：StreamContext / ChatMessage / ChatMetadata 逐字段 typed；
更深的 typed 结构（RagSourceInfo、DocumentAttachment、MultimodalContentPart、ToolCall/ToolResult、
MistakeExamSheetLink、BridgeLinkContext）按 `serde_json::Value` 精确原样往返（只校验容器种类），
不复现其内部 `None` 字段省略和 `RagSourceInfo.score` 的 f32 舍入。

缓存逐条 Rust 断言、同步回调文档纠错、过期自有测试夹具和 API 类型修正由 L22 完成。
未发现新增 npm / F7 原生依赖需求。无独立 ACCEPTANCE 报告，v2 B 级待复核，不自行签收。
