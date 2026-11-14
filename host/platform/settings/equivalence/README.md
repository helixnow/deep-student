# F4-security 等价场景 v0：设置与安全输入（WP-071）、日志与诊断（WP-237）

本目录只放 WAVE0 §3 v0 场景源文件，不含答案。A（Tauri+Rust）是答案机，B（Electron 宿主）重放后交给比较器。**本包没有执行任何 A/B 重放，没有任何命令因此达到 C 级。**

| 文件 | 场景 | 步骤 | 本包命令 |
|---|---|---|---|
| `backup-config.json` | 32 | 89 | `get_backup_config`、`set_backup_config` |
| `cloud-config.json` | 51 | 229 | `cloud_config_ssot_save`、`cloud_config_ssot_get`、`cloud_config_ssot_clear`、`cloud_config_publish` |
| `secure-credentials.json` | 26 | 90 | `secure_save_cloud_credentials`、`secure_get_cloud_credentials`、`secure_delete_cloud_credentials`、`secure_clear_cloud_encryption_password`、`secure_store_is_available` |
| `keystore-protection.json` | 5 | 17 | `secure_store_get_keystore_protection`、`secure_store_set_keystore_protection` |
| `platform-gated/keystore-enable.json` | 2 | 10 | `secure_store_set_keystore_protection`（`enabled:true`，见 §4） |
| `package-managers.json`（WP-237，domain `diagnostics`） | 11 | 51 | `check_package_manager`、`check_all_package_managers`、`auto_install_package_manager`、`check_test_dependencies`、`toggle_devtools` |
| `frontend-log.json`（WP-237，domain `log`） | 14 | 70 | `log_debug_message`、`report_frontend_log`、`tauri_lab_frontend_log`、`write_debug_logs` |
| `frontend-log-bounds.json`（WP-237，domain `log`） | 3 | 8 | `report_frontend_log`、`write_debug_logs` 的截断边界（大载荷单独成文件） |
| `debug-logs.json`（WP-237，domain `log`） | 14 | 56 | `get_debug_logs_info`、`clear_debug_logs`、`ensure_debug_log_dir`、`read_debug_log_file`、`open_logs_folder`（仅错误）、`export_diagnostics_bundle` |
| `platform-gated/open-logs-folder.json`（WP-237） | 5 | 5 | `open_logs_folder` 成功路径（会启动系统文件管理器，见 §7.4） |
| `platform-gated/package-install.json`（WP-237） | 2 | 4 | `auto_install_package_manager` 的 uv/cargo（可能联网安装，见 §7.4） |

WP-071 共 13 条命令、116 个场景、435 个步骤；WP-237 增加 15 条命令、49 个场景、194 个步骤，合计 28 条命令、165 个场景、629 个步骤。全部场景 `seed:"empty"`、`capture {events:true, db:["*"]}`、`normalize: []`。`expect:"error"` 只是标注，判定以 A 的实际结果为准。没有写任何期望返回值。

## 1. 运行器约定（交 X7 确认）

1. `${n.path}` 是整串引用，n 为同场景内 0 起步骤下标，只指向更早且未标 error 的步骤。替换为原始 JSON 值，不做字符串拼接。本目录用到 `${0.backupDirectory}` 等（值可能是 `null`）和 `${1.config}`（对象）。
2. 步骤里写成 `undefined` 的字段在 JSON 中已经省略，对应前端 `invoke` 序列化后的实际载荷。例如 `cloudStorageApi.ts:519` 的 `credentials` 只带非空字段。
3. **辅助步骤**不计入本包覆盖，只用来搭建前置状态：`save_setting {key:"backup.config", value}`，所有者 L19-mcp-browser（Rust `src-tauri/src/cmd/web_search.rs:541`，前端 `src/components/WebSearchAdvancedConfig.tsx:239`）。`backup.config` 不匹配 `SENSITIVE_KEY_PATTERNS`（`crates/dstu-security/src/secure_store.rs:134-150`），所以按 `dstu-storage/src/database/mod.rs:4230-4232` 落入 settings 表，和 `BackupConfig::load` 读的是同一行。本包不覆盖 `save_setting` 自身的分支，也不改它的所有者。
4. 这 13 条命令在 Rust 中都不发事件（`backup_config.rs`、`cloud_config_commands.rs`、`secure_store.rs` 均无 emit）。`events:true` 用来确认 B 也不发。
5. **DB 捕获不包含安全存储。** 凭据存在 `<app_data_dir>/.secure/*.enc`（`secure_store.rs:1293-1306`，命令经 `dstu-sync/src/cloud_credentials.rs:48-56` 用根 app_data_dir）。`db:["*"]` 看不到这些文件，所以每个写凭据的场景都用 `secure_get_cloud_credentials` 回读状态。建议运行器另外记录 `.secure/` 下的**文件名集合**（不记录内容，内容是带随机 nonce 的密文）。这一点交 X7/X3 决定。

## 2. 命令、调用点与分支

Rust 路径相对 `src-tauri/`。`ss.rs` = `crates/dstu-security/src/secure_store.rs`，`cc.rs` = `crates/dstu-sync/src/cloud_config_commands.rs`。B 端注册点：`host/platform/settings/backup-commands.ts:98,106`、`host/platform/errors/cloud-config-commands.ts:11-18`、`host/platform/secrets/commands.ts:20-34`。

所有命令共有的错误是 IPC 参数反序列化失败（缺键、类型错误、`deny_unknown_fields`），已作为错误步骤写入。

### get_backup_config / set_backup_config

- Rust：`src/backup_config.rs:115`（get），`:121`（set），`load :73-83`，`save :86-91`，结构体 `:27-53`，默认值 `:59-70`，`BackupTier` 在 `crates/dstu-sync/src/data_governance/backup/mod.rs:1935-1945`。
- 前端：`src/api/dataGovernance.ts:195,203`；UI 调用点 `src/features/settings/components/data-governance/BackupTab.tsx:217,243`。
- 分支和场景：
  - 无记录 → `Default`（`maxBackupCount: 5`，`interval: 24`）：`get.default_empty`。
  - 有记录 → 按 serde 解码：`full_roundtrip`、`stored_valid_extra_fields`、`stored_number_precision`、`seq_form`（serde_derive 也接受数组形式，短数组的尾部字段用 default）。
  - `set` 用 serde 字段级 default，和 `Default` 不同。`{}` 存进去后再读，`maxBackupCount` 是 `null` 不是 5：`empty_object_serde_defaults`、`partial_object_defaults`、`overwrite_replaces_whole_record`。
  - `backupTiers: None` 不序列化，`[]` 会序列化：`nulls_and_tiers_absent`、`tiers_empty_array`；别名归一化及重复项：`tiers_all_names_and_aliases`。
  - u32 边界 0 和 4294967295 成功，4294967296、-1、1.5、`"24"` 失败；非 Option 字段为 null 失败；未知 tier 及大小写失败；未知字段被忽略：`u32_bounds_success`、`number_type_errors`、`null_non_option_errors`、`tier_errors`、`unknown_fields_ignored`、`config_arg_errors`。
  - `load` 的 Err `AppError::internal("解析备份配置失败: …")`（`:77-78`）：`get.malformed_json`、`stored_null_bool`、`stored_duplicate_field`、`stored_float_interval`、`stored_exponent_interval`、`stored_u32_overflow`、`stored_unknown_tier`、`stored_trailing_chars`、`stored_empty_string`、`stored_json_null`、`stored_proto_tier`；写回修复：`repairs_malformed_store`。
  - 同值重存不更新 `updated_at`（`dstu-storage/src/database/mod.rs:4111-4115` 的 `WHERE settings.value IS NOT excluded.value`）：`same_value_resave`。
  - set 成功时 info 日志 `[AutoBackup] 配置已更新 …`（`:124-131`），差分观察不到，属于人工审读项。
  - 空种子下不可达：`database.get_setting/save_setting` 的数据库错误（`?` 透传）、`serde_json::to_string` 失败。

### cloud_config_ssot_save / cloud_config_ssot_get

- Rust：命令薄包装 `src/cloud_config_commands.rs:10,18`；实现 `cc.rs:561`（save）、`:576`（get）、`save_cloud_config_ssot_with_capabilities :499-516`、`load_… :528-545`、校验 `:214-278,314-427`、DTO `:47-111`（`deny_unknown_fields`）。
- 前端：`src/utils/cloudStorageApi.ts:441,447`；UI 链：`CloudStorageSection.tsx:332` → `resolveCloudStorageConfig`（`cloudStorageApi.ts:556` get，`:591` save）。
- save 分支（每条都有场景）：
  - WebDAV：endpoint 空/超 2048 字符/控制字符（`:214-236`），非 URL、非 http(s) 或无 host、内嵌凭据（`:238-256`），公网 http 无 `allowInsecure` 失败（`:326-332`），loopback 不保存 `allowInsecure`（`:343`），username 校验，root 归一化/穿越/超 256（`:258-278`）。
  - S3：`s3_supported`（当前桌面 default feature 含 `cloud_storage_s3`，`Cargo.toml:596`，不可达），公网 http 即使 `allowInsecure` 也失败（`:358-362`），bucket/accessKeyId/region 校验，`allowInsecure` 一律归一为 false，`pathStyle` 默认 false 且会序列化。
  - FTP：`ftp_supported`（桌面为 true，Android 分支不可达），`port==0`（`:393-397`），port 超 u16/负数/小数（serde），host 含 `://`、`/`、`@`、空白（`:399-407`），明文需 `allowInsecure`（`:409-414`，`:423`），loopback 判定 `localhost`/`::1`/`[::1]`。
  - 校验顺序：`error_precedence`。DTO 拒绝 `password`、未知 provider、大小写不符、缺字段：`secret_and_shape_errors`。
  - 覆盖与保持：`provider_switch_overwrites`、`invalid_keeps_previous`、`idempotent_resave_from_get`。
- get 分支：`NotConfigured` → `{configured:false}`（`:586-591`）：`get.not_configured`；成功形状见上面各 save 场景。
- 不可达或需种子：
  - `serialized configuration is too large`（`:507-511`）按字段上限不可达：WebDAV 最大约 2048×4+512×4+256×4 字节，小于 16384。
  - get 的 `stored configuration is too large` / `malformed` / 存量记录重新校验失败（`:536-543`）需要 settings 表里有非法的 `cloud_storage.config.safe_v1` 行。这一行不能经 `save_setting` 写入，因为 `cloud_storage` 前缀会被路由到安全存储（`secure_store.rs:143`、`database/mod.rs:4230`），所以需要 **X3 提供 settings 行种子**。
  - `Storage` 错误（数据库读写失败）：需要故障注入。

### cloud_config_ssot_clear

- Rust：`src/cloud_config_commands.rs:47`，`cc.rs:968-1022`；`delete_cloud_credentials_transactional` 在 `ss.rs:2698`。
- 前端：`cloudStorageApi.ts:451`；UI `CloudStorageSection.tsx:637`。
- 场景：`clear.empty`、`after_save`（含二次清除）、`after_publish_removes_credentials`、`credentials_without_ssot`。
- 不可达或需种子：读 SSOT 失败、`get_cloud_credentials` 失败（要有损坏的 `.enc` 或 `.key_seed`，需要 **X3/F4 安全目录种子**）、事务删除失败、删 SSOT 失败及凭据恢复并带 `data.credentialsRestored`（`:995-1014`，需要故障注入）。

### cloud_config_publish

- Rust：`src/cloud_config_commands.rs:27`，`cc.rs:832-965`；staged/commit 在 `ss.rs:2552-2664`。
- 前端：`cloudStorageApi.ts:519`；UI `CloudStorageSection.tsx:477`。
- 分支顺序：短口令门（`cc.rs:686-706`，先于一切）→ SSOT 快照 → 非敏感校验 → 读 active 凭据 → 当前 provider 无 secret 则 `E_CLOUD_CREDENTIALS_UNAVAILABLE`（`:865-884`）→ `write_staged`（弱口令门 `ss.rs:2275-2287` 在这里触发，错误带 `data.operation`）→ 保存 SSOT → commit。
- 场景：首发及 generation 1→2→3（`webdav_first`、`generation_increments_and_keeps_secret`）、清除后从 1 重新开始、`secure_delete` 只删 active 不删 generation 指针（`secure_delete_keeps_generation_pointer`）、provider secret 缺失或不匹配、短/弱口令（含 CJK 7 和 8 码点边界、trim）、`preexisting` 放行、`preexisting` 为 null/缺省/字符串、credentials 未知字段被忽略（无 `deny_unknown_fields`）及类型错误、`error_precedence`、`failures_keep_previous_state`、S3/FTP 发布、公网 http 准入。
- 不可达或需种子：读 SSOT 失败；损坏的 active `.enc`；generation 指针非数字或为 u64::MAX（`ss.rs:2518-2527,2563-2567`，指针只能经 commit 推进，需要 **安全目录种子**）；校验通过后 save SSOT 失败及 abort 失败的 warn（`:898-908`）；commit 失败后恢复 SSOT 并带 `data.ssotRestored`（`:912-936`，需要并发或故障注入）。

### secure_save_cloud_credentials / secure_get_cloud_credentials / secure_clear_cloud_encryption_password / secure_delete_cloud_credentials

- Rust：`src/secure_store.rs:26,42,66,59`；`ss.rs:2447-2463`（合并保存）、`:2465-2474`（状态）、`:2480-2494`（清加密）、`:2496-2498`（删除），错误映射 `:97-111`（`data.operation`，`retryable`）。
- 前端：`cloudStorageApi.ts:1077,1087,1097,1105`；UI：保存在 `cloudStorageApi.ts:589`（legacy 迁移，`preexisting:true`），状态在 `CloudStorageSection.tsx:373,504` 和 `stores/syncStatusStore.ts:408`，清加密在 `CloudStorageSection.tsx:684`。`deleteCredentials`（`cloudStorageApi.ts:1103`）只有 wrapper，`src/` 中没有 UI 调用点（见 §5）。
- 场景：
  - 合并语义：空串或空白表示保留现有值（`apply_nonempty_update :2356-2391`）；合并后没有任何 secret 时改为删除（`:2457-2461`）。
  - null 字段等同缺省；未知字段被忽略；类型错误。
  - 短口令（`E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT`，trim 后按码点计数，含 emoji 和 CJK 边界）；弱口令黑名单（小写化 + trim）和不同字符数少于 4；短口令先于弱口令判定；`preexisting:true` 跳过两道门，缺省或 null 时按 false。
  - 被拒的更新不改变已存值。
  - 清加密：空库返回全 false（`:2483-2485`）；保留传输凭据；只有加密密码时删除整条记录。
  - 删除：空库幂等（NotFound 忽略 `:1382-1388`）；不影响 SSOT。
- 不可达或需种子：损坏或过大的 `.enc`、`.key_seed` 为目录或符号链接、为空、过大、带 DPAPI 前缀（`ss.rs:701-760`）；remove 时遇到非 NotFound 错误；序列化失败。需要 **X3/F4 安全目录种子**，或在只读目录下运行。

### secure_store_is_available

- Rust：`src/secure_store.rs:77`，`ss.rs:1420-1436`（`get_device_key` 失败时返回 false 并 warn）。
- 前端：`cloudStorageApi.ts:1116`（只有 wrapper，见 §5）。
- 场景：`available.empty_store`（空库调用会**创建** `.key_seed`，这是副作用）、`available.after_save`。返回 false 的分支需要损坏的种子（同上）。

### secure_store_get_keystore_protection / secure_store_set_keystore_protection

- Rust：`src/secure_store.rs:84,96`；`ss.rs:1444-1468`（状态，只读文件，不碰密钥库）、`:1470-1519`（开关）、`keystore_supported :391-396`。
- 前端：`src/features/settings/components/SystemPermissionsSection.tsx:162,171`，在 `GeneralTab.tsx:262` 渲染。契约 `contracts/ipc/F4-security.json` 把这两条写成 `frontend:"none"`，与源码不符（见 §5）。
- 场景：空库状态；`set(false)` 在无标记时成功并创建种子（`:1488-1517`）；参数类型错误。
- `enabled:true`、标记删除失败、回迁未完成：见 §4。

## 3. 规范化候选（只是候选，没有写进 normalize）

- settings 表 `updated_at`（`Utc::now().to_rfc3339()`，`database/mod.rs:4116`）：等 A 双录后由比较器自动识别。`same_value_resave` 用来验证"同值不更新"这个语义，规则不能把这一列整列忽略。
- 返回值中没有时间或随机 id。generation 是确定的计数，**不能规范化**。

## 4. 平台门控（如实 blocked）

`platform-gated/keystore-enable.json` 会把种子写入**真实的平台密钥库**（Linux Secret Service，服务名 `deep-student`）。本服务器没有会话 D-Bus（`DBUS_SESSION_BUS_ADDRESS` 为空），也没有 secret-service 进程。直接运行时，A 端结果只会是 `KeychainUnavailable` 这一条分支，而且在开发者桌面上运行有写入真实钥匙串的风险。所以这些场景单独放在子目录，不在 `equivalence/*.json` 的默认 glob 里。运行条件如下：

- 每个实例使用隔离的 `dbus-run-session` + `gnome-keyring-daemon --unlock`（空口令），A/B 两端各自独立；或者
- 设置 `DEEP_STUDENT_KEY_SEED_FILE_ONLY=1`，这样只覆盖 `PlatformUnsupported` 分支（`ss.rs:1474-1479`）。A/B 两端必须使用同一个环境变量。

Windows DPAPI 与 macOS Keychain 的分支在 Linux 上不可达，状态为 **blocked（平台）**，留给对应平台录制。

## 5. 范围、剩余与发现

**纳入（13）**：上面列出的命令都有 Rust 注册（`src/lib.rs:2219-2220,2241-2247,3104-3108`）和 `src/` 中的 invoke。其中 `secure_delete_cloud_credentials`、`secure_store_is_available` 只有 wrapper，没有 UI 调用点；契约记为 `frontend:"app"`，所以计入。是否从 765 中剔除由协调者决定。

**不纳入**：
- `cloud_config_test_connection_draft`：属于 L21-backup-governance 契约，并且需要网络。
- `save_setting` / `get_setting`：属于 L19 的同名通用设置，只作为辅助步骤使用。
- `get_auto_backup_status`：契约记为 `frontend:"app"`（`src/api/dataGovernance.ts:207`），但 Rust **没有注册**这条命令（`src/lib.rs` 的 `generate_handler!` 中没有它，只有 `backup_config.rs:231` 的函数定义），A 端调用会返回 command not found。WP-126 起 B 端同样不注册（`settings/backup-commands.ts` 的 `meta.commands` 只含 Rust 注册的五条），调用经 kernel 返回同一 command not found；本包不编写成功场景冒充覆盖。
- 无前端调用（契约 `frontend:"none"`，`src/` 中也没有 invoke）：`pick_backup_directory`、`clear_backup_directory`、`get_default_backup_directory`、`secret_prompt_submit/status/discard/capabilities`。

**F4 剩余命令（后续包）**：日志组 `cleanup_old_debug_logs`、`save_test_log`、`get_test_logs`、`open_log_file`；诊断组 `debug_get_database_stats`、`debug_vfs_textbook_pages`、`debug_vfs_migration_status`、`write_test_report`；以及上面不纳入的 8 条。WP-237 已覆盖的 15 条见 §7。

**需要别的域提供**：
- X3：settings 表中非法的 `cloud_storage.config.safe_v1` 行种子。
- X3/F4：`.secure/` 下损坏的 `.enc`、`.key_seed`、generation 指针种子。生成损坏的 `.enc` 必须使用 A 端密钥，应由 A 录制产出。
- X7：§1.5 中 `.secure` 文件名集合的捕获。
- 隔离的 Secret Service 运行环境（§4）。

## 6. 最小校验

场景 JSON 由临时脚本生成（不提交）。校验脚本经作业队列运行，检查以下各项：

- JSON 可解析，顶层与场景键严格符合 v0。
- id 全局唯一，seed、capture、normalize 都是固定值。
- 每步 cmd 在 F4 契约中，或是 L19 辅助命令 `save_setting`。
- 成功步骤的参数键是契约键的子集，且必填键齐全。
- `${n…}` 只指向更早的非错误步骤。
- 每个列出的命令都被使用过。

作业 `20261105161753-6b6273` exit 0：5 个文件、116 个场景、435 个步骤，CHECK OK。各命令的成功/错误步骤数如下（同一场景内的回读也计入）：

| 命令 | 场景 | 成功步骤 | 错误步骤 |
|---|---|---|---|
| get_backup_config | 32 | 26 | 12 |
| set_backup_config | 18 | 19 | 18 |
| cloud_config_ssot_save | 31 | 36 | 57 |
| cloud_config_ssot_get | 47 | 57 | 0 |
| cloud_config_ssot_clear | 5 | 6 | 0 |
| cloud_config_publish | 18 | 24 | 28 |
| secure_save_cloud_credentials | 27 | 30 | 22 |
| secure_get_cloud_credentials | 46 | 51 | 0 |
| secure_clear_cloud_encryption_password | 4 | 6 | 0 |
| secure_delete_cloud_credentials | 4 | 5 | 0 |
| secure_store_is_available | 4 | 5 | 0 |
| secure_store_get_keystore_protection | 7 | 9 | 0 |
| secure_store_set_keystore_protection | 5 | 6 | 4 |
| save_setting（L19 辅助，不计） | 14 | 14 | 0 |

错误步骤数为 0 的命令，其可达 Err 都需要 §2 所列的种子或故障注入，空种子下没有可触发的错误输入（参数反序列化除外：这些命令都没有参数）。

**D-170（WP-237）**：WP-071 的无参命令步骤省略了 `args`，v0 `validateScenario` 要求每步显式带 `args`，导致 116 个场景全部无效。177 个步骤补了 `"args": {}`，其余字段和顺序都没动（前端 `invoke('cmd')` 与 `invoke('cmd', {})` 发出的载荷相同）。这些步骤所属命令的契约参数都是 `[]`。`get_backup_config` 的 12 个错误步骤由前一步 `save_setting` 写入的坏记录触发，没有一步是有意测缺参的。全目录 validateScenario 统计：改前作业 `20261106040045-1d3494` 无效 116，改后作业 `20261106040225-905f72` 无效 0。

## 7. 日志与诊断组（WP-237）

Rust 路径相对 `src-tauri/`。`cmd.rs` = `src/commands.rs`，`dbg.rs` = `src/debug_commands.rs`，`pm.rs` = `crates/dstu-platform/src/package_manager.rs`，`dl.rs` = `crates/dstu-platform/src/debug_logger.rs`，`dls.rs` = `crates/dstu-platform/src/debug_log_service.rs`，`diag.rs` = `src/diagnostics.rs`。B 端注册点：`host/platform/diagnostics/index.ts`、`diagnostics/devtools.ts`、`diagnostics/database-commands.ts`、`host/platform/log/commands.ts`。命令都注册在 `src/lib.rs:2025-2029,2212-2215,2258-2268,2406-2415`；`toggle_devtools` 只在 `debug_assertions` 或 `devtools` feature 下注册（`lib.rs:2267`），A 端 dev profile 满足。

这些命令都不发事件，也不写数据库；`events:true`、`db:["*"]` 用来确认 B 同样不发、不写。日志文件内容（`<log_root>/frontend/*_frontend.log`、主日志）不在捕获范围内，脱敏和截断的结果属于人工审读项，或由运行器另行捕获 `<log_root>` 文件集合（交 X7 决定）。

### 7.1 逐命令覆盖

| 命令 | Rust | 前端调用 | 成功场景 | 错误/提前返回场景 | 未覆盖分支与理由 |
|---|---|---|---|---|---|
| `check_package_manager` | `cmd.rs:7098`，`pm.rs:252` | `src/utils/systemApi.ts:418` | `npx_variants`、`uv_variants`、`python_variants`、`cargo`（四个 detected 分支）；`not_detected`（`None` 分支，含后缀不匹配、首尾空白、Unicode 小写化） | `arg_errors`（缺键、null、数字、错键名） | 无。`is_available`/`version` 取决于主机 PATH，A/B 同机运行时一致 |
| `check_all_package_managers` | `cmd.rs:7131` | `systemApi.ts:445` | `check_all.basic` | 无参数，没有 Err 路径 | 无 |
| `auto_install_package_manager` | `cmd.rs:7119`，`pm.rs:366` | `systemApi.ts:431` | `auto_install.unsupported`（`Ok(None)` 提前返回，返回值 `success:false` 但 IPC 成功）；gated `auto_install.uv`/`cargo`（已安装提前返回，或执行安装） | `arg_errors` | `spawn_blocking` 的 `Err(JoinError)` 不可达；安装执行、超时、失败分支会联网改主机，见 §7.4 |
| `check_test_dependencies` | `cmd.rs:7403`，`src/test_utils/health_check.rs:87` | `src/utils/testMode.ts:143` | `test_dependencies.basic` | 函数恒返回 `Ok` | 数据库不可用分支需故障注入。prometheus 探测 `127.0.0.1:59321`，未监听时走 `Request failed` 分支 |
| `toggle_devtools` | `dbg.rs:475` | `src/dev/devtools.ts:21` | `toggle_cycle`（true/false/true/false） | 函数体恒返回 `Ok` | `WebviewWindow` 参数提取错误只在 macOS/Windows 打开内置浏览器后可达，见 §8 |
| `log_debug_message` | `dbg.rs:155` | `src/features/workbench/core/wallpaperDiagnostics.ts:50` | `debug_message.basic` | `debug_message.arg_errors` | info/println 输出属人工审读项 |
| `report_frontend_log` | `cmd.rs:6520`，载荷 `:6450`，截断 `:6464-6498`，级别 `:6502-6516` | `src/logging/errorReporter.ts:232`、`src/features/learning-hub/apps/views/media/useMediaPlayback.ts:160`、`src/lib.rs:500` | `full_payload`、`minimal_and_nulls`、`levels`（含未知级别回落 ERROR）、`url_and_redaction`、`extra_bounds`（深度 4、40 键、20 项、8000 字符）、bounds 文件里的长度上限 | `arg_errors`（缺 payload、null、非对象、缺 message、u32 越界、负数、小数、类型错误） | `前端日志记录器未初始化`（`:6547`）：A 端 setup 的正常路径（`lib.rs:1068`）和每条恢复模式提前返回（`:957-1060`）都会先调用 `init_global_logger`，不可达 |
| `tauri_lab_frontend_log` | `dbg.rs:164` | `src/main.tsx:167` | `tauri_lab.no_env_noop`（未设置 `TAURI_LAB_*` 时提前返回 `Ok`） | `tauri_lab.arg_errors` | 写文件分支及其 `create_dir_all`/`open`/`write` 错误由环境变量 `TAURI_LAB_FRONTEND_LOG` 决定；录制器会删除 `TAURI_LAB_INSTANCE_ID`（`scripts/electron-migration/record/tauri-first-command.mjs:54`），A/B 需设置同一路径才能覆盖，交 X7 决定 |
| `write_debug_logs` | `dl.rs:893`，`write_frontend_entries :503-566` | `src/utils/debugLogger.ts:535` | `full_entry`、`empty`（空批提前返回）、`levels_and_optionals`（含外部标签形式 `{"WARN":null}`）、bounds 文件里的字段截断、256 KiB 条目替换、501 条批次截断并插入 `LOG_BATCH_TRUNCATED` | `arg_errors`（小写/未知级别、缺 timestamp/module/operation/data、类型错误、数组混入非对象） | 写文件 IO 错误需故障注入。缺 `data` 时 serde 对 `serde_json::Value` 的处理以 A 实际结果为准，场景只标注 error |
| `get_debug_logs_info` | `cmd.rs:604`，`dls.rs:591` | `src/features/settings/components/GeneralTab.tsx:192` | `info_empty`、`ensure_then_info_clear` | 等待写入超时（`dls.rs:322`，10 秒）需并发注入，不可达 | 有文件的统计需要 `debug-logs/*.json` 种子（§7.3） |
| `clear_debug_logs` | `cmd.rs:616`，`dls.rs:619` | `GeneralTab.tsx:756` | `info_empty`、`ensure_then_info_clear`（删除 0 个） | 同上超时，不可达 | 删除非零个需要种子（§7.3） |
| `ensure_debug_log_dir` | `cmd.rs:637`，`dls.rs:303` | `GeneralTab.tsx:737` | `ensure_then_info_clear`、`read_dir_itself`、`export_include_debug_logs` | 恒返回 `Ok`（`create_dir_all` 错误被忽略） | 返回值是绝对路径，依赖实例数据目录，比较器需按实例根目录归一（候选，未写入 normalize） |
| `read_debug_log_file` | `cmd.rs:645`，`dls.rs:694` | `src/features/chat/components/message/RawRequestPreview.tsx:64,311` | **无** | `read_dir_itself`（目录在白名单内但扩展名不是 .json）、`read_errors`（canonicalize 失败、不在 debug-logs 内）、`read_arg_errors` | 成功和 `读取调试日志失败` 都需要 `debug-logs/*.json` 文件。这些文件只由 LLM 调试模式写入（`dstu-llm/src/llm_manager/model2_pipeline.rs:3919`、`dstu-qbank/src/qbank_generation/pipeline.rs:139`），需要种子（§7.3） |
| `open_logs_folder` | `cmd.rs:6404` | `GeneralTab.tsx:566` | gated `open_all/backend/frontend/debug/crash` | `logs_folder.arg_errors`（`不支持的日志类型`，大小写、空串、首尾空白、缺键、null、错键名） | 成功路径会启动系统文件管理器，见 §7.4。`创建日志目录失败` 需只读日志根，需故障注入 |
| `export_diagnostics_bundle` | `diag.rs:448`，`export_bundle_sync :289-445`，`collect_sources :226` | `src/logging/exportDiagnostics.ts:47` | `export_default`、`export_include_debug_logs`、`export_replace_existing`（覆盖已有文件分支）、`export_after_frontend_logs`、`export_path_shapes`（新建多级父目录、`..`、中文和空格、无扩展名、未知字段被忽略） | `export_destination_errors`（相对路径、空串、`~`、`/` 与 `/tmp` 为目录、`/proc` 下创建失败）、`export_parent_is_file`（`创建保存目录失败`）、`export_arg_errors` | `诊断包保存路径无效`：绝对路径只有 `/` 没有父目录，但它先被 `is_dir` 拦下，不可达。zip 写入、rename 失败及恢复失败需故障注入。超时分支同上 |

`get_auto_backup_status`（`src/backup_config.rs:232`，前端 `src/api/dataGovernance.ts:207`）：Rust 没有注册（见 §5），A 端只会返回 command not found，不写场景。建议协调者把它从 G3 的 768 中剔除，或记为"Rust 未注册"例外。

### 7.2 运行器约定（交 X7 确认）

1. `export_diagnostics_bundle` 的目的地是固定绝对路径 `/tmp/ds-equivalence-diagnostics/<场景名>.zip`，因为 v0 没有实例目录占位符。运行器需要在每个场景前清空这个目录，并且同一场景的 A/B 不能并行；否则 `export_replace_existing` 和 `export_default` 会因为上一次运行留下的文件走到不同分支。若 X7 提供实例临时目录占位符，就改用占位符。
2. 诊断包返回值中的 `fileCount`、`skippedCount`、`sizeBytes` 取决于运行期间日志目录里有什么，A/B 主日志的内容天然不同。这是规范化**候选**，没有写进 normalize；需要 A1/A2 原始差异，并由 C2 决定。`path` 原样回显输入字符串（不做规范化），不能忽略。
3. `check_test_dependencies` 的 `details` 来自 `HashMap`，键顺序不确定；`latency_ms` 是耗时。这两项都是候选。
4. `check_package_manager`、`check_all_package_managers` 的 `is_available`/`version` 取决于主机 PATH（`which`）。A/B 必须在同一台主机、使用同一个 PATH 运行。

### 7.3 需要别的域提供

- X3：在 `<log_root>/debug-logs/`（Linux 上是 `app_log_dir`）放一个合法的 `.json` 调试日志种子，再放一个无法读成 UTF-8 的 `.json`。有了它们，`read_debug_log_file` 的成功分支与 `读取调试日志失败` 分支、`clear_debug_logs` 删除非零个、`get_debug_logs_info` 的非空统计才能写场景。另一种做法是通过 X5 的 LLM 模拟服务开启调试模式，用 L01 的流程产生调试日志。

### 7.4 平台门控（不在默认 glob 里）

- `platform-gated/package-install.json`：本机 `uv` 不存在（`command -v uv` 为空），A 端会执行 `curl -LsSf https://astral.sh/uv/install.sh | sh`，联网并修改主机。`cargo` 在 dev 机存在，所以会走"已安装"提前返回，但沙箱 PATH 里没有 cargo 时就会联网安装 rustup。只能在一次性容器里运行，或者先确认目标已经安装。
- `platform-gated/open-logs-folder.json`：A 端在 Linux 上执行 `xdg-open <目录>`。本机没有 `xdg-open`，所以结果是 `打开日志文件夹失败`；在有桌面环境的机器上，它会弹出文件管理器窗口。B 端的打开方式必须与 A 在同一环境下比较。

### 7.5 校验

`/tmp/opencode/F4-check-wp237.mjs`（临时脚本，不提交）经作业队列运行，检查的内容与 §6 相同；另外检查引用只指向更早的非错误步骤，并允许回读/搭建用的辅助命令。作业 `20261106041523-321792` exit 0：11 个文件、165 个场景、629 个步骤，CHECK OK。以下 3 个成功步骤故意带了契约外的顶层键，用来确认 Tauri 会忽略未知顶层参数：`diagnostics.pm.check_all.basic#1`、`diagnostics.test_dependencies.basic#1`、`diagnostics.devtools.toggle_cycle#2`。

| 命令 | 场景 | 成功步骤 | 错误步骤 |
|---|---|---|---|
| check_package_manager | 8 | 28 | 4 |
| check_all_package_managers | 1 | 2 | 0 |
| auto_install_package_manager | 4 | 11 | 4 |
| check_test_dependencies | 1 | 2 | 0 |
| toggle_devtools | 1 | 4 | 0 |
| log_debug_message | 2 | 3 | 4 |
| report_frontend_log | 8 | 27 | 11 |
| tauri_lab_frontend_log | 2 | 4 | 5 |
| write_debug_logs | 7 | 12 | 14 |
| get_debug_logs_info | 2 | 4 | 0 |
| clear_debug_logs | 2 | 2 | 0 |
| ensure_debug_log_dir | 3 | 4 | 0 |
| read_debug_log_file | 3 | 0 | 11 |
| open_logs_folder | 6 | 5（全部在 gated 里） | 7 |
| export_diagnostics_bundle | 8 | 11 | 15 |

（`check_package_manager` 和 `auto_install_package_manager` 的计数包含 gated 文件。）

## 8. G3 错误分支判定：8 条无 `expect:"error"` 的命令（WP-269）

结论：这 8 条命令在 `seed:"empty"` 下都没有可达的业务 Err 或提前返回，所以**没有新增 `g3w-*.json`**。下面逐条给出 Rust 文件:行。路径简写同 §2、§7：`ss.rs` = `crates/dstu-security/src/secure_store.rs`，`cc.rs` = `crates/dstu-sync/src/cloud_config_commands.rs`，`pm.rs` = `crates/dstu-platform/src/package_manager.rs`，`tauri` = `~/.cargo/registry/.../tauri-2.11.5`（`Cargo.lock:12578-12579` 锁定 2.11.5）。

这 8 条命令都没有前端参数（只取 `AppHandle`、`State` 或 `WebviewWindow`）。Tauri 不对多余的顶层键做反序列化，所以不存在参数错误；ACL 都已放行（`permissions/application-commands.toml:173,195,196,800-802,805,917`）。

| 命令 | 判定 | Rust 文件:行与原因 |
|---|---|---|
| `check_all_package_managers` | 无可达 Err | `src/commands.rs:7130-7164` 返回 `serde_json::Value`，不是 `Result`。四个探测函数 `pm.rs:69,119,164,207` 返回 `PackageManagerInfo`；`is_command_available`（`pm.rs:37`）返回 bool，`get_command_version`（`pm.rs:51`）用 `.ok()` 吞掉 spawn 和 UTF-8 错误，没有 `unwrap`。 |
| `toggle_devtools` | Linux 下无可达 Err | 函数体 `src/debug_commands.rs:474-484` 两个分支都是 `Ok`。处理函数之外的唯一 Err 是 `WebviewWindow` 参数提取：`tauri src/webview/webview_window.rs:1489-1497` 在调用方窗口不是单 webview 时返回 `current webview is not a WebviewWindow`，判定条件是 `src/window/mod.rs:1160-1162`（窗口内所有 webview 的 label 都等于窗口 label）。只有内置浏览器在 macOS/Windows 上用 `main_window.add_child` 挂子 webview `browser-content` 时（`crates/dstu-browser/src/browser/window.rs:425-490`），主窗口才变成多 webview。Linux 上浏览器是独立的 `WebviewWindowBuilder` 窗口（`window.rs:511-520`），不影响主窗口。所以 Linux 录制不可达；在 macOS/Windows 上还要先通过 `BrowserService::open_session`（`browser/service.rs:338,467`）打开外部 URL，这属于浏览器 lane 且需要联网，不在本包写场景，留给对应平台录制。release 构建未注册这条命令（`lib.rs:2267` 的 cfg）时返回 command not found，A 端 dev profile 不走这条路径。 |
| `secure_store_is_available` | 无可达 Err | `src/secure_store.rs:77-81` 返回 `bool`，不是 `Result`。`ss.rs:1420-1436`：`get_device_key` 失败时只记 `warn!` 并返回 `false`，IPC 层仍然成功。`false` 分支需要损坏的 `.key_seed`（见下一行），属于成功场景的取值，不是 Err。 |
| `secure_get_cloud_credentials` | 无可达 Err | `src/secure_store.rs:42-50` → `cloud_credential_status`（`ss.rs:2465-2473`）→ `get_cloud_credentials`（`ss.rs:2414-2425`）→ `get_encrypted_file`（`ss.rs:1308-1366`）。文件不存在时返回 `Ok(None)`（`:1313`）。其余 Err 都是 IO 或存储状态故障：`get_secure_dir` 建目录失败（`ss.rs:654-663`）；`symlink_metadata`、open、read 失败（`:1315-1320,1335-1339`）；`.enc` 是目录或符号链接（`:1322`）；超过 16 MiB（`:184,1327,1340`）；解密失败（`:1346-1363`）；JSON 反序列化失败（`:2419-2420`）；种子相关的 `get_or_create_master_seed`（`ss.rs:701-868`，种子锁中毒 `:702-704`、`.key_seed` 是目录/过大/为空/带 DPAPI 前缀 `:710-752`、密钥库不可达 `:757-765,805-811`）。在根 `.secure/` 下写 `cloud_storage_credentials.enc` 的只有本域命令，写入值都是 `serde_json::to_string(&CloudStorageCredentials)`（`ss.rs:2404-2411`）。通用 `save_setting` 虽然会把 `cloud_storage*` 键路由到安全存储（`ss.rs:143`），但那是 `Database` 自带的 `SecureStore`，目录是 `db_path.parent()`，即活动槽位目录（`dstu-storage/src/database/mod.rs:1211-1220`，`lib.rs:3492-3494`，`data_space.rs:1005-1018,1673-1675`），而本命令用根 `app_data_dir`（`dstu-sync/src/cloud_credentials.rs:48-56`）。两者不是同一个文件，所以前端写不出坏凭据。`keystore` 打开后的密钥库分支见 §4（平台门控）。 |
| `secure_clear_cloud_encryption_password` | 无可达 Err | `src/secure_store.rs:66-74` → `ss.rs:2480-2494`。空库时 `get_cloud_credentials` 返回 `None`，提前返回 `Ok(default)`（`:2483-2485`），这是成功分支，已由 `secure-credentials.json` 覆盖。其余 Err 只来自读取（同上一行）、写回时的序列化或 IO（`ss.rs:2404-2411,1293-1306`）和 `delete_secret` 的非 NotFound 删除错误（`ss.rs:1369-1391`）。 |
| `secure_delete_cloud_credentials` | 无可达 Err | `src/secure_store.rs:52-63` → `ss.rs:2496-2498` → `delete_encrypted_file`（`ss.rs:1369-1391`）：NotFound 被忽略（`:1384`），只有 `remove_file` 的其他 IO 错误（`:1385-1387`，如目录只读、路径是目录）会返回 Err。这需要故障注入或安全目录种子。 |
| `cloud_config_ssot_get` | 无可达 Err | `src/cloud_config_commands.rs:18-23` → `cc.rs:576-593`；`NotConfigured` 映射为 `Ok({configured:false})`（`:586-591`）。其余 Err 都出自 `load_cloud_config_ssot_with_capabilities`（`cc.rs:528-545`）：`get_setting` 数据库错误（`:532-534`）；存量记录超过 16 KiB、反序列化失败或重新校验失败（`:536-543`）。`cloud_storage.config.safe_v1` 这一行只有 `save_cloud_config_ssot_with_capabilities`（`cc.rs:499-516`）和发布回滚（`cc.rs:914-916`）会写，写入的都是已经校验并规范化过的配置，且同一能力集下规范化是幂等的：`bounded_text` 先 trim（`cc.rs:214-235`），`validated_root` 先去掉首尾 `/` 和空白（`:258-278`），WebDAV/FTP 的 `allowInsecure` 规范化为 `insecure && allowInsecure`，S3 固定为 `false`（`:314-427`）。保存时 16 KiB 的判定与读取时相同（`cc.rs:46,507,536`）。通用 `save_setting` 写不到这一行（键前缀 `cloud_storage` 被路由到安全存储，`ss.rs:143`，`database/mod.rs:4229-4232`），所以需要 X3 提供 settings 行种子（同 §2）。`State<AppState>` 提取失败（`tauri src/state.rs:60-67`）只出现在恢复启动模式：`AppState` 在 `lib.rs:1321,1336` 才 manage，恢复模式在此之前 `return Ok(())`（`lib.rs:959,972,986,1043,1053,1062,1317`）。`seed:"empty"` 不进入恢复模式，判定同 L01 的 WP-246。 |
| `cloud_config_ssot_clear` | 无可达 Err | `src/cloud_config_commands.rs:47-53` → `cc.rs:968-1022`，没有业务校验，只有存储步骤：读 SSOT 快照的数据库错误（`:976-978`）；读凭据快照（`:980-983`，Err 来源同 `secure_get_cloud_credentials`）；事务删除（`:987-991` → `ss.rs:2698-2723`，逐个 `get_secret` 后 `delete_secret`，Err 只来自 IO，同上两行）；`delete_setting` 失败后恢复凭据并带 `data.credentialsRestored`（`cc.rs:995-1014`，需要故障注入）。空库和有记录时的成功路径已由 `cloud-config.json` 的 `clear.*` 场景覆盖。`State` 提取失败同上一行。 |

需要别的域提供的种子没有变化，仍然是 §2 和 §5 列出的那些：X3 的 settings 行种子、X3/F4 的 `.secure/` 安全目录种子、恢复启动模式种子，以及 §4 的隔离 Secret Service 环境。
