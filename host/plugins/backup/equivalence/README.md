# L21-backup-governance 等价场景 v0：备份清单 / ZIP 导入 / 任务 / 迁移诊断

WP-073（WAVE0 §3 v0），WP-129 追加六条元数据/资产/审计命令（§9）。本目录只放场景源文件，不含答案：A（Tauri+Rust）是答案机，B（Electron 宿主）重放后由 X7 比较器比对。**本包没有执行任何 A/B 重放，没有一条命令因此成为 C。**

| 文件 | 可执行 | seed | 场景 | 步骤 | 说明 |
|---|---|---|---|---|---|
| `inventory.json` | 是 | `empty` | 5 | 69 | 清单/校验/磁盘/自动校验/删除的空库路径与 `validate_backup_id` 全分支 |
| `import.json` | 是 | `empty` | 4 | 39 | `import_zip` 同步阶段全部可达 Err，以及 IPC 反序列化错误 |
| `jobs.json` | 是 | `empty` | 3 | 23 | 任务表空状态、resume 未找到、IPC 错误 |
| `diagnostics.json` | 是 | `empty` | 4 | 27 | 迁移状态、健康检查、单库状态、完整诊断报告 |
| `pending-runner/import-job-lifecycle.json` | 否 | `empty` | 4 | 38 | 需 X7 的终态等待原语与 runner 路径参数（§5） |
| `inventory-seeded.json` | 是 | `l21-backups-empty-dir` / `l21-backups-size-overflow` | 2 | 9 | W21 种子（`host/e2e/data-compat/__fixtures__/backup-seeds.ts`） |
| `pending-seed/inventory-mixed-seeded.json` | 否 | `l21-backups-mixed-v1` | 1 | 16 | 种子已实现，等 A 产出备份冻结进仓库后即可移到顶层（§4.1、`host/e2e/data-compat/__fixtures__/a-produced/README.md`） |
| `pending-seed/inventory-seeded.json` | 否 | `l21-backups-symlink-escape` | 1 | 4 | 符号链接与快照器约定冲突（§4.5） |
| `pending-runner/backups-path-is-file-recovery.json` | 否 | `l21-backups-path-is-file` | 1 | 11 | 占位文件让启动进入恢复模式后的行为（§4.1.1）；种子已就绪，录制器在恢复模式下的准备步骤失败，等 W13 |
| `jobs-persisted.json` | 是 | `l21-persisted-jobs-v1` | 1 | 14 | W21 种子 |
| `pending-seed/jobs-persisted.json` | 否 | `l21-persisted-jobs-v1` | 1 | 4 | 种子已就绪；导出续传需等待任务终态，现有等待原语只匹配 `eventType`/`type:phase` |
| `diagnostics-seeded.json` | 是 | `l21-live-integrity-issues` | 1 | 4 | W21 种子 |
| `pending-seed/diagnostics-seeded.json` | 否 | `l21-live-vfs-not-sqlite` | 1 | 5 | 非 SQLite 的 `.db` 会让快照器读库报错，处理建议见 §4.5 |
| `pending-seed/historical-zip.json` | 否 | `l21-historical-zip-v1` | 2 | 12 | 种子已实现，等 A 产出 ZIP 冻结（§4.4）；另需录制器 `${seed.*}`（W13） |
| `metadata.json` | 是 | `empty` | 2 | 6 | WP-129：Schema 注册表、维护状态（§9） |
| `assets.json` | 是 | `empty` | 2 | 29 | WP-129：资产类型、资产扫描参数变体与 IPC 错误 |
| `audit.json` | 是 | `empty` | 7 | 73 | WP-129：审计查询过滤/分页/非法状态/SQLite 整数溢出；清理令牌在取连接前的全部 Err |
| `pending-runner/audit-cleanup-token.json` | 否 | `empty` / `l21-audit-history-v1` | 11 | 32 | 种子已就绪；需 runner 当前时间令牌、单步超时与崩溃隔离（§9.4） |
| `audit-seeded.json` | 是 | `l21-audit-history-v1` / `l21-audit-corrupt-rows-v1` | 2 | 25 | W21 种子（`host/e2e/data-compat/__fixtures__/audit-seeds.ts`，§9.5） |
| `assets-seeded.json` | 是 | `l21-assets-tree-v1` / `l21-assets-root-is-file` | 2 | 12 | W21 种子 |
| `pending-seed/assets-seeded.json` | 否 | 3 个 L21 种子 | 3 | 6 | 符号链接 / FIFO 与快照器约定冲突（§4.5） |
| `metadata-seeded.json` | 是 | `l21-live-integrity-issues` | 1 | 2 | W21 种子 |
| `pending-seed/metadata-seeded.json` | 否 | `l21-live-vfs-not-sqlite` | 1 | 2 | 同 diagnostics：非 SQLite `.db` 阻塞快照（§4.5） |
| `backup-lifecycle.json` | 是 | `empty` | 4 | 56 | WP-234：备份→导出→恢复往返、run/tiered 参数变体、取消排队任务（§10） |
| `backup-errors.json` | 是 | `empty` | 5 | 35 | WP-234：incremental 早退、backupType 大小写、cancel 未知 id、IPC 错误 |
| `export-restore-errors.json` | 是 | `empty` | 6 | 109 | WP-234：export_zip / restore_backup 同步 Err 与后台失败、restore_with_assets 停用、verify_with_assets 空库 |
| `slot-tests.json` | 是 | `empty` | 2 | 8 | WP-234：Slot C / D 迁移测试 |
| `zip-export-errors.json` | 是 | `empty` | 1 | 14 | WP-234：`backup_and_export_zip` 同步 Err |
| `cloud-draft.json` | 是 | `empty` | 5 | 49 | WP-234：草稿连接测试的口令门、配置校验、缺凭据、回环拒连 |
| `pending-runner/cloud-draft-success.json` | 否 | `empty` | 2 | 5 | 需 L23 云服务替换 `${cloud.*}`（§10.4） |
| `pending-runner/purge-all-data.json` | 否 | `empty` | 2 | 9 | 需 X7 重启原语（§10.4） |
| `jobs-dir-blocked.json` | 是 | `l21-backup-jobs-is-file-v1` | 1 | 3 | 持久化目录读取失败（§10.5）；W21 种子 |
| `pending-seed/verify-with-assets-seeded.json` | 否 | `l21-backups-legacy-mirror-v1` / `l21-backups-mixed-v1` | 2 | 7 | verify_with_assets 成功与路径解析失败（§10.5）；种子已实现，等 A 产出备份冻结 |

所有场景：`capture {events:true, db:["*"]}`、`normalize: []`。`expect:"error"` 只是说明，判定只看 A 的实际结果；没有写任何期望返回值。顶层目录只放种子已实现（`empty` 或 `scenario-seeds.ts` 已登记）且不需要 v0 之外能力的场景，`pending-*` 子目录不应被当前 runner 执行。

## 1. 运行器约定（交 X7 确认）

1. `${n.path}` 只引用同场景更早、未标 `expect:"error"` 的步骤，整串替换为原类型值。顶层 4 个可执行文件不含任何引用。
2. 缺省参数用**省略键**表达（前端 `invoke` 传 `undefined` 时键被丢弃，`src/api/dataGovernance.ts:811-816` 等）；显式 `null` 场景单独写，两者都要比。
3. 路径类错误文案经 `sanitize_path_for_user`（`commands_backup.rs:621-636`）：位于 `$HOME` 下改写为 `~/…`，否则保留最后两级。本目录的不存在路径都在 `/nonexistent-wp073/` 下，不受 HOME 影响；但 A/B 的 HOME 与工作目录（相对路径 `zipPath` 场景）必须一致。
4. `db:["*"]` 不覆盖文件系统。以下场景有**非 DB 副作用**，建议 X7/X3 对数据目录做树快照比对：`content://` 导入写 `pending_saf_persist/` 队列文件（`dstu-storage/src/unified_file_manager.rs:603-630`），虚拟 URI 物化创建 `temp_zip_import/`（`:1066-1075`）；完整诊断报告创建并清理 Slot C/D 测试目录（`commands.rs:225-300`）；任务失败写 `backup_jobs/<id>.json`（`dstu-sync/src/backup_job_manager.rs:626-629`）。
5. 本包场景都在隔离的 `empty` 数据目录里运行，不触碰真实用户备份；`delete_backup` 只在隔离 seed 内调用。

## 2. 首组命令（15 条）与 Rust / 前端入口

Rust 路径相对 `src-tauri/src/data_governance/`，任务管理器为 `src-tauri/crates/dstu-sync/src/backup_job_manager.rs`（下称 `bjm`）。前端路径为调用点；`src/api/dataGovernance.ts` 简写 `dg.ts`。15 条均在 `src-tauri/src/lib.rs:3081-3143` 注册，B 端在 `host/plugins/backup/index.ts` 注册。

| 命令 | Rust | 前端 | 文件 |
|---|---|---|---|
| `data_governance_get_backup_list` | `commands_backup.rs:1194` | `dg.ts:241`；`DataGovernanceDashboard.tsx:853`、`DataImportExport.tsx:665` | inventory |
| `data_governance_verify_backup` | `commands_backup.rs:1404` | `dg.ts:261`；`DataGovernanceDashboard.tsx:1360` | inventory |
| `data_governance_check_disk_space_for_restore` | `commands_backup.rs:1321` | `dg.ts:1323`；`DataImportExport.tsx:885,982`、`CloudStorageSection.tsx:1128` | inventory |
| `data_governance_auto_verify_latest_backup` | `commands_backup.rs:1495` | `dg.ts:273`；`DataGovernanceDashboard.tsx:1137` | inventory |
| `data_governance_delete_backup` | `commands_backup.rs:1272` | `dg.ts:249`；`DataGovernanceDashboard.tsx:1344` | inventory |
| `data_governance_import_zip` | `commands_zip.rs:1210` | `dg.ts:811`；`DataGovernanceDashboard.tsx:1323`、`DataImportExport.tsx:971`、`CloudStorageSection.tsx:1099` | import |
| `data_governance_list_backup_jobs` | `commands_backup.rs:2300` → `bjm:917` | `dg.ts:399`；`DataGovernanceDashboard.tsx:1764` | jobs |
| `data_governance_get_backup_job` | `commands_backup.rs:2282` → `bjm:924` | `dg.ts:390`；`useBackupJobListener.ts:122`、`DataImportExport.tsx:557`、`CloudStorageSection.tsx:837` | jobs |
| `data_governance_list_resumable_jobs` | `commands_backup.rs:2356` → `bjm:1162` | `dg.ts:662`；`DataGovernanceDashboard.tsx:866` | jobs |
| `data_governance_resume_backup_job` | `commands_backup.rs:2396` | `dg.ts:601`；`DataGovernanceDashboard.tsx:1033` | jobs |
| `data_governance_cleanup_persisted_jobs` | `commands_backup.rs:2505` → `bjm:1174` | `dg.ts:678`（仅 API 包装，未见组件调用） | jobs |
| `data_governance_get_migration_status` | `commands.rs:739` | `dg.ts:86`；`useMigrationStatusListener.ts:160`、`DataGovernanceDashboard.tsx:836` | diagnostics |
| `data_governance_run_health_check` | `commands.rs:823` | `dg.ts:111`；`DataGovernanceDashboard.tsx:837,1116`、`DataImportExport.tsx:1261` | diagnostics |
| `data_governance_get_database_status` | `commands.rs:1006` | `dg.ts:98`（仅 API 包装，未见组件调用） | diagnostics |
| `data_governance_get_migration_diagnostic_report` | `commands.rs:1061` | `dg.ts:1351`；`MigrationStatusBanner.tsx:208` | diagnostics |

辅助命令（只在 `pending-runner` 搭建状态，不计入本组覆盖）：`data_governance_backup_and_export_zip`，Rust `commands_zip.rs:221`，前端 `dg.ts:737` / `DataGovernanceDashboard.tsx:1186`。

所有命令共有的 IPC 层错误：缺必填键、类型不符（Tauri 参数反序列化）。多余键被忽略，这一点由各文件 `ipc_args` 场景里的成功步骤（带 `unexpected`/`backupId` 等多余键）覆盖。`get_app_data_dir`（`commands_backup.rs:30-34`）失败、`DataGovernanceOperationGuard::acquire` 失败（`获取全局备份锁失败: …`）在单场景串行重放下不可达。

## 3. 可达 Err / 提前返回逐命令列表

### 3.1 `validate_backup_id`（`commands_backup.rs:917-951`，verify / check_disk / delete / import 共用）

按代码顺序：`trim()` 后为空 → `backup_id 不能为空`（`:919-921`）；`urlencoding::decode` 失败（非 UTF-8，如 `%FF`）→ `backup_id 编码非法: {e}`（`:923-925`）；解码结果与原串不同 → `backup_id 不允许包含 URL 编码`（`:927-929`）；**按字节**长度 >128 → `backup_id 长度超限（最大 128）`（`:931-933`，`'备'×43`=129 字节命中、`'a'×128` 通过）；含 `/`、`\`、`..` 或以 `.` 开头 → `backup_id 包含非法路径片段`（`:935-941`）；含 ASCII 字母数字与 `-_.` 以外字符 → `backup_id 包含非法字符`（`:943-948`，`a b`、`%zz`（decode 原样返回）、`备份`）。返回值是 trim 后的串，`' valid_id-1.0 '` 通过校验后进入下一检查。`BAD_IDS` 每个分支至少一个输入，另含两个通过校验的边界值。

### 3.2 清单组（inventory.json）

| 命令 | 可达 Err / 提前返回（按执行顺序） | empty 场景覆盖 | 需种子 |
|---|---|---|---|
| `get_backup_list` | 备份目录不存在 → `Ok([])`（`:1203-1206`，早退）；`list_backups` 失败 → `获取备份列表失败: {BackupError}`（`:1212-1215`，目录是文件时为 `IO error: …`）；任一清单 `checked_restore_disk_budget` 溢出 → 整个命令失败 `[E_RESTORE_DISK_BUDGET_OVERFLOW] …`（`:1222-1223`，`:84-101`）；`list_backups` 跳过无清单目录/坏清单并 warn、目录名覆盖 `manifest.backup_id`、按 `created_at` 降序（`backup/mod.rs:5698-5741`）；`recovery_kind`/`restorable` 由 `validate_for_slot_restore` 决定（`:73-79`） | 早退 `[]` | 目录为文件、溢出、混合清单 |
| `verify_backup` | §3.1；目录不存在 → `[E_BACKUP_DIR_MISSING] 备份目录不存在。…`（`:1414-1416`，`:69-73`）；锁；`获取备份列表失败: …`（`:1427-1429`）；`备份不存在: {id}`（`:1431-1434`）；`ensure_existing_path_within_backup_dir` 的 `解析备份根目录失败`/`解析备份路径失败`/`备份路径越界: …`（`:1437`，`:953-972`）；`verify_with_assets` 的 Err 不返回 Err，转为 `is_valid:false` 与错误列表（`:1443-1455`） | §3.1 全部 + 目录缺失 | 成功、校验失败、未找到、越界 |
| `check_disk_space_for_restore` | §3.1；目录缺失（`:1334-1336`）；`获取备份列表失败`（`:1339-1343`）；`未找到备份: {id}`（`:1345-1348`）；预算溢出（`:1351-1352`）；`[…] 数据空间管理器未初始化，无法确定恢复目标卷`（`:1357-1362`，正常启动不可达）；`恢复目标槽目录不存在或不是目录…`（`:1364-1368`）；`解析恢复目标卷失败`（`:1370-1371`）；`获取可用磁盘空间失败`（`:1372-1376`）。`available_bytes` 取真实卷剩余空间 | §3.1 全部 + 目录缺失 | 成功、未找到、溢出、目标槽缺失 |
| `auto_verify_latest_backup` | 目录缺失 → `[E_BACKUP_DIR_MISSING] 备份目录不存在，无法执行自动验证。…`（`:1503-1508`，与通用文案不同）；锁；列表失败（`:1519-1521`）；空 → `没有可用的备份，无法执行自动验证。请先创建一个备份`（`:1523-1525`）；`max_by(created_at)` 取最新（相同 `created_at` 时取最后一个）；成功后写审计日志（`:1572-1604`，`data_governance` feature） | 目录缺失 | 空目录、成功（含审计行） |
| `delete_backup` | §3.1；**先取锁**（`:1280-1283`）再判目录缺失（`:1288-1290`），与 verify 顺序相反；目标存在时越界检查（`:1295-1297`）；`删除备份失败: File not found: 备份不存在: {id}`（`:1300-1303`，`backup/mod.rs:5747-5752`）或 `IO error`（`remove_dir_all`） | §3.1 全部 + 目录缺失 | 成功、未找到、越界 |

### 3.3 导入（import.json，`commands_zip.rs:1210-1323`）

同步阶段（命令返回前）的顺序：
1. `backupId` 为 `Some` 时走 §3.1（`:1219-1222`），**先于**任何路径检查；`null`/省略跳过。
2. `reject_double_encoded_virtual_uri`（`:1225-1226`；`unified_file_manager.rs:423-433`）→ `路径像是双重编码的安全 URI，已拒绝以免破坏授权。请传入原始 content:// 地址`。
3. `queue_persistable_saf_uri`（`:1227-1228`；`unified_file_manager.rs:603-630`）：仅 `content://`（trim 后不区分大小写）进入；>8 KiB 或含 `\n`/`\r` → `SAF persist 队列拒绝过长或含换行的 URI`；否则**写队列文件**后返回 Ok。
4. 虚拟 URI（`content://`、`asset://`、`ph://`、`image://`、`camera://`、`primary:`/`secondary:`/`raw:`，`unified_file_manager.rs:16-19,413-416`）→ `ensure_local_path`，失败 → `无法读取 ZIP 文件: {e}`（`:1231-1242`）。桌面没有 ContentResolver，失败点在 `get_file_size`/`copy_file`，具体文案以 A 为准；`temp_zip_import/` 在此之前创建。
5. 本地路径：`validate_user_path`（`commands_backup.rs:643-659`）→ `路径中不允许包含 null 字节`、`路径中不允许包含 '..' 目录遍历`；不存在 → `ZIP 文件不存在: {sanitized}。请确认文件路径正确，或重新选择文件`（`:1246-1251`）。`file://…` 不是 special scheme，按字面本地路径处理；空串与相对路径相对进程 cwd 判断。
6. 通过后：`create_job` 同步 emit 一次 `backup-job-progress`（`bjm:885-890,974-984`）、写审计日志 `zip_import/{id|auto}`（`:1262-1286`），然后后台执行并返回 `{job_id, kind:"import", status:"queued", message}`。

后台阶段（`execute_zip_import_with_progress`，`:1328-1625`）只经事件与 `get_backup_job` 可见，不是命令 Err：`无法读取 ZIP 文件: {ZipExportError}`（`:1341-1347`）；密码解析失败（`:1348-1359`，含 `E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED`，`:91`）；等待全局锁/取消（`:1364-1369`）；`创建备份目录失败`（`:1389-1393`）；`backup_id 非法`（`:1406-1411`，自动生成 id 时不可达）；`备份路径校验失败` / `备份已存在: {id}`（`:1415-1424`）；扫描阶段取消（`:1439-1442`）；`ZIP 导入任务异常退出`（`:1480-1484`）；`ZIP 导入失败: {e}`（`:1584`，含"用户取消"时转 cancelled）并清理目标目录（`:1611-1618`）。`fail()` 持久化 `backup_jobs/<id>.json`（`bjm:626-629`）；`init_checkpoint` 在 `:1427`，在它之前失败的任务没有检查点。

**empty 下 `import_zip` 没有确定的成功场景。** 唯一不需要夹具的成功输入是一个存在的非 ZIP 路径（`pending-runner` 中用 `/`），它同步返回 queued，但后台失败事件与后续步骤存在竞态（第 1 步 `zip_contains_encrypted_secrets` 几乎立即失败），v0 没有等待原语时 A1/A2 自身都不稳定，所以放在 `pending-runner/`，不在顶层用不稳定场景冒充成功覆盖。

### 3.4 任务（jobs.json）

| 命令 | 可达 Err / 提前返回 | empty 场景覆盖 | 需种子/等待 |
|---|---|---|---|
| `list_backup_jobs` | 无 Err；内存 DashMap 迭代顺序（`bjm:917-922`）对多任务不稳定，见 §6 | `[]` | 多任务（runner） |
| `get_backup_job` | 无 Err；不存在 → `null`（`bjm:924-926`） | `null`（含空串、路径样 id） | 存在的任务（runner） |
| `list_resumable_jobs` | `load_persisted_jobs` 目录不存在 → `[]`（`bjm:1073-1077`）；`读取持久化目录失败`（`:1081-1082`）；跳过非 `.json`、`.tmp`、读/解析失败并 warn（`:1084-1117`）；只保留 Failed+有检查点（`:1162-1171`）；导入任务另算 `requires_password`，ZIP 读失败只 warn 为 false（`commands_backup.rs:2321-2353`） | `[]` | `l21-persisted-jobs-v1` |
| `resume_backup_job` | `load_persisted_jobs` 错误；`未找到可恢复的任务: {id}`（`:2408-2411`）；`任务状态为 {:?}，仅失败状态的任务可恢复。…`（`:2414-2419`，Debug 形如 `Completed`）；`任务没有检查点信息，无法恢复。…`（`:2421-2423`）；之后先 `restore_job_from_persisted`（**已建内存任务并 emit**，`:2426`）再判 `导入任务缺少 ZIP 路径参数`（`:2461-2463`）/ `ZIP 文件不存在: …`（`:2466-2471`）；导出分支 `unwrap_or_default` 解析参数后后台重跑 | 未找到 ×5（含带密码、null 密码） | 其余全部 |
| `cleanup_persisted_jobs` | `load_persisted_jobs` 错误；删 Completed/Cancelled，删除失败 warn 不计数（`bjm:1174-1193`）；按 `job_id` 而非文件名删除 | `0` | 计数 >0 |

### 3.5 诊断（diagnostics.json，`commands.rs`）

| 命令 | 可达 Err / 提前返回 | empty 覆盖 | 需种子 |
|---|---|---|---|
| `get_migration_status` | `refresh_schema_registry_from_live_state` → `刷新 SchemaRegistry 失败 ({path}): {e}`（`:182-193`，`:205-215`）；pending>0 且已初始化时生成 `last_error` 并 warn，pending>0 时用持久化真实迁移错误覆盖（`:752-801`） | 成功 | 刷新失败、pending、持久化错误 |
| `run_health_check` | `get_live_app_data_dir`；`refresh_schema_registry_from_dir` 同上（`:829-830`）；依赖失败/未初始化/待迁移/完整性检查失败（`数据库文件不存在`、`只读打开失败`、`quick_check: …`、`检测到外键约束违规` 等）都只写入 issues，不是 Err（`:893-930`）；审计健康快照（`:982-985`） | 成功 | 刷新失败、FK 违规 |
| `get_database_status` | **先刷新注册表**（`:1011`）再判 ID：`未知的数据库 ID: {id}。可选值: vfs, chat_v2, mistakes, llm_usage`（`:1013-1023`，大小写/空白敏感）；注册表无该库 → `null` | 4 个合法 id + 10 个未知 id | 刷新失败先于未知 id |
| `get_migration_diagnostic_report` | `get_live_app_data_dir`（`:1067`）；刷新失败（`:1068`）；其余审计库缺失/打开/查询失败都写进报告文本（`:1149-1194`）；串行跑 Slot C 空库与 Slot D 克隆迁移并把报告拼入（`:1199-1217`） | 成功 ×2（可重复） | 刷新失败、审计库失败 |

**WP-005 状态（不弱化）**：`get_migration_diagnostic_report` 在 B 端完整报告返回耗时 Node 13.19s / Electron 8.23s，原 5 秒断言仍红（`ab5efb96f`、`LANE.md` WP-005 节）。D-010：保持 `Result<String,String>` 同步完整报告，不改成 job 回执、不并发 C/D、不省略迁移。本场景按原 IPC 等待完整返回；runner 若对单步设超时，应把超时如实记为失败，不能当作通过或忽略。性能处置由 C2 / F3 后继 owner 裁定，与本场景无关。

## 4. 需要种子的场景（X3 owner；L21 给出精确需求）

种子都在隔离目录中构造；`<base>` 为 Rust `app_data_dir`（Linux 下 `~/.local/share/<identifier>`，对应 X3 `SeedDirectory.dataDir`）。备份根目录为 `<base>/recovery/backups`（`backup_config.rs:649-657`），任务持久化目录为 `<base>/backup_jobs`（`bjm:809,850-858`）。

### 4.1 备份目录类（`pending-seed/inventory-seeded.json`）

- `l21-backups-path-is-file`：`recovery/backups` 是普通文件。场景见 §4.1.1：这个状态只能在启动前存在，应用一启动就进入恢复模式。
- `l21-backups-empty-dir`：空目录。触发 `没有可用的备份…`、`备份不存在`、`未找到备份`。
- `l21-backups-mixed-v1`：由 A 在当前 checkout 用 `data_governance_run_backup`（`commands_backup.rs:1737`）产出一份完整备份，复制并改写为以下子目录（各清单 `created_at` 改为与目录名日期一致的 RFC3339 串，使 `auto_verify` 的 `max_by(created_at)` 先选中 `20260103`，删除后续步骤不改变它）：
  `20260101_000000_full_ok`（原样）、`20260102_000000_checksum_bad`（任一数据库文件翻转 1 字节）、`20260103_000000_dirname_mismatch`（`manifest.backup_id` 改为 `other_manifest_id`）、`20260104_000000_bad_manifest`（清单写非 JSON）、`20260105_000000_no_manifest`（无清单）、外加一个普通文件 `stray.txt`。`created_at` 必须为字符串比较可排序的值，种子须记录 A 构造 checkout SHA。
  **实现**（`host/e2e/data-compat/__fixtures__/a-produced-seeds.ts`）：A 的完整备份由服务器上跑 `a-produced/producers.v0.json` 产出，`a-produced/collect.ts` 逐文件 gzip 冻结并在 `PROVENANCE.json` 记录 A 构建回执、producer 套件 sha256 与 tree commit；种子只复制、改写冻结字节。清单改写只替换顶层 `"backup_id"` / `"created_at"` 两行（Rust `to_string_pretty` 两空格缩进，`backup/mod.rs:1615`），其余字节（含大整数）不动；`checksum_bad` 翻转的是第一个 `.db` 第 1 页指针数组与单元内容区之间的未分配字节，sha256 变了但库照常能打开，G3 快照器不报错。冻结前这 2 个种子（连同 legacy-mirror、historical-zip）不进 `SEED_NAMES`。B 端用本地 B 产出的备份空跑（`--local-check`，不提交）：清单只列 3 个有效目录、`checksum_bad` 校验失败、`dirname_mismatch` 按目录名校验成功、`auto_verify` 删除前后都选中 `20260103`，与设计一致；B 的 `checksum_bad` 把 4 个库全标 `校验失败`（只翻了 `chat_v2.db`），以 A 为准。
- `l21-backups-size-overflow`：一份清单 `files[].size` 为 `18446744073709551615` 与 `1`，覆盖整表溢出（JSON 大整数必须无损写入）。
- `l21-backups-symlink-escape`：`20260107_000000_symlink_out` 是指向备份根外目录（含合法清单）的符号链接，触发 `备份路径越界`。**与 X3 现约定冲突**：`SCENARIO-V0.md`（X3 工作树）规定比对器遇符号链接报错，需 X3/X7 决定是否允许该 seed 或改为只比 DB。

#### 4.1.1 `recovery/backups` 被文件占位（`pending-runner/backups-path-is-file-recovery.json`）

原场景的前提是“运行中备份根目录是文件”，这个状态到不了：Rust 每次启动都在 `migrate_legacy_slot_backups` 里 `create_dir_all(recovery/backups)`（`dstu-storage/src/data_space.rs:1212`），B 同样在 `host/platform/storage/data-space.ts:79` 建目录。路径是文件时 `create_dir_all` 报错，`init_data_space_manager` 失败，`lib.rs:963-972` 记 `data_space_init` 失败并直接返回，应用停在恢复模式：AppState、数据治理、备份任务管理器都不注册。B 对应 `host/platform/storage/startup.ts:28`。所以场景保留原 id，改为测“占位文件让启动进入恢复模式之后”的行为：

1. `get_startup_recovery_status`：`recovery_required:true`，`failed_operation:"data_space_init"`，`retry_requires_restart:true`；`recovery_error` 是 `io::Error` 的 Display（A 预期 `File exists (os error 17)`）。`list_startup_recovery_incidents` 为 `[]`：失败类 incident 只在内存里，不落盘。
2. `get_data_space_info` 报 `数据空间管理器未初始化`（storage README §5.3 的“种子就绪后加一步”）。
3. 5 条清单命令只取 `AppHandle`，恢复模式下照常执行，错误分支就是原场景要测的那些：list/check_disk/auto_verify 报 `获取备份列表失败: IO error: Not a directory (os error 20)`，verify 在取锁后报同一错误（`commands_backup.rs:1427-1429`），delete 走 `删除备份失败: File not found: 备份不存在: x1`。
4. `data_governance_list_backup_jobs` 需要 `State<BackupJobManagerState>`，它在恢复模式提前返回之后才注册（`lib.rs:1435-1452`），A 预期报 Tauri 的 state 未注册错误（§11 的“恢复模式种子就绪后加一步”）。
5. `retry_startup_recovery_preflight` 对需要重启的失败类型直接返回当前状态（`data_space.rs:275-285`），随后再读一次状态，incident 不变（storage README 里“需种子”的那条提前返回）。

B 端空跑（W21 本地探针，绕过录制器准备步骤）已暴露 3 处与上面 Rust 预期不同的地方，交各自 owner，以 A 实录为准：`recovery_error` 是 Node 文案 `EEXIST: file already exists, mkdir '<绝对路径>'`（W07）；verify 少了 `获取备份列表失败: ` 前缀（`host/plugins/backup/src/backup-commands.ts:145`，W08）；`list_backup_jobs` 返回 `[]`（W08，要保留就按 §7 登记 deliberate）。B 启动时另发一条 `host://plugins-degraded` 事件。

阻塞：录制器 `g3-run-b.mjs:126-127` 在第 0 步之前调 `vfs_set_indexing_config`，恢复模式下 B 没注册它（`… not allowed. Command not found`），准备步骤失败，整场景不执行；A 的同一步（`g3-run-a.mjs:164`）在恢复模式下也会因缺 State 失败。恢复模式下两侧都不启动索引 worker，W13 可在 `get_startup_recovery_status` 为 `recovery_required:true` 时跳过这一步并写进 trace。归一化候选（未写入）：`incident.incident_id`（`startup-preflight-<uuid v4>`）、`incident.created_at`（A 纳秒精度、B 毫秒精度）。

### 4.2 任务持久化（`pending-seed/jobs-persisted.json`，`l21-persisted-jobs-v1`）

`<base>/backup_jobs/` 下 `PersistedJob` JSON（`bjm:230-258`，可选字段缺省时省略）：`job-failed-ckpt-export`（export/failed/有检查点）、`job-failed-ckpt-import-nozip`（import/failed/有检查点/params 无 `zip_path`）、`job-failed-ckpt-import-missingzip`（`zip_path` 指向不存在路径）、`job-failed-nockpt`、`job-running`、`job-completed`、`job-cancelled`、一个 camelCase 别名字段的 completed 任务（`jobId`/`createdAt`）、一个文件名与 `job_id` 不一致的 completed 任务、一个非 JSON 内容的 `.json`、一个 `.json.tmp`、一个 `.txt`。第 2 个场景（导出续传）另需 §5 等待原语。

### 4.3 活动库类（`pending-seed/diagnostics-seeded.json`）

- `l21-live-vfs-not-sqlite`：活动槽 `databases/vfs.db` 为非 SQLite 字节，覆盖 `刷新 SchemaRegistry 失败` 及其先于 `未知的数据库 ID` 的顺序。启动阶段是否先失败/自修复以 A 为准；如 A 无法启动，此种子改为在运行中替换文件，需 X7 提供文件操作步骤。
- `l21-live-integrity-issues`：已初始化库中存在外键违规行，以及一个库的 refinery 历史缺最后一条迁移（pending>0），覆盖 issues 与 `last_error`。

### 4.4 历史 ZIP（`pending-seed/historical-zip.json`）

仓库没有 git tag，也没有提交过的 L21 备份 ZIP（唯一的 `.zip` 是 FSRS 的 Anki 集合），`zip.test.ts` 现场拼的 `old-*.zip` 不能作历史来源。

**方案**（W21，种子已实现）：`a-produced/producers.v0.json` 的 `w21.a-produce.historical-zips` 在 `empty` 种子上调用 `data_governance_backup_and_export_zip` 两次（便携 ZIP；`encryptionPassword` 密封 ZIP），各自用全局锁栅栏等后台任务结束再读 `get_backup_job`。ZIP 写到 `/tmp/w21-a-produced/`，`collect.ts` 确认两个任务 `completed` 后原样冻结，`PROVENANCE.json` 记录 sha256、密码与 A 构建回执。种子把两份 ZIP 放在 `<seed>/files/`（数据目录之外），`seedBindings()` 给出 `${seed.file.portableZip}`、`${seed.file.sealedZip}`、`${seed.secret.sealedZipPassword}`；录制器还不解析 `seed` 命名空间（W13）。默认用当前 A 参考构建（wp043 回执）；若 C1 指定某个历史提交，用 wp043 构建该提交、换成它的回执重跑同样两步即可，种子代码不变。服务器步骤见 `host/e2e/data-compat/__fixtures__/a-produced/README.md`。

### 4.5 快照器按设计拒绝的 5 个种子（未实现，交 X3/W13 决定）

`database-state.ts` 的 `enumerateDatabases` 遇符号链接直接抛错，把任何 `*.db` 文件当 SQLite 打开；g3-inputs 的种子指纹和 A/B 录制器的 `before`/`after`/`finalDatabases` 都走它，所以这 5 个种子一旦生成，整条场景在快照阶段就失败，与命令行为无关。建议：

| 种子 | 场景 | 建议 |
|---|---|---|
| `l21-backups-symlink-escape`、`l21-assets-root-symlink`、`l21-assets-nested-symlink` | `inventory-seeded` 1 个、`assets-seeded` 2 个 | 快照器把符号链接记成 `{kind:"symlink", target}` 条目（`readlink` 原文，不跟随），不再抛错；目标在种子目录外时只记文本。指纹（g3-inputs `seedDirectoryDigest`）同样按 `l:<name>:<target>` 计入。这样隔离性不受影响：快照器从不跟随链接 |
| `l21-assets-nested-fifo` | `assets-seeded` 1 个 | 遍历时 FIFO / socket / 设备记成 `{kind:"special"}` 条目，不 `open`（打开 FIFO 会阻塞）。种子用 `mkfifo` 生成（Node 无 API，需 `child_process` 调 `mkfifo`；macOS/Linux 都有），Windows 上不生成该种子 |
| `l21-live-vfs-not-sqlite` | `diagnostics-seeded`、`metadata-seeded` 各 1 个 | `snapshotDatabase` 打不开或文件头不是 `SQLite format 3\0` 时，记成 `{kind:"unreadable", size, sha256}` 而不是抛错；比较时按字节摘要比。A 若在启动阶段就把这个文件改掉/重建，快照里会看到两侧各自的结果 |

三项都改 `host/e2e/data-compat/__fixtures__/database-state.ts`（X3 快照器，比较器同步认新条目类型）与 `scripts/electron-migration/record/g3-inputs.mjs`（W13）。改好后 W21 再补这 5 个种子的生成代码并把 6 个场景移出 pending。

## 5. v0 表达不了的部分（X7 owner）

`pending-runner/import-job-lifecycle.json` 与 `pending-seed/jobs-persisted.json` 第 2 场景、`historical-zip.json` 需要：
1. **终态等待**：在每个返回 `BackupJobStartResponse` 的步骤之后，等待同 `job_id` 的 `backup-job-progress` 事件 `status ∈ {completed, failed, cancelled}`（`bjm:77-83`），再执行下一步。等待本身不能吞掉事件：事件序列、数量与顺序都要保留比较。不做此等待时，顶层用不稳定场景只会制造 A1/A2 差异。
2. **runner 参数**：`${runner.scratchDir}`（每场景独立、A/B 同名绝对路径，位于数据目录外且不在 `$HOME` 下，以免 sanitize 差异）与 `${runner.fixture.notZip}`（内容固定为 ASCII `not a zip\n` 的文件）。`${runner.scratchDir}/name.zip` 是**字符串拼接**，与 §1.1 的整串替换不同，需 X7 支持。
3. 场景要点：`directory_path_fails_async_without_checkpoint` 用 `/` 走后台 `无法读取 ZIP 文件`，失败早于 `init_checkpoint`，因此 `list_resumable_jobs` 不含它，`resume_backup_job` 报 `任务没有检查点信息`，`cleanup` 为 0，`get_backup_list` 仍为空（目录尚未创建）；round-trip 场景覆盖导入成功、`备份已存在`（第 8 步同 id 二次导入）、verify/check_disk/auto_verify 成功、delete 成功与再次删除失败；密封场景覆盖缺密码、错密码与正确密码三支。

## 6. 规范化候选（只列候选，未写入 normalize）

Rust 双录尚未完成，以下全部只是候选，须 A1/A2 实录后逐 scenario+JSONPath 交 C2：`job_id`（UUID v4，`bjm:885-890`，须跨返回/事件/`backup_jobs/<id>.json`/审计 `details.job_id` 一致映射）；自动 `backup_id`（`%Y%m%d_%H%M%S_<rand8>_<ms>_imported`，`commands_zip.rs:1396-1404`）；`created_at`/`started_at`/`finished_at`/`verified_at`/`checked_at`、诊断报告首行 `时间:`；`duration_ms`；`available_bytes`（真实卷剩余空间）；审计表 `id`/`timestamp`。`list_backup_jobs` 的 DashMap 顺序非确定，若多任务时需按 `job_id` 映射后比较集合，C2 裁定。错误文案、事件数量与顺序、DB storageClasses 不在候选之列。

## 7. 覆盖统计、剩余命令与阻塞

顶层可执行：16 场景 / 158 步，15 条命令全部有场景。成功分支直接覆盖：`get_backup_list`（空）、`list_backup_jobs`、`get_backup_job`（null）、`list_resumable_jobs`（空）、`cleanup_persisted_jobs`（0）、4 个诊断命令（空库状态、4 个合法 `databaseId`、两次完整报告）。错误/提前返回分支直接覆盖：§3.1 全部 6 类 × 4 命令、目录缺失 × 4 命令（含 auto_verify 专用文案与 delete 的锁后判断顺序）、`import_zip` 同步阶段全部 7 类、`resume` 未找到、`get_database_status` 未知 id、各命令 IPC 反序列化错误。

未在 empty 下覆盖、移入 `pending-*` 的：verify/check_disk/auto_verify/delete 的成功与“目录存在后”的全部分支；`import_zip` 成功与后台全部失败；`resume` 状态/检查点/ZIP 分支与成功；`cleanup` 非零；诊断的刷新失败与 issues。

剩余命令（本组之外，L21 共 33 条）：`restore_backup`、`restore_with_assets`、`run_backup`、`backup_tiered`、`backup_and_export_zip`、`export_zip`、`cancel_backup`、`verify_backup_with_assets`、`run_slot_c_empty_db_test`、`run_slot_d_clone_db_test`、`purge_all_data`、`cloud_config_test_connection_draft`（需 L23 模拟服务端点）。`scan_assets`、`get_asset_types`、`get_schema_registry`、`get_maintenance_status`、`get_audit_logs`、`cleanup_audit_logs` 已由 WP-129 补场景（§9）。

阻塞：历史 ZIP seed（X3，依赖 WP-043 A 端构建，§4.4）；§4.1–4.3 的 L21 种子（X3）；终态等待与 runner 参数（X7，§5）。

## 8. 复核方法

场景 JSON 由 `/tmp/opencode/wp073-gen.mjs` 生成（不提交），`/tmp/opencode/wp073-check.mjs` 经作业队列检查：JSON 可解析；顶层与场景键严格为 v0；id 全局唯一；顶层文件 seed 全为 `empty`、`pending-seed` 不为 `empty`；capture/normalize 固定；步骤键只含 `cmd/args/expect`；每个 cmd 在 `contracts/ipc/L21-backup-governance.json` 且在 `src/api/dataGovernance.ts` 有 invoke；`${n.…}` 指向更早非错误步骤，runner 参数只出现在 `pending-*`；成功步骤参数键为契约键子集（`ipc_args` 中故意的多余键除外）且必填齐全；每个文件声明的 commands 与实际使用一致。

## 9. WP-129：诊断元数据 / 资产 / 审计六命令

WP-129 只补以下 6 条命令的 v0 输入，不重做 WP-073，不含 `purge_all_data`、历史加密 ZIP、F4 backup-config handler。**没有执行任何 A/B 重放，没有一条命令因此成为 C。** 生成器 `/tmp/opencode/wp129-gen.mjs`（不提交），检查沿用 §8 的 `/tmp/opencode/wp073-check.mjs`。

### 9.1 前端 / Rust / B 端对应

Rust 路径相对 `src-tauri/src/data_governance/`；6 条均在 `src-tauri/src/lib.rs:3079-3085,3147-3148` 注册，B 端在 `host/plugins/backup/index.ts:203-243` 注册。

| 命令 | Rust | 前端（`dg.ts` = `src/api/dataGovernance.ts`） | B handler | 文件 |
|---|---|---|---|---|
| `data_governance_get_schema_registry` | `commands.rs:500` | `dg.ts:78`（仅 API 包装，未见组件调用） | `src/governance.ts:119` | metadata |
| `data_governance_get_maintenance_status` | `commands.rs:431` | `dg.ts:67`；`main.tsx:529`、`RecoveryCenter.tsx:165`、`DataGovernanceDashboard.tsx:886,1804`；直接 invoke `useSystemStatusSync.ts:27` | `index.ts:236` → `src/governance.ts:437` | metadata |
| `data_governance_get_audit_logs` | `commands.rs:530` | `dg.ts:129`；`DataGovernanceDashboard.tsx:1073,1096,1661`（`limit=50`，`offset` 为 0 或已加载条数） | `src/governance.ts:142` | audit |
| `data_governance_cleanup_audit_logs` | `commands.rs:599` | `dg.ts:155`（令牌 `AUDIT_CLEANUP_${Math.floor(Date.now()/1000)}`；仅 API 包装，未见组件调用） | `src/governance.ts:177` | audit |
| `data_governance_get_asset_types` | `commands_asset.rs:80` | `dg.ts:1111`（仅 API 包装） | `index.ts:79` → `src/assets.ts:9` | assets |
| `data_governance_scan_assets` | `commands_asset.rs:25` → `dstu-sync/.../backup/assets.rs:1556` | `dg.ts:1101`（仅 API 包装） | `index.ts:80` → `src/assets.ts:27` | assets |

本组没有辅助命令：顶层与 pending 场景只调用这 6 条命令。

### 9.2 可达成功 / Err / 早退逐项

| 命令 | 分支（按执行顺序） | 覆盖位置 |
|---|---|---|
| `get_schema_registry` | `get_live_app_data_dir`（正常启动不可达）；`refresh_schema_registry_from_dir` → `刷新 SchemaRegistry 失败 ({sanitized}): {e}`（`commands.rs:182-193`）；注册表写锁中毒（不可达，见 TESTMAP pending）；成功 | 成功 ×3：`metadata.json`；刷新失败：`pending-seed/metadata-seeded.json`（`l21-live-vfs-not-sqlite`）；待迁移状态：同文件 `l21-live-integrity-issues` |
| `get_maintenance_status` | `wait_startup_ready(120s)` 超时 → `应用启动初始化超时（120 秒），请重启应用`（启动完成后重放不可达）；`blocked_components` 逐组件；`current_operation` 取全局租约；`component_health`/`component_issues` 取启动健康 | 空闲成功 ×3：`metadata.json`；启动降级：`metadata-seeded.json`；非空 `current_operation`/`blocked_components` 需在另一治理操作持锁期间调用，v0 串行步骤表达不了（§9.4） |
| `get_audit_logs` | `get_conn`（Mutex 中毒，不可达）；`status` 非 `Started/Completed/Failed/Partial`（大小写、空白敏感）→ `无效的状态过滤值: {s}。可选值: Completed, Failed, Partial`（文案缺 `Started`，原样保留）；`limit` 缺省 100；`offset` 为 0 时不拼 OFFSET；COUNT 查询失败 / 行解析失败 → `查询审计日志失败: {AuditError}`；成功 | 成功、过滤、分页、`limit=0`、未知 `operationType`：`audit.json`；非法状态 ×7；`limit`/`offset`=10^19 拼入 SQL 超出 SQLite 整数（以 A 实际错误为准）；坏行（时间戳非 RFC3339、`operation_data` 非 JSON、`duration_ms` 为负）与容错行（`details` 非 JSON→null、未知 status→Started）：`pending-seed/audit-seeded.json` |
| `cleanup_audit_logs` | 前缀不是 `AUDIT_CLEANUP_` → `审计清理令牌格式无效，需要 AUDIT_CLEANUP_{unix_timestamp}`；后缀 `i64::from_str` 失败 → `审计清理令牌中的时间戳无效`；`abs(now-ts)>60` → `审计清理令牌已过期（差值 {diff}s，允许 60s 内）`；`keep_recent<100`、`before_days<7`（先 keep 后 days，各自独立判断）；`get_conn`；写 `cleanup_audit_logs_initiated` 审计行；`keep_recent` 优先，否则 `before_days` 缺省 90；删除失败写失败审计行并返回 `清理审计日志失败: {e}`；成功写完成审计行并返回删除数 | 取连接前的全部格式/解析/过期 Err：`audit.json`；阈值、成功、令牌窗口：`pending-runner/audit-cleanup-token.json` |
| `get_asset_types` | 无 Err、无参数；固定 10 项（`assets.rs:165-178`） | `assets.json` 成功 ×3（含多余键） |
| `scan_assets` | `get_active_data_dir`（DataSpaceManager 缺失时回退 `slots/slotA`）；`assetTypes` 逐项 `from_str` 过滤，未知项丢弃，过滤后为空 → 扫描全部；根不存在 → 跳过；根为符号链接或非目录 → `扫描资产失败: 配置无效: 资产扫描根不是普通目录: {绝对路径}`；`symlink_metadata` 其它 IO 错误；递归遇符号链接 / 非常规条目 → `扫描资产失败: IO 错误: 资产扫描不允许符号链接: …` / `…包含非常规条目: …`；成功 | 空库成功（缺省、null、空数组、10 个单类型、全集、重复、未知、大小写、空白、空串、混合）与 IPC 错误：`assets.json`；有文件计数、根为文件、根符号链接、内层符号链接、FIFO：`pending-seed/assets-seeded.json` |

所有命令共有的 IPC 层错误（缺必填键、类型不符、整数为负/小数/超出 u64）放在各文件 `ipc_args` 场景；多余键被忽略，由带 `unexpected` 的成功步骤覆盖。

### 9.3 副作用与捕获

- `get_schema_registry` 写内存注册表状态（不可直接观察）；`get_audit_logs`、`get_asset_types`、`scan_assets`、`get_maintenance_status` 只读。
- `cleanup_audit_logs` 写/删审计库 `databases/audit.db` 的 `__audit_log`（`init.rs:295`、`commands.rs:654-731`）。`capture.db:["*"]` 须包含 `audit.db`，请 X3/X7 确认；`audit.json` 每个错误场景末尾用 `get_audit_logs` 证明令牌拒绝早于取连接、没有写审计行。
- **文件副作用当前 db 捕获不足**：`scan_assets` 的输入是活动槽下的资产文件树，结果依赖树内容；资产种子需要 X3 对数据目录做树快照，单靠 DB 终态看不出种子是否一致。本组命令都不写文件树。

### 9.4 pending-runner：审计清理令牌（X7 owner）

`pending-runner/audit-cleanup-token.json` 需要：
1. `${runner.unixNow}`、`${runner.unixNowMinus30}`、`${runner.unixNowPlus30}`、`${runner.unixNowMinus120}`、`${runner.unixNowPlus120}`：在**该步派发时**计算的 Unix 秒，**字符串拼接**进 `AUDIT_CLEANUP_…`。固定令牌无法过 60 秒窗口，所以阈值、成功和清理计数都不能写进顶层。
2. **单步超时 + 进程隔离，并把挂起如实记为失败**。只读源码发现：Rust `cleanup_audit_logs` 在 `commands.rs:647` 取得 `audit_db.get_conn()` 的 `MutexGuard` 后，`:654` 的 `try_save_audit_log` 在 `:392` 对同一个 `Arc<AuditDatabase>` 的 `std::sync::Mutex` 再次加锁（`dstu-storage/src/audit/mod.rs:175-179`），守卫直到函数结束才释放。std 对同线程重入加锁的行为是死锁或 panic（未定义具体哪种）；该命令是同步命令。因此**令牌有效且通过阈值的每条路径**（本文件 7 个成功场景）在 A 上预计不返回，B 端正常返回删除数。这是 Rust 行为，按规则不修复，交协调者裁定如何记账；每个成功场景单独一个 scenario，避免一处挂起拖累其它场景。阈值拒绝在取连接之前，不受影响。
3. **panic 隔离**：`i64_overflow_tokens*` 两个场景的令牌使 `now_ts - token_ts`或 `.abs()`（`:618`）在 i64 上溢出。A 用 dev profile（overflow-checks 开）时 panic，release 下回绕。每个场景只有一步，需 runner 能隔离崩溃，A 的 profile 须在录制记录里写明。
4. 非空 `current_operation`/`blocked_components`：需要“另一治理操作持锁期间调用 `get_maintenance_status`”的并发原语，本包没写场景，待 X7 给出原语后补。

### 9.5 种子需求（X3 owner）

- `l21-audit-history-v1`（`databases/audit.db`）：由 A 在当前 checkout 实际执行备份/恢复/同步/迁移操作产出 ≥160 行 `__audit_log`，覆盖 5 种 `operation_type` × 4 种 status；为覆盖 `before_days`，须把一部分行的 `timestamp` 改到 10/40/100 天前，另含两行相同 `timestamp`。改时间戳属于种子构造，须在种子清单记录改动与 checkout SHA，不新增测试用 SQL 命令。
- `l21-audit-corrupt-rows-v1`：在上述库中再加 5 行，`operation_type` 分别为 `CorruptTimestamp`（timestamp 非 RFC3339）、`CorruptOperationData`（operation_data 非 JSON）、`NegativeDuration`（duration_ms=-1）、`CorruptDetails`（details 非 JSON）、`UnknownStatus`（status=`Weird`）；用 `operationType` 过滤可单独命中每一支。这些行只能直接写库构造。
- **两个审计种子的实现**（W21，`host/e2e/data-compat/__fixtures__/audit-seeds.ts`，场景已移到顶层 `audit-seeded.json`）：没有走“A 实跑再改时间戳”，而是按 `AuditRepository::save` 的精确编码直接写 160 行。原因：`save` 会把终态行折叠进同 target 最近一条 Started（`audit/mod.rs:239-273`），A 实跑永远留不下 Started/Partial 的组合；Sync 需要云端；160 行 × 20 组合只能构造。与 `historical-wp013-v1` 的 SQL 构造 `audit.db` 同一先例。编码核对有两道：A 读这份种子本身就是验证（坏行 4 支的报错文案直接来自 A 的解析）；`a-produced/collect.ts` 还从 A 的 producer 运行里取出 A 自己写的审计行，逐行比 `operation_data` 键序与值类型、时间戳形状、status 拼写，结果记在 `PROVENANCE.json` 的 `audit.mismatches`（B 本地 6 行为空），`g3-audit-seeds.test.ts` 在 A 产物冻结后断言其为空。时间戳固定：144 行在 2025 年、16 行在 2099 年，`before_days` 在任何录制日期切分都一样；`w21-audit-080`/`081` 时间戳相同。
- **启动折叠**（B 空跑实测，A 应同理）：启动时迁移协调器给 4 个核心库各写一条无 `job_id` 的 Migration/Completed，经上面的折叠写进同 target 最近一条 Started（`w21-audit-080/100/120/140`），所以录到的 status 分布是 Started 36、Completed 44，这 4 行的 `operation_data` 变成当前迁移版本、`duration_ms` 是实测耗时（A1/A2 本身就会不同，比较器按位置记不确定，不阻塞）。若种子里没有这些 target 的 Started，启动会插入 4 行录制时刻的新行，分页全错位，所以保留这个设计。B 空跑：`filters_paging` 17 步全部返回，`corrupt_rows` 前 4 步按 3 种解析错误报错、`CorruptDetails`/`UnknownStatus` 容错返回。
- `l21-assets-tree-v1`：活动槽（`<base>/slots/slotA`，以 DataSpaceManager 为准）下 `images/a.png`(100B)、`images/sub/b.png`(200B)、`images/empty/`、`documents/c.pdf`(0B)、`documents/.env`(5B，确认扫描不过滤敏感文件)、`audio/d.mp3`(1B)；`notes_assets/` 等其余目录不建。
- `l21-assets-root-is-file`：`images` 是普通文件，`documents/` 为空目录。
- `l21-assets-root-symlink`：`images` 是指向槽内目录的符号链接；`l21-assets-nested-symlink`：`images/link` 为符号链接；`l21-assets-nested-fifo`：`images/pipe` 为 FIFO。前两项**与 X3 “比对器遇符号链接报错”约定冲突**（同 §4.1），FIFO 同样需要 X3/X7 决定是否允许。
- `metadata-seeded.json` 复用 §4.3 的 `l21-live-vfs-not-sqlite`、`l21-live-integrity-issues`。

### 9.6 规范化候选（只列，未写入 normalize）

须 A1/A2 实录后交 C2：`aggregated_at`、`databases[].updated_at`；`databases` 数组顺序（Rust 迭代 `HashMap<DatabaseId,_>`，`commands.rs:509-521`，A 自身可能不稳定；B 按固定 `DATABASE_IDS`）；`scan_assets.by_type` 键序（`HashMap`）；审计 `logs[].id`/`timestamp`/`duration_ms`（启动迁移经 `coordinator.rs:264` 默认审计库写 Migration 行，空库预计非空）及相同 `timestamp` 时的行序；过期令牌错误文案里的 `差值 {diff}s`（`token_expired_live_diff` 场景单列，其余顶层场景不含时间相关文案）；资产错误文案中的绝对路径；`component_health` 若含时间字段。错误类别、事件数量与顺序、DB 行数不在候选之列。

### 9.7 静态比对发现的 A/B 差异候选（未改生产代码，供差分确认）

- 令牌解析：Rust `i64::from_str` 接受 `+0`、拒绝 `9223372036854775808`；B 原用 `/^-?\d+$/` + `Number`，相反（`audit.json` 已含这两个输入）。WP-148 已改为 i64 范围的 BigInt 解析与精确差值（`src/governance.ts` `parseI64`，`tests/audit-cleanup-token.test.ts`），仍待 A 实录确认。
- 上文 §9.4 的重入锁：A 预计挂起，B 正常返回。
- `scan_assets` 内层错误：Rust 的 `资产扫描不允许符号链接`/`非常规条目` 经 `AssetBackupError::Io` 显示为 `IO 错误: …`，B 一致加了前缀；根为符号链接时 Rust 走 `配置无效`，B 同。差分以 A 实录为准。

### 9.8 统计

| 范围 | 文件 | 场景 | 步骤（错误步） |
|---|---|---|---|
| 顶层可执行（本包） | 3 | 11 | 108（48） |
| `pending-runner`（本包） | 1 | 11 | 32（12） |
| `pending-seed`（本包） | 3 | 9 | 47（11） |
| 本包合计 | 7 | 31 | 187（71） |
| 本目录全部（含 WP-073） | 16 | 62 | 456（221） |

6 条目标命令都在顶层有场景（自有命令 6，辅助命令 0）。每条命令的步骤数，顶层：`get_schema_registry` 3、`get_maintenance_status` 3、`get_audit_logs` 45、`cleanup_audit_logs` 28、`get_asset_types` 3、`scan_assets` 26。

## 10. WP-234：G3 语料 v1（11 条命令 + 6 条补错误）

清单：`.oc-runs/board/corpus/WP-234-L21-backup-governance.md`，11 条都在 768 内。**本包没有执行任何 A/B 重放，没有一条命令因此成为 C。** 生成器 `/tmp/opencode/wp234-gen.mjs`，检查脚本 `/tmp/opencode/wp234-check.mjs`（即 §8 的检查，前端入口另含 `src/utils/cloudStorageApi.ts`），两者都不提交。另用 `scripts/electron-migration/record/scenario-v0.mjs` 的 `validateScenario` 校验了全部 30 个新场景。

### 10.1 前端 / Rust 入口

Rust 路径相对 `src-tauri/src/data_governance/`，`cloud_config_commands.rs` 在 `src-tauri/crates/dstu-sync/src/`。`dg.ts` = `src/api/dataGovernance.ts`。

| 命令 | Rust | 前端 |
|---|---|---|
| `data_governance_run_backup` | `commands_backup.rs:1737` | `dg.ts:229` |
| `data_governance_backup_tiered` | `commands_backup.rs:2538` | `dg.ts:707`；`DataImportExport.tsx:768,848`、`CloudStorageSection.tsx:943` |
| `data_governance_cancel_backup` | `commands_backup.rs:2249` → `bjm:901` | `dg.ts:378`；`DataGovernanceDashboard.tsx:1217`、`CloudStorageSection.tsx:870` |
| `data_governance_export_zip` | `commands_zip.rs:698` | `dg.ts:781`；`DataImportExport.tsx:780,1035`、`CloudStorageSection.tsx:962`、`DataGovernanceDashboard.tsx:1256` |
| `data_governance_restore_backup` | `commands_restore.rs:420` | `dg.ts:291`；`DataImportExport.tsx:894,992`、`CloudStorageSection.tsx:1146`、`DataGovernanceDashboard.tsx:1422` |
| `data_governance_restore_with_assets` | `commands_asset.rs:116` | `dg.ts:1137`（仅 API 包装） |
| `data_governance_verify_backup_with_assets` | `commands_asset.rs:138` | `dg.ts:1153`（仅 API 包装） |
| `data_governance_run_slot_c_empty_db_test` | `commands.rs:1279` | `dg.ts:1359`；`DataGovernanceDashboard.tsx:251` |
| `data_governance_run_slot_d_clone_db_test` | `commands.rs:1288` | `dg.ts:1368`；`DataGovernanceDashboard.tsx:285` |
| `data_governance_purge_all_data` | `commands_backup.rs:3047` | `dg.ts:1657`；`DataGovernanceDashboard.tsx:162` |
| `cloud_config_test_connection_draft` | `cloud_config_commands.rs:765` | `src/utils/cloudStorageApi.ts:496`；`CloudStorageSection.tsx:582` |

### 10.2 逐命令覆盖表

“成功”指顶层可执行文件中命令返回 Ok 的步骤；“错误”指可达的 Err / 提前返回分支。

| 命令 | 成功 | 错误 | 理由 / 位置 |
|---|---|---|---|
| `run_backup` | 有：`backup-lifecycle` 往返与 4 种参数变体 | 有：`backupType="incremental"` → `INCREMENTAL_BACKUP_REMOVED_MESSAGE`（`:1747-1749`，早于 create_job）；IPC 类型错误 | `"Incremental"`/`"weird"` 不命中早退，按 A 实际行为比较（`backup-errors`） |
| `backup_tiered` | 有：缺省、CloudStorageSection/DataImportExport 真实参数、未知层级与库名、空数组、全 null | 只有 IPC 反序列化错误 | 处理函数无业务 Err（`:2538-2610`）；未知层级只 warn 跳过（`:2672-2683`），后台失败只经事件与 `get_backup_job` 可见 |
| `cancel_backup` | 有：已完成任务首次请求（cancel_flag 置位）、排队任务取消、重复请求与未知 id → `false` | 只有 IPC 错误 | 处理函数恒 `Ok(bool)`（`:2249-2268`） |
| `export_zip` | 有：往返中导出真实备份；缺失备份的同步 queued ×6 | 有：`validate_backup_id` 全部分支、双重编码、SAF 换行/超长、null 字节、`..`、新设口令 <8、`useStoredCloudEncryptionPassword` 无已存密码、IPC 错误；后台“备份不存在”经 `get_backup_job` | 无存储密码时的文案依赖隔离 HOME 下安全存储的后端，以 A 为准 |
| `restore_backup` | 有：往返中恢复真实备份；缺失目录的 queued ×3 | 有：`validate_backup_id` 全部分支、IPC 错误；后台“备份目录不存在”（`commands_restore.rs:507-510`） | 恢复只写切槽标记，不重启 |
| `restore_with_assets` | **无，不可达** | 有：任意输入都返回停用文案；IPC 错误 | Rust 处理函数恒 `Err`（`commands_asset.rs:116-126`） |
| `verify_backup_with_assets` | 顶层无；`pending-seed/verify-with-assets-seeded.json` 有 | 有：目录缺失（无错误码前缀，`:150-152`）、`validate_backup_id`、IPC；往返中真实 id 与缺失 id | 见 §10.3 第 1 条 |
| `run_slot_c_empty_db_test` | 有 ×4（含重复与 C/D 交替顺序） | 无可达 | 唯一 Err 是 `get_live_app_data_dir`（`commands.rs:94-100`），启动后不可达；迁移失败写进 `report`，不是 Err |
| `run_slot_d_clone_db_test` | 有 ×4 | 无可达 | 同上 |
| `purge_all_data` | 只在 `pending-runner` | 无可达 | 成功分支调用 `app.restart()`，IPC 不返回（`:3047-3063`）；`写入清理标记失败` 需要 base 目录不可写，同时应用本身无法启动，不构造 |
| `cloud_config_test_connection_draft` | 只在 `pending-runner` | 有：口令门（含存量口令放行、空白口令）、webdav/s3/ftp 配置校验、`deny_unknown_fields`、未知 provider、缺凭据 `E_CLOUD_CREDENTIALS_UNAVAILABLE`、`127.0.0.1:9` 拒连 `E_CLOUD_CONNECTION_CHECK_FAILED`、IPC 错误 | 成功必须有可连的服务端，用 L23 本地云服务（§10.4） |

补错误的 6 条：

| 命令 | 新增错误场景 | 无可达分支的理由 |
|---|---|---|
| `backup_and_export_zip` | `zip-export-errors.json`：双重编码、SAF `\r`/超长、null 字节、`..`、缺 `outputPath`、各参数类型错误（均早于 create_job，`commands_zip.rs:221-262`） | — |
| `cleanup_persisted_jobs` | `pending-seed/jobs-dir-blocked.json`：`backup_jobs` 是普通文件 → `读取持久化目录失败`（`bjm:1081-1082`） | — |
| `list_resumable_jobs` | 同上 | — |
| `get_asset_types` | 无 | 返回 `Vec`，不是 `Result`（`commands_asset.rs:80`），无参数，多余键被忽略 |
| `get_maintenance_status` | 无 | 唯一 Err 是 `wait_startup_ready(120s)` 超时（`commands.rs:434-439`），启动完成后重放不可达 |
| `list_backup_jobs` | 无 | 恒 `Ok`，无参数（`commands_backup.rs:2300` → `bjm:917`） |

### 10.3 Rust 行为说明（未改生产代码）

1. `verify_backup_with_assets` 用 `get_backup_dir`（`<base>/recovery/backups`）列清单，越界检查却用 `app_data_dir.join("backups")`（`commands_asset.rs:173-174`）。新布局下没有 `<base>/backups`，`canonicalize` 预计以 `解析备份根目录失败` 失败，所以往返场景第 4 步标 `expect:"error"`，以 A 为准。成功需要 `<base>/backups/<id>` 镜像（种子 `l21-backups-legacy-mirror-v1`）。疑似 Rust bug，按规则保留。
2. **全局锁栅栏**：v0 没有等待原语。`delete_backup` 先 `acquire` 全局 semaphore 再判目录（`commands_backup.rs:1280-1290`），tokio semaphore 按 FIFO 排队，所以“提交后台任务 → 删除一个不存在的 id”会等前面的任务释放锁。前提是后台 `spawn` 在下一次 IPC 到达前已经排进锁队列。若 A1/A2 出现该竞态，表现为栅栏错误文案不同或 `${2.0.path}` 无法解析，应改用 §5 的终态等待，不能 normalize 掉。
3. 栅栏前采集的 `backup-job-progress` 事件条数可能随时序变化；终态（`get_backup_job`）应确定。事件数量、顺序不在规范化候选之列，差异交 C2。
4. `cancel_backup` 对已完成任务也返回 `true`：`request_cancel` 只对 cancel_flag 做 compare_exchange（`bjm:901-915`），不看状态。`cancel_queued_tiered_job` 中第 2 个任务被取消前是否已拿到锁取决于第 1 个任务的耗时，终态以 A 为准。

### 10.4 pending-runner（owner 见括号）

- `cloud-draft-success.json`（L23 + X7）：`${cloud.webdav.endpoint}` / `${cloud.s3.endpoint}` 由 `host/plugins/sync-providers/equivalence/__fixtures__/cloud-service.ts` 的 `resolve()` 替换（seed `basic`）。fake_dav 不校验口令，“错误口令被服务端拒绝”这一支无法表达，未写。
- `purge-all-data.json`（X7）：需要“命令触发重启后等待应用重新就绪再执行下一步”的原语，并把第 3 步记为“无返回 + 重启”。场景在隔离数据目录中运行，不触碰真实数据。

### 10.5 种子需求（X3 owner）

- `l21-backup-jobs-is-file-v1`：`<base>/backup_jobs` 是普通文件。若 A 启动阶段即因此失败，以 A 为准，再改为运行中替换。
- `l21-backups-legacy-mirror-v1`：在 §4.1 `l21-backups-mixed-v1` 基础上，把 `20260101_000000_full_ok`、`20260102_000000_checksum_bad` 两个目录复制到 `<base>/backups/`。已实现（`a-produced-seeds.ts`，与 mixed 同一份 A 备份；`slots/.legacy_migration_complete` 已写，启动不搬迁 `<base>/backups`）。B 用本地产物空跑：镜像存在时 `verify_with_assets` 对 full_ok 成功、对 checksum_bad 报 `校验和不匹配 chat_v2.db`；无镜像时 B 报 `解析备份根目录失败: ENOENT: …, lstat '<绝对路径>'`，Rust 应是 `io::Error` 文案，以 A 为准（W08）。

### 10.6 规范化候选（只列，未写入 normalize）

沿用 §6：`job_id`、自动生成的 `backup_id`（往返中经 `${2.0.path}` 传递，须跨返回/事件/审计一致映射）、各时间字段、`duration_ms`；Slot C/D `report` 中的 `({n}ms)` 与数据目录路径行；export 后台任务的临时文件名 `zip_export_<uuid>.zip`。

### 10.7 统计

| 范围 | 文件 | 场景 | 步骤（错误步） |
|---|---|---|---|
| 顶层可执行（本包） | 6 | 23 | 271（185） |
| `pending-runner`（本包） | 2 | 4 | 14（1） |
| `pending-seed`（本包） | 2 | 3 | 10（5） |
| 本包合计 | 10 | 30 | 295（191） |

11 条命令都有场景。顶层有成功步骤的 7 条：`run_backup`、`backup_tiered`、`cancel_backup`、`export_zip`、`restore_backup`、`run_slot_c_empty_db_test`、`run_slot_d_clone_db_test`（辅助命令 `get_backup_list`/`get_backup_job`/`list_backup_jobs`/`delete_backup` 不计入）；成功只在 pending 的 3 条：`verify_backup_with_assets`（种子）、`purge_all_data`（重启原语）、`cloud_config_test_connection_draft`（云服务）；成功不可达 1 条：`restore_with_assets`。有错误场景的 9 条（除 Slot C/D）；补错误的 6 条中 3 条已补，3 条写了无可达分支的理由。

## 11. WP-271：六条 768 命令的 Rust 可达 Err 判定

C1 扫描认定以下 6 条命令“无判定”。逐条读 Rust 后结论：**在 `seed:"empty"` 下都没有可达的业务 Err 或提前返回**，所以本包不新增 `g3w-*.json`，只在这里写理由。Rust 路径相对 `src-tauri/`，`dg.ts` = `src/api/dataGovernance.ts`。6 条命令在前端都是无参数 `invoke`（`dg.ts:61-69,399,1111,1358-1361,1367-1370,1657`、`src/app/hooks/useSystemStatusSync.ts:22-27`），Rust 签名也只取 `AppHandle`/`State`，没有要反序列化的参数，多余键会被忽略，所以不存在 IPC 参数错误。

下文多处要用到的两个前提：

- **setup 闭包首行的就绪守卫**：`src/lib.rs:838` 创建 `StartupReadyGuard`，它在 Drop 时调用 `mark_startup_ready()`（`crates/dstu-platform/src/startup_gate.rs:35-38,85-89`）。setup 的任何退出路径都会标记就绪，包括恢复模式的提前 `return Ok(())`。
- **数据目录解析**：`get_app_data_dir`（`src/data_governance/commands_backup.rs:30-34`）只有在 tauri `app_data_dir()` 返回 `UnknownPath` 时才失败（tauri-2.11.5 `src/path/desktop.rs:247-251`）。这要求 `XDG_DATA_HOME` 不是绝对路径、`HOME` 未设置或为空，并且 getpwuid_r 也查不到家目录（dirs-sys-0.5.0 `src/lib.rs:33-37`；dirs-6.0.0 `src/lin.rs:11`）。这属于进程环境故障，不是业务分支。setup 在同样情况下只 warn 并回退到临时目录（`src/lib.rs:855-868`），所以构造这种环境并不会让 setup 走不同路径。

| 命令 | 结论 | 依据 |
|---|---|---|
| `data_governance_get_asset_types` | 无可达 Err | `src/data_governance/commands_asset.rs:79-90`：同步函数，返回 `Vec<AssetTypeInfo>`，不是 `Result`；函数体只把 `AssetType::all()` 映射成结构体。`all()` 是固定 10 项的 `vec![…]`（`crates/dstu-sync/src/data_governance/backup/assets.rs:165-178`）。无参数，也不取 `State`，任何启动模式下都返回 Ok。 |
| `data_governance_get_maintenance_status` | 无可达 Err | `src/data_governance/commands.rs:430-439`：唯一的 Err 是 `wait_startup_ready(120s)` 超时 → `应用启动初始化超时（120 秒），请重启应用`。按上面第一条前提，setup 返回前就会标记就绪；`wait_startup_ready` 一进入就走 `is_startup_ready()` 快路径（`startup_gate.rs:46-49`），超时只会发生在 setup 自身卡住 120 秒以上的情况。其余状态全部经 `try_state` 读取，缺失时按“无阻塞/无健康快照”处理（`commands.rs:440-494`），不报错。 |
| `data_governance_list_backup_jobs` | 无可达业务 Err | `src/data_governance/commands_backup.rs:2299-2305`：函数体是 `Ok(job_manager.list_jobs())`；`list_jobs` 只遍历内存 DashMap，没有 `?`（`crates/dstu-sync/src/backup_job_manager.rs:917-922`）。处理函数外唯一的 Err 来自 `State<'_, BackupJobManagerState>` 提取失败（tauri-2.11.5 `src/state.rs:62-67`：`state not managed for field \`backup_job_state\` …`）。该 State 在 `src/lib.rs:1435-1452` 注册，位于全部恢复模式提前返回（`src/lib.rs:959,972,986,1043,1053,1062,1317`）之后，所以只有启动进入恢复模式时才会出现。`seed:"empty"` 不进入恢复模式；需要 X3 提供恢复模式种子（例如待处理的数据时间线冲突，`src/lib.rs:955-959`）后才能补这一步，做法与 WP-246 相同。 |
| `data_governance_purge_all_data` | 无可达 Err | `src/data_governance/commands_backup.rs:3047-3063`：Err 只有两个。① `get_app_data_dir` 失败（`:3051`），属于上面第二条前提里的环境故障。② `write_purge_marker` 失败 → `写入清理标记失败: …`（`:3054-3055`）；来源是 `create_dir_all` / `fs::write` 的 IO 错误（`crates/dstu-storage/src/startup_cleanup.rs:18-27`），属于 IO 故障。base 目录不可写时应用本身也无法启动（见 §10.2）。成功分支调用 `app.restart()`，IPC 不返回（`:3060`），由 `pending-runner/purge-all-data.json` 覆盖。 |
| `data_governance_run_slot_c_empty_db_test` | 无可达 Err | `src/data_governance/commands.rs:1278-1284`：唯一的 `?` 是 `get_live_app_data_dir`（`:94-100`）。有 `AppState` 时取 `get_writable_app_data_dir()`，返回 `PathBuf`，不可能失败，不可写时回退到临时目录（`crates/dstu-storage/src/file_manager.rs:167-169`）。没有 `AppState`（恢复模式）时回退到 `get_app_data_dir`，同样只会因环境故障失败。`run_slot_c_empty_db_test`（`commands.rs:225-269`）返回结构体而不是 `Result`：目录操作的错误被 `let _ =` 忽略，迁移失败写进 `report` 并令 `success:false`，命令仍返回 Ok。 |
| `data_governance_run_slot_d_clone_db_test` | 无可达 Err | `src/data_governance/commands.rs:1287-1293`：与 Slot C 相同，唯一的 `?` 是 `get_live_app_data_dir`。`run_slot_d_clone_db_test`（`commands.rs:271-379`）中源库缺失、快照失败（`复制文件时出错: …`，`:327-335`）都是 `return SlotMigrationTestResponse { success:false, … }`，即 Ok 返回，不是 Err；迁移失败同样写进 `report`。 |

`get_maintenance_status` 和两条 Slot 测试命令不取 `State`，所以在恢复模式下也不会出现 State 提取错误。`list_backup_jobs` 的恢复模式错误等 X3 恢复模式种子就绪后，在该种子上加一步 `{ "cmd": "data_governance_list_backup_jobs", "expect": "error" }` 即可。本节与 §10.2 “补错误的 6 条”表中的结论一致，并补充了文件:行依据；那张表里 `list_backup_jobs` 写的“恒 `Ok`”只针对处理函数本身。
