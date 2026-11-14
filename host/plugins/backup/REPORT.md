# L21-backup-governance 迁移报告

生成时间：2026-11-04 · 分支：`ds-mig/L21-backup-governance` · 插件：`host/plugins/backup/`

## 1. 结论

- 契约命令 **33/33 全部注册**，命令名、参数、返回形状与错误通道按 `contracts/ipc/L21-backup-governance.json` 校验。
- Rust 测试 323 条：**313 条 ported**（23 个 Vitest 文件；历史全套 368 个用例 passed、无 skip），**10 条 pending**，逐条证据见 §5。
  2026-11-04 续作新增 1 条 B03 锁失败文案回归后共 369 例；本轮按 C2 指示只跑变更相关 19 例（passed / exit 0），
  未再反复跑全套，历史与本次负载下失败原文见 §9。
- R4 `ACCEPTANCE.md` 的 B01–B11 已逐项处理（B05 的两个 VFS 测试与 B06 的 7 个 init 测试按跨 lane 阻塞转 pending）；
  issue → 处理 → 提交见 `SPEC.md` 的「验收问题处理」。
- 本 lane 提供 `backup`、`governance`、`cloudConfig` 三个服务（lowerCamelCase，`api.ts` 声明 + `meta.provides` + `ctx.provide`），
  并消费 F3 `storage`、F4 `settings`/`secrets`、L23 `syncProvider`。
- 完整 A/B 切槽恢复已实现：清单兼容/覆盖校验 → 候选槽清理 → 数据库/工作区/非数据库域恢复 → VFS 索引 prepare/finalize →
  候选槽迁移 → 同步基线重建 → 激活标记 → 维护屏障 → 密钥事务发布与切槽登记 → DomainRestorePlan 消费/隔离/未消费断言 → 审计 →
  `requires_restart: true`。
- `cloudConfig` 服务已实现 `save/get/clear/publish`（SSOT 快照回滚、staged 凭据、稳定错误码、u64 安全整数检查），
  F4 的 `cloud_config_ssot_*` / `cloud_config_publish` 命令因此真正注册。

## 2. 已注册命令（33/33）

| 类别 | 命令 |
|---|---|
| 备份列表/删除/校验 | `data_governance_get_backup_list`、`data_governance_delete_backup`、`data_governance_check_disk_space_for_restore`、`data_governance_verify_backup`、`data_governance_verify_backup_with_assets`、`data_governance_auto_verify_latest_backup` |
| 备份执行/任务 | `data_governance_run_backup`、`data_governance_backup_tiered`、`data_governance_get_backup_job`、`data_governance_cancel_backup`、`data_governance_resume_backup_job`、`data_governance_cleanup_persisted_jobs`、`data_governance_list_resumable_jobs` |
| ZIP | `data_governance_export_zip`、`data_governance_import_zip`、`data_governance_backup_and_export_zip` |
| 恢复/清理 | `data_governance_restore_backup`、`data_governance_purge_all_data` |
| 资产 | `data_governance_get_asset_types`、`data_governance_scan_assets`、`data_governance_restore_with_assets`（保留旧入口固定错误） |
| 治理/诊断 | `data_governance_get_migration_status`、`data_governance_get_schema_registry`、`data_governance_get_database_status`、`data_governance_run_health_check`、`data_governance_get_maintenance_status`、`data_governance_get_migration_diagnostic_report`、`data_governance_run_slot_c_empty_db_test`、`data_governance_run_slot_d_clone_db_test` |
| 审计 | `data_governance_get_audit_logs`、`data_governance_cleanup_audit_logs` |
| 云配置 | `cloud_config_test_connection_draft` |

事件：`backup-job-progress`、`backup-import-progress`；`id`/`job_id` 两个表达式事件按 Rust 实际发送名归并为
`backup-job-progress`，已在 `SPEC.md` 说明。

## 3. 服务与接线

| 服务 | 提供方 | 消费方/生产调用 |
|---|---|---|
| `backup` | `host/plugins/backup` | 提供 `jobs`、`hydrateCloudConfig`、`cleanupOldBackups`、`tryAcquireOperation(kind)`、`acquireOperation(kind, timeoutMs)`、`syncCommandPorts()`（显式 `release()`）；供自动备份/设置、L20 同步与 L23 云同步写命令使用 |
| `governance` | `host/plugins/backup` | 提供资产目录、活动槽资产扫描、`acquireOperationGuard(kind)`/`tryAcquireOperationGuard(kind)`（DeletePropagation 删除路径）、等待型 `acquireOperation` 与 `syncCommandPorts()` |
| `cloudConfig` | `host/plugins/backup` | F4 `dstu.platform.cloud-config` 命令层经 `ctx.cloudConfig` 调用（`cloud_config_ssot_save/get/clear/publish`） |

- `ctx.secrets`：备份种子校验/reseal、DSBK 密封、云凭据读取、crypto publication journal。
- `ctx.storage`：活动槽定位、数据库快照/恢复、维护屏障 `enterMaintenance`。
- `ctx.settings`：云配置 SSOT（`cloud_storage.config.safe_v1`）。
- `syncProvider`：草稿试连 `createStorage`/`checkConnection`；已按 L23 正式服务名 `syncProvider` 消费（旧键 `sync.provider@1` 回退已删除）。
- `ctx.syncSupport.state.recordDeviceRotation`：恢复激活的设备轮换写操作改由 L20 已发布服务完成，
  `repository/sync-state.ts` 已删除。
- `finalizeRestoreActivation` 已实现并测试，但 F3 启动流程尚未在启动时调用；属于 F3 启动集成边界。
- 跨 lane 阻塞与待接线接口汇总见 `BLOCKERS.md`。

### 共享接口交付（2026-11-04 协调者增量）

实现提交：`2a3738008`（协调器/同步端口/agentTools 接线）、`31ad462b2`（公开 API 类型、忙锁错误与测试/VFS 恢复执行）、`bf1a1d20e` + `0980d8552`（C2 P03 结构化 busy/lock IO、D3 u64 IPC number、L20 分支状态与文档）。

- **唯一操作许可**：`Operations` 仍是进程级单例；`backup.tryAcquireOperation(kind)`、`backup.acquireOperation(kind, timeoutMs)`、
  `governance.acquireOperationGuard(kind)`、`governance.tryAcquireOperationGuard(kind)`、`governance.acquireOperation(...)`
  全部使用同一队列与跨进程锁。kind 使用契约 serde snake_case（9 种），不再有大写映射或“默认 prune”。
- **等待型 acquire**：`Operations.acquireWithTimeout` 是真实队列等待；超时返回 `timeout` 并移除自身排队位置，
  不会被补授许可；公开方法按 Rust 原文案抛
  `等待全局数据治理锁超时（N秒），可能有其他数据治理操作正在执行，请稍后再试。`；忙锁/锁 IO 抛结构化
  `OperationGuardError`（见下一条），invoke 正常 settle。调用方必须在 `try/finally` 显式 `release()`。
- **C2 P03 结构化许可错误**：`OperationGuardError` 公开 `reason: 'busy' | 'lock_io'`、稳定
  `code`（`E_DATA_GOVERNANCE_BUSY` / `E_DATA_GOVERNANCE_LOCK_IO`）、`app_error`（Rust 同形
  `{ error_type, message, details }`）与 `cause`；`value === app_error`，L23 可直接按原
  `Validation`/`FileSystem` 契约传输，不再猜 message 前缀。L21 的 `error: string` 命令在
  `stringErrorCommand` 出口取 message 转回字符串；裸 `Error` 不转成业务错误。
- **D3 u64 → IPC number**：`u64ToJsonNumber` 只做与原 Tauri/serde_json 一致的 number 输出，
  不再因 `> Number.MAX_SAFE_INTEGER` 额外拒绝 Rust 合法输入；内部 generation/版本/大小仍为精确 bigint。
- **DeletePropagation**：`governance.acquireOperationGuard('delete_propagation')` 按 Rust `try_acquire` 立即失败，
  供 C1 工作区删除、L04/L05 删除、L10 笔记/资产删除接线。
- **L20 SyncCommandPorts（L21 部分）**：`backup.syncCommandPorts()`/`governance.syncCommandPorts()` 返回同一对象：
  - `limiter`：`tryAcquire()` + `acquire(timeoutMs)`，与备份/恢复/ZIP 共用同一许可；
  - `loadHydratedCloudConfig()`：SSOT → runtime → SecureStore 凭据 → `validateConfig`；`NotConfigured → null`，
    凭据缺失 `E_CLOUD_CREDENTIALS_UNAVAILABLE`；
  - `saveSyncAudit()`：`AuditOperation::Sync` 的 started/completed/failed 行，best-effort，不阻断主流程。
  `application` 按 D7 明确不由 L21 提供：main `d5cd234aa` 已集成 L20 `host/plugins/sync/api.ts:108`
  `applyDownloadedChangesToDatabases(changes, strategy)`；唯一实现留在 L20 `repository/apply-databases.ts`，
  由 L20 本地绑定，L21 不复制跨所有者表写入，缺 `sync` 时按需 `ctx.get` 报错、不硬 inject。
- **L07 agentTools**：`DataGovernanceToolExecutor` 在 `apply` 中经 `ctx.agentTools.registerToolExecutors([...])`
  注册，服务已存在与后到两种路径都覆盖；派发/审批/超时仍归 L04/L07。

## 4. 测试迁移

- 23 个测试文件、368 个用例全部 passed（无 skip），exit 0，无 `Unhandled Error`、无
  `Timeout calling "onTaskUpdate"`；`TESTMAP.md` 311 行 `ported:`，12 行 `pending`。
  （2026-11-04 续作新增 1 条 B03 回归后为 369 例，本轮未再跑全套，见 §9。）
  合并 `main` 前后的历史证据为 22 文件 / 358 用例（508.96s、653.15s）；R4 阶段 B07 的两次修复后
  证据（21 文件 / 345 用例：343 passed + 2 skipped，389.37s / 268.28s）保留在 `SPEC.md` B07 行。
  本轮新增共享接口、VFS 恢复与 5 条 L20 同步测试后为 23 文件 / 368 passed。
- C2 P03/D3 增量（2026-11-04）：`operation-and-sync-ports` + `acceptance-fixes` + `cloud-config`
  共 3 文件 / 47 passed，exit 0（全局 jobs 作业 `20261104065221-ada3e7`）；busy/lock IO 判别、
  B03 双 host 忙锁 wire、u64 IPC number 均已覆盖。
- 执行门禁：vitest fork worker 的 birpc `onTaskUpdate` 固定 60s 超时；`migration-behavior.test.ts` 的
  92 条用例大量调用同步 SQLite 迁移，形成长微任务链，负载下 `historical_fixtures...` 单测曾达 76.8s，使待处理 RPC
  定时器先到期并导致 exit=1。修复为每个用例前及长用例各阶段之间让出宏任务（仅测试调度，断言不变）。
- 覆盖重点：清单 v3/覆盖账本、备份 ID/磁盘预算、任务状态机/checkpoint/持久化、ZIP 便携/密封往返、密码解析、
  取消/续传、便携预检、增量拒绝、schema registry、资产扫描/敏感文件/符号链接防护、完整切槽恢复、
  crypto 事务发布/回滚、DomainRestorePlan 消费/隔离/未消费断言、R7 重试矩阵、迁移执行/历史 fixture、
  共享操作许可/超时队列/DeletePropagation、L20 同步端口、L07 agentTools 注册。
- `tests/acceptance-fixes.test.ts` 为 R4 B01/B02/B03/B04/B08/B09/B11 的生产入口回归（经 `host.invoke` 或发布服务），
  其中 B01 现有 5 条真实 invoke settle（返回/拒绝）断言。
- `tests/operation-and-sync-ports.test.ts` 覆盖协调者增量：9 种 snake_case kind、跨服务互斥、带超时等待与
  超时后不补授、同步 limiter、`loadHydratedCloudConfig`、`saveSyncAudit`、`agentTools` 注册（已存在/后到）。
- `migration-behavior.test.ts` 92 个用例覆盖 `migration_tests.rs`、`tests.rs`、`critical_audit_tests.rs`、
  `migration_compat_tests.rs`、`mod.rs::policy_tests`；`init.rs` 本地替身和对应 7 条测试已删除并转 pending。

## 5. 仍为 pending 的 10 条及证据

> **断言数变化说明（quality-feedback `weakened`）**：`tests/migration-behavior.test.ts` 的
> `expect()` 数从 274 降到 253，减少的 21 条 **全部** 来自下表已转 `pending` 的 8 条测试，
> 不是从保留测试中删除或放宽断言：
> `init.rs` 7 条共 19 条（3+4+3+1+2+2+4），`commands.rs::refresh_schema_registry_from_dir_maps_poisoned_lock_error`
> 1 条共 2 条。原因是这些测试断言测试内本地 `InitializationReport`/`RegistryStateHolder` 替身，
> 违反 quality.md §10.1；在 F3 发布生产初始化/Registry 刷新入口前不能计为 `ported`。

| 测试 | 条数 | 阻塞类别与证据 |
|---|---:|---|
| `backup/mod.rs::test_restore_handles_write_failure_gracefully`、`test_pre_restore_backup_and_rollback_mechanism` | 2 | 对应 Rust `BackupManager::restore` / `rollback_from_pre_restore` 仅被 `restore_with_assets` 调用，而该入口的命令层已固定返回停用错误（`src-tauri/src/data_governance/commands_asset.rs:118-126`：`该旧恢复入口已停用...`）。Electron 生产无调用方，移植将测试死代码；需协调者批准 `obsolete:dead-in-electron`。 |
| `init.rs::test_ensure_directories`、`test_initialization_report_new`、`test_initialization_report_is_fully_successful`、`test_needs_initialization_new_app`、`test_get_current_schema_state_empty`、`test_initialize_audit_log`、`test_initialize_without_feature` | 7 | 启动初始化编排由 F3 `storage` 持有；Host 未发布 `ensureDirectories`/`InitializationReport`/`initializeWithReport`/`needsInitialization`/`getCurrentSchemaState` 生产入口。测试内本地替身已删除，TESTMAP 转 pending。 |
| `commands.rs::refresh_schema_registry_from_dir_maps_poisoned_lock_error` | 1 | 需要 F3 发布生产 `refreshSchemaRegistryFromDir` 与可观察的 Registry 写锁状态；测试内 `RegistryStateHolder` 替身已删除。 |

原 `data_governance_executor.rs` 8 条已移植到 `tests/governance-tool.test.ts`：`src/governance-tool.ts` 实现了
`can_handle`/`sensitivity_level`/`concurrency_class`、参数校验、任务摘要映射、同步结果映射与 24h 任务回执；
`DataGovernanceToolExecutor` 现已通过 `ctx.agentTools.registerToolExecutors` 在 L07 注册表生产接线（见
`tests/operation-and-sync-ports.test.ts`）。Rust `execute` 的派发适配器仍由 L04/L07 负责。

## 6. 质量自查（quality.md 第五/六/七节）修复点

- **日志**：Rust `warn!`/`error!` 位置改为 `ctx.logger('backup').warn/error` 或仓储函数参数 logger；
  `verify` 的数据库打开失败、crypto 沙箱解密失败、删除旧备份失败、manifest 临时文件清理失败均记录后继续。
- **空 catch**：生产代码 `console.*` 清零；保留 4 处 `boundary-allow empty-catch`，理由与 Rust `let _ = ...` 一致
  （`repository/vfs-restore.ts` 回滚失败保留原始错误、`src/assets.ts` 半成品清理失败、
  `src/governance.ts` 关闭 FK 迭代器不得覆盖原始外键诊断、`src/operations.ts` RAII 释放失败不覆盖主错误）。
- **crypto 验证**：`verifyDirectoryWithAssets` 补齐 Rust `verify_crypto_material` 的隔离沙箱实际解密步骤
  （复制种子/凭据到临时 `.secure`，`getSecret` 失败报 `加密凭据无法实际解密`），并保留 `加密凭据验证时消失`。
- **u64**：`cloud_config_test_connection_draft` 与 `cloud_config_publish` 的 generation 内部保持 bigint；
  `u64ToJsonNumber` 按原 Tauri JSON number 输出，不再对 `> Number.MAX_SAFE_INTEGER` 额外拒绝（D3）。
- **服务命名**：按 ARCHITECTURE 附录 A 使用 `backup`/`governance`/`cloudConfig`，导出 `*Service` 版本描述；
  `syncProvider` 优先新名、旧键回退。
- **cloudConfig 校验顺序**：`publish` 先校验配置，再查 secret（与 Rust 一致）；凭据先 normalize（`null`→`undefined`）。
- **测试生产路径**：`backup-manager.test.ts` 直接调用 `createBackup`/`backupCryptoKeys`/`backupAuditDb`/`restoreCryptoKeys`/
  `verifyWithAssets`/`restoreSingleDatabaseToDir`；ZIP 往返走 `exportBackupToZip`/`importBackupFromZip` 与
  `data_governance_restore_backup` 命令；`list/cleanup` 走 `ctx.backup.cleanupOldBackups`。
- **平台模块替换（F4 已合入 main）**：删除 `src/io.ts` 的本地 `rfc3339Now`/`formatRfc3339`，全部调用点直接使用
  `platform/time.toRfc3339`（AutoSi + `+00:00`，同时修复旧实现把 `.120` 压成 `.12` 的偏差）；
  `utcNow` 使用 `toRfc3339Opts(..., 'AutoSi', true)` 对应 chrono serde 的 `Z`；
  全部 `str::trim` 改为 `platform/util.rustTrim`（U+FEFF/U+0085 语义），UTF-8 长度改为 `utf8ByteLength`。

## 7. 实现差异与限制

- **ZIP**：经 `host/platform/zip` 流式读写（文件句柄 + zlib 流，支持 ZIP64），写出布局与 Rust `zip 0.6.6` 一致；
  导入前按 `validate_import_archive` 校验条目数、中央目录声明的 20 GiB 解压总量、单条目/整体压缩比 ≤ 200、
  非空条目零压缩、路径/重复/换行；解压时逐条目校验 CRC 与声明大小，实际解压预算由 `copyWithActualSizeBudget`
  按条目累计校验，超限不提交计数。
- **平台接口缺口**：F3 未在 `api.ts` 发布 `SchemaRegistry`/`AuditRepository`，本 lane 在 `repository/` 内最小等价实现；
  诊断 Slot C/D 复用平台内部 `host/platform/storage/migration/coordinator.ts` 与 `DEFAULT_MIGRATIONS_DIR`（非公共 API）。
- **维护状态**：`Operations` 为模块级共享队列 + 跨进程锁文件；备份/分层/ZIP 导出在 staging 期间调用
  `ctx.storage.enterMaintenance(DATABASE_NAMES)` 并（若存在）`agentWorkspace.enterMaintenanceMode()`，
  `blocked_components` 来自真实 lease；`component_health` 读取 F3 `storage.impl.componentHealth`（缺失时为 null）。
  启动就绪等待仍缺 F3 公共 API，见 `BLOCKERS.md`。
- **审计库路径**：恢复 DomainRestorePlan 的 audit 域恢复到应用根 `databases/audit.db`；备份侧读取活动槽 `databases/audit.db`
  与 Rust `BackupManager` 收到 slot 路径时的解析一致。
- **`data_governance_purge_all_data`**：写 `.purge_on_next_start`（内容 `1`）后调用 `ctx.shell.request('process:restart')`，
  进程仍存活时抛 `应用重启未生效：进程仍在运行`。
- **`data_governance_restore_with_assets`**：保留旧入口固定错误文案，不执行恢复。
- **`verify_backup_with_assets`**：保留 Rust 原边界根行为（`appDataDir/backups`，而非 `recovery/backups`）。
- **`cloud_config_test_connection_draft`**：`syncProvider` 缺失时返回结构化 `E_CLOUD_CONFIG_INVALID`，不伪造成功；
  loopback/明文传输判定来自 L23 `sync-providers` 的 `isLoopbackHost`（该 lane 已改为引用 `platform/net-policy`）。

## 8. 门禁输出

见最终回复中逐字粘贴的 `migration:ledger -- --check --no-write` 最后一行、
`migration:wiring -- --lane backup` 与 `migration:boundaries:strict` 本 lane 行。

- 类型检查：`node_modules/.bin/tsc --noEmit -p tsconfig.host.json`，全局 jobs 作业 `20261104082023-a2944d`，
  `job.mjs result` 退出码 0。
- 变更相关测试：`acceptance-fixes` 18 passed（作业 `20261104082023-77076d`）、
  `commands-backup-sync` 5 passed（作业 `20261104081923-22cf3b`）、
  `restore` + `zip-integration` 16 passed（作业 `20261104081039-498d8f`），均 exit 0。
- 全量 lane 测试：23 文件 / 368 passed，作业 `20261104082121-fd43b5`，退出码 0。
- `importable.mjs host/plugins/backup/index.ts`：`importable: ok`。
- 本 lane 边界：`npm run migration:boundaries:strict -- host/plugins/backup` 扫描 54 文件，
  0 violation、4 suppressed（均为 `boundary-allow empty-catch`），退出码 0。
- 接线：`migration:wiring -- --lane backup` 输出 `合计 ported 311，其中所测模块未从 index.ts 接入 0（0.0%）`。

本 lane 自身的 `host/**/*.ts` 在 `tsconfig.host.json` 编译选项下通过。2026-11-04 `main` 的
`scripts/electron-migration/accounts.test.ts`（引入于 main `3eda92215`）引用无声明文件的
`./lib/accounts.mjs`，导致仓库级 `npm run typecheck:host` 报 TS7016；该文件不在本 lane 允许写入路径内，
未做修改，待协调者补齐声明或调整 `include`。


## 9. 2026-11-04 新会话续作增量（B02/B03/B09 真实 Storage 回归）

> **分支可见性（更新）**：`0d4a73c61`、`5f02d66bd` 已是 main 祖先（main `eeaf5bdc7`），R4 在 main 上复核。

- 合并 `main`：`aea252eb0`；类型检查 `npx tsc --noEmit -p tsconfig.host.json` 作业
  `20261104085038-3eb101`，退出码 0。
- B02：`tests/acceptance-fixes.test.ts` 的 staging 用例不再替换 `enterMaintenance`，改用真实
  `StorageServiceImpl`；在真实备份快照打开点断言 `storage.database('vfs')` 与备份前已持有句柄写入均抛
  `MAINTENANCE`，备份完成后同一句柄恢复可写。借用已有主库维护的用例继续断言外部 lease 不被提前释放，
  release 失败用例断言同一调用内重试 2 次并保留首次错误。
- B03：6 个 `acquireForJob` 调用点捕获取锁失败，按 Rust `commands_backup.rs:1005-1010` 原文案
  `获取全局备份锁失败: {e}` 落到 `job.fail`；新增真实 `StorageServiceImpl` + `recovery` 锁目录不可创建
  的回归。排队取消用例改用真实 `StorageServiceImpl`，450ms 内 `cancelled("用户取消任务")` 且不提前释放持有者。
- B09：健康检查只读 profile 与真实孤儿外键回归都改用真实 `StorageServiceImpl`；最终 issue 为
  `数据库完整性检查失败: 检测到外键约束违规`，不含 `busy`。
- 变更相关测试：`host/plugins/backup/tests/acceptance-fixes.test.ts` 19 passed，作业
  `20261104085038-86d7ff`，退出码 0，无 Errors 行；D7 5 条 `commands-backup-sync` 经
  `ctx.get('sync')` 消费 L20 公开面，5 passed，作业 `20261104085658-a470af`，退出码 0。
- 全套测试（改动前的树）：作业 `20261104083515-e07598`，`Test Files 1 failed | 22 passed (23)`、
  `Tests 4 failed | 364 passed (368)`、`Duration 882.63s`、退出码 1；4 条均为
  `migration-behavior.test.ts` 的 30s 单测超时（当时集成构建并发，CPU 压力 27.85），无 `Errors` 行，
  非业务断言失败。此前绿色全套证据为作业 `20261104082121-fd43b5`（23 文件 / 368 passed，exit 0），
  但**只属于旧树，不能覆盖本次当前树的 364 passed / 4 timeout / exit 1**。按 C2 2026-11-04T08:26
  指示，本轮不重复跑全套；该失败原文保留，未用 tail 截掉或改写为通过。
- **当前树没有「全目录通过」证据**：`acceptance-fixes` 19 passed（作业 `20261104085038-86d7ff`）与
  `commands-backup-sync` 5 passed（作业 `20261104085658-a470af`）都是变更相关最小集，不是全目录重新通过。

### 交接状态

- 等 R4 对 B02/B03/B09 增量及 B04/B10/B11 的独立复核；本 lane 不自勾 B04/B10/B11。
- 等 L11/L12 发布 `resetRebuildableIndex(targetDir)`（B05 VFS，`BLOCKERS.md` §1.1）。
- 等 F3 提供启动初始化 / Registry 刷新 / 启动就绪等待 / 恢复激活启动钩子（7+1 条 init 测试与
  `finalizeRestoreActivation` 接线）。

### 本轮门禁输出（原样）

```text
$ npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78% B 0.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）

# 本 lane（migration/ledger.json summary.lanes）
L21-backup-governance: commands 33 / cmdA 33（100%）/ cmdB 0 / cmdC 0；
tests 323 / testA 311（96.3%）/ testB 0；pending 12

$ npm run migration:wiring -- --lane backup
合计 ported 311，其中所测模块未从 index.ts 接入 0（0.0%）

$ node scripts/electron-migration/importable.mjs host/plugins/backup/index.ts
importable: ok

$ npm run migration:boundaries:strict
host/plugins/backup/repository/vfs-restore.ts:182:7 [empty-catch]（allowed，理由：回滚失败保留原始错误）
host/plugins/backup/src/assets.ts:326:5 [empty-catch]（allowed，理由：半成品清理失败继续原流程）
host/plugins/backup/src/governance.ts:369:7 [empty-catch]（allowed，理由：关闭 FK 迭代器不得覆盖原始外键诊断）
host/plugins/backup/src/operations.ts:448:9 [empty-catch]（allowed，理由：RAII 释放失败不覆盖主错误）
boundaries: scanned 2277 files, 4 violation(s) {"empty-catch":3,"console-log":1}, 178 suppressed via boundary-allow
# 4 个 violation 均在 host/plugins/vfs（create.ts/folders.ts/resources.ts/update.ts），本 lane 0 violation。
```

- 本 lane 测试：`acceptance-fixes` 19 passed / exit 0（作业 `20261104085038-86d7ff`）。
- 类型检查：`tsc --noEmit -p tsconfig.host.json` exit 0（作业 `20261104085038-3eb101`）。
