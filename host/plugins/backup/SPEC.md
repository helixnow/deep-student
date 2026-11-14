# L21-backup-governance 行为规格（`host/plugins/backup/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 33 个 · 发出事件 4 种 · 契约：`contracts/ipc/L21-backup-governance.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省：可选参数在契约中为 `T | null` 时，`null`/缺省都按 Rust `None` 处理；返回的可选字段按 `x-option` 省略或写 null，与 `skip_serializing_if` 一致。
- [x] u64/i64 超过 2^53 的表示：文件大小/预算/内部 generation 用 bigint 做 checked 运算并保持精确；IPC 返回契约 u64 时按原 Tauri JSON number 输出（超出安全整数时与前端 `JSON.parse` 的精度收敛一致），不额外拒绝 Rust 合法输入（D3）。
- [x] 字段顺序（serde_json preserve_order）：返回对象按契约/生成类型的字段顺序构造，不依赖 HashMap 迭代顺序。
- [x] f32 精度：任务进度用 `Math.fround` 模拟 f32，持久化与事件载荷保持同一精度。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：业务错误统一抛字符串（`CommandError`），稳定码写在 `[E_*]` 前缀；未捕获异常按 kernel 规则不伪装成业务错误。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：备份/导入/导出任务用协作式 `isCancelled()` 检查点；invoke 的 AbortSignal 只停止等待，不取消后台任务。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：`Operations` FIFO 队列对应 `DataGovernanceOperationGuard`；verify 只登记 current_operation，不宣称数据库维护态。
- [x] 时间与 ID：生成方式、格式、时区：时间统一 RFC3339 UTC（`Z`），任务 ID 用 UUID，备份 ID 为 `YYYYMMDD_HHMMSS_<rand8>_<ms>[_suffix]`。
- [x] 不对含 HashMap 的结构做序列化后比对：测试只比较契约字段或排序后的集合，不比较 HashMap 序列化顺序。

### v2 初始化/审计测试的生产证据边界（B06 / X6-AP-0103、0131）

- 不把测试内 `InitializationReport/initializeWithReport` 或策略 if 副本当作生产证据。
  现仅两条报告字段测试与两条策略测试仍缺真实落点，逐 ID 及元数据纠正请求见 BLOCKERS §1.0.1。
  已有 init.rs 七条/Registry 锁一条 pending 不恢复；不新增 skip 或手改生成表。
- 实际入口：使用真实 F4 paths/log/secrets 安装正式 F3 storage 插件，启动编排由该插件执行；
  `migration_tests.rs:1311-1319` / `tests.rs:854` 后初始化测试再查询实际活动目录的生产 pending-count=0。
  测试 helper 只提供依赖/生命周期，不生成报告字段或重写目录、审计、迁移、聚合步骤。
- `critical_audit_tests.rs:1648,1662,1674`：第一次真实 F3 安装成功、写原 VFS resource 夹具、卸载/重装真实 F3、
  从当前实际 storage 读取相同 payload；同时检查活动目录不变，避免读离线旧文件伪证数据保留。
  私有系统目录与新 app 根分离，启动前检查 app 根为空，防止测试日志意外走旧用户数据迁移分支。
- `tests.rs:907,910-920`：正式 F3 AuditLog.complete/save 不抛错后，用真实 F3 句柄调用生产 queryAuditLogs，
  按 Migration + limit10 过滤/解码后长度1；不以仅 COUNT 列值替代原审计查询的成功/反序列化条件。
- 迁移报告 AP-0126 的 await/逐记录循环、审计初始化 AP-0130 的直接失败传播已经对应原断言，
  只记录 EQUIV 审读，不为计数添加无意义 expect；不改变业务或既有测试预算。

## 命令 `cloud_config_test_connection_draft`

<!-- BEGIN GENERATED:cmd:cloud_config_test_connection_draft -->
- Rust：`src-tauri/crates/dstu-sync/src/cloud_config_commands.rs:765` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:496`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：config: SafeCloudStorageConfig__De, credentials: CloudStorageCredentials, encryptionPasswordIsPreexisting?: boolean | null
  - 结果：CloudConfigDraftTestResponse · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:cloud_config_test_connection_draft -->

- [x] 输入：`config: SafeCloudStorageConfig`、`credentials`、`encryptionPasswordIsPreexisting?`；非敏感字段走与保存相同的 `validate_and_normalize`（公网明文传输仅接受 `allow_insecure=true`），secret 只来自本次 IPC。
- [x] 输出：`{ ok: true, generation }`；generation 为当前 active 凭据 generation（只读，pointer 缺失 = 0），不 bump。
- [x] 错误：新设短口令 `E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT`（preexisting=true 放行）；配置校验 `E_CLOUD_CONFIG_INVALID`（平台能力用 `E_FTP_UNSUPPORTED_ON_ANDROID` / `E_S3_UNSUPPORTED_IN_BUILD`）；运行时缺凭据 `E_CLOUD_CREDENTIALS_UNAVAILABLE`；`create_storage` 失败 `E_CLOUD_CONFIG_INVALID`（平台码优先）；试连失败 `E_CLOUD_CONNECTION_CHECK_FAILED`。
- [x] 事件：无。
- [x] DB 读写：零持久化副作用；不读写 SSOT、不写安全存储，只读 active generation pointer。
- [x] 取消/并发：不获取全局操作锁，不写入任何状态。
- [x] 时间/ID：不生成时间或 ID。

## 命令 `data_governance_auto_verify_latest_backup`

<!-- BEGIN GENERATED:cmd:data_governance_auto_verify_latest_backup -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:1494` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:273`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：AutoVerifyResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_auto_verify_latest_backup -->

- [x] 输入：无参数；备份目录不存在返回 `[E_BACKUP_DIR_MISSING]` 专用文案，列表为空返回“没有可用的备份”。
- [x] 输出：`backup_id/is_valid/verified_at/duration_ms/databases_verified/errors`，按 `created_at` 取最新备份（commands_backup.rs:1494-1605）。
- [x] 错误：目录/列表/验证内部错误折叠为 `is_valid=false` 并写入 errors；审计写入 best-effort。
- [x] 事件：无。
- [x] DB 读写：读取备份清单与文件哈希/PRAGMA integrity_check；写 audit.db 审计记录。
- [x] 取消/并发：先获取全局 Verify 锁，再列出/选择最新备份，并持有到验证、审计写入和返回（commands_backup.rs:1512-1605）。
- [x] 时间/ID：`verified_at` 为当前 RFC3339 UTC，`duration_ms` 为验证耗时。
## 命令 `data_governance_backup_and_export_zip`

<!-- BEGIN GENERATED:cmd:data_governance_backup_and_export_zip -->
- Rust：`src-tauri/src/data_governance/commands_zip.rs:221` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:737`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：outputPath: string, compressionLevel?: integer(u32) | null, addToBackupList?: boolean | null, useTiered?: boolean | null, tiers?: string[] | null, includeAssets?: boolean | null, assetTypes?: string[] | null, encryptionPassword?: string | null
  - 结果：BackupJobStartResponse · 错误：string · 注入：app-handle, window, state
<!-- END GENERATED:cmd:data_governance_backup_and_export_zip -->

- [x] 输入：`outputPath` 必填；`compressionLevel` 默认 6、上限 9；`addToBackupList` 默认 true；`useTiered` 默认 false；tiers/includeAssets/assetTypes/encryptionPassword 可选（commands_zip.rs:221-699）。
- [x] 输出：`BackupJobStartResponse`，后台创建备份后导出 ZIP，结果通过任务事件返回。
- [x] 错误：路径校验、密码过短、备份创建/导出失败写入 job.fail；命令本身只返回启动响应。
- [x] 事件：`backup-job-progress`（阶段 scan/compress/verify/cleanup）。
- [x] DB 读写：按 tiers 备份所选数据库（默认全量）与资产，再读取备份目录打包；写审计。
- [x] 取消/并发：获取全局 backup 锁；数据库/资产 staging 期间持有 `BackupSnapshotBarrier`（storage 维护态 + 工作区维护态），释放失败优先于备份结果错误；导出阶段响应协作式取消（commands_zip.rs:427-516）。
- [x] 时间/ID：任务 UUID；备份 ID 自动生成（tiered 带 `_tiered` 后缀）。
## 命令 `data_governance_backup_tiered`

<!-- BEGIN GENERATED:cmd:data_governance_backup_tiered -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:2538` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:707`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：tiers?: string[] | null, includeDatabases?: string[] | null, excludeDatabases?: string[] | null, includeAssets?: boolean | null, maxAssetSize?: integer(u64) | null, assetTypes?: string[] | null
  - 结果：BackupJobStartResponse · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_backup_tiered -->

- [x] 输入：`tiers` 默认 `core`；`includeDatabases`/`excludeDatabases` 覆盖层级；`includeAssets` 默认 false；`maxAssetSize`/`assetTypes` 可选（commands_backup.rs:2538-3040）。
- [x] 输出：`BackupJobStartResponse`，后台执行分层备份。
- [x] 错误：无有效层级、所选数据库缺失/非常规文件、资产备份失败均写入 job.fail。
- [x] 事件：`backup-job-progress`。
- [x] DB 读写：按 core/important 选择 vfs/chat_v2/mistakes/llm_usage，SQLite online backup + 资产复制；写审计。
- [x] 取消/并发：全局 backup 锁；分层 staging 在 `BackupSnapshotBarrier` 内完成，释放失败优先于备份结果错误（commands_backup.rs:2807-2818）。
- [x] 时间/ID：任务 UUID；备份 ID 带 `_tiered` 后缀。
## 命令 `data_governance_cancel_backup`

<!-- BEGIN GENERATED:cmd:data_governance_cancel_backup -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:2249` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:378`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：jobId: string
  - 结果：boolean · 错误：string · 注入：state
<!-- END GENERATED:cmd:data_governance_cancel_backup -->

- [x] 输入：jobId 字符串原样使用（commands_backup.rs:2250）。
- [x] 输出：首次将取消位设为 true 返回 true，不存在或已经请求返回 false（backup_job_manager.rs:901）。
- [x] 错误：无业务 Err 分支。
- [x] 事件：请求取消本身不广播进度。
- [x] DB 读写：仅内存状态。
- [x] 取消/并发：同步设置取消位；不因 invoke 放弃而取消；终态也允许首次请求取消（Rust:901-915）。
- [x] 时间/ID：不生成时间或 ID。

## 命令 `data_governance_check_disk_space_for_restore`

<!-- BEGIN GENERATED:cmd:data_governance_check_disk_space_for_restore -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:1320` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1323`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupId: string
  - 结果：DiskSpaceCheckResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_check_disk_space_for_restore -->

- [x] 输入：`backupId` 经 `validate_backup_id`（trim、URL 解码、长度/路径片段/字符集）校验（commands_backup.rs:1320-1391）。
- [x] 输出：`has_enough_space/available_bytes/required_bytes/backup_size`，预算为备份大小 ×2。
- [x] 错误：备份目录不存在、未找到备份（`未找到备份: <id>`）、大小统计溢出（`E_RESTORE_DISK_BUDGET_OVERFLOW`）、目标槽缺失/不是目录/无法 canonicalize。
- [x] 事件：无。
- [x] DB 读写：只读备份清单；不写数据库。
- [x] 取消/并发：无全局锁（与 Rust 一致）。
- [x] 时间/ID：不生成时间或 ID。
## 命令 `data_governance_cleanup_audit_logs`

<!-- BEGIN GENERATED:cmd:data_governance_cleanup_audit_logs -->
- Rust：`src-tauri/src/data_governance/commands.rs:598` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:155`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：keepRecent?: integer(usize) | null, beforeDays?: integer(u64) | null, confirmationToken: string
  - 结果：integer(u64) · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_cleanup_audit_logs -->

- [x] 输入：`confirmationToken` 必须为 `AUDIT_CLEANUP_{unix_ts}` 且 ±60s；`keepRecent>=100`、`beforeDays>=7`（commands.rs:598-700）。
- [x] 输出：删除的审计记录数（u64）。
- [x] 错误：令牌格式/过期、阈值过低、审计库不可用或删除失败返回字符串。
- [x] 事件：无。
- [x] DB 读写：audit.db 删除旧记录，并写 initiated/completed/failed 审计。
- [x] 取消/并发：无全局锁；同步 SQLite 操作。
- [x] 时间/ID：令牌时间戳与当前时间比较；审计记录使用当前时间。
## 命令 `data_governance_cleanup_persisted_jobs`

<!-- BEGIN GENERATED:cmd:data_governance_cleanup_persisted_jobs -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:2504` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:678`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：string · 注入：state
<!-- END GENERATED:cmd:data_governance_cleanup_persisted_jobs -->

- [x] 输入：无（commands_backup.rs:2505）。
- [x] 输出：成功删除的 completed/cancelled 持久记录数量；不存在文件也算成功（backup_job_manager.rs:1174）。
- [x] 错误：读取目录失败字符串；坏 JSON/单项删除失败记录日志并继续（Rust:1073-1191）。
- [x] 事件：无。
- [x] DB 读写：base/backup_jobs/*.json；不写数据库，不清理失败任务。
- [x] 取消/并发：同步文件步骤，不监听 invoke AbortSignal。
- [x] 时间/ID：无新 ID/时间；读取原持久记录。

## 命令 `data_governance_delete_backup`

<!-- BEGIN GENERATED:cmd:data_governance_delete_backup -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:1271` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:249`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupId: string
  - 结果：boolean · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_delete_backup -->

- [x] 输入：`backupId` 经 `validate_backup_id` 校验；删除前对已存在目标做 canonicalize 越界校验（commands_backup.rs:1271-1307）。
- [x] 输出：成功返回 true。
- [x] 错误：备份目录不存在、备份不存在（`File not found: 备份不存在: <id>`）、路径越界、删除 IO 失败。
- [x] 事件：无。
- [x] DB 读写：删除 recovery/backups/<id> 目录；不写数据库。
- [x] 取消/并发：获取全局 Backup 锁，避免与备份/恢复/ZIP 并发。
- [x] 时间/ID：不生成时间或 ID。
## 命令 `data_governance_export_zip`

<!-- BEGIN GENERATED:cmd:data_governance_export_zip -->
- Rust：`src-tauri/src/data_governance/commands_zip.rs:698` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:781`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupId: string, outputPath?: string | null, compressionLevel?: integer(u32) | null, includeChecksums?: boolean | null, encryptionPassword?: string | null, useStoredCloudEncryptionPassword?: boolean | null
  - 结果：BackupJobStartResponse · 错误：string · 注入：app-handle, window, state
<!-- END GENERATED:cmd:data_governance_export_zip -->

- [x] 输入：`backupId` 校验；`outputPath` 可选；压缩级别默认 6、上限 9；`includeChecksums` 默认 true；显式密码优先，`useStoredCloudEncryptionPassword` 打开时读取安全存储（commands_zip.rs:698-1210）。
- [x] 输出：`BackupJobStartResponse`，后台导出 ZIP。
- [x] 错误：存储密码缺失返回 `[E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED]`，短密码返回 `[E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT]`，备份不存在/导出失败写入 job.fail。
- [x] 事件：`backup-job-progress`。
- [x] DB 读写：读取备份目录生成便携/密封 ZIP；写审计。
- [x] 取消/并发：全局 zip_export 锁；导出取消检查点。
- [x] 时间/ID：任务 UUID；审计记录当前时间。

### v2 取消增量（X6-AP-0090；候选待独立复核）

生产入口：`index.ts` 注册 → `ZipCommands.executeExport`（`src/zip-commands.ts`）→
`exportBackupToZip` / `buildSealedSecretsPayload`（`src/zip.ts`）。本增量只涉及下列取消分支，不统签 ZIP 整体。

| Rust `backup/zip_export.rs` | TS 落点/行为 |
|---|---|
| :1005-1009 `export_cancelled = Io(Interrupted, 用户取消导出)`；:658 Display `IO error: …` | `zipCancelled('导出')`：Error.message 保留完整 Display，code=`EINTR` 对应 Interrupted；不伪造 errno 覆盖自定义消息 |
| :201-202、218-219、319-320 密封构建的扫描/逐文件取消 | `buildSealedSecretsPayload` 原检查点统一抛上述错误 |
| :339-348 内层 ZIP 完成后、不可中断加密窗口前再次检查 | 写入 innerPath 后，在同一 try/finally 内检查；已取消不调用 F4 encrypt，finally 清理内层 ZIP |
| :1095、1175、1230、1344、1394、1415 外层导出检查 | `exportBackupToZip` 原检查点统一同种错误；保持原生成/发布顺序 |

- 入出站字段、密码解码、全局许可范围不变；异常仍由命令现有取消分支转为 cancelled 任务，不添加业务超时。
- 原有临时载荷、输出 ZIP 原子发布和 finally 清理不变；不新增表写入。
- 断言：`tests/zip.test.ts::test_export_cancel_token_set_midway_stops_export` 对应 :3178（进入 compress）、
  :3182-3190（Interrupted）、:3191-3195（Display）、:3196-3198（无输出 ZIP）。
  另有 before-encrypt 测试观测内层 ZIP 已生成后的取消，加密服务调用为零、临时文件清空。
- 证据：修前 20261104153255-c71b78 两例因缺 EINTR 失败；修后定向作业记 LANE。
  ZIP/哈希的主线程阻塞仍待迁移 worker，不以此增量关闭 v2 §1.7 全部问题。

## 命令 `data_governance_get_asset_types`

<!-- BEGIN GENERATED:cmd:data_governance_get_asset_types -->
- Rust：`src-tauri/src/data_governance/commands_asset.rs:79` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1111`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：AssetTypeInfo[]
<!-- END GENERATED:cmd:data_governance_get_asset_types -->

- [x] 输入：无（commands_asset.rs:80）。
- [x] 输出：固定 10 项，按 AssetType::all 顺序；字段 id/name/relative_path/priority（assets.rs:113-219）。
- [x] 错误：非 Result，无错误分支。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步只读，无取消点。
- [x] 时间/ID：固定 snake_case 类型 ID，无时间。

## 命令 `data_governance_get_audit_logs`

<!-- BEGIN GENERATED:cmd:data_governance_get_audit_logs -->
- Rust：`src-tauri/src/data_governance/commands.rs:529` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:129`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：operationType?: string | null, status?: string | null, limit?: integer(usize) | null, offset?: integer(usize) | null
  - 结果：AuditLogPagedResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:data_governance_get_audit_logs -->

- [x] 输入：`operationType`、`status`（Completed/Failed/Partial 等）、`limit` 默认 100、`offset`（commands.rs:529-597）。
- [x] 输出：`logs` 与 `total` 分页响应。
- [x] 错误：先获取审计库连接，再校验 status；无效状态过滤值、审计库连接/查询失败返回字符串（commands.rs:537-554）。
- [x] 事件：无。
- [x] DB 读写：只读 audit.db。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：不生成时间或 ID。

### v2 持久化 AuditOperation 数值边界（X6-UD-0014；候选待复核）

入口仍是 kernel 命令 → `Governance.getAuditLogs` → 生产仓储 query/rowToAuditLog。
Rust `dstu-storage/audit/mod.rs:43-90,790-793` 对 operation_data 直接做 typed serde，而不是先转换成 JS number。

| Rust 字段/接收规则 | TS 实现与证据 |
|---|---|
| Migration from_version/to_version: u32 | F4 JsonReader 保留词法类型和整数，先 bigint 检查0..2^32-1，再转安全number |
| applied_count/file_count/records_affected: usize；Backup total_size: u64 | 64位桌面按0..2^64-1精确检查，安全范围外保留bigint，不接受1.0/1e0/-0或溢出 |
| BackupType/SyncDirection单元枚举 | 接收字符串或Serde单键null map，拒绝非unit载荷；输出仍为原枚举字符串 |
| 必填、已知字段重复、未知字段 | 缺字段/已知重复报错；未知字段忽略，重复未知key不被无故拒绝 |
| save的JSON整数表示（audit/mod.rs:operation_data序列化） | JSON.rawJSON仅用于bigint十进制数字，精确落盘、不加引号或先Number；三操作最大u64保存读回仍原数字 |

- summary IPC仅返回原operation_type等字段，不新增BigInt字段或更严格拒绝Rust合法u64。
  数据库连接/status校验优先级、错误外层 `查询审计日志失败: Serialization error:` 保留；状态未知回退Started与Rust:840-846一致，无需改动。
- tests/audit-decode 使用完整真实StorageServiceImpl，经公开kernel入口验证；合法最大值再经生产query/save验证内部精度和数字字面量。
  原普通值/纳秒时间回归和实际F3迁移审计生产者读回测试均保留。旧自加错误措辞改为serde visitor诊断，不放宽拒绝条件。
- 修前 20261104220456-95acab 新10例全失败；修后Node/Electron各24例与typecheck通过（作业见LANE）。
- 本增量不签收完整serde差分：复杂多错输入的错误优先级/位置、任意details Value、SQLite duration宽整数、
  上游已有Number转换的字节统计仍需另核，不能把此窄codec修复写成D3整组完成。

### v2 SQLite 审计行时长/列转换（自查 L21-D3-AUDIT-ROW；候选待复核）

生产路径为 `index.ts` 命令 → `Governance.getAuditLogs` → `queryPagedAuditLogs/queryAuditLogs` →
`rowToAuditLog` → `toAuditLogResponse`；复用 F3 `defineQuery(... safeIntegers: true)`，不新造数据库读取层。

| Rust 分支（dstu-storage/audit/mod.rs） | TS 落点与可观察行为 |
|---|---|
| :768-773 按列 0..5 读取 String，包括未用于输出的 operation_type | `sqlString` 按原列序读取；列2 BLOB 错误先于列6负时长，不跳过 operation_type |
| :774 `Option<u64>`：NULL / 非负INTEGER | `sqlDuration` 保持 null；安全整数为number，宽整数bigint；query→save→safeIntegers回读 i64::MAX 低位不变 |
| :774 负INTEGER / 非INTEGER物理类型 | 拒绝负值，保留 `Integer -1 out of range at index 6`；REAL/TEXT/BLOB 用 rusqlite0.40.1 `Invalid column type ... at index: 6, name: duration_ms`，不先 Number/round |
| :775-776 details/error_message 的 Option<String> | `optionalSqlString` 在时长之后、timestamp/operation解析之前做列类型转换 |
| :778-804 SQL列转换完成后解析timestamp与operation | 原时间/JSON解析保持；新多错用例证明负时长优先于损坏时间/JSON |
| :352-359 row.get错误进入 AuditError::Database | 行转换错误保留 `Database error:`，命令外层仍为 `查询审计日志失败:` |
| commands_types.rs AuditLogResponse::from，D3线上边界 | 只在 `toAuditLogResponse` 将非null时长转number；响应形状/字段不变，合法宽时长仍接收 |

- `__audit_log` 为本插件审计仓储表；查询只读，save保留既有更新/插入逻辑与精确SqlValue绑定。未新增日志、锁、时钟、取消或异步边界。
- 已审读真实生产者：备份/ZIP `Math.trunc`、恢复 `Math.round`、清理 `0`、L20同步结果 `Math.floor`，均产生整数毫秒；本增量不替坏SQL值或调用者做舍入。
- 新增8个实际 kernel/F3 SQLite 用例，修前 `20261104230230-ec563f` 为7失败/NULL控制1通过；未删改既有断言或预算。
  修后Node/Electron各34通过，含原审计解码、真实迁移审计save/query、同步save及切槽后失败审计关闭Started行回归（回执见LANE）。
- 证据等级为生产入口回归+Rust/rusqlite逐分支审读，非Rust执行差分或独立签收；本节只关闭上节列出的SQLite duration候选缺口，
  不外推任意details JSON、复杂serde多错优先级/位置或上游字节数生产精度已全部对齐。

### v2 details JSON整数与坏值降级（自查 L21-D3-AUDIT-DETAILS；桌面特性纠正后阻塞）

**撤回64ebae82d对1e999的错误预期及其完成推论**：桌面Cargo图中的dstu-agent/vfs/notes/sync/media等显式启用serde_json arbitrary_precision，
`AuditLog.details: Value`及:799-804推导的from_str::<Value>不是独立dstu-storage默认typed数字路径。合法超f64 Value必须保留raw，不能降null/Infinity。
F4已发布候选 `fd920f955` / 合同 `5106246c9` 的JsonValueNumber.arbitrary、jsonNumberToRawJSON及stringifyJsonValue出口；当前main尚未包含。
等待正常同树后以正式数字投影替换当前未规范化raw候选；1e999应重存为数字1e+999，原子只用于同runtime持久化，不structuredClone/IPC。
新增两个合法超f64/高精度Value正例的完成状态pending不授权禁用测试；已按C2要求恢复普通it.each（保原输入/not.toBeNull/精确token断言），
当前Node/Electron各2失败/4回退及typed控制通过/exit1，真实红灯保留待正式四owner同树验证，不使用skip/fails、功能探测或复制lexer让旧parser变绿。

| Rust（dstu-storage/audit/mod.rs） | TS生产落点/证据 |
|---|---|
| :799-804 非空details文本解析为任意serde_json::Value，坏JSON降Null | `rowToAuditLog`复用正式F4 `parseJsonDocument`；原best-effort catch仍返回null，不让坏details导致整条查询失败 |
| Value可含嵌套/数组/root任意合法JSON数字 | 私有映射候选对u64/i64保留安全number或bigint；其余待正常main消费F4 jsonNumberToRawJSON，保raw/规范化且不先Number；桌面同树验证仍pending |
| Value对象重复key last-wins，无AuditOperation的字段限制 | 对象/数组/普通scalar原语保留，重复对象键取最后值；不复用操作schema而拒绝任意详情字段 |
| :231 save重新序列化details Value | operation/details共享既有JSON.rawJSON bigint replacer，宽整数仍是原JSON数字，不加引号/先舍入；job_id相关逻辑保持 |
| 桌面arbitrary_precision Value接收1e999；真正坏JSON/空文本/SQL NULL降Null | 纠正误把typed有限性拒绝外推Value的断言；合法1e999列入精确重存正例，不能以当前main旧parser拒绝作为Rust证据 |

- 真实kernel查询仍返回原分页summary，不新增details字段或公开BigInt字段；内部精度和写回由同一真实F3 SQLite上的生产query/save回环验证。
  原8例修前4失败/4控制通过（`20261105004230-450820` exit1）及旧树42绿回执保留为历史；含错误1e999预期，不能作为桌面Value签收。
- 仅改自有审计仓储，未新增SQL表、锁、超时、fallback开关/通用解析框架，未改旧断言或预算。
  `AuditOperation.uint`改用F4 typed readNumber，避免Value新增arbitrary联合无.value的编译缺口；typed整数仍拒绝超范围数，不混淆Value合法性。
  新typed字段回归仅验证拒绝/Serialization错误合同，不把typed reader自身的范围诊断当作整个internally-tagged enum的Rust诊断；精确错误路径仍待桌面特性差分。
  本候选未签收桌面arbitrary_precision完整投影/重存或数值形对象键顺序，也不统签整个D3；缺口与原F4 tsc反例见BLOCKERS。

## 命令 `data_governance_get_backup_job`

<!-- BEGIN GENERATED:cmd:data_governance_get_backup_job -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:2281` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:390`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：jobId: string
  - 结果：BackupJobSummary | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:data_governance_get_backup_job -->

- [x] 输入：jobId 原样查询（commands_backup.rs:2282）。
- [x] 输出：缺失为 null；summary 可选时间/result 缺省，message 为 null；progress clamp 0..100；failed 且有 checkpoint 才 resumable（backup_job_manager.rs:488）。
- [x] 错误：无业务 Err。
- [x] 事件：查询不发事件。
- [x] DB 读写：只读共享任务内存。
- [x] 取消/并发：同步快照，不监听 AbortSignal。
- [x] 时间/ID：原 UUID v4 和 UTC RFC3339 时间。

## 命令 `data_governance_get_backup_list`

<!-- BEGIN GENERATED:cmd:data_governance_get_backup_list -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:1193` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:241`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：BackupInfoResponse[] · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_get_backup_list -->

- [x] 输入：无参数；备份目录不存在返回空数组（commands_backup.rs:1194-1259）。
- [x] 输出：按 `created_at` 降序的 `path/created_at/size/backup_type/recovery_kind/restorable/databases`。
- [x] 错误：清单解析/大小统计溢出返回字符串。
- [x] 事件：无。
- [x] DB 读写：只读 recovery/backups 下的 manifest.json。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：使用清单内 `created_at`。
## 命令 `data_governance_get_database_status`

<!-- BEGIN GENERATED:cmd:data_governance_get_database_status -->
- Rust：`src-tauri/src/data_governance/commands.rs:1005` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:98`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：databaseId: string
  - 结果：DatabaseDetailResponse | null · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_get_database_status -->

- [x] 输入：`databaseId` 必须为 vfs/chat_v2/mistakes/llm_usage（commands.rs:820-900）。
- [x] 输出：数据库详情或 null；含 schema 版本、兼容范围、数据契约、checksum、迁移历史、依赖。
- [x] 错误：未知数据库 ID、SchemaRegistry 刷新失败。
- [x] 事件：无。
- [x] DB 读写：打开活动槽数据库读取 refinery_schema_history。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：`updated_at` 为本次聚合时间。
## 命令 `data_governance_get_maintenance_status`

<!-- BEGIN GENERATED:cmd:data_governance_get_maintenance_status -->
- Rust：`src-tauri/src/data_governance/commands.rs:430` · async
- 前端：app（2 处，例 `src/api/dataGovernance.ts:61`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：MaintenanceStatusResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_get_maintenance_status -->

- [x] 输入：无。
- [x] 输出：`is_in_maintenance_mode/blocked_components/current_operation/component_health/component_issues`。
- [x] 错误：启动等待 120s 超时返回 `应用启动初始化超时（120 秒），请重启应用`（B02 候选，待 R4）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：先消费 F2 startupGate 等待就绪，再读取 `Operations` 当前操作与阻塞组件；`blocked_components` 来自 `storage.enterMaintenance` 的 lease，`component_health/component_issues` 仍沿原读取路径（独立启动维护态公共面另跟进，不能据此签收 B02 整组）。
- [x] 时间/ID：`current_operation.started_at` 为操作开始时间。

### B02 v2 启动就绪等待增量（候选待 R4）

生产入口：`index.ts` 的命令注册处理器，先按需取得正式 F2 `startupGate`，再调用原 `Governance.getMaintenanceStatus`。

| Rust | TS 分支与错误顺序 |
|---|---|
| `dstu-platform/startup_gate.rs:24` 固定 120s | `STARTUP_READY_WAIT_MS=120000`，不改通用 IPC 或测试预算 |
| `commands.rs:434` 等待 setup 完成 | `await gate.waitStartupReady(...)`；之前不读取/返回维护快照 |
| `commands.rs:435-439` 超时 Err(String) | `CommandError` 携带精确原文，kernel 业务错误通道拒绝 Promise |
| `commands.rs:440` 起的维护快照读取 | 仅在 gate 返回 true 后调用现有 getter；响应字段、当前操作、租约所有权均不变 |

- profile 缺 startupGate 时显式报未安装，不伪造 ready 或健康状态；不硬注入形成启动依赖环。
- 无新入参、持久化结构、表写入、事件、取消点或资源所有权；计时和 waiter 清理由正式 F2 gate 提供。
- `tests/startup-readiness.test.ts` 经 kernel 与真实 `createStartupGate` 测待就绪/已就绪/120s 超时三分支；
  超时只用 fake timers 推进真实 F2 timer，不替换被测 gate，也不等待现实两分钟或增大用例预算。
- 修前两例提前返回失败：20261104173831-5ab4cf exit1；修后与相关 B02 维护回归合计 12 例通过：20261104174214-03aa90 exit0。
  finalizer 注册与独立启动维护态读取不属于本增量签收范围。

## 命令 `data_governance_get_migration_diagnostic_report`

<!-- BEGIN GENERATED:cmd:data_governance_get_migration_diagnostic_report -->
- Rust：`src-tauri/src/data_governance/commands.rs:1060` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1351`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：string · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_get_migration_diagnostic_report -->

- [x] 输入：无。
- [x] 输出：多段诊断字符串（数据库状态、错误、审计失败记录、Slot C/D 测试、迁移历史、磁盘、数据目录）。
- [x] 错误：SchemaRegistry 刷新失败直接抛出；Slot C/D 内部错误写入报告。
- [x] 事件：无。
- [x] DB 读写：读取全部数据库与 audit.db；Slot C/D 在 slots/slotC|slotD 创建临时库并执行迁移后清理。
- [x] 取消/并发：无全局锁；Slot C/D 串行执行。
- [x] 时间/ID：报告时间与各阶段耗时。

### v2 迁移 worker 增量（共享于 Slot C、Slot D、恢复候选槽）

正式依赖：main `80dcc5291` 及后继 `storage/api.ts::createMigrationWorker`。
每个 `Governance` 插件实例建两个长期 runner（都在首次使用时才起线程）：一个供恢复候选槽和 Slot C，一个只供 Slot D。
卸载先等待两条测试槽生命周期队列，再关闭两个 runner；
F3 负责完整 `MigrationCoordinator.runAll`、线程连接清理、startup backup guard 合并及错误/日志跨线程传递。

| Rust 生产步骤 | TS 生产落点 |
|---|---|
| `commands.rs:225-265` 清空 slotC → 四库迁移 → 报告 → 清空重建 | `runSlotCTest` → slotC 生命周期队列 → `executeSlotCTest` → `runMigrations(dir, null)` |
| `commands.rs:271-376` 在线备份到 slotD → copy error 或迁移 → 报告/清理 | `runSlotDTest` → slotD 生命周期队列 → `executeSlotDTest`，复制仍用真实 `backupTo`，迁移调用 `runMigrations(dir, null)`（按目录落到 Slot D 的 runner） |
| `commands.rs:1199-1217` 诊断报告依次嵌入 C/D 结果 | `getMigrationDiagnosticReport` 同时启动原 C/D 生产方法，两者都结束后按 C、D 顺序写入；C 的异常优先（RF-W08-diagnostic-slots-concurrent，proposed） |
| `commands_restore.rs:1108` 候选槽初始化迁移并检查报告 | `initializeCandidateSlot(governance, inactiveDir)` → 同一 `runMigrations`；auditDbPath 省略，保持默认候选槽审计 |

- Slot C/D 的 auditDbPath 为 null；恢复迁移不关闭审计。migrationsDir 使用原默认常量；不传 logTarget，迁移日志沿用协调器默认 target `dstu_storage::migration::coordinator`（`tests/migration-log-target.test.ts`）。
- 仅根据 report.databases/totalDurationMs 生成原文本；恢复检查 success/error，不序列化内部 threadId/组件对象。
  跨线程错误只按公开 message 等字段映射原文，不依赖 MigrationError instanceof。
- 不复制算法，不加业务超时，不把前端 AbortSignal 传给已运行迁移，不把 runner 注册成会被自身维护许可 pause 的参与者。
  恢复仍持原全局 restore guard；同一槽的 sandbox 目录 reset/copy/migrate/cleanup 整体排队，不能在前次 worker 返回前清目录。
- `tests/slot-tests.test.ts` 经真实 kernel 命令、正式 F3 runner 断言报告/清理、worker 日志到父 Host、并发 slotC 不互删；
  两目标命令的心跳仅在实际迁移日志出现后计数，并记录耗时，不以模块加载/线程启动的空档伪证响应性。
  `restore.test.ts` 的完整候选槽恢复与外部维护所有者用例覆盖第三处迁移调用。证据见 LANE。
- 本增量不声称 X1 总时长已满足预算；未更改 X1 断言/预算或两个 main-red 测试的原默认 30s。

### WP-005：5 秒预算的阶段归属（2026-11-05）

- 原 X1 job `20261105112439-a10c89` 的 Node 产物
  `/tmp/opencode/x1-smoke-m6EYCy/node/result.json:17806-17815`：本命令 5001ms timeout。
  同次 `local/data/logs/deep-student.log:55-204` 保留真实 Slot C 开始/逐库/结束日志：
  19:25:55 开始，19:26:05 完成，coordinator 自报 **10316ms**；VFS 71、LLM 8、Chat 29、Mistakes 23 个迁移均实际执行。
  日志墙钟仅秒精度，VFS 约5秒不能冒充精确子阶段计时；10316ms 是该次 coordinator 的实测总时长。
- Rust `commands.rs:1199-1217` 必须依次生成 C/D 两份结果；`:237-239` 空库完整 `run_all`，
  `:283-340` 在线克隆后再次完整 `run_all`。F3 Rust `migration/coordinator.rs:282-428` 包含磁盘检查、
  故障恢复、备份保护、依赖顺序迁移/验证与失败恢复。不能通过复用已迁移槽或跳过验证来加速。
  C/D 并发（两槽目录互不相干，报告文本不变）按 deliberate 登记为 RF-W08-diagnostic-slots-concurrent（第 10 轮）。
- 当前 L21 `Governance.runMigrations` 已调用正式 `storage/api.ts::createMigrationWorker`，
  F3 `migration/worker-tasks.ts:11-24` 创建协调器并运行原算法；不再把旧同步迁移调用描述为未接 worker。
- `tests/migration-diagnostic.test.ts` 经真实 kernel + 完整 F3 storage；先以独立 worker 构造当前版本活动库，
  保持诊断 worker 冷启动。计时透传原 C/D 与 runMigrations，记录实际报告/逐库时长、日志、Host 心跳；
  保留完整文本各段、持久错误、历史、C/D 清理与顺序断言，最后仍按 **5000ms** 判断，失败也保留阶段证据。
  这不是 Rust 运行时差分，不能从 TS 时长推出 Rust 在该机器的实际时长。

## 命令 `data_governance_get_migration_status`

<!-- BEGIN GENERATED:cmd:data_governance_get_migration_status -->
- Rust：`src-tauri/src/data_governance/commands.rs:738` · sync
- 前端：app（2 处，例 `src/api/dataGovernance.ts:86`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：MigrationStatusResponse · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_get_migration_status -->

- [x] 输入：无。
- [x] 输出：`global_version/all_healthy/databases/pending_migrations_total/has_pending_migrations/last_error`（commands.rs:739-820）。
- [x] 错误：SchemaRegistry 刷新失败。
- [x] 事件：无。
- [x] DB 读写：读取 refinery_schema_history；pending>0 时读取 `.last_migration_error`。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：`updated_at` 为聚合时间，last_error 保留持久化时间戳。
## 命令 `data_governance_get_schema_registry`

<!-- BEGIN GENERATED:cmd:data_governance_get_schema_registry -->
- Rust：`src-tauri/src/data_governance/commands.rs:499` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:78`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：SchemaRegistryResponse · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_get_schema_registry -->

- [x] 输入：无。
- [x] 输出：`global_version/aggregated_at/databases[]`（id、schema/min/max、数据契约、迁移数、checksum、updated_at）。
- [x] 错误：SchemaRegistry 刷新失败。
- [x] 事件：无。
- [x] DB 读写：只读各活动数据库的 refinery_schema_history。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：`aggregated_at` 为当前 RFC3339 UTC。

### v2 Registry 迁移回归真实性（B06 / X6-AP-0116、0127）

被测生产路径：命令 → `Governance.refreshSchemaRegistry` →
`repository/schema-registry.ts::aggregateSchemaRegistry(activeDir, opener, toRfc3339)`。
`migrations-metadata.test.ts` 原来的 latestOpener 固定返回最新版本，并未读取实际库；现已删除该 opener、空文件占位和无校验 SqlExecutor 强转。

| 原 Rust 测试步骤/断言 | TS 证据落点 |
|---|---|
| `migration_tests.rs:1153-1157` / `tests.rs:701-707` 先迁移再聚合 | 正式 F3 `createMigrationWorker.runAll` 真实迁移四库，再用真实 F3 openFile/close 读取上述生产聚合函数；不返回伪造历史行 |
| `migration_tests.rs:1160-1168` / `tests.rs:710-717` 四个库、正全局版本 | 两聚合用例均断言 size=4、global_version>0 |
| `migration_tests.rs:1172-1192` 状态存在、正版本、匹配正式迁移集合最新版本 | 固定 Rust 四库输入逐项断言，期望取正式 F3 集合；保留原 L21 消费版本表的精确断言以检测漂移 |
| `tests.rs:721-729` 状态存在且 schema_version>0 | tests.rs 对应聚合用例逐项保留，原 TS 的最新版本断言不放宽 |
| `migration_tests.rs:1203` 起 / `tests.rs:741-755` 真实迁移/聚合后依赖通过 | 两依赖检查用例不再用 fake latest 夹具，而消费实际 SQLite 历史聚合结果 |

- 所有临时目录独占；先 await F3 close/drain，再关闭聚合句柄服务、删除目录，不在 worker 运行时重置目标。
- 使用生产的 `toRfc3339` 回调，不给生产函数增加假默认参数；原预算、用例名称、TESTMAP 状态不变。
- 这只纠正迁移/聚合测试的数据来源与原断言，不替代尚 pending 的启动初始化/Registry poison 公共面，不签收 B06 整组。

## 命令 `data_governance_import_zip`

<!-- BEGIN GENERATED:cmd:data_governance_import_zip -->
- Rust：`src-tauri/src/data_governance/commands_zip.rs:1209` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:811`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：zipPath: string, backupId?: string | null, password?: string | null, useStoredCloudEncryptionPassword?: boolean | null
  - 结果：BackupJobStartResponse · 错误：string · 注入：app-handle, window, state
<!-- END GENERATED:cmd:data_governance_import_zip -->

- [x] 输入：`zipPath` 必填；`backupId` 可选并校验；`password` 可选；`useStoredCloudEncryptionPassword` 仅在密封 ZIP 时生效（commands_zip.rs:1210-1700）。
- [x] 输出：`BackupJobStartResponse`，后台解压并验证。
- [x] 错误：ZIP 不存在、备份已存在、密封包缺密码 `[E_BACKUP_SEALED_PASSWORD_REQUIRED]`、解密失败 `[E_BACKUP_SEALED_DECRYPT_FAILED]`、便携包带密码拒绝；失败写入 job.fail 并清理非续传目标。
- [x] 事件：`backup-job-progress`。
- [x] DB 读写：解压到 recovery/backups/<id>，校验 manifest/checksums/资产；写审计。
- [x] 取消/并发：全局 zip_import 锁；解压阶段协作式取消。
- [x] 时间/ID：任务 UUID；未指定 backupId 时生成 `YYYYMMDD_HHMMSS_<rand8>_<ms>_imported`。

### v2 取消增量（X6-AP-0091；候选待独立复核）

生产入口：`ZipCommands.executeImport` / `resumeImportJob` → `importBackupFromZip`。
Rust `zip_export.rs:2058-2062,2087-2092,2102-2107,2211-2215` 的四处取消均对应 TS 的
scan 起点、scan 验证后、逐条目解压前、verify 起点；统一 `zipCancelled('导入')` 返回 EINTR 与 `IO error: 用户取消导入`。

- 首个 Extract 进度回调置取消标志后，本条目按 Rust 完整落盘；下一条目的检查点终止。
  不在单文件写入中间添加取消，避免留下截断文件；保留 `writeAtomically` 的临时文件清理。
- `tests/zip.test.ts::test_import_cancel_midway_extract_leaves_no_partial_files` 逐项对应
  :3468（至少两个归档文件）、:3319-3331（取消错误）、:3495/3499（落盘文件非空且未写完）、
  :3505（无 `.tmp` 前缀临时文件）、:3513（每个落盘文件与归档条目大小一致）。原 TS 的 `.tmp` 后缀检查也保留。
  不再用 `if (existsSync(target))` 让空目录/未创建目录场景空通过。
- 目录清理、续传语义、事件、锁、解密前检与数据边界均沿原生产路径；只修正取消错误类型和 Display。

## 命令 `data_governance_list_backup_jobs`

<!-- BEGIN GENERATED:cmd:data_governance_list_backup_jobs -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:2299` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:399`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：BackupJobSummary[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:data_governance_list_backup_jobs -->

- [x] 输入：无（commands_backup.rs:2300）。
- [x] 输出：所有内存任务摘要；Rust DashMap 顺序无保证，不添加排序（backup_job_manager.rs:917）。
- [x] 错误：无业务 Err。
- [x] 事件：无。
- [x] DB 读写：只读任务内存。
- [x] 取消/并发：同步快照，不监听 AbortSignal。
- [x] 时间/ID：沿用任务创建时间及 UUID v4。

## 命令 `data_governance_list_resumable_jobs`

<!-- BEGIN GENERATED:cmd:data_governance_list_resumable_jobs -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:2355` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:662`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：ResumableJobResponse[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:data_governance_list_resumable_jobs -->

- [x] 输入：无参数；读取 `backup_jobs/*.json`，仅返回 `status=failed` 且带 checkpoint 的任务（backup_job_manager.rs:960）。
- [x] 输出：`PersistedJob` 字段加 `requires_password`；仅 `kind=import` 且 ZIP 含 `portable_secrets.dsbk` 时为 true，探测失败记录 warn 并按 false 继续。
- [x] 错误：单个损坏任务文件跳过并记录 warn；目录不可读时返回 IO 错误文案。
- [x] 事件：无。
- [x] DB 读写：只读 `backup_jobs/*.json`；不解密，仅检查 ZIP 是否含 `portable_secrets.dsbk`。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：不生成时间或 ID。
## 命令 `data_governance_purge_all_data`

<!-- BEGIN GENERATED:cmd:data_governance_purge_all_data -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:3047` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1657`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：string · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_purge_all_data -->

- [x] 输入：无。
- [x] 输出：Rust 写标记后 `app.restart()` 不返回；Host 写标记并请求 `process:restart`，若进程仍存活则抛“应用重启未生效”。
- [x] 错误：写入 `.purge_on_next_start` 失败返回“写入清理标记失败: ...”。
- [x] 事件：无。
- [x] DB 读写：不直接删除数据库；由下次启动的 startup_cleanup 执行。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：不生成时间或 ID。
## 命令 `data_governance_restore_backup`

<!-- BEGIN GENERATED:cmd:data_governance_restore_backup -->
- Rust：`src-tauri/src/data_governance/commands_restore.rs:420` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:291`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupId: string, restoreAssets?: boolean | null
  - 结果：BackupJobStartResponse · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_restore_backup -->

- [x] 输入：`backupId` 校验；`restoreAssets` 可选（false 在完整快照路径被拒绝）（commands_restore.rs:421-780）。
- [x] 输出：`BackupJobStartResponse`，后台恢复任务。
- [x] 错误：备份不存在、非完整快照 `[E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE]`、校验和/完整性失败、磁盘预算溢出、A/B 管理器不可用 `[E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE]`。
- [x] 事件：`backup-job-progress`。
- [x] DB 读写：校验清单/文件，恢复候选槽；索引/同步基线经正式 owner，迁移经 F3 worker，原子密钥/切槽登记及激活 marker 沿原生产链。缺能力时 fail-closed，不能再把已发布 A/B cutover 记作提供方未发布。
- [x] 取消/并发：全局 restore 锁；验证/替换阶段取消检查点。
- [x] 时间/ID：任务 UUID；审计当前时间。

### v2 旧增量包的生产入口拒绝证据（AP-0101）

- Rust critical_audit_tests.rs:899-917 的真实changes文件/重算hash/size由测试按实际内容构造并落盘；原validator增量/英文拒绝断言全部保留。
- kernel `data_governance_restore_backup` → `RestoreCommands.restoreBackup/executeRestore` → `findBackup/loadManifest` →
  `checkManifestCompatibility` 的is_incremental拒绝分支 → 生产 `Jobs.markFailure`，检查失败终态与 `result.success=false`、精确 `result.error`。
  后者保持现有 `备份版本不兼容: ` 上下文；不能在顶层job.error断言一个不存在的字段（Rust BackupJobSummary.result/ResultPayload.error）。
- 证据是原生产string/job结果合同上的增量拒绝，不添加仅供测试的BackupError类或伪owner，也不外推完整恢复成功/切槽安全。
  只改变fixture与增量断言，未改原30s预算；候选提交/初轮误用字段的失败日志及修后Node/Electron作业见LANE。

### D2 恢复激活 finalizer 注册增量（候选待独立复核）

| Rust 启动/恢复步骤 | TS 生产落点 |
|---|---|
| `lib.rs:1169-1173` 初始化/迁移完成后调用恢复激活收尾，返回 false 则无操作 | `index.ts` 的 apply 最后注册 `backup.restore-activation`，回调委托现有 `finalizeRestoreActivation`；F1/F3 在业务插件全部可用后执行 |
| `commands_restore.rs::finalize_restore_activation` 读取激活 marker 与租约 | 回调在执行时取得 `ctx.storage.locations.activeDir`，复用原解码/检查，不捕获注册时的旧槽路径 |
| 设备身份与同步游标轮换 | 按需调用 F4 paths 与 L20 syncSupport 的正式方法，不硬注入形成启动环、不复制同步状态 SQL |
| 标记激活提交、删除 marker、解除租约 | 复用 F3 DataSpaceManager 入口；回调不标记 startup ready，成功后的 ready 由组合根负责 |
| `lib.rs:1174-1190` 恢复失败启动政策 | 回调不吞错，交 F3 StartupFinalizerRegistry 包装并向组合根传播；当前 F1 fatal 与 Rust 降级维护/事件分支的差异另列 BLOCKERS，未签收整链 |

- 无新的 IPC/持久化字段、SQL、迁移算法或超时；注册 API 缺失/失败时不降级为本地直接执行。
- `startup-finalizer.test.ts` 通过真实 F3 `runStartupFinalizers` 执行插件已注册回调，而非测试直接调用 helper：
  新启动无 marker 不轮换；坏 marker 保留且 gate 未 ready；真实切槽后用 F4 身份持久化、L20 状态 owner、F3 租约收尾，成功重跑不重复设备轮换。
  成功场景依赖的 L11/notes/syncSupport 均安装正式插件，没有本地 reset SQL 或伪轮换实现。
- 旧 SQL/路径单元 fixture 补正式 F3 StartupFinalizerRegistry（非 no-op），只为满足真实注册 API；
  核心 finalizer 测试仍使用完整 StorageServiceImpl，不以旧 fixture 证明维护/启动行为。
- 注册基线 `20261104182440-d41f5c` 三例失败（未注册/不消费 marker），修后作业见 LANE。

## 命令 `data_governance_restore_with_assets`

<!-- BEGIN GENERATED:cmd:data_governance_restore_with_assets -->
- Rust：`src-tauri/src/data_governance/commands_asset.rs:116` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1136`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupId: string, restoreAssets?: boolean | null
  - 结果：RestoreResultResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_restore_with_assets -->

- [x] 输入：契约 backupId/restoreAssets；Rust 不使用参数（commands_asset.rs:117-125）。
- [x] 输出：无成功分支。
- [x] 错误：固定字符串“该旧恢复入口已停用，因为它无法保证完整快照校验和原子槽切换。请调用 data_governance_restore_backup。”。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：立即拒绝，无任务启动。
- [x] 时间/ID：无。

## 命令 `data_governance_resume_backup_job`

<!-- BEGIN GENERATED:cmd:data_governance_resume_backup_job -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:2395` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:601`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：jobId: string, password?: string | null
  - 结果：BackupJobStartResponse · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_resume_backup_job -->

- [x] 输入：`jobId` 与可选 `password`；仅 failed 且有 checkpoint 的任务可恢复（commands_backup.rs:2355-2500）。
- [x] 输出：`BackupJobStartResponse`，复用原 job_id。
- [x] 错误：任务不存在、状态非 failed、无 checkpoint、ZIP 缺失、密封包密码错误。
- [x] 事件：`backup-job-progress`。
- [x] DB 读写：导入任务从 checkpoint 继续解压；导出任务用原参数重新执行。
- [x] 取消/并发：恢复后的任务重新获取对应全局锁。
- [x] 时间/ID：复用原任务 ID；进度时间按恢复时刻更新。
## 命令 `data_governance_run_backup`

<!-- BEGIN GENERATED:cmd:data_governance_run_backup -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:1737` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:229`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupType?: string | null, baseVersion?: string | null, includeAssets?: boolean | null, assetTypes?: string[] | null
  - 结果：BackupJobStartResponse · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_run_backup -->

- [x] 输入：`backupType` 默认 full；incremental 返回已移除英文文案；`includeAssets` 默认 true；`assetTypes` 可选（commands_backup.rs:1600-1900）。
- [x] 输出：`BackupJobStartResponse`，后台全量备份。
- [x] 错误：incremental 已移除；includeAssets=true 时备份后必须通过 `validateForSlotRestore`，否则任务失败；屏障进入/释放失败优先；其余备份创建/校验失败写入 job.fail（commands_backup.rs:2039-2046）。
- [x] 事件：`backup-job-progress`。
- [x] DB 读写：四个数据库 SQLite online backup + 工作区/持久域/资产；写审计。
- [x] 取消/并发：全局 backup 锁；checkpoint 阶段取消检查；数据库/资产 staging 在 `BackupSnapshotBarrier` 内完成，释放失败优先于备份结果错误（commands_backup.rs:2003-2024）。
- [x] 时间/ID：任务 UUID；备份 ID 自动生成。

### v2 增量创建的无产物/错误合同证据（AP-0100）

- 对照Rust critical_audit_tests.rs:848先创建base目录；公开run_backup带incremental与baseVersion，调用前后目录列表相等的原断言保留。
- Rust BackupError::IncrementalBackupRemoved的Display为原canonical常量（backup/mod.rs:1862-1863），Host命令合同为string；
  同一个Promise既保留原拒绝文本断言，也新增精确string值断言，避免HandlerPanic对象被toThrow文本匹配误当正常业务错误。
- 真实生产链为kernel→stringErrorCommand→BackupCommands.runBackup的立即增量拒绝，未创建job或调用备份算法；不引入新错误类/协议tag。
  原既有expect和预算不变；候选与Node/Electron最小回归见LANE。

## 命令 `data_governance_run_health_check`

<!-- BEGIN GENERATED:cmd:data_governance_run_health_check -->
- Rust：`src-tauri/src/data_governance/commands.rs:822` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:111`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：HealthCheckResponse · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:data_governance_run_health_check -->

- [x] 输入：无。
- [x] 输出：`overall_healthy/total_databases/initialized_count/uninitialized_count/dependency_check_passed/dependency_error/databases/checked_at/...`（commands.rs:820-980）。
- [x] 错误：SchemaRegistry 刷新失败；单库完整性问题写入 issues 而非抛出。
- [x] 事件：无。
- [x] DB 读写：读取 refinery 历史；对已初始化库以 `readonly` + `busy_timeout=5000` 打开并执行 quick_check/foreign_key_check（commands.rs:894-924）。
- [x] 取消/并发：无全局锁。
- [x] 时间/ID：`checked_at` 为当前 RFC3339 UTC。

### B09 v2 增量：FK 检查的惰性准备错误（候选待 R4 复核）

生产入口 `data_governance_run_health_check` → `Governance.runHealthCheck` → `integrityCheck` →
`repository/diagnostics.ts::foreignKeyCheckIterator` → F3 `DatabaseHandle.iterate`。
F3 迭代器在首次 next 才真正准备/绑定/步进 SQL；`StorageError.phase` 已公开，不解析错误文案。

| Rust `commands.rs` | TS `Governance.integrityCheck` |
|---|---|
| :912-914 `prepare` 失败 | 无论构造 iterator 时抛错，还是首次 next 抛 `phase=prepare`，均为 `foreign_key_check 准备失败:` |
| :915-917 `query([])` 失败 | 首次 next 的 `phase=bind` → `foreign_key_check 执行失败:` |
| :918-920 `rows.next()` 失败 | 首次 next 的 execute/无阶段错误 → `foreign_key_check 读取失败:` |
| :921-923 存在违规行 | 原 `检测到外键约束违规` 不变；仍先 iterator.return 再 close，清理不覆盖原问题 |

新增生产命令回归用真实 F3 + SQLite 创建引用非唯一列的 FK，触发实际 prepare 错误并断言精确前缀；
未替换查询或伪造 phase。原只读/5 秒 busy timeout 和真实违规清理测试继续保留。
不新增表所有权写入（测试仅操作临时库），不改变响应结构、日志、锁、时钟或取消语义。

## 命令 `data_governance_run_slot_c_empty_db_test`

<!-- BEGIN GENERATED:cmd:data_governance_run_slot_c_empty_db_test -->
- Rust：`src-tauri/src/data_governance/commands.rs:1279` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1358`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：SlotMigrationTestResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_run_slot_c_empty_db_test -->

- [x] 输入：无。
- [x] 输出：`success/report`，report 含每个库的迁移结果。
- [x] 错误：迁移失败写入 report 的 ROOT CAUSE，不抛出。
- [x] 事件：无。
- [x] DB 读写：清空并创建 slots/slotC 空库，执行全部迁移，结束后删除 slotC。
- [x] 取消/并发：无全局锁；串行执行。
- [x] 时间/ID：report 记录总耗时与各库耗时。
## 命令 `data_governance_run_slot_d_clone_db_test`

<!-- BEGIN GENERATED:cmd:data_governance_run_slot_d_clone_db_test -->
- Rust：`src-tauri/src/data_governance/commands.rs:1288` · sync
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1367`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：（无）
  - 结果：SlotMigrationTestResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_run_slot_d_clone_db_test -->

- [x] 输入：无。
- [x] 输出：`success/report`。
- [x] 错误：复制源库失败/迁移失败写入 report，不抛出。
- [x] 事件：无。
- [x] DB 读写：用 SQLite online backup 复制活动槽数据库到 slots/slotD，执行迁移，结束后删除 slotD。
- [x] 取消/并发：无全局锁；串行执行。
- [x] 时间/ID：report 记录耗时。
## 命令 `data_governance_scan_assets`

<!-- BEGIN GENERATED:cmd:data_governance_scan_assets -->
- Rust：`src-tauri/src/data_governance/commands_asset.rs:24` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1101`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：assetTypes?: string[] | null
  - 结果：AssetScanResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_scan_assets -->

- [x] 输入：assetTypes 缺省/null/空列表/全部无效均扫描所有类型；未知类型滤除（commands_asset.rs:34-36）。
- [x] 输出：by_type 为存在目录的统计，total_files/total_size 为其求和；重复类型覆盖同键（assets.rs:1556-1622）。
- [x] 错误：前缀“扫描资产失败: ”；根符号链接/非目录为配置无效，内部链接/特殊文件及 I/O 失败为 IO 错误。
- [x] 事件：无。
- [x] DB 读写：仅活动槽文件元数据读取，缺失类型目录跳过，不过滤敏感文件。
- [x] 取消/并发：无原取消点，不监听 AbortSignal；不获取全局备份锁。
- [x] 时间/ID：固定类型 ID，无新时间。

## 命令 `data_governance_verify_backup`

<!-- BEGIN GENERATED:cmd:data_governance_verify_backup -->
- Rust：`src-tauri/src/data_governance/commands_backup.rs:1403` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:261`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupId: string
  - 结果：BackupVerifyResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_verify_backup -->

- [x] 输入：`backupId` 校验；备份目录不存在返回 `[E_BACKUP_DIR_MISSING]`；目标目录做越界校验（commands_backup.rs:1404-1490）。
- [x] 输出：`is_valid/checksum_match/databases_verified/errors`。
- [x] 错误：备份不存在/路径越界/内部验证错误折叠为 `is_valid=false` 并写入 errors。
- [x] 事件：无。
- [x] DB 读写：逐文件 SHA-256 与数据库 PRAGMA integrity_check；只读。
- [x] 取消/并发：全局 Verify 锁（选择→验证→审计→返回全程持有）。
- [x] 时间/ID：不生成时间或 ID。
## 命令 `data_governance_verify_backup_with_assets`

<!-- BEGIN GENERATED:cmd:data_governance_verify_backup_with_assets -->
- Rust：`src-tauri/src/data_governance/commands_asset.rs:138` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1152`）
- 契约：`contracts/ipc/L21-backup-governance.json`
  - 参数：backupId: string
  - 结果：BackupVerifyWithAssetsResponse · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:data_governance_verify_backup_with_assets -->

- [x] 输入：`backupId` 校验；备份目录不存在返回专用文案（commands_asset.rs:139-210）。
- [x] 输出：`is_valid/database_errors/asset_errors/has_assets/asset_file_count`。
- [x] 错误：备份不存在；保留 Rust 原边界根 `app_data_dir/backups`（而非 recovery/backups）导致的路径校验失败。
- [x] 事件：无。
- [x] DB 读写：逐文件 SHA-256、数据库 integrity_check、资产校验；只读。
- [x] 取消/并发：全局 Verify 锁（选择→验证→审计→返回全程持有）。
- [x] 时间/ID：不生成时间或 ID。
## 事件 `backup-import-progress`

<!-- BEGIN GENERATED:event:backup-import-progress -->
- 事件名 `backup-import-progress`
- 发送点：`src-tauri/crates/dstu-sync/src/backup_job_manager.rs:990`（emit）
<!-- END GENERATED:event:backup-import-progress -->

- [x] 载荷：`ImportProgress`（当前阶段、进度、已处理/总数、当前文件、消息）。
- [x] 触发时机与顺序：仅 `emit_legacy_progress` 调用时发送，位于任务进度更新之外；Host 的 `Jobs.emitLegacyProgress` 同口径。
- [x] 节流/合并：不节流，逐次回调发送。
- [x] 是否在事务提交后：不涉及数据库事务。
- [x] 目标窗口（emit / emit_to / emit_filter）：`emit` 广播到全部窗口。

## 事件 `backup-job-progress`

<!-- BEGIN GENERATED:event:backup-job-progress -->
- 事件名 `backup-job-progress`
- 发送点：`src-tauri/crates/dstu-sync/src/backup_job_manager.rs:979`（emit）
<!-- END GENERATED:event:backup-job-progress -->

- [x] 载荷：`BackupJobEvent`（job_id/kind/status/phase/progress/message/processed_items/total_items/eta_seconds/cancellable/created_at/started_at/finished_at/result）。
- [x] 触发时机与顺序：任务创建与每次合法状态更新后发送；状态机拒绝非法转换，因此事件状态单调。
- [x] 节流/合并：不节流，每次状态更新发送一次。
- [x] 是否在事务提交后：不涉及数据库事务；runtime 锁释放后才发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`emit` 广播到全部窗口。

## 事件 `id`

<!-- BEGIN GENERATED:event:expr:id -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/backup_job_manager.rs:889`（emit）
<!-- END GENERATED:event:expr:id -->

- [x] 载荷：无独立事件；`id` 是 `create_job` 内部 `self.emit(&id)` 的参数表达式，实际事件名为 `backup-job-progress`。
- [x] 触发时机与顺序：见 `backup-job-progress`。
- [x] 节流/合并：同 `backup-job-progress`。
- [x] 是否在事务提交后：不涉及数据库事务。
- [x] 目标窗口（emit / emit_to / emit_filter）：`emit` 广播到全部窗口。

## 事件 `job_id`

<!-- BEGIN GENERATED:event:expr:job_id -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-sync/src/backup_job_manager.rs:897`（emit）
- 发送点：`src-tauri/crates/dstu-sync/src/backup_job_manager.rs:967`（emit）
<!-- END GENERATED:event:expr:job_id -->

- [x] 载荷：无独立事件；`job_id` 是 `create_job_with_id` / `update_runtime` 内部 `self.emit(job_id)` 的参数表达式，实际事件名为 `backup-job-progress`。
- [x] 触发时机与顺序：见 `backup-job-progress`。
- [x] 节流/合并：同 `backup-job-progress`。
- [x] 是否在事务提交后：不涉及数据库事务。
- [x] 目标窗口（emit / emit_to / emit_filter）：`emit` 广播到全部窗口。

## DataGovernanceToolExecutor实际执行（C2/F1本owner接线，候选）

- 原F1真实宿主探针 `20261105003527-c8eec3` 的两份DataGovernanceToolExecutor贡献均executable=false；这是注册对象存在但无execute，不是缺L07注册入口。
  当前执行器实现L04公开ToolExecutor，入口为backup.apply注册→L07实际agentTools贡献→L04公开createExecutorRegistry派发；不创建同名空execute。

| Rust data_governance_executor.rs | TS业务落点 |
|---|---|
| :71-125 backup_status | 既有参数白名单/分页→backup.getBackupList（与UI同一BackupCommands实例）→created_at降序/有界字段/分页结果 |
| :127-173 backup_create | 参数只允许include_assets/asset_types→backup.runBackup(full)同生产Jobs→rememberBackupJob→仅queued/job_id回执，不把排队当完成 |
| :175-213 backup_job_status | UUID校验→同一backup.jobs.getJob→实际summary映射；不存在时按本模块原24h回执区分expired/not_found |
| :215-303 sync_status | L20公开getSyncStatus→本地change logs观察；非敏感SSOT读取及未配置/不可用警告，不探测云端或泄漏凭据 |
| :305-360 sync_run | 复用公开SSOT hydrate与L20 runSync/原syncExecutionJson，600s/SYNC_*返回映射候选；本次取消/超时执行生命周期缺L20 signal接缝，未签收，见BLOCKERS |
| :382-440 execute | 先start，再真实业务；成功end+ToolResultInfo.success，失败error+failure(output=null)，单调时钟毫秒；实际saveToolBlock失败只warn，不覆盖原结果 |

- `backup@1`新增getBackupList/runBackup业务面，委托已有BackupCommands，构造期共用同一个Jobs，未复制命令/备份算法或跨owner SQL。
  L04 ChatExecutionContext公开的services/main_db/cancellation_token、事件及saveToolBlock已经可用，不再记“待执行器注册/上下文发布”。
- 真实回归安装L07/L04/L20/L11及完整F3，以实际L07贡献创建L04生产registry；只覆盖本owner，不伪造完整App中其余60余执行器、不修改MissingExecutorError闭门。
  验证实际catalog排序分页+落盘工具块、异步创建+found/expired/not_found、参数失败事件/错误存块、真实L20状态/未配置SSOT拒绝、真实F3维护造成save失败warn且返回仍成功。
- 原新测试误用全App组装、end.payload与维护期间新借main库的失败日志保留；按Rust BackendEvent.end.result和执行前持有句柄修fixture，业务断言未删。
  修后Node/Electron各5例通过（作业见LANE）。完整App花名册仍需组合根实际集成；有效配置sync_run的取消/超时释放不能以Promise.race提前返回或全局cancelSync替代。

### 已发布登记释放合同的消费增量（L21-GOV-REG-LIFETIME）

- 正常main的L07 registerToolExecutors返回kernel.Disposer对象，不是可调用函数；L21仅由ctx.inject子作用域登记一次，
  用Cordis清理回调调用registration.dispose。删除Root立即登记/对象身份缓存，避免不同trace proxy使同一provider重复贡献。
- 真实L07/F3/F4新宿主验证已有/晚到provider、替换后1条贡献、卸载backup后撤销自有条目、旧snapshot稳定、后来同对象独立登记与PTC owner仍保留。
  只消费该次token，不按名称/对象全局去重或删除其它caller；原两个metadata路由测试保持原断言，夹具改公开owner registry真实disposer。
- 基线两红→Node/Electron各4绿、tsc/strict通过，作业与初轮误用Disposer形状的真实失败见LANE；本增量仅补登记生命周期候选证据，待独立复核，不签全App roster/运行中同步取消。

### 回执TTL单调时间（L21-GOV-RECEIPT-CLOCK）

- Rust data_governance_executor.rs:165/202为两调用传Instant::now，:797/814以saturating_duration_since判24h；
  TS两个生产helper默认改performance.now，避免OS墙钟前跳使尚未过实际保留期的agent回执被清除。时间只存进程内receipt，不新增IPC/持久化字段。
- 24h常量、容量/去重/未来值饱和条件与显式时间轴注入均保留；原:1017-1020测试的now映射到单调时钟，known/unknown两个断言不变。
- 新墙钟前/后跳环境spy及精确TTL边界控制修前1红1绿，修后Node/Electron各3例通过（回执见LANE）；不改公开UTC日期、任务manager其它时钟或同步I/O生命周期，不以此签完整工具域。

### issue1测试路径helper额外IO（dd564 main-red最小缓解，非全量根因签收）

- Rust critical_audit_tests.rs:51-57的get_database_path只是路径匹配；旧TS helper却每次new MigrationCoordinator并读取整套SQL。
  588f089f8复用现有生产databasePath，真实计数131→0次SQL读，同路径；原空库runAll、初始成功、四库状态、旧VFS重建、最终需迁移断言与30s预算不变。
- 原33.23s失败的STACK_TRACE_ERROR对应Vitest withTimeout/makeTimeoutError占位栈；不能据此推断哪个阶段或CPU原因。
  新定向Node/Electron各2例、tsc/strict通过，只证明路径/原业务输入断言保留且无该额外IO，不冒充同全量环境性能修复；后续正常fulltest由infra保留原message/stack/worker配置。

## 验收问题处理

### 未知ZIP备份层级warning（X6-LP-0080部分修复）

- Rust commands_zip.rs:436-449 → `executeBackupAndExport`原tiers默认core、逐项小写并过滤；未知值按:445原文host warn后继续忽略。:451-453全非法输入仍以原文案失败，混合输入仍仅按合法层级选择数据库。
- 仅加warn，不改选择集合/顺序、参数/结果/审计、共享许可、快照屏障、清理、取消或预算；不是LP0080所有warn的完整签收，不改其它备份命令的层级策略。
- 新生产入口回归经真实F3/kernel，混合大小写合法/未知输入实际导出且核四库ZIP条目；全未知输入核failed/result.error/无ZIP。两例都核许可释放与逐项小写warn。logger exporter仅观测真实日志，不替换被测选择或导出。
  首次新测试context错误单列保留，有效修前两分支业务已达成但warn[]失败；修后Node/Electron各2例通过，原作业/exit/Errors详见LANE。旧移植断言、Value两真红及AP0137原30s不变。

### ZIP导入失败日志（X6-LP-0081部分修复）

- 生产链：`index.ts`命令注册→`ZipCommands.importZip/ resumeBackupJob`→`executeImport`→实际`importBackupFromZip`。Rust commands_zip.rs:1583初次导入“ZIP 导入任务失败”与:1891断点恢复“ZIP 导入失败”，对应同一非取消catch按resumable选择host error前缀，保留原始错误诊断。
- 仅增日志，不改任务result/错误、审计/清理次序或锁finally；取消分支依旧先返回，不新增取消error。未触及Rust:53虚拟URI复制分支，LP-0081整项不因此签收。
- 新回归`acceptance-fixes.test.ts`通过实际坏manifest ZIP和真实F3 Host，初次导入failed且清理目录，再使用该任务真实落盘的checkpoint经kernel恢复failed且保留输入；核两次原result诊断、实际文件及许可释放，最后核两条不同error日志。
  修前两入口均已执行但日志[]而失败；修后Node/Electron各1例通过（原作业见LANE）。不替换导入器/任务状态/被测logger，不修改旧移植断言或预算；候选待复核，不借日志回归签任意Value、native性能或整个lane。

### 日志候选源码核实（X6-LP-0070/0071）

- `cloud_config_commands.rs:902/920/926/1001` → `cloud-config.ts:886/900/905/819`：发布SSOT失败后abort也失败、提交失败后恢复SSOT也失败、提交失败后abort也失败、清除失败后恢复凭据也失败，四条warn的条件/关键错误字段均已存在。
  `index.ts:171-175`安装真实cloudConfig服务并传host logger；这四条不是缺日志，无需改代码或为计数重复记录。
- `cloud_credentials.rs:117/140` → `cloud-config.ts:555/538`：安全存储读取失败与SSOT非NotConfigured错误均warn并继续清空相应IPC形状；`index.ts:48-54`的公开backup服务委托同函数且传host logger。
  原X6仅将Rust整文件与api.ts粗关联，不等于生产实现没有warn。结论仅为逐分支源码映射正确，不是新故障注入测试、所有事务/serde或lane完整签收；未重复运行既有已绿业务。

### ZIP密封残留与密码覆盖证据（AP-0136/0137候选，Electron有真实超时）

- Rust zip_export_import_restore_tests.rs:504-523 → wrong-password用不同source/import目录，clean及真实ZIP外层manifest残留两输入；
  残留key_policy=included_encrypted、直接生产gate与kernel restoreAssets=false明确拒绝，四核心库hash/真实SQLite marker维持原值。
  原TS纯文本文件fixture/UTF8 marker比较改为Rust原SQLite marker语义，不因坏数据库格式让后续验证提前失败掩盖sealed门禁。
- :814/:821-833 → resolver返回值真正送生产export，explicit ZIP有密封入口，实际显式密码导入成功，stored密码导入该覆盖ZIP失败；
  原缺密码/portable/stored/explicit取值与peek断言不减弱。两条fixture使用F4真实服务+真实SQLite/生产coverage元数据，不用Fake-DSBK密码前缀验证F4行为。
- Node3通过，Electron错密码两例通过/显式链原30s超时，tsc与strict通过（均见LANE原作业/exit/Errors）；候选未完成，未改预算/Argon2参数或禁用断言。
  E原生最小probe抛不支持而走F4已声明JS回退；C2已裁定先F4最小消费已main F7 nativeArgon2，不批准扩30s。
  等正常main/明确固定联合树提供方到位后仅复验这三入口；不改默认KDF/原预算、不重写F7/加包，native后仍超时才凭阶段证据裁定。
  不签F4密码学全域、完整A/B恢复、Value codec或lane完成；原Value两项可执行失败仍保持。

### 取消后完整重试（AP-0135候选）

- Rust restore_domain_plan_tests.rs:704/:735-737先锁notes非空及clear后candidate空；原取消/无租约/活跃槽/已写入半成品断言保留。
- :739-765通过真实kernel restore_backup完成完整重试，使用真实SQLite/metadata和F3/F4/L11/L20业务入口，核completed/result.success、四库/资产数1以及chat marker、notes、webview；
  不再拿只重跑asset helper当完整恢复，也不由测试手工mark租约；生产cutover后保:775-777实际lease字段。
- 原30s预算不变，等待采用该用例Vitest signal，真实host资源先销毁再删临时文件；本例不用旧fakePublication/假版本。Node/Electron各1例、tsc/strict通过，检查点875296fbc与作业见LANE。
  只是该断言缺口的生产补证，不签Value、native Crypto性能、startup D2或lane完整验收。

> 最新外部签收：只读 `ds-mig/R4-review-sync:host/plugins/backup/ACCEPTANCE.md` §15–17。
> R4已关闭B05（实际L11+激活owner）、B09（所列健康检查finding）、B02启动等待子项，以及B06四个真实registry/依赖子项和三个真实初始化/审计子项。
> 下方旧待复核说明保留为历史，不重做或复跑已签范围；B02外部真实维护漏报、B03、B06两报告+两策略、B07仍开。
> 实际维护状态/初始化报告读取面交架构协调owner；不在L21读取F3私有状态或复制报告/策略，F3 parked时不排执行消息。

### B05 v2 增量：VFS 恢复表所有者（2026-11-04）

- Rust 入口：`backup/mod.rs:2537-2568`；生产 TS：`RestoreCommands.executeRestore`
  调 `prepareVfsIndexRestore(ctx, ...)` / `finalizeVfsIndexRestore(ctx, ...)`，后者按需获取
  `vfs-repos/api.ts` 的 `VfsMaintenanceService`，调用 `resetRebuildableIndex(targetDir)`。
- 分支：prepare 删除旧 Lance（2544-2547）→ 创建完整组件目录（2548-2550）或委托 owner 重置（2551-2552）；
  finalize 完整组件 + restoreAssets 为 true 直接保留（2561-2562），否则再次委托重置（2568）。
- 所有权：删除本 lane `repository/vfs-restore.ts`，所有 VFS SQLite 更新由 L11 在同一个
  IMMEDIATE 事务内执行；L21 不持有该连接。main `eeaf5bdc7` 已含正式 owner。
- 数据边界：manifest 沿既有加载解码器；owner 接口只接候选槽根路径，无 JSON/SQL 透传。
- 日志：Rust `mod.rs:2521-2524` 成功 info 在 owner 完成事务返回后发出；无库时不发。
- 错误/运行时：owner 抛错原样交既有恢复阶段包装；没有 owner 明确失败，完整组件保留路径无需 owner。
  owner 同步关闭句柄；本次不改变取消点、时钟与平台分支。
- 测试：`backup-manager.test.ts` 安装真实 L11 插件，恢复 Rust 6880、6921-6928、6948、6969、6978、
  6987、6999、7025 的全部字段断言；legacy 的 7052/7057/7068 三断言保留。
  `restore.test.ts` / `zip-integration.test.ts` 的真实 kernel 恢复调用链改装正式 owner。
- 证据等级：生产入口测试 + Rust 审读；作业结果与 R4 签收另记，不自行关闭 ACCEPTANCE。

### 审计域assert补证（AP-0074/0134，非B05重复验收）

- Rust backup/mod.rs:7708-7712 → `backup-manager.test.ts`真实createBackup/backupAuditDb生成manifest后，
  `domainRestorePlan('audit')`核files数、file_count、应用根scope、归档路径、SHA256长度；之后原破坏SQLite并重写hash/verify失败断言不变。
- Rust restore_domain_plan_tests.rs:382 → `restore-domain-plan.test.ts`生产consumeCompleteDomains前显式验证audit目标不存在，
  再保留restored与实际SQLite marker终态，调用的是RestoreCommands使用的同一消费者，不是测试内恢复副本。
- 仅增加原Rust遗漏断言，未改生产/SQL归属/日志/时钟/并发/取消/预算；审计库root与active-slot位置的既有裁定问题不由此关闭。
  Node/Electron各2例、typecheck、两文件strict均exit0，无Errors行；检查点与作业详见LANE，待独立复核，当前Value两项真实失败仍保留。

### 数据库恢复陈旧Lance清理补证（AP-0069）

- Rust backup/mod.rs:7093/:7095-7097 → 备份并验证后删除源库，候选槽预置真实陈旧Lance目录及文件；:7104-7107核整个 `databases/lance/vfs` 不存在。
  原备份vfs条目、verify成功、恢复库存在和SQL行数2四断言保持；some(vfs)已蕴含原:7087非空。
- 使用真实L11插件，生产可达的 `restoreSingleDatabaseToDir` → `prepareVfsIndexRestore` → `finalizeVfsIndexRestore`，false选择database-only分支；
  与 `RestoreCommands.executeRestore` 的数据库→prepare→finalize顺序一致，但本例只证明这三个真实组件的组合，不冒称整槽kernel恢复/重签B05，也不复活旧原地restore入口。
- 仅补测试输入/生产调用及遗漏断言，不改生产所有权、日志、清理、取消、KDF或预算。Node/Electron各1例通过，候选与原作业（含首次筛选零执行不计验收）详见LANE，等待独立复核。

### main-red：真实 VFS owner 的维护参与者接线（2026-11-05）

- 原始反例：fulltest `650ddffbe` / `2026-11-04T23:26:51Z` 的两条B05重置回归、完整槽恢复、加密ZIP完整往返，
  均在 `installVfsRestoreOwner → vfs-repos/index.ts:172` 抛 `ctx.storage.registerMaintenanceParticipant is not a function`，
  未进入重置或恢复操作，不是时长/预算问题。
- 已发布合同：L11把实际VFS worker注册到正式F3维护屏障，enter执行pause/drain、exit恢复。
  L21旧测试夹具只有Connection包装与no-op enterMaintenance，缺少该接口；owner生产实现无需回退、可选调用或兼容分支。
- `ecff33220`：backup-manager共用setupEnv、完整restore及encrypted ZIP roundtrip改用完整 `createStorageService`，
  保留真实L11安装、F3参与者注册与维护屏障；host卸载后dispose实际存储句柄。删除restore本地不完整存储副本。
  本增量只改夹具，不改业务算法、SQL所有权或现有任何expect/事件/文件/候选槽/lease断言，原60s/120s与issue1默认30s预算均不变。
- 直接owner回归仍覆盖Rust `backup/mod.rs:6777/7032` 的各项重置/legacy/完整组件不变量；
  另外两项走kernel实际恢复命令及完整ZIP导出→导入→恢复链，不能以“注册不抛错”替代终态/数据断言。
- Electron定向4例（`20261104233518-7302dd`）、Node整个backup目录27文件/437例（`20261104233518-5a602c`）、
  typecheck（`20261104233518-f2055e`）、全boundaries 2946文件/0违规（`20261104233518-862ddc`）均exit0、无Errors行。
  本增量不签收D2启动失败政策、外部translation fixture或整个lane完成。

> R4 `ACCEPTANCE.md`（审读基线 `f23c98702`）B01–B11 的逐项处理。提交号为本分支短哈希；
> 跨 lane 无法独立完成的接口按「阻塞」记录，测试同步转 `pending`（见 `TESTMAP.md` / `BLOCKERS.md`）。

| 问题 | 处理 | 提交 / 阻塞 |
|---|---|---|
| B01 普通业务失败变 HandlerPanic | 全部 `error: string` 命令经 `stringErrorCommand` 出口转为 `CommandError`；TypeError/RangeError 等编程异常继续 panic；补 `run_backup`/`get_audit_logs` 生产入口断言 | `5a0164243`、`518dd3e14` |
| B02 maintenance 只是本地标签 | `Operations.enterSnapshotBarrier()` 调用 `ctx.storage.enterMaintenance(DATABASE_NAMES)` 与 `agentWorkspace.enterMaintenanceMode()`；`blocked_components` 来自真实 lease；`component_health/issues` 读取 F3 `componentHealth`；主库已在维护态时按 Rust 借用该屏障（返回空 ownership 的 no-op barrier，绝不释放外部 lease）；release 首次失败保留 ownership 并按 `Drop` 语义在同一调用内重试一次，调用方仍收到原始错误，只有重试也失败才保持 fail-close。`tests/acceptance-fixes.test.ts` 的 staging 用例改用真实 `StorageServiceImpl`（不再替换 `enterMaintenance`）：备份快照打开点 `storage.database('vfs')` 与备份前已持有句柄写入均抛 `MAINTENANCE`，屏障退出后同一句柄恢复可写；借用用例继续断言外部 lease 不被提前释放（作业 `20261104085038-86d7ff`，19 passed / exit 0） | `dc18851a2`、`518dd3e14`、`67a796889`、`0d4a73c61` |
| B03 守卫未共享且无跨进程锁 | 模块级共享 FIFO + active 快照；`acquireProcessOperationLockAt(<dataDir>/recovery/.data-governance-operation.lock)`；发布完整 snake_case `backup.tryAcquireOperation(kind)`、带超时 `backup.acquireOperation(kind, timeoutMs)` 与 `governance.acquireOperationGuard(kind)`/`tryAcquireOperationGuard(kind)`；忙锁与锁 IO 均以结构化 `OperationGuardError` settle（`busy`→`Validation`、`lock_io`→`FileSystem`，`value`/`app_error` 为 Rust 同形 AppError），L21 `error: string` 命令在出口转回字符串，调用方显式 `release()`；`tryAcquire` 持有期间 `acquire` 排队等待；备份/分层/ZIP/恢复任务改用 `Operations.acquireForJob`，按 `commands_backup.rs:999-1016` 每 200ms 轮询取消，排队取消立即 `cancelled("用户取消任务")`，不占后到许可；6 个任务入口捕获取锁失败并按 Rust 原文案 `获取全局备份锁失败: {e}` 落到 `job.fail`（本次新增真实 `StorageServiceImpl` + recovery 锁目录不可创建回归） | `dc18851a2`、`518dd3e14`、共享接口增量提交见下节、`67a796889`、`5f02d66bd` |
| B04 含资产备份可降级为 partial 成功 | `run_backup` 在 `includeAssets=true` 时调用 `validateForSlotRestore(manifest)`；全部无效 `assetTypes` 回退默认目录；A/B 回归覆盖失败与回退两条路径 | `dc18851a2`、`518dd3e14` |
| B05 跨插件表写入/逻辑复制 | 设备轮换改为 `ctx.syncSupport.state.recordDeviceRotation`，删除 `repository/sync-state.ts`；同步基线改经 `ctx.get('sync').resetSyncBaselineAfterRestore`，删除 `repository/vfs-restore.ts` 本地副本（`4806be8e6`） | 轮换：`703ad9dfe`；**仅剩阻塞**：VFS 由 L12/L11 发布 `resetRebuildableIndex`（语义见 `BLOCKERS.md` §1.1，2 条回归保持可执行、TESTMAP 仍 pending） |
| B06 ported 测试不测生产行为/弱化断言 | 删除 `init.rs` 本地 `InitializationReport`/`ensureDirectories`/`initializeWithReport` 测试与 `RegistryStateHolder` 替身，7+1 条转 `pending`；ZIP 两条缺密码改为完整错误相等，`short_explicit` 恢复最小长度断言 | `703ad9dfe` |
| B07 测试闭包/执行门禁 | 定位：vitest fork worker 的 birpc `onTaskUpdate` 固定 60s 超时（`index.B521nVV-.js` `DEFAULT_TIMEOUT=6e4`）；本文件 92 条同步 SQLite 迁移用例形成长微任务链，负载下 `historical_fixtures...` 单测曾达 76.8s，待处理 RPC 定时器先到期 → 整套 exit=1（所有断言仍 passed，非业务失败）。修复：每个用例前与长用例各阶段之间让出宏任务（仅调度，断言不变）；复跑两次均 21 文件 / 345 用例（343 passed + 2 skipped）、无 `Unhandled Error`、exit 0（389.37s / 268.28s） | `24b3aa18a`；日志 `/tmp/opencode/l21-full-fix1.log`、`l21-full-fix2.log` |
| B08 自动验证锁外选择/过早释放 | `autoVerifyLatest` 先 `acquire('verify')` 再 list/选择，锁持有到验证、审计写入和返回；`verify_backup*` 同步此顺序 | `dc18851a2`、`518dd3e14` |
| B09 健康检查未只读打开 | `integrityCheck` 以 `profile: { readonly: true, busyTimeoutMs: 5000 }` 打开；分阶段 `只读打开/quick_check 执行/foreign_key_check 准备/读取` 错误上下文；`foreign_key_check` 迭代器在 close 前显式 `return()`，close 的 busy 错误不得覆盖原始外键违规诊断。回归改用真实 `StorageServiceImpl`：真实孤儿外键数据 + 真实平台 iterate，最终 issue 必须为 `数据库完整性检查失败: 检测到外键约束违规` 且不含 `busy`（作业 `20261104085038-86d7ff`，exit 0）。平台 `iterate` 把 prepare/bind/first-step 都推迟到第一次 `next()`，因此准备期失败只能落在 Rust 的“读取失败”阶段；这一点在 REPORT §7 记为平台差异，不伪造阶段 | `dc18851a2`、`67a796889`、`53c496e2b`、`0d4a73c61` |
| B10 warn/error 丢失或 process.emitWarning | 清单加载/备份 ID 不一致、list/delete、cancel、迁移 pending、健康依赖、非法任务状态转换均注入插件 logger；`process.emitWarning` 全部移除 | `703ad9dfe`、`dc18851a2` |
| B11 错误顺序/上下文差异 | `getAuditLogs` 先取连接再校验 status；`checkDiskSpace` 使用 `未找到备份`、inactive 目标 `isDirectory`+`realpathSync`；`deleteBackup` 保留 `File not found: 备份不存在:` 前缀 | `dc18851a2` |

## 共享接口交付（2026-11-04 协调者增量）

> 对应 C2 04:25 / 04:45 / 04:59 指令与 D2 裁定；实现均在 `host/plugins/backup/`，跨 lane 消费方只需按公开方法接线。

| 需求 | 交付 | 测试证据 | 提交 |
|---|---|---|---|
| 唯一共享操作许可 | `backup.tryAcquireOperation(kind)` + `backup.acquireOperation(kind, timeoutMs)`；`governance.acquireOperationGuard` / `tryAcquireOperationGuard` / `acquireOperation` 全部委托同一个 `Operations` 单例与跨进程锁 | `tests/operation-and-sync-ports.test.ts`（跨服务互斥、快照、显式 release） | `2a3738008`、`31ad462b2` |
| snake_case kind 契约 | 公开类型改为契约 `DataGovernanceOperationKind`：`backup`/`auto_backup`/`verify`/`zip_export`/`zip_import`/`restore`/`sync`/`delete_propagation`/`prune`；删除大写枚举与“默认映射 prune”分支 | 9 种 kind 逐个快照断言；与 L23 小写入参一致 | `2a3738008`、`31ad462b2` |
| 带超时等待（import_sync_data） | `Operations.acquireWithTimeout`：真实队列等待；超时移除自己的排队位置、不补授；原文案 `等待全局数据治理锁超时（N秒）…`；非超时锁错误走结构化 `OperationGuardError` | 等待成功/1 秒超时/超时后 `tryAcquire` 立即可得 | `2a3738008`、`31ad462b2` |
| C2 P03 结构化许可错误 | `OperationGuardError` 公开 `reason`（`busy` / `lock_io`）、稳定 `code`（`E_DATA_GOVERNANCE_BUSY` / `E_DATA_GOVERNANCE_LOCK_IO`）、`app_error`（Rust 同形 `AppError`）与 `cause`；`value === app_error` 使 L23 可直接按 `Validation`/`FileSystem` 原契约传输。L21 字符串命令在 `stringErrorCommand` 出口取 message 转回 `string`；裸程序异常不被吞成业务错误。 | `tests/operation-and-sync-ports.test.ts` busy/lock IO 判别；`tests/acceptance-fixes.test.ts` B03 真实双 host 忙锁 wire | `bf1a1d20e`、`0980d8552` |
| D3 u64 → IPC number | 内部 generation/版本/大小保持 bigint 精确；移除 `u64ToJsonNumber` 对 `> Number.MAX_SAFE_INTEGER` 的额外拒绝，IPC 与原 Tauri number 输出一致 | `tests/cloud-config.test.ts` generation 输出断言 | `bf1a1d20e`、`0980d8552` |
| DeletePropagation | `governance.acquireOperationGuard('delete_propagation')` 按 Rust `try_acquire` 立即失败；与 `backup` 守卫同一许可 | 持有 `backup` 时删除守卫抛错；释放后可取得并再阻塞 backup | `2a3738008`、`31ad462b2` |
| L20 SyncCommandPorts | `backup.syncCommandPorts()` / `governance.syncCommandPorts()`：`limiter`（`tryAcquire`/`acquire(60_000)` 同一许可）、`loadHydratedCloudConfig`（SSOT→runtime→SecureStore→validate；NotConfigured→null）、`saveSyncAudit`（`AuditOperation::Sync` + best-effort） | limiter 互斥/超时；未配置 null；凭据缺失 `E_CLOUD_CREDENTIALS_UNAVAILABLE`；started→completed / failed 审计行 | `2a3738008`、`31ad462b2` |
| `application` 归属（D7） | 多库应用唯一归 L20：main `d5cd234aa` 已集成 `host/plugins/sync/api.ts:108` 的 `applyDownloadedChangesToDatabases(changes, strategy)`；L21 不复制 `repository/apply-databases.ts`，`BackupSyncCommandPorts` 明确不含 `application`。L20 本地绑定该实现，只消费 `ctx.backup.syncCommandPorts()`；缺 `sync` 时按需 `ctx.get` 报错，不硬 inject。 | 5 条原 `commands_backup` 库路由/冲突测试经 `ctx.get('sync')` 在 `tests/commands-backup-sync.test.ts` 生产入口执行；见 `BLOCKERS.md` §2 | `2a3738008`、`31ad462b2`、`4806be8e6` |
| L07 agentTools 生产接线 | 原2a3738008/31ad462b2仅注册/metadata证据，不代表execute已接；本轮276cc2123及后续fixture修正补实际业务execute，消费正式L07/L04 API | `governance-tool-execution.test.ts` 真实L07贡献→L04生产registry，Node/Electron各5例；非全App roster或sync取消闭环签收 | 原注册历史保留；本轮候选/回执见LANE |
| VFS 回归不再 skip | 2 条 VFS 不变量测试恢复执行；TESTMAP 仍 `pending`；向 L11/L12 给出 `resetRebuildableIndex(targetDir)` 最小语义 | `tests/backup-manager.test.ts`（19 条全通过） | `2a3738008`、`31ad462b2` |
| 业务错误真实 settle | 新增 `cleanup_audit_logs` 非法令牌、`get_database_status` 未知 ID、`delete_backup` 非法 ID 三条 `host.invoke` 断言；连同原 B01 两条共 5 条真实入出口 | `tests/acceptance-fixes.test.ts` | `2a3738008`、`31ad462b2` |

### 仍存在的验收阻塞

- VFS 派生索引重置：缺 L12/L11 的 `resetRebuildableIndex(targetDir)`；2 条 VFS 回归保持可执行，TESTMAP 仍为 `pending`（最小语义见 `BLOCKERS.md` §1.1）。
- 同步基线重建：main `d5cd234aa` 已集成 L20 `sync@1.resetSyncBaselineAfterRestore`（`host/plugins/sync/api.ts:205`）；恢复候选槽改为经 `ctx.get('sync')` 按需调用，`repository/vfs-restore.ts` 的本地副本已删除（D7）。
- 启动初始化：F3 持有 `init.rs` 编排；7 条 init 测试与 1 条 Registry 中毒测试转 `pending`。
- 启动就绪等待：缺 F3 `waitStartupReady`；`get_maintenance_status` 无法等待启动初始化。
- L20 `applyDownloadedChangesToDatabases`：main `d5cd234aa` 已集成，5 条 sync 冲突测试已移植到 `tests/commands-backup-sync.test.ts` 并经 `ctx.get('sync')` 消费；`application` 由 L20 本地绑定，L21 不复制。
- L23 云同步写命令需删除本地可选 guard 类型、改用最终 snake_case kind，并按结构化 `OperationGuardError` 的 `app_error`（`busy`→`Validation`、`lock_io`→`FileSystem`）传输；L21 已发布正式 API，L23 代码不在本 lane 写入范围。
- D1/D4：L21 向 `*WithConn`/仓储所有者传同一个 `SqlExecutor`，SQL 留在表所有者；恢复候选槽的 VFS 索引重置仍按 `BLOCKERS.md` §1.1 等待 L11/L12 所有者 API，L21 不复制。
- 启动/恢复结束收尾归 F3 注册点；L21 只提供业务函数 `finalizeRestoreActivation`，平台不得反向 import `backup`。缺 F3 启动钩子期间该接线保持阻塞。
