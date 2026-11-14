# L17-memory-research：记忆与研究

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L17-memory-research（记忆与研究） |
| 目录 | `host/plugins/memory/` |
| Rust 范围（lanes.md） | dstu-memory、dstu-research、quick_assistant，以及 memory、academic、paper、knowledge 等工具 |
| 主要提供 | `memory@1` |
| 主要消费 | L02、L12 |
| 特别注意 | 内化任务队列 |
| 规模（本目录） | 27312 行 · 44 个文件 · 34 个命令（前端调用 33） · 168 个测试 |
| 规模（整条 lane，inventory） | 27312 行 · 44 个文件 · 34 个命令（前端 33） · 168 个测试 |
| 契约 | [`contracts/ipc/L17-memory-research.json`](../../../contracts/ipc/L17-memory-research.json) |
| 服务草稿 | [`contracts/services/DRAFT-L17-memory-research.md`](../../../contracts/services/DRAFT-L17-memory-research.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-memory/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-memory/src/lib.rs` | 25 | 0 |  |
| `src-tauri/crates/dstu-memory/src/memory/audit_log.rs` | 378 | 0 |  |
| `src-tauri/crates/dstu-memory/src/memory/auto_extractor.rs` | 600 | 9 |  |
| `src-tauri/crates/dstu-memory/src/memory/category_manager.rs` | 512 | 5 |  |
| `src-tauri/crates/dstu-memory/src/memory/compaction_flush.rs` | 426 | 8 |  |
| `src-tauri/crates/dstu-memory/src/memory/compressor.rs` | 161 | 0 |  |
| `src-tauri/crates/dstu-memory/src/memory/config.rs` | 625 | 3 |  |
| `src-tauri/crates/dstu-memory/src/memory/daily_log.rs` | 578 | 7 |  |
| `src-tauri/crates/dstu-memory/src/memory/delete_hook.rs` | 113 | 0 |  |
| `src-tauri/crates/dstu-memory/src/memory/evolution.rs` | 1359 | 10 |  |
| `src-tauri/crates/dstu-memory/src/memory/handlers.rs` | 1042 | 0 | 31 |
| `src-tauri/crates/dstu-memory/src/memory/learner_profile.rs` | 1947 | 19 |  |
| `src-tauri/crates/dstu-memory/src/memory/llm_decision.rs` | 345 | 7 |  |
| `src-tauri/crates/dstu-memory/src/memory/mastery_hook.rs` | 44 | 0 |  |
| `src-tauri/crates/dstu-memory/src/memory/mod.rs` | 116 | 0 |  |
| `src-tauri/crates/dstu-memory/src/memory/query_rewriter.rs` | 212 | 2 |  |
| `src-tauri/crates/dstu-memory/src/memory/reranker.rs` | 125 | 1 |  |
| `src-tauri/crates/dstu-memory/src/memory/semantic_dedup.rs` | 801 | 6 |  |
| `src-tauri/crates/dstu-memory/src/memory/service.rs` | 5204 | 12 |  |
| `src-tauri/crates/dstu-research/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-research/src/hpias/events.rs` | 69 | 3 |  |
| `src-tauri/crates/dstu-research/src/hpias/mod.rs` | 23 | 0 |  |
| `src-tauri/crates/dstu-research/src/hpias/orchestrator.rs` | 99 | 2 |  |
| `src-tauri/crates/dstu-research/src/hpias/payloads.rs` | 462 | 8 |  |
| `src-tauri/crates/dstu-research/src/hpias/retrieval_backend.rs` | 296 | 3 |  |
| `src-tauri/crates/dstu-research/src/hpias/service.rs` | 164 | 5 |  |
| `src-tauri/crates/dstu-research/src/hpias/synthesis.rs` | 151 | 1 |  |
| `src-tauri/crates/dstu-research/src/insight/disclosure.rs` | 328 | 5 |  |
| `src-tauri/crates/dstu-research/src/insight/jobs.rs` | 734 | 0 |  |
| `src-tauri/crates/dstu-research/src/insight/mod.rs` | 32 | 0 |  |
| `src-tauri/crates/dstu-research/src/insight/recall.rs` | 450 | 0 |  |
| `src-tauri/crates/dstu-research/src/insight/repo.rs` | 598 | 0 |  |
| `src-tauri/crates/dstu-research/src/insight/service.rs` | 503 | 0 |  |
| `src-tauri/crates/dstu-research/src/insight/tests.rs` | 743 | 15 |  |
| `src-tauri/crates/dstu-research/src/insight/types.rs` | 435 | 0 |  |
| `src-tauri/crates/dstu-research/src/lib.rs` | 31 | 0 |  |
| `src-tauri/src/chat_v2/tools/academic_search_executor.rs` | 1140 | 7 |  |
| `src-tauri/src/chat_v2/tools/insight_recall_executor.rs` | 397 | 0 |  |
| `src-tauri/src/chat_v2/tools/knowledge_executor.rs` | 442 | 5 |  |
| `src-tauri/src/chat_v2/tools/learning_overview_executor.rs` | 1401 | 7 |  |
| `src-tauri/src/chat_v2/tools/memory_executor.rs` | 2382 | 7 |  |
| `src-tauri/src/chat_v2/tools/paper_save_executor.rs` | 1485 | 9 |  |
| `src-tauri/src/quick_assistant.rs` | 298 | 2 | 3 |

### 命令（34）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `memory_add_relation` | `crates/dstu-memory/src/memory/handlers.rs:364` | async | app | src/api/memoryApi.ts:187 | (noteIdA: string, noteIdB: string) → null ! string |
| `memory_batch_delete` | `crates/dstu-memory/src/memory/handlers.rs:478` | async | app | src/api/memoryApi.ts:242 | (noteIds: string[]) → BatchOperationResult ! string |
| `memory_batch_move` | `crates/dstu-memory/src/memory/handlers.rs:522` | async | app | src/api/memoryApi.ts:249 | (noteIds: string[], targetFolderPath: string) → BatchOperationResult ! string |
| `memory_create_root_folder` | `crates/dstu-memory/src/memory/handlers.rs:208` | async | app | src/api/memoryApi.ts:140 | (title: string) → string ! string |
| `memory_delete` | `crates/dstu-memory/src/memory/handlers.rs:614` | async | app | src/api/memoryApi.ts:274 | (noteId: string) → null ! string |
| `memory_export_all` | `crates/dstu-memory/src/memory/handlers.rs:688` | async | app | src/api/memoryApi.ts:294 | (（无）) → MemoryExportItem[] ! string |
| `memory_get_audit_logs` | `crates/dstu-memory/src/memory/handlers.rs:947` | async | app | src/api/memoryApi.ts:355 | (limit?: integer(u32) \| null, offset?: integer(u32) \| null, sourceFilter?: string \| null, operationFilter?: string \| null, successFilter?: boolean \| null) → MemoryAuditLogItem[] ! string |
| `memory_get_config` | `crates/dstu-memory/src/memory/handlers.rs:174` | async | app | src/api/memoryApi.ts:116 | (（无）) → MemoryConfigOutput ! string |
| `memory_get_or_create_root_folder` | `crates/dstu-memory/src/memory/handlers.rs:221` | async | none | — | (（无）) → string ! string |
| `memory_get_profile` | `crates/dstu-memory/src/memory/handlers.rs:721` | async | app | src/api/memoryApi.ts:290 | (（无）) → MemoryProfileSection[] ! string |
| `memory_get_related` | `crates/dstu-memory/src/memory/handlers.rs:400` | async | app | src/api/memoryApi.ts:195 | (noteId: string) → string[] ! string |
| `memory_get_tags` | `crates/dstu-memory/src/memory/handlers.rs:466` | async | app | src/api/memoryApi.ts:213 | (noteId: string) → string[] ! string |
| `memory_get_tree` | `crates/dstu-memory/src/memory/handlers.rs:353` | async | app | src/api/memoryApi.ts:183 | (（无）) → FolderTreeNode \| null ! string |
| `memory_list` | `crates/dstu-memory/src/memory/handlers.rs:337` | async | app | src/api/memoryApi.ts:175 | (folderPath?: string \| null, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → MemoryListItem[] ! string |
| `memory_move_to_folder` | `crates/dstu-memory/src/memory/handlers.rs:566` | async | app | src/api/memoryApi.ts:256 | (noteId: string, targetFolderPath: string) → null ! string |
| `memory_read` | `crates/dstu-memory/src/memory/handlers.rs:249` | async | app | src/api/memoryApi.ts:153 | (noteId: string) → MemoryReadOutput \| null ! string |
| `memory_remove_relation` | `crates/dstu-memory/src/memory/handlers.rs:382` | async | app | src/api/memoryApi.ts:191 | (noteIdA: string, noteIdB: string) → null ! string |
| `memory_restore_archived` | `crates/dstu-memory/src/memory/handlers.rs:447` | async | app | src/api/memoryApi.ts:209 | (noteId: string) → boolean ! string |
| `memory_restore_stale` | `crates/dstu-memory/src/memory/handlers.rs:430` | async | app | src/api/memoryApi.ts:204 | (noteId: string) → boolean ! string |
| `memory_search` | `crates/dstu-memory/src/memory/handlers.rs:233` | async | app | src/api/memoryApi.ts:147 | (query: string, topK?: integer(usize) \| null) → MemorySearchResult[] ! string |
| `memory_set_auto_create_subfolders` | `crates/dstu-memory/src/memory/handlers.rs:629` | async | app | src/api/memoryApi.ts:128 | (enabled: boolean) → null ! string |
| `memory_set_auto_extract_frequency` | `crates/dstu-memory/src/memory/handlers.rs:655` | async | app | src/api/memoryApi.ts:136 | (frequency: string) → null ! string |
| `memory_set_default_category` | `crates/dstu-memory/src/memory/handlers.rs:642` | async | app | src/api/memoryApi.ts:132 | (category: string) → null ! string |
| `memory_set_privacy_mode` | `crates/dstu-memory/src/memory/handlers.rs:197` | async | app | src/api/memoryApi.ts:124 | (enabled: boolean) → null ! string |
| `memory_set_root_folder` | `crates/dstu-memory/src/memory/handlers.rs:184` | async | app | src/api/memoryApi.ts:120 | (folderId: string) → null ! string |
| `memory_to_anki_document` | `crates/dstu-memory/src/memory/handlers.rs:973` | async | app | src/api/memoryApi.ts:227 | (folderPath?: string \| null, purposeFilter?: string \| null, limit?: integer(u32) \| null) → MemoryAnkiDocument ! string |
| `memory_update_by_id` | `crates/dstu-memory/src/memory/handlers.rs:584` | async | app | src/api/memoryApi.ts:265 | (noteId: string, title?: string \| null, content?: string \| null) → MemoryWriteOutput ! string |
| `memory_update_tags` | `crates/dstu-memory/src/memory/handlers.rs:412` | async | app | src/api/memoryApi.ts:199 | (noteId: string, tags: string[]) → null ! string |
| `memory_write` | `crates/dstu-memory/src/memory/handlers.rs:276` | async | app | src/api/memoryApi.ts:162 | (noteId?: string \| null, folderPath?: string \| null, title: string, content: string, mode?: string \| null) → MemoryWriteOutput ! string |
| `memory_write_batch` | `crates/dstu-memory/src/memory/handlers.rs:815` | async | app | src/api/memoryApi.ts:323 | (items: MemoryBatchWriteItemInput[], defaultFolderPath?: string \| null, defaultMemoryType?: string \| null, defaultMemoryPurpose?: string \| null) → MemoryBatchWriteOutput ! string |
| `memory_write_smart` | `crates/dstu-memory/src/memory/handlers.rs:761` | async | app | src/api/memoryApi.ts:307 | (folderPath?: string \| null, title: string, content: string, memoryType?: string \| null, memoryPurpose?: string \| null, idempotencyKey?: string \| null) → SmartWriteOutput ! string |
| `quick_assistant_apply_enabled` | `src/quick_assistant.rs:273` | sync | app | src/quick-assistant/window.ts:103 | (enabled: boolean) → null |
| `quick_assistant_hide` | `src/quick_assistant.rs:264` | sync | app | src/quick-assistant/window.ts:39 | (（无）) → null |
| `quick_assistant_show` | `src/quick_assistant.rs:256` | sync | app | src/quick-assistant/window.ts:29 | (（无）) → null |

### 发出的事件（3）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `hpias_event` | 常量 `HPIAS_EVENT_CHANNEL` | crates/dstu-research/src/hpias/events.rs:25 (emit) |
| `memory://changed` | 字面量 | crates/dstu-memory/src/memory/handlers.rs:89 (emit)<br>src/chat_v2/tools/memory_executor.rs:440 (emit) |
| `quick-assistant://shown` | 常量 `SHOWN_EVENT` | src/quick_assistant.rs:193 (emit) |

### 契约中的事件（3，`contracts/ipc/L17-memory-research.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `hpias_event` | 否 | Value | crates/dstu-research/src/hpias/events.rs:25 (emit) |
| `memory://changed` | 否 | object \| object | crates/dstu-memory/src/memory/handlers.rs:89 (emit)<br>src/chat_v2/tools/memory_executor.rs:440 (emit) |
| `quick-assistant://shown` | 否 | null | src/quick_assistant.rs:193 (emit) |
<!-- END GENERATED:lane -->

## 备注

### WP-208：migrated-schema 冷/热 report 契约窄修

- 起点 `051c4cb73`，正常 merge main 已是最新。WP-158/F3 精确分页与迁移接口均在 main。
  仅把冷构造返回的完整 MigrationReport 投影为已声明 Pick 的 `{ success, error }`，
  与热读取一致。实际 runAll、失败检查、关闭句柄后原子发布、ready.json 校验均保留。
- 起点原六例 `20261105214500-7dc48f` 6 passed /0 failed /0 skipped /无 Errors /exit0，
  这是已有热缓存结果。先加隔离回归 `20261105214548-697e5a`：0 passed /1 failed /0 skipped /
  无 Errors /exit1；真实四库从0迁移成功，冷 report 多出 databases/totalDurationMs，热 report 正常。
- 新 `tests/migrated-schema-report.test.ts` 用独有空临时根启动两个独立真实 Node/Electron 进程，
  第一个 builder.pid=自身PID，第二个PID不同但仍读取同一 builder.pid/seed 路径，证明冷/热分支。
  两者返回及落盘报告都精确等于 `{ success:true, error:null }`，四库版本均非零且一致。
- 修后 Node `20261105214616-74159d`：3 files /8 passed /0 failed /0 skipped /无 Errors /exit0；
  Electron `20261105214616-3fccf4`：同3 files /8 passed /0 failed /0 skipped /无 Errors /exit0。
  包含原 insight-pagination 六例及原 worker-schema-cache 一例，原文件和默认30秒预算均未改。
  raw 均位于 `/home/dsdev/.oc-jobs/done/<job>.log`，含冷/热PID、路径、report与四库版本原件。
- 本包是测试夹具缺陷修复，不新增 A/C，不改 TESTMAP（109 ported /57 pending /2 approved obsolete）。
  **WP-170 整分支仍 partial blocked**：retrieval 依赖齐全时的新 throw 不符 Rust，后继真实pipeline
  替换前不能因本包或5gate绿而签收；原170代码/测试保留，详见 BLOCKERS 当前集成边界。
  L15/X1 在修复入main后独立消费；最终提交、merge与官方lane-gate结果随WP-208报告交付。

### WP-170：HPIAS 默认禁用与显式 stub 首事件

- 基线 `b17264b88`，正常 merge 保留104/158。入口签名保持；D-070进程环境配置已接入。
  非研究块/disabled不发事件；显式stub先同步发不带options_json的session_started，再跳过
  timeline首条、按原350ms发后续事件；首发失败原WARN后继续，后续失败含index的WARN后停止。
- question 按 Rust title Option：`title ?? extractQuestionFromIntent(intent)`，Some(空/空白)
  不回退；复用原提取器与F4 rustTrim，U+0085去除、U+FEFF保留，环境仅ASCII小写。
- 测试用真实 Host、L07 agentTools registry、L13注册执行器、真实memory/notes/vfs-repos/vfs。
  日志仅观察；vfsIndex为未调用的外部依赖fixture，retrieval齐全分支的llm对象仅证明依赖存在，
  不冒充真实模型/retrieval输出。无测试专用memory实例或被测backend替身。
- 起点类型 `20261105211955-d47eaa` exit0；起点 hpias+l13-ports
  `20261105211955-614707` 37 passed /0 failed /0 skipped /无Errors /exit0。
  先写新provider测试：`20261105212301-3ff851` 0 passed /11 failed /0 skipped /exit1，
  默认收到9条pipeline、同步首事件缺失、retrieval错误被掩盖均复现。
  修复后 `20261105212625-ca105c` 三文件48 passed /0 failed /0 skipped /无Errors /exit0；
  raw `/home/dsdev/.oc-jobs/done/20261105212625-ca105c.log` 包含逐分支事件与WARN原件。
- Electron ABI复验 `20261105212754-9320fc` 同三文件48 passed /0 failed /0 skipped /无Errors /exit0；
  wiring `20261105212754-cf9b2d` exit0：`合计 ported 109，其中所测模块未从 index.ts 接入 0（0.0%）`。
- 新回归验证每个静默分支越过5000ms；stub检验349/350ms边界、完整顺序/session/target/question、
  真实时钟达到session_completed以及卸载后450ms无新事件；虚拟完整调度后timer=0。
  两条旧生产用例补显式stub环境；原非研究断言、400/450ms观察与3000ms预算保留，原round断言
  顺延到第二条，新增首事件断言（Rust executor:348-354 / orchestrator:31-35）。
- retrieval缺依赖原WARN/None；具备VFS/LLM但真实pipeline未迁移时明确错误。自有120ms真实检索
  与synthesis剩余、L02缺`callWithConfigIdRawPrompt(configId,prompt)`见BLOCKERS，不能签全部HPIAS。
- TESTMAP 109 ported /57 pending /2 approved obsolete，去向行未动，旧47保持pending。L22三条由
  WP-175在供方main后独立消费。本包不签A/golden/C；最终tip/base、Electron与gate回执由wp-done交付。

### WP-158：insight 精确 i64 分页供方

- 从 WP-104 正式 tip `05417353c` 恢复，干净合并 main `f3753b682`；此前158无遗留作业。
  起点 typecheck `20261105200549-317eaf` exit 0；insight-service + insight-command-errors
  `20261105200549-fdbdcd` 10 passed / 0 failed / 0 skipped / 无 Errors / exit 0。
- 先新增回归、后改实现：`20261105200826-67a5ed` 原实现 3 passed / 3 failed / exit 1，
  bigint 经过 Math.min 报 `Cannot convert a BigInt value to a number`，同时掩盖了应传播的 SQLite 错误。
- 公开签名（经 `api.ts`）：`listInsights(status: string | null, limit: IpcInteger,
  offset: IpcInteger): Promise<Wire.InsightCard[]>`，`IpcInteger = number | bigint`。
  例：`await ctx.insight.listInsights(null, 9223372036854775807n, 9007199254740993n)`。
- 对照 `dstu-research/src/insight/service.rs:406-424` / `repo.rs:210-247`：
  min500 在 service 精确比较，repository 两条 SQL 原样绑定，不额外限制负值。
  默认100/0继续由 L15 handler 提供，SQL 错误沿既有 Database AppError 传播。
- `tests/insight-pagination.test.ts` 走真实公开 memory 服务、真实 L11 resources/L10 notes、F3
  迁移 SQLite；call-through spy 仅观察真正执行的分页绑定（不替换结果），防止把两个相邻大 offset
  都返回空页误当精度证明。另有普通 number/默认/负值/MIN/MAX/500及读卡错误覆盖。
- 本包不改 TESTMAP：109 ported / 57 pending / 2 approved obsolete，旧47全pending。
  最终精确tip、门禁与Electron原件由 WP-158 wp-done 报告交付，待独立验收。

## v2 接手盘点（2026-11-04，GPT-6.1 Sol）

基线 `2ee9a9cbe`（已 fast-forward main）。无独立 `ACCEPTANCE.md`，不创建或代签。
旧 `109 ported / 57 pending / 2 approved obsolete` 是历史账目，不是 v2 验收结论。

### 八类横切自查

| ID | 类型 | 结果与证据（路径均相对本目录） |
|---|---|---|
| L17-V2-01 | 1.2 单写者 | 不通过：`repository/vfs.ts:313-320,497-515,543-563` 直接写 L10 notes.tags；`repository/insight-projection.ts:13-41` 写 L16 document_tasks/anki_cards；`repository/insight.ts:41-53` 写 L15 mastery_events。不能用更新时间的 updateNote 代替 tags-only。 |
| L17-V2-02 | 1.3 serde | 不通过：`repository/vfs.ts:272-279` 把混合类型 Vec 过滤成部分成功，Rust Vec<String> 应整列失败后 default；`:475-479` JSON.parse 类型断言未解码。其他持久化结构仍须逐字段复核。 |
| L17-V2-03 | 1.4 日志/错误、1.6 分支 | 不通过：`src/service.ts:1036-1092` 对照 auto_extractor.rs:106-219，缺 profile 读取失败的 ok().flatten、空 candidates 早退、活动追加 info。不得把整体测试绿当日志齐全。 |
| L17-V2-04 | 1.7 运行时 | 不通过：`src/service.ts:1036,1081` 用墙钟测耗时；Rust audit_log.rs:272-285 的 OpTimer 使用 Instant。 |
| L17-V2-05 | 1.1 生产接线 | 57 pending 保留：`BLOCKERS.md:14-95`；main chat/api.ts 无 registry，llm/api.ts 无 memory-decision role；不以分支声明当已发布。 |
| L17-V2-06 | 1.5 测试真实性 | `tests/support.ts:91-491` 用外部 notes/repos 替身，不能证明真实所有者集成；`plugin-startup.test.ts:74-83` 只真实加载 F4 paths/log，未证明 notes/repos。既有断言不删不弱化，补真实组合测试。 |
| L17-V2-07 | 1.8 复验 | 无独立报告、无 finding 签收；所有本次修复带自查 ID，提交后请求独立复核。 |

### 命令逐项检查索引

下表为审读入口与发现，不代表完成 §2；所有命令均须补分支/边界/日志/所有权/运行时/测试证据。
普通写入的索引/维护链仍有 L02 缺口（`src/service.ts:489-509`），不得宣称完整等价。

| 命令 | 类型/待核事项 | TS 入口 |
|---|---|---|
| memory_get_config | 1.3/1.6 配置默认及根查找 | index.ts:118 |
| memory_set_root_folder | 1.6 保留名/不存在 | index.ts:120 |
| memory_create_root_folder | 1.2 真实 folders API | index.ts:122 |
| memory_get_or_create_root_folder | 1.6 同步根认领/修复 | index.ts:124 |
| memory_read | 1.3 tags 解码；缺失资源修复遗漏 | index.ts:126；repository/vfs.ts:341-349 |
| memory_write | 1.4/1.6 trim、mode、维护日志 | index.ts:128 |
| memory_list | 1.3 tags；1.6 分页/过滤 | index.ts:144 |
| memory_get_tree | 1.3/1.7 时间整数、递归 | index.ts:147 |
| memory_add_relation | 1.2/1.7 双端 OCC 事务 | index.ts:149 |
| memory_remove_relation | 1.2/1.7 双端 OCC 事务 | index.ts:155 |
| memory_get_related | 1.3 tags | index.ts:161 |
| memory_update_tags | 1.3 系统标签/OCC | index.ts:163 |
| memory_get_tags | 1.3 tags | index.ts:169 |
| memory_restore_stale | 1.2/1.6 tags/索引 | index.ts:171 |
| memory_restore_archived | 1.2/1.6 tags/索引 | index.ts:177 |
| memory_batch_delete | 1.2 incoming refs 越权；1.6 部分失败 | index.ts:183 |
| memory_batch_move | 1.6 部分失败/事件 ids | index.ts:194 |
| memory_move_to_folder | 1.7 folder/note 同事务 | index.ts:202 |
| memory_update_by_id | 1.4 审计/维护 | index.ts:208 |
| memory_delete | 1.2 incoming refs 越权 | index.ts:215 |
| memory_export_all | 1.6 500 条限制/内容读失败 | index.ts:222 |
| memory_get_profile | 1.3 类别/profile 内容 | index.ts:224 |
| memory_to_anki_document | 1.6 purpose/limit；1.7 本地日期 | index.ts:226 |
| memory_write_smart | 1.1 L02 决策未接；1.7 note+receipt 原子 | index.ts:229 |
| memory_write_batch | 1.1 同 smart；1.3 flatten 契约待核 | index.ts:241 |
| memory_set_privacy_mode | 1.3 bool；1.2 memory_config 自有 | index.ts:254 |
| memory_set_auto_create_subfolders | 1.3 bool；1.2 memory_config 自有 | index.ts:256 |
| memory_set_default_category | 1.3 原样字符串 | index.ts:258 |
| memory_set_auto_extract_frequency | 1.3/1.6 Rust trim 与拒绝顺序 | index.ts:260 |
| memory_get_audit_logs | 1.3 f32/null/i64；1.6 filters | index.ts:267 |
| memory_search | 1.2 hits 越权；1.7 L12 在途取消 | index.ts:270 |
| quick_assistant_show | 1.4/1.7 F2 平台分支未原生验 | index.ts:275 |
| quick_assistant_hide | 1.4/1.7 bounds/焦点 | index.ts:277 |
| quick_assistant_apply_enabled | 1.6/1.7 destroy/bounds | index.ts:279 |

服务：memory（service.ts:88）、memoryRetrieval（index.ts:92）、memoryConfig（:100）、
insight（:84）、masteryProfileSink（:91）、hpiasResearch（:99）。前两者受 01–06 影响；
insight 有跨所有者写入；mastery sink 用 memory VFS 库；HPIAS 真实后端仍 pending。

### 排雷顺序与验证基线

先请求 L10/L15/L16 所有者接缝（01），不复制仓储或用普通更新改变 Rust 时钟；
并行修自有 serde（02）、extract 分支/日志/单调时钟（03/04）；再补真实组合测试与逐命令 SPEC。
无独立验收未勾选 finding 可冒充关闭；新发现按上述 ID 追踪。旧 57 项不重做，真实接口到达后接入。

队列：`20261104093556-c8d297` typecheck exit 0；`20261104093559-fa213f` 全插件
233 passed / 9 timeout / Errors 3、exit 1；不计通过。仅复跑失败文件的
`20261104095427-9c6d79`（threads 单 worker）34 passed、无 Errors、exit 0。
`20261104101127-d658f7` ledger exit 0；机械账本不替代 v2。

### 自查修复进度（待独立复核，不自签关闭）

| ID | 状态 | 提交与证据 |
|---|---|---|
| X6-SW-MEM-02 | 已修待复核 | `c4c736484`（另见 WIP `fce68f61f`）：learning 造数 helper 移至 `tests/fixtures/learning-rows.ts`，`addStudySeconds` 仅测试使用已删，测试改用 L15 `addStudyTimeSeconds`；读聚合未改，原断言保留。typecheck `20261104111103-44b5be` exit 0；测试 `20261104111104-b90d0d` 16 passed exit 0。 |
| L17-V2-03 | 已修待复核 | 代码由协调者 WIP `9aa3ffa81`/`98c43f156` 提交：profile 读取失败静默置空（auto_extractor.rs:108 `ok().flatten()`）、活动追加计数 info、空 candidates 早退不写 audit、extract debug 行。新用例 `extract_and_store_memory returns before audit when only activities are extracted`；同上两个作业。 |
| L17-V2-04 | 已修待复核 | 同上提交：`performance.now()` 单调计时并截断到 ms，对应 OpTimer/Instant。 |
| L17-V2-02 | 部分修复待复核 | `parseTags` 改为整列 all-or-nothing（memory 侧 Rust 调用点均为 `from_str::<Vec<String>>().unwrap_or_default()`）；`createOrReuseTypedResource` 改为直接传类型化 `VfsResourceMetadata`，去掉 `JSON.parse as`。代码在 WIP `fadaa2b4f`。新用例 `tags column with a non-string element reads as empty, not partially filtered`；typecheck `20261104112638-45838e` exit 0，commands-core + insight-service `20261104112638-73ef66` 16 passed exit 0。未完成：Rust `note_repo.rs::row_to_note` 解析失败会 warn，memory 自有 `getNote/toNote` 不打该日志；正确做法是读取改走 L10 `notes.getNote(id, conn)`（notes/repository/notes.ts:93-95 已有同语义 warn），留待单独提交。 |
| X6-SW-MEM-01 / L17-V2-01 | 阻塞 | 等 L10/L16/L15 接缝，见 BLOCKERS.md §v2。 |
| L17-V2-08 | 已修待复核 | 新发现（L10 回复确认）：memory 自有 JOIN 读 `getNoteContent` 对缺资源返回空串，Rust `get_note_content(..)?` 报 "Missing resource for note"。改走 L10 `notes.repository.getNoteContent`；evolution 合并补 Err 分支 warn（evolution.rs:457-486）。代码在 WIP `e13a921c9`/`2105b5f0a`。新用例 `tests/note-content-owner.test.ts`（真实 notes 插件）。typecheck `20261104113545-a23cbc` exit 0；测试 `20261104113545-3a4867` 13 passed exit 0。 |
| R5-M3 | 已修待复核 | `690988159`：cacheResult 0 行→`CONFLICT(memory.idempotency.lease_lost)`（service.rs:3145-3150），新增 finalizeResult（3154-3172，含 result_mismatch），writeSmart 事务内先 renew（1151）。service-occ 测试恢复 Rust 方向（5062-5068）；新入口用例 `memory_write_smart rolls back the note when the lease is reclaimed before the receipt`。typecheck `20261104120046-156b4c` exit 0；测试 `20261104120046-2e76d5` 31 passed exit 0。 |
| R5-M6 | 已修待复核 | `e9e8997e3`：命令边界先校验“标题不能为空”/“内容不能为空”（handlers.rs:774-783），store 内部 NONE 不变。作业 `20261104121759-4290fa` 1 passed exit 0。 |
| R5-M2 / X6-SW-MEM-01（L10 部分） | 已修待复核 | `7dd81f614`：三处 notes.tags 写改走 `notes.repository.rewriteTagsWithoutTouchingUpdatedAtWithConn`（main 518e8db56），同 conn、不改 updated_at、不加事务，补 incoming-ref 成功 info。真实 notes 插件用例 `memory_delete removes incoming refs via L10 tags-only seam without touching updated_at`。作业 typecheck `20261104124846-504508`、测试 `20261104124846-e79aa5` 20 passed、single-writer `20261104124846-5f1629` 均 exit 0。L16 投影 / L15 mastery 仍待 main。 |
| R5-M7 | 已修待复核 | 即 L17-V2-08（`cc0b61878`）。 |
| R4-SYNC-05 | 已提供接口 | api.ts 重导出 `mergeProfileJsonForSync`（纯函数，Rust learner_profile.rs:551-561），测试 `tests/profile-sync-merge.test.ts` 用 sync_app_tests.rs:13-50 原向量（3/4→5、两目标都保留）；typecheck `20261104125208-192072` exit 0，测试 `20261104125208-130bf0` 2 passed exit 0。M4 词法宽容差异未修，见下。 |
| R5-M4 | 已修待复核 | `d3fb5a35d`：画像解码用 JSON.parse source access 保留数字词法，`1.0`/`1e0`/`-0`（serde f64）对 u32 version/evidence_count 拒绝；`_promotion_fingerprint` 按 as_str，非 string 视为 None 不再拒绝整份画像（learner_profile.rs:506-514）。用例 `loadProfile keeps serde number kinds and ignores a non-string promotion fingerprint`。typecheck `20261104135549-8b8786` exit 0；测试 `20261104135549-05542d` 63 passed exit 0。 |
| R5-M5 | 已修待复核 | 代码 WIP `7e99c2676`，测试 WIP `7aec2fbcb`：update/delete/write_smart 成功审计按 Rust OpTimer 起点（service.rs:1750,3323,3422）记 performance.now 毫秒，不再 0/null；FILTERED 行保持 Some(0) 并带调用方 source（log_filtered）。用例 `audit duration uses the operation timer and filtered rows keep their source`（stub performance.now）。同上作业。未覆盖：fact 决策路径的 log_error 审计，随 R5-M1。 |

### v2 排雷清单（X6 基线 2ee9a9cbe 候选，按当前 SHA 核验）

| 门禁/候选 | 当前核验 | 对应 finding/状态 |
|---|---|---|
| single-writer learning.ts:244-290 chat/exam/questions/answer/pomodoro/study_time | 已移除（生产无调用） | X6-SW-MEM-02，`c4c736484`；main 上仍可见是因为本分支未集成 |
| single-writer vfs.ts:498 notes | 已移除 | X6-SW-MEM-01/R5-M2，`7dd81f614` |
| single-writer insight-projection.ts:14/18 anki_cards/document_tasks | 仍在 | X6-SW-MEM-01，等 L16 `1598b1112` 进 main |
| single-writer insight.ts:42 mastery_events | 仍在 | X6-SW-MEM-01，等 L15 `dbf5cf87a` 进 main |
| single-writer config.ts:6 memory_config | memory 是 owner；越权写入方是 vfs-handlers attachment-config.ts:14 | 非本 lane 缺陷，已记录 |
| unchecked-decode vfs.ts:476 json-parse-assertion | 已修：改为直接传类型化 metadata | L17-V2-02，WIP `fadaa2b4f` |
| unchecked-decode learning.ts:32 / memory-utils.ts:198 / write-store.ts:294 double-assertion[info] | 人工核：分别是本地化错误类型、ctx.get 访问、tx→DatabaseHandle 覆盖，都不是持久化/外部数据解码 | 无缺陷 |
| prod-reachable（44 info） | 人工线索；纯函数多由生产入口间接调用，未逐个改测试 | 未处理，不按数量改 TESTMAP |
| assert-parity auto-extractor:33、config:50/62、hpias:83 | 未逐断言核 | 待办 |
| log-parity（26 info） | 已核并修：extract（V2-03）、incoming refs info、evolution 读错误 warn、missing resource（L10）。其余文件未逐日志核 | 待办 |

未修：R5-M1 的真实 L02 角色接线（检索/决策分派的本 lane 实现见下方增量；不再泛称无检索后端）、其余逐分支 serde/日志审计。按标题/资源读取的旧日志待办已核为 Rust 本就静默，不补假 warn；实际查询/snapshot 差异见 L17-V2-09。

#### C2 稳定 ID 映射（冻结报告 0119143715c0，源码基线 2ee9a9cbe）

| C2 ID | 对应既有条目 | 当前状态 |
|---|---|---|
| X6-SW-0010..0015（learning.ts:244-290） | X6-SW-MEM-02 | 已修 `c4c736484`，待集成与 R5 复核 |
| X6-SW-0016（vfs.ts:498 notes） | X6-SW-MEM-01 / R5-M2（L10 部分） | 已修 `7dd81f614`，待复核 |
| X6-UD-0052（vfs.ts:476） | L17-V2-02 | 已修，WIP `fadaa2b4f`，记录于 `32f418558` |
| X6-PR-0069..0071（query-rewriter） | 已 obsolete | 不复活，不处理 |
| X6-PR-0072..0112 | 排雷清单 prod-reachable 行 | 人工候选，未逐个核；不按 testIds 整文件降级 |
| X6-AP-0347..0350 | 排雷清单 assert-parity 行 | 未逐断言核；不机械补 expect |
| X6-LP-0199 | L17-V2-03 | extract 路径已修；其余 warn 未逐个核 |
| X6-LP-0204 | R5-M2 / L17-V2-08 | evolution 读内容 Err 分支 warn 已补（`cc0b61878`）；其余未核 |
| X6-LP-0207（query-rewriter） | 已 obsolete | 不处理 |
| X6-LP-0200..0203、0205、0206、0208..0224 | 排雷清单 log-parity 行 | 未按分支逐日志核 |

### R5-M1 增量（2026-11-04，待独立复核）

- fact 写入不再无条件 ADD：现有 `searchForPurpose(content,15,'internal_dedup')` 先检索；
  检索失败按 Rust warn 并置空。成功空结果再按真实 notes/index-units 聚合判定就绪，
  活跃数≥3 且索引单元=0 时 auto_extract 返回 SKIPPED，显式 ADD 后打待复核标签。
- `fact-decision.ts` 对照 service.rs:1968-2175：模型调用/解析失败 warn + 0.6 ADD，5 次失败开启
  进程级 10 分钟熔断；auto_extract 熔断时跳过，显式调用记 DECISION_UNAVAILABLE；成功关闭熔断。
  低置信度 mutation 返回 NONE（f32 阈值），不误写日志；仅实际候选 target 可被 mutation。
- ADD/UPDATE/APPEND/DELETE/NONE 分派对照 service.rs:2177-2429；异步检索与模型不持有 SQLite
  事务。await 后 renew lease；mutation+receipt 同 conn/IMMEDIATE；DELETE replacement 通过
  L10 notes / L11 embeddingUnits 正式 owner API，失败整体回滚。批量/flush/extract 调用方均 await。
- 测试：`smart-fact-decision.test.ts` 6 个生产命令/服务用例（外部 retrieval/LLM 才用替身）；
  `note-content-owner.test.ts` 真实 L10/L11 插件 DELETE replacement 的 receipt-fault 回滚/重试。
  `20261104151648-8a20cd` typecheck exit 0；`20261104152206-7d8676` exit 1（10 pass，真实
  owner fixture 错误重复插入 unit_index=0，已改用第二单元，未弱化断言）；修后
  `20261104152415-fc7298` 3 passed exit 0。首轮 `20261104151108-fd2af3` exit 1 的 3 个失败
  是测试 helper 未导出、UPDATE 后 retrieval fixture 仍指旧 resource、wire f32 预期错误，均已修。
- **未闭合**：L02 main 没有 `callMemoryDecisionRawPrompt`，非空候选时明确报缺接口，
  清理 reservation；不以通用 singleShotCompletion 冒充，不把缺接口当实际模型故障静默 ADD。
  已向 L02-llm-manager 通知；13 个既有 L02 依赖测试仍 pending，不自签 M1。
- L11 `getBreadcrumbs`：按架构新裁定，`6525dc938` 已改为可选能力，C2 确认覆盖此前
  mandatory-only 要求，不以 mandatory 作为阻塞。现有 typed fixture 保留 unused→throw，
  不倒改、不复制 owner 算法；本 lane 生产未调用此能力。未来实际消费时须先检查能力，
  缺失明确报错，禁止 SQL fallback。L15 已 parked；deck consumer77 已被 84f 撤回，
  不把新 D3/deck owner 组合作为已进 main；既有普通 seam 仍仅按下方具体实现 SHA 消费。
- L15/L16 owner seams 现已在 main；下一单元直接消费，不再等待上游发布。

### R5-M2 / X6-SW-MEM-01 后续消费（待独立复核）

- L16：消费 **main 实现 f09807bb4**（anki/repository/insight-projection.ts），三个
  tombstone/task-upsert/card-write `*WithConn`。同一 mistakes conn、同一 now 字符串，保持
  task→card SQL 顺序，不加事务；status/修订缺失仍在 L17 判定，错误由既有 worker fail/warn
  分支处理。通过 `ctx.inject(['anki'])` 获取真实 owner，未装配时明确报错。
- L15：消费 **main 实现 8f037194c**（review/src/mastery.ts），
  `recordInsightRecallVerdictWithConn(conn,insightId,sessionId,success,now:string)`；
  幂等 INSERT OR IGNORE、不 recompute、不回流 profile。未采用未入 main 的
  a0515bf75 / a47f42ded i64 新类型，不能把本次窄面消费视为其签收。
- `repository/insight-projection.ts` / `repository/insight.ts` 不再写外域表；
  原测试改用真实 anki/review 插件，原断言保留。`20261104155532-6bb2d7` typecheck exit 0，
  `20261104155532-238566` 10 passed exit 0；先前含错误契约测试的
  `20261104155025-fae71f` 14 passed exit 0。single-writer `20261104155025-51dcb9` exit 0，
  memory 唯一余项是 config.ts 的 owner 信息（vfs-handlers 写 memory_config，非本 lane 越权）。
- M1 自检记录：`20261104152747-ea7d38` 全 lane 243 passed / 17 timeout / **Errors 3**，exit 1；
  其他四项门禁通过，绝不记整轮通过。仅复跑三失败文件 `20261104154220-e74070`：38 passed、exit 0。
  按 C1 后发指令不新增全量、不抬 timeout；这些局部结果不能单独证明所有超时均为负载。

### L02 pending 范围（沿原 ID，不新增编号）

**7 条 decision 子集**：前缀 `crates/dstu-memory/src/memory/llm_decision.rs::tests::`，名称是
`test_memory_event_serde`、`test_extract_and_parse_clean_json`、`test_extract_json_from_surrounding_text`、
`test_extract_json_with_think_tag`、`test_extract_json_markdown_with_text_before`、
`test_extract_json_returns_none_for_no_json`、`test_memory_event_from_str`。

**13 条 L02 总集 = 上述 7 + semantic_dedup 的 6**；后六前缀
`crates/dstu-memory/src/memory/semantic_dedup.rs::tests::`，名称是
`test_parse_dedup_response_merge`、`test_parse_dedup_response_keep_with_noise`、
`test_parse_dedup_response_invalid_action`、`test_validate_merge_decision_guards`、
`test_extract_tag_count_max_merge`、`test_build_dedup_prompt_contains_both_notes`。
两范围均保持 TESTMAP pending；query_rewriter 的两条 obsolete 不在 13 条内。

### 精确 X6 交接增量（main 8d7b05d14 报告，沿 C2 固定 ID）

- **X6-PR-0103**（本次唯一精确 unreachable）：`hpias-service.ts::startFromIntent` 的真实生产
  intent 判定现调用 `shouldStartResearchSession`，替换原等价内联 `intentHasResearchBlocks`，
  不引入多余调用/新行为。原 `spawn_from_intent_skips_non_research_intent` 保留所有断言，
  并新增从真实 `ctx.hpiasResearch.startFromIntent` 验证 text intent 无事件、research intent
  发 round_started。`20261104155734-fe576f` 37 passed exit 0，ledger
  `20261104155734-f61cf9` exit 0；TESTMAP 不批量降级、不误伤 query_rewriter 或其他 pure 用例。
- **X6-AP-0347**：auto-extractor.test.ts 的完整 `toEqual({candidates:[],activities:[]})`
  同时覆盖 auto_extractor.rs:529 的两个空数组断言，计数差不是缺断言。
- **X6-AP-0348**：config.test.ts:51-54 的 7 key 循环 + 后续 6 default 断言，恰好覆盖
  config.rs:553-587 的 13 条，未补重复 expect。
- **X6-AP-0349**：Rust 12 条中多出 `Off.as_str()=="off"`；TS `AutoExtractFrequency` 本身是
  wire string union，没有另一个 formatter，`frequencyFromStrLossy('off') == 'off'` 同时检查
  Rust 的 Off 选择和 wire 文本。其余 11 项逐值/方向对应 config.rs:592-622，无新增数据拒绝。
- **X6-AP-0350**：hpias.test.ts:87-89 五个 lifecycle 值逐个循环 `toContain`，覆盖
  payloads.rs:391-395 的五条 assert；已用 's1'/'Q?'/null 原向量，不改原值、不凑数量。
- query_rewriter 仍沿 C1 两项精确 obsolete；PR0069–71 不扩展到无关 ported 用例。

### L17-V2-02 getNote owner 增量（待独立复核）

`repository/vfs.ts::getNote` 及 13 个生产调用点改用 `notes.repository.getNote(id,conn)`：
保留调用方事务 executor，直接复用 L10 的 Vec<String> 整列失败与
`[VFS::NoteRepo] Failed to parse tags JSON for note …` warn，null→undefined 仅适配内部返回类型。
未改所有者代码，未另拷贝 decoder 或新增 SQL。测试替身的 tags 解码同步为真实 owner 的
all-or-nothing；真实性由 `note-content-owner.test.ts` 的真实 notes 插件用例验证。

`20261104160215-f51eee` typecheck exit 0；`20261104160215-d836e8` boundaries exit 0、0 violation。
`20261104160215-2455ba` 22 passed / 1 failed、exit 1：新 warning 断言监听了 F4 `ctx.log`，
L10 实际绑定 Cordis `ctx.logger('notes')`。现已把测试 observer 改为真实 logger exporter
并开启 warning level；原 decoder/warn 断言保留。修后 `20261104160646-c46993`：1 passed、
3 skipped（仅选新用例）、exit 0；`20261104160646-f3c2e2` typecheck exit 0。
不因本次 getNote 修复宣称全体 serde/日志自查结束：按 title/resource 的本地行解码仍需后续核查。

### main-red（main 677f6727c / fulltest 2026-11-04T16:25Z）

- 原失败：l13-ports 的 short-compress（38.98s）、mastery-sink 的 upsert/remove（33.61s）。
  JSON 报告是 `STACK_TRACE_ERROR` 的 Vitest 测试创建栈；runner 的 withTimeout/makeTimeoutError
  采用该栈，未见 owner 接口不匹配或原业务 expect 的断言差异。不能把这些结果外推为所有超时归因。
- fixture 中每次 setupMemoryHost 都真实迁移四核心库，即使 short-compress 不读库也重复执行。
  改为每文件/worker 一次真实 runAll，关闭 seed SQLite 后复制独立 data directory；不共享
  可变库/host，不删迁移、不用手写 schema。两个红灯文件在 beforeAll 预备 schema，hook/test
  均沿默认 timeout，未提高任何超时。原生产入口与全部原断言保留。
- 新 `host-fixture-isolation.test.ts` 验证四库迁移版本与多 host 数据/配置隔离，后续 clone
  也不含其他 host 写入。`20261104164000-1ea5f3`：16 passed、无 Errors、exit 0；
  mastery 主用例 466ms；`20261104164000-f7a04c` typecheck exit 0。待官方 lane-gate。
- 此前正式 §5 已在 ce7c88d3f / main 677f6727c 达到 5/5，通过回执独立保留；旧
  `20261104152747-ea7d38` 的 243 pass / 17 timeout / Errors 3 / exit 1 永不改写。
- L17-V2-09 普通 `.ok()` 查询与系统 CAS JOIN snapshot 的在途修改因 main-red 中断，
  已用 `263bdb06f`（及协调者 checkpoint）保存；专门故障测试尚未补，不自签该项完成。

### L17-V2-09：区分 optional 查询与 CAS snapshot（2026-11-04，待复核）

- 纠正旧日志待办：service.rs:3194/3227/3260 都是 `Vec<String>::unwrap_or_default()`，
  并不经过 NoteRepo 的 warn decoder；按 title/resource 读不应补告警或强行二次调用 owner。
- 普通 `find_note_by_title` / `get_note_by_resource_id` 的 `query_row(..).ok()`
  （service.rs:3181-3208、3251-3274）把查询/行错误视为 None。TS 这两处现在同样静默返回
  undefined；获取 executor 的调用仍在 helper 外，不伪造连接成功。
- 画像/日志不同：daily_log.rs:100-127、learner_profile.rs:658-685 使用
  `optional().map_err(..)`，单条 notes/folder_items/resources JOIN 同时取 CAS token 与正文，
  错误传播、JOIN 缺资源为 None。原 TS 两次查询（先 note 再 getNoteContent）可能混读
  version/content，并将该处 missing JOIN 误变成一般笔记的 Missing resource 错误。
  新 `findSystemNoteSnapshot` 按原一条 SELECT；仅 profile/daily store 使用，普通
  `memory_read` 仍走 L10 并保留其缺资源错误，不能互相替代。
- `optional-note-reads.test.ts` 走真实 memory_search/服务入口，用真实 SQLite 表暂时改名
  制造 SQL 错误：普通查询不报错、严格 snapshot 必须抛错；另测两类 snapshot 缺 JOIN
  资源返回 null。原 CAS 重试/画像断言未修改。`20261104165458-55a6b4` 15 passed、
  无 Errors、exit 0；`20261104165458-9ae764` typecheck exit 0。
- 当前正式门禁仍被 L10/F3 retention Slot 生命周期阻塞：`20261104164359-2a1224`
  259 passed / 3 SlotOccupied failed、exit 1。已向架构/L10/F3 上报（见 BLOCKERS.md），
  不 reset Slot/模块、不删真实-owner 用例绕过。

### Linux 续作：四个门禁失败与 F1 元数据请求（2026-11-05）

- `43469fdc5` 合并 main，无冲突，继承的 BLOCKERS 未提交说明保留并核查。
  L10 scoped retention 修复已在主线；真实 owner 四例通过，不再以 Slot 故障阻塞。
- 复现四个文件均在重复 schema 预热 `beforeAll` 处超时（默认 hook 10 秒），用例未执行：
  `20261105000321-603c5a`：4 failed suites / 20 skipped / exit 1。
  改用已有 `setupMemoryHost` 惰性迁移缓存，仍真实 runAll、关闭模板后逐 host 独立复制；
  未改断言、timeout、schema 或测试选择。`20261105000459-d06815`：41 files / 266 passed，
  无 Errors、exit 0；`20261105000322-f3fa8c` typecheck exit 0；strict
  `20261105000459-e33670` 0 violation / exit 0；ledger `20261105000459-d1805e` exit 0。
- F1 续派允许提供等价 metadata 服务。本次公开 `createMemoryToolMetadata()` 与
  `ctx.memoryToolMetadata`，生产 index 复用原解析模块策略并将相同对象登记到 agentTools。
  不提供假的 execute，不将 metadata-only 误称为可执行完整 roster。35 条按 F1 指令仍 pending；
  自有工具执行体未完成不能再归为“L04 registry 未发布”。精确缺口见 BLOCKERS。
- metadata 专项 `20261105002240-c10a4b`：2 files / 21 passed / exit 0；
  最新全 lane `20261105002450-4cdae8`：42 files / 269 passed，无 Errors、exit 0。
  metadata 与四个 hook 修复均已由协调者自动检查点保存（`ae5f891dd` / `202590a68`），
  不把工作区 diff 为空误当成丢失。
- Electron 原生运行时复验四个反馈文件：`20261105001959-78dcc0`，4 files / 20 passed，
  无 Errors、exit 0；正式自检仍需记录最新静态检查结果。

### 后续集成反馈：跨 fork 迁移模板复用（2026-11-05）

- 新反馈的 17 项清单与旧日志相同，gate-fail 仍指 `43469fdc5`，但不能据此忽略本轮实测：
  合并 main 后 `20261105004630-3c0af8` 为 **265 passed / 4 timed out / Errors 1 / exit 1**。
  四个 30 秒超时是 idempotency-atomicity、insight-adaptive、memory-executor、tool-metadata；
  Errors 为 `Timeout calling onTaskUpdate`。本轮不计通过，不把失败外推为业务断言错误。
- Vitest 3.2 forks 默认 `isolateWorkers=true`，每文件一个独立进程（forks pool 的
  `coverage.DfSpMS-b.js:2627,2680`）。单文件/worker Promise 无法避免下一文件重跑 runAll；
  config/jobs/真实 owner fixture 此前还逐用例运行整套迁移。只把缓存提升到 Node process 也不够。
- 统一使用 `tests/fixtures/migrated-schema.ts`：真实 runAll 成功、所有 SQLite 句柄关闭且 WAL
  checkpoint 后才原子发布空 schema。各 fork 只复用该不可变种子，每个 host 仍复制到独立目录并
  构造独立 storage/Host；真实 notes/review/anki 生命周期不改，不 reset Slot/模块逃错。
- 内容摘要在这里实际替代昂贵迁移：SQL、F3 storage 源码、依赖锁、fixture 发布代码或工作树根
  改变就使用新种子；只缓存空迁移结果，不缓存用例数据，不共享可写库。生成缓存保存在 OS 临时
  目录，允许同一输入的后续测试复用；各 host 的可变副本仍按原 afterEach/finally 清理。
- 新用例先写于实现前：独立 ESM 求值共享 Promise、另一个真实 Node/Electron 子进程复用同一
  已完成种子、四个迁移版本与数据库写入隔离。原 Rust 用例标题、期望值、断言数量/方向以及
  testTimeout/hookTimeout 均未改变；原迁移成功断言读取真实 runAll 的缓存报告，未删除。
- 早期 fixture 专项 `20261105005820-b1b8d4`（7 files / 17 passed / exit 0）与 typecheck
  `20261105005820-4a31aa`（exit 0）属于中途版本，不代替最终跨 fork 实现的整 lane 自检。
- 最终跨 fork 版本 `20261105010419-0f5587`：**43 files / 270 passed / 无 Errors / exit 0**，
  用时 105.67 秒（先前失败运行 444.11 秒）。四个新超时用例本次约 1–2 秒完成；原失败结果保留。
  Electron `20261105010420-282fef`：9 files / 28 passed / 无 Errors / exit 0，含真实 child-process
  cache 回归与真实 notes owner 四例；strict `20261105010420-8f3063`：0 violation / exit 0。

### WP-016：13 条逐证核验（2026-11-05，待 C2 独立抽检）

结论：部分完成；核验 13 条，保留 6 条已映射项、纠正 7 条无生产调用的映射，新增闭合 0 条。

#### 起点与计数（不重复认领）

- 起点工作区干净；仅在本 worktree 合并 main `967f43c7547d1ed29a7e3d736b8118fb95d3661e`，
  得到 `b3b135eadae79c37bf92022fc7c5eca695838dc3`。没有运行 Rust、安装依赖或更改实现/测试。
- 实际历史与 brief 的“已交付 11 条”不同：旧检查点 `a80ba453c9bccb022a7d6e993f36c3cddcd4a1c7`
  仅改 TESTMAP，一次映射 47 行。合并后与 main 的 memory 差异也仅该文件；本包 13 行已全部 ported，
  没有可新增认领的 pending。未找到这 47 行的逐条已验收证据，不将检查点当签收。
- main 行计数 109 ported / 57 pending / 2 obsolete；合并后分支 154 ported / 2 merged / 10 pending /
  2 obsolete；本包后 147 ported / 2 merged / 17 pending / 2 obsolete。本包子集 pending **0 → 7**，
  相对 main 是 **13 → 7**，但六条已映射项不重复计为本包新增。
- 另外 36 条继承映射不在本包，未更改、不签收（包括 HPIAS request），请 C1/C2 分开审查旧检查点，
  不将整分支 47 条计作 WP-016 完成。embedding frozen12 属 L01，不在本包。

#### 生产路径与真实缺口

路径均相对 `host/plugins/memory/`（显式写出其他插件的除外）。

- **P1（已有 main 生产静态路径）**：`index.ts:239-246` 注册 `memory_write_smart` →
  `src/service.ts:838-843` 的 `writeSmart` → `src/write-store.ts:314,403` 调 `planFactWrite` →
  `src/fact-decision.ts:107` 调 `parseDecisionResponse` → `src/llm-decision.ts:57` 调
  `src/json.ts:84` 的 `extractFirstJsonObject`。因此六条解析/提取用例测的是生产使用的同一函数，
  不是测试副本。实际模型角色仍缺，不能把静态可达/纯函数通过外推成 live LLM 端到端已完成。
- **P2（无调用）**：`src/llm-decision.ts:7` 的 `memoryEventFromStr` 只被测试导入和调用。
  `decodeDecision` 的 enum 校验是 `:38-39` 的字符串表，并未调用这个 helper；不得人为插入无用调用。
- **P3（无调用）**：`src/semantic-dedup.ts` 的四个被测函数只被
  `tests/evolution-profile.test.ts:15-18` 导入，生产没有 import/调用；
  `src/service.ts:525-526` 对 semantic pass 仅 warn 后跳过。Rust `semantic_dedup.rs:334-365,378-381`
  有真实 prompt/parser/guards/counter 调用，TS 没有对应 pass。六条虽测实际纯模块，仍全部 pending。
- L02 main `host/plugins/llm/api.ts` 与实现无 `callMemoryDecisionRawPrompt`；本 lane 需求签名是
  `callMemoryDecisionRawPrompt(prompt: string, signal?: AbortSignal): Promise<{ assistantMessage: string }>`，
  路由 memory_decision_model→model2、force_json=true、Memory/memory_decision，见 `api.ts:104-114`。
  本 lane 的 `src/service.ts:853-862` 明确报缺接口。semantic pass 接线及 P2 是自有未完成工作，
  不全归因上游；本包只核映射，不新迁移 pass 或为 helper 制造生产调用。

#### 逐条原测试全文与 TS 用例对照

完整 Rust id = 下列前缀 + 表内测试名（TS 用例名与表内测试名完全一致）：

- **D** = `crates/dstu-memory/src/memory/llm_decision.rs::tests::`；Rust 文件 =
  `src-tauri/crates/dstu-memory/src/memory/llm_decision.rs`。
- **S** = `crates/dstu-memory/src/memory/semantic_dedup.rs::tests::`；Rust 文件 =
  `src-tauri/crates/dstu-memory/src/memory/semantic_dedup.rs`。
- **TD** = `host/plugins/memory/tests/llm-decision.test.ts`；
  **TS** = `host/plugins/memory/tests/evolution-profile.test.ts`。

已逐条读 Rust 函数全体（D:284–344、S:696–800）及 TS 全体；下表列原 Rust assert → TS expect，
不是按同名批量匹配。纯单元原测试没有模型失败/数据库副作用断言，不虚构相应覆盖。

| Rust id / 文件:行 | TS 文件:行 / 同名用例 | 断言、边界、失败路径对应 | 结论/调用证据 |
|---|---|---|---|
| D `test_memory_event_serde` D:284–289 | TD:8–13 | 原 JSON `ADD/0.9/test` 进实际 parseDecisionResponse；event=ADD、confidence=0.9 两条对应 TD:10–11，额外 target=null；非直接断言字面量。f32 wire 由 src/f32.ts:6 还原短小数；原测试无非法输入断言。 | 保留已有 ported，P1 |
| D `test_extract_and_parse_clean_json` D:292–297 | TD:14–17 | 原样 JSON，经真实 extractor 后 JSON.parse，event=ADD 对应 Rust extract+serde 后的唯一 event 断言。不是只测 JSON.parse；此用例不单独证明完整 serde 字段拒绝规则。 | 保留已有 ported，P1 |
| D `test_extract_json_from_surrounding_text` D:300–307 | TD:18–21 | 相同中文前后杂讯、换行、ADD/0.9/新信息；断言精确提取整段 JSON 文本，不仅检查非空。 | 保留已有 ported，P1 |
| D `test_extract_json_with_think_tag` D:310–317 | TD:22–25 | 相同 think 标签前文与 ADD/0.95/全新；精确 JSON 相等。原用例未测括号位于字符串内，不扩称覆盖。 | 保留已有 ported，P1 |
| D `test_extract_json_markdown_with_text_before` D:320–327 | TD:26–29 | 相同中文前文、json fence、UPDATE/note_abc；精确 JSON 文本断言；不增补原测试没有的 confidence 字段。 | 保留已有 ported，P1 |
| D `test_extract_json_returns_none_for_no_json` D:330–332 | TD:30–32 | 相同 `no json here`；Rust None 对 TS null，唯一失败路径断言完整对应。 | 保留已有 ported，P1 |
| D `test_memory_event_from_str` D:335–343 | TD:33–41 | 七条同向同值：ADD、update→UPDATE、APPEND、DELETE、delete→DELETE、none→NONE、invalid→NONE；原断言无差异，但函数没有生产消费者。 | ported→pending，P2 |
| S `test_parse_dedup_response_merge` S:696–703 | TS:338–346 | 相同 fence 与合并内容；unwrap 对 TS 非空检查，action=merge、keep_note_id=n1 两条同值。 | ported→pending，P3 |
| S `test_parse_dedup_response_keep_with_noise` S:706–711 | TS:348–353 | 相同中文杂讯与 keep JSON；unwrap 对非空，action=keep、缺 ID 为 None/null 两条对应。 | ported→pending，P3 |
| S `test_parse_dedup_response_invalid_action` S:714–717 | TS:355–358 | delete 非法 action、`没有 JSON` 两个失败向量均 null/None，不删断言。 | ported→pending，P3 |
| S `test_validate_merge_decision_guards` S:720–765 | TS:360–378 | n1/n2 输入；成功精确 tuple `[n1,合并后内容]`；n999 拒绝；201 个“长”在200上限拒绝；三个空格拒绝；keep+null 不产参数。5条对应，字面量仅作输入，不是被测结果，但 helper 未接线。 | ported→pending，P3 |
| S `test_extract_tag_count_max_merge` S:768–786 | TS:380–388 | 同 tags `_hits:3/_used:2/_type:fact` 与 `_hits:7`；真实 extractor 的 max 分别=7、2，空 tags=0；不是只断言 Math.max 常量，但生产未调用 extractor。 | ported→pending，P3 |
| S `test_build_dedup_prompt_contains_both_notes` S:789–799 | TS:390–400 | 原 n1/n2 标题及内容A/B、上限200；实际 builder 输出包含两个ID、两个正文、`不超过 200 字`、完整 action 选项，共6条。输入只保留 Rust builder 读取的 id/title，不是测试自造 prompt。 | ported→pending，P3 |

#### 旧阻塞纠正与交接

- main 已提供 `hpiasResearch`（本插件 `index.ts:109`），且 L13 已在
  `host/plugins/vfs/index.ts:219-220` 注册真实消费者；“仅在 L13 分支”撤回。
- main `api.ts:60` 重导出 `mergeProfileJsonForSync`（`src/learner-profile.ts:510`），
  该提供方接口已存在，不重新派发、不重新计数。HPIAS retrieval/backend/request 不在本包验收。
- 供 C2 抽检：D `test_memory_event_serde`（P1 与 f32/serde 断言），S
  `test_validate_merge_decision_guards`（五条边界虽齐，仍无生产调用）；至少抽1条，若按13条核验量抽检则抽2条。
  本 lane 不代签独立复核；由 wp-done 通知 C1/C2 后验收。

#### 验证原件

- 起点类型检查：job `20261105140608-83edd7`，`npm run typecheck:host`，exit 0。
- 本包两个候选文件：job `20261105140609-52a2f1`，exit 0；
  `Test Files 2 passed (2)` / `Tests 40 passed (40)`；failed 0 / skipped 0，无 Errors。
  其中 llm-decision 9 条、evolution-profile 31 条；通过不改变七条生产不可达的 pending 结论。
- 最终精确 tip、自检各 job 与 exit 由 `coord.mjs wp-done WP-016` 交付报告记录；
  不用后改本文件的提交冒充已自检的 tip。
