# L12-vfs-index：索引与检索

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L12-vfs-index（索引与检索） |
| 目录 | `host/plugins/vfs-index/` |
| Rust 范围（lanes.md） | indexing、embedding、lance 存储、unified_retriever、retrieval_planner、multimodal、pdf_processing |
| 主要提供 | `lanceEngine`、`retrieval`、`vfsIndex` |
| 主要消费 | F7 lance/pdfium、L02 |
| 特别注意 | 分块边界、向量维度表、检索打分顺序 |
| 规模（本目录） | 25671 行 · 9 个文件 · 3 个命令（前端调用 2） · 79 个测试 |
| 规模（整条 lane，inventory） | 25671 行 · 9 个文件 · 3 个命令（前端 2） · 79 个测试 |
| 契约 | [`contracts/ipc/L12-vfs-index.json`](../../../contracts/ipc/L12-vfs-index.json) |
| 服务草稿 | [`contracts/services/DRAFT-L12-vfs-index.md`](../../../contracts/services/DRAFT-L12-vfs-index.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-vfs/src/lance_vector_store.rs` | 4784 | 3 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/embedding_service.rs` | 713 | 2 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/indexing.rs` | 5402 | 8 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/lance_store.rs` | 3303 | 9 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/lance_store_stub.rs` | 328 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/multimodal_service.rs` | 1829 | 5 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs` | 4537 | 12 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/retrieval_planner.rs` | 1587 | 17 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/unified_retriever.rs` | 3188 | 23 |  |

另有命令定义在其他 lane 拥有的文件里（按命令名分派）：`src-tauri/src/commands.rs`——只迁移下表列出的命令。

### 命令（3）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `clear_message_embeddings` | `src/commands.rs:2012` | async | app | src/utils/testApi.ts:67 | (messageIds: string[]) → null ! AppError |
| `optimize_chat_embeddings_table` | `src/commands.rs:2088` | async | none | — | (olderThanDays?: integer(u64) \| null, deleteUnverified?: boolean \| null, force?: boolean \| null) → null ! AppError |
| `optimize_lance_database` | `src/commands.rs:6898` | async | app | src/utils/systemApi.ts:150 | (parallelism?: integer(usize) \| null, force?: boolean \| null) → Value ! AppError |

### 发出的事件（7）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `media-processing-completed` | 字面量 | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:1108 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3229 (emit) |
| `media-processing-error` | 字面量 | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:826 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3270 (emit) |
| `media-processing-progress` | 字面量 | crates/dstu-vfs/src/vfs/indexing.rs:3825 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:931 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3188 (emit) |
| `pdf-processing-completed` | 字面量 | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3238 (emit) |
| `pdf-processing-error` | 字面量 | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:837 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3279 (emit) |
| `pdf-processing-progress` | 字面量 | crates/dstu-vfs/src/vfs/indexing.rs:3826 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3197 (emit) |
| `vfs-index-progress` | 字面量 | crates/dstu-vfs/src/vfs/indexing.rs:3562 (emit)<br>crates/dstu-vfs/src/vfs/indexing.rs:3683 (emit)<br>crates/dstu-vfs/src/vfs/indexing.rs:3729 (emit)<br>crates/dstu-vfs/src/vfs/indexing.rs:3837 (emit) |

### 契约中的事件（7，`contracts/ipc/L12-vfs-index.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `media-processing-completed` | 否 | MediaProcessingCompletedEvent \| MediaTranscriptionCompletedEvent | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:1108 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3229 (emit) |
| `media-processing-error` | 否 | MediaProcessingErrorEvent | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:826 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3270 (emit) |
| `media-processing-progress` | 否 | MediaProcessingProgressEvent \| MediaTranscriptionProgressEvent | crates/dstu-vfs/src/vfs/indexing.rs:3825 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:931 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3188 (emit) |
| `pdf-processing-completed` | 否 | MediaProcessingCompletedEvent | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3238 (emit) |
| `pdf-processing-error` | 否 | MediaProcessingErrorEvent | crates/dstu-vfs/src/vfs/pdf_processing_service.rs:837 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3279 (emit) |
| `pdf-processing-progress` | 否 | MediaProcessingProgressEvent | crates/dstu-vfs/src/vfs/indexing.rs:3826 (emit)<br>crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3197 (emit) |
| `vfs-index-progress` | 否 | object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object \| object | crates/dstu-vfs/src/vfs/indexing.rs:3562 (emit)<br>crates/dstu-vfs/src/vfs/indexing.rs:3683 (emit)<br>crates/dstu-vfs/src/vfs/indexing.rs:3729 (emit)<br>crates/dstu-vfs/src/vfs/indexing.rs:3837 (emit) |
<!-- END GENERATED:lane -->

## 备注

## WP-264 · mistakes.db rag_documents/rag_document_chunks 建表时机（2026-11-06）

X7 G2 `chat.stream.success.answer`：B 的 mistakes.db 在 `before` 快照里已经有这两张表（A1 的 before/after 都没有），
所以表是在 Host 启动时建的，与聊天步骤无关。Rust 侧唯一建表点是 `LanceVectorStore::new`
（lance_vector_store.rs:644-653 → ensure_base_rag_schema :2898-3038），库为 `Database`=mistakes.db
（lib.rs:3493-3494，file_manager.rs:222-225）。仍在用的调用点只有：启动 6 s 后的维护任务
（lib.rs:1646-1655）、clear_message_embeddings（commands.rs:2069）、optimize_chat_embeddings_table
（commands.rs:2096）。cleanup_orphan_chat_embeddings（:3788）和 auto_migrate_if_needed（:3641）没有调用方，
流式对话不会走到这里。B 的建表点是 `index.ts` 在 inject(['vector']) 时调
`LegacyKbStore.create`（→ legacy-kb-store.ts:94 → chat-lance.ts:11）。现改为首次读取 `vfsIndex.legacyKb`
时才构造，表结构不变。`tests/rag-schema-timing.test.ts` 先在旧代码上失败（作业 `20261106043139-80bc21`），
修复后通过（`20261106044700-eda5ff`）。没有迁移 lib.rs:1646-1655 的启动维护，所以 Rust 在 T+6 s
会建这两张表，B 不会；这里涉及 optimize_kb_tables 的 Lance 行为，不在本包范围，已写入报告。
## WP-222 · D33 AttachmentPreview 消费（2026-11-05）

开工从 `24f0db313` 正常 fast-forward 至已含219的 main `029292123`；公开 L01
`api.ts:81` 文本 parser、AttachmentPreview bigint 类型及 JsonSyntaxError cause 已核实。
`src/multimodal-service.ts` 现在直接传原 preview_json，按 None 过滤 blob、按 None 默认
MIME，精确 usize→i32；错误只取原 cause.message，加 Rust 前缀并保结构化 cause。
不再把 D33 说成 L01 未提供。实现/先行测试由自动检查点 `38ec775d5` 保存。

真实公开 by-source 回归复用 `lance-store.test.ts` 既有向量叶边界与外部 embedding
输入，L12 parser消费/转换/索引/Lance store、L11资源/files/Unit/Segment均为生产路径。
11项新增测试含最小snake、完整camel、nullable、两种sequence、2^53相邻/usizeMAX、
None/空blob、空MIME、11组原错误/位置/零写和image fallback日志。原测试/断言/预算未改。

- 基线 typecheck `20261105234959-c7649b` exit0；原multimodal-index
  `20261105234959-31e916` 4 passed/0 failed/0 skipped/Errors0。
- 修前 `20261105235321-935eff` exit1，10 failed/16名称过滤：8项旧parser拒绝，
  另2项为新增测试误写media_type，已按实际MultimodalInput.mediaType更正，不当业务反证。
- 修后初轮 Node `20261105235431-72b878` / Electron `20261105235431-4c7c5b`
  均41 passed/2 failed/0 skipped/Errors0。两个新增预期已对照Rust纠正：
  end_seq先吃逗号再peek，`?`实际第20列；usizeMAX用独立新资源保完整[-1]断言，
  不把原Rust :799-820仅清本轮Unit旧代误当“立即删除所有旧页同维度向量”。
- 仅修改后的lance-store再验：Node `20261105235614-7ab15d` / Electron
  `20261105235614-6df731` 均27 passed/0 failed/0 skipped/Errors0/exit0；未变的
  multimodal-index 4例、PdfPreviewJson 13例在上轮两runtime均passed，未重复投递。
- strict `20261105235614-c6c941`：3147 files/0 violations/exit0；importable
  `20261105235614-e27971` ok/exit0；wiring `20261105235614-804308` ported77/未接入0。

随后正常 merge main `01dd0a0c8`，其相对029仅四个S0协调文档/派发脚本，无业务变更。
最终typecheck/精确tip/base/直接官方lane-gate原件在WP-222报告；两foreign账本保留给C2。
TESTMAP前后77 ported/2 approved obsolete/0 merged/0 pending，文件及去向未改。
本包只关闭D33消费候选；009全域独验、其它多模态输送/所有权差异不升级。

## WP-219 · embedding-owner-errors 新组合收口（2026-11-05 23:24Z）

原正式 tip `53e40d3e5` 的官方2240组合被拒，只有失败文件名摘要；不能沿用 WP-202
Node308/Electron67 作为该组合通过证据。正常 merge 固定 main `df2cd30a1` 后为
`bc0a0b9e5`。修前唯一 job `20261105232019-f83490` exit1、1 failed suite、3 skipped：
旧测试 root `embedding@1` 与新 L02 `index.ts:146` 重复 provide。C2 已结束的
`20261105231336-8c00a8` 独立组合原件同错；两者均不是官方2240缺失的原始栈。

窄修仅 `tests/embedding-owner-errors.test.ts`：移除旧 embedding 替身/getApiConfigs spy，
安装真实 F3 usage、F4 secrets/settings，L02 公开 saveApiConfigurations 建立配置，真实
本地 HTTP 完成批次。同步 progress 后由 F4 恢复 L02 生成的空 model_profiles 字符串，
实际 L02 重读产生原完整错误；保留三原前缀、两个零 Segment 断言与全部超时预算，
补请求、progress、L02 成功日志与模型确已消失断言。没有改生产实现。

Node `20261105232258-3bd9fe`、Electron `20261105232338-4596c5` 均3 passed/0 failed/
0 skipped/Errors0/exit0；typecheck `20261105232259-f49720` exit0。正式 gate 在
`ee049be92` 提交并正常 merge main 后直接执行，仍仅 foreign 账本前置exit2/无子job，
完整原件见 `WP-219.report.md`。
TESTMAP 77 ported/2 approved obsolete/0 merged/0 pending 不变；
WP-202 仍须 C2 新 tip 清洁组合门禁，009 全域仍 pending independent acceptance。
WP-202/205/192 的 OCR 与媒体改动全部继承，本包没有重做这些单元。

## WP-202 · OCR 恢复 SQL 时间与原错误（2026-11-05）

开工正常 merge main：`51651c5d8`，base `be646f2522f1028ae6e6553f5afeb201b05e76c4`。
已亲核 main `api.ts` 重导 PdfResourceOwner，`resources.ts:432-437` 是真实专用实现。
`updateResourceOcrTextRow` 现直接调用公开 `saveOcrTextWithSqlTimestampWithConn`，
同连接/resource id/原文本传入；原 WARN/best-effort 编排保留，无本地 SQL 或错误去前缀补丁。

基线两文件 `20261105220955-4f1195`：48 passed/exit0。先行真实反证
`20261105221154-4f29a4`：4 failed/5 passed/exit1，命中毫秒时间及 `Database error:`；
修后同集 `20261105221240-8aa0fe`：9 passed/exit0，无 Errors/Unhandled。
新增公开 indexing→recovery→真实 L11/F3 成功/失败两例，TEMP trigger RAISE(ABORT)
验证 WARN 原 resource id/原文、ready_modes、completed 与成功返回；真实事务另验连接
局部 TEMP 观察器、SQL 时刻、主连接隔离、调用方回滚与缺行 no-op，通用毫秒入口仍保留。
原 OCR recovery 失败用例改真实 trigger 驱动，原断言不变；取消/旧代/205 N1 未改。

TESTMAP 去向仍77 ported/2 approved obsolete/0 merged/0 pending，009 仍 pending
independent acceptance。最终 Node/Electron/gate 及 foreign 账本前置原件见 WP-202 报告。

实现提交 `58131269f`；Node全lane `20261105221427-4a798c` 为33文件308 passed，
Electron五文件 `20261105221427-88b12b` 为67 passed，均exit0/无Errors/Unhandled。
同树官方 typecheck 命令 `20261105221427-c163ab` exit0；普通boundaries、changed-strict、
importable、全lane tests 的分项亦exit0。正式绝对 lane-gate 已直接执行，仍仅两份
foreign migration账本前置exit2，未分配子job；分项通过不冒称完整gate通过。

## WP-205 · 消费 WP-204 修 N1（2026-11-05）

开工 `6f548a302` 正常 merge main；`a3bcecd4e` 第二父 `ac734a62b`，公开
`media/api.ts:11` 是生产同一 MediaError 的 re-export。N1 的错误面依赖解除。
基线 jobs `20261105205002-372e5a` typecheck exit0、`20261105205002-40e18f`
三文件24 passed/exit0。先行真实 L18 回归 `20261105205427-c8ce19` 为6 failed/1 passed，
无 Errors；配置/ASR payload、last stage、取消 INFO 的缺失已实测，未知 SQLite 外层通过。

实现只在 pdf-runtime/pdf-service：保最后 consumed stage，仅捕获公开 MediaError，
cancelled INFO/Ok，普通 WARN display→同代 setError 原 payload/from_str→原 stage 错误
事件→Ok；二次写失败仍 ERROR。原192/N2/N3/PDF外层/取消/drain/旧代/u64断言保留。
真实 provider 与 HTTP401/SQLite trigger 的日志、事件、DB、返回逐项 RAW 保存在 jobs。
检查回执、提交及正式 foreign gate 归属以 WP-205.report.md 为准；不扩旧全域任务。

收尾回执：实现已由 `1d9fb9beb` 自动保存，`5836a0540` 标记 finding 并修测试类型读取，
原 version=1 断言不变。Node `20261105205822-7c64f8` 32文件305 passed、Electron
`20261105205822-2eab3e` 两文件16 passed，均exit0/无Errors；含七条真实 L18 失败回归、
原192七例及两条 from_str 契约补充。最终typecheck `20261105210108-25f4ea` exit0。
正式gate直接执行仍原foreign账本前置exit2；分项原件与完整原文见本包报告。

## WP-192 · R3 N1–N3（2026-11-06，新会话）

N2/N3 候选 `246bf15d1`：重复启动保 fetch_add/u64 回绕并补 Rust WARN；set_error
日志 stage 用 Debug 变体名。`01ec081c0` 自动检查点保存先行测试/分支表与依赖请求。
PDF 外层测试改用真实 PDF runtime + L11 最终状态写失败，保二次 ERROR 断言并覆盖两种
错误事件；不再用音频 fixture 证明 PDF 外层。取消/drain/旧代/u64 原断言保留。

基线 jobs `20261105200531-3d3ef8` typecheck exit0、`20261105200531-530165`
三文件22 passed exit0；新增反证 `20261105200718-01fdea` 两失败精确命中 N2/N3，
其余5通过、无 Errors。修后 Node 全 lane `20261105201128-89b456` 为31文件296 passed，
Electron 生命周期 `20261105201129-0f9993` 为7 passed，均exit0/无Errors；typecheck、
strict、importable、wiring、ledger 均exit0。正式 gate 仍因范围外账本 dirty 前置exit2。
原件/分支/作业号见 `WP-192.report.md`。

**N1 仍未修**：main `media/api.ts` 未导出真实 `MediaError.toPayloadString()`，已交
C1/C2/L18 精确接口请求（`WP-192-dependency.md`），C1 已派 L18 WP-204，正式 main 后
另派新包恢复消费；本包部分交付。本 lane 不复制或私引实现。Rust
转写失败 WARN，二次 set_error 失败为 ERROR；该差异已对照 :1008-1030 告知协调者。
TESTMAP 77 ported/2 approved obsolete/0 pending 前后不变；本包不改变 009 全域验收等级。

## WP-009 · A3/D06（2026-11-05，新会话）

范围仅为 ab947994d 卸载候选与 R12-09 generation 的正常 main 集成单元。
已 merge main，原 wire/generation 基线 `20261105140049-cbcdad` 两文件20 passed、
exit0，无 Errors/Unhandled；typecheck `20261105140049-471a44` exit0。
实际审读发现仅 abort+clear 不能等待在途 OCR 的 NamedTempFile 清理，新增真实插件
回归 `20261105140704-b0e6b5` 首红5 failed/Errors1/exit1；修复跟踪已接受任务（含
已取消旧代），异步 dispose 完成后才解绑 L11，并保留 Rust 二次状态写失败日志/事件。
PDF task generation 改 bigint/u64 回绕；Lance/Unit/Segment 的 number|bigint 精确链保留，
临时 IndexUnitProfileWrites 改引用已 main 的正式 owner 类型。详见 SPEC WP-009。

TESTMAP 前后均77 ported / 2已批准obsolete / 0 merged / 0 pending；本包不改去向。
F1/F4/L11 generation 与 BM25 已公开的证据见 BLOCKERS 顶部；D03 WP-001 不属本包依赖。
两份范围外 migration 账本 dirty 已通知 C2，正式 lane-gate 前置结果与最终五项证据另记
本包交付报告；本节不将整个索引流水线称为完成。

WP-009 收尾：`4efcf2fa9` 修正新增测试夹具对 TS lib 的依赖，原断言/超时未改。
Node全lane `20261105142340-428e99` 31文件292 passed；Electron定向
`20261105141817-7dc2b4` 25 passed；均exit0/无Errors。最终五项补充检查
`20261105144336-{2c5a99,ee7fbf,43f86d,ae07a2,a42dae}` 全部exit0，最后一个
因main前移选到额外目录，原总数1727 passed/20 skipped；L12仍31文件292 passed/0 skipped。
完整原命令、归属及历史红灯见 `WP-009.md`。正式lane-gate仍因外来账本前置exit2，
不伪造selfgate成功记录。`7db266b11` 收尾正常merge main，L12源码/测试无变。

## 2026-11-05 Linux 续作（最新状态）

### 2026-11-05 新健康会话：正式固定联合树（源提交 5615f2e3e）

本会话只改本 lane，不切分支、不改 C2/主仓库，不动 ACCEPTANCE/Rust/依赖/生成物；
两外来 migration/LEDGER.md、ledger.json 保持未提交、不覆盖不还原。本 lane 提交：
- **5615f2e3e**：`src/pdf-preview.ts`、`src/pdf-processing.ts` 的未知字段分支改用 F4
  公开 `JsonReader.skipIgnoredValue()`（preview 未知 `futureField:1e400` 按 serde
  IgnoredAny 跳过并保留后续字段）；`processingProgressSnapshot` 的 percent 改用公开
  `f32ToJsonNumber`（finite 取最短 roundtrip 十进制，overflow/NaN→null，保留 -0）。
  原三条失败测试断言未改、未 skip。
- **ec39ebe7d**：F5 输出契约 nullable 后，本 lane `api.ts` 仍把内部
  `ProcessingProgress.percent` 声明为 number（仅 snapshot 为 number|null），不在计算
  路径放 null、不用 cast。
- **8b252cf5b**：`getStatus` 统一走该 snapshot 后，三个既有状态断言由 widened binary
  f32 改为 serde 最短出站值（33.333332 / 12.345679 / 9223373000000000000）；整数例
  仍能区分 double rounding，未删/跳/放宽测试。
- **R3 结论 + 唯一补测**：R3 已确认 8b 三处 snapshot 最短期望正确、不回改。补测落在
  既有 `pdf-status-boundary.test.ts`（`bebb5ea64`）：生产 `parseProcessingProgress`
  直接断言 `Math.fround(33.333333333333336)`、`2**63+2**40`、
  `Math.fround(12.3456789)`，以及 1e40 内部为 Infinity；snapshot null 仍由原 wire
  用例断言，现有新 snapshot 期望与三 wire 原 assert 全部不变。作业
  `20261105102806-4359c5` 1 passed/11 filtered、exit0。本会话一度加的重复 parser
  用例已由 `bd61095ee` 撤回，保持单一补测。

**正式固定联合树按正常 merge 引入真实 owner 提交**（无复制实现）：
F4 `71f7a3d10`→`30747990c`；F5 `b4a033c65`→`f87ae5d7a`→`052ac9759`→
`845e26b4d`（最终，含 main `65f668842`；f87-only 旧组合作废，845 已恢复被旧
merge-base 误退的非 F5 主线文件）；L13 `6913a03e5`→`0c2348a3f`；L18 `5e37aeae1`
（307 组合暴露的 raw atom 单行 owner 修正）。merge 后复核：L13 upload 仍用本 lane
wire 结果类型并保 null、F4 qbank Value 修复、L18 atom 修正与 F5 percent nullable
契约均未被 845 覆盖丢失。

**最终固定 tip 回执（F5 845 组合）**：
- 全 lane `20261105101523-7624a3`：30 文件 **286 passed/286**、exit0；含原三失败。
- typecheck `20261105101523-3bf580` exit0（vfs 零诊断，含 L13 upload）。
- importable `20261105101523-0b5b46` ok；boundaries `20261105101523-f44206` 3017 文件
  0 violation/232 suppressed；wiring `20261105101523-466c8e` ported77/未接入0；
  ledger `20261105101933-869cdf` exit0。
- R3 补测后受影响 parser/status 小集 `20261105103110-33ed17`：4 文件 **41 passed**、
  exit0；typecheck `20261105103110-21c7a0` exit0。
旧 f87 组合的 `20261105100324-4cb20e`（286）只证明旧树，不外推到本组合。
原 `20261105075942-a9b47d` 283/286、3 failed exit1 仍是修复前基线；原三失败在当前
固定树真实通过，未重跑无关 OCR/primary/codec 专项。

**F4/L18 最终闭包仍待纳入**：C1 已将 L18 `f9d949d43` 正式交 F4，L14 仍在最后 f64
高精度修正；本树仍是 F5 845 + F4 307 + L18 5e 的已验证组合，不把未确认的 Value
高精度语义合入 main。raw atom IPC `{rawJSON}` 属 F1 边界，C1 已派，L12 不私修 kernel。

**正式 lane-gate 前置仍被外来 dirty 阻塞**：`migration/LEDGER.md`、`migration/ledger.json`
非本 lane 改动，不隐藏/删除/提交；lane-gate clean 前置需 C2 安排归属。TESTMAP 保持
77 ported/2 obsolete。剩余跨域阻塞按 BLOCKERS（L02 共享 OCR 许可、L11 精确 owner 等）。

### 2026-11-05 恢复后冻结交接（交架构的新健康会话）

自动续派追加核对：按后发续派指令同步main至5fc8c0152；本lane的src/index/tests/api、
SPEC及TESTMAP相对d77bd5dbd无diff。共享最终gate仍以前置dirty退出2，只剩两份外来
migration账本。只读核查F4两个原语仍无导出、F5 percent仍number、L13:209仍nullable
赋值冲突；未获得新健康会话接管确认。沿C2限制不扩大实现、不重排原07:59检查，
此前六项回执仍是本单元的既有证据，不把本次静态核对写成新测试通过。
新main带入R3 ACCEPTANCE §21：独立审读并亲取已有07:59回执，确认Lance-disabled所查
生命周期/SQLite/OCR重同步子链候选通过；未另跑测试、未签在途卸载或整个桌面向量能力。
该限定验收与三项reader/wire失败、L13类型错误及正常main集成仍分别记账。

按C2立即指令收尾原会话，交接代码树为 **d77bd5dbd**。07:59已提交的六个作业均已
接回终态，没有重新提交它们；作业执行期间源码/config及main合并状态保持不变。
以下是当前单元的真实证据，不是“恢复即通过”，也不是对旧缺包条件的新复现。
尚未确认架构的新健康会话已创建或接管；当前收尾仍属于原会话。

**已保存的Lance-disabled单元入口**：

- `0bba255b8`：`index.ts`传现有lanceLifecycle.enabled，经`runtime-adapter.ts`进入
  `full-indexing.ts`。processPendingBatch在drain/claim前判断；单资源保Unit/OCR准备，
  OCR恢复后重同步，在chunk/embedding前返回0。已claim批次保持该轮enabled决定。
- `src/lance-disabled.ts`使用Rust InvalidState的完整code/message；batch/OCR日志按SPEC
  对照补齐。`tests/embedding-owner-errors.test.ts`增加真实vector provider以测试enabled
  分支，原三条owner-error断言不改。
- `c007d461a`：第三条真实插件回归验证无vector的PDF OCR→真实L11落库→真实Unit重同步；
  前两条覆盖队列/资源不被误消费、晚装真实F7后下一轮恢复、词法可检索。
- `d77bd5dbd`：SPEC补充上述边界。原红`20261105070748-e7750c`三失败；首绿
  `20261105071727-dfdc5c`两文件42通过，尚未包含后加的PDF OCR重同步用例。

**07:59原作业最终回执（全部已完成，无待取结果）**：

| 作业 | 命令/范围 | 结果 |
|---|---|---|
| `20261105075942-a9b47d` | Node完整本lane | 30文件；283 passed/3 failed（286）；exit1；无Errors/unhandled |
| `20261105075942-9653ee` | Electron index-service + embedding-owner-errors | 2文件43 passed；exit0；无Errors/unhandled |
| `20261105075942-9b5805` | typecheck:host | exit2；仅vfs/src/upload-attachment.ts:209的number|null→number|undefined |
| `20261105075942-2d0cf0` | boundaries:strict | 2985文件；0 violation；233 suppressed；exit0 |
| `20261105075942-736152` | ledger --check --no-write | exit0；problems全部0；不代表语义/集成门禁已过 |
| `20261105075942-a511af` | wiring --lane vfs-index | ported77、未接入0；exit0 |

原日志均在`/home/dsdev/.oc-jobs/done/<作业号>.log`，可用job.mjs result直接读取，不需submit。
importable同树为`importable: ok`。三失败固定为pdf-preview的IgnoredAny及pdf-status-wire
的finite f32最短值/null成功响应，未删改这些预期。

**后继入口与边界**：

1. 先读本节、SPEC的“Lance-disabled索引分支”和BLOCKERS最新条目；取已有结果，不重做
   primary、旧KB、已过codec集合。此单元待独立复核，不能把提供方绿例扩成整组签收。
2. 新健康会话再核main已发布接口后决定合并/消费；冻结树中F4 f32ToJsonNumber和
   JsonReader.skipIgnoredValue尚未进入main。前者只接processingProgressSnapshot出站点，
   后者只接preview/progress未知字段分支；不复制formatter/parser或私引分支实现。
3. F5 nullable输出/L13上传DTO、L02共享OCR许可、L11精确owner缺口仍按BLOCKERS各项交接。
   两旧KB审批e4680aa8a已main并应用：77 ported/2已批准obsolete/0 pending/0 merged；
   原测试保留、不skip，不扩大到活跃VFS clearAll或chat/KB维护。
4. 恢复入口git状态仅自有BLOCKERS.md历史增量和两份外来`migration/LEDGER.md`、
   `migration/ledger.json`。本次将已核对的自有BLOCKERS历史增量及本交接记录提交；外来
   两文件不提交、不覆盖、不还原。源码与测试均已有上述检查点，未丢失。
5. 依C2要求保持冻结代码树收尾，不在原会话继续merge/实现或启动新会话。共享绝对入口
   lane-gate的clean前置条件仍须由协调者处理；本lane不手写selfgate、不声称已完成。

### R12-06 primary恢复/清理错误优先级；C2两项审批已应用

对照Rust indexing.rs:2846-2901，修复metadata失败后Unit恢复标记异常抢先覆盖原错误、
阻断discard的问题；恢复标记只WARN，metadata/清理失败按原ERROR级别和顺序记录。
非InvalidState且清理失败时，资源failed和返回Other均使用合并文案；InvalidState即使
清理失败也仍mark pending并返回原对象。资源状态setter的?传播保留，无新SQL/API。

先红 `20261105051337-402d90` 四组合全部失败（33名称过滤），证明原错误被真实SQLite
恢复标记错误覆盖。修复在dd01a32e6，测试在e206b37dc：普通metadata错误来自真实L11
Segment INSERT触发器，InvalidState是owner依赖故障输入；不替换本lane恢复/清理编排。
Node全lane `20261105052600-232b6d`：280 passed/3 failed（283）、exit1，仅既有两wire
和B12-15，无Errors/unhandled；Electron `20261105052601-c044e3` 索引37 passed、exit0。
typecheck `20261105052601-1375f1`仅L13:209、exit2；strict
`20261105052601-5eeacc` 2985文件/0 violation/exit0；importable: ok。

C2审批e4680aa8a已由正常merge 977c14fba进入本树，main祖先检查exit0、审批分片:5-6
可见；已按C2/R3指令仅将两旧KB精确ID改为obsolete:dead-in-rust，变更保存在b17ed85c0。
现为77 ported/2已批准obsolete/0 pending/0 merged，原Rust/TS测试和全部断言保留、无skip；
未重跑两旧用例求绿，未扩大到parseDim、VFS clear_all(modality)或chat/KB维护。
审批应用后ledger `20261105053649-b039e8`、wiring `20261105053649-059030`均exit0，
ported77、未接入0。此记账不清零R12组级缺口或F4/F5/L13联合门禁阻塞。

### R12-06 primary元数据状态写候选修复

继续原日志/错误策略审读发现：Rust indexing.rs:2754-2764的primary indexing marker
写失败应WARN继续，:3132-3140的additional同一步则传播。共用syncSegmentMetadata原先
统一fail-fast。新增真实L11/SQLite触发器双分支回归，先红作业
`20261105044034-47445f` 为primary1 failed/additional1 passed/31名称过滤。
修复保存于917812ea6：显式primary/additional角色，仅primary捕获这条状态写错误，
profile/Segment/最终状态等仍传播；补primary维度范围WARN。无新SQL或API，原R3已核的
additional向量失败测试未改，原所有权缺口也未借此关闭。

Node全lane `20261105044259-f4a726`：276 passed/3 failed（279）、exit1；仍仅两wire
与B12-15，无Errors/unhandled。Electron `20261105044259-9d43b4` index-service33 passed、
exit0，验证primary仍提交+精确WARN，additional回滚profile/不留Segment/discard并继续later。
typecheck `20261105044259-10d06c`仅L13:209、exit2；strict
`20261105044259-e71682` 2985文件、0 violation、exit0；importable: ok。
ledger `20261105044742-1fa823` / wiring `20261105044742-e8ee85` exit0，ported77、未接入0；
两条旧KB pending审批保持，完整ID/证据见TESTMAP。随后merge main f5a8d03e2只更新其它
lane及审计记录，未改本单元实现；R3 §17已独立确认此前config-copy清理子项，不重做。

### 符号级审读：旧KB两测试撤回ported、申请裁定

现行TESTMAP为77 ported/2 pending（生成表头未手改，以行状态为准），不是原79/0。
精确ID与引用证据见TESTMAP末尾：rows_to_retrieved_input_dedup_semantics与
clear_all_success_means_sqlite_and_every_lance_table_are_empty对应旧VectorStore KB方法。
Rust vector_store.rs:1-9明确无外部多态调用，auto_migrate_if_needed:3633-3642明确死入口；
全src-tauri方法引用只有trait定义/实现内部、该死迁移和测试。申请C2按dead-in-rust核实，
未自行obsolete、未删测试/断言/公开legacyKb接口；不能用TS挂出属性替原Rust造活跃入口。

parse_dim_from_table_name仍被聊天维护使用，六项原输入/期望改测真实ChatLanceStore helper，
不在申请范围；Rust lib.rs:1652-1654的chat/KB优化也不在该申请范围。旧native-needs中
“全部未迁移chat/KB均F7阻塞”已更正为逐方法核调用，不能借缺能力扩大或恢复死分支。

变化点Node `20261105042327-10e2e8` / Electron `20261105042327-b921b4` 均3 passed、
exit0，包含仍保留的两项pending用例；不是将绿色当作生产可达。typecheck
`20261105042327-0575ff`仍仅L13:209、exit2；ledger `20261105042328-d732cb` exit0；
wiring `20261105042328-d56e69`输出ported77、未接入0。本轮全量结果沿前一配置单元
040857-5883a7的274 passed/3 failed，不冒称维度helper测试切换后又重跑了一次全量。

收尾merge main带入R3 ACCEPTANCE §16：c28e272d4 settings-owner六个场景已由固定2例
加固定4例独立通过；这是候选限定签收，正常main未集成及整R12-03仍未闭合，不重复返工。

### 自动续派：R12-03配置副本清理

main无新实现、正式自检仍被继承dirty前置拦截。查明L12的setConfig/validateConfig仅测试
调用，真实L13b命令早已委托L11 indexingConfig。删除未接线的写SQL、校验及额外事务副本，
未为扫描器造调用；保留索引器实际配置读取。附加测试改用真实owner并维持十项逐字错误、
写后读取及配置投影断言，额外校验VFS_INVALID_ARGUMENT/param；79条Rust映射未改。

修改测试后首验 `20261105040337-3b0e36` 2 passed/29名称过滤；清理后Electron
`20261105040857-016bcc` 31 passed/exit0。Node全lane `20261105040857-5883a7`
274 passed/3 failed、exit1，仅既有两wire+B12-15，无Errors/unhandled。
typecheck `20261105040857-bf2238`仅L13:209、exit2；strict `20261105040857-6dfc33`
2983文件/0 violation/exit0；ledger/wiring `20261105040857-c916e4/a9813c` exit0，
ported79、未接入0；importable: ok。实现保存于3e087ab85/185b88eb9。

另只读发现L11已存跨字段i32的+号/范围处理与Rust不符，精确请求B12-16；未越界改owner，
未把普通配置矩阵通过外推为其完整解码签收。

### 自动续派：R12-03 settings owner

main已同步（855ffcc21）。F4 f32/skipIgnoredValue仍未main，不重复实现；共享lane-gate
按规定执行，仍因继承dirty文件前置exit2。按剩余单写者事项接main已发布的SettingsWithConn：
本地saveSetting写SQL删除，生产ChatLanceStore/LegacyKbStore由ctx.settings传同一连接。
时间戳失败warn继续、path回退写失败传播；三处get_setting按Rust.ok().flatten()保读失败默认。

先红owner回归 `20261105032452-7c738f`：3 failed/1 passed/14名称过滤；新增读取错误回归
`20261105032939-bb7e9b`：1 failed/18过滤，确实暴露原SQL读取错误误传播。
owner写接线后初次WARN测试失败来自默认logger buffer不收集WARN，现显式exporter level4，
保留原级别/前缀/SQLite错误断言，不更改生产日志或放宽断言。

固定实现闭包 **7a99ffb2a**（含ddae869ff五文件owner接线）；Electron
`20261105033357-8ea842` 命令19/19 passed、exit0。R3先排032744-2c0383期间目标代码发生
上述变更，已明确该早期作业只作探索结果，不能冒充当前闭包签收。Node全lane及最终门禁待取。
原throttle回归仅补真实F4 provider，原持久值/优化次数断言未改；R12-07已签部分不重写。

最终Node全lane `20261105033357-86edf7`：274 passed/3 failed（277）、exit1；失败仍为
原两wire与B12-15 IgnoredAny，无settings回归失败或Errors/unhandled。typecheck
`20261105033357-942a1f`仅L13 upload-attachment.ts:209、exit2；普通/strict
`20261105033358-fdf02a` / `20261105033357-d0c24a` 2983文件、0 violation、exit0。
ledger `20261105033357-52cadc`、wiring `20261105033357-eac5d7` exit0；importable: ok。

R3探索红回执后只增强WARN逐字断言，原some/优化/owner/空值断言保留。变化点作业
`20261105033948-b294f4` 1 passed/18名称过滤、exit0，准确WARN为：
`[Lance优化] 记录 chat 上次优化时间失败: timestamp rejected`。
原因核对Cordis logger.ts:22-26、213-219：默认buffer INFO=1不收WARN=2，测试显式exporter
level4捕获同一生产日志；未改生产WARN调用。该最后变化仅测试断言，五实现仍为7a99ffb2a。

### 自动续派：R12-08 preview 已知字段与大整数回写

同步main提交 `1ba48a7bb` 后，已读R3 ACCEPTANCE §12：owner-error与generation联合候选
已独立6例通过，不重做；原wire/DTO闭包仍未进入main，正式lane-gate仍被继承dirty前置拦截。
继续既有自有preview事项：新增pdf-preview.ts，消费F4 JsonReader，覆盖typed字段重复、
整数词法、struct序列、Option/default及usize精确读写；pdf-runtime原导出保留。
PDF压缩/OCR、索引OCR与multimodal usize→i32接缝均保全数值。未截断的新preview仍写
maxRenderedPages=50（Rust repos/pdf_preview.rs:263-269），未改前端/契约/其他lane。

先红 `20261105023550-ef2d49` 10 failed/1 passed；实现后首轮4文件
`20261105023750-8c4f07` 24 passed/exit0。进一步覆盖PDF OCR/索引OCR排序及multimodal
真实owner写入；其中PDF高页码测试原来进入后续稠密数组索引而超时，已按SPEC改为无resource
历史文件验证OCR写回，保持原大值和排序断言，未给业务加上限或改Rust既有稠密Vec行为。

**新增真实跨域阻塞B12-15**：main JsonReader没有skipIgnoredValue，skipValue会把未知
1e400按Value报错；Rust IgnoredAny应跳过。F4候选 `ba6ef98a3` 已公开该专用方法，待正常
main后消费（preview与progress未知字段分支）；不复制parser。相应成功预期回归保留，
因此不宣称整个preview/R12-08闭合。

typecheck `20261105024309-405781`仅L13 upload-attachment.ts:209、exit2；strict
`20261105024309-9468fd` 2979文件、0 violation、exit0；importable: ok。
完整最终结果待队列返回，不把最初24通过覆盖后加的回归或IgnoredAny阻塞。

最终Node全lane `20261105024831-7c5d18`：30文件、269 passed/3 failed（272），exit1；
失败为原两wire加B12-15 IgnoredAny，没有剩余OCR夹具超时或Errors/unhandled。
Electron `20261105024831-90682e`：4文件27 passed/1 failed（28），exit1；仅同一
IgnoredAny反例，压缩/OCR/索引OCR/multimodal精度断言均通过。ledger
`20261105025023-045b81`、wiring `20261105025023-4aba14` exit0，原79行仍ported、未接入0。
实现已在bc3428852，新增反例/夹具边界说明在ee05933a9/8e877d6f6自动检查点；没有削弱
原移植断言。随后merge main为9dd95bfd7，带入R3 §13的MIME/F7限定候选签收，不扩大组级结论。

### 协调者指令1复验（main同步9c86545b5）

再次合并main并执行指定三项，没有改失败断言或越界改owner：
typecheck `20261105020750-7a8666` exit2，唯一L13 upload-attachment.ts:209；
普通boundaries `20261105020750-df8cc0` exit0、2974文件/0 violation；
全lane `20261105020750-e0ec54` 255 passed/2 failed（257）、exit1，无Errors/unhandled，
两失败仍为finite f32最短投影与non-finite null输出契约。

亲查F4 util/api.ts仍无f32ToJsonNumber，F5 _shared.json:1302-1305仍percent:number，
L13处理变量:197仍number|undefined。C2协调日志:1562明确这三owner按联合闭包处理；
重复同基线检查不能替代它们的发布。strict `20261105021012-5b92bb` exit0、0 violation；
ledger `20261105021012-b21d56`、wiring `20261105021012-397098`均exit0。
共享绝对入口lane-gate实际运行后因继承dirty文件前置exit2，未手写selfgate记录。
本轮仅保存新main的实测证据，不标全绿/已完成；接口、依赖与原TESTMAP状态不变。

### 当前提交验证（合并 main 后）

集成基线同步提交 `61a2e77c4`；随后再次merge main为Already up to date。
已处理本lane旧测试参数TS2345及R3的owner-error新反例；不得再将旧topK-only错误归给当前树。

- typecheck `20261105013703-32d625`：exit2，唯一L13 upload-attachment.ts:209 nullable
  percent错误；没有本lane类型错误。
- Node全lane `20261105013703-6aa333`：29文件，255 passed/2 failed（257），exit1；
  失败仍仅R12-08 finite f32投影与null输出schema。无Errors/unhandled。
- 普通boundaries `20261105013703-e339e8`、strict `20261105013703-d75045`：均exit0，
  2969文件、0 violation（strict 233 suppressed）。
- ledger `20261105013703-4add83`、wiring `20261105013704-bee76d`：均exit0。
  lane命令A100%/B0%；TESTMAP 79 ported、0 merged/obsolete/pending；module未接入0。
- 本轮各变更的Electron定向结果见下：原生metadata21、图片OCR及原MIME18、真实owner错误6
  均passed/exit0。未将这些定向数字说成最新main的Electron全量。
- lane-gate已实际执行，因开工继承的BLOCKERS未提交hunk与两个范围外migration账本dirty
  在前置检查退出2。新增BLOCKERS hunk已单独暂存提交，继承内容未覆盖/还原；仍需协调者
  处理该前置条件。R12-08/F5/F4与L13 DTO闭包继续由架构协调，未削弱失败断言。

本轮公开api.ts未变；实际新增消费L13 mediaIndex与L02 llmOcrPages，无新npm依赖。
Rust数值转换/错误Display保持原行为；不自签R3尚未复核的组级结论。

### R3 R12-02 owner-error 增量

按R3回执只处理Display，不复做已验证的模型选择/五字段指纹：已读
embedding_service.rs:114-176,343-389与models.rs:1038-1041。`embedding.ts`共用错误文本
消费函数现解开kernel CommandError.value，再取AppError.message；首次配置、重读配置、
单次transport和批次retry日志/终止前缀保持原样，不解析envelope JSON或修改L02契约。

新增 `embedding-owner-errors.test.ts` 安装真实L01/L02/L11/L12/notes/vfs，只控制配置列表
与尚未发布的远端embedding输入；被测L02解析器与L12管线未替换。先红
`20261105012855-7ec63b` 三项都精确复现envelope混入文案（首次info、query模型ID、批后重读），
并要求失败后无Segment提交。修复后全lane/Electron/typecheck正在队列复验。

R12-02修复后：Node全lane `20261105013044-2edb4c` 为255 passed/2 failed（257），
exit1，只有原PDF wire两失败；Electron `20261105013045-c27c25` 6 passed、exit0。
typecheck `20261105013045-adf4d1`仅L13:209、exit2；本lane的旧VfsSearchParams遗漏已
在b9c123779修正且未再报错。strict `20261105013045-e179f9` 2954文件、0 violation、exit0。
实现与真实owner回归已保存于939686562；不将提供方结果当R3独立签收。

### 自动续派：R12-01 媒体接线与真实 F7 写链

### C2 新反馈：R12-05 图片 OCR 临时文件

只读R3 ACCEPTANCE §10后确认R12-07已独立关闭，不新增其实现或复跑该专项；R12-06
additional-unit候选保持。Rust image_extension_for_mime在pdf_processing_service.rs:2603
确有生产调用。现在 `ocrImageFile` 创建真实MIME后缀临时文件，交L02正式文件OCR入口，
finally清理，保原OCR文本；未把helper调用伪装成仍走data URL的路径。

原四MIME断言保留；TESTMAP曾如实pending，实际接入后恢复ported。新增真实插件/L11
与外部L02契约替身的五项回归：Node `20261105012116-eaaaf0` 5 passed；Electron
`20261105012302-1069c0`（含原pdf-processing）18 passed，两者exit0、无Errors。
首跑超时来自测试误调用listen的void返回值，已修观察器，不将超时当业务证据。
L02共享ocr_semaphore许可尚未公开（Rust:608,2588），见B12-14；不以本地图像slots冒充。

R12-05收尾门禁：全lane `20261105012302-b87337` 252 passed/2 failed、exit1，
仍仅原R12-08 wire两例；typecheck `20261105012302-6edd01` exit2，仅L13:209。
strict `20261105012302-48bf50` 2953文件/0 violation/exit0；ledger
`20261105012302-d6d5d8` 与wiring `20261105012302-e4d079` exit0，ported79、未接入0。
图片实现/回归/恢复TESTMAP已由 `08c4478b7` / `fc656f653` 自动保存，原断言未削弱。

媒体/原生metadata单元最终补充：Node `20261105010433-f9e4ca` / Electron
`20261105010433-1f909a` 均21 passed、exit0；包含Value的arbitrary_precision裸-0与
未消费字段1e400，page/source来自native metadata列。typecheck
`20261105010136-5cc4d9`只剩L13 upload-attachment.ts:209 nullable percent错误。

以下是媒体单元的过程记录：

再次merge main至 `80851cc18`；F4/F5/L13原三项门禁问题仍未消除。
L13已发布的mediaIndex现在由实际runtime消费：primary/additional transcript的range
随Segment事务写入；retrieval在fusion与multimodal过滤后回填timeRange/sourceId。
调用时解析provider，复用owner算法；缺表保持debug/best-effort。

- 新媒体检索入口先红 `20261105004130-486415`（2 failed），修复后Node
  `20261105004311-0b8fe4`（含既有检索，共12 passed）/Electron
  `20261105004311-fb0fa6`（2 passed）均exit0。
- 真实F7索引写链首跑 `20261105004523-4c3a10` 暴露DTO metadata_json未映射至Arrow
  metadata列；已按Rust build_batch修复。夹具改读真实列，原断言不变。
- Electron `20261105004857-0235ea`：两个文件17 passed、exit0，包括原R12-09三例和
  两窗口真实Lance/Unit/Segment的2^53+1精度。追加的native查询page_index/source_id
  也已改为从metadata列解析（Rust parse_metadata_fields）；新增adapter向量/FTS用例。
- typecheck发现上一轮新增标题测试遗漏VfsSearchParams.query/modality，已补完整参数，
  不修改业务断言；L13 upload-attachment.ts:209的nullable错误仍独立保留。
- 普通boundaries `20261105004605-b21009` 与strict `20261105004857-a19e87` 均exit0、
  0 violation；importable: ok。
- 最终Node全lane `20261105004857-1ab90d`：27文件、245 passed/2 failed、exit1；
  仅原R12-08两项wire失败，无Errors/unhandled。追加Electron
  `20261105005442-26c126`：3文件22 passed、exit0，含真实Lance写入/查询页码和bigint、
  媒体窗口/metadata优先级、实际缺表debug并保留命中。原生库仅有distance自动投影弃用警告。
- ledger `20261105005442-7acf2f` exit0；wiring `20261105005442-8158e1` exit0，
  ported79、未接入0。自动检查点保存了实现与测试，后续显式提交注明Rust映射与夹具改动。

以下为上一单元的基线结果，不用于替代本次改动后的复验：

- 恢复分支既有工作后正常 merge main：`b97f237e2`（main 基线 `e9df01a3c`）。
  开工已有 BLOCKERS 与两个 migration 账本生成物 dirty；未还原范围外文件。
- 门禁反馈的 R12-09 三例随 L11 `9006bc168` 集成转绿。Node 全 lane
  `20261105000316-0d8e42`：25文件/233测试，231 passed、2 failed，exit1；失败仅为
  R12-08 finite f32 最短输出与 non-finite null 输出契约。F4 helper 和 F5 输出契约未进 main。
- typecheck `20261105000315-7b7e06` exit2，仅 L13 upload-attachment.ts:209 nullable
  percent 消费错误。普通 boundaries 2949文件、0 violation、exit0；importable: ok。
  当前门禁未绿，未宣称完整迁移或独立验收完成；接缝请求见 BLOCKERS 最新小节。
- X6-UD-0090 标题子项：Rust indexing.rs:5014-5026 对非空 metadata title 保留原文。
  新增真实插件 fullSearch 两入口的三组回归；先红作业 `20261105000801-f8710e`
  为1 failed/2 passed/7按-t过滤，实际输出错误裁剪了标题。实现只去掉返回值的 trim，
  保留 Rust 空白判断；完整 typed metadata 解码未借此关闭。
- 修复后 Node 检索文件 `20261105001327-4482d0` 10 passed、exit0。Electron 全 lane
  `20261105000802-4969bd` 25文件/236测试，234 passed、2 failed、exit1；仍仅R12-08
  两例，无Errors/unhandled。strict `20261105000821-84141e` 2949文件、0 violation、exit0。
- ledger `20261105000802-d564c4` exit0：本lane命令A100%/B0%，测试A100%/B0%；
  TESTMAP 79 ported、0 merged、0 obsolete、0 pending。独立验收仍不通过。
- 自动检查点 `693b5f806` 保存测试/SPEC，`a2bf8cac1` 保存标题实现与续作记录；
  diff消失是已提交，修复仍在HEAD，并非工作区丢失。

## v2排雷清单

固定报告：`0119143715c0bab2d8f698b7c1d58651358e85be`；**以下每行源码基线均为
`2ee9a9cbe`**，原位置不会随重扫改写。稳定编号沿 C2 原报告顺序保留；当前核对树
`1ca9397b5`。SW 的原报告 owner 均为 `vfs-repos`、类别均为 `executed`。
所有权优先使用 `037376b1e` 的 **X6-OWN-C2-20261104**：这里 VFS 表属 L11；
`mistakes.rag_documents/rag_document_chunks/rag_sub_libraries` 属 L12，主库 settings
属 F4，`vfs_indexing_config` 属 L11。不能把同名异库表或旧 qbank 推断混入本清单。

“候选已修”仅表示已读实际 diff/生产调用，并列修复提交（含协调者自动检查点）；
**正常 main 后须 R3 独立复验，当前均不标验收完成**。“未修”是自有工作，只有明确
列出的窄 owner API 缺失才列跨 lane 阻塞。R12-09 与阻 L04/L13 的接缝继续优先，
本次清单登记不触发全仓扫描/全量测试，也不复活任何已批准 obsolete/dead 分支。

### SW：61 项（保留原 SQL 操作与位置）

| 稳定 ID | 原位置（源码基线 2ee9a9cbe） | 原操作 | 当前状态、修复 SHA / 生产证据 |
|---|---|---|---|
| X6-SW-0142 | host/plugins/vfs-index/repository/embedding-dim.ts:341 | UPDATE vfs_embedding_dims | 候选已修待复核；`ce4a5e2cc`：setAnnStatus 仅调用 L11 embeddingDims，同 conn；真实 Lance/owner 测试。 |
| X6-SW-0143 | host/plugins/vfs-index/repository/embedding-dim.ts:347 | UPDATE vfs_index_profiles | 候选已修待复核；`ce4a5e2cc`：同一 setAnnStatus 委托，删除第二条本地 SQL。 |
| X6-SW-0144 | host/plugins/vfs-index/repository/embedding-dim.ts:361 | UPDATE vfs_index_profiles | 候选已修待复核；`ce4a5e2cc`：setProfileAnnStatus→L11。 |
| X6-SW-0145 | host/plugins/vfs-index/repository/embedding-dim.ts:503 | INSERT vfs_embedding_dims | 候选已修待复核；`ce4a5e2cc`：registerWithModelFingerprint→L11，删除本地注册实现。 |
| X6-SW-0146 | host/plugins/vfs-index/repository/embedding-dim.ts:519 | UPDATE vfs_index_profiles | 候选已修待复核；`ce4a5e2cc`：profile queryable 切换归 owner 注册事务。 |
| X6-SW-0147 | host/plugins/vfs-index/repository/embedding-dim.ts:525 | UPDATE vfs_index_profiles | 候选已修待复核；`ce4a5e2cc`：旧 profile retired 切换归 owner。 |
| X6-SW-0148 | host/plugins/vfs-index/repository/embedding-dim.ts:533 | UPDATE vfs_index_profiles | 候选已修待复核；`ce4a5e2cc`：同空间更新归 owner。 |
| X6-SW-0149 | host/plugins/vfs-index/repository/embedding-dim.ts:543 | INSERT vfs_index_profiles | 候选已修待复核；`ce4a5e2cc`：profile insert/upsert 归 owner。 |
| X6-SW-0150 | host/plugins/vfs-index/repository/embedding-dim.ts:569 | UPDATE vfs_embedding_dims | 候选已修待复核；`ce4a5e2cc`：active profile 指针归 owner。 |
| X6-SW-0151 | host/plugins/vfs-index/repository/embedding-dim.ts:594 | UPDATE vfs_index_units | 候选已修待复核；`ce4a5e2cc`：切换空间时 Unit 重排归 owner 注册事务。 |
| X6-SW-0152 | host/plugins/vfs-index/repository/embedding-dim.ts:601 | UPDATE resources | 候选已修待复核；`ce4a5e2cc`：资源调度重排归 owner；`96a14d4bd` 将 owner 传至实际事务句柄。 |
| X6-SW-0153 | host/plugins/vfs-index/repository/index-content.ts:175 | UPDATE resources | 部分候选；`97556dbc8/b49b0e913` 删除条件缓存 SQL，`80cf53a42` 缺方法明确报错，`ea5ccf9ee` 恢复 warn/继续。L11 saveOcrTextIfEmptyWithConn 未 main，行为仍 pending。 |
| X6-SW-0154 | host/plugins/vfs-index/repository/index-content.ts:241 | INSERT vfs_index_units | 未修，SHA —；insertIndexingUnitRow 在 index-service.indexResource/full-indexing.indexQuestion 可达；需窄 insertIndexingUnitWithConn（指定 ID/时刻/空文本必需态），B12-03。 |
| X6-SW-0155 | host/plugins/vfs-index/repository/index-content.ts:267 | INSERT vfs_index_segments | 未修，SHA —；旧 indexResource→insertPlaceholderSegmentRow；需保持指定 ID/共同 at 的 owner 方法，不能用普通 create 冒充。 |
| X6-SW-0156 | host/plugins/vfs-index/repository/index-content.ts:286 | UPDATE vfs_index_units | 未修，SHA —；indexResource/indexQuestion→markUnitIndexedRow 指定 at；待精确 owner 接缝，不能丢同一时刻语义。 |
| X6-SW-0157 | host/plugins/vfs-index/repository/index-content.ts:302 | UPDATE vfs_embedding_dims | 候选已修待复核；`7e3bc4b8c`：incrementEmbeddingDimCountRow→owner.incrementCount，删除 fallback。 |
| X6-SW-0158 | host/plugins/vfs-index/repository/index-content.ts:312 | UPDATE vfs_index_units | 部分候选；`da6219572` 删除恢复 reset SQL；`80cf53a42` 缺恢复 owner 抛错而非返回0。recoverStuckIndexingWithConn 未发布，未签恢复成功。 |
| X6-SW-0159 | host/plugins/vfs-index/repository/index-content.ts:318 | UPDATE vfs_index_units | 部分候选；同 `da6219572/80cf53a42`，mm 恢复归窄 owner；缺接口仍 pending。 |
| X6-SW-0160 | host/plugins/vfs-index/repository/index-content.ts:324 | UPDATE resources | 部分候选；同 `da6219572/80cf53a42`，资源恢复归窄 owner；缺接口仍 pending。 |
| X6-SW-0161 | host/plugins/vfs-index/repository/index-content.ts:350 | INSERT __lance_orphan_queue | 未修，SHA —；full-indexing.clearEmptyTextIndex→clearTextIndexRowsForResource；需要 enqueue/delete/Unit 状态同事务 owner 方法。 |
| X6-SW-0162 | host/plugins/vfs-index/repository/index-content.ts:363 | DELETE vfs_index_segments | 未修，SHA —；同 clearEmptyTextIndex 事务，不能将删除从同 conn 拆出。 |
| X6-SW-0163 | host/plugins/vfs-index/repository/index-content.ts:369 | UPDATE vfs_index_units | 未修，SHA —；同 clearEmptyTextIndex，必须保非 primary 非空 required Unit pending 的 CASE。 |
| X6-SW-0164 | host/plugins/vfs-index/repository/index-content.ts:423 | UPDATE __lance_orphan_queue | 未修，SHA —；full-indexing.drainLanceOrphanQueue→updateOrphanRetry；需 owner retry/error/nextRetryAt 方法。 |
| X6-SW-0165 | host/plugins/vfs-index/repository/index-segment.ts:10 | INSERT __lance_orphan_queue | 候选已修待复核；`ab64d23f9`：enqueueLanceOrphan→L11 embeddingSegments，同 conn。 |
| X6-SW-0166 | host/plugins/vfs-index/repository/index-segment.ts:22 | DELETE __lance_orphan_queue | 未修，SHA —；drainLanceOrphanQueue→deleteLanceOrphan；需 owner 窄删除入口。 |
| X6-SW-0167 | host/plugins/vfs-index/repository/index-state.ts:287 | UPDATE resources | 候选已修待复核；`96a14d4bd`：setIndexState→owner，事务句柄绑定/恢复，同 conn，无 fallback。 |
| X6-SW-0168 | host/plugins/vfs-index/repository/index-state.ts:325 | UPDATE resources | 候选已修待复核；`96a14d4bd`：markFailed→owner。 |
| X6-SW-0169 | host/plugins/vfs-index/repository/index-state.ts:371 | UPDATE resources | 候选已修待复核；`96a14d4bd`：claimPendingResources→owner immediate 事务。 |
| X6-SW-0170 | host/plugins/vfs-index/repository/index-state.ts:414 | UPDATE vfs_index_units | 候选已修待复核；`96a14d4bd`：reviveConfigBlocked→owner deferred 事务。 |
| X6-SW-0171 | host/plugins/vfs-index/repository/index-state.ts:420 | UPDATE resources | 候选已修待复核；`96a14d4bd`：同 reviveConfigBlocked 原子事务。 |
| X6-SW-0172 | host/plugins/vfs-index/repository/index-state.ts:438 | UPDATE resources | 候选已修待复核；`96a14d4bd`：requeuePagedPdfsOnce→owner，资源/迁移标记同事务。 |
| X6-SW-0173 | host/plugins/vfs-index/repository/index-state.ts:477 | UPDATE vfs_embedding_dims | 候选已修待复核；`96a14d4bd`：refreshCountsFromSegments→owner。 |
| X6-SW-0174 | host/plugins/vfs-index/repository/index-units.ts:170 | UPDATE resources | 候选删除重复写，待复核；`97556dbc8` 删除 cacheResourceOcrText；实际条件缓存缺接口仍见 SW-0153，不签完整行为。 |
| X6-SW-0175 | host/plugins/vfs-index/repository/index-units.ts:214 | INSERT vfs_index_units | 未修，SHA —；full-indexing.indexResource→ensurePrimaryUnit；需空文本 text_required=1/indexing 的精确 owner 方法。 |
| X6-SW-0176 | host/plugins/vfs-index/repository/index-units.ts:233 | INSERT vfs_index_units | 待可达性核对，SHA —；insertUnit 当前仅定义和未使用 import，未找到调用；未自行标 obsolete 或为清指标接回生产。 |
| X6-SW-0177 | host/plugins/vfs-index/repository/index-units.ts:254 | UPDATE vfs_index_units | 候选已改 owner 待复核；`80cf53a42`：text/mm→setUnitIndexProfile→L11 setIndexProfile；R12-09 Segment 精度仍红，不以此关闭写链。 |
| X6-SW-0178 | host/plugins/vfs-index/repository/index-units.ts:270 | UPDATE vfs_index_units | 未修，SHA —；syncSegmentMetadata→setUnitTextState 含 embeddingDim 分支；需 owner 窄方法。 |
| X6-SW-0179 | host/plugins/vfs-index/repository/index-units.ts:277 | UPDATE vfs_index_units | 候选已修待复核；`21e8175c2`：无 embeddingDim 分支委托 owner.setTextState，同 conn，删除本地 SQL。真实 full-indexing.indexResource 附加 Unit 写失败回归断言 owner 被调用、保留 indexed_at/维度和资源业务时间；Node/Electron 最小用例均通过。 |
| X6-SW-0180 | host/plugins/vfs-index/repository/index-units.ts:293 | UPDATE vfs_index_units | 候选已修待复核；`765dcc245`：markUnitTextIndexed→owner.setTextIndexed。 |
| X6-SW-0181 | host/plugins/vfs-index/repository/index-units.ts:311 | UPDATE vfs_index_units | 未修，SHA —；full-indexing 错误恢复→markTextUnitsState；按资源/requiredOnly 的批量同一时刻 owner 方法缺失。 |
| X6-SW-0182 | host/plugins/vfs-index/repository/index-units.ts:327 | UPDATE vfs_index_units | 未修，SHA —；markTextUnitsFailedWithoutDim；需失败态与清空维度一并写入的窄 owner。 |
| X6-SW-0183 | host/plugins/vfs-index/repository/index-units.ts:346 | INSERT __lance_orphan_queue | 候选已修待复核；`765dcc245`：purgeIndexArtifactsByResource→owner，入队/删 Unit 同 conn。 |
| X6-SW-0184 | host/plugins/vfs-index/repository/index-units.ts:358 | DELETE vfs_index_units | 候选已修待复核；`765dcc245`：同 owner purge。 |
| X6-SW-0185 | host/plugins/vfs-index/repository/index-units.ts:376 | DELETE __lance_orphan_queue | 候选已修待复核；`765dcc245`：replaceSegmentsByUnitAndModality→owner，保留行出队属同一事务。 |
| X6-SW-0186 | host/plugins/vfs-index/repository/index-units.ts:386 | INSERT __lance_orphan_queue | 候选已修待复核；`765dcc245`：旧行入队归同一 owner replacement。 |
| X6-SW-0187 | host/plugins/vfs-index/repository/index-units.ts:397 | DELETE vfs_index_segments | 候选已修待复核；`765dcc245`：旧 segment 删除归 owner replacement。 |
| X6-SW-0188 | host/plugins/vfs-index/repository/index-units.ts:425 | INSERT vfs_index_segments | 候选已改 owner 待复核；`765dcc245`：batchCreateSegments/replace→L11；R12-09 精确写入失败独立保留。 |
| X6-SW-0189 | host/plugins/vfs-index/repository/index-units.ts:425 | REPLACE vfs_index_segments | 候选已改 owner 待复核；`765dcc245` 删除 INSERT OR REPLACE 副本；与 SW-0188 同一原语，编号仍独立保留。 |
| X6-SW-0190 | host/plugins/vfs-index/repository/index-units.ts:461 | INSERT vfs_embedding_dims | 候选已修待复核；`7e3bc4b8c`：registerAndIncrementEmbeddingDim→owner.register，同 conn。 |
| X6-SW-0191 | host/plugins/vfs-index/repository/index-units.ts:468 | UPDATE vfs_embedding_dims | 候选已修待复核；`7e3bc4b8c`：同 owner.incrementCount。 |
| X6-SW-0192 | host/plugins/vfs-index/repository/index-units.ts:517 | INSERT __lance_orphan_queue | 候选已修待复核；`765dcc245`：clearMultimodalIndex→owner，真实 multimodal delete 回归。 |
| X6-SW-0193 | host/plugins/vfs-index/repository/index-units.ts:530 | DELETE vfs_index_segments | 候选已修待复核；`765dcc245`：同 owner mm 清理。 |
| X6-SW-0194 | host/plugins/vfs-index/repository/index-units.ts:536 | UPDATE vfs_index_units | 候选已修待复核；`765dcc245`：同 owner mm disable/reset。 |
| X6-SW-0195 | host/plugins/vfs-index/repository/index-units.ts:553 | UPDATE resources | 候选已修待复核；`7e3bc4b8c`：setResourceMmState→owner.indexStates，失败/非失败分流。 |
| X6-SW-0196 | host/plugins/vfs-index/repository/pdf.ts:61 | UPDATE files | 候选已修待复核；`7f827f303`：cancelMediaRow→files.cancelProcessing，owner 必需；真实 setter 夹具已替代复制实现。 |
| X6-SW-0197 | host/plugins/vfs-index/repository/pdf.ts:78 | UPDATE files | 候选已修待复核；`7f827f303`：markRecoveredPendingRow→files.markProcessingRecovered。 |
| X6-SW-0198 | host/plugins/vfs-index/repository/pdf.ts:93 | UPDATE files | 候选已修待复核；`7f827f303`：setProcessingErrorRow→files.setProcessingError。 |
| X6-SW-0199 | host/plugins/vfs-index/repository/pdf.ts:113 | UPDATE files | 候选已修待复核；`7f827f303`：completed 分支归 files.applyProcessingStatus。 |
| X6-SW-0200 | host/plugins/vfs-index/repository/pdf.ts:119 | UPDATE files | 候选已修待复核；`7f827f303`：completed_with_issues 分支归同 owner。 |
| X6-SW-0201 | host/plugins/vfs-index/repository/pdf.ts:126 | UPDATE files | 候选已修待复核；`7f827f303`：error 分支归同 owner。 |
| X6-SW-0202 | host/plugins/vfs-index/repository/pdf.ts:131 | UPDATE files | 候选已修待复核；`7f827f303`：进行中 started_at 分支归同 owner。 |

#### SW 新基线关联

SW 重扫关联：固定 main `4525e11ac`，X6刷新 `1c8239f67`，报告读取 ref
`b8a466a20cd9aaf05121193cdd329e0e2649e137`。以下17个原报告写点关联旧ID，旧基线/修复
SHA保留在上表；这是新固定main的存量，不表示最新候选仍保留每条SQL。

| 新报告位置 | 操作 / 表（vfs库，owner=L11） | 关联旧ID / 当前候选 |
|---|---|---|
| host/plugins/vfs-index/repository/index-content.ts:296 | INSERT vfs_index_units | X6-SW-0154，精确创建owner待发布。 |
| host/plugins/vfs-index/repository/index-content.ts:322 | INSERT vfs_index_segments | X6-SW-0155，旧placeholder owner待发布。 |
| host/plugins/vfs-index/repository/index-content.ts:341 | UPDATE vfs_index_units | X6-SW-0156，保指定时刻的owner接口待发布。 |
| host/plugins/vfs-index/repository/index-content.ts:383 | INSERT __lance_orphan_queue | X6-SW-0161，clearEmptyTextIndex同事务接口待发布。 |
| host/plugins/vfs-index/repository/index-content.ts:396 | DELETE vfs_index_segments | X6-SW-0162，同上。 |
| host/plugins/vfs-index/repository/index-content.ts:402 | UPDATE vfs_index_units | X6-SW-0163，同上，保非primary required单元pending。 |
| host/plugins/vfs-index/repository/index-content.ts:456 | UPDATE __lance_orphan_queue | X6-SW-0164，owner重试更新接口待发布。 |
| host/plugins/vfs-index/repository/index-segment.ts:14 | DELETE __lance_orphan_queue | X6-SW-0166，owner出队接口待发布。 |
| host/plugins/vfs-index/repository/index-state.ts:136 | INSERT vfs_indexing_config | R12-03.setConfig候选清理3e087ab85/185b88eb9：删除TS测试专用副本；实际L13b命令继续用L11 owner。旧011914371无此数字ID，不冒用SW-0172。 |
| host/plugins/vfs-index/repository/index-state.ts:136 | REPLACE vfs_indexing_config | 同上，原操作记录保留，不新编ID；不能为清扫描指标接回未使用副本。 |
| host/plugins/vfs-index/repository/index-units.ts:203 | INSERT vfs_index_units | X6-SW-0175，ensurePrimaryUnit精确owner待发布。 |
| host/plugins/vfs-index/repository/index-units.ts:222 | INSERT vfs_index_units | X6-SW-0176，当前insertUnit仅定义/unused import，待可达性清理，不标Rust obsolete。 |
| host/plugins/vfs-index/repository/index-units.ts:243 | UPDATE vfs_index_units | X6-SW-0177，候选80cf53a42已委托setIndexProfile；R12-09的Segment精度另待9006。 |
| host/plugins/vfs-index/repository/index-units.ts:259 | UPDATE vfs_index_units | X6-SW-0178，带embeddingDim的窄owner接口待发布。 |
| host/plugins/vfs-index/repository/index-units.ts:266 | UPDATE vfs_index_units | X6-SW-0179，21e8175c2已委托；R3 job154913-89292e确认此子项，不等additional错误策略已签。 |
| host/plugins/vfs-index/repository/index-units.ts:293 | UPDATE vfs_index_units | X6-SW-0181，批量状态owner待发布。 |
| host/plugins/vfs-index/repository/index-units.ts:309 | UPDATE vfs_index_units | X6-SW-0182，批量failed+清维度owner待发布。 |

### UD：2 项

| 稳定 ID | 原位置（源码基线 2ee9a9cbe） | 原表达式 / 当前状态与修复 SHA |
|---|---|---|
| X6-UD-0089 | host/plugins/vfs-index/src/pdf-service.ts:153 | `PdfProcessingService.getStatus`：`JSON.parse(progressText) as ProcessingProgress`。候选已修待复核：`e1ccaf456` 初始结构检查；`2b1fc7217/26b85c095` 接已main的F4流式Reader，补词法整数/重复字段/alias/序列/default/f32/大整数回写与状态快照；生产 getStatus/OCR回写 Node/Electron各40例通过。L13b内部DTO与F5出站nullable契约接面仍待集成（B12-10/11），不整项签收。 |
| X6-UD-0090 | host/plugins/vfs-index/src/search-service.ts:269 | `enrichAndFilterResults`：`JSON.parse(resource.metadataJson) as Record<string, unknown>`。未修，SHA —；当前仅检查 title string，不等于 Rust ResourceMetadata typed 解码。Rust indexing.rs:5014-5027 保留非空 title 原文，当前还 trim 输出；需核完整 metadata 解码/失败策略后补最小真实搜索入口测试，不按字段数或扫描计数签收。 |

### AP：3 项（计数线索已逐断言核对，未为计数改测试）

| 稳定 ID | 原位置（源码基线 2ee9a9cbe） | 原报告 / 当前逐语义结论、修复 SHA |
|---|---|---|
| X6-AP-0453 | host/plugins/vfs-index/tests/lance-vector-store.test.ts:106 | `rows_to_retrieved_input_dedup_semantics`：Rust 3 assertions（0 cfg-gated）> TS 1 expects；Rust `src-tauri/crates/dstu-vfs/src/lance_vector_store.rs:4689`；ID `crates/dstu-vfs/src/lance_vector_store.rs::tests::rows_to_retrieved_input_dedup_semantics`。候选非缺失断言：原 L4703-4705 的长度2、首(c1,.9)、次(c2,.7)由当前 L120-123 完整数组 toEqual 一并验证；SHA —（无需修复，待 R 复核分类）。 |
| X6-AP-0454 | host/plugins/vfs-index/tests/retrieval-planner.test.ts:116 | `rrf_fuses_same_unit_without_comparing_raw_scores`：Rust 4 assertions（0 cfg-gated）> TS 3 expects；Rust `src-tauri/crates/dstu-vfs/src/vfs/retrieval_planner.rs:1321`；ID `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::rrf_fuses_same_unit_without_comparing_raw_scores`。候选非缺失断言：Rust L1337-1340 的 hit数/provenance数/两原始分数与当前 L118-120 一一对应，最后两项合并为数组 toEqual；SHA —，待复核分类。 |
| X6-AP-0455 | host/plugins/vfs-index/tests/retrieval-planner.test.ts:157 | `mmr_diversifies_across_resources`：Rust 4 assertions（0 cfg-gated）> TS 3 expects；Rust `src-tauri/crates/dstu-vfs/src/vfs/retrieval_planner.rs:1492`；ID `crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::mmr_diversifies_across_resources`。候选非缺失断言：Rust L1504-1506 长度2、首a、次b对应当前长度与 ['a','b'] 完整数组；L1522-1524 全a对应 every(...).toBe(true)；SHA —，待复核分类。 |

#### AP 新基线关联

AP 重扫关联（报告 `a07019791e219c91f89fc3960ef5644846486b94` / main `8d7b05d14`）：
沿原 Rust ID 关联，不修改上方旧基线位置，不创建或重排稳定编号。

| 原 Rust ID | 原稳定 ID | 新报告位置 | 沿用的逐断言证据 |
|---|---|---|---|
| crates/dstu-vfs/src/lance_vector_store.rs::tests::rows_to_retrieved_input_dedup_semantics | X6-AP-0453 | host/plugins/vfs-index/tests/lance-vector-store.test.ts:114 | 完整数组 toEqual 同时约束长度2、首(c1,.9)、次(c2,.7)，对应 Rust 三断言。 |
| crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::rrf_fuses_same_unit_without_comparing_raw_scores | X6-AP-0454 | host/plugins/vfs-index/tests/retrieval-planner.test.ts:116 | hit长度1、provenance长度2、rawScore完整数组对应 Rust 四断言。 |
| crates/dstu-vfs/src/vfs/retrieval_planner.rs::tests::mmr_diversifies_across_resources | X6-AP-0455 | host/plugins/vfs-index/tests/retrieval-planner.test.ts:157 | 长度2、完整资源数组[a,b]、pure relevance每项a对应 Rust 四断言。 |

三项仍为语义候选，无需重复 expect/新修复 SHA；等待独立复核分类。PR 确定不可达才按
新规则降测试A，unknown不降；不从 AP 数量自动改变 TESTMAP 或命令状态。

### LP：12 项（文件级计数不等于分支缺陷清单）

| 稳定 ID | 原位置（源码基线 2ee9a9cbe） | 原报告 / 当前状态与修复 SHA |
|---|---|---|
| X6-LP-0279 | host/plugins/vfs-index/index.ts:1 | lance_vector_store.rs：Rust warn! 24 > TS warn 3 across 4 citing files。待逐分支审读；现 src/chat-embeddings.ts 与 legacy-kb-store.ts 有路径/优化日志，但不能按引用文件数认定全部覆盖；SHA —（无整组修复）。 |
| X6-LP-0280 | host/plugins/vfs-index/index.ts:1 | lance_vector_store.rs：Rust error! 4 > TS error 2 across 4 citing files。待逐分支审读；chat-embeddings.optimizeTableGroup 已 error 后继续，open_table 原本静默跳过不加伪日志；SHA —（无整组修复）。 |
| X6-LP-0281 | host/plugins/vfs-index/repository/index-content.ts:1 | indexing.rs：Rust warn! 50 > TS warn 24 across 9 citing files。部分候选：`ea5ccf9ee` 补条件/图片/合并 OCR cache warn并继续，生产 full-indexing 传 logger；原 unitSync warn 已在实际分支。其余须逐 Rust warn 核对，组未关闭。 |
| X6-LP-0282 | host/plugins/vfs-index/repository/index-content.ts:1 | indexing.rs：Rust error! 7 > TS error 2 across 9 citing files。待逐 error 分支核对；full-indexing.indexQuestion 两 error 现有，不因文件重分拆推定其余缺失或覆盖；SHA —。 |
| X6-LP-0283 | host/plugins/vfs-index/repository/index-units.ts:1 | lance_store.rs：Rust warn! 9 > TS warn 4 across 4 citing files。待逐分支核对；建索引 warn 在 lance-tables.ts，不能只检 repository/index-units.ts；SHA —（无整组修复）。 |
| X6-LP-0284 | host/plugins/vfs-index/api.ts:1 | multimodal_service.rs：Rust warn! 10 > TS warn 3 across 4 citing files。待逐分支核对；实际 batch/cleanup/rollback 日志在 src/multimodal-service.ts，api 再导出不是日志证据；SHA —（无整组修复）。 |
| X6-LP-0285 | host/plugins/vfs-index/repository/pdf.ts:1 | pdf_processing_service.rs：Rust warn! 63 > TS warn 2 across 3 citing files。部分候选：`3da610c19` 已补不可重试 stage warn；实际各 native 阶段 warn 在 pdf-runtime.ts，63条需按分支/平台/owner交接核对，组未关闭。 |
| X6-LP-0286 | host/plugins/vfs-index/repository/pdf.ts:1 | pdf_processing_service.rs：Rust error! 9 > TS error 1 across 3 citing files。待逐分支核对；src/pdf-service.setError 的实际 error 不等于整文件9条闭合；SHA —。 |
| X6-LP-0287 | host/plugins/vfs-index/index.ts:1 | commands.rs：Rust warn! 18 > TS warn 1 across 1 citing file。此文件跨多 lane，L12仅拥有3个命令；clear_message_embeddings 的无匹配 warn 原分支已保留，`e1ccaf456` 移入 src/commands.ts。先核本lane所有权与原分支，不要求补其他命令17条。候选范围误报待复核。 |
| X6-LP-0288 | host/plugins/vfs-index/index.ts:1 | commands.rs：Rust error! 26 > TS error 1 across 1 citing file。L12所拥有 clear_message_embeddings 的 Lance失败/DB标记失败两 error 均在 src/commands.ts，`e1ccaf456/09e88243a/2e9acd132` 提供 kernel 日志顺序/传播测试；其他命令日志不归本lane。候选局部已修/范围需纠偏，待复核。 |
| X6-LP-0289 | host/plugins/vfs-index/LANE.md:1 | plugin total：Rust warn! 178 > TS warn 40。聚合候选，不能从差值新增138条日志；状态继承逐模块 LP-0279/0281/0283/0284/0285/0287，尚未整组复核；SHA —。 |
| X6-LP-0290 | host/plugins/vfs-index/LANE.md:1 | plugin total：Rust error! 46 > TS error 5。聚合候选，包含跨lane commands计数；状态继承 LP-0280/0282/0286/0288，尚未整组复核；SHA —。 |

PR=0（原报告无本插件 PR 候选，不新增编号）。后续修复提交携本表稳定 ID 与对应 R12
finding，按实际入口测试/事务/日志证据更新当前状态；不重排编号、不用机械计数降 A。

## v2 接手盘点（2026-11-04，新会话）

### 增量证据（以此覆盖下方旧会话状态）

**D10根依赖到位后的复验**：已正常merge含D10的main，F7生产encode-worker仍为
pngjs/jpeg-js，解析路径为共享root node_modules；原两文件Node `20261104155007-dafcd7`
和Electron `20261104155007-467a6f` 均 **7 passed、exit0**，原PNG/JPEG/768尺寸/图像
就绪与回填断言全保留。日志仅WASI ExperimentalWarning，无Errors/Unhandled或
GLib-GObject-CRITICAL。旧缺包条件解除，不外推D5 PSNR/三平台或整R12-01。
R3 `20261104154913-89292e` 1pass/28过滤确认SW-0179 owner委托子项；新发现
R12-06.additional-unit的warn/状态失败策略已形成候选：`8e0d6dfd3`包含真实UPDATE
trigger两分支回归，Node `20261104162455-0c2ec3` / Electron `20261104162455-94c89c`
各2文件34 passed、exit0；补强trigger原始错误检查后，`20261104164333-4a174c` /
`20261104164333-00825c` 各2 passed/29按-t过滤、exit0。普通Other错误即使含文字
INVALID_STATE也只warn后继续；真实InvalidState保原error对象，状态写失败不掩盖它，
已提交primary不被外层catch误重排，第三Unit仅普通失败时继续。SPEC列明Rust分支；
该候选待R3独立复验，不借owner子项签整组。typecheck162455-37afb5仍仅L13b旧DTO
两处TS2322（修复候选f6a9907e2未main），不称全仓绿。

**后发协调裁定（15:29）**：D10撤回F7 `9252ace96` 的sharp编码切换，正式依赖是
pngjs@7.0.0/jpeg-js@0.4.4，由架构师安装；L12已经委托正式API，不改回并行实现，
保留原图片失败断言直至root依赖/正式F7集成后复验。F4 `0fb54cdde` f32ToJsonNumber
候选已获提供方门禁/最小向量证据，待main后只接共享snapshot投影点，不能用于输入或
内部运算；nullable成功响应契约仍由contract owner处理，R12-08组保持未签。

**R12-08 / X6-UD-0089 reader 消费**：F4 reader已随正常 main `6a7715d6e`到位，
ProcessingProgress/Issue不再经JSON.parse类型断言。Node `20261104142353-b18abd`、
Electron `20261104142353-03dd4f` 各4文件40 passed，exit0，无Errors；包括同名重复、
alias冲突、整数词法、usize全精度回写、struct数组形式、整数→f32直接舍入与非有限
f32出站null。新补SQLite状态时间i64精确读亦在定向验证。typecheck先暴露本lane
hasRetriableFailure参数过窄，已改为接受内部/快照DTO；L13b两处generated DTO引用错误
已交owner，不能靠Number或类型强转消除。F5 percent出站nullable差异单列B12-11。
Preview reader仍是自有后续工作，不再声称缺F4接口。R12-09和图片根依赖状态独立保留。

新增 i64 时间边界：`20261104143616-181f33` / Electron `20261104143616-ad6257`
各2文件23 passed，exit0。真实 invoke 回归 `tests/pdf-status-wire.test.ts` 安装全部
真实业务 provider；`20261104144632-f9f5ec` 为2 passed/1 failed，exit1：普通25及
usize/i64内部bigint→wire number成功，仅非有限f32的null被当前输出schema拒绝。
R3回执 `20261104142645-d02d0a` 确认reader/序列化子链，不包含OCR owner原子行为；
其wire探针 `20261104143042-824c5b` 同样发现null契约缺口，组不关闭。
L13b DTO import 已有候选 `f6a9907e2`（已通知C2正常集成），不再按旧树报其未修。
本轮还亲读固定Cargo/serde_json源码，有限f32的最短十进制出站另需F4窄投影helper，
与null契约子项分开，未把当前有限f32快照外推为完整wire等价。

**R12-09 联合集成候选：main-ready（仅指可交联合门禁，非已签收）**。
消费者固定提交 **`5aaf3bc8a`** 与 L11 **`9006bc168`** 应同批集成：该消费者提交已含
`VfsIndexSegment.generation: number | bigint`、next 返回 bigint、text/mm完整写链及
三个 R12-09 公开入口回归，避免先合 L11 时旧消费者 number 签名 TS2322。
亲读固定提交及其与当前 HEAD 的相关实现 diff，generation 链无后继缺补（差异仅
另一个 SW-0179 状态写委托）。主线反例215passed/3failed是旧 owner 证据，联合新 owner
尚待正常集成后验证。**不要将较新图片接线缺 pngjs/jpeg-js 的整棵 HEAD 误报全绿**；
图片单元另有真实失败证据，未回退其源码或跳过测试。已告 C2/L11 精确消费者 SHA。

**13:17 F3/F7 图片正式接线**：随后一次正常 merge main 带入 F7 NativeImage/vector
provider。已删 `src/image-codec.ts`；PDF RGBA→PNG 走 nativeImage.encode，图片/页压缩
走 imageQuality.adjustImageQualityBytes(...,nativeImage)，依赖每次调用时解析。
LanceVectorColumn 复用正式 F7 VectorColumn 类型；F1 profile 仍缺 dstu.vector。
typecheck `20261104131754-bf23c9` exit0；两文件最小测试 `20261104131754-c64c0a`
3 failed / 4 passed，exit1。真实插件入口定位作业 `20261104132400-895c66` 1 failed /
1 按 -t 过滤，exit1：状态中 page_rendering 精确报 `Cannot find module 'pngjs'`，
Require stack 为 F7 `native/image/encode-worker.mjs`。jpeg-js 的 root 解析同样失败。
两依赖已交 C2/F7，未自行安装、未恢复本地编码器、未 skip 或改弱图像断言。
F3 JPEG 真组合与 D5 PSNR 仍 pending，不把接口到位等同于运行能力已过。

**13:03 接缝交接**：L11 `9006bc168` 已发布 R12-09 owner generation 修复，F4
`2d9d56497` 已发布流式 JsonReader；两者经祖先检查仍为候选、未 main。已请求 C2 正常
集成，未复制 provider/未混合树；到位后复跑既有 R12-09 三例并接 typed PDF 解码。
等待期间完成 X6-SW-0179（`21e8175c2`），作业 `20261104130259-460b8c`（Node）与
`20261104130345-436f35`（Electron）均 1 passed / 28 按 -t 过滤，exit0；typecheck
`20261104130259-7e112f` exit0。未运行新的全量测试，未把该局部通过算成 R12-09 通过。

**12:07 后优先项 R12-09**：已按 C2/R3 §6 的真实反例把 next→pipeline→Lance→Unit
改为精确 bigint，并增补公开服务完整 text/mm 写链测试；目前真实 L11 Segment owner
仍舍入，`20261104120704-aeeb2a` 2 failed，exit 1。因此下列 213 passed 只代表
R12-09 回归加入前的已保存单元，**不是当前分支全绿**。i64::MAX 独立用例也已补，
待 L11 精确 generation 公开实现合 main 后复验；请求与证据在 BLOCKERS B12-08。

新 standard-v2 §5 收尾：提交自己文件→merge main→lane-gate；当前开工即存在的
范围外 migration 生成物 dirty 会触发 gate exit2，已交 C2（B12-09），不自行还原。

12:15 主线合并后的 typecheck 作业 `20261104121518-931af5` exit0；全 lane
`20261104121518-2e26d3` 已返回 **24文件：23 passed / 1 failed；218测试：215 passed /
3 failed，exit1**。全部失败均为 R12-09 的真实 Segment 精度断言；Lance、Unit 与 mm
metadata 前置断言通过。i64::MAX 也被 owner 写成 9223372036854776000 number。
普通 boundaries `20261104121518-cbf4cd`：2434 files、0 violations、exit0。
已补充通知 L11；缺 owner fixture 的旧集成错误本次未再出现。
F7 后发通知恢复 diagnostics 必需：本 lane 两个 Pdfium fixture 已补该方法，意外调用
会明确失败，未放宽正式 NativePdfium 契约，也未改 F7 文件。

- 固定树 `e004f9ec1`（main 含 L18/L11）作业 `20261104103823-6f8851`：
  22 文件 201 passed，exit 0，无 Errors；C2 已亲取并接受，原集成失败的两个文件都绿。
  旧集成日志仅保存标题，缺堆栈与依赖 SHA，C2 已上报基础设施保全；不猜测首错。
- R12-08：新增公开 `vfsIndex.pdf.getStatus` 入口的非法 optional usize、重复 alias、
  retriable 缺省/非法 null、可选字段省略测试；作业 `20261104105424-a46238` 3 passed exit 0。
- R12-06 / 入口：命令业务已移入 `src/commands.ts`，恢复删除成功 info 与零优化 debug。
  原命令断言保留，新增日志顺序/级别测试；定向 Node `20261104110601-5f5605` 与
  Electron `20261104110743-72bf8d` 均 14 passed exit 0。此前全量作业
  `20261104110004-4b9c39/76869e` 为 206 passed / 1 failed exit 1：新 debug 用例
  未开启 logger exporter，现已启用 debug 收集，未弱化断言。
- R12-03：删除 resource state/profile/ANN/维度计数的 standalone SQL fallback；
  真实 L11 provider 绑定进索引、Lance、检索测试；事务句柄继承并 finally 恢复 owner。
  作业 `20261104112221-2880c1`：23 文件 208 passed exit 0，无 Errors；typecheck
  `20261104112221-3a5d14` exit 0。随后继续把已发布的 Unit/Segment 写入委托 owner，
  精确 primary/placeholder/批量状态与 bigint 接口缺口见 BLOCKERS（已 escalate）。
- R12-01：L18 正式 provider 已 main，新增真实 L12 调度→L18 导入字幕→L11 持久化测试，
  `20261104112412-6f8bcf` 1 passed exit 0；没有替换 scheduler/transcriber/indexer。
  L13 完整 `mediaIndex/unitIndex` 是**候选已发布待集成**，三 lane 刷新链仍 pending。
- v2 运行时：Rust `lance_store.rs:2446-2462` 用 Instant 节流；已将 maybeOptimizeAll
  改为 performance.now，补墙钟前跳/后跳不影响节流的测试。
- importable `20261104110743-cd072c` exit 0；wiring `20261104110743-95c326`：
  `合计 ported 79，其中所测模块未从 index.ts 接入 0（0.0%）`。
- strict `20261104110004-afd946` exit 1，四项均在其他 lane 的 `host/plugins/vfs/repository/`
  （create:41、folders:22、resources:126、update:33），本 lane 无 violation；不算全仓通过。
- preview 必填/类型/default 解码与检索 Instant 时钟已补，定向作业
  `20261104113547-daa3d6` 12 passed exit 0。OCR 阈值改为 Rust usize 完整字符串解析，
  大 u64 保持 bigint，`20261104114029-442f47` 5 passed exit 0。
- **本轮完整验证**：Node `20261104114258-dbba33` / Electron
  `20261104113723-bc0540` 都是 24 文件 **213 passed，exit 0，无 Errors**，包含
  全部真实 owner 夹具、preview、单调时钟与 L18 持久化新增用例。
- 未完成：精确 JSON 数字词法/同名重复键（已向 C2 请求 F4 公共 decoder，B12-07）、
  BLOCKERS 列出的精确 owner/native/embedding 接缝。TESTMAP 旧 79/79 不能替代 v2 签收。

接手基线 `b38b8cdb9`，已合并 main。以下为本次亲读结论，旧 ledger 的 A 不代表 v2
签收。`ACCEPTANCE.md` 在此分支/main 缺失，以派发中的 R12-01…08 和两条补充项为
复核输入；不创建或修改复核人文件。开工的 `migration/LEDGER.md`、`migration/ledger.json`
已有未提交改动，不纳入本 lane 提交。

类型编号对应 standard-v2 §1：①生产接线 ②单写者 ③serde/精度 ④日志错误
⑤真实测试 ⑥完整分支 ⑦运行时 ⑧复验闭环。以下路径相对本插件，R 为 Rust。

| 命令/服务 | 八类自查结果与证据（未复验不计完成） |
|---|---|
| `clear_message_embeddings` | ①⑤ kernel 测试 `tests/commands.test.ts`；② `repository/chat-lance.ts:129` 直接写聊天表，需确认 L04/F3 owner；③ bigint 解析 `index.ts:39`；④ Lance error 日志已补 `index.ts:123`；⑥ 空输入、stable 查询、建 store 失败、DB best-effort 分支均存在 `index.ts:77-135`；⑦ KB 锁在 `src/chat-embeddings.ts`；⑧ 待复验，入口业务仍须移入 src。 |
| `optimize_chat_embeddings_table` | ①⑤ 同上；② settings 写入仍本地 `repository/chat-lance.ts:96`；③ 参数经 kernel；④⑥ open-table 跳过已补 `src/chat-embeddings.ts:211-226`，命令成功日志待与 R commands.rs:2101 核对；⑦ 时间戳与 KB 锁已有实现；⑧ 待复验/入口拆分。 |
| `optimize_lance_database` | ①⑤ kernel 调用；② 无写入；③⑥ 固定结果与 Rust 6898-6910 相同 `index.ts:237`；④⑦ 无日志/取消/计时；⑧ 待复验。 |
| `lanceEngine` / `vfsIndex.lance` / legacy KB | ① 生命周期绑定 `index.ts:179`；② `repository/embedding-dim.ts:541-639`、`index-units.ts:203-570` 仍有 owner 缺失时本地写入；③ generation bigint 已有，配置 JSON 待逐结构查；④⑥ R12-07 跳过 open_table 已补 `src/lance-store.ts:714-797`；⑤ tests/lance-store.test.ts；⑦ `maybeOptimizeAll:702` 使用墙钟，需对照 R；⑧ F7 未合 main，不能宣称真实 Lance 链已验。 |
| `retrieval` / search / fullSearch | ① `index.ts:193,219`；② 读路径；③ 完整配置已传递 `src/runtime-adapter.ts:103-120,320-343`；④⑥ rerank 已接失败 warn 路径但无 provider `runtime-adapter.ts:395-410`；⑤ tests/retrieval-service.test.ts；⑦ 路由超时/熔断时钟待继续审读；⑧ R12-02/04/05 待复验。 |
| `vfsIndex.indexing` / embedding | ① unitSync/OCR 已注入 `runtime-adapter.ts:447-465`；② `repository/index-state.ts:277-509` 等仍存在 SQL fallback，R12-03 未修完；③ settings 数值用 parseInt `runtime-adapter.ts:254` 不等同 Rust parse；④⑥ 已有重试与 unit-sync 日志，缺 owner 缓存静默跳过仍需处理；⑤ tests/index-service.test.ts；⑦ 同步 IO/时钟继续审；⑧ 缺真实 embedding transport。 |
| `vfsIndex.multimodal` | ① `runtime-adapter.ts:467` 注入 embedding；② unit/segment fallback 同上；③ 完整 VL transport 配置 `runtime-adapter.ts:368-377`；④⑥ 批处理失败恢复已有生产用例 `tests/unit-maintenance.test.ts:217`；⑤ 部分链使用依赖替身不能证明跨插件闭合；⑦ generation 已保持 bigint；⑧ 等 L02/F7 集成复验。 |
| `vfsIndex.pdf` | ① NativePdfStageRuntime 已接 `index.ts:218`；② PDF setters 已 owner 必需 `repository/owners.ts:109`；③ R12-08 仍有缺陷：`pdf-processing.ts:22-25` 将非法 optional usize 当缺省、`:18-20` 接受重复 alias；④⑥ 不可重试 warn 已补，媒体依赖待 main；⑤ tests/pdf-service.test.ts；⑦ compression finally 释放 slot `pdf-processing.ts:160-177`，本地 PNG/sharp 策略未等价；⑧ R12-01/08 待复验。 |
| `vfsUnitBuilder` / `vfsIndexMaintenance` | ① `index.ts:207-208`；② 调用 L11 owner；③ unit-source 的规范题库上下文仍近似，需 L11 API；④⑥ reset/sync/delete 分支 `src/unit-sync-service.ts:103,219`；⑤ 真实 L11 插件测试 `tests/unit-maintenance.test.ts:60`，旧失败已由 `d4a13dbc5` 补 paths 修复；⑦ 事务回滚测试 `:178`；⑧ 合并 main 后队列复跑。 |

处理顺序：先复现集成门禁；R12-08 补严格解码及生产状态入口回归；入口业务移入 src；
R12-03 删除 owner fallback 并改为真实 owner 测试；R12-06/07 对照遗漏日志/best-effort；
R12-02/04/05 核对现有修复与真实提供方。R12-01 的 F3/F7/L02/L18 接缝以 main 为准，
缺接口记 `BLOCKERS.md` 并上报，不以本地替代实现签收。修复提交均标 finding ID。

初始队列：typecheck `20261104094322-ea66f2`；全 lane 测试 `20261104094325-2cc686`；
boundaries `20261104094325-d28808`。结果待取，不沿用旧会话绿灯。

- 2026-11-04：按 Q4 表所有者交接发布 `vfsUnitBuilder`（`syncResourceUnits`）与
  `vfsIndexMaintenance`（`resetUnitIndex`/`deleteResourceIndex`），并补
  `vfsIndex.multimodal.processPendingBatch`；详见 SPEC「Q4 表所有者写操作交接（L12 部分）」。

## 当前状态与下一步（2026-11-04 续作会话）

已合并 `main`（`a5f01a944`）。ledger 本 lane 3/3 命令 A、79/79 Rust 测试 A，无 pending 行。

已完成：

- 3 个命令、7 个事件、`lanceEngine`/`retrieval`/`vfsIndex` 服务与 L02/L11/L18 接线。
- F7 vector 精确适配：`createTableWithSchema` 全 schema、`openTable` 缺表转 null、
  `query/search/fullTextSearch` 原始分数映射、`optimizeAll` 只做 all、缺失能力显式失败。
- C2 08:11 两项：`repository/pdf.ts` 的 owner→本地 SQL fallback 已删除，缺 setter 明确
  报 pending；`lance-engine.ts` 的 `generation` 保持 `bigint` 精确，`chunk_index` 按
  int32 独立校验，并有真实大 generation 测试。
- 条件 OCR 缓存按 Rust 语义改为只调用 L11
  `saveOcrTextIfEmptyWithConn`（缺失时 best-effort 跳过），不拼 `getOcrText`+`saveOcrText`。
- 图片 OCR 缓存（Rust `indexing.rs:3354/3949` 不写 `updated_at`）改为只调用 L11
  `saveOcrTextWithoutTimestampWithConn`，缺失时跳过；不再用会写 `updated_at` 的
  `saveOcrText` 代替。
- VFS 启动恢复 reset（Rust `indexing.rs:1978-2046`）按 C2 08:35 归 L11：L12 只保留
  `recoverStuckIndexing` 调度入口，调用 `maintenance.recoverStuckIndexingWithConn`；
  缺失时返回 0，不再保留第二份 `vfs_index_units`/`resources` reset SQL。

剩余（均有证据，非本 lane 可单独完成）：

1. **F3 图片策略/F7 原生编码**（C2 08:23 接缝）：F3 分支 `5bed80423` 已在
   `host/platform/storage/api.ts` 发布 `ctx.imageQuality.adjustImageQualityBytes(
   bytes, visionQuality, ctx.nativeImage)`（`ImageQualityCodec = dimensions +
   resizeAndEncodeJpeg`）；F7 分支已发布 `NativeImage.encode`/
   `resizeAndEncodeJpeg`。两者都尚未进入 main：main 的 `storage/api.ts` 无
   `adjustImageQualityBytes`，`native/image/api.ts` 仍只有 `dimensions`/`decodeRgba`。
   合入前 `src/pdf-runtime.ts` 仍走本地 `src/image-codec.ts`，**不算等价**；合入后
   删除该平行策略/编码器。D5 像素 PSNR 未验。
2. **L11 owner 缺口**（main `7b7136676` 已合入 PDF/媒体 setter；以下新方法仍未发布）：
   `resources.saveOcrTextIfEmptyWithConn`、`resources.saveOcrTextWithoutTimestampWithConn`、
   `maintenance.recoverStuckIndexingWithConn`、`files.setExtractedTextByResource`、
   `questions.canonicalContext`。当前分别跳过缓存 / 跳过缓存 / 返回 0 / 记录待回写 warn /
   用 `source_refs` 近似，R12-03 保持 pending。另：`indexing.rs:3778` 的
   `datetime('now')` 与 main `saveOcrText` 的毫秒 `updated_at` 表示不同，暂用 owner
   setter 保留缓存并记为未等价项，待精确 WithConn 版本。
3. **F7 `vector` provider / F1 profile**：`vector` 仍未进 main，L12 用
   `optionalService` 探测；F1 需生成 `dstu.vector` profile 后才能宣称 main 可消费。
4. **L18 `mediaTranscriber`（候选已发布待 main）**：L18 责任分支 `fdb013829`/
   `cadffc2e7` 已发布 `MediaTranscriberCordisService`，签名与本 lane `api.ts` 的
   `transcribe({fileId,tempDir,imported,signal,onProgress}) →
   {transcriptChars,doneSegments,totalSegments,failedSegments}` 一致，并在
   `index.ts` provide `mediaTranscriber` + 注册 `media_transcribe_start`。main 到位前
   `pdf-runtime.runMedia` 仍明确失败；合入后直接接真实转写，`refresh_transcript_index`
   归 L13、最终 `indexResource` 归本 lane，不复制 ASR/持久化。
5. **VFS 启动恢复 reset（C2 08:35 归 L11）**：`VfsFullIndexingService.recoverStuckIndexing`
   只保留调度入口，已改为调用 L11 `maintenance.recoverStuckIndexingWithConn(conn, at)`；
   该方法未发布时返回 0，不再写第二份 `vfs_index_units`/`resources` reset SQL。L12 继续
   负责 Lance 目录清理与调度顺序。

下一步顺序：先确认本轮 typecheck/vitest 作业为绿并提交文档；再按 C2 指令逐项复核
F3/F7、L18、L11 是否已合入 main。F3/F7 到位后接 `ctx.imageQuality` +
`ctx.nativeImage` 并删除本地编码器；L18 到位后直接接真实转写；L11 到位后接
`saveOcrTextWithoutTimestampWithConn` / `recoverStuckIndexingWithConn` /
`setExtractedTextByResource` / `canonicalContext`。未到位时保持上述证据，继续核对
本 lane 自有实现与 Rust 的差异（不做跨 lane fallback、不装依赖）。

复核反馈：本目录没有 `ACCEPTANCE.md`；C2 的两轮“必须修复”已分别处理（SQL fallback、
generation 精度、条件 OCR 语义）。F3 图片接缝按最新指令保留为待集成，不把本地实现
写成等价。

### 本轮验证（2026-11-04）

- typecheck：作业 `20261104090233-8ea46f`，`npm run typecheck:host` 退出码 0。
- 本 lane 测试：作业 `20261104090233-df4e61`，22 个文件 201 passed，退出码 0。
- Electron 本 lane 测试：作业 `20261104090716-d8442f`，22 个文件 201 passed，退出码 0。
- 中断记录：`20261104090233-*` 之前一次同命令作业 `20261104090141-ceb4fa` /
  `20261104090141-6b21f1` 因作业执行器重启被中断（退出码 -1），随后已重提；
  更早的 `20261104084140-570af1` 为 198 passed 退出码 0。
- **集成门禁修复**：main `7b7136676` 合入 L11 后，L11 `index.ts` 在启动时调用
  `paths.dataSpaceDeviceId()`；本 lane 的 `tests/support/paths-service.ts` 只提供了
  `deviceId()`，导致 integration gate 的 `unit-maintenance.test.ts` 全部失败。已补
  `dataSpaceDeviceId()`；`unit-maintenance`/`unit-source`/`multimodal-index` 17 passed
  （作业 `20261104090828-b2839b`，退出码 0）。
- 合并 main 后复跑：typecheck 作业 `20261104091032-361cef` 退出码 0；本 lane 全量
  22 文件 201 passed（作业 `20261104091032-a13786`，退出码 0）。
- wiring：`--lane vfs-index` 合计 ported 79，未接入 0（0.0%）。
- ledger：`problems: commands 0, tests 0, orphan registrations 0`（本 lane 3/3 命令 A、
  79/79 测试 A）。
