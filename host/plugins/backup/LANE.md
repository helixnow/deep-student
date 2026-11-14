# L21-backup-governance：备份与数据治理

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L21-backup-governance（备份与数据治理） |
| 目录 | `host/plugins/backup/` |
| Rust 范围（lanes.md） | dstu-sync 的 backup、src/data_governance（除 sync），以及 data_governance 工具、tests/restore 和 zip 相关测试 |
| 主要提供 | `backup@1`、`governance@1` |
| 主要消费 | F3、F4 |
| 特别注意 | zip 导出、导入、恢复往返；恢复码 |
| 规模（本目录） | 37462 行 · 31 个文件 · 33 个命令（前端调用 33） · 323 个测试 |
| 规模（整条 lane，inventory） | 37462 行 · 31 个文件 · 33 个命令（前端 33） · 323 个测试 |
| 契约 | [`contracts/ipc/L21-backup-governance.json`](../../../contracts/ipc/L21-backup-governance.json) |
| 服务草稿 | [`contracts/services/DRAFT-L21-backup-governance.md`](../../../contracts/services/DRAFT-L21-backup-governance.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-sync/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-sync/src/backup_job_manager.rs` | 1491 | 6 |  |
| `src-tauri/crates/dstu-sync/src/cloud_config_commands.rs` | 1205 | 8 | 1 |
| `src-tauri/crates/dstu-sync/src/cloud_credentials.rs` | 302 | 5 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/backup/assets.rs` | 2026 | 14 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/backup/delta_inventory.rs` | 374 | 0 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/backup/mod.rs` | 8303 | 41 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/backup/portable_precheck.rs` | 521 | 9 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/backup/restore_plan.rs` | 782 | 4 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/backup/zip_export.rs` | 3614 | 34 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/mod.rs` | 14 | 0 |  |
| `src-tauri/crates/dstu-sync/src/data_governance/restore_codes.rs` | 113 | 3 |  |
| `src-tauri/crates/dstu-sync/src/hooks.rs` | 40 | 0 |  |
| `src-tauri/crates/dstu-sync/src/lib.rs` | 61 | 0 |  |
| `src-tauri/src/chat_v2/tools/data_governance_executor.rs` | 1032 | 8 |  |
| `src-tauri/src/data_governance/commands.rs` | 1542 | 17 | 10 |
| `src-tauri/src/data_governance/commands_asset.rs` | 236 | 0 | 4 |
| `src-tauri/src/data_governance/commands_backup.rs` | 3065 | 7 | 14 |
| `src-tauri/src/data_governance/commands_restore.rs` | 2143 | 5 | 1 |
| `src-tauri/src/data_governance/commands_types.rs` | 180 | 0 |  |
| `src-tauri/src/data_governance/commands_zip.rs` | 2140 | 16 | 3 |
| `src-tauri/src/data_governance/critical_audit_tests.rs` | 1708 | 26 |  |
| `src-tauri/src/data_governance/dto/mod.rs` | 127 | 0 |  |
| `src-tauri/src/data_governance/init.rs` | 463 | 7 |  |
| `src-tauri/src/data_governance/migration_compat_tests.rs` | 959 | 4 |  |
| `src-tauri/src/data_governance/migration_tests.rs` | 1937 | 48 |  |
| `src-tauri/src/data_governance/mod.rs` | 221 | 4 |  |
| `src-tauri/src/data_governance/plugin.rs` | 17 | 0 |  |
| `src-tauri/src/data_governance/tests.rs` | 1086 | 35 |  |
| `src-tauri/tests/restore_domain_plan_tests.rs` | 907 | 13 |  |
| `src-tauri/tests/zip_export_import_restore_tests.rs` | 835 | 9 |  |

### 命令（33）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `cloud_config_test_connection_draft` | `crates/dstu-sync/src/cloud_config_commands.rs:765` | async | app | src/utils/cloudStorageApi.ts:496 | (config: SafeCloudStorageConfig__De, credentials: CloudStorageCredentials, encryptionPasswordIsPreexisting?: boolean \| null) → CloudConfigDraftTestResponse ! CommandError |
| `data_governance_auto_verify_latest_backup` | `src/data_governance/commands_backup.rs:1494` | async | app | src/api/dataGovernance.ts:273 | (（无）) → AutoVerifyResponse ! string |
| `data_governance_backup_and_export_zip` | `src/data_governance/commands_zip.rs:221` | async | app | src/api/dataGovernance.ts:737 | (outputPath: string, compressionLevel?: integer(u32) \| null, addToBackupList?: boolean \| null, useTiered?: boolean \| null, tiers?: string[] \| null, includeAssets?: boolean \| null, assetTypes?: string[] \| null, encryptionPassword?: string \| null) → BackupJobStartResponse ! string |
| `data_governance_backup_tiered` | `src/data_governance/commands_backup.rs:2538` | async | app | src/api/dataGovernance.ts:707 | (tiers?: string[] \| null, includeDatabases?: string[] \| null, excludeDatabases?: string[] \| null, includeAssets?: boolean \| null, maxAssetSize?: integer(u64) \| null, assetTypes?: string[] \| null) → BackupJobStartResponse ! string |
| `data_governance_cancel_backup` | `src/data_governance/commands_backup.rs:2249` | async | app | src/api/dataGovernance.ts:378 | (jobId: string) → boolean ! string |
| `data_governance_check_disk_space_for_restore` | `src/data_governance/commands_backup.rs:1320` | async | app | src/api/dataGovernance.ts:1323 | (backupId: string) → DiskSpaceCheckResponse ! string |
| `data_governance_cleanup_audit_logs` | `src/data_governance/commands.rs:598` | sync | app | src/api/dataGovernance.ts:155 | (keepRecent?: integer(usize) \| null, beforeDays?: integer(u64) \| null, confirmationToken: string) → integer(u64) ! string |
| `data_governance_cleanup_persisted_jobs` | `src/data_governance/commands_backup.rs:2504` | async | app | src/api/dataGovernance.ts:678 | (（无）) → integer(usize) ! string |
| `data_governance_delete_backup` | `src/data_governance/commands_backup.rs:1271` | async | app | src/api/dataGovernance.ts:249 | (backupId: string) → boolean ! string |
| `data_governance_export_zip` | `src/data_governance/commands_zip.rs:698` | async | app | src/api/dataGovernance.ts:781 | (backupId: string, outputPath?: string \| null, compressionLevel?: integer(u32) \| null, includeChecksums?: boolean \| null, encryptionPassword?: string \| null, useStoredCloudEncryptionPassword?: boolean \| null) → BackupJobStartResponse ! string |
| `data_governance_get_asset_types` | `src/data_governance/commands_asset.rs:79` | sync | app | src/api/dataGovernance.ts:1111 | (（无）) → AssetTypeInfo[] |
| `data_governance_get_audit_logs` | `src/data_governance/commands.rs:529` | sync | app | src/api/dataGovernance.ts:129 | (operationType?: string \| null, status?: string \| null, limit?: integer(usize) \| null, offset?: integer(usize) \| null) → AuditLogPagedResponse ! string |
| `data_governance_get_backup_job` | `src/data_governance/commands_backup.rs:2281` | async | app | src/api/dataGovernance.ts:390 | (jobId: string) → BackupJobSummary \| null ! string |
| `data_governance_get_backup_list` | `src/data_governance/commands_backup.rs:1193` | async | app | src/api/dataGovernance.ts:241 | (（无）) → BackupInfoResponse[] ! string |
| `data_governance_get_database_status` | `src/data_governance/commands.rs:1005` | sync | app | src/api/dataGovernance.ts:98 | (databaseId: string) → DatabaseDetailResponse \| null ! string |
| `data_governance_get_maintenance_status` | `src/data_governance/commands.rs:430` | async | app | src/api/dataGovernance.ts:61<br>src/app/hooks/useSystemStatusSync.ts:22 | (（无）) → MaintenanceStatusResponse ! string |
| `data_governance_get_migration_diagnostic_report` | `src/data_governance/commands.rs:1060` | sync | app | src/api/dataGovernance.ts:1351 | (（无）) → string ! string |
| `data_governance_get_migration_status` | `src/data_governance/commands.rs:738` | sync | app | src/api/dataGovernance.ts:86<br>src/hooks/useMigrationStatusListener.ts:160 | (（无）) → MigrationStatusResponse ! string |
| `data_governance_get_schema_registry` | `src/data_governance/commands.rs:499` | sync | app | src/api/dataGovernance.ts:78 | (（无）) → SchemaRegistryResponse ! string |
| `data_governance_import_zip` | `src/data_governance/commands_zip.rs:1209` | async | app | src/api/dataGovernance.ts:811 | (zipPath: string, backupId?: string \| null, password?: string \| null, useStoredCloudEncryptionPassword?: boolean \| null) → BackupJobStartResponse ! string |
| `data_governance_list_backup_jobs` | `src/data_governance/commands_backup.rs:2299` | async | app | src/api/dataGovernance.ts:399 | (（无）) → BackupJobSummary[] ! string |
| `data_governance_list_resumable_jobs` | `src/data_governance/commands_backup.rs:2355` | async | app | src/api/dataGovernance.ts:662 | (（无）) → ResumableJobResponse[] ! string |
| `data_governance_purge_all_data` | `src/data_governance/commands_backup.rs:3047` | sync | app | src/api/dataGovernance.ts:1657 | (（无）) → string ! string |
| `data_governance_restore_backup` | `src/data_governance/commands_restore.rs:420` | async | app | src/api/dataGovernance.ts:291 | (backupId: string, restoreAssets?: boolean \| null) → BackupJobStartResponse ! string |
| `data_governance_restore_with_assets` | `src/data_governance/commands_asset.rs:116` | async | app | src/api/dataGovernance.ts:1136 | (backupId: string, restoreAssets?: boolean \| null) → RestoreResultResponse ! string |
| `data_governance_resume_backup_job` | `src/data_governance/commands_backup.rs:2395` | async | app | src/api/dataGovernance.ts:601 | (jobId: string, password?: string \| null) → BackupJobStartResponse ! string |
| `data_governance_run_backup` | `src/data_governance/commands_backup.rs:1737` | async | app | src/api/dataGovernance.ts:229 | (backupType?: string \| null, baseVersion?: string \| null, includeAssets?: boolean \| null, assetTypes?: string[] \| null) → BackupJobStartResponse ! string |
| `data_governance_run_health_check` | `src/data_governance/commands.rs:822` | sync | app | src/api/dataGovernance.ts:111 | (（无）) → HealthCheckResponse ! string |
| `data_governance_run_slot_c_empty_db_test` | `src/data_governance/commands.rs:1279` | sync | app | src/api/dataGovernance.ts:1358 | (（无）) → SlotMigrationTestResponse ! string |
| `data_governance_run_slot_d_clone_db_test` | `src/data_governance/commands.rs:1288` | sync | app | src/api/dataGovernance.ts:1367 | (（无）) → SlotMigrationTestResponse ! string |
| `data_governance_scan_assets` | `src/data_governance/commands_asset.rs:24` | async | app | src/api/dataGovernance.ts:1101 | (assetTypes?: string[] \| null) → AssetScanResponse ! string |
| `data_governance_verify_backup` | `src/data_governance/commands_backup.rs:1403` | async | app | src/api/dataGovernance.ts:261 | (backupId: string) → BackupVerifyResponse ! string |
| `data_governance_verify_backup_with_assets` | `src/data_governance/commands_asset.rs:138` | async | app | src/api/dataGovernance.ts:1152 | (backupId: string) → BackupVerifyWithAssetsResponse ! string |

### 发出的事件（4）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `backup-import-progress` | 字面量 | crates/dstu-sync/src/backup_job_manager.rs:990 (emit) |
| `backup-job-progress` | 字面量 | crates/dstu-sync/src/backup_job_manager.rs:979 (emit) |
| `id` | 动态（表达式） | crates/dstu-sync/src/backup_job_manager.rs:889 (emit) |
| `job_id` | 动态（表达式） | crates/dstu-sync/src/backup_job_manager.rs:897 (emit)<br>crates/dstu-sync/src/backup_job_manager.rs:967 (emit) |

### 契约中的事件（2，`contracts/ipc/L21-backup-governance.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `backup-import-progress` | 否 | dstu_storage__backup_common__ImportProgress | crates/dstu-sync/src/backup_job_manager.rs:990 (emit) |
| `backup-job-progress` | 否 | UNRESOLVED(payload type of `snapshot.clone(..)` not determinable statically) | crates/dstu-sync/src/backup_job_manager.rs:979 (emit) |
<!-- END GENERATED:lane -->

## 备注

（本 lane 自行记录。）

## WP-005（2026-11-05）：migration diagnostic 的原 X1 慢阶段

- 本包只处理 `data_governance_get_migration_diagnostic_report`。已完整读 WORKER/任务卡并正常 merge main；
  原有 `migration/LEDGER.md` / `migration/ledger.json` 非本包改动保留。
- 原 X1 job `20261105112439-a10c89` 的 5001ms 超时已对上实际应用日志：
  `/tmp/opencode/x1-smoke-m6EYCy/node/local/data/logs/deep-student.log:55-204` 中 Slot C 完整迁移 **10316ms**，
  131 个迁移全部执行，日志覆盖逐个 SQL apply；原产物不再仅有 timeout 摘要。详细 Rust/F3 对应见 SPEC 的 WP-005 小节。
- 正式 F3 migration worker 与 L11 `resetRebuildableIndex(targetDir)` 均已在 main；后者
  `types/services.ts:175` / `src/maintenance-service.ts:75` 已用 `git show main:...` 核实。
  下方旧“等待发布”段落仅是历史，不能作为本包阻塞理由。
- TESTMAP 实际行状态为 **319 ported / 1 merged / 3 pending**；旧 GENERATED 表头 311/12 与旧人工313/10为历史统计。
  本包不迁移 TESTMAP 行；新增诊断性能用例是生产入口回归，非新增 Rust 测试映射。
- 最终阶段数据、作业/退出码与 C2 待裁定项由本包交付报告记录，不以单次定向绿外推原 X1 或全量完成。
- 当前 Node 定向 `20261105140602-fba35c`：0 passed / 1 failed / 0 skipped，exit1，无额外 Errors；
  完整报告/日志/顺序/清槽断言全部通过，最后原5000ms断言失败（13191.20ms）。
  Slot C worker10909.17ms（实际runAll9662ms，四库5924/593/1850/1279ms）；
  Slot D worker2035.88ms（实际runAll2027ms，四库1282/49/292/343ms）；worker外合计246.14ms。
  真实迁移开始后1905次Host心跳、最大timer间隔138.96ms。L21编排开销不是本次超预算主体，待C2/F3性能裁定。
- Electron `20261105140951-bf8c05` 同为0 passed / 1 failed / 0 skipped、exit1，无额外 Errors；
  仅最后5秒断言失败（8231.39ms）。C worker6255.01ms/runAll5085ms，D worker1832.33ms/runAll1823ms，
  worker外144.05ms；心跳1247次、最大间隔53.53ms。两runtime均保完整报告与131条空库迁移，未修改生产实现。
- 回归已由协调者自动检查点 `1a9f505d1` 保存，文档/Node证据在 `fe7cf8f13`；手工提交遇空暂存区已核为自动提交，非改动丢失。

## 2026-11-05 main-red：治理工具sync入口超时（3f794390c，10:01Z）

- 最高优先级反馈覆盖本轮旧交接等待：已先merge main，原失败与阶段证据存 `pending/tool-sync-main-red.md`，不扩到其它新单元。
- 原fulltest原红项30070.83ms，仅Vitest runner638超时占位栈，无业务错误/阶段证据；同文件其它四例21.9–29.5s通过。未发现本文件/治理执行器/L20 status新接口变化，不将原占位栈归咎跨lane接口/CPU。
- 修前仅加阶段metadata的定向 `20261105101043-6636d7` 1 passed/4 filtered/exit0，无Errors，总6.38s；冷worker加载+完整迁移5.286s，两个sync工具约76ms。未复现原全量失败，不拿该绿覆盖原红。
- 实现检查点 `cf48db6ed`：只改自有fixture重复创建/关闭F3 worker为文件内懒建一个正式runner；**每例仍在原30s预算内对独立新Host四库完整runAll并保success断言**，不缓存DB/schema/报告、不移beforeAll，不删弱任何原expect。
  afterEach先drain当前已接受任务再dispose Host；afterAll close+清理独立worker根。原红项task.meta记录Host/迁移/插件/registry/两工具阶段与真实逐库报告，供后续fulltest保具体阶段。
- 生命周期影响同文件五例，故只跑本文件一次Node/Electron：`20261105101718-6d271e` / `-9b73c3` 各5 passed/0 skip/exit0，无Errors；原红项13.484/13.906s。真实报告四库71/8/29/23个迁移全部success，实际迁移12.296/12.657s、两个sync调用28/81ms。非受控负载A/B，不宣称原全量根因已关闭。
- strict `-dfbaec` 一文件0违规/exit0，无Errors。首typecheck `-b54602` exit2为本次TaskMeta直接字段写两条TS2339，已等价Object.assign写公开元数据，不cast/改owner；修后 `20261105102346-7b9357` exit0，无Errors。
- Rust data_governance_executor.rs:215-303的本地状态/:305-327的SSOT先拒绝语义与原状态/错误/存块断言均保留。正式main后是否复现交正常fulltest，未跑全域/压力求绿；Value/AP0137/issue1及跨owner未决不因该局部证据解除。

## 2026-11-05 续派：未知ZIP备份层级warning（X6-LP-0080部分）

- merge main为Already up to date，同HEAD已有gate `20261105074232-133c6b` 前置exit2，仅两foreign ledger，不为未变化树重排。F4 native/Value正式选项仍无，未提前消费或重跑原三Crypto/Value红项。
- 回归 `9d233c830`：Rust commands_zip.rs:436-453。真实F3/Host经kernel backup_and_export_zip，混合CoRe/IMPortant与TYPO/OTHER实际完成导出并核四库ZIP条目，全非法输入保持原失败文案/无输出；两例均核许可释放及按输入顺序的两条小写warn。
- 首次 `20261105075730-e306c9` 2 failed/exit1为新测试误用each第二位置context，非生产证据；使用项目已有it.for取得Vitest signal，所有断言/默认预算不变。有效修前 `20261105075854-5f53ce` 2 failed/36 filtered/exit1，业务/副作用断言已通过，最终两条期望warn实际[]；均无额外Errors，原日志保留。
- 修复 `6e2aff74b`：只在原lowercase→filter未知分支加host warn，保合法集合/顺序/默认core/全部非法失败，不抽公共解析器、不改变选择/锁/屏障/审计/清理。
- 修后Node `20261105080017-31e919` / Electron `-a0839e` 各2 passed/36 filtered/exit0（mixed1552/1472ms，invalid719/577ms）；strict `-f0391c` 两文件0违规/exit0，typecheck `-a12db5` exit0，均无Errors。提交后gate `20261105080317-d0e55c` 前置exit2仍仅两foreign ledger，未启动功能检查。
  仅LP0080的Rust:445子项补证候选，未统签其余warn或整个finding。LP0081已获C2限定接受的两条不再重跑，Value/AP0137仍未决，不自签lane完成。

## 2026-11-05 C2/F4 native正式候选与健康会话交接

- F4完整native消费候选 `658590eb3` 已实现，C2接受其限定接线证据；但当前main `d41d57d68` 尚不含（祖先检查exit1），不能把文档tip单条当全部实现或提前改L21。
- 本lane上一gate `20261105072831-c0ab6a` 已结束，前置exit2仍仅foreign ledger；Node/Electron日志回归、typecheck/strict均已结束并记录，不存在待取原单。
- 交接正文 `HANDOFF.md` 保存自有提交、原job/exit/Errors、两foreign文件、当前实际builder与正式提供方可见后的三例执行范围。新健康会话须由协调者落实；本次保存材料不冒称已建立新会话。
- AP0135 C2已接受限定候选875296/c79与原Node/E各1pass，不再重跑；同main后复核归R4，不扩到D2重启/完整notes组合。
- Value两普通正例真红、原30s/默认KDF及其它跨owner未决保持；当前不提前接native、不循环旧Crypto/Value失败，不宣称lane完成。

## 2026-11-05 续派：ZIP导入失败日志（X6-LP-0081部分）与两个日志误报核实

- 先merge main；初始queued gate `20261105071545-010ea2` 仍两个非本lane ledger脏改动前置exit2，无Errors行。仅读R4新增§18–19，四个F3夹具原红项已限定签收，不重复；两个Value普通it.each的真红仍待正式F4同树。
- 新回归 `e1a89fad9`：真实F3/Host，生成实际ZIP内的坏manifest，经kernel初次import失败、真实持久化checkpoint→resume再失败；原诊断/初次清目录/续传保留/许可释放均核实。
  Rust commands_zip.rs:1583/:1891要求不同前缀的error，修前 `20261105071928-af7de9` 1 failed/35 filtered/exit1：走完两入口后应有两条error但实际[]；无额外Errors行，原失败保留。
- 修复 `493b5afd4` 仅在非取消catch加host error，按resumable区分“ZIP 导入任务失败”与“ZIP 导入失败”，保原始诊断；任务结果、审计/清理顺序、锁finally、取消分支与预算均不改。
  Node `20261105072249-ff6b97` / Electron `-2a3bb1` 各1 passed/35 filtered/exit0（1501/1282ms）；strict `-404504` 两文件0违规/exit0，typecheck `-1434d7` exit0，均无Errors行。
  仅关闭该两个漏日志的候选缺口，原LP-0081第三个虚拟URI复制error不在本轮范围，整个finding尚不统签；不重跑B10/registry/工具五路/全目录。
- LP-0070四warn、LP-0071两warn经逐分支生产源码已核存在：原粗关联计数不能证明缺失。稳定表/SPEC记录Rust→实际分支→host logger注入点，不加重复日志或为已正确源码制造回归。
- F4 native及Value正式出口当前main仍无，不提前装配/复制实现，不循环三Crypto或Value原红项；默认KDF/原30s与两个普通正例强断言均保留。

## 2026-11-05 续派：数据库恢复陈旧Lance清理补证（X6-AP-0069）

- `git merge --no-edit main` 已是最新；F4 native增补仍仅合同，当前 `SecretsServiceOptions` 无native参数、Value正式出口亦未发布，不提前接线或重跑原红灯。
- 候选 `0193b05cb`：Rust backup/mod.rs:7093删除源数据库，:7095-7097实际预置目标 `databases/lance/vfs/stale_table.lance/stale.bin`，补:7104-7107整个Lance目录不存在。
  原备份含vfs/verify成功/恢复库存在/实际行数2断言全部保持；非空断言由原some(vfs)蕴含，不凑expect计数。
- 安装真实L11插件，执行实际 `RestoreCommands.executeRestore` 可达的数据库恢复→prepare→finalize函数，false选择database-only无完整Lance组件分支；
  不复制owner SQL、不新增清理替身、不修改生产实现。是局部生产组件组合回归，不冒称kernel完整恢复或再次签收B05，不复活停用原地恢复命令。
- Node `20261105065735-b0bc87` / Electron `-e5382f` 各1 passed/18 filtered/exit0（960/871ms）。首轮 `20261105065640-15dd0b` / `-347374` 因筛选表达式错误19 filtered/0执行，exit0不计验收；已纠正筛选，并非重复通过用例求绿。
  strict `20261105065640-fb849f` 一文件0违规/exit0；typecheck `-d037f8` exit0，均无Errors行。原预算不变，其余Value/Crypto等真实失败与跨owner阻塞不抵消，待独立复核。

## 2026-11-05 续派：取消后的完整重试生产证据（X6-AP-0135）

- 先merge main；初始gate `20261105061748-2ef2e9` 仍两个非L21 migration脏产物前置exit2，无Errors行。F4 Value/native性能接线尚待正式提供，不重跑未变Value红灯或AP0137超时。
- 测试检查点 `875296fbc`：Rust restore_domain_plan_tests.rs:704 notes非空、:735-737清槽后为空两个前置补齐。
  原首文件落盘后取消语义/无lease/activeA/候选半成品四expect保留；原retry仅asset helper+手工mark lease不能证明完整重试，现调用真实kernel restore_backup。
- 本例fixture仅把core占位字节改实际SQLite marker、真实size/hash/database_id及生产updateCoverage/markFull；完整F3/F4服务、实际L11/L20调用，
  不使用本例旧fakePublication/伪refinery版本。host先dispose后删临时输入；waitForJob传Vitest signal，原默认30s不变，不把步骤移hook。
- 实际job completed/result.success/requires_restart、database_count4/restored_assets1替代原仅恢复计数1，保持原资产数1语义并证明不是部分成功；
  Rust:744 chat marker/:749-758重试notes/:760-765 webview三结果补齐，租约由生产cutover登记，不由测试冒充；:775-777 slotB/backup_id/activation=false原断言保留。
- Node `20261105062946-da2532` / Electron `-dd8d1b` 各1 passed/12 filtered/exit0（6809/6575ms）；
  typecheck `20261105062947-dd2015` exit0，strict `-103b53` 一文件0违规/exit0，均无Errors行。仅本case候选补证，待独立复核，不签lane完成或解除其它红灯。

## 2026-11-05 续派：ZIP密封残留/显式密码真实链（X6-AP-0136、0137；F4 native性能接线待发布）

- 先merge main；初始gate `20261105050122-dea0de` 仍两个非L21 migration脏产物前置exit2，无Errors行。F4 Value出口仍未main，原两个普通it.each真红不变，不重复未变测试求绿。
- 测试候选 `5cfcd00a7`：AP-0136修正原import target与source backup同目录的fixture错误，不能把原明文manifest误当错密码残留；
  clean/从真实导出ZIP原文预存sealed-residue两输入覆盖Rust:504-523分支。残留load→included_encrypted→生产validate拒绝→kernel restoreAssets=false明确封存拒绝；
  原四库hash不变保留，目标升级为真实SQLite，旧UTF8文件串断言改对应Rust:525起真实SQLite marker查询（同pre-restore-data值/all四库），不删弱保护。
- AP-0137保原缺密码fail-closed/portable/stored/explicit解析取值与peek方向，resolver结果真正传export，不再旁路硬编码；
  补Rust:814真实explicit密封入口、:821-826显式密码实际解封成功、:827-833 stored不能解封显式覆盖产物。
  两例改F4真实createSecretsService公开方法+真实SQLite/metadata/生产updateCoverage输入，不用FAKE-DSBK头充密码oracle，不改F4实现/默认KDF/预算。
- Node `20261105052534-d6ce14`：3 passed/7 filtered/exit0（clean2014ms/residue1570ms/stored3901ms）；
  Electron `-4a3bbf`：2 passed/1 failed/7 filtered/exit1（clean28752ms/residue27299ms，stored38634ms触发原30000ms timeout）。
  typecheck `20261105052535-1fd748` exit0、strict `-cddab9` 一文件0违规/exit0，无额外Errors行。E失败/原强断言保留，AP0137未完成，不以Node绿抵消。
- 后端只读诊断 `20261105053507-bcad81` exit0：Node26.5与Electron45.2/Node24.22均有argon2符号；符号存在不等可用。
  `20261105053909-3d6e7d` 按F4:70-88相同最小原生probe，Node成功length4，E抛ERR_CRYPTO_ARGON2_NOT_SUPPORTED，确认F4:99-104在E选JS argon2idAsync回退；
  未据此分解该case各阶段或改测试分支/跳过。真实测试始终默认m65536/t3/p4，未低成本KDF/跨runtime偷跑/换假cipher/移到hook规避预算。
- **C2后续裁定已收到：先性能接线，不批准扩30s**。已派active F4最小真实消费已main的F7 nativeArgon2（既有E默认参数字节/timer证据由提供方保留），不重写parked F7或加新包。
  保本三例真实F4/密封残留/显式覆盖链、默认KDF/原预算；待提供方正常main或C2明确固定联合树后，仅复验本三入口，不循环同图重跑。
  真native后仍超时才按实际阶段证据再裁定，不能预设全部KDF解释；issue1原30s、W69/P36阈值不受影响。
  只补本lane未修AP，不重做R4已签B05/B09/init、原registry/工具五路或全量；当前还存在Value两真红，整个lane仍不能签收。

## 2026-11-05 续派：治理任务回执TTL默认时钟（L21-GOV-RECEIPT-CLOCK）

- 先merge main；本轮初始自检 `20261105043218-ea3b69` 仍仅因两个非L21 migration脏产物前置exit2，无Errors行。
  F4正式Value API仍未在main，两个普通it.each正例的现有真红/四owner闭包不变，不重跑这些未变失败或全域工具/registry求绿。
- `302f2c4d5`：Rust data_governance_executor.rs:58/165/202/793-815用Instant及24h saturating_duration_since；
  原rememberBackupJob/wasAgentBackupJob默认Date.now，墙钟前跳会提前忘掉agent回执，把应该可识别的expired变not_found。
  两默认统一performance.now；显式nowMs仍同一单调毫秒轴，24h/容量256/去重/未来时间饱和逻辑不变，公开job日期和其它时钟不改，未引入Clock框架或兼容层。
- 新回归只spy墙钟环境，不替换被测helper/不复制TTL逻辑；修前 `20261105043437-28ec52` 为1 failed/1 passed/exit1：前跳使known=false，24h边界控制原本正确。
  新前/后跳及TTL-1/TTL边界保留；原Rust:1019 known true/:1020 unknown false两expect原样，旧fixture now改performance对应:1017 Instant，不删弱断言/加预算。
- 修后Node `20261105043756-c40b35` / Electron `-3a1d86` 各3 passed/8 filtered/exit0，strict `-871280` 两文件0违规/exit0，均无Errors行；
  typecheck `-d01c22` exit0，无Errors行。生产连接仍为实际execute的backup_create→remember、backup_job_status→was，未改业务五路或其它owner实现。
- 这是回执保留期的单点候选，未自签独立复核，不因此关闭sync_run本次取消/超时、F4 Value两红、main-red原全量慢阶段或其余B项。

## 2026-11-05 最新dd564 main-red与Value门禁反馈（只做有证据的最小改动）

- 已按新反馈merge main；F4正式Value出口仍未在当前main，最新集成所列两个arbitrary_precision失败正是91067dab2恢复执行后保留的红灯，
  继续交四owner闭包，不重跑整目录求绿/不恢复skip，不以当前旧parser或未规范化raw候选替代正式F4合同。
- 原fulltest `dd564e12f9ced043381b3b61410a01aba38a1a1b` / 03:04Z仅backup的issue1失败，duration=33233.423755ms，JSON只留STACK_TRACE_ERROR。
  已亲读安装Vitest3.2.7 runner:638/641、withTimeout:1871-1885、makeTimeoutError:2005-2010；C2也核JSON reporter优先stack，
  因此能确认30s deadline路径遮住原timeout message，不能当迁移业务自己抛错；仍不能定位runAll/文件重建/needsMigration哪个阶段慢或判CPU根因。
- `fix(main-red)` `588f089f8` 仅移除与Rust测试helper:51-57不一致的额外工作：dbPath复用既有生产databasePath，不为文件名new F3 coordinator/重载迁移SQL。
  一次实际转发原readFileSync的探针 `20261105032129-4a53ea` exit0：同路径，旧131次SQL读/新0；14.66ms/0.03ms只是这次helper开销，不能解释整个33s或签全量修好。
  原runAll空库完整迁移/初始success/四库无需迁移/VFS删除及旧init-history重建/最终需迁移步骤和assert均保留，没有移出预算/复用伪历史/增至60s。
- 定向原issue1+全迁移四路径验证：Node `20261105032414-145386` / Electron `20261105032413-38b8e2` 各2 passed/90 filtered/exit0，
  issue1分别4249ms/4311ms；typecheck `20261105032414-8610b4`、strict `20261105032413-c63891` 一文件0违规均exit0，无Errors行。
  仅证明确定额外IO已去除；原全量失败阶段仍待infra在后续正常fulltest保message+stack/有效worker环境，不为取报文重跑全量，30s原预算不变。

## 2026-11-05 消费新main L07登记disposer（L21-GOV-REG-LIFETIME）

- L07新公开合同已main：registerToolExecutors按每调用返回kernel.Disposer对象，.dispose幂等且只移除该调用，旧snapshot不变/后来同对象同名登记不受影响。
  真实L07+完整F3/F4平台宿主基线 `20261105033137-8a4122` 两失败/exit1：已有provider时Root立即+注入两路径造成2重复；晚到/替换后backup卸载残留1。
- 修复 `b1f090a2f`：只用ctx.inject依赖作用域登记一次，捕获正式registration对象，以Cordis函数清理回调调用.dispose，不再用trace proxy对象身份猜去重，不按名称/对象清表。
  新早/晚真实provider、替换、backup卸载、旧snapshot及后来同对象的独立登记均实际验证；未调用工具五路业务，不重做已签子项/全App花名册。
- 初次适配误把Disposer当可调用函数：Node `20261105034122-03d93a` / Electron `-876be2` 各2失败/2通过/exit1；
  typecheck `-6f2328` exit2两处类型错。已按公开primitives.Disposer.dispose修正本轮代码/新fixture，不归因owner、不改卸载/快照/独立调用断言，原日志保留。
- 修后Node `20261105035249-5baf6a` / Electron `-f1080e` 各2 files/4 passed/9 filtered/exit0，
  typecheck `-2be620` exit0、strict `-075f45` 三文件0违规/exit0，均无Errors行；旧两metadata测试改用公开AgentToolExecutorRegistry提供真实disposer，原name/canHandle断言保留。
  测试最新形状由检查点6b93d7be8保存，旧metadata fixture真实registry改动为7b58c598a；不以本次登记清理绿抵消Value两真红或sync_run本次取消/超时未闭环。

## 2026-11-05 续派：审计域计划/恢复前置断言（X6-AP-0074、0134）

- 先merge main；本轮初始gate `20261105021818-bfaf13` 仍仅因两个非L21 migration脏产物前置exit2，无Errors行，未处理它们。
- 测试检查点 `d02f72cc4`：AP-0074对照Rust backup/mod.rs:7708-7712，在真实backup生成后/改写audit文件及hash之前，
  补计划files.len=1、file_count=1、restore_scope=application_data、文件路径databases/audit.db、SHA256长度64五断言。
  原改写文件/重算hash、verify失败与错误包含audit路径的两个expect保留；只补已存在生产字段证据，不改生产算法或审计库位置裁定。
- AP-0134对照Rust restore_domain_plan_tests.rs:382补目标audit文件不存在断言，路径只提取为同一局部变量；
  仍调用生产consumeCompleteDomains→restoreAuditDomain/restoreAuditDb，原state=restored及真实SQLite marker终态两expect保留，不从残留文件假绿。
- Node `20261105022404-659965` / Electron `20261105022404-440b79` 各2 files/2 passed/30 filtered/exit0，
  typecheck `20261105022404-a1de51` exit0，strict `20261105022404-2f7f7f` 两文件/0违规/exit0，均无Errors行。
  未重跑已签B05/B09/三个初始化子项，不改旧预算或TESTMAP/ACCEPTANCE生成行；候选待独立复核，不因两例绿覆盖当前Value两例真实红灯。

## 2026-11-05 C2纠正：恢复两个Value正例执行，当前功能测试真实红灯

- 接受纠正：此前将“完成状态pending”误解为可用it.skip禁用测试，没有获得授权。已将audit-decode两组正例恢复普通it.each，
  原合法对象/数组输入、not.toBeNull及精确数字token重存断言全部保留（1e999→1e+999，不能null/Infinity/业务string）；不用it.fails、不删用例、不做能力探测跳过。
- 仅排对应Value正例、真正坏JSON/SQL NULL/空串fallback与typed边界：Node `20261105022638-b0d5a2` / Electron `20261105022638-5547a9`
  各2 failed / 4 passed / 35 filtered / exit1，无额外Errors行。两失败都是details=null违反not.toBeNull，完整失败日志保留，不能以旧450pass+2skip签任意Value或当前HEAD功能全绿。
- F4 `fd920f955` / `5106246c9` 保存合同是已发布候选、尚非当前main；当前旧Value parser仍拒绝合法超f64数。
  等正式provider+consumer四owner闭包同树后消费jsonNumberToRawJSON并只复验对应正例/fallback/typed，不私拷parser、不用Infinity/null替代，不再循环全目录求绿。
- 本次不重做已通过的registry两项/工具五路；它们既有复验不等于原门禁根因已修。新AP-0074/0134审计域断言补证另列，不与此真实失败混算。

## 2026-11-05 集成再反馈：两个真实registry测试（原失败栈待补，未改断言/预算）

- 已再次merge main。门禁摘要 `integrate-auto-2026-11-05T004127491Z.log` / `012647463Z.log` 重复列出
  test_schema_registry_aggregation_after_migration、test_schema_registry_dependency_check；gate-fail原tip `50ae2d5a627c8e49081607a4b9709c3168eb2c51` / 01:03:42。
  此tip早于本轮details/工具execute增量，不能从旧名字反推新代码回归。门禁runner只保留judge摘要，未找到两例原始栈/时长，已向协调者/infra精确请求原输出。
- 已对该tip与当前HEAD做限定路径diff：两例测试所在文件、L21 schema-registry/src-migrations、F3 migration-worker/迁移实现及src-tauri/migrations均无改动；
  这是直接输入/实现路径的来源核实，不外推所有运行环境相同，也不代替失败栈。
- `migrations-metadata.withMigratedRegistry` 保持真实F3 worker runAll→真实SQLite历史→生产聚合/依赖检查；本轮尚未修改此文件、原assert或30s预算。
  不因R4已签就忽略新失败，也不改回latestOpener/自造历史；先按原配置取当前树完整日志。
- 按新指令队列 `20261105013658-da0ae3` typecheck、`-98b93d` 全boundaries、`-df5cc5` 全backup目录；
  boundaries已2966files/0违规/216原allow/exit0，无Errors行。Electron原两红最小集 `-6c4ef2` 为2 passed/17 filtered/exit0，无Errors行，
  typecheck `-da0ae3` exit0，无Errors行；两例分别22774ms/26919ms（原默认30s未变）。
  Node完整 `-df5cc5` 最终28 files / 450 passed / 2 skipped / exit0，684.58s，无Errors行；metadata文件19例全通过，原两例25886ms/23011ms。
  该历史回执的两skip未获授权，现已恢复普通it.each且两例真实失败；保留450+2旧数字不等于当前HEAD功能绿。原registry两项本轮未复现，未修改metadata/F3迁移源码、assert或预算，
  不虚构“已修复”的具体原因、不把一次队列全绿当作旧集成并发环境已相同；原门禁原栈/时长和实际worker环境仍请求infra补证。
- 另有可核环境线索：jobs/runner.mjs:82为作业默认设置VITEST_MAX_FORKS/MAX_THREADS=3，旧gate-runner:19直接spawn仅继承父env+check.env，没有相同默认cap。
  原集成父env实际值未取得，因此不能认定是并发导致；已上报infra/C2核实/保存worker环境及原stdout，L21不越界改调度器、不反复跑压力或改测试budget。

## 2026-11-05 C2即时任务：DataGovernanceToolExecutor实际业务执行（L21-GOV-EXEC）

- 已亲读F1原 `20261105003527-c8eec3`：真实宿主两份DataGovernanceToolExecutor贡献executable=false，其它缺失花名册另列；不把全域roster任务转本lane。
  实现检查点 `276cc2123`：同名class不再只有metadata，实际execute消费公开ChatExecutionContext，五路业务路由复用本ownerbackup与L20 API。
  backup@1新增getBackupList/runBackup薄业务面，和UI共用BackupCommands/Jobs；保catalog/分页、queued回执、job found/expired/not_found、sync本地状态/警告与SSOT fail-closed。
  统一start→end/error→ToolResultInfo→saveToolBlock次序，成功省error、失败output=null；单调时长，真实save失败只warn不覆盖业务结果。
- 新测试安装真实L07/L04/L20/L11+完整F3，使用L07贡献的本owner实例创建L04实际registry；全App assemble仍由组合根验，不伪造其它60余执行器填花名册、不改生产闭门。
  初轮Node `20261105010823-64cb55` / Electron `20261105010823-0c5157` 各5失败/48通过/2明确pending/exit1：错误尝试全App组装，缺其它owner。
  次轮 `20261105011155-1e27d8` / `-54e9b9` 各2失败/3通过/exit1：新fixture误读end.payload（Rust实际end.result），及后台备份维护期间重新借主库。
  已按Rust事件字段/执行前长期持有句柄修fixture，未删业务断言/加预算，原日志均保留；检查点2ff8f067e及后续修正关联这些新测试。
- 修后Node `20261105011525-f0f105` / Electron `20261105011525-05771c` 各5 passed/exit0，无Errors行：
  实际catalog+事件+工具块落盘、真实创建与job查找三分支、参数失败存块、L20真实状态与未配置SSOT拒绝、F3真实维护使save失败但保成功结果。
  本轮typecheck `20261105010823-150191` exit0；strict `20261105010823-a680b3` 六文件0违规/exit0，均无Errors行。
- 随后按Rust:391-403补未知工具优先于arguments解析的match顺序；未变更四条业务入口。Node `20261105012927-6221d5` / Electron `20261105012928-d742d0`
  只跑该参数/未知工具案例各1 passed/4 filtered/exit0，strict `20261105012928-ef343d` 六文件0违规/exit0、最终typecheck `20261105012928-98f097` exit0，均无Errors行。
- **未签范围**：sync_run普通runSync没有本次signal/取消/超时释放公开面；api.cancelSync仅针对progress全局控制器，不调用它打断别人的任务，不用Promise.race声称已停止I/O。
  提供方L20归C2，C2已追加架构parked接管；C1仅ExecutionContext/真实registry侧，不整体转错owner。四已可接分支和统一执行不因该接缝停工，但不把五条工具全域生命周期签完成。
- F4 Value合同现已收到 `fd920f955` / `5106246c9`：待正常main消费jsonNumberToRawJSON，合法1e999保存数字1e+999，不能用当前未规范化raw候选或旧42绿签收。
  审计两个合法超f64/高精度Value正例完成状态pending，但现已普通it.each执行/两例真红；旧48通过含纯治理9+审计39的回执不替代F4 arbitrary同树回归。

## 2026-11-05 续派：审计details JSON整数/坏值降级（自查 L21-D3-AUDIT-DETAILS；C2纠正后pending）

- **C2立即纠正已接受，撤回原1e999→null预期/完成推论**：桌面Cargo图dstu-agent/vfs/notes/sync/media等显式arbitrary_precision；
  audit/mod.rs:38的details为Value，:799-804的from_str推导Value，合法1e999不是坏JSON。下方64eb及42绿仅是旧main parser+错误新预期的历史，不能用于桌面Value签收。
  两个合法超f64/高精度Value正例完成状态pending，已普通it.each执行并保留完整精确重存断言/真实失败；只有真正坏JSON/SQL NULL/空串属于原fallback。
  F4已回复fd920f955/5106246c9正式jsonNumberToRawJSON/stringifyJsonValue；待正常main消费规范化数字原子，不复制lexer/解析算法、不用功能探测/错误预期迁就旧parser。
- F4完整tsc原 `20261105001519-08b811` exit2指出旧uint从Value联合直接.value缺口；现uint改正式typed readNumber，
  details候选明确区分u64/i64与其他raw数字，其他数以标准JSON.rawJSON原子保留，不访问arbitrary.value、不先Number。
  typed整数拒绝1e999与Value接收1e999是两条路径；缺正式同树验证前仍不能把本候选写完成。

- 先merge main；本轮队列gate `20261105004045-c1c9ca` 仍因原有非L21两个migration脏产物前置exit2，无Errors行，未动这些文件。
  不重做R4已签B05/B09/初始化子项、不重跑ledger或旧main-red全目录；本轮是自有尚未核闭合的details精度缺口。
- `64ebae82d`：Rust audit/mod.rs:799-804以任意Value读details，:231保存Value。旧JSON.parse将合法宽i64/u64先舍入，并接收1e999为Infinity。
  私有递归映射复用F4 parseJsonDocument的完整文档/数值分类检查，安全整数维持number、宽整数bigint；对象/数组/root值与重复key last-wins保留。
  save的operation/details共享现有rawJSON bigint数字序列化；不套AuditOperation字段限制、不另造词法解析器、不新增IPC summary字段。
  原SQL NULL/空字符串/坏JSON降null逻辑保留；原“非有限数也降null”的判断已撤回，等待F4正式Value路径后以正例核实。
- 新8例走真实kernel/F3库、生产query/save：对象内嵌u64::MAX/i64::MIN、安全整数、root宽整数、数组宽整数、重复key/普通scalar控制与四种best-effort fallback。
  修前 `20261105004230-450820` 为4 failed/4 passed/exit1，原日志保留；未改变既有expect或预算。
- 修后Node `20261105004414-83920a` / Electron `20261105004415-c7fa99` 各4 files / 42 passed / 114 filtered / exit0，无Errors行，
  含原操作JSON/SQL时长、真实迁移审计save/query、同步save及切槽后失败审计关闭Started行。strict `20261105004414-ae0dea` 两文件/0违规/exit0，无Errors行；
  typecheck `20261105004415-8712a7` exit0。以上是旧main/F4有限Value图回执，无Errors行但不能外推桌面arbitrary图正确，原日志均保留。
- 本候选待正式Value数字投影/重存合同及F4同树复验；数值形对象键顺序/全Value差分及上游Number字节统计仍未统签。
  既有操作codec复杂多错优先级、B02实际维护状态/B03锁/B06报告策略/B07账本完整性等阻塞不因此解除，不自改ACCEPTANCE/GENERATED。

## 2026-11-05 C2/R4优先级校准（取R4分支ACCEPTANCE §15–17，只读）

- `git show ds-mig/R4-review-sync:host/plugins/backup/ACCEPTANCE.md` §15–17已读：R4在固定main 5b1b19055/90538c240/9b3c18601分别签收
  B05实际L11重置+恢复激活owner消费、B09真实prepare阶段错误与消费者映射、B06四个真迁移registry/依赖子项及三个实际F3初始化子项/正式审计save-query。
  B02的真实F2启动等待子项也已签；下方旧“待R4”仅是历史，不能继续据此排重复复验或重做实现。本lane只记录外部签收，不修改ACCEPTANCE。
- 仍开放：B02真实外部维护状态漏报、B03锁原语、B06两报告+两策略本地替身（另有原init/锁pending）、B07完整性。
  R4外部维护探针 `20261104210356-780ffc` 原exit1：真实F3外部mistakes租约已使借用抛MAINTENANCE，kernel状态仍false/blocked=[]；
  Governance仍只读Operations局部数组，F3 api只有维护租约/参与者注册，未提供实际组件维护状态的只读观察面。不能读private Set或猜current_operation。
  真实状态/初始化报告面由架构协调F3 owner提供；F3 parked期间不排执行消息、不造本地替代实现，接口缺口与原探针保留在BLOCKERS。
- C2再次提及的650ddffbe四项main-red已由 `ecff33220` 完整F3 fixture修复，且已核该提交为main祖先；
  指定Node全目录437例、Electron原四例、tsc/boundaries回执见上轮记录，不重跑。helper其他用途仍有旧fixture不等于这四项仍未修。
- 原作业最终回执已到（未重排）：只读ledger `20261105000417-9aaef4` exit0、无Errors行；全局commands1058/tests8109，
  problems commands0/tests0/orphan registrations0；prod-reachable unreachable16、unknown3633未否决。只证明机械账本检查通过，不证明本lane v2行为或全部可达性已签。
  lane-gate `20261105000642-4dc58d` exit2、无Errors行，在脏树前置检查列出 `migration/LEDGER.md` / `migration/ledger.json`，未启动后续检查。
  之前result的CLI75只是运行/排队状态，不是作业结果；两个非L21产物继续只请求infra处理，不暂存/还原/混提交，不另排重复ledger/gate。

## 2026-11-05 续派：AP尾项增量拒绝补证与同名关联纠错（AP-0100/0101/0102/0125）

- 先merge main（已最新），队列lane-gate `20261104235319-885efe` 仍因原有两个非L21 migration产物脏改动exit2，无Errors行；未混交/隐藏/清除。
- 测试候选 `09203c01b`：AP-0100按Rust critical_audit_tests.rs:848建立既有base目录并传baseVersion，保留:860错误文案与:878前后产物不变断言；
  同一个真实kernel Promise再验证精确string错误而非HandlerPanic对象，对应IncrementalBackupRemoved的公开Display合同，不新增协议tag/仅供测试的错误类。
- AP-0101按Rust:899-917真实写changes.json并按内容计算hash/size，原三个manifest校验/英文增量拒绝断言保留；
  追加真实kernel restore_backup→持久化清单解析→兼容性拒绝→jobs失败终态，精确检查result.success=false/result.error为原canonical拒绝文本加恢复上下文，
  不再只用直接validator证明恢复入口拒绝。Rust内部BackupError variant在Host公开面为string合同/异步job result，不声称新增了同名内部枚举。
- 初轮Node `20261104235648-01f04e` / Electron `20261104235648-786177` 各1 failed/1 passed/exit1：新增断言误读顶层job.error（undefined），
  Rust BackupJobSummary/ResultPayload（backup_job_manager.rs:142-150,201-218）明确为result.error。只改新断言字段，不改生产、不删旧expect/不扩大原30s预算，原日志保留。
  修后Node `20261104235815-f4eea0` / Electron `20261104235815-c8ac34` 各2 passed/90 filtered/exit0，无Errors行；
  strict `20261104235648-f43477` 一文件0违规/exit0，typecheck `20261104235648-61d74b` exit0，均无Errors行。
- **撤回之前AP-0125的GAP误判**：初次按扫描首个同名位置（原报告:553）误把migration_tests.rs的chain当作tests.rs的chain。
  实际两个describe各有一个同名测试；tests.rs的真实用例已有VFS<ChatV2、VFS<Mistakes两断言与await失败传播，分别对应Rust:587/:591/:568。
  原TESTMAP按完整Rust ID区分正确，不需改生成关联/新增排序assert；此纠错只改人工LANE说明，不自改原报告ID/基线位置。
- AP-0102静态3>2为Rust两分支互斥计数：同一连接checkpoint后写入再online backup，无并发写者，原TS source=3/destination=3覆盖实际单连接WAL可见分支；
  保留较强的destination=3，不为纸面计数放宽到2或造替身。证据仅是SQLite primitive回归，不冒充跨连接/进程竞争已安全；复用此前437例整目录回执，无需重跑。
- 当前固定80行已逐项审读79项（33 EQUIV、46缺口/候选/结构阻塞），另1项AP-0128保留历史重复关联；无未审项不代表无剩余工作或独立验收通过。

## 2026-11-05 协调者最高优先级：main-red四例 / 真实F3维护参与者夹具

- 先 `git merge --no-edit main`，保留既有非本lane `migration/LEDGER.md` / `migration/ledger.json` 改动。
  原始fulltest基线 `650ddffbef3c755dce9fc3b3eb2fe5502bf72382` / `2026-11-04T23:26:51.932Z`：
  两条B05 VFS reset、完整槽恢复、加密ZIP完整往返，全部failureMessages为 `TypeError: ctx.storage.registerMaintenanceParticipant is not a function`，
  栈为L11 index.ts:172 → helpers.installVfsRestoreOwner:223，耗时仅0.38–0.47秒。旧日志保留，不推断为超时或审计SQL回归。
- 归因：L11正确消费F3已发布参与者接口，本lane旧createRealStorage只是Connection包装+no-op维护，接口不完整。
  已立即coord escalate说明证据和处理归属：由L21改真实F3 fixture，F3/L11不需回退/改成可选调用。
- `fix(main-red)` 实现 `ecff33220`：backup-manager共用setupEnv、完整restore、加密完整ZIP往返改完整StorageServiceImpl；
  host卸载后dispose句柄，删除restore本地不完整存储副本，不添加no-op registerMaintenanceParticipant/兼容适配。
  没有改任何既有expect、Rust:6777/7032字段不变量、终态/槽/数据/lease断言或原60s/120s/issue1默认30s预算。
- Electron `20261104233518-7302dd`：3 files / 4 passed / 38 filtered / exit0，无Errors行，四个原红项全部实际执行恢复后原断言通过。
  全boundaries `20261104233518-862ddc`：2946 files / 0 violations / 215原有allow / exit0，无Errors行。
  typecheck `20261104233518-f2055e` exit0；按指令Node整目录 `20261104233518-5a602c` 为27 files / 437 passed / exit0，均无Errors行。
  这是本次真实F3 fixture修后完整目录回归（含四个原红项），不代替旧报告/策略影子测试的v2生产证据签收，也不关闭已有pending。
- 仅修本lane夹具/合同消费，不把局部绿外推D2失败政策/外部translation夹具/Registry锁/fs2/审计根位置问题已解除；待提交证据后再合main并运行lane-gate。

## 2026-11-05 续派：审计完成/失败断言接真实save/query（X6-AP-0114、0115）

- 实际测试改动由协调者检查点 `bdd58df6e` 保存、查询句柄修正 `d1204084b`；非被覆盖/丢失。Rust migration_tests.rs:1007-1023 / :1036-1058
  调用可失败的 AuditRepository.log_migration_complete/failed 后断言is_ok，再走正式query解码过滤。
  原TS却用始终成功的best-effort logMigrationAudit/Failure加局部SELECT，不能证明save失败传播或operation解析。
- 现用真实F3 `AuditLog(migrationOperation(...)).complete(150)/fail('Test failure') → saveAuditLog`（Rust audit/mod.rs:551-562、573-584的薄委托），
  `.not.toThrow` 分别对应:1009/:1039；再走L21生产 `queryAuditLogs` 的原Migration/Failed/limit10过滤与typed-row解码。
  完成用例原length1/Completed（:1022-1023）、失败用例原length1/error contains（:1053-1058）全部保留；
  failed参数to_version恢复原Rust的20260130、applied_count0，而非coordinator wrapper的from_version/额外duration。
  不复制查询SQL或审计算法，不改预算、不扩展best-effort生产策略，不把测试修复写成算法修复。
- Node `20261104231222-b70bd4` / Electron `20261104231222-a54571` 各2 passed / 90 filtered / exit0；
  strict `20261104231222-a6a2b4` 一文件 / 0 violations / exit0，均无Errors行。
  后续测试改动typecheck `20261104231222-e29c79` exit2：两处底层Connection缺SqlExecutor.one，这是本轮夹具错误，不是生产算法问题。
  已保留F3 Connection的真实save，查询改由完整StorageService.openFile句柄执行，finally关闭/释放，不加as强转/适配包装。
  修后Node `20261104231632-2ddaaf` / Electron `20261104231632-d54eef` 各2 passed/exit0、strict `20261104231632-d2deb0` 一文件零违规/exit0，均无Errors行；
  typecheck `20261104231632-d5a724` exit0，无Errors行；原失败日志保留。
- 候选仅补齐两条真实生产链证据，待正常main后独立复核；固定AP ID/原报告位置不变，未手改TESTMAP生成区或ACCEPTANCE。
- 排队期间补做 AP-0104–0110 逐断言审读，均EQUIV（详见固定表）：6条的差值为真实F3直接调用/await所保障的Rust is_ok；
  AP-0110由expectMigrationError的抛错/类型检查与detail整体toEqual覆盖is_err及kind/database/dependency。无测试/实现改动，不重跑用例凑回执。
- AP-0112 / 0132同为await自然失败传播等价is_ok，原逐库success/两次报告成功与次应用0断言齐全，EQUIV。
  AP-0125曾被误记为排序缺口；本轮按完整describe+同名测试核实后撤回：tests.rs专属chain已有两条排序断言，详见最新纠错记录，不补冗余测试。
- AP-0119–0123也已逐条对照：前四条缺的均是直接F3调用所保障的is_ok；run_all的四个实际数据库路径断言由ALL_ORDERED循环全覆盖，
  加await失败传播后无遗漏。仅补映射，未把生产迁移的其他实现问题顺带签收，也不为已有等价断言再跑迁移集成测试。

## 2026-11-05 续派：SQLite审计时长精度与typed-row顺序（自查 L21-D3-AUDIT-ROW）

- 本轮先合main为 `bd0975335`；原有非L21的 `migration/LEDGER.md` / `migration/ledger.json` 仍脏，原lane-gate前置检查exit2，未清理/暂存/提交它们。
- 测试检查点 `2fdfab718`，实现 `e3707d7ec`：Rust audit/mod.rs:768-776 先按列序FromSql，再解析时间/operation。
  F3 query safeIntegers 保留INTEGER bigint并区分REAL；读取0..8列严格按String/Option<String>/Option<u64>类型与先后，
  非负安全时长维持number、宽时长bigint、NULL维持null；仅toAuditLogResponse在线上边界转number，save绑定不丢低位。
  负INTEGER及REAL/TEXT/BLOB错误采用当前Cargo.lock中的rusqlite0.40.1原Display与命令原外层前缀。
- 新增8个真实kernel/F3 SQLite回归：负数/REAL/TEXT/BLOB拒绝、SQL时长先于坏timestamp/JSON、列2错误先于列6、NULL控制、i64::MAX读/重存精确且summary才舍入。
  修前 `20261104230230-ec563f` 为7 failed / 1 passed / exit1，原失败日志保留；没有改旧断言或预算。
- 修后 Node `20261104230815-86d6b9` / Electron `20261104230815-c7d1f2` 各4 files / 34 passed / 114 filtered / exit0；无Errors行。
  包含原23项审计解码、8个SQL回归、真实迁移生产者save/query、Sync生产者save、切槽失败终态审计close-started回归。
  strict `20261104230815-e8aaaa` 两文件 / 0 violations / exit0，typecheck `20261104230815-b9d485` exit0，均无Errors行。
- 持续时间生产者已审读：备份/ZIP截断、恢复round、清理0、L20同步结果floor，均整数毫秒，无需在读库时掩盖非法值。
  证据仅为生产入口回归+源码映射，未自签独立复核、不复用稳定X6编号、不将本窄修复外推到details/复杂serde多错/上游Number字节统计或整个D3。
- 同域顺带完成 AP-0113 逐断言审读：真实F3 init的直接失败传播等价Rust is_ok，两个原expect分别覆盖表和索引；无缺失语义，不为计数追加测试/重跑。
- 已提交并再次合main后，队列lane-gate `20261104231525-b2124c` 仍在前置脏树检查exit2（无Errors行），同上两个非L21产物；
  已在BLOCKERS列出并通过coord escalate上报，未用定向绿代替正式自检，也未借此重跑ledger/全量/issue1性能诊断。

## 2026-11-05 续派：审计JSON整数词法/精度（X6-UD-0014）

- 先合 main → `5a4ffc83c`，自检仍因两个既有 migration 文件改动退出2；未提交/清除或隐藏它们。
- 实际反例：旧 `JSON.parse → decodeAuditOperation(number)` 把u64最大值读成18446744073709552000，
  还接收u64上界外、1.0/1e0/-0与重复已知字段，拒绝Serde合法unit-enum map。修前 `20261104220456-95acab` 新10例全失败，exit1保留。
- dd9034566 + 测试检查点d3c860e03改走正式 F4 JsonReader/jsonUnexpected；先以bigint检查u32/64位usize/u64，
  安全范围外保持bigint。内部操作字段扩大为number|bigint；save用标准JSON.rawJSON原样写JSON数字，不加引号/不先Number。
  正式kernel查询与生产query/save回环证明三种操作的合法u64最大值读写精确，不仅测私有decoder。
- 已知字段缺失/重复拒绝，未知字段（含重复未知key）忽略，单元枚举字符串/单键null map接收，非unit载荷拒绝；
  未改变分页summary字段。原8个普通/时间/失败回归保留；旧自加未知variant/负数错误断言改为serde visitor诊断，不放宽条件。
  状态unknown→Started已核与Rust:840-846一致，无需“补修”。
- Audit测试夹具改用完整真实StorageServiceImpl并随scope关闭缓存句柄，不再用no-op维护/未关闭连接或as unknown as SqlExecutor。
  Node `20261104221226-a0c37c` / Electron `20261104221226-1c1f9e` 各24 passed/exit0，含真实F3迁移审计生产者读回；
  typecheck `20261104221226-007d74` exit0，均无Errors行。strict边界 `20261104222019-3d4a31`：2 files / 0 violations / exit0。
- 这是窄codec候选，不签完整serde/D3：复杂多错输入优先级/位置、details任意JSON Value、SQLite duration宽整数、
  上游既有Number字节生产路径仍需另核；不把此次24绿外推成整仓或整lane完成，不重跑main-red诊断/ledger/全量。

## 2026-11-05 续派：初始化证据排雷、真实启动与审计查询（B06 / X6-AP-0103、0131）

- 先确认 main 无新变化、尝试 lane-gate；仍由两个既有 migration 文件改动阻塞，未隐藏/提交他人改动。
- 初步确认7个旧ported有本地副本问题：5个初始化、2个策略。进一步用已存在的正式F3插件入口解决3个不读取报告字段的用例，
  **当前仅2个报告+2个策略共4项仍缺生产证据**；完整Rust ID/状态见BLOCKERS§1.0.1，不与已有init.rs七项/锁一项混淆。
  原7项元数据请求已向架构收窄为这4项，F3请求也只剩真实启动实现的窄报告/registry观察面，不要求另造初始化算法；
  本轮遵守不手改GENERATED，未删原断言/加skip。313ported/10pending只为形式现状，不能作为真实完成数。
- d9d47f792（自动检查点）移除本地 needsInitialization 薄封装，改直接测真实 MigrationCoordinator.pendingMigrationsCount：
  两新库用例断言>0，原后初始化两例断言=0；后两例最初仍有本地编排，现改正式插件入口，见下文。
  真实初始化API未提供前，不恢复那7个init.rs pending，也不把调用生产子步骤的测试拼装当作生产初始化。
- AP-0131：原用 COUNT 只能看operation_type列，不能发现损坏/错误operation_data。现以正式F3 AuditLog.complete/save
  （Rust audit/mod.rs:551-562的真实委托）校验保存不抛错，再以真实F3句柄调用生产 queryAuditLogs 进行过滤/解码并断言一条记录；
  对应 tests.rs:905-920，不用best-effort wrapper或本地insert SQL代替原Result语义。
- Node `20261104202728-944320` / Electron `20261104202728-929f4a` 各3 passed / exit0（只运行两个新库pending-count与审计记录用例），
  typecheck `20261104202728-d1b63f` exit0，均无Errors行。未运行5个影子初始化用例来刷绿，也未重复main-red诊断或全量压力。
- 3个可通过已有入口解决的用例：真实F4 paths/log/secrets → 实际F3 storage插件安装 → 正常模式/pending-count；
  AP-0103另在写原resource夹具后卸载/重装真实F3，读当前实际storage相同payload并断言活动路径稳定。
  helper只供给依赖/执行公开生命周期，不复制目录、审计、迁移、聚合或报告逻辑。
- 初版实际插件用例已在 d38f85/1e81c4 各3例通过；随后发现测试系统目录与app根共用会改变legacy迁移输入，
  改为独立私有系统根并检查新app根为空后，最终 Node `20261104210258-0b127b` / Electron `20261104210258-224e82`
  各3 passed/exit0，typecheck `20261104210258-2198ec` exit0，均无Errors行。原默认30s未改。
- 上述代码由 d9d47f792/b7a063ff6/d25ccf1d7/5e27abda5/ca16e6fae 自动检查点保存，428211444关联修复ID与原断言映射；
  当前本地 initializeWithReport 仅剩2个报告用例，复制策略仅剩2个用例，未据这些旧副本签收生产行为。
  最终变更文件 strict boundaries `20261104211811-b4c1be`：1 file / 0 violations / exit0。
- AP-0126/0130按原Rust逐语义已为EQUIV：生产runAll的await失败自然使测试失败；审计初始化直接调用失败会抛错。
  不补重复expect凑计数。AP-0103已为真实入口候选；AP-0117/0129仍是报告结构阻塞，不只差几个expect。

## 2026-11-05 续派：Registry 假历史夹具移除（B06 / X6-AP-0116、0127）

- 本轮起点 main 与 `95a9e3b95` 一致，无新反馈可解除；lane-gate 仍因既有两个非本 lane 的 migration 文件改动退出2，未掩盖或提交。
- `migrations-metadata.test.ts` 原四 Registry 用例只写空文件，再由 latestOpener 直接返回 latestVersion，不能证明迁移/聚合。
  6d0c88509（自动检查点）/41ea02bf9（ID/断言映射）移除此 opener、无校验 SqlExecutor 强转、空文件占位与no-op关闭。
  改为真实 F3 worker迁移四库 → 真实 F3句柄 → `Governance.refreshSchemaRegistry` 实际调用的生产聚合函数，使用相同 F4时钟；
  测最新版本取正式F3集合，原L21版本表断言也保留以检测漂移。未添加本地迁移/初始化报告算法，不更改原30s测试预算。
- AP-0116 逐项补 global_version>0、各库状态存在、正版本与正式目标版本；AP-0127 同样验证存在/正版本，保留更强的原latest断言。
  两 Registry 依赖检查成功用例也使用真实迁移后聚合，而不消费伪造历史。原用例名与TESTMAP去向不动，8个初始化/锁pending保持不动。
- 首轮新fixture漏传必需时钟：Node `20261104194458-5afaf0`、Electron `20261104194458-fba51c` exit1，
  typecheck `20261104194458-6d4300` exit2；错误均为缺第三参数/now不是函数，属于本次fixture错误，不报成生产缺陷，原日志保留。
- 补齐与生产相同的 `toRfc3339` 后：Node `20261104194945-2b7b0d` 4 passed / exit0；
  Electron `20261104194945-af8fe2` 4 passed / exit0；typecheck `20261104194945-50934e` exit0，均无Errors行。
  变更文件 strict boundaries `20261104195702-d1b56e`：1 file / 0 violations / exit0。
  全部只跑变更范围；未扩大预算、重跑全目录、ledger或main-red诊断。仍待正常main后的独立复核，不签收B06整组。

## 2026-11-05 续派：迁移依赖/集合测试结构纠正（X6-AP-0111/0118/0124/0133）

- 先 merge main → `13fe76bb7`。自检仍因原有两个非本 lane 的 migration 文件改动退出2，未提交或清除它们。
- main `cce44494c` 已合入 finalizer 注册，但 translation C1夹具仍只有 storage.locations；与旧失败作业被测两文件无差异。
  已再次向协调者升级主线新红灯，未重复运行旧反例、未越界改translation或在生产跳过必需钩子。
- `migrations-metadata.test.ts` 的依赖三用例原结构不对应 Rust：它们构造 SchemaRegistry 并检查其错误，
  而 `migration_tests.rs:890-907,917-934` / `tests.rs:512-528,540-556` 被测是 MigrationCoordinator + MigrationReport。
  `a8fc93a40` 改为正式 F3 协调器（生产 runAll 实际调用的方法）及原报告夹具，真实异常类型与 detail 的 kind/database/dependency 全部匹配。
  两成功用例分别保留原 VFS toVersion=20260203/实际迁移数与20260131/2的不同夹具，不用一个看似相近的 Registry 成功代替。
- Node `20261104191009-c06c00`：3 passed/exit0；Electron `20261104191009-e84faa`：3 passed/exit0；
  typecheck `20261104191009-a8d4a7` exit0，均无Errors行。只跑纠正用例，不执行无关整库迁移/压力，也不改 TESTMAP/ACCEPTANCE。
- `521f0e397` 补正式 F3 MigrationSet 属性断言，而不只核对 L21 自己的版本数组；原消费侧断言保留。
  固定四个 Rust 集合名/基线，VFS/Chat声明数量与版本常量、Mistakes/LLM最低版本逐项对应（详见AP两行），无SQL迁移。
  Node `20261104191816-529d45` 1 passed/exit0，Electron `20261104191816-3d608e` 1 passed/exit0；
  typecheck `20261104191816-c36623` exit0。通过运行无Errors行，全部仍待main后独立复核，不据静态expect数签收。
  变更文件严格边界检查 `20261104192238-9a4e60`：1 file / 0 violations / exit0。

## D2 恢复激活 finalizer 注册（2026-11-05，已main，消费者fixture仍未对齐）

- 本轮先 merge main → `d1e14ac9a`；正常 main 已含此前 L21 worker/ready-wait 候选，未重做。
  `index.ts` apply 最后注册正式 F3 `backup.restore-activation`（自动检查点2f727ea45），
  回调仅委托原 `finalizeRestoreActivation(ctx, ctx.storage.locations.activeDir)`，不在注册阶段执行、不中途标 ready、
  不硬注入 paths/sync、不吞错、不复制同步 SQL/组合根。SPEC 已列 Rust lib.rs:1169 与 helper 的对应步骤。
- 新 `startup-finalizer.test.ts`（855f3c20e）通过真实 F3 `runStartupFinalizers` 执行已注册回调：
  无 marker 的新启动不轮换；坏 marker 原样保留、失败向上传播、gate不ready；真实活动槽B迁移完成后，
  F4设备ID持久化、L20同步状态/历史、F3 marker和租约收尾均执行，成功后重跑不重复轮换。
  L11/notes/syncSupport与paths/secrets/settings均使用真实 owner；未用测试直接调用 helper 冒充启动接线。
- 旧 SQL/路径 fixture（962671313）只补实际 F3 StartupFinalizerRegistry 绑定（非 no-op）；
  jobs/assets测试改走公共测试宿主，不改变任何原断言。核心组合仍用完整真实 StorageServiceImpl。
- 修前 `20261104182440-d41f5c` 3 failed / exit1（未注册/未消费）；修后 Node `20261104182814-bd618d` 30 passed / exit0，
  包含修改fixture的jobs/assets回归；Electron `20261104182814-783f1f` 6 passed / exit0（含ready-wait），
  typecheck `20261104182814-8cca82` exit0，strict boundaries `20261104183735-1ee88c` 5 files / 0 violations / exit0。
  通过作业均无 Errors 行，未重跑全目录或 ledger 刷回执。
- **消费者对齐阻塞**：只读排查发现 translation C1夹具只给storage.locations。定向实测 `20261104183735-96d75e`
  1 failed / exit1：`ctx.storage.registerFinalizer is not a function`，已投递L02补真实F3服务/registry。
  不越界改translation，不在生产添加“缺API就跳过”。此前要求同步集成；当前 main 已合注册但夹具尚未修，已升级协调者，原失败保持可见。
- **失败政策阻塞**：Rust lib.rs:1174-1190 激活失败走降级维护及状态事件；当前F1/F3合同会传播为启动失败、不标ready。
  差异已按BLOCKERS向架构升级，需owner承接或明确批准，不能用L21吞错/伪造maintenance事件代替。
  本轮只交注册/实际owner调用证据，不签收B02/D2整链，不改ACCEPTANCE或pending测试状态。

## 中断续作：B02 startup ready-wait（2026-11-05）

- 已核 `git log --oneline -20` / status，原 worker 接线与60s草案留存/30s恢复均在提交中，未重做。
  TESTMAP 实际去向为 313 ported / 10 pending；GENERATED 头仍是旧311/12，本轮不手改生成区，也不签收 pending/obsolete。
- 按用户要求运行 ledger：`20261104173424-daa848` exit1，notes 已删除 helper 发生 ENOENT；
  此作业17:34:24–17:35:51与本轮17:35:29的merge重叠，而该merge确实删除此文件，不能据此派给notes恢复已删除副本。
  稳定树上仅补一次诊断检查 `20261104174335-9474e1` exit0：commands/tests/orphan problems均0，prod-reachable unreachable16 / unknown3631。
  原失败日志保留，不将竞争读取失败误报成业务回归或当前外部阻塞。
- B02 候选 e4b5bbdaa：维护状态命令先消费正式 F2 `startupGate.waitStartupReady(120000)`，ready后才读原维护快照；
  超时精确返回 `应用启动初始化超时（120 秒），请重启应用`，缺服务明确失败，不伪造ready。
  Rust `commands.rs:434-439` / `dstu-platform/startup_gate.rs:24`；无新IPC字段、DB写入、业务预算配置或原断言放宽。
- 测试 `startup-readiness.test.ts`（bf481118f）使用真实 F2 gate，经 kernel 证明待就绪/已就绪/超时三个分支；
  fake timers仅推进正式gate的原120s timer。原helper默认提供已ready的真实gate（75f62e927），不是本地no-op实现。
- 修前 `20261104173831-5ab4cf`：2失败/1通过，exit1（提前返回）；修后 `20261104174214-03aa90`：12 passed/26 filtered/exit0，
  含相关B02既有维护屏障回归；Electron `20261104174619-8ebd86`：3 passed/exit0；typecheck `20261104174214-a57df7` exit0。
  通过运行均无 Errors 行；变更文件严格边界检查 `20261104174826-734bac`：3 files / 0 violations / exit0。
- 这只补 ready-wait；finalizeRestoreActivation 的注册候选现见上文，独立启动维护态读取、失败政策及整个B02仍未签收，不自行勾ACCEPTANCE。

## main-red 优先处理（2026-11-05；fulltest 基线 `677f6727c`）

- 收到 fulltest 16:25Z 的两条 issue1 红灯后先合 main → `bbc7273c0`。这两条测试与 main 红灯基线之间源码无差异；
  未发现 F3 API 变化。只读 `.oc-runs/fulltest/latest.json` / `shard-1.json`（原作业 `20261104160236-dcf6f6`），
  耗时分别 47078ms、30925ms；failureMessages 为 Vitest `STACK_TRACE_ERROR`（测试注册栈）。
- 归因：默认 `vitest.host.config.ts` testTimeout=30000，与四库整轮迁移/旧库重建/再次迁移的集成工作量不匹配。
  Vitest `chunk-hooks.js:638,641,2005-2009` 表明该栈由 `withTimeout` 使用，不是迁移业务断言栈。
  未修改前定向作业 `20261104163038-991707` 两例通过（5501ms/7217ms，exit 0，无 Errors 行），不把它洗成原全量失败已消失。
- 草案 `3426e676f` 曾只给这两例 60000ms **测试运行预算**；不改全局 testTimeout、生产迁移时限、
  X1 IPC 预算、Rust 模拟恢复步骤或原断言。另显式断言初始迁移 `success`，避免错误初态进入后续步骤。
  Rust 依据 `critical_audit_tests.rs:95-109,111-144,156-205`；并保留四库无需迁移、旧 VFS 需迁移、Mistakes 重迁移成功及最新版本断言。
- **C2 后续边界**：60s 方案待明确裁定，不能仅为全量变绿扩大预算。当前测试已恢复原默认 30s，
  `3426e676f` 的改动及上述前后作业仍在 git/原日志中保留，显式初始 success 断言保留；不重跑两例或全量压力。
- F3 主线程同步迁移的运行时问题未因此关闭。现 F3 正式接口已进入 main `80dcc5291` 及后继，
  本分支合并树 `8144fb3ab` 已可导入 `storage/api.ts::createMigrationWorker`，正在接线原生产入口；
  不冒称性能已修，不将 8d7/AP 候选重扫当作新业务回归。
- 候选验证作业：Node `20261104163736-69c0af` 两例通过（10810ms/9729ms），Electron `20261104163736-16b8f1`
  两例通过（11317ms/10448ms），typecheck `20261104163736-b4a67f` 通过；均 exit 0、无 Errors 行。
  以上是测试预算候选的定向结果，不代表正常 main 全量红灯已清除，更不能由旧 STACK_TRACE_ERROR 推断 CPU 原因。
  lane-gate 仍受接手前已有、非本 lane 的两个 `migration/` 文件改动阻塞；已再次上报，未经授权不提交或清除它们。

## F3 正式迁移 worker 消费（2026-11-05，当前状态）

- main `80dcc5291` 及后继已含正式 `storage/api.ts::createMigrationWorker`；本分支在 `8144fb3ab` 合入后接线，
  不能再以旧候选提交不在某次祖先检查结果中作为“提供方未发布”的理由。
- 候选 `cc3d6ad13`（恢复 helper e92982cb9、槽测试 84602ddf0）让三处原生产迁移共用一个插件 scope 的长期 runner：
  slotC/slotD 指定 auditDbPath=null，恢复候选槽省略该字段以保持审计默认；日志由 F3 worker 桥发到 Host 的 backup target。
  仅用 report 组装原响应，不透传 threadId。迁移/回滚/验证/备份 guard 全由真实 F3 完成，无本地算法副本。
- 测试槽 reset→clone→迁移→cleanup 整体排队；卸载先等待队列，再 F3 close drain。恢复保持全局 restore guard，
  runner 不注册为会被同一许可 pause 的参与者，无新增业务超时/前端 AbortSignal。
- Node：`20261104165446-96f99a` 5 passed，`20261104165446-e5544e` 4 passed，typecheck `20261104165446-7b7fe9` exit0，均无 Errors 行。

| 原 kernel 命令 | Node 实测耗时 / 迁移开始后心跳 | Electron 实测耗时 / 心跳 |
|---|---|---|
| get_migration_diagnostic_report | 9238ms / 1549 | 20630ms / 2518 |
| run_slot_d_clone_db_test | 5688ms / 839 | 10730ms / 1242 |

- 心跳只在实际迁移日志出现后计数，不借模块加载空档伪证不阻塞。测量是本次环境结果，**仍可能超过 X1 原预算**；
  不修改 X1 断言/预算，不把“事件循环可推进”写成“总时长达标”，待 X1 正常 main 最小复核。
- Electron `20261104165852-ad2064` exit1：槽测试5例与完整恢复1例通过，外部维护三例在 job仍running时触发
  `waitForJob` 固定10s等待上限。原日志保留，不抹去失败。新 worker 使主线程计时器正常运行，旧 helper 的隐含截止因而显现。
  仅让长恢复测试按 Vitest signal 结束等待，原用例60s/120s预算与全部状态/数据/外部所有权断言不变；
  无 signal 的 helper 调用仍用原10s上限。issue1 的默认30s完全不变。
- 恢复等待复验：Node `20261104170953-722609` 5 passed / exit 0；Electron `20261104170954-2200a9` 5 passed / exit 0；
  typecheck `20261104170954-6daa45` exit 0。通过的运行均无 Errors 行。
  只跑受影响的四个恢复入口用例和加密 ZIP 完整切槽链，不重跑已通过槽测试或 main-red 两例诊断。

## v2 接手盘点（2026-11-04，GPT-6 Astra）

接手树 `25cb51fcb`（已合并 main `2ee9a9cbe`）。下表是审读发现与待验证范围，
不是签收；旧 SPEC 的勾选及 311 ported 不代表满足 v2。编号对应 §1.1 接线、
§1.2 所有权、§1.3 serde、§1.4 日志错误、§1.5 测试、§1.6 分支、§1.7 运行时、§1.8 复验。
所有行的 5/6/8 都需要逐断言/分支证据与 R4 签收，不能由注册名推断。
路径以下均相对本目录；命令省略 `data_governance_` 前缀。

| 命令/模块 | 八类自查结果及当前问题 | 证据 文件:行（接手树） |
|---|---|---|
| cloud_config_test_connection_draft / cloudConfig | 1 已接 provider；2 经 settings/secrets；3/4/6 继续逐字段及日志对照；7 密钥异步；5/8 待复验 | index.ts:162-167,200-204；src/cloud-config.ts:507 |
| auto_verify_latest_backup | 1 已接；2 审计所有权需确认；3 时间比较仍是字符串；4 list warn 已注入；7 锁范围 B08 已签；5/6/8 增量待验 | src/backup-commands.ts:189-232 |
| backup_and_export_zip | 1 已接；2/3 依赖 manager/manifest；4/6 资产默认与失败分支待核；7 主线程 staging/哈希，release 有二次尝试；5/8 待验 | src/zip-commands.ts:469-599；src/operations.ts:422-442 |
| backup_tiered | 1 已接；2/3 同上；4/6 层级及统计待逐分支核对；7 acquireForJob 已接；5/8 待验 | src/backup-commands.ts:390-512 |
| cancel_backup | 1 已接；2 无表；3 kernel 参数；4 info/warn 已存在；7 只置取消位；5/6/8 补日志断言 | index.ts:210-215；src/jobs.ts:132-136 |
| check_disk_space_for_restore | 1 已接；2 只读；3 statfs 先 number 乘法不满足 D3；4 B11 文案已改；7 同步 IO；5/6/8 待验 | src/backup-commands.ts:90-114 |
| cleanup_audit_logs | 1 已接；2 审计仓储归属待 F3 确认；3 token 按 i64::from_str 解析、差值 BigInt 精确（WP-148，tests/audit-cleanup-token.test.ts）；`now-token` 越 i64 的 Rust 溢出/panic 及重入锁待 A 实录；4/6 需逐分支核对；7 墙钟有 Rust 依据；5/8 待验 | src/governance.ts:187-252 |
| cleanup_persisted_jobs | 1 已接；2 自有文件；3 依赖持久任务解码；4 warn 已有；7 同步文件 IO；5/6/8 待验 | src/jobs.ts:204-240 |
| delete_backup | 1 已接；2 自有备份；3 kernel/validateBackupId；4 B11 前缀已恢复；7 全局锁；5/6/8 待验 | src/backup-commands.ts:71-88；src/backup-manager.ts:111-115 |
| export_zip | 1 已接；2 自有文件；3 manifest 解码需核；4/6 密码/清理分支待核；7 ZIP 内存处理/同步 IO 待迁 worker；5/8 待验 | src/zip-commands.ts:152-297；src/zip.ts:498 |
| get_asset_types | 1 已接；2 无表；3 固定返回目录；4 无 Err；7 同步纯值；5/6/8 需对照 catalog 原断言 | index.ts:205；src/asset-catalog.ts |
| get_audit_logs | 1 已接；2 审计仓储；3 operation_data 无校验强转、timestamp 丢纳秒；4 B11 连接优先已改；7 同步查询；5/6/8 待验 | repository/audit.ts:170-189；src/governance.ts:116-149 |
| get_backup_job | 1 已接；2 内存；3 可选字段/浮点需对照；4 缺项 null；7 clone 快照；5/6/8 待验 | src/jobs.ts:138-148 |
| get_backup_list | 1 已接；2 自有文件；3 字符串时间排序；4 list warn 已接但其它调用方可能漏传；7 同步扫描；5/6/8 待验 | src/backup-manager.ts:51-76；src/backup-commands.ts:60-69 |
| get_database_status | 1 已接；2 只读 schema；3/4/6 registry 错误/时间需核；7 同步；5/8 待验 | src/governance.ts:378-401 |
| get_maintenance_status | 1 已接；2 无写；3 返回健康快照；4/6/7 启动 ready 与外部维护态尚缺公开 API；5/8 B02 未关闭 | src/governance.ts:404-413；host/platform/storage/api.ts:383（仓库根） |
| get_migration_diagnostic_report | 1 已接；2 含 C/D 临时库；3/4/6 文本、错误阶段需核；7 同步扫描；5/8 待验 | src/governance.ts:416 起 |
| get_migration_status | 1 已接；2 只读；3 持久错误 JSON 强转后检查；4 pending warn 已有；7 同步；5/6/8 待验 | src/governance.ts:81-90,217-254 |
| get_schema_registry | 1 已接；2 只读；3 字段映射；4 refresh 错误包装；7 原 registry lock 不可观测；5/6/8 B06 阻塞 | src/governance.ts:72-114 |
| import_zip | 1 已接；2 自有文件；3 manifest/密码；4/6 取消与失败清理路径需核；7 ZIP 主线程；5/8 待验 | src/zip-commands.ts:299-441 |
| list_backup_jobs | 1 已接；2 内存；3 摘要；4 无业务 Err；7 无排序承诺；5/6/8 待验 | src/jobs.ts:149 |
| list_resumable_jobs | 1 已接；2 自有文件；3 参数解码；4 探测 warn；7 ZIP 读取；5/6/8 待验 | src/zip-commands.ts:125-150 |
| purge_all_data | 1 已接；2 自有标记；3 无输入；4/6 重启请求需对照；7 下次启动由 F3 消费；5/8 待验 | index.ts:295；src/restore-commands.ts |
| restore_backup | 1 已接；2 VFS 重置已改由 L11 owner（vfs-restore.ts 已删）；3 activation JSON 强转；4/6 全部恢复分支待核；7 marker 注释写 fsync 实际没有；5/8 B05 待 R4 复核 | src/restore-commands.ts:78-91,163-191；src/backup-manager.ts:638-670 |
| restore_with_assets | 1 已接；2 无写；3 无结果；4 固定停用错误；7 无取消/资源；5/6/8 R4 已核实拒绝路径 | index.ts:207-209 |
| resume_backup_job | 1 已接；2 自有持久化；3 export 手工字段读取未复用严格 params；4/6 缺参失败待核；7 guard 已接；5/8 待验 | src/backup-commands.ts:371-388；src/zip-commands.ts:602-632 |
| run_backup | 1 已接；2 manager 文件；3 manifest/size；4 B04 门已加；6 无效 assetTypes 回默认；7 屏障/取消候选已有，主线程哈希仍待改；5/8 待 R4 | src/backup-commands.ts:257-368 |
| run_health_check | 1 已接；2 只读；3/4 B09 iterator.return 已有但 prepare/read 阶段平台未分离；6 坏 FK 实测已补；7 readonly/释放；5/8 待 R4 | src/governance.ts:334-376；tests/acceptance-fixes.test.ts:373-416 |
| run_slot_c_empty_db_test | 1 已接；2 临时槽库；3/4/6 报告错误待核；7 coordinator 异步；5/8 待验 | src/governance.ts:425 起 |
| run_slot_d_clone_db_test | 1 已接；2 临时槽库；3/4/6 同上；7 online backup；5/8 待验 | src/governance.ts:416 起 |
| scan_assets | 1 已接；2 只读；3 过滤参数；4 scan 错误包装；7 同步遍历；5/6/8 待核 | index.ts:71-74,206；src/assets.ts |
| verify_backup | 1 已接；2 只读；3 manifest；4 findBackup 未传 logger（B10 遗漏）；7 哈希在主线程；5/6/8 待核 | src/backup-commands.ts:124-142 |
| verify_backup_with_assets | 1 已接；2 只读；3 manifest；4 同样漏 warn；6 保留 Rust 错误根路径；7 全局锁；5/8 待核 | src/backup-commands.ts:157-181 |
| backup/governance 共享许可与 SyncPorts | 1 已 provide；2 owner 已集中；3 kind/AppError 已结构化；4 IO 分类已接；7 跨进程 wx/PID 非 fs2，F3 阻塞；5/6/8 不能以同进程测试签整个 B03 | index.ts:54-98；src/operations.ts:212-351 |
| Jobs 持久化/事件 | 1 经 backup.jobs 可达；2 自有 JSON；3 uint 无 u64 上界/date 宽松；4 非法转换日志；7 单调时钟已用；5/6/8 待逐断言核查 | src/jobs.ts:33-111,150-181 |
| migration-behavior 移植测试 | 1/5 测试内初始化与策略 helper 仍存在，不仅 8 条 pending；2/3/4/6/7 未经生产入口的结果不能证明；8 B06 不可关闭 | tests/migration-behavior.test.ts；ACCEPTANCE.md:36-38 |

### 执行计划与阻塞边界

1. B01/B08 保留已签范围；B02/B03/B09 不重做已有修复，补剩余真实工作区失败/日志证据；B04/B11 先审读后补精确失败测试。
2. B10 先修生产 find/list 漏传 logger 并通过 kernel 回归；B05 已接 L11 正式 owner 并删除本地 SQL，待 R4 复核。
3. B06/B07 纠正自造 helper 与验证范围；12 pending 保持原状态，两 obsolete 仅申请未批准。
4. 再修自查的数据解码、纳秒排序、激活 fsync、同步 IO；这些属于 L21 自有工作，**不是跨 lane 阻塞**。33 个命令逐步补 v2 §2 分支映射。
5. 接手时阻塞的后续状态：L11 reset、F3 finalizer/SqlPhase/F2 ready-wait 及 F3 迁移 worker 均已正式发布；不能继续列为提供方未合。
   当前迁移 worker 与 ready-wait 已有消费候选，finalizer 仍是 L21 自有接线工作；Registry 写锁/可读维护状态、advisory lock 与 obsolete 审批仍按 BLOCKERS 逐项跟踪。

新机器基线检查（合并后）：ledger 作业 `20261104104759-72bcfb`，typecheck `20261104104913-4a2d41`，插件全目录测试 `20261104104913-3a921a`；结果待领取，不能预写绿。

## v2 排雷清单（X6 报告 `0119143715c0bab2d8f698b7c1d58651358e85be`，源码基线 `2ee9a9cbe`）

编号沿用原报告顺序，后续重扫不得重排复用。路径相对本目录。"候选已修"均须 main 后对应 R 复验才算完成。
AP/LP 为 report-only 粗计数：AP 须逐语义对照（不为补数写重复 expect），LP 须对分支保留原 warn/error/字段/时序，计数不能定罪也不能销项。
SW-0001/0002 的修复提交早于本编号分配，提交信息只写了 B05；不改写历史，在此关联。

### SW / UD

| ID | 位置（基线） | 内容 | 状态 | 修复 SHA · 真实入口 · 证据 |
|---|---|---|---|---|
| X6-SW-0001 | repository/vfs-restore.ts:53 | DELETE vfs_index_segments（owner=vfs-repos） | 候选已修待复核 | 9740a103e/dac4927af 删文件，d8d86d53c；`RestoreCommands.executeRestore` → `prepare/finalizeVfsIndexRestore` → L11 `vfsMaintenance.resetRebuildableIndex(targetDir)`；backup-manager.test 真实 L11 插件 · `20261104110506-f33825`、`20261104110653-e6b972` |
| X6-SW-0002 | repository/vfs-restore.ts:178 | DELETE __lance_orphan_queue（owner=vfs-repos） | 候选已修待复核 | 同上；`__lance_orphan_queue` 计数断言保留 |
| X6-UD-0014 | repository/audit.ts:174 | rowToAuditLog JSON.parse as AuditOperation | 候选强化待复核 | 保留9e6f7eb86纳秒/结构修复历史；dd9034566/d3c860e03消除JSON.parse先舍入，真实F4词法/宽整数验证及raw数字存储、enum map/重复/未知字段分支。修前95acab新增10例全红；Nodea0c37c/Electron1c1f9e各24绿/tsc007d74均exit0；仍不统签复杂多错优先级或整个D3 |
| X6-UD-0015 | src/governance.ts:87 | readPersistedMigrationError JSON.parse as Record | 已核，非缺陷，申请例外 | Rust commands.rs:85-92 同样解析为无类型 `serde_json::Value` 后 `get(..)?.as_str()?`，任一失败返回 None；TS 读取/解析失败返回 null、两字段 typeof 检查，语义一致。需协调者精确审批 |
| X6-UD-0016 | src/restore-commands.ts:164 | finalizeRestoreActivation JSON.parse as RestoreActivationMarker | 候选已修待复核 | 7094bf392 `decodeRestoreActivationMarker` + 读取/解析分开报错（commands_restore.rs:56-65,165-171）；入口 `finalizeRestoreActivation`；restore.test malformed marker 4 例 · `20261104115132-a81b30` |

### AP（候选，80 条）

#### 新基线关联（不重编号）

固定 main `8d7b05d14`，报告 ref `a07019791e219c91f89fc3960ef5644846486b94` 的
`scripts/electron-migration/gate-checks/reports/handoff-8d7b05d14.md`。已只读解析该报告，79 个完整 Rust ID
全部一一关联至下表既有稳定编号；不覆盖 `0119143715c…` / `2ee9a9cbe` 的原位置、计数、修复 SHA。
新基线的行号变化不是新增缺陷；候选未入 main 不因重扫重复修改。PR 的 unreachable/unknown 与 AP 语义候选分开，
不依据 AP 计数下调测试等级，也不修改命令等级。

完整 Rust ID = 下列命名空间 + 下表「Rust 测试」函数名（仅 AP-0128 为旧扫描同源别名，见该行）：

| 稳定编号 | Rust ID 命名空间 |
|---|---|
| AP-0058 | `crates/dstu-sync/src/backup_job_manager.rs::tests::` |
| AP-0059–0061 | `crates/dstu-sync/src/cloud_config_commands.rs::tests::` |
| AP-0062–0063 | `crates/dstu-sync/src/data_governance/backup/assets.rs::tests::` |
| AP-0064–0077 | `crates/dstu-sync/src/data_governance/backup/mod.rs::tests::` |
| AP-0078 | `crates/dstu-sync/src/data_governance/backup/portable_precheck.rs::tests::` |
| AP-0079 | `crates/dstu-sync/src/data_governance/backup/restore_plan.rs::tests::` |
| AP-0080–0091 | `crates/dstu-sync/src/data_governance/backup/zip_export.rs::tests::` |
| AP-0092–0095 | `src/data_governance/commands.rs::tests::` |
| AP-0096–0098 | `src/data_governance/commands_restore.rs::tests::` |
| AP-0099–0103 | `src/data_governance/critical_audit_tests.rs::critical_audit_tests::` |
| AP-0104–0118 | `src/data_governance/migration_tests.rs::tests::` |
| AP-0119–0127、0129–0133 | `src/data_governance/tests.rs::integration_tests::` |
| AP-0134–0135 | `tests/restore_domain_plan_tests.rs::` |
| AP-0136–0137 | `tests/zip_export_import_restore_tests.rs::` |

原80行中已核79条：EQUIV33条（含循环/await/直接失败传播证据，不能因静态expect数少判缺陷），另46条按下表保留缺口、候选修复或结构阻塞。尚未核0条，AP-0128另保留为旧重复关联历史项，不重编号。候选待 main 后独立复核，以上计数不是签收；旧ported中新增确认的7项影子初始化/策略另须纠正元数据。

| ID | TS 位置 | Rust 测试 | 计数 Rust>TS | Rust 位置 | 状态 |
|---|---|---|---|---|---|
| X6-AP-0058 | tests/jobs.test.ts:46 | `incremental_disabled_message_is_english_and_aligned` | Rust 3 (1 cfg) > TS 2 | backup_job_manager.rs:1422 | 候选已修待复核：2267ebed1/090d225cb 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 1431-1435 cfg(data_governance) 两常量相等断言 |
| X6-AP-0059 | tests/cloud-config.test.ts:114 | `ftp_platform_error_has_stable_code_and_shared_diagnostic` | 6 > 5 | cloud_config_commands.rs:1132 | 候选已修待复核：35abca62d 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 1138 Invalid 变体断言 |
| X6-AP-0060 | tests/cloud-config.test.ts:127 | `s3_platform_error_has_stable_code_independent_of_message` | 3 > 2 | cloud_config_commands.rs:1158 | 候选已修待复核：1fb41e693，补 :1161-1165 toCommandError 后 envelope code/message；作业 20261104145406-ff0500：1 passed / exit 0，无 Errors 行 |
| X6-AP-0061 | tests/cloud-config.test.ts:144 | `android_rejects_ftp_on_save_and_persists_nothing` | 3 > 2 | cloud_config_commands.rs:1170 | 已核（只读对照 2026-11-04）GAP：整测 cfg(android)；缺 1174 denied==ftp_unsupported_on_platform() |
| X6-AP-0062 | tests/assets.test.ts:39 | `test_is_sensitive_file` | 6 > 2 | backup/assets.rs:1665 | 已核（只读对照 2026-11-04）EQUIV：两循环覆盖同 6 路径 |
| X6-AP-0063 | tests/assets.test.ts:211 | `test_restore_assets_with_progress_skips_untrusted_executable_assets` | 6 > 4 | backup/assets.rs:1932 | 候选已修待复核：2267ebed1 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 1962-1963 asset_requires_explicit_trust 正反 |
| X6-AP-0064 | tests/mod-behavior.test.ts:35 | `backup_incremental_create_returns_removed_error` | 3 > 2 | backup/mod.rs:6433 | 已核（只读对照 2026-11-04）EQUIV：完整消息 + 目录前后对比 |
| X6-AP-0065 | tests/mod-behavior.test.ts:46 | `restore_rejects_legacy_incremental_manifest` | 2 > 1 | backup/mod.rs:6478 | 已核（只读对照 2026-11-04）EQUIV：toThrow 子串覆盖 1506/1513 |
| X6-AP-0066 | tests/backup-manager.test.ts:72 | `backup_crypto_keys_excludes_codex_oauth_session` | 4 > 3 | backup/mod.rs:6611 | 候选已修待复核：6804042d8（count 返回值 + 断言）· 20261104141252-5105d1（0）；补生产 run_backup 异常密钥回归 334964bf8：超大主密钥/非常规 secure 条目均失败，不发布清单且释放真实 F3 屏障；20261104150347-52dc5a：2 passed / exit 0，无 Errors 行 |
| X6-AP-0067 | tests/backup-manager.test.ts:89 | `root_crypto_and_audit_are_found_when_manager_receives_active_slot` | 5 > 2 | backup/mod.rs:6637 | 部分：6804042d8 补 6659/6660；6655 根路径语义待裁定（见下「审计库路径分歧」） |
| X6-AP-0068 | tests/manifest.test.ts:49 | `test_list_backups_overrides_manifest_backup_id_with_dir_name` | 2 > 1 | backup/mod.rs:6736 | 候选已修待复核：08871d6ec 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 6753 len==1（夹具 2 份） |
| X6-AP-0069 | tests/backup-manager.test.ts:108 | `test_backup_and_restore_single_database` | 5 > 4 | backup/mod.rs:7072 | 候选0193b05cb：补:7093源库删除/:7095-7097实际陈旧Lance文件/:7104-7107目录移除；真实L11及生产restore→prepare→finalize，原verify/库存在/行数2保留。Node b0bc87/Electron e5382f各1绿exit0，待复核；非kernel整槽或B05重签 |
| X6-AP-0070 | tests/mod-behavior.test.ts:95 | `test_backup_full_rejects_missing_core_database` | 2 > 1 | backup/mod.rs:7411 | 已核（只读对照 2026-11-04）EQUIV：消息覆盖变体与库名 |
| X6-AP-0071 | tests/manifest.test.ts:95 | `persistent_registry_marks_user_skills_untrusted_executable` | 5 > 1 | backup/mod.rs:7575 | 候选已修待复核：08871d6ec 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 7581 skills.optional |
| X6-AP-0072 | tests/manifest.test.ts:113 | `active_data_space_settings_are_manifested_with_restore_scope` | 4 > 3 | backup/mod.rs:7611 | 候选已修待复核：5140144c1；真实 F3 四库和两设置文件，经 kernel run_backup 读取已发布清单，逐域补 :7628 complete、:7629 active_data_space、:7630 files.len=1、:7631-7634 sha256 长度64，原静态目录断言保留；20261104153942-9e412e：1 passed / exit 0 |
| X6-AP-0073 | tests/backup-manager.test.ts:204 | `crypto_tamper_fails_even_if_manifest_hash_is_rewritten` | 4 > 2 | backup/mod.rs:7653 | 候选已修待复核：af2fb0a93；真实备份后、AEAD 篡改前补 :7665 encrypted、:7666 application_data、:7667-7670 每个文件 sha256 长度64；20261104153514-ec0d0e：1 passed / exit 0 |
| X6-AP-0074 | tests/backup-manager.test.ts:237 | `corrupted_audit_database_fails_integrity_after_hash_rewrite` | 6 > 2 | backup/mod.rs:7693 | 候选补证d02f72cc4：:7708-7712真实备份audit plan的files数1/file_count1/application_data/路径/SHA长度64五断言；原改写文件及hash后的verify失败/路径错误保留。Node659965/Electron440b79各2绿/tsca1de51/strict2f7f7f均exit0，非B05重复签收 |
| X6-AP-0075 | tests/backup-manager.test.ts:285 | `test_restore_reverts_data_to_backup_state` | 6 > 2 | backup/mod.rs:7739 | 候选已修待复核：fc6abe7fe；:7775/7783 修改后 count/new_row3，:7797/7807/7821/7834 完整恢复原值/无新增行。走真实 restoreSingleDatabaseToDir，候选先预置修改后状态，不复活停用原地恢复命令；20261104145611-07dad2：2 passed / exit 0，无 Errors 行 |
| X6-AP-0076 | tests/backup-manager.test.ts:299 | `test_restore_integrity_check_passes_on_restored_db` | 5 > 4 | backup/mod.rs:7844 | 候选已修待复核：35abca62d 补断言 · 作业 20261104134954-20fb89（0）；原已核（只读对照 2026-11-04）GAP：缺 7934-7938 foreign_key_check 为空 |
| X6-AP-0077 | tests/backup-manager.test.ts:252 | `test_restore_schema_version_matches_backup_metadata` | 4 > 3 | backup/mod.rs:8064 | 候选已修待复核：fc6abe7fe；补 :8104-8107 删除原库前提，:8123 版本与 manifest 一致，:8144-8147 versioned_data 随历史恢复；20261104145611-07dad2（同上） |
| X6-AP-0078 | tests/portable-precheck.test.ts:135 | `import_sealed_zip_with_wrong_password_fails_before_touching_target` | 3 > 2 | backup/portable_precheck.rs:433 | 候选已修待复核：08871d6ec 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 463-467 "解封加密备份失败" |
| X6-AP-0079 | tests/restore-plan.test.ts:73 | `untrusted_user_skills_are_quarantined_not_written_to_restore_target` | 7 > 6 | backup/restore_plan.rs:675 | 已核（只读对照 2026-11-04）EQUIV：710 状态相等蕴含 715 |
| X6-AP-0080 | tests/zip.test.ts:66 | `test_export_excludes_crypto_secrets` | 9 > 7 | backup/zip_export.rs:2351 | 候选已修待复核：5140144c1/a1533c0da；补 .SECURE/upper.enc 夹具，七路径循环逐项对应 :2392-2398 的 is_file；原导出排除/manifest 存在断言保留；20261104153942-c87b04：8 passed / exit 0（取消相关小集合） |
| X6-AP-0081 | tests/zip.test.ts:95 | `test_unencrypted_export_excludes_user_skills` | 2 > 1 | backup/zip_export.rs:2402 | 候选已修待复核：090d225cb 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 2429-2432 源 skill 文件仍在 |
| X6-AP-0082 | tests/zip.test.ts:132 | `test_export_nonexistent_dir` | 2 > 1 | backup/zip_export.rs:2584 | 已核（只读对照 2026-11-04）EQUIV：Display 文本覆盖 |
| X6-AP-0083 | tests/zip.test.ts:139 | `test_invalid_compression_level` | 2 > 1 | backup/zip_export.rs:2593 | 已核（只读对照 2026-11-04）EQUIV：Display 文本覆盖（TS 10，Rust 15） |
| X6-AP-0084 | tests/zip.test.ts:147 | `test_import_from_zip` | 10 > 2 | backup/zip_export.rs:2610 | 候选已修待复核：49281d8bd（自动检查点）；按 Rust :2268-2314 建四个真实 SQLite 库，补 :2622-2662 的数量/文件/partial/key_policy/拒绝槽恢复/crypto 与 user-skills excluded；旧设置内容往返断言另保留。20261104150603-9bca2b exit 1（夹具账本旧大小），按 Rust :2290-2297 重记覆盖后 20261104150758-c2a8eb：2 passed / exit 0，无 Errors 行 |
| X6-AP-0085 | tests/zip.test.ts:358 | `test_resumable_import_never_skips_manifest_json` | 3 > 1 | backup/zip_export.rs:2818 | 已核（只读对照 2026-11-04）EQUIV：2867 蕴含 2859（缺 2840 前置 assert_ne） |
| X6-AP-0086 | tests/zip.test.ts:485 | `test_resumable_import_encrypted_zip_requires_password_before_touching_target` | 3 > 2 | backup/zip_export.rs:2906 | 候选已修待复核：090d225cb 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 2915 "备份密码" |
| X6-AP-0087 | tests/zip.test.ts:233 | `test_resumable_import_encrypted_zip_wrong_password_then_retry_with_correct` | 6 > 2 | backup/zip_export.rs:2962 | 候选已修待复核：caf21c621；完整真实四库夹具，补 :2976 解封文案、:2981 稳定码、:2989 密文保留、:3006/3007 数量与跳过、:3008 移除密封载荷、:3010 清单可槽恢复。原 seed-value 字节断言保留；20261104161232-f11193 两例passed（含共用夹具AP-0084）exit0，无Errors行 |
| X6-AP-0088 | tests/zip.test.ts:215 | `test_non_resumable_import_encrypted_zip_fails_early_without_password` | 3 > 2 | backup/zip_export.rs:3061 | 候选已修待复核：090d225cb 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 3069-3075 提示文案 |
| X6-AP-0089 | tests/zip.test.ts:555 | `test_non_resumable_progress_import_encrypted_zip_fails_early_without_password` | 4 > 3 | backup/zip_export.rs:3092 | 候选已修待复核：090d225cb 补断言 · 作业 20261104134419-ede7d7（0）；原已核（只读对照 2026-11-04）GAP：缺 3112-3118 提示文案 |
| X6-AP-0090 | tests/zip.test.ts:254 | `test_export_cancel_token_set_midway_stops_export` | 4 > 2 | backup/zip_export.rs:3154 | 候选已修待复核：5140144c1（测试）/4c7efffb3（生产）/a1533c0da（ID 与 SPEC）；:3178 saw_compress、:3182-3190 EINTR、:3191 IO Display、:3196 无输出 ZIP。补 :339-348 加密前取消点；修前20261104153255-c71b78 两例失败，修后20261104153942-c87b04 八例通过；均保留原作业结果 |
| X6-AP-0091 | tests/zip.test.ts:301 | `test_import_cancel_midway_extract_leaves_no_partial_files` | 5 > 2 | backup/zip_export.rs:3464 | 候选已修待复核：同 AP-0090；:3319-3331 EINTR+IO Display，:3468 多条目，:3495/3499 落盘非空且未写完，:3505 无 .tmp 前缀（原后缀检查保留），:3513 每个文件大小与归档一致。取消首个 Extract 回调后完成当前条目、下条目前中止，不再以目标不存在空通过 |
| X6-AP-0092 | tests/paths.test.ts:58 | `resolve_target_and_pending_returns_zero_when_latest_reached` | 2 > 1 | commands.rs:1346 | 已核（只读对照 2026-11-04）EQUIV：toEqual 覆盖两字段 |
| X6-AP-0093 | tests/paths.test.ts:65 | `resolve_target_and_pending_prefers_status_target_version` | 2 > 1 | commands.rs:1356 | 已核（只读对照 2026-11-04）EQUIV：toEqual 覆盖两字段 |
| X6-AP-0094 | tests/paths.test.ts:88 | `test_infer_database_mistakes` | 6 > 1 | commands.rs:1487 | 已核 EQUIV：tests/paths.test.ts:89-90 循环同一 6 表名，逐个断言 mistakes，对应 Rust :1488-1502；无需改测试，无修复 SHA |
| X6-AP-0095 | tests/paths.test.ts:94 | `test_infer_database_vfs` | 7 > 1 | commands.rs:1506 | 已核 EQUIV：tests/paths.test.ts:95-96 循环同一 7 表名，逐个断言 vfs，对应 Rust :1507-1513；无需改测试，无修复 SHA |
| X6-AP-0096 | tests/restore.test.ts:216 | `pre_cutover_interruption_is_retryable_and_second_publish_commits_lease` | 16 > 14 | commands_restore.rs:1617 | 已核（只读对照 2026-11-04）EQUIV：逐条一一对应 |
| X6-AP-0097 | tests/restore.test.ts:253 | `post_cutover_failure_audit_details_carry_cutover_committed_and_close_started_row` | 7 > 4 | commands_restore.rs:1711 | 候选已修待复核：e56fbed7b（自动检查点）/1fb41e693（ID 与断言映射），补 :1786-1791 domains 和 :1795-1803 json_extract 计数；真实 F3 audit handle → 生产审计仓储；20261104145232-9b5398：2 passed / exit 0，无 Errors 行 |
| X6-AP-0098 | tests/restore.test.ts:295 | `terminal_restore_job_can_never_flip_to_success` | 10 > 4 | commands_restore.rs:1810 | 候选已修待复核：e56fbed7b/1fb41e693，补 :1861-1867 不可撤销错误、:1872-1878 取消与终态、:1882 新任务不取消；kernel cancel 命令 + 正式 backup.jobs；20261104145232-9b5398（同上） |
| X6-AP-0099 | tests/migration-behavior.test.ts:1102 | `test_issue1_restore_old_backup_then_migrate_reaches_latest` | 4 > 3 | critical_audit_tests.rs:151 | 已核 EQUIV：Rust :185 result.is_ok 由 TS await runAll 的拒绝即失败保障；:192 success、:199 找到 mistakes、:201-204 最新版本三条 expect 一一对应。main-red 修复另加初始 success 断言，不补无意义 expect 来凑计数 |
| X6-AP-0100 | tests/migration-behavior.test.ts:1320 | `test_issue6_incremental_create_returns_removed_error` | 3 > 2 | critical_audit_tests.rs:844 | 候选补证09203c01b：:848既有base目录+baseVersion；:860原错误文案、:878原产物前后相等保留；:865内部variant在公开string出口以精确canonical Display验证，不接受HandlerPanic对象。Nodef4eea0/Electronc8ac34各2绿，待复核 |
| X6-AP-0101 | tests/migration-behavior.test.ts:1333 | `test_issue6_incremental_restore_silently_restores_nothing` | 4 > 3 | critical_audit_tests.rs:883 | 候选补证09203c01b：原canonical增量拒绝/英文断言保留；:899-917真实changes文件与hash/size，新增kernel恢复命令failed/result.success=false与精确result.error，证明生产兼容性拒绝，不仅直接validator。内部variant对照公开string/job合同，非新增枚举签收。Nodef4eea0/Electronc8ac34各2绿 |
| X6-AP-0102 | tests/migration-behavior.test.ts:1403 | `test_issue10_checkpoint_then_write_then_backup_may_lose_data` | 3 > 2 | critical_audit_tests.rs:1149 | 已核EQUIV（单连接可达分支）：:1191 source=3、:1198 destination=3对应原两个expect；Rust另一个destination=2断言是互斥诊断分支，当前同连接先写再backup无并发写者，原TS固定3不弱化。不据此证明生产多进程race安全；复用5a602c整目录437绿，无代码改动 |
| X6-AP-0103 | tests/migration-behavior.test.ts:1554 | `test_initialization_preserves_existing_data` | 3 > 1 | critical_audit_tests.rs:1644 | 候选已修待复核：428211444及其所列自动检查点；:1648/1662用实际F3插件启动/卸载重装（实际F4依赖、正常模式），:1674读取当前storage原payload，另防活动路径漂移；不再调用本地initializer。Node0b127b/Electron224e82各3例及tsc2198ec均exit0 |
| X6-AP-0104 | tests/migration-behavior.test.ts:388 | `test_full_migration_from_empty_database` | 10 > 9 | migration_tests.rs:135 | 已核 EQUIV：:152 is_ok由await真实F3 runAll失败自然失败保障；:143初始文件不存在、:157/159/164成功/数量/正时长、:171/176/181/193循环四库成功/from0/to正/实际集合count、:203文件存在均有原expect，不增冗余断言 |
| X6-AP-0105 | tests/migration-behavior.test.ts:406 | `test_vfs_database_full_migration` | 7 > 6 | migration_tests.rs:312 | 已核 EQUIV：:318 is_ok=直接F3 migrateSingle抛错自然失败；:321/322/323/324/330/338分别为原success/id/from0/latest/count/文件存在expect；latest/count取真实F3集合，无影子历史 |
| X6-AP-0106 | tests/migration-behavior.test.ts:418 | `test_chat_v2_database_full_migration` | 4 > 3 | migration_tests.rs:343 | 已核 EQUIV：先真实VFS迁移，:355 Chat is_ok由直接F3 migrateSingle失败传播保障；:362/363/364原success/id/latest三expect逐项对应 |
| X6-AP-0107 | tests/migration-behavior.test.ts:429 | `test_llm_usage_database_full_migration` | 4 > 3 | migration_tests.rs:373 | 已核 EQUIV：:380 is_ok=直接真实F3 migrateSingle失败传播；:387/388/389原success/id/latest三expect逐项对应，无本地迁移副本 |
| X6-AP-0108 | tests/migration-behavior.test.ts:438 | `test_mistakes_database_full_migration` | 5 > 4 | migration_tests.rs:398 | 已核 EQUIV：先真实VFS迁移，:410 is_ok由直接F3 migrateSingle保障；:417/418/419/427原success/id/latest/实际文件存在四expect对应 |
| X6-AP-0109 | tests/migration-behavior.test.ts:459 | `test_run_all_idempotency` | 6 > 4 | migration_tests.rs:478 | 已核 EQUIV：:485/:499两个is_ok由两次await真实F3 runAll失败传播保障；:487/491首success/实际TOTAL、:504/508次success/应用数0均有原expect |
| X6-AP-0110 | tests/migration-behavior.test.ts:471 | `test_run_all_stops_on_dependency_failure` | 3 > 2 | migration_tests.rs:516 | 已核 EQUIV：原Rust也仅测check_dependencies，真实F3失败VFS CoreMigrationReport→checkDependencies；:538 is_err由expectMigrationError无抛错时主动失败+instance验证；:540-548 kind/database=chat_v2/dependency=vfs由detail整体toEqual覆盖 |
| X6-AP-0111 | tests/migrations-metadata.test.ts:121 | `test_dependency_not_satisfied_error` | 3 > 1 | migration_tests.rs:885 | 候选已修待复核：a8fc93a40；旧测错为SchemaRegistry，现真实F3 MigrationCoordinator.checkDependencies + 空CoreMigrationReport；:896 异常、:898-907 错误类型/kind/database=chat_v2/dependency=vfs逐项覆盖，非重复expect凑数。Node c06c00/Electron e84faa三例、tsc a8d4a7均exit0 |
| X6-AP-0112 | tests/migration-behavior.test.ts:553 | `test_full_dependency_chain_migration` | 2 > 1 | migration_tests.rs:939 | 已核 EQUIV：:945 is_ok=await真实F3 runAll失败自然失败；:951逐库success由原for/expect对应。只对应本Rust ID，不与tests.rs同名排序测试混为一谈 |
| X6-AP-0113 | tests/migration-behavior.test.ts:558 | `test_audit_log_table_initialization` | 3 > 2 | migration_tests.rs:965 | 已核 EQUIV：Rust:972 init.is_ok由直接调用真实F3 initAuditTable的异常传播保障；:983表存在、:994 timestamp索引存在均对应原expect。不是本地副本，无需追加冗余expect，无实现SHA |
| X6-AP-0114 | tests/migration-behavior.test.ts:567 | `test_audit_log_records_migration_complete` | 3 > 2 | migration_tests.rs:999 | 候选已修待复核：bdd58df6e/d1204084b；:1009改为真实F3 AuditLog.complete/save.not.toThrow，非best-effort wrapper；:1012-1023用完整F3句柄的生产queryAuditLogs的Migration/limit10过滤解码并保留length1/Completed。Node2ddaaf/Electrond54eef各2绿 |
| X6-AP-0115 | tests/migration-behavior.test.ts:579 | `test_audit_log_records_migration_failed` | 3 > 2 | migration_tests.rs:1028 | 候选已修待复核：bdd58df6e/d1204084b；:1039真实F3 AuditLog.fail/save.not.toThrow，to_version恢复20260130；:1042-1058用完整F3句柄的生产query的Migration/Failed/limit10，原length1/contains Test failure保留。Node2ddaaf/Electrond54eef各2绿 |
| X6-AP-0116 | tests/migrations-metadata.test.ts:174 | `test_schema_registry_aggregation_after_migration` | 5 > 2 | migration_tests.rs:1148 | 候选已修待复核：6d0c88509/41ea02bf9；去掉latestOpener影子历史，用F3真实迁移/句柄读生产聚合；:1160数4、:1166全局版本>0、:1174状态存在、:1177正版本、:1188最新目标逐项对应，保留L21静态表断言。Node2b7b0d/Electronaf8fe2四例及tsc50934e均exit0 |
| X6-AP-0117 | tests/migration-behavior.test.ts:626 | `test_complete_initialization_flow` | 6 > 5 | migration_tests.rs:1271 | 确认结构阻塞：report/时长/registry由本地initializeWithReport拼装，不是生产报告；不能追加expect假签收。F3实际启动插件已存在，但报告/registry观察面未暴露，已收窄接口与状态请求，原断言保留 |
| X6-AP-0118 | tests/migrations-metadata.test.ts:63 | `test_migration_set_properties` | 8 > 6 | migration_tests.rs:1339 | 候选已修待复核：521f0e397；原只测L21数组，现另测真实coordinator.sets，固定四集合名(:1342/1350/1358/1366)与28/14/6/3基线(:1343-1371)；原L21断言保留。Node529d45/Electron3d608e一例均exit0 |
| X6-AP-0119 | tests/migration-behavior.test.ts:830 | `test_vfs_full_migration` | 8 > 7 | tests.rs:76 | 已核 EQUIV：:83 is_ok由直接F3 migrateSingle失败自然失败；:86/87/88/89/90/94/98的success/id/from0/to正/applied正/时长正/文件存在均对应原expect |
| X6-AP-0120 | tests/migration-behavior.test.ts:843 | `test_chat_v2_full_migration` | 3 > 2 | tests.rs:103 | 已核 EQUIV：先直接F3迁移VFS，:115 is_ok由Chat migrateSingle失败传播保障；:122/123原success/id两个expect对应 |
| X6-AP-0121 | tests/migration-behavior.test.ts:853 | `test_mistakes_full_migration` | 4 > 3 | tests.rs:128 | 已核 EQUIV：:140 is_ok由直接F3 migrateSingle失败传播，原success/id/实际mistakes.db文件存在分别对应:147/148/152；VFS依赖预迁移保留 |
| X6-AP-0122 | tests/migration-behavior.test.ts:864 | `test_llm_usage_full_migration` | 4 > 3 | tests.rs:160 | 已核 EQUIV：:167 is_ok由直接F3 migrateSingle失败传播，原success/id/实际llm_usage.db存在分别对应:174/175/179 |
| X6-AP-0123 | tests/migration-behavior.test.ts:873 | `test_run_all_migrations` | 9 > 5 | tests.rs:187 | 已核 EQUIV：:194 is_ok由await真实F3 runAll失败传播；:197/198/199/206对应success/数4/时长正/逐库成功；:214-217四路径由ALL_ORDERED→真实getDatabasePath循环exists全覆盖，非单个文件断言 |
| X6-AP-0124 | tests/migrations-metadata.test.ts:121 | `test_dependency_not_satisfied_error` | 3 > 1 | tests.rs:507 | 候选已修待复核：同a8fc93a40，独立对应tests.rs:518 失败、:520-528 真实迁移错误与两个字段；成功对照用原:540-556报告，不与Registry测试混淆 |
| X6-AP-0125 | tests/migration-behavior.test.ts:553 | `test_full_dependency_chain_migration` | 3 > 1 | tests.rs:561 | 更正为EQUIV：保留原扫描首同名位置553作历史；实际describe('tests.rs')内专属chain（当前约1009）已有VFS<ChatV2、VFS<Mistakes分别覆盖:587/:591，await覆盖:568。原TESTMAP完整Rust ID正确；此前GAP系人工读错同名describe，撤回而非追加expect或篡改生成映射 |
| X6-AP-0126 | tests/migration-behavior.test.ts:996 | `test_migration_report_content` | 5 > 4 | tests.rs:659 | 已核 EQUIV：:665 result.is_ok由await真实coordinator.runAll的拒绝即失败覆盖；:670长度4、:673成功、:678 to>=from、:682耗时>0在现有for循环逐记录对应。无需加重复expect，无修复SHA |
| X6-AP-0127 | tests/migrations-metadata.test.ts:162 | `test_schema_registry_aggregation` | 4 > 3 | tests.rs:696 | 候选已修待复核：同6d0c88509/41ea02bf9；真实四库迁移后验证:710四库、:715全局版本>0、:723状态存在、:726版本>0；原TS最新版本精确断言也保留，不用fake opener或空文件“证明”通过 |
| X6-AP-0128 | tests/migrations-metadata.test.ts:174 | `test_schema_registry_aggregation_after_migration` | 4 > 2 | tests.rs:696 | 保留旧扫描历史：源 Rust ID 实为 `src/data_governance/tests.rs::integration_tests::test_schema_registry_aggregation`（与 AP-0127 同源、不同 TS 粗关联）；新 a07019791e 报告仅列 AP-0127，不另造 ID，不因此签收或删除测试 |
| X6-AP-0129 | tests/migration-behavior.test.ts:1011 | `test_full_initialization` | 6 > 5 | tests.rs:814 | 确认结构阻塞：同AP-0117，测试内报告不能充当生产结果；只需F3真实报告观察面，不另造初始化算法，不以补数关闭，已请求元数据维护暂列pending |
| X6-AP-0130 | tests/migration-behavior.test.ts:1027 | `test_audit_log_initialization` | 2 > 1 | tests.rs:873 | 已核 EQUIV：:882 init.is_ok由直接调用真实F3 initAuditTable、异常自然失败保障；:891 sqlite_master中表存在对应原expect。非影子初始化器，无需重复expect，无修复SHA |
| X6-AP-0131 | tests/migration-behavior.test.ts:1035 | `test_audit_log_migration_record` | 2 > 1 | tests.rs:896 | 候选已修待复核：d9d47f792/428211444；:907真实AuditLog.complete/save成功，:910-920通过生产queryAuditLogs过滤/解码后长度1，不仅COUNT列值。Node944320/Electron929f4a三例及tscd1b63f均exit0；不复制SQL或log_migration_complete算法 |
| X6-AP-0132 | tests/migration-behavior.test.ts:1055 | `test_migration_idempotency` | 5 > 3 | tests.rs:959 | 已核 EQUIV：:966/:972两次is_ok由两次await真实F3 runAll失败自然失败；:968首报告success、:977次报告success、:981次应用数0均逐项对应原expect，无需增加冗余is_ok断言 |
| X6-AP-0133 | tests/migrations-metadata.test.ts:63 | `test_migration_set_properties` | 12 > 6 | tests.rs:1039 | 候选已修待复核：同521f0e397；:1041/1053/1065/1075四名称；:1042/1054实际声明数组count；:1047 VFS_SCHEMA_VERSION；:1059 Chat=20260910；:1066 Mistakes>=4被原>=6更强基线覆盖；:1070 Mistakes版本>=20260207；:1076 LLM>=3及:1080版本>=20260201，全来自真实F3集合 |
| X6-AP-0134 | tests/restore-domain-plan.test.ts:172 | `audit_complete_domain_restores_via_manifest_plan_consumer` | 3 > 2 | tests/restore_domain_plan_tests.rs:378 | 候选补证d02f72cc4：补:382目标不存在，生产manifest consumer后原restored/真实SQLite marker两断言保留。Node659965/Electron440b79各2绿/tsca1de51/strict2f7f7f均exit0；不修改生成行或独立验收结论 |
| X6-AP-0135 | tests/restore-domain-plan.test.ts:277 | `r7_cancelled_restore_before_cutover_leaves_no_lease_and_full_retry_succeeds` | 12 > 8 | tests/restore_domain_plan_tests.rs:686 | 候选875296fbc：补:704/:735-737前置，实际kernel完整重试而非asset helper；:744/:749-765 chat/note/webview结果，保原取消/半成品/四库与资产数/lease字段语义，生产负责切槽登记。Node da2532/Electron dd8d1b各1绿/tsc dd2015/strict103b53均exit0；原30s不变，待复核 |
| X6-AP-0136 | tests/zip-integration.test.ts:87 | `encrypted_zip_wrong_password_never_touches_target_slot` | 4 > 3 | tests/zip_export_import_restore_tests.rs:450 | 候选5cfcd00a7：分离source/target、真实F4/SQLite，clean与sealed-residue覆盖:504-523实际gate/restore拒绝，原hash/marker保护保留。Node整组3绿exit0；Electron本两例绿但同组AP0137超时使作业exit1，不冒称整组绿/签收 |
| X6-AP-0137 | tests/zip-integration.test.ts:187 | `stored_password_resolution_selects_portable_or_encrypted_export` | 11 > 8 | tests/zip_export_import_restore_tests.rs:718 | 候选5cfcd00a7但未完成：补:814实际显式密封、:821-826正确解封、:827-833 stored不得解封覆盖产物，原解析/peek断言保留且真正传输出。Nodepass/E30000ms timeout exit1真实保留；C2不批扩时，待F4最小消费main F7 native正式可见后仅复验，不假cipher/低KDF求绿 |

#### 审计库路径分歧（待 R4/架构师裁定，未改）

- Rust `backup_audit_db` 读 `application_data_root()/databases/audit.db`（backup/mod.rs:4054-4057，根目录），测试 6637-6662 断言从活动槽推得根目录并找到根下 audit。
- Rust 活跃审计库却建在活动槽：`lib.rs:1098 initialize_with_report(&active_app_data_dir)` → `init.rs:295 app_data_dir.join("databases/audit.db")`；F3 `locations.ts:331` 同样在活动槽。
- TS `backupAuditDb` 读活动槽（src/backup-manager.ts:291）。TS 用例 AP-0067 通过是因为插件初始化在活动槽建了 audit，并非证明根目录语义。
- 选项：A 照搬 Rust 读根（备份可能漏掉真实活跃审计库）；B 保持活动槽（偏离 Rust 6655 断言）。需裁定后再改，不自行选择。

### LP（候选，16 条）

| ID | 引用位置 | 计数 | 状态 |
|---|---|---|---|
| X6-LP-0068 | api.ts:1 | backup_job_manager.rs warn! 12 > 0 | 未核 |
| X6-LP-0069 | api.ts:1 | backup_job_manager.rs error! 4 > 0 | 未核 |
| X6-LP-0070 | src/cloud-config.ts:1 | cloud_config_commands.rs warn! 4 > 0 | 源码已核存在，无需修日志：Rust:902/920/926/1001分别对应cloud-config.ts:886/900/905/819，发布abort/提交后恢复与abort/清除后恢复的相同失败分支、warn级别与错误字段；index.ts:171-175真实服务注入host logger。证据为生产可达源码审读，不冒称新跑故障注入或整个事务已签收 |
| X6-LP-0071 | api.ts:1 | cloud_credentials.rs warn! 2 > 0 | 源码已核存在，无需修日志：Rust:117/140分别对应cloud-config.ts:555/538，凭据读取与非NotConfigured的SSOT失败warn；index.ts:48-54公开backup.hydrateCloudConfig提供host logger。原粗关联api.ts导致计数误报，不追加重复日志/重跑已绿业务，不扩签全部hydrate行为 |
| X6-LP-0072 | src/asset-catalog.ts:1 | assets.rs warn! 2 > 0 | 未核 |
| X6-LP-0073 | repository/vfs-restore.ts:1 | backup/mod.rs warn! 17 > 10 | 未核；引用文件已删（d8d86d53c），计数归 mod.rs 全体，需按分支重核 |
| X6-LP-0074 | repository/vfs-restore.ts:1 | backup/mod.rs error! 22 > 0 | 未核；同上 |
| X6-LP-0075 | src/zip-codes.ts:1 | zip_export.rs warn! 2 > 0 | 未核 |
| X6-LP-0076 | api.ts:1 | data_governance_executor.rs warn! 1 > 0 | 未核 |
| X6-LP-0077 | src/cloud-config.ts:1 | commands.rs warn! 8 > 5 | 部分候选已修：7885b8e09 补 slot C/D MigrationCoordinator 日志，slot-tests 生产命令 2 例（20261104124840-d8ed64 exit 0）；不据此统签其余 warn 分支 |
| X6-LP-0078 | src/cloud-config.ts:1 | commands.rs error! 1 > 0 | 未核 |
| X6-LP-0079 | src/backup-commands.ts:1 | commands_backup.rs error! 11 > 3 | 部分：check_disk_space 获取磁盘空间失败 error 已补（16d74702f）；其余待逐分支 |
| X6-LP-0080 | src/zip-commands.ts:1 | commands_zip.rs warn! 6 > 5 | 部分候选6e2aff74b/回归9d233c830：:445未知层级小写值逐项warn，混合合法继续与全非法失败两真实kernel分支保留，修前5f53ce两红/修后Node31e919、Electrona0839e各2绿exit0；其余warn未统签 |
| X6-LP-0081 | src/zip-commands.ts:1 | commands_zip.rs error! 3 > 0 | 部分候选493b5afd4/回归e1a89fad9：Rust:1583/:1891初次与续传ZIP导入非取消失败的error已补。修前af7de9 exit1实际[]；修后Nodeff6b97/Electron2a3bb1各1绿exit0。第三个:53虚拟URI复制error未在本轮修复/签收，不据两项绿统签 |
| X6-LP-0082 | LANE.md:1 | plugin total warn! 63 > 39 | 汇总项，随上列逐项处理 |
| X6-LP-0083 | LANE.md:1 | plugin total error! 54 > 4 | 汇总项；本轮已补 check_disk_space、恢复切槽退出失败（8f31bf443）两处 error |

## v2 续作增量（2026-11-04 下午，Claude Opus 5.5）

### 自动续派补断言（2026-11-04，GPT-6.1 Sol）

#### 2026-11-05 续派：B09 优先修复、AP-0087 与旧阻塞纠正

- 本轮先合并 main → `eabbb13e3`；自检仍因两个非本 lane 的 `migration/` 未提交文件退出 2，原样保留。
- B09：真实 F3 已有 `StorageError.phase`，原来首次 FK iterator.next 的 prepare 错误仍误写成“读取失败”。
  新增真实 SQLite 非唯一列外键引用，通过 kernel health 命令断言精确准备失败前缀；
  1783a548f/8cd83b1f4 按 phase 映射准备/绑定/读取，纠正 diagnostics 的惰性迭代器注释，SPEC 已列分支表。
  不是解析错误文案或替换 SQL 的测试。原违规清理与只读超时用例保留。
- 修前 `20261104161707-de3529` exit 1 原样保留；修后 `20261104162025-033924` 3 passed / exit 0。
  AP-0087 与共用夹具 AP-0084：`20261104161232-f11193` 2 passed / exit 0。
  Electron 两组最小组合 `20261104162026-d8de86` 5 passed / exit 0；typecheck `20261104162026-cb98b9` exit 0。
  通过作业均无 Errors 行。未重跑全目录、ledger 或已签 B04，均待 main 后独立复核。
- **阻塞状态纠正**：F3 finalizer API、F1 finishStartup、F2 startupGate、F3 SqlPhase 都已可消费（见 BLOCKERS 最新段）；
  不能仅因迁移 worker 的 `80a7b8877` 未在祖先链，就误称这些独立 API 未提供。
  当时迁移 worker 未在树，现已按上文 main `80dcc5291` 及后继接线；finalizer 与 maintenance-status ready-wait 仍为本 lane 后续接线任务。

续派增量（本轮先 merge main → bd4572386）：
- AP-0090/0091 是真实生产缺陷而不只是计数缺口：取消原来只抛普通 Error，缺 `Io(Interrupted)` 类型及 `IO error:` Display；
  各原检查点统一改为 code=EINTR 的自定义 IO 错误（不设置 errno 以免覆盖用户取消消息）。另补内层 ZIP 完成后、不可中断加密前的取消点，finally 清理不变。
  Rust→TS 分支表见 SPEC 中 export_zip/import_zip 的 v2 取消增量。
- AP-0072 不再仅看静态目录；新增真实 F3 + kernel run_backup 的两个设置域计划断言。AP-0073 补真实 crypto 计划字段；
  AP-0080 补所有七个源文件保留。未改已签收 B04，不复活停用恢复命令，未再跑全目录/ledger。
- Node：20261104153255-c71b78 两例确因缺 EINTR 失败（exit 1，保留）；修后 20261104153942-c87b04 为 8 passed / exit 0，
  20261104153942-9e412e、20261104153514-ec0d0e 各 1 passed / exit 0；20261104154747-0ed06f 加密前取消例 1 passed / exit 0。
- Electron：20261104154747-49d906 为 3 files / 11 passed / 61 filtered / exit 0，含加密前取消新例；
  typecheck 20261104154747-e2974b exit 0。通过作业均无 Errors 行；不把此前 exit 1 洗成通过。
- lane-gate 本轮起点仍因非本 lane 的 migration/LEDGER.md、migration/ledger.json 未提交改动退出 2；不提交或清除他人改动。
  当时 F3 worker 未合；现已正式 main 并由 L21 消费（见上文），不再构成提供方阻塞。以上业务候选仍待独立复核。

- 候选新增：AP-0060、0075、0077、0084、0097、0098；代码/自动检查点与逐条 Rust 断言映射见上表。
  AP-0066 另补 run_backup 两条失败回归（334964bf8）：拒绝超大主密钥、secure 子目录；无备份发布且真实 F3 维护屏障退出。
  AP-0094/0095 已证循环覆盖原输入，不新增重复 expect。新 X6 报告 79 个 Rust ID 全部关联原稳定编号，不重扫或重编号。
- Node 仅跑变更范围：20261104145232-9b5398（2 passed）、20261104145406-ff0500（1 passed）、
  20261104145611-07dad2（2 passed）、20261104150347-52dc5a（2 passed）、20261104150758-c2a8eb（2 passed），
  均 exit 0、无 Errors 行。ZIP 首次失败 20261104150603-9bca2b（exit 1）原样保留，未放宽断言。
- Electron 原生 SQLite 相同小集合：20261104151022-b87d73，4 files / 8 passed / 96 filtered / exit 0、无 Errors 行。
  typecheck 20261104150758-40373f exit 0，无 Errors 行。没有重跑 B04、全目录或 ledger 取回执。
- 上述均为候选测试证据，不自行签收 R4 的 B02/B10/B11 或 X6 项。F3 worker 仍须正常 main 集成后再消费。

均待 R4 复核；本 lane 不勾 ACCEPTANCE。

| 项 | 修复（生产入口） | Rust | 测试 · 作业（退出码） |
|---|---|---|---|
| B05 | prepare/finalize 经 `vfsMaintenance.resetRebuildableIndex(targetDir)`，删 `repository/vfs-restore.ts`；2 条测试改 ported | backup/mod.rs:2521-2568 | backup-manager/restore/zip-integration · `20261104110506-f33825`、electron `20261104110653-e6b972` 35 passed（0） |
| B02 | 三个 staging 入口 staging 失败也先 release，release 失败优先（6 例） | commands_backup.rs:2003-2018,2807-2818；commands_zip.rs:427-516 | acceptance-fixes · `20261104112653-a25a71`（0） |
| B02（恢复切槽） | `setRestoreCutoverMaintenance` 逐组件进入（主库/VFS/Chat V2/LLM Usage/工作区前缀），主库已维护按结构化错误拒绝，失败只回滚本次组件，退出失败记 error；去掉 message 子串匹配 | commands_restore.rs:266-399,1198-1224 | restore.test 真实 `StorageServiceImpl` 3 例 · `20261104115132-a81b30` 23 passed（0） |
| B10 | verify/verify_with_assets/restore 的 findBackup 传 logger | backup/mod.rs:5712-5731 | acceptance-fixes B10 3 例 · `20261104115418-e3e9ea`（0） |
| 自查 1.3 | 激活标记读取/解析分开报错 + serde 解码器；审计 `AuditOperation` serde 解码、chrono RFC3339 纳秒保留、`Database error:` 前缀 | commands_restore.rs:56-65,165-171；audit/mod.rs:43-90,767-807 | restore 4 例、audit-decode 8 例 · `20261104113645-9e26ad` 152 passed（0） |
| 自查 1.4 | 资产目标路径非法单独报错；磁盘空间改平台 `getAvailableDiskSpace`（statvfs→df→fail-close，check_disk_space 失败记 error） | assets.rs:1254-1268；backup_common.rs:632；commands_backup.rs:1373-1376；commands.rs:1248 | assets · `20261104113102-1541f3` 48 passed（0） |

typecheck：`20261104115132-c46494`（0）。boundaries strict `20261104113103-091587` 退出 1，4 条违规全在 `host/plugins/vfs/`（非本 lane），backup 0 条。

已核对、无需改：`backup-manager.ts` markFull→markPartial（Rust 3150/6131 同样不记日志）；governance 迁移错误读取（Rust `.ok()?`）；resume 导入参数回退（Rust `unwrap_or_default`）。
`tests/helpers.ts` 的 no-op `enterMaintenance` 仍被 B04/B09 等不断言屏障的用例使用；断言屏障的 B02 与切槽用例已改用真实 F3。

自检（standard-v2 §5）：全部本 lane 改动已提交，`git merge --no-edit main` → `18c5f2450`。
`lane-gate.mjs` 退出 2（前置条件）：工作区有 `migration/LEDGER.md`、`migration/ledger.json` 的未提交改动，
接手前即存在、非本 lane 产生；按纪律不提交、不 stash/restore 他人文件，需协调者确认处置后再自检。

### X1 运行时审读：get_migration_diagnostic_report / run_slot_d_clone_db_test

- Rust：两命令都是同步 `#[tauri::command] pub fn`（commands.rs:1061,1289），在 Tauri 命令线程上跑，不阻塞其它 async IPC；
  诊断报告内部依次跑 slot C 空库迁移和 slot D 克隆迁移（commands.rs:1199-1214）。Slot D 用 Online Backup `run_to_completion(64, 10ms)`。
- TS：`Governance.runSlotCTest/runSlotDTest`（src/governance.ts:426-500）语义与 Rust 一致，但 `MigrationCoordinator.runAll`
  内的 `migrateDatabase`（F3 `host/platform/storage/migration/coordinator.ts:180`）是同步 better-sqlite3 + 同步 fs，在 Host 主线程执行，
  会冻结整个事件循环。`backupTo` 用 better-sqlite3 分步 backup，步间让出事件循环，不是主因。
- 复用 X1 原产物证据：`/tmp/opencode/x1-smoke-6Dg6nm/node/result.json` 中 slot D 返回 `结果: 成功 (15272ms)`，四库全部
  "已是最新"（0 个迁移），说明耗时在 coordinator 的校验/修复路径而非复制；同轮诊断报告 crash `durationMs 8148`
  （预算 5000ms 的计时器被推迟约 3s 才触发），证明事件循环被同步工作阻塞。`x1-smoke-cKMk1s` 同命令 slot D 1396ms，
  耗时随机器负载波动大。
- 原候选计划（现已按上文正式接口接线，历史保留）：在 F3 提供"在 worker 线程对指定目录运行 `MigrationCoordinator.runAll`"的 owner 接缝
  （参照 L11 `vfs-repos/src/worker-service.ts`），L21 的 slot C/D 改调该接缝；清理（resetDir）、错误文本与报告格式留在 L21 不变。
  不加业务超时，不改 X1 预算/断言。原 coordinator 缺日志已在 7885b8e09 补过；当前正式 worker 继续按原级别/字段传日志，非现存“缺 log”阻塞。

## 当前状态与下一步（2026-11-04 新会话接续）

### 已完成

- 契约命令 33/33 已注册；`TESTMAP` 313 ported / 10 pending（pending 均有跨 lane 证据，见 `BLOCKERS.md` §1）。
- R4 已签收：B01（字符串错误出口，e4dd）、B08（auto_verify 锁内选择/验证/审计，e4dd）。
- **分支可见性**：`0d4a73c61`、`5f02d66bd` 已是 main 祖先（main `eeaf5bdc7`），由 R4 在 main 上复核 B02/B03/B09。
- B02/B03/B09 的实现与回归已在本分支落地（e4dd 复核之后）：
  - B02：`enterSnapshotBarrier` 在主库已被外部维护时借用屏障且 ownership 为空；`release()` 首次失败后按 Rust Drop 语义在同一调用内再试一次。`tests/acceptance-fixes.test.ts` 新增真实 `StorageServiceImpl` 借用/重试用例。
  - B03：`Operations.acquireForJob` 在排队期间每 200ms 轮询取消，排队取消文案 `用户取消任务`；`tests/acceptance-fixes.test.ts` 断言 450ms 内 cancelled 且不提前释放持有者。
  - B09：`integrityCheck` 先 `rows.return()` 再 close，close 的 busy 错误不得覆盖原始 FK 违规诊断；`tests/acceptance-fixes.test.ts` 用真实 FK 违规数据断言最终 issue 为 `检测到外键约束违规`。
- B04/B10/B11 已按首轮问题修，按 C2 要求不自勾，等 R4 定向复核。
- D7：L20 `applyDownloadedChangesToDatabases` 已 main 可用；本 lane 只在 `tests/commands-backup-sync.test.ts` 经 `ctx.get('sync')` 消费，5 条原 `commands_backup` 冲突/库路由测试已执行。

### 剩余（按执行顺序）

1. ~~先把 R4 §7 的“真实 storage/工作区边界”补齐~~ —— **已完成**（提交 `0d4a73c61`、`5f02d66bd`）：
   - B02 `B02 run_backup freezes...` 改为真实 `StorageServiceImpl`，staging 期间 `storage.database('vfs')` 与备份前已持有句柄写入均抛 `MAINTENANCE`，屏障退出后同一句柄恢复可写。
   - B09 FK/只读 profile 用例改到真实 `StorageServiceImpl` 路径。
   - B03 排队取消改真实 `StorageServiceImpl`；新增“获取全局备份锁失败”文案回归。
2. ~~复跑变更相关测试 + `tsc`~~ —— `acceptance-fixes` 19 passed / exit 0（作业 `20261104085038-86d7ff`），`commands-backup-sync` 5 passed / exit 0（作业 `20261104085658-a470af`），`tsc` exit 0（作业 `20261104085038-3eb101`）。**当前树没有全目录通过证据**：全套 364 passed / 4 timeout / exit 1（作业 `20261104083515-e07598`）；历史 368 passed（`20261104082121-fd43b5`）只属旧树，不能覆盖本次失败。按 C2 08:26 指示不再重复跑全套。
3. quality-feedback 的 `migration-behavior.test.ts` 断言数 274→253：减少的 21 条全部属于转 pending 的 8 条本地替身测试（见 `BLOCKERS.md` §1 与 `SPEC.md` B06），证据已写入最终报告。
4. **等待 R4 定向复核 / 所有者 API，不再自跑全套**：
   - R4 复核 B02/B03/B09 增量与 B04/B10/B11（本 lane 不自勾 B04/B10/B11）。
   - L11/L12 发布 `resetRebuildableIndex(targetDir)`（B05 VFS）。
   - F3 提供启动初始化 / Registry 刷新 / 启动就绪等待 / 恢复激活启动钩子。
   - 收到具体返工项后只跑对应最小测试集（经全局 `job.mjs`），并在最终报告保留 job ID/exit/Errors。

### 真实跨 lane 阻塞（未变）

- VFS 派生索引恢复重置：缺 L11/L12 `resetRebuildableIndex(targetDir)`，L21 不复制 VFS SQL；2 条 VFS 回归可执行但 TESTMAP 保持 pending（最小语义见 `BLOCKERS.md` §1.1）。
- 启动初始化 / Registry 刷新 / 启动就绪等待 / 恢复激活 startup hook：归 F3 `storage`；7+1 条 init 测试保持 pending，`finalizeRestoreActivation` 已实现待 F3 启动注册。
- L23 消费侧（kind/错误组装、显式 release）属 L23 文件，本 lane 只发布正式接口。

### 复核“必须修复”未决清单（R4 §7 口径）

- B02：借用分支/Drop 重试已实现；真实 `StorageServiceImpl` 写阻断/外部 lease 不释放回归已补，**等 R4 对 `0d4a73c61` 的独立复核**。
- B03：排队取消已实现并验证 450ms 内取消；取锁失败文案已补；跨进程锁原语等价仍属 F3 平台 `backup-common.ts`，本 lane 不改，等 R4 反例。
- B09：迭代器释放/错误优先级已实现；真实 `StorageServiceImpl` FK 回归已补，等 R4 复核。
- B04/B10/B11：等 R4 复核，不自行勾选。
- B05/B06/B07：跨 lane / 账本口径，按 `BLOCKERS.md` 与 `SPEC.md` 记录。

## 2026-11-05 F4完整联合树消费：Value details与AP0136/0137真实native

- 正常merge真实owner交付 `3f7187033`（F4最终联合tip，base main `65f668842`；含L14 `9871b1c1c`／实质`78f1dd8cf`、L18 `f9d949d43`／实质`65a801993`），未cherry-pick、未复制提供方实现；本lane只改 `host/plugins/backup/`。
- 审计details改用F4正式 `jsonNumberToRawJSON` 投影数字、`stringifyJsonValue` 从保留的原始Value树再序列化；任意精度/重复键last-wins/首次键序按serde Value语义保留，无Number/Infinity/null/skip/fails/条件断言，原两个 `it.each` 全部执行。
  - Node `20261105104241-17ae61`：audit-decode 41 passed/0 skipped/exit0；Electron `20261105104241-0a609e` 同41 passed/exit0。
- `zip-integration::setupRealSecrets` 在同一真实Host安装公开F7 `native` 后把真实 `ctx.nativeArgon2` 传给正式 `createSecretsService`；未造bootstrap Host/假快KDF，m65536/t3/p4、原30s与全部断言不变，安装步骤留在用例计时内。
  - Node `20261105104244-0acd61`、Electron `20261105104244-5d164c`：原clean/residue+stored/explicit三例各3 passed/7 filtered/exit0（Electron实际约1.4s，不再触发原30s）。
- 标准检查：typecheck `20261105104348-90ba2d` exit0；boundaries `20261105104348-717c9c` 3013文件0违规；strict `20261105104348-d687c7` 两文件0违规；importable `20261105104348-aa74fe` ok；本目录全量 `20261105104351-dc1605` 29文件460 passed/exit0。
- 提交 `a0c6229f8`（merge `575f8414d`）；两foreign ledger保持未暂存/未提交。待C2正常integrate干净树全gate。
- main已前进到 `c7f0ed8e4`（含F4/L14/L18/F1/F3/F2等正常集成），本lane已 `git merge --no-edit main`（merge `7e4f2c072`）并在合并后复验：typecheck `20261105105036-7bb733` exit0；audit Node/Electron `20261105105037-06d5fe`/`-4f9392` 各41 passed；Crypto三例 Node/Electron `20261105105037-604ed5`/`-74ff5e` 各3 passed；boundaries `20261105105353-9773c4` 3023文件0违规；strict `-301eef` 0违规；importable `-1b9455` ok；本目录全量 `20261105105353-2c42cf` 460 passed/exit0。
