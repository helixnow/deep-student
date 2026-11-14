# L20-sync 本地同步等价语料（WAVE0 v0，WP-077）

`sync-local.json` 按 `board/WAVE0-EQUIVALENCE.md` §3 v0 编写（domain / commands / scenarios / id / seed / steps / capture / normalize）：20 命令（17 条 L20 + 3 条外域 owner 前置）/ 35 场景 / 231 步，其中 71 步标 `expect: "error"`。全部 `seed: "empty"`、`capture: {events: true, db: ["*"]}`、`normalize: []`。`expect` 只是注释，比对以 A（Tauri+Rust）实际结果为准。**这些场景尚未在 A 或 B 上运行，不计 C 级。**

范围是"本地同步配置/状态/导入导出"：只做不需要云端的 L20 命令。需要云端的 7 条命令见文末"未覆盖"。

## 与 L20b WP-065 的复用关系（X2 去重）

| 语料 | 命令 | 本文件 |
|---|---|---|
| `host/plugins/sync-support/equivalence/sync-state.json`（WP-065） | `data_governance_mark_blob_deleted`、`data_governance_mark_asset_deleted`、`data_governance_detect_prune_gap`、`data_governance_run_sync`、`data_governance_run_sync_with_progress`（owner L20，观察 `sync_state.db`/墓碑），以及 F4 前置 `cloud_config_ssot_save`、`secure_save_cloud_credentials` | 不重复。这 5 条 L20 命令的场景以 WP-065 为准 |
| 本文件（WP-077） | 下表 17 条 L20 本地命令 | WP-065 不含其中任何一条 |

两份语料没有共同的 L20 命令。WP-065 已经覆盖"无 SSOT"错误分支；本文件只在 `detect_conflicts` 里复用同一个前提（`hydrate_cloud_config` 丢弃 IPC 配置，`dstu-sync/src/cloud_credentials.rs:127-150`），给出一个确定性的本地错误步骤，没有加 SSOT/凭据前置步骤。

## 命令、owner 与入口

Rust 路径相对 `src-tauri/`。前端调用点已逐条在 `src/` 中核对；B 端注册在 `host/plugins/sync/index.ts:217-248`。

| 命令 | owner | 前端调用点 | Rust 入口 |
|---|---|---|---|
| `data_governance_get_sync_status` | L20 | `src/api/dataGovernance.ts:826` | `src/data_governance/commands_sync.rs:1025-1186` |
| `data_governance_cancel_sync` | L20 | `dataGovernance.ts:1013` | `commands_sync.rs:2810-2824` |
| `data_governance_detect_conflicts` | L20 | `dataGovernance.ts:837` | `commands_sync.rs:1280-1381` |
| `data_governance_resolve_conflicts` | L20 | `dataGovernance.ts:852` | `commands_sync.rs:1428-1546` |
| `data_governance_export_sync_data` | L20 | `dataGovernance.ts:883` | `commands_sync.rs:2368-2505,2518-2533` |
| `data_governance_import_sync_data` | L20 | `dataGovernance.ts:897` | `commands_sync.rs:2570-2753`；`commands_backup.rs:374-617` |
| `data_governance_list_quarantine` | L20 | `dataGovernance.ts:1547` | `commands_sync.rs:4167-4229` |
| `data_governance_retry_quarantine` | L20 | `dataGovernance.ts:1557` | `commands_sync.rs:4232-4253`；`dstu-sync/.../sync/mod.rs:6840-6872` |
| `data_governance_discard_quarantine` | L20 | `dataGovernance.ts:1567` | `commands_sync.rs:4256-4282` |
| `data_governance_retry_all_quarantine` | L20 | `dataGovernance.ts:1580` | `commands_sync.rs:4293-4348` |
| `data_governance_discard_all_quarantine` | L20 | `dataGovernance.ts:1584` | `commands_sync.rs:4351-4384` |
| `data_governance_list_record_conflicts` | L20 | `dataGovernance.ts:1398` | `commands_sync.rs:4406-4502` |
| `data_governance_count_record_conflicts` | L20 | `dataGovernance.ts:1427` | `commands_sync.rs:4530-4584` |
| `data_governance_resolve_record_conflict` | L20 | `dataGovernance.ts:1452` | `commands_sync.rs:4610-5007` |
| `data_governance_purge_resolved_conflicts` | L20 | `dataGovernance.ts:1468` | `commands_sync.rs:5010-5049` |
| `data_governance_list_sync_snapshot_batches` | L20 | `dataGovernance.ts:1494` | `commands_sync.rs:5186-5222`；`dstu-sync/.../sync/history.rs:202-240` |
| `data_governance_rollback_sync_snapshot_batch` | L20 | `dataGovernance.ts:1520` | `commands_sync.rs:5244-5292`；`history.rs:351-530` |
| `dstu_folder_create` | L13（只作前置） | `src/dstu/api/folderApi.ts:77` | `crates/dstu-vfs/src/dstu/folder_handlers.rs:135` |
| `dstu_folder_rename` | L13（只作前置） | `folderApi.ts:118` | `folder_handlers.rs:273` |
| `save_text_to_file` | F2（只作前置） | `src/utils/settingsApi.ts:125` | `src/commands.rs:4271-4274` → `dstu-storage/src/unified_file_manager.rs:375-384` |

### seed 只经 owner 命令建立

- **变更日志 / 记录冲突**：`dstu_folder_create` 写 `folders` 行和 `__change_log` INSERT（vfs 迁移 `V20260131__add_change_log.sql` 的触发器），`dstu_folder_rename` 留下一条未同步的 UPDATE。`notes_create`、`vfs_create_note` 的契约是 `frontend: none`，所以没用。`notes_update` 前端可达，但无 capabilities/lease 的旧分支只在 owner 内部调用，所以也没用。
- **导入文件**：先用 L20 自己的 `data_governance_export_sync_data`（无参数）在活动数据目录写出 `sync_export.json` 并返回绝对路径，再用 F2 `save_text_to_file` 把精心构造的 v2 导出 JSON（`SyncExportData`，`commands_sync.rs:2508-2516`）写到 `${0.output_path}`。没有使用运行器外的文件 fixture，也没有写死主机路径。
- **掌握度**：导入文件里的 `vfs.mastery_events` 变更字段与 WP-004 的 `tests/mastery-integration.test.ts:41-46` 一致，表结构来自 vfs 迁移 `V20260718/19/20`。重建由真实 review/mastery 完成（`commands_backup.rs:512-601`）。
- **检疫**：导入同一批中包含 CHECK 违规（`source='wp077'`，`V20260718__add_mastery_tables.sql:9`）和 vfs 中不存在的表，属于非 transient 错误（`mod.rs:6560-6575`），走 `quarantine_change`（`mod.rs:7155-7165,6626-6670`）。
- **快照批次**：只由 `resolve_record_conflict` 的 keep_cloud / merged 写回路径产生（`commands_sync.rs:4896-4925`，reason `conflict_resolve`）；回退会再产生 `rollback_undo` 批次。

## 分支覆盖表

场景 id 省略前缀 `sync.local.`，`#n` 是步序号（从 0 起）。"阻塞"指空种子/串行步骤下不可达，按协议登记，不伪造。

### data_governance_get_sync_status

| 分支 | Rust | 场景 |
|---|---|---|
| 成功：全部库无 / 有 `__change_log`，pending=0 | 1042-1186 | `status.empty_seed`#0,#1 |
| 成功：建文件夹后 pending>0，`last_sync_at` 为 null | 1074-1108 | `status.pending_after_folder_create`#2 |
| 成功：导入回放后的计数（suppress 的回放不生成本地 pending） | 同上 | `import.roundtrip_repeat`#6、`import.mastery_rebuild_and_repeat`#9、`conflicts.manual_keep_cloud_snapshot_rollback`#20、`conflicts.merged_variants`#12 |
| 维护模式 | 1032；`commands.rs:106-113` | 阻塞：需要 X3 维护模式种子或进行中的备份 |
| 打开库失败 / 查表失败 / stats 失败 → partial、Unknown | 1047-1155 | 阻塞：需要 X3 提供损坏的库文件种子 |

### data_governance_cancel_sync

| 分支 | Rust | 场景 |
|---|---|---|
| 没有进行中的同步 → `false`，重复调用结果相同 | 2816-2823 | `cancel.no_active_sync`#0,#1 |
| 有令牌 → `true` 并取消 | 2817-2820 | 阻塞：需要并发步骤（与进行中的 `run_sync_with_progress` 并行），v0 只能串行 |

### data_governance_detect_conflicts

| 分支 | Rust | 场景 |
|---|---|---|
| 两参数都缺省 / null → 只返回本地清单 | 1368-1380 | `detect.local_only`#0,#1 |
| 显式清单：空库集合（每个本地库都是 LocalOnly） | 1337-1367；`mod.rs:1158-1167` | `detect.manifest_variants`#0 |
| SchemaMismatch（needs_migration）、CloudOnly、data_version=u64::MAX | `mod.rs:1121-1130,1167-1175` | `detect.manifest_variants`#1 |
| serde 默认值（缺 format_version 等）、`Partial` 状态 | `mod.rs:183-197` | `detect.manifest_variants`#2 |
| 清单 JSON 解析失败：空串、截断、`null`、缺必填字段、未知 status、schema_version=2^32 | 1317 | `detect.manifest_parse_errors`#0-#5 |
| 清单优先于 cloudConfig（不建存储，不联网） | 1316-1318 | `detect.manifest_wins_over_config`#0 |
| 只有 cloudConfig、无 SSOT → `创建云存储失败: …` | 1318-1323 | `detect.config_without_ssot`#0（端点为 `127.0.0.1:9`，SSOT 缺失时不会发出请求） |
| 有 SSOT：下载清单成功 / 失败 | 1321-1331 | 阻塞：需要 WP-046 确定性 WebDAV + F4 SSOT 前置（与 WP-065 同一前提） |
| `冲突检测失败` | 1338-1339 | 不可达：`SyncManager::detect_conflicts`（`mod.rs:1097-1184`）没有 `Err` 返回点 |
| 维护模式 | 1289 | 阻塞（同上） |

### data_governance_resolve_conflicts（已停用）

| 分支 | Rust | 场景 |
|---|---|---|
| strategy 或清单非空 → 停用说明 | 1434-1439 | `resolve_conflicts.retired_nonempty`#0-#2 |
| 两者都空 → 维护模式检查后 `未知的合并策略: ` | 1443-1458 | `resolve_conflicts.empty_args_unknown_strategy`#0 |
| IPC 缺必填参数 | 反序列化 | `resolve_conflicts.ipc_missing_args`#0,#1 |
| 合法策略之后的分支（1461-1545） | — | 不可达：任何合法策略都是非空串，会先命中 1434 |

### data_governance_export_sync_data

| 分支 | Rust | 场景 |
|---|---|---|
| 缺省 / null → `<active>/sync_export.json` | 2471 | `export.default_path`#0,#1 |
| 有 pending 变更时带完整数据导出；显式绝对路径 | 2411-2436,2466-2470 | `export.default_path`#3 |
| `..` 路径 | `commands_backup.rs:651-656` | `export.bad_paths`#0 |
| null 字节 | `commands_backup.rs:646-649` | `export.bad_paths`#1 |
| 双重编码的 content URI | `unified_file_manager.rs:423-433` | `export.bad_paths`#2 |
| `content://`：入 SAF 队列，暂存后复制失败 → `写入目标 URI 失败`，并清理暂存文件 | 2455-2465,2483-2488 | `export.bad_paths`#3 |
| 空串：校验通过，`File::create("")` 失败 → `写入文件失败` | 2475-2480,2521 | `export.bad_paths`#4 |
| 补全变更数据失败（只 warn，继续导出） | 2427-2433 | 阻塞：需要 X3 损坏行种子 |
| 创建目录失败 / 序列化失败 / 任务 join 失败 | 2462,2476,2523-2528,2378 | 阻塞：需要只读文件系统；序列化与 join 失败前端不可达，待 C2 审核 |

注：export 不检查维护模式（与 import 不同，见 2381-2389）。

### data_governance_import_sync_data

| 分支 | Rust | 场景 |
|---|---|---|
| 导入自己的导出：空变更 / 有变更；重复导入（幂等，计入 skipped） | 2692-2752 | `import.roundtrip_repeat`#1,#4,#5 |
| strategy 缺省 / null → keep_latest | 2672 | `import.roundtrip_repeat`#1,#5 |
| 合法策略 keep_local（`commands_backup.rs:477-499`）、use_cloud、keep_latest、manual | 2673-2676 | `import.strategies_accepted`#1-#4 |
| 坏策略：大小写不符、空串、`keep_cloud`（这是 resolution 的取值，不是策略）、`merged` | 2677-2683 | `import.bad_strategy`#1-#4 |
| 坏路径：`..`、null 字节、双重编码、`content://`（物化失败 → `无法读取导入文件`）、空串、不存在的文件（`读取文件失败`） | 2614-2630,2536 | `import.bad_paths`#0-#5 |
| 路径错误先于策略错误 | 2614-2628 早于 2672 | `import.bad_paths`#6 |
| IPC 缺 `inputPath` | 反序列化 | `import.bad_paths`#7 |
| 解析失败：截断 JSON、空文件、缺 `pending_changes`、未知 status、未知 operation | 2537-2542 | `import.bad_content`#2,#4,#6,#8,#10 |
| 文件可读但策略非法 | 2677 | `import.bad_content`#12 |
| `pending_changes` 为空 → 跳过应用；有 CloudOnly/SchemaMismatch 时 `conflicts_detected` 取较大值 | 2692,2747 | `import.empty_pending_changes`#2,#4 |
| legacy 变更表名无法推断库 / 未知 `database_name` → `应用导入变更失败: 部分数据库应用变更失败…` | `commands_backup.rs:413-449,603-615`；2710-2717 | `import.unroutable_changes`#2,#4 |
| 掌握度副作用：导入 3 条 mastery_events → 真实重建 `mastery_states` + learner profile；重复导入；Delete 部分、全部 | `commands_backup.rs:512-601` | `import.mastery_rebuild_and_repeat`#2-#8 |
| 单条失败进入检疫 → `success:false`、`N条变更应用失败` | 2733-2734 | `quarantine.seed_list_repeat`#2 |
| manual 下有记录冲突 → `needs_manual_resolution:true` 和冲突提示 | 2728-2732,2748 | `conflicts.*`#3（共用 `conflictBase`） |
| manual 重复导入同一冲突（`ON CONFLICT … DO NOTHING` 去重） | `conflict_resolver.rs:485-516` | `conflicts.manual_keep_cloud_snapshot_rollback`#6 |
| 数据不完整被跳过的提示 | 2735-2739 | 未覆盖：需要 data=null 的 Insert/Update，要先核实是否会被 `validate_batch_formats` 拦下，留给后继包 |
| 维护模式；全局锁超时（`SYNC_LOCK_TIMEOUT_SECS`） | 2582-2594 | 阻塞：需要维护种子 / 并发占锁 |
| 重建 mastery_states 失败 | `commands_backup.rs:551-555` | 阻塞：WP-004 用 trigger 注入失败，只经 owner 命令无法构造 |

### 检疫命令（list / retry / discard / retry_all / discard_all）

| 分支 | Rust | 场景 |
|---|---|---|
| list 空种子 / 无表 → `[]` | 4181-4190 | `quarantine.empty_and_bad_input`#0 |
| list 有行；按 last_attempt、id 倒序；limit/offset 缺省、null、1/0、1/1、0、u32::MAX（实际上限 2000） | 4174-4228 | `quarantine.seed_list_repeat`#3,#5-#9 |
| 重复导入同一失败变更 → attempts+1（`ON CONFLICT DO UPDATE`） | `mod.rs:6639-6655` | `quarantine.seed_list_repeat`#4 |
| retry：仍然失败 / 行不存在 → `false` | `mod.rs:6862-6871` | `quarantine.retry_discard_one`#4,#8,#9 |
| discard：删除 → `true`；重复 → `false`；id 为 -1 → `false` | 4275-4281 | `quarantine.retry_discard_one`#6,#7,#10 |
| 单库无检疫表或无该行 → `false`（空种子下 vfs 是否已有 `__sync_quarantine` 以 A 为准） | 4247-4249,4271-4273；`mod.rs:6862` | `quarantine.empty_and_bad_input`#3,#4 |
| 未知数据库（大小写不符、空串） | 4239-4242,4263-4266 | `quarantine.empty_and_bad_input`#5,#6 |
| IPC：i64 溢出、字符串 id、缺参数、limit=-1、offset=2^32 | 反序列化 | `quarantine.empty_and_bad_input`#7-#11 |
| retry_all：计入 failed 和 errors；空表 → 0/0 | 4328-4347 | `quarantine.batch_retry_discard_all`#3,#7 |
| discard_all：删除数；重复 → 0 | 4372-4383 | `quarantine.batch_retry_discard_all`#5,#6 |
| retry 成功 → `true` 并清除 | `mod.rs:6865-6871` | 未覆盖：需要能在本地变为可应用的检疫项（例如先导入子行、再建父行）。这要依赖 FK/时钟漂移种子，不为凑数伪造 |
| prepare/query 失败、打开库失败 | 4192-4219,4245 | 阻塞：需要 X3 损坏库种子 |

### 记录冲突与快照命令

| 分支 | Rust | 场景 |
|---|---|---|
| list/count/purge/list_batches 空种子；limit 为 0 和 u32::MAX | 4413-4502,4569,5016-5048,5192-5221 | `conflicts.empty_reads`#0-#9 |
| IPC 负数 / 越界 / 缺参数 | 反序列化 | `conflicts.ipc_bad_input`#0-#5 |
| purge `olderThanDays=u32::MAX`：`Utc::now() - Duration::days(4294967295)` 越出 chrono 范围 | 5016-5017 | `conflicts.purge_days_max`#0。单列一个场景，A 端预计 panic/IPC 错误；按 Rust 原样记录，不修改 |
| manual 导入产生 local+cloud 两行；count groups=1/rows=2；limit=1 按组分页 | 4471-4501,4539-4546 | `conflicts.*`#4,#5 |
| resolve：`expectedConflictIds` 为空 | 4626-4628 | `conflicts.resolve_early_errors_empty_seed`#0 |
| resolve：未知数据库 | 4636-4639 | `conflicts.resolve_early_errors_empty_seed`#1 |
| resolve：空种子查询冲突表（表不存在 → 读取失败，或 generation 不匹配） | 4646-4668 | `conflicts.resolve_early_errors_empty_seed`#2,#3 |
| resolve：generation 不完整 / 去重后相等（`[b,a,b]`） | 4629-4631,4666 | `conflicts.manual_keep_cloud_snapshot_rollback`#8,#10 |
| resolve：未知 resolution（在"当前与快照匹配"检查之后） | 4714-4723,4767 | `…_snapshot_rollback`#9 |
| resolve keep_cloud：force 写回 + `conflict_resolve` 快照 + `updated_at` 刷新 + 进入 change_log | 4743-4752,4862-5006 | `…_snapshot_rollback`#10 |
| resolve 已解决的冲突 → generation 不匹配 | 4666-4668 | `…_snapshot_rollback`#13 |
| resolve keep_local，处于目标状态 → 只标记，不建快照 | 4725-4741,4785-4860 | `conflicts.manual_keep_local_mark_only`#6 |
| merged：缺参数、null、坏 JSON、`"null"` → Delete 写回 | 4753-4766 | `conflicts.merged_variants`#6-#9 |
| 冲突生成后本地再次变化：keep_cloud / merged 被拒；keep_local 保留当前编辑 | 4714-4723,4728-4734 | `conflicts.local_changed_after_conflict`#7-#9 |
| 错误数据库（chat_v2）、错误记录 id、混入不存在的 id | 4643-4668 | `conflicts.wrong_record_and_db`#6-#8 |
| list offset 越过唯一组 → `[]` | 4486 | `conflicts.wrong_record_and_db`#9 |
| list_batches 有行，跨库按 batch_id 倒序，limit=1 | 5205-5220 | `…_snapshot_rollback`#14,#17,#19 |
| rollback 成功 → `undo_batch_id`；同一批次再回退 → `已回退过`；撤销点再回退 | `history.rs:351-530` | `…_snapshot_rollback`#15,#16,#18 |
| rollback：批次不存在、空 batch_id、未知数据库 | `history.rs:397-402`；5257-5260 | `snapshot.rollback_errors_empty_seed`#0-#2 |
| purge 已解决冲突：默认 30 天不删；0 天删除；重复 → 0 | 5040-5046 | `…_snapshot_rollback`#21-#23 |
| resolve/rollback 的全局锁 `try_acquire` 失败 | 4621-4624,5251-5254 | 阻塞：需要并发占锁 |
| `找不到该冲突的 cloud side 数据` | 4695-4696 | 不可达：只要 generation 匹配，就一定存在 cloud 行（落表时 cloud 总是 loser 或 winner 之一，`mod.rs:7912-7950`） |
| 事务内重验失败、`冲突决策未写入任何业务记录` | 4810-4832,4929-4933,5002-5003 | 阻塞：需要在事务窗口内并发写入 |
| 维护模式 | 4620,5250 | 阻塞（同上） |

## 运行前提（交 X7 / X3 / WP-046）

1. **步骤引用**：使用 `${n.path}` 整值引用，包括数组下标（`${5.0.id}`、`${14.0.batch_id}`）。数组里的整数引用必须按原类型（i64）代入，不能变成字符串。
2. **大整数**：`18446744073709551615`、`9223372036854775807`、`9223372036854775808`、`4294967296` 以 JSON 原始整数写入（`detect.manifest_variants` 的清单字符串内部也是原始整数）。运行器不能先经过 `JSON.parse` 再转成 double。
3. **文件系统终态**：除 SQLite 外，下列文件也属于副作用，需要纳入快照比较：活动目录下的 `sync_export.json`（含 `exported_at`、`sync_transaction_id`、`device_id`）、`<app_data>/temp_sync_export|temp_sync_import/`（应为空）、SAF persist 队列文件（`content://` 步骤，`unified_file_manager.rs:603-625`）。
4. **隔离**：每个场景使用独立数据目录。`/nonexistent-wp077/…` 只读，不会被写入。`127.0.0.1:9` 端点不会被访问（SSOT 缺失），没有连接任何真实云端。
5. **规范化候选**（只是候选，未经 A1/A2 双录不生效）：`device_id`、`sync_transaction_id`、`created_at`/`exported_at`/`detected_at`/`resolved_at`/`rolled_back_at`、`batch_id`/`undo_batch_id`（UTC 时间戳前缀）、`__change_log.changed_at`/`sync_version`、`folders.id`（`fld_` nanoid）、导出的 `output_path`（绝对路径前缀）、所有错误文本里出现的路径（`sanitize_path_for_user`）。动态 ID 在返回值、表和后续步骤之间必须一致映射；计数、行顺序、storageClasses、NULL 不进规范化。
6. **前提核实点**：`conflictBase` 假设 manual 导入旧的 folder INSERT 会遇到本地未同步的 rename，从而落下两行冲突（`mod.rs:7853-7950`）。如果 A 实际没有产生冲突，`conflicts.*` 的 #6 及以后各步都会失去意义，需要先报告，不能在 B 端迁就。`quarantine.*` 假设未知表/CHECK 违规会按单条进入检疫，而不是整库失败（`mod.rs:5584-5593,6174-6185` 会跳过未知表）。这一点同样以 A 的结果为准。

## 未覆盖 / 阻塞

- **需要云端的 L20 命令**：`data_governance_repo_check`、`data_governance_list_unsynced_items` 已由 WP-243 写入 `sync-cloud.json`（见下文"WP-243"一节）；WP-065 覆盖的 5 条见 `sync-support/equivalence/`。
- **维护模式、全局锁/并发、事务窗口**：见各表"阻塞"行。v0 只能串行，不伪造锁冲突。
- **S06**：busy 通知仍是 pending（D-022/D-029），本语料与它无关，不能作为证据。
- **20 个外域差异**：本包开工时 `git merge --no-edit main` 在 `host/plugins/sync-providers/tests/weird_sync.test.ts`、`host/plugins/sync-support/tests/service-host.ts` 冲突，已 `merge --abort`。没有编辑或回退这些文件，仍由 C2 组合 L23/L20b 的 owner 提交（D-014/D-023）。

## WP-243：云端只读巡检命令（`sync-cloud.json`）

`sync-cloud.json` 同样按 WAVE0 §3 v0 编写：6 命令（2 条 L20 目标 + 4 条前置）/ 14 场景 / 77 步，其中 15 步标 `expect: "error"`。全部 `seed: "empty"`、`capture: {events: true, db: ["*"]}`、`normalize: []`。**尚未在 A 或 B 上运行，不计 C 级。** WP-077 的 `sync-local.json` 未改动。

### 命令、owner 与入口

| 命令 | owner | 前端调用点 | Rust 入口 |
|---|---|---|---|
| `data_governance_repo_check` | L20 | `src/features/settings/components/CloudStorageSection.tsx:100` | `src/data_governance/commands_sync.rs:5150-5166`；`dstu-sync/src/cloud_storage/repo_check.rs:384-640` |
| `data_governance_list_unsynced_items` | L20 | `src/features/settings/components/data-governance/UnsyncedItemsPanel.tsx:104` | `commands_sync.rs:5812-5904`；清单拉取 `:5395-5441`，分类 `:5560-5806` |
| `cloud_config_ssot_save` | F4（前置） | `src/utils/cloudStorageApi.ts:441` | `dstu-sync/src/cloud_config_commands.rs:487-516` |
| `secure_save_cloud_credentials` | F4（前置） | `cloudStorageApi.ts:1077` | `src/secure_store.rs:27-39` |
| `cloud_storage_put` | L23（前置，构造远端对象） | `cloudStorageApi.ts:735` | `dstu-sync/src/cloud_storage/mod.rs:309-318` |
| `data_governance_mark_blob_deleted` | L20（前置，发布墓碑；分支归 WP-065） | `src/api/dataGovernance.ts:1601` | `commands_sync.rs:4063-4097` |

B 端注册：`host/plugins/sync/index.ts:216`（list_unsynced_items）、`:244`（repo_check）。

前提与 WP-065 相同：两条命令都先 `hydrate_cloud_config`（`dstu-sync/src/cloud_credentials.rs:127-150`），丢弃 IPC 传入的配置，改用 SSOT + 安全存储，所以成功场景都先走 F4 两条前置。远端对象只经 L23 `cloud_storage_put` 写入（同一 SSOT、同一 root `wp243`），没有运行器外的 fixture。`data` 是字节数组，内容见生成方式说明。

### data_governance_repo_check

| 分支 | Rust | 场景 |
|---|---|---|
| 成功：空远端 → `ok`、全 0、无问题；重复调用结果相同（只读） | repo_check.rs:384-640 | `repo_check.empty_remote_ok`#2,#3 |
| 成功：`problemsFound`。好对象通过（objectsChecked/bytesVerified）；MissingObject；ChecksumMismatch；非法校验和 → CorruptManifest 但版本仍计入期望；非法版本 ID → CorruptManifest；两份 manifest 对同一 ID 登记不同校验和 → ConflictingManifestEntry；`manifests/` 下非 `.json` → TempLeftover；未引用对象 → OrphanObject；旧版 `manifest.json` 无法解析 → CorruptManifest；重复调用不改远端 | 322-375,408-560 | `repo_check.seeded_problems`#9,#10 |
| 成功：无标记 + 明文对象 → 无 DSBK 问题；标记内容损坏 → CorruptEncryptionMarker（fail-closed 按加密仓库）+ PlaintextInEncryptedRepo | 392-405,578-598 | `repo_check.corrupt_marker_plaintext_object`#4,#6 |
| 成功：无标记 + DSBK 魔数对象 → EncryptedWithoutMarker；未知容器版本 → UndecodableDsbkHeader | 599-615 | `repo_check.dsbk_without_marker`#4 |
| 无 SSOT：IPC 配置（含密码）被丢弃 → `创建云存储失败: …`；IPC 缺 `cloudConfig` → 反序列化错误 | commands_sync.rs:5156-5162 | `repo_check.no_ssot`#0,#1 |
| 有 SSOT、无凭据 → `创建云存储失败: WebDAV 密码不能为空` | config.rs:338-340 | `repo_check.ssot_without_password`#1 |
| `check_connection` 失败 → `云端仓库巡检失败: …` | repo_check.rs:385；commands_sync.rs:5163-5165 | `repo_check.connection_refused`#2（端点 `127.0.0.1:9`，loopback 不出网） |
| 维护模式 | 5154 | 阻塞：只在备份/恢复 guard 期间为真，v0 串行步骤不可达（同 WP-077） |
| 加密标记 GET / 列表请求失败（连接成功后）、临时目录创建失败 | 392,408,448,476 | 阻塞：需要 WP-046 能对单个 key/前缀注入 5xx；临时目录失败需只读 `/tmp` |
| 列表截断 → `incomplete`；对象 stat/下载失败 → ObjectReadFailed；problems 超过 500 条截断 | 409-412,449-451,478-540,627-629 | 阻塞：WP-046 截断列表/单对象故障注入；500+ 问题需 500+ 次 put，暂不写 |

### data_governance_list_unsynced_items

| 分支 | Rust | 场景 |
|---|---|---|
| 成功：空远端 → items=[]、各 total=0、`encryptionEnabled:false`；重复调用相同 | 5812-5904 | `unsynced.empty_remote`#2,#3 |
| 成功：旧版 + per-device blob 清单合并（非 `.json` 跳过）；DownloadPending（含 `size`=u64::MAX、cipher 条目）；非法 `relative_path` → InvalidKey；资产 InvalidKey（root 非法、缺第三段）、CaseConflict（`wp243.png`/`WP243.png`）、`app_data` 根；排序 kind→key | 5416-5426,5560-5600,5660-5806,5890 | `unsynced.seeded_classification`#6 |
| 成功：墓碑晚于清单条目 → 条目移除，`blobEntriesTotal` 减 1 | 5848-5858 | `unsynced.seeded_classification`#7,#8（墓碑经 L20 `mark_blob_deleted` 发布） |
| 成功：启用 E2EE、空远端 → `encryptionEnabled:true` | 5826-5827 | `unsynced.encryption_enabled_rejects_plaintext_manifest`#2 |
| E2EE 下明文旧清单 → `旧 blob 清单无法解密（请检查加密密码）: …`（PLAINTEXT_LEGACY_REJECTED） | 5408-5410；`sync/mod.rs:960-968` | 同上 #4 |
| 无 SSOT（IPC 密码被丢弃）/ IPC 缺 `cloudConfig` | 5822-5832 | `unsynced.no_ssot`#0,#1 |
| 有 SSOT、无凭据 → `创建云存储失败: WebDAV 密码不能为空` | 5830-5832 | `unsynced.ssot_without_password`#1 |
| 连接失败 → `获取旧 blob 清单失败: …`（本命令不先 check_connection） | 5403-5406 | `unsynced.connection_refused`#2 |
| 旧 blob 清单损坏；DSBK 魔数但未配置密码 → `旧 blob 清单无法解密`；per-device 清单形状错误 → `blob 清单 <key> 损坏`；legacy blob 墓碑损坏 → `获取 blob tombstone 失败`；旧资产清单损坏；legacy asset 墓碑损坏 | 5408-5414,5432-5437,5845-5847,5862-5876；`tombstone.rs:767-786` | `unsynced.corrupt_manifests`#3,#5,#8,#11,#14,#17 |
| LegacyPlaintext / SanitizedNameConflict 分类 | 5584-5596,5678-5711,5770-5780 | 未覆盖：需要 E2EE 下可解密的（DSBK）清单，只能由 owner 同步上传产生（需 WP-046 + 已加密 `run_sync`），或需要净化后重名的成对 key，留给后继包 |
| 列表截断报错、已列举清单消失、读取 per-device 清单失败 | 5420-5431 | 阻塞：WP-046 截断/竞态/单 key 故障注入 |
| `items` 超过 500 截断 | 5891-5893 | 未覆盖：需 500+ 条清单条目，单次 put 可构造但体积大，暂不写 |
| 维护模式 | 5819 | 阻塞（同上） |

### data_governance_resolve_conflicts：无成功场景（理由）

`commands_sync.rs:1434-1439`：strategy 或清单任一非空即返回停用说明；两者都为空时走到 1447-1458，空串不匹配任何策略，返回 `未知的合并策略: `。所以处理函数的每条可达路径都是 `Err`，1461-1545 的成功分支不可达。现有 3 个错误场景（`sync.local.resolve_conflicts.*`）已经覆盖全部可达分支，本包不新增，不能拿错误步骤冒充成功覆盖。G3 计分时这条命令只能靠错误场景与 A 一致计 pass。

### 已有成功场景、补错误分支判定（WP-243 附加项）

| 命令 | 可达 Err / 提前返回 | 结论与理由 |
|---|---|---|
| `data_governance_cancel_sync` | 无 | `commands_sync.rs:2811-2824` 只返回 `Ok(true)` / `Ok(false)`，没有 `Err`。有令牌分支需要并发步骤，见 WP-077 表 |
| `data_governance_count_record_conflicts` | 无（前端可达范围内） | 唯一 `?` 是 `get_active_data_dir`（`commands_backup.rs:43-48`），只在取不到 app 数据目录时失败；打开库失败 `continue`，统计失败 `unwrap_or((0,0))`（4559-4569）。需要坏数据目录环境，不是 IPC 输入能触发的分支 |
| `data_governance_discard_all_quarantine` | `批量清除失败`（4376-4378） | 阻塞：需要 `DELETE FROM __sync_quarantine` 失败，即库被其他连接写锁或损坏，属于 X3 损坏库种子 / 并发占锁。打开失败、无表都 `continue`，不报错 |
| `data_governance_get_sync_status` | 维护模式（1032）、`get_active_data_dir`（1034） | 阻塞：维护模式只在备份/恢复 guard 期间为真（`commands.rs:106-113`，`commands_backup.rs:1110-1140`），v0 串行不可达；各库错误只进 `partial/errors`，不返回 `Err` |
| `data_governance_retry_all_quarantine` | `准备批量查询失败` / `执行批量查询失败`（4315-4321） | 阻塞：`__sync_quarantine` 由迁移/`ensure_quarantine_table` 建表，`SELECT id` 只在库损坏或被锁时失败，需 X3 种子。单条重试的 `Err` 只计入返回值的 `failed/errors`，已由 `quarantine.batch_retry_discard_all`#3 覆盖 |

这 5 条本包没有新增场景。

### 运行前提（补充 WP-077 / WP-065）

1. `${mock.webdav.endpoint|username|password}` 与 WP-065 相同，由运行器替换为 WP-046 确定性 WebDAV；每个场景前清空远端。服务未就绪时不运行，不连真实云。owner：WP-046 / X7。
2. 远端终态（`wp243/` 下 key 排序 + 字节）属于比较对象；两条目标命令都是只读，重复调用步骤用来证明远端与本地 DB 均不变。owner：WP-046 提供远端快照。
3. `seeded_classification`#6 的 blob DownloadPending 依赖本地 `vfs_blobs/` 下没有这些文件（空种子成立）；`app_data/pdf_ocr_sessions/wp243.json` 同理。
4. `encryption_enabled_*` 用 `encryptionPasswordIsPreexisting: true` 跳过新口令强度校验（`dstu-security/src/secure_store.rs:2447-2454`），与前端迁移存量口令的入参一致；安全存储后端可用性同 WP-065 第 5 条（F4/X7）。
5. 规范化候选（未生效）：`checkedAt`、`generated_at`；错误文本中的端口号、reqwest 错误原文（`connection_refused` 两步）。
6. `cloud_storage_put` 的 `data` 是 JSON 整数数组；`repo_check` 场景里 manifest 的 `checksum` 是对应字节的 SHA256，由生成脚本计算，`size` 为字节长度。

## WP-275：5 条命令的错误分支判定（无可达 Err，不新增 g3w 场景）

范围：`data_governance_cancel_sync`、`data_governance_count_record_conflicts`、`data_governance_discard_all_quarantine`、`data_governance_get_sync_status`、`data_governance_retry_all_quarantine`。路径相对 `src-tauri/`，行号以 main 12a07b1b4 为准（与 C1 扫描的 84d89e3e8 相比，这些文件没有改动）。上文 WP-243 表里写的"阻塞"在这里改判为"不可达"：剩下的 `Err` 都只会在 DB/锁故障、平台路径故障、启动失败或并发时出现，按 W-L04 硬性要求第 1 条不写场景。

五条命令的前端调用点都不带参数（`src/api/dataGovernance.ts:826,1013,1427,1580,1584`，只有 `invoke("<cmd>")`），Rust 签名也只有 `AppHandle` 或什么都没有，所以 IPC 反序列化错误也不存在。

| 命令 | 结论 | Rust 文件:行与原因 |
|---|---|---|
| `data_governance_cancel_sync` | 无可达 Err | `src/data_governance/commands_sync.rs:2810-2824`：只返回 `Ok(true)`（2817-2820）或 `Ok(false)`（2822），函数体里没有 `?`。`RwLock` 中毒时 `.read().ok()` 得到 `None`，走 `Ok(false)`（2812-2815） |
| `data_governance_count_record_conflicts` | 无可达 Err | 唯一 `?` 是 `get_active_data_dir`（`commands_sync.rs:4554`），它只在 `app.path().app_data_dir()` 失败时报错（`commands_backup.rs:30-34,43-48`），这是平台路径解析故障，IPC 输入触发不了。打开库失败时 `continue`（4567），统计失败时 `unwrap_or((0, 0))`（4569），最后 `Ok`（4579） |
| `data_governance_discard_all_quarantine` | 无可达 Err | `get_active_data_dir`（`commands_sync.rs:4355`）同上。库不存在、打开失败、表不存在都 `continue`（4361-4370）。`批量清除失败`（4372-4374）只在 `DELETE FROM __sync_quarantine` 执行失败时出现，也就是库被锁、损坏或 IO 错误，属于 DB 故障 |
| `data_governance_get_sync_status` | 无可达 Err | `check_maintenance_mode`（`commands_sync.rs:1032` → `commands.rs:106-113`）只在 `Database` 处于维护模式时报错。维护模式只有三个来源：启动时数据治理初始化或迁移失败（`lib.rs:1173-1175,1251,1265-1267` 置位，`lib.rs:1371-1415` 进入），这需要专门的坏 schema 种子，`seed: "empty"` 不会触发；备份快照屏障（`commands_backup.rs:1093-1150`，在 `spawn_blocking` 后台任务里进入，`:2006`、`:2808`、`commands_zip.rs:427`）；恢复切槽（`commands_restore.rs:266-313,1198`）。后两种是任务进行中的临时状态，串行步骤只能靠时序竞争碰上，结果不确定。`get_active_data_dir`（1034）同上。各库的打开、查表、统计错误都只写进 `partial`/`errors`/`Unknown`（1047-1155），最后 `Ok`（1176） |
| `data_governance_retry_all_quarantine` | 无可达 Err | `get_active_data_dir`（`commands_sync.rs:4297`）同上。库不存在、打开失败、表不存在都 `continue`（4304-4314）。`准备批量查询失败` / `执行批量查询失败`（4317-4323）只在 `SELECT id FROM __sync_quarantine` 的 prepare/query 失败时出现。表由 `ensure_quarantine_table` 建立（`crates/dstu-sync/src/data_governance/sync/mod.rs:6508-6512`，`id INTEGER PRIMARY KEY`），导入的变更只改行、不改这张表的结构，所以只剩库被锁或损坏，属于 DB 故障。逐行读取错误被 `filter_map(\|r\| r.ok())` 丢弃（4324），单条重试的 `Err` 只计入返回值里的 `failed`/`errors`（4327-4339），最后 `Ok`（4343） |

这 5 条的成功和提前返回分支已有场景覆盖：`sync.local.cancel.no_active_sync`、`status.*`、`conflicts.empty_reads`、`quarantine.batch_retry_discard_all`（见上文 WP-077 各表）。本包没有新增 JSON 文件。
