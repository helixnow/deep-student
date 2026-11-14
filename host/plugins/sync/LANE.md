# L20-sync：同步引擎

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L20-sync（同步引擎） |
| 目录 | `host/plugins/sync/` |
| Rust 范围（lanes.md） | dstu-sync 的 data_governance/sync、src 的 commands_sync |
| 主要提供 | `sync@1` |
| 主要消费 | F3、L23 |
| 特别注意 | 最高数据风险：协议锁、租约、增量格式、E2EE |
| 规模（本目录） | 36174 行 · 15 个文件 · 24 个命令（前端调用 24） · 263 个测试 |
| 规模（整条 lane，inventory） | 36174 行 · 15 个文件 · 24 个命令（前端 24） · 263 个测试 |
| 契约 | [`contracts/ipc/L20-sync.json`](../../../contracts/ipc/L20-sync.json) |
| 服务草稿 | [`contracts/services/DRAFT-L20-sync.md`](../../../contracts/services/DRAFT-L20-sync.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-sync/src/data_governance/sync/asset_filenames.rs` | 662 | 10 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/classification.rs` | 1455 | 3 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/conflict_resolver.rs` | 564 | 0 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/emitter.rs` | 482 | 3 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/field_merge.rs` | 780 | 25 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/history.rs` | 541 | 0 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/hlc.rs` | 110 | 4 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/mod.rs` | 18878 | 139 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/note_history.rs` | 732 | 5 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/pomodoro_counts.rs` | 673 | 8 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/progress.rs` | 607 | 11 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/state.rs` | 665 | 2 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/sync/tombstone.rs` | 3015 | 25 |  |
| `src-tauri/src/data_governance/commands_sync.rs` | 6956 | 27 | 24 |
| `src-tauri/src/sync_app_tests.rs` | 54 | 1 |  |

### 命令（24）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `data_governance_cancel_sync` | `src/data_governance/commands_sync.rs:2810` | async | app | src/api/dataGovernance.ts:1013 | (（无）) → boolean ! string |
| `data_governance_count_record_conflicts` | `src/data_governance/commands_sync.rs:4550` | async | app | src/api/dataGovernance.ts:1427 | (（无）) → RecordConflictCounts ! string |
| `data_governance_detect_conflicts` | `src/data_governance/commands_sync.rs:1280` | async | app | src/api/dataGovernance.ts:837 | (cloudManifestJson?: string \| null, cloudConfig?: CloudStorageConfig \| null) → ConflictDetectionResponse ! string |
| `data_governance_detect_prune_gap` | `src/data_governance/commands_sync.rs:5070` | async | app | src/api/dataGovernance.ts:1643 | (cloudConfig: CloudStorageConfig) → PruneGapResponse ! string |
| `data_governance_discard_all_quarantine` | `src/data_governance/commands_sync.rs:4351` | async | app | src/api/dataGovernance.ts:1584 | (（无）) → BatchQuarantineResult ! string |
| `data_governance_discard_quarantine` | `src/data_governance/commands_sync.rs:4256` | async | app | src/api/dataGovernance.ts:1567 | (databaseName: string, quarantineId: integer(i64)) → boolean ! string |
| `data_governance_export_sync_data` | `src/data_governance/commands_sync.rs:2368` | async | app | src/api/dataGovernance.ts:883 | (outputPath?: string \| null) → SyncExportResponse ! string |
| `data_governance_get_sync_status` | `src/data_governance/commands_sync.rs:1025` | async | app | src/api/dataGovernance.ts:826 | (（无）) → SyncStatusResponse ! string |
| `data_governance_import_sync_data` | `src/data_governance/commands_sync.rs:2570` | async | app | src/api/dataGovernance.ts:897 | (inputPath: string, strategy?: string \| null) → SyncImportResponse ! string |
| `data_governance_list_quarantine` | `src/data_governance/commands_sync.rs:4167` | async | app | src/api/dataGovernance.ts:1547 | (limit?: integer(u32) \| null, offset?: integer(u32) \| null) → SyncQuarantineRow[] ! string |
| `data_governance_list_record_conflicts` | `src/data_governance/commands_sync.rs:4406` | async | app | src/api/dataGovernance.ts:1398 | (limit?: integer(u32) \| null, offset?: integer(u32) \| null) → RecordConflictRow[] ! string |
| `data_governance_list_sync_snapshot_batches` | `src/data_governance/commands_sync.rs:5186` | async | app | src/api/dataGovernance.ts:1494 | (limit?: integer(u32) \| null) → SyncSnapshotBatchRow[] ! string |
| `data_governance_list_unsynced_items` | `src/data_governance/commands_sync.rs:5812` | async | app | src/features/settings/components/data-governance/UnsyncedItemsPanel.tsx:104 | (cloudConfig: CloudStorageConfig) → UnsyncedItemsReport ! string |
| `data_governance_mark_asset_deleted` | `src/data_governance/commands_sync.rs:4104` | async | app | src/api/dataGovernance.ts:1617 | (key: string, size?: integer(u64) \| null, cloudConfig: CloudStorageConfig) → null ! string |
| `data_governance_mark_blob_deleted` | `src/data_governance/commands_sync.rs:4062` | async | app | src/api/dataGovernance.ts:1601 | (hash: string, relativePath?: string \| null, size?: integer(u64) \| null, cloudConfig: CloudStorageConfig) → null ! string |
| `data_governance_purge_resolved_conflicts` | `src/data_governance/commands_sync.rs:5010` | async | app | src/api/dataGovernance.ts:1468 | (olderThanDays?: integer(u32) \| null) → integer(u64) ! string |
| `data_governance_repo_check` | `src/data_governance/commands_sync.rs:5150` | async | app | src/features/settings/components/CloudStorageSection.tsx:100 | (cloudConfig: CloudStorageConfig) → RepoCheckReport ! string |
| `data_governance_resolve_conflicts` | `src/data_governance/commands_sync.rs:1428` | async | app | src/api/dataGovernance.ts:852 | (strategy: string, cloudManifestJson: string) → SyncResultResponse ! string |
| `data_governance_resolve_record_conflict` | `src/data_governance/commands_sync.rs:4610` | async | app | src/api/dataGovernance.ts:1452 | (databaseName: string, tableName: string, recordId: string, resolution: string, mergedDataJson?: string \| null, expectedConflictIds: integer(i64)[]) → null ! string |
| `data_governance_retry_all_quarantine` | `src/data_governance/commands_sync.rs:4293` | async | app | src/api/dataGovernance.ts:1580 | (（无）) → BatchQuarantineResult ! string |
| `data_governance_retry_quarantine` | `src/data_governance/commands_sync.rs:4232` | async | app | src/api/dataGovernance.ts:1557 | (databaseName: string, quarantineId: integer(i64)) → boolean ! string |
| `data_governance_rollback_sync_snapshot_batch` | `src/data_governance/commands_sync.rs:5244` | async | app | src/api/dataGovernance.ts:1520 | (databaseName: string, batchId: string) → RollbackSnapshotResponse ! string |
| `data_governance_run_sync` | `src/data_governance/commands_sync.rs:1585` | async | app | src/api/dataGovernance.ts:869 | (direction: string, cloudConfig?: CloudStorageConfig \| null, strategy?: string \| null) → SyncExecutionResponse ! string |
| `data_governance_run_sync_with_progress` | `src/data_governance/commands_sync.rs:2858` | async | app | src/api/dataGovernance.ts:994 | (direction: string, cloudConfig?: CloudStorageConfig \| null, strategy?: string \| null) → SyncExecutionResponse ! string |

### 发出的事件（9）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `data-governance-sync-progress` | 常量 `EVENT_NAME` | crates/dstu-sync/src/data_governance/sync/emitter.rs:236 (emit) |
| `direction` | 动态（表达式） | src/data_governance/commands_sync.rs:857 (emit)<br>src/data_governance/commands_sync.rs:910 (emit)<br>src/data_governance/commands_sync.rs:962 (emit)<br>src/data_governance/commands_sync.rs:1010 (emit) |
| `progress` | 动态（表达式） | crates/dstu-sync/src/data_governance/sync/emitter.rs:164 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:178 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:192 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:227 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:323 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:360 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:380 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:389 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:398 (emit) |
| `SyncProgress { operation_id: None, outcome: None, phase: SyncPhase::DetectingChanges, percent: 5.0, current: db_index as u64 + 1, total: total_dbs, current_item: Some(db_id.as_str().to_string()), speed_bytes_per_sec: None, eta_seconds: None, error: None, }` | 动态（表达式） | src/data_governance/commands_sync.rs:3092 (emit) |
| `SyncProgress::completed()` | 动态（表达式） | crates/dstu-sync/src/data_governance/sync/emitter.rs:197 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:403 (emit) |
| `SyncProgress::detecting_changes()` | 动态（表达式） | crates/dstu-sync/src/data_governance/sync/emitter.rs:150 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:371 (emit) |
| `SyncProgress::failed(error.into())` | 动态（表达式） | crates/dstu-sync/src/data_governance/sync/emitter.rs:205 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:408 (emit) |
| `SyncProgress::failed(error.into()).with_outcome(SyncOutcome::Partial)` | 动态（表达式） | crates/dstu-sync/src/data_governance/sync/emitter.rs:210 (emit) |
| `SyncProgress::preparing()` | 动态（表达式） | crates/dstu-sync/src/data_governance/sync/emitter.rs:145 (emit)<br>crates/dstu-sync/src/data_governance/sync/emitter.rs:366 (emit) |

### 契约中的事件（1，`contracts/ipc/L20-sync.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `data-governance-sync-progress` | 否 | SyncProgress | crates/dstu-sync/src/data_governance/sync/emitter.rs:236 (emit) |
<!-- END GENERATED:lane -->

## 备注

### WP-004 · 2026-11-05

- 开始时工作树干净，正常 merge main 得 `12463c9ec`（main `967f43c75`）。`c2536fc6b` 已为 dstu.sync 显式 inject mastery；review 的真实 provider 仅 inject storage，无依赖环。
- `tests/mastery-integration.test.ts` 使用真实 review + sync + backup 与 SQLite 验证 IPC 导入、公开多库 apply、掌握度重建/删除恢复、错误及提交后副作用顺序。执行结果以 `WP-004-REPORT.md` 为准。
- TESTMAP 状态列实数 256 ported / 2 pending / 0 merged / 5 approved obsolete（本包不改去向）。memory/api.ts 已公开 merger，旧“缺 merger”阻塞解除；剩余消费/映射由后续包处理。F3 startup 公共接口已发布，D18 不重做。
- 历史 `ca99bb4f9` 的20个外域 fixture 冲突已按 C2 20:48 决议在 WP-179 窄恢复中收口：正常合并 main `c60c4bf4d` 得 `8216f80ca`，逐路径保留正式 owner 内容，20/20 blob 等于该 main，`main...8216f80ca` 外域净 diff=0。证据：`/tmp/opencode/l20-wp179-recovery-evidence.json`；原 WP-004 门禁证据仍见报告。

### WP-179 窄恢复 · 2026-11-05

- `8216f80ca` 保留原 `2088a21e8` 及 WP-004/077 全部历史；`api.ts`、`src/field-merge.ts`、公开面测试与原候选 blob 相同，`mergeField` 仍纯重导出同一生产实现。
- 原“等待 L23 提供这19个 owner 文件”前置解除：固定 main 的20个 blob 已与 L23 `804ca52c3` / L20b `58f68140f` 相同。完整门禁结果以本次 WP-179 交付报告为准，候选尚待 C2 正常集成。
- TESTMAP pending 保持2；L23 WP-032 八原 ID 仍 pending，WP-180 等待 WP-179 真实 main 后消费。

以下为历史记录，状态以本工作包报告及 TESTMAP 实际列为准。

### 2026-11-04 22:55 接管自检

- lane-gate（分支头 c1e4e70f1，base 306eb8bbb）：typecheck/boundaries/boundaries-strict/importable 通过；tests 仅新增失败1项 s03_delete_note_tombstone_sync_propagates，main 既有失败0项计入。
- s03 根因在 L10（notes.sync.updateInferredFormat 过滤软删笔记），修复 a38068281 尚未进 main。临时分离工作树合入 a38068281 后跑 realistic_scenarios_sync + business_tables_sync：40/40 通过（作业 20261104145242-f12882），未改 L23 测试。待 a38068281 进 main 后 merge main 重跑 gate。
- main 上 host/plugins/sync 的35项红灯全部是 `paths.dataSpaceDeviceId is not a function`（main 的 sync 测试夹具未提供 F4 新接口）；本分支 host-fixture/test-db 已提供，自检中这35项全部通过，随本分支合入即消除。

### 2026-11-04 架构师基线纠正：8项新增回归由L20负责闭环

撤回此前“L23既有失败/仅外lane夹具问题”的归因。架构师确认这8项在main通过、合入本分支才失败；文件属L23不改变L20对D7 apply行为与新增依赖的集成责任。指定两文件job `20261104135611-f99900` 原样复现8failed/32passed，未改测试。

具体证据与接缝见 `REGRESSION-8.md`：本分支新增syncSupport reader依赖使旧throwing输入实际进入；新增L10 inferred-format委托对soft-deleted笔记读语义不等价。两者均由本分支改动触发，不能以“owner方法问题”或“文件不属本lane”宣布免责。不得绕过快照/吞错/恢复越权写SQL。14:03正常merge后原样job20261104140353-20cbc8已39pass/1fail：business25/25pass，仅s03待L10 a38068281正常集成。

### 2026-11-04 迁移状态

- 已注册24/24；新增mark_blob_deleted、mark_asset_deleted、list_unsynced_items、run_sync、run_sync_with_progress直接消费正常main的L20b async codec/L21许可。真实index测试结果见REPORT，A/B仍按完整语义与独立复核，不因注册统签。
- 服务名 `sync`，已提供行级 apply/enrich/上传下载/格式协商/清单/游标确认/DELETE 归档保护等能力，接口摘要见 api.ts。
- 五条命令现已接线；多库apply唯一归L20且两个run_sync均await公开服务；D3整数边界遵循架构裁定。Memory/F3后继公开接口仍以实际main是否集成为准。
- TESTMAP状态列：212 ported、0 merged、46 pending、5经C2批准obsolete。R4-SYNC-05画像owner未接已退pending。11条历史/番茄的真实公开apply覆盖及D8部分退休矩阵见TESTMAP。writer busy握手继续pending，不用固定延时冒充。
- 本lane合并冲突已自行解决，main服务新名及notes/vfs-repos去环已合入。L11批量重算已接入同一apply事务，删除本lane重复todo写；所有ABI失败自动skip路径已移除。
- W18笔记写已全部委托notes.sync，同一SqlExecutor；默认hooks还使用真实syncSupport reader，测试不覆盖默认链。main合入L10精度修复后原props_json/CAS回归及同事务回滚通过；Node405passed/Electron相关17passed均exit0。X4仅reset业务面验证通过，启动时点仍待F3两阶段接点；详见REPORT作业证据。
- ACCEPTANCE.md 仍待独立评审，不自行提升 B。测试使用临时目录与 Node/Electron SQLite，未触碰真实用户数据。

## v2排雷清单

固定报告 `0119143715c0bab2d8f698b7c1d58651358e85be`，源码基线 `2ee9a9cbe`。编号/位置永久指向该快照，后续重扫不重排复用。所有者优先采用 C2 `037376b1e` / `X6-OWN-C2-20261104`，以下 resources/blobs/notes 表均为 **vfs** 库。每行“—”表示尚无修复SHA；候选已修也须正常main后R复验，不自行签收。PR/AP/LP仅人工候选，未按计数修改断言、整体降A或复活approved obsolete分支。当前优先处理R4-SYNC-02..06（进度/作业见REPORT）。

### 单写者与解码（SW 11 / UD 4）

| 稳定ID | 基线 | 固定位置（host/plugins/sync/相对） | 当前状态、生产证据与修复SHA |
|---|---|---|---|
| X6-SW-0074 | 2ee9a9cbe | repository/apply-refcounts.ts:92 UPDATE resources | 待修；vfs-repos所有，真实apply后重算仍直接写；R4-SYNC-01，须owner同conn窄API；SHA — |
| X6-SW-0075 | 2ee9a9cbe | repository/apply-refcounts.ts:96 UPDATE resources | 待修；同上，不能复制SQL或改事务；SHA — |
| X6-SW-0076 | 2ee9a9cbe | repository/apply-refcounts.ts:106 UPDATE resources | 待修；同上；SHA — |
| X6-SW-0077 | 2ee9a9cbe | repository/apply-refcounts.ts:218 UPDATE blobs | 待修；vfs-repos所有，真实apply后重算仍直接写；R4-SYNC-01；SHA — |
| X6-SW-0078 | 2ee9a9cbe | repository/apply-refcounts.ts:222 UPDATE blobs | 待修；同上；SHA — |
| X6-SW-0079 | 2ee9a9cbe | repository/apply-refcounts.ts:232 UPDATE blobs | 待修；同上；SHA — |
| X6-SW-0080 | 2ee9a9cbe | repository/note-history.ts:177 UPDATE note_document_formats | 候选已修待复核；ec75d3494删除旧SQL，snapshotNotesImpl→notes.sync.updateInferredFormat(db)；f53290429默认index hooks闭合 |
| X6-SW-0081 | 2ee9a9cbe | repository/note-history.ts:230 UPDATE note_learning_relations | 候选已修待复核；ec75d3494删除本地失效SQL/locator解码，notes.revisions.snapshot同conn执行；f53290429默认入口 |
| X6-SW-0082 | 2ee9a9cbe | repository/note-history.ts:261 UPDATE note_learning_relations | 候选已修待复核；ec75d3494→notes.sync.retargetNoteRelations(db)；f53290429默认入口 |
| X6-SW-0083 | 2ee9a9cbe | repository/note-history.ts:407 UPDATE note_document_revisions | 候选已修待复核；ec75d3494→notes.sync.applyRevision(db)；f53290429默认入口 |
| X6-SW-0084 | 2ee9a9cbe | repository/note-history.ts:427 INSERT note_document_revisions | 候选已修待复核；ec75d3494→同一notes.sync.applyRevision(db)，不另开事务；f53290429默认入口 |
| X6-UD-0072 | 2ee9a9cbe | repository/change-log.ts:46 parseEntry / JSON.parse(field_deltas_json) | 候选修复aab3cd060/e408548ff：使用既有parseJsonLossless保留任意Value及大整数/浮点表示，不加错误对象shape约束；同修pending ID内部舍入。公开API链回归142746-1fffb8通过，待最终gate/main后复核 |
| X6-UD-0073 | 2ee9a9cbe | repository/note-history.ts:220 invalidateMissingBlocks | 候选已修待复核；ec75d3494删除本地locator解析，实际失效判断交notes owner；f53290429默认入口。owner自身decode质量另由其lane复核 |
| X6-UD-0074 | 2ee9a9cbe | repository/note-history.ts:286 prepareRelationImpl | 候选已修待复核；ec75d3494删除本地解析，notes.sync.prepareRelation(db,id,data)同conn；f53290429默认入口 |
| X6-UD-0075 | 2ee9a9cbe | src/json.ts:106 parseJsonLossless / JSON.parse+reviver as DbJson | 待逐表达式裁定：目标是任意serde_json::Value，JSON.parse已做词法校验，reviver只转换数字为bigint/JsonFloat；不是领域struct解码。不得添加错误shape约束，未申请/获得豁免；SHA — |

### 生产可达候选（PR 2）

两行报告关联的21个Rust testIds为同一 `tests/remote-protocol.test.ts` 文件粗关联（完整列表保留在固定报告），不能将这些测试整体降级。

| 稳定ID | 基线 | 固定位置（host/plugins/sync/相对） | 当前状态、证据与修复SHA |
|---|---|---|---|
| X6-PR-0117 | 2ee9a9cbe | tests/remote-protocol.test.ts:1 → src/record-progress.ts:59 executeDownloadWithProgress | 候选已修e63ac0775：index注册run_sync_with_progress→runSyncWithProgress→executeDownloadWithProgress；真实owner空云download/进度完成测试132718-b09cfb exit0。待正常main后R复核，不连带整文件升/降A |
| X6-PR-0118 | 2ee9a9cbe | tests/remote-protocol.test.ts:1 → src/record-progress.ts:84 executeBidirectionalWithProgress | 候选已修e63ac0775：同一已注册progress命令的Bidirectional分支直接调用该符号；符号可达与全部bidirectional行为签收分开，完整原向量/正常main后R复核仍待 |

### 断言语义候选（AP 17）

下列“计数误报”只指本行人工语义核对，不代表相应生产命令或测试整体获签收。Rust路径省略前缀 `src-tauri/`。

| 稳定ID | 基线 | 固定TS位置 / 原Rust位置 | 当前状态与修复SHA |
|---|---|---|---|
| X6-AP-0400 | 2ee9a9cbe | tests/payload.test.ts:23 decode_payload_accepts_plaintext_when_encryption_disabled；sync/mod.rs:12981，3>2 | 标题包含匹配误报：:23是Buffer所有权补充用例，原用例在TS:61，保留同JSON明文/空密码disabled/空密码decode三原断言且多测null disabled。无需修复，SHA — |
| X6-AP-0401 | 2ee9a9cbe | tests/remote-protocol.test.ts:358 sequence_gap_download_allows_publication_after_listing；sync/mod.rs:13394，4>3 | 确认证据缺口：v3/v4前三断言一致，但Rust最后读真实state cursor=0，TS仅setCursor throwing fixture+注释，需真实state owner持久化读断言；不以补一个mock expect冒充；SHA — |
| X6-AP-0402 | 2ee9a9cbe | tests/remote-protocol.test.ts:282 regression_c4_dedupe_distinct_kept；sync/mod.rs:13580，4>2 | 计数误报：长度3与数组[1,2,3]覆盖原三个序号，三条r1/x1、r2/x1、r1/x2输入一致。无需修复，SHA — |
| X6-AP-0403 | 2ee9a9cbe | tests/remote-protocol.test.ts:309 test_parse_version_from_key_invalid；sync/mod.rs:13710，4>1 | 计数误报：循环中的空串/no-slash/notanumber.json/abc.json.zst四完整输入与Rust一致，各断言null。无需修复，SHA — |
| X6-AP-0404 | 2ee9a9cbe | tests/change-log.test.ts:122 test_mark_synced_empty；sync/mod.rs:14179 test_mark_synced，3>1 | 计数/标题匹配误报：原empty实际:14197仅updated=0；主test_mark_synced在TS:111保留updated2/pending1/msg-3三断言。无需修复，SHA — |
| X6-AP-0405 | 2ee9a9cbe | tests/change-log.test.ts:126 test_mark_synced_with_timestamp；sync/mod.rs:14179 test_mark_synced，3>2 | 同类误报：原with_timestamp实际:14205两断言updated1/!has_changes，与TS一致。无需修复，SHA — |
| X6-AP-0406 | 2ee9a9cbe | tests/change-log.test.ts:144 test_reset_sync_baseline_after_restore；sync/mod.rs:14291，7>5 | 计数误报：truncated2/reset1/count0保留，两条对象断言各含local_version/sync_version，覆盖原4标量断言。无需修复，SHA — |
| X6-AP-0407 | 2ee9a9cbe | tests/apply.test.ts:1655 remote_resource_apply_strips_and_resets_local_vector_index_lifecycle；sync/mod.rs:14359，11>10 | 候选修复c63b6c4f7：补回原:14464四列is_local_derived_sync_column循环断言；原10个行状态断言不变。待验证/main后R复核。另有D1 owner缺口，不统签 |
| X6-AP-0408 | 2ee9a9cbe | tests/apply.test.ts:1728 remote_business_rows_keep_multimodal_index_fields_local；sync/mod.rs:14478，3>2 | 候选修复c63b6c4f7：补回原:14590 exam_sheets.mm_indexing_mode派生字段断言；原两对象断言不变。待验证/main后R复核 |
| X6-AP-0409 | 2ee9a9cbe | tests/change-log.test.ts:210 test_get_change_log_stats；sync/mod.rs:14745，3>1 | 计数误报：同四行输入，完整对象断言total4/pending2/synced2覆盖原三字段。无需修复，SHA — |
| X6-AP-0410 | 2ee9a9cbe | tests/progress.test.ts:16 test_sync_progress_builders；sync/progress.rs:475，11>6 | 计数误报：phase/current/total/percent/error/outcome用对象断言合并，上传60..85区间两断言覆盖原&&；原11项均保留。无需修复，SHA — |
| X6-AP-0411 | 2ee9a9cbe | tests/progress.test.ts:31 test_sync_progress_with_methods；sync/progress.rs:514，4>1 | 计数误报：current_item=file.txt/speed1024/eta60/percent25四字段对象断言；无需修复，SHA — |
| X6-AP-0412 | 2ee9a9cbe | tests/progress.test.ts:67 test_progress_tracker；sync/progress.rs:579，4>2 | 计数误报：phase/total/current_item合并对象+complete后phase，原4项保留；无需修复，SHA — |
| X6-AP-0413 | 2ee9a9cbe | tests/progress.test.ts:75 test_progress_tracker_fail；sync/progress.rs:579 test_progress_tracker，4>1 | 标题包含匹配误报：fail应对应:598，tracker在TS:67另测；无需修复，SHA — |
| X6-AP-0414 | 2ee9a9cbe | tests/progress.test.ts:75 test_progress_tracker_fail；sync/progress.rs:598，2>1 | 计数误报：phase failed与Network error合并对象，原两项保留；无需修复，SHA — |
| X6-AP-0415 | 2ee9a9cbe | host/plugins/sync-support/tests/tombstone.test.ts:359 bad_or_future_deleted_at_is_skipped_and_never_advances_watermark；sync/tombstone.rs:2125，7>5 | 跨lane L20b文件，待owner/R4逐义核对；L20不越权修改，TESTMAP既有pending不提升；SHA — |
| X6-AP-0416 | 2ee9a9cbe | tests/conflicts.test.ts:50 count_unresolved_conflicts_reports_groups_and_rows；src/data_governance/commands_sync.rs:6216，2>1 | 计数误报：同notes/a双边、notes/b单边、已解决c、跨表tags/a；对象groups3/rows4覆盖原两标量。无需修复，SHA — |

### 日志候选（LP 6）

| 稳定ID | 基线 | 固定位置（host/plugins/sync/相对） | 当前状态与修复SHA |
|---|---|---|---|
| X6-LP-0249 | 2ee9a9cbe | src/emitter.ts:1 / emitter.rs error 1>0 | 候选漏识别回调：doEmit.catch→logError，index.createProgressEmitter注入ctx.logger.error；实现8cbaa9407。须按Rust分支/文案复核，不增加重复error |
| X6-LP-0250 | 2ee9a9cbe | src/field-merge.ts:1 / field_merge.rs warn 2>0 | 待修/核日志接缝；数值/enum单值tags冲突当前无warn，不能以R4-SYNC-02精度修复代替日志；SHA — |
| X6-LP-0251 | 2ee9a9cbe | api.ts:1 / mod.rs warn 55>41（38文件） | 文件聚合候选，须逐可达分支比对并排除批准退休子义；不凭差14补日志；SHA — |
| X6-LP-0252 | 2ee9a9cbe | repository/tombstone.ts:1 / tombstone.rs warn 5>0（2文件） | 待跨L20b正式owner/consumer日志核对，遵守原error/warn字段与时序；SHA — |
| X6-LP-0253 | 2ee9a9cbe | repository/change-log.ts:1 / commands_sync.rs warn 29>16（28文件） | 聚合候选；R4-SYNC-03只修status/空resolve日志顺序，不能据此关闭本行；SHA — |
| X6-LP-0254 | 2ee9a9cbe | LANE.md:1 / plugin total warn 91>60 | 汇总候选不是新增31项缺陷；依逐分支子项签收，不机械加日志；SHA — |
