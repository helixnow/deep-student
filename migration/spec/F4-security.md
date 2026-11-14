# F4-security 行为规格（`migration/spec/F4-security.md`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 44 个 · 发出事件 1 种 · 契约：`contracts/ipc/F4-security.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：普通 `Option<T>` 序列化为 `null`；明确标注 `skip_serializing_if = "Option::is_none"` 的字段（如 `BackupConfig.backupTiers`）在 `None` 时省略（`backup_config.rs:28–53`）。命令返回值中的 `undefined` 由 kernel 统一按 `null` 发送（`host/kernel/api.ts`）。
- [x] u64/i64 超过 2^53 的表示：F4 计数/字节长度受每文件 100 MiB、诊断 500 条等上限约束，最大远小于 2^53；TS 用 `number` 原样输出。契约中的 `u32` 字段由 kernel Ajv 校验 0–4294967295（`contracts/ipc/F4-security.json`）。
- [x] 字段顺序（serde_json preserve_order）：Rust 启用 `serde_json/preserve_order`（`src-tauri/Cargo.toml:101`），对象按结构体声明顺序输出；TS 侧 `backup.config` 按 `BackupConfig` 字段顺序生成（`host/platform/settings/backup-config.ts`），其余命令结果按字段名消费，不依赖顺序。
- [x] f32 精度：F4 命令结果没有 `f32` 字段；耗时/大小均为整数或 `null`（`contracts/ipc/F4-security.json`）。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：`AppError` 命令返回 `{error_type,message,details}`，`details` 缺省为 `null`（`host/platform/errors/api.ts`，`models.rs:928–1084`）；`export_diagnostics_bundle`、`log_debug_message`、`secret_prompt_submit` 返回字符串错误；panic 在生产中让前端 Promise 永不 settle（`host/kernel/protocol.ts`），F4 不主动 panic。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：F4 命令不使用 `CancellationToken`；`invoke` 的 `AbortSignal` 只中止等待，不取消底层文件/子进程操作；包管理器安装用独立超时终止子进程（`host/platform/diagnostics/package-manager.ts`）。这与 Rust 命令直接 await 的行为一致。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：设置写入是同一 SQLite 连接上的单条 UPSERT；安全存储命令通过插件内 Promise 链串行化（`host/platform/secrets/commands.ts`）；诊断导出先写临时文件再原子替换。Node 单线程 + `await` 交错不会改变 Rust 的串行语义。
- [x] 时间与 ID：生成方式、格式、时区：设置 `updated_at` 与备份状态使用 chrono `Utc::now().to_rfc3339()`（`dstu-storage/src/database/mod.rs:4108–4120`、`backup_config.rs:618`）；诊断包 manifest 使用 ISO/RFC3339 时间；F4 不新增持久 ID。
- [x] 日志：Rust `warn!`/`error!`/`info!` 位点均在 TS 同位置经 `ctx.logger` 记录，禁止静默 catch：
  - 安全存储：`secure-store.ts` 的权限/ACL/钥匙串回迁/legacy 迁移/云凭据回滚日志逐条对应 `secure_store.rs:519–649,774–790,1304,1357–1359,1432,2649–2716`；`crypto-service.ts` 对应 `crypto/mod.rs:47–148`；`crypto-publication.ts` 对应 `crypto_publication.rs:191`。
  - 日志服务：`debug-logs.ts` 对应 `debug_log_service.rs:326,429–432,472,529,627,647,668`；`structured.ts` 对应 `debug_logger.rs:69–75,183,447,493`。
  - 命令层：`backup-config.ts`/`backup-commands.ts` 对应 `backup_config.rs:124,164,178,685–687`；`database-commands.ts` 对应 `debug_commands.rs:250,380` 与 `commands.rs:7457`；`package-manager.ts` 对应 `dstu-platform/src/package_manager.rs:417`。
  - `background-tasks.ts` 对应 `background_tasks.rs:78,108`（拒绝准入 warn、shutdown 等待/超时日志）。
- [x] 不对含 HashMap 的结构做序列化后比对：F4 结果断言按字段/逐项进行，不比较 `HashMap` 的序列化字节顺序（测试见 `host/platform/*/tests`）。

## WP-007 · B4/D15-time：chrono serde / FromStr UTC 解析

锁定依据：`src-tauri/Cargo.lock:1842-1845` chrono **0.4.41**。下表 Rust 路径相对
`chrono-0.4.41/src/`；只读本机 registry 源码，未运行 Rust。
入口：`host/platform/time/api.ts` 与 `index.ts` 的
`parseChronoDateTimeUtc(value: string): ParsedDateTime | null`。输入是 JSON 解码后的字符串，
不是 JSON 文档；Option/字段重复/JSON 类型错误仍由消费方处理。
TS 定位：`time/api.ts:61-66` 公开出口，`time/index.ts:249-254` 词法分支，`:261-292`
解析/日历校验/UTC转换；已有 `civilToMillis:205-226`、`fractionNanos:228-231`、
`parsedFromParts:233-243` 直接复用，没有第二套日历实现。

| Rust 分支 | TS 落点 / 行为 |
|---|---|
| `datetime/serde.rs:53-98` DateTimeVisitor `value.parse()` 后 `with_timezone(Utc)`；`datetime/mod.rs:1814-1819` FromStr 同一路径 | 新公开入口解析完整字符串；成功返回 UTC 日历字段与 `offsetMinutes:0`，失败返回 null（对应消费方 `.ok()`，不提供 ParseError Display） |
| `format/parse.rs:523-533,545-567` DATE_ITEMS；`:335-380` Numeric | `CHRONO_DATETIME_UTC`：无符号年 1..4 位，有 ASCII +/- 时不限位数；月/日/时/分/秒 1..2 位，数字只认 ASCII；Numeric 前及日期连字符前可有 Rust White_Space；符号后不能有空白 |
| `format/parse.rs:569-575` 日期/时间分隔 | 日后必须立即为 T/t/ASCII 空格之一；后续 Hour 前可有 White_Space；不能用单独 tab/NBSP 或“空格+T”代替 |
| `format/parse.rs:555-565,420-425` TIME_ITEMS；`format/scan.rs:48-65` | 冒号两侧允许 White_Space；小数点必须紧跟秒，点后至少一位 ASCII 数字；多于九位消费但截断，不舍入；无小数为零 |
| `format/parse.rs:576-582`；`format/scan.rs:183-278` | 时间后空白、ASCII 大小写 UTC/Z；偏移 +/-/U+2212 + 两位小时 + 任意多个冒号/White_Space（可为空）+ 两位分钟；不接受缺少分钟、偏移秒或其他区名 |
| `format/parse.rs:529-532` | 只允许尾随 Rust White_Space；FEFF/零宽字符及其他尾随文本失败 |
| `format/parsed.rs:586-728,748-780,902-916`；`naive/date/mod.rs:2343-2352` | 年 -262143..262142、有效公历月日、小时 0..23、分钟 0..59、秒 0..60；复用 `civilToMillis` 的明确日历校验，未将字符串交给 JS Date；偏移绝对值小于24小时 |
| `offset/mod.rs:567-572`；`naive/datetime/mod.rs:588-601` | 偏移相减后 UTC 基础秒也须在 chrono 日期范围内；复用 `civilTime` 转 UTC，但不把闰秒的额外纳秒交给它归一化 |
| `format/parsed.rs:768-780` 闰秒 | `second:59` 与 `nanos:1e9+fraction` 保留，`parsedFromParts` 生成精确 bigint epochNanos；既有 epochNanos 是归一化投影，不能单靠它区分闰秒和下一秒 |

该纯函数没有日志、事件、数据库/文件写入、资源释放或异步任务。现有 strict RFC3339 和
flexible timestamp 入口保持自己的格式范围。L19 OAuth 持久化消费请求见
`host/plugins/mcp/BLOCKERS.md:27-44`，消费者接入与日期比较/保存由 L19 后续完成。
测试走两个真实公开出口；上游 UTC 原测试子集与逐分支补充向量记录在 `host/platform/TESTMAP.md`。

## 命令 `auto_install_package_manager`

<!-- BEGIN GENERATED:cmd:auto_install_package_manager -->
- Rust：`src-tauri/src/commands.rs:7118` · async
- 前端：app（1 处，例 `src/utils/systemApi.ts:431`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：managerType: string
  - 结果：Value
<!-- END GENERATED:cmd:auto_install_package_manager -->

- [x] 输入：`managerType: string`；只有 uv/cargo 有自动安装命令，其余管理器返回失败说明（`commands.rs:7118`，`dstu-platform/src/package_manager.rs:366`）。
- [x] 输出：`{success,message,installed_version}`；失败也是 `Ok` 对象，不抛命令错误（`commands.rs:7118–7128`）。
- [x] 错误：无命令级错误；子进程启动失败、退出码非 0、超时都写进 `message` 并令 `success=false`（`package_manager.rs:366–430`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：安装子进程带超时；超时 SIGKILL 并返回「安装超时（N 秒），已终止安装进程」；无 `CancellationToken`（`package_manager.rs:330–350`）。
- [x] 时间/ID：不生成时间/ID；超时按秒计时。

## 命令 `check_all_package_managers`

<!-- BEGIN GENERATED:cmd:check_all_package_managers -->
- Rust：`src-tauri/src/commands.rs:7130` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:445`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：Value
<!-- END GENERATED:cmd:check_all_package_managers -->

- [x] 输入：无参数（`commands.rs:7130`）。
- [x] 输出：`{node:{is_available,version,install_hints}, python:{…}, uv:{…,can_auto_install}, cargo:{…,can_auto_install}}`（`commands.rs:7130–7163`）。
- [x] 错误：无错误分支；每个探测失败只体现在对应 `is_available=false` 与 `version=null`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步依次探测 4 个环境，每次探测启动子进程并取退出状态/版本（`package_manager.rs:69–250`）。
- [x] 时间/ID：不生成时间/ID。

## 命令 `check_package_manager`

<!-- BEGIN GENERATED:cmd:check_package_manager -->
- Rust：`src-tauri/src/commands.rs:7097` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:418`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：command: string
  - 结果：Value
<!-- END GENERATED:cmd:check_package_manager -->

- [x] 输入：`command: string`（`commands.rs:7097`）。
- [x] 输出：识别成功时 `{detected:true,manager_type,is_available,version,install_hints,can_auto_install}`；否则 `{detected:false,message:"无法识别命令 '…' 所需的包管理器"}`（`commands.rs:7097–7116`）。
- [x] 错误：无错误分支；探测失败写入 `is_available=false`/`version=null`（`package_manager.rs:252–330`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步探测命令是否可执行并读取版本，无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `check_test_dependencies`

<!-- BEGIN GENERATED:cmd:check_test_dependencies -->
- Rust：`src-tauri/src/commands.rs:7402` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:check_test_dependencies -->

- [x] 输入：无参数（`commands.rs:7402`）。
- [x] 输出：`{available,details:{service:boolean},errors:string[],results:[{service,available,latency_ms,error}]}`；固定顺序 prometheus、database、web_search（`commands.rs:7402–7421`，`test_utils/health_check.rs`）。
- [x] 错误：命令本身返回 `Ok`；服务失败写入 `results[].error` 与 `errors`，不抛错（`commands.rs:7402–7421`）。
- [x] 事件：无。
- [x] DB 读写：只检查主库连接可用性，不读表（`health_check` 的 database 探针）。
- [x] 取消/并发：prometheus 探针 2 秒超时；database 探针同步；web_search 按 Rust 硬编码 `available=true` 不探测（`health_check.rs:74–83`）。
- [x] 时间/ID：`latency_ms` 为本进程单调时钟耗时，取整毫秒；不生成 ID。

## 命令 `cleanup_old_debug_logs`

<!-- BEGIN GENERATED:cmd:cleanup_old_debug_logs -->
- Rust：`src-tauri/src/commands.rs:625` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：maxAgeDays: integer(u32)
  - 结果：integer(usize) · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:cleanup_old_debug_logs -->

- [x] 输入：`maxAgeDays: u32`（`commands.rs:625`）。
- [x] 输出：删除的文件数 `usize`（`commands.rs:625–634`，`debug_log_service.rs:632–652`）。
- [x] 错误：等待待写日志超时 → `AppError::FileSystem("等待调试日志写入超时，请稍后重试")`；删除失败被忽略，不报错（`commands.rs:625–634`，`debug_log_service.rs:638–645`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：先 await 待写队列 flush，再逐文件删除；无取消点。
- [x] 时间/ID：以文件 mtime 与 `now - maxAgeDays*86400s` 比较（`debug_log_service.rs:634–645`）。

## 命令 `clear_backup_directory`

<!-- BEGIN GENERATED:cmd:clear_backup_directory -->
- Rust：`src-tauri/src/backup_config.rs:173` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:clear_backup_directory -->

- [x] 输入：无参数；读取 `backup.config`，只把 `backupDirectory` 置为 `None`，其余字段原样保留（`backup_config.rs:173–180`）。
- [x] 输出：`null`（Rust `Result<()>`）。
- [x] 错误：读/写设置失败 → `AppError::Database("数据库错误: …")`（`models.rs:1081–1085`）；配置 JSON 损坏 → `AppError::internal("解析备份配置失败: …")`（`backup_config.rs:74–83`）。
- [x] 事件：无。
- [x] DB 读写：主库 `settings` 表先读后写 `backup.config`（`dstu-storage/src/database/mod.rs:4108–4135`）。
- [x] 取消/并发：无取消点；单条同步 SQLite UPSERT，串行于同一连接（`host/platform/settings/index.ts`）。
- [x] 时间/ID：写入时 `updated_at = Utc::now().to_rfc3339()`（`database/mod.rs:4108–4120`），值不变时该行不更新。

## 命令 `clear_debug_logs`

<!-- BEGIN GENERATED:cmd:clear_debug_logs -->
- Rust：`src-tauri/src/commands.rs:615` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:clear_debug_logs -->

- [x] 输入：无参数（`commands.rs:615`）。
- [x] 输出：删除的文件数 `usize`（`commands.rs:615–623`，`debug_log_service.rs:619–629`）。
- [x] 错误：等待待写日志超时 → `AppError::FileSystem("等待调试日志写入超时，请稍后重试")`；单个删除失败被跳过，不报错（`commands.rs:615–623`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：先 flush 待写队列，再同步删除；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `cloud_config_publish`

<!-- BEGIN GENERATED:cmd:cloud_config_publish -->
- Rust：`src-tauri/src/cloud_config_commands.rs:27` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:519`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：config: SafeCloudStorageConfig__De, credentials: CloudStorageCredentials, encryptionPasswordIsPreexisting?: boolean | null
  - 结果：CloudConfigPublishResponse · 错误：CommandError · 注入：app-handle, state
<!-- END GENERATED:cmd:cloud_config_publish -->

- [x] 输入：`config: SafeCloudStorageConfig__De`、`credentials: CloudStorageCredentials`、`encryptionPasswordIsPreexisting?: boolean | null`（`cloud_config_commands.rs:27–53`）。`config` 为 webdav/s3/ftp 判别联合，先经与保存相同的 `validate_and_normalize`；`credentials` 只含 secret 字段。
- [x] 输出：`{ok:true,generation,provider,root?,config}`；`generation` 为提交后的 active 凭据代次（u64，JSON number）（`dstu-sync/.../cloud_config_commands.rs:744–753,832–966`）。
- [x] 错误：新设短口令 → `E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT`；非敏感校验失败 → `E_CLOUD_CONFIG_INVALID`（平台能力码 `E_CLOUD_FTP_UNSUPPORTED_ON_ANDROID`/`E_CLOUD_S3_UNAVAILABLE_IN_BUILD`）；SSOT 写失败 → `E_CLOUD_CONFIG_STORAGE`；草稿与已发布记录都无 provider secret → `E_CLOUD_CREDENTIALS_UNAVAILABLE`；staged 写/提交失败 → secure-store 稳定码，提交失败时 `data:{operation:"commit_staged_cloud_credentials",ssotRestored}`（`cloud_config_commands.rs:832–966`）。
- [x] 事件：无。
- [x] DB 读写：先读 `cloud.config.ssot` 快照；写 SSOT 后提交 staged 凭据；提交失败按快照恢复（有则写回，无则删除）并 abort staged（`cloud_config_commands.rs:832–966`）。
- [x] 取消/并发：无取消点；同一安全存储的 staged/commit 由串行锁保护，`generation` 作为并发句柄（stale generation fail-closed）。
- [x] 时间/ID：不生成时间；`generation` 为单调递增的 active 代次。

## 命令 `cloud_config_ssot_clear`

<!-- BEGIN GENERATED:cmd:cloud_config_ssot_clear -->
- Rust：`src-tauri/src/cloud_config_commands.rs:47` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:451`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：CloudConfigSsotResponse · 错误：CommandError · 注入：app-handle, state
<!-- END GENERATED:cmd:cloud_config_ssot_clear -->

- [x] 输入：无参数（`cloud_config_commands.rs:47–53`）。
- [x] 输出：未配置视图 `{configured:false}`（省略 `provider`/`root`/`config`）（`dstu-sync/.../cloud_config_commands.rs:968–1030`）。
- [x] 错误：设置库读取/删除失败 → `E_CLOUD_CONFIG_STORAGE`；凭据事务删除失败 → secure-store 稳定码；SSOT 删除失败且凭据恢复失败时 `data:{operation:"delete_cloud_credentials_transactional",credentialsRestored:false}`（`cloud_config_commands.rs:968–1030`）。
- [x] 事件：无。
- [x] DB 读写：先 fail-early 读 `cloud.config.ssot`；事务化删除 active+staged+generation 凭据；再删 SSOT，失败时按调用栈快照 best-effort 恢复凭据（`cloud_config_commands.rs:968–1030`）。
- [x] 取消/并发：无取消点；凭据删除在安全存储串行锁内执行。
- [x] 时间/ID：不生成时间/ID。

## 命令 `cloud_config_ssot_get`

<!-- BEGIN GENERATED:cmd:cloud_config_ssot_get -->
- Rust：`src-tauri/src/cloud_config_commands.rs:18` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:447`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：CloudConfigSsotResponse · 错误：CommandError · 注入：state
<!-- END GENERATED:cmd:cloud_config_ssot_get -->

- [x] 输入：无参数（`cloud_config_commands.rs:18–25`）。
- [x] 输出：已配置时 `{configured:true,provider,root?,config}`；未配置时 `{configured:false}`（字段缺省）（`dstu-sync/.../cloud_config_commands.rs:576–592`）。
- [x] 错误：设置读取失败 → `E_CLOUD_CONFIG_STORAGE`；记录超过 16 KiB 或 JSON 损坏 → `E_CLOUD_CONFIG_INVALID`；平台能力拒绝（Android FTP / 无 S3 构建）→ 对应 `E_*` 平台码（`cloud_config_commands.rs:528–545,180–205`）。
- [x] 事件：无。
- [x] DB 读写：只读主库 `settings` 的 `cloud.config.ssot`（`dstu-storage/src/database/mod.rs:4122–4135`）。
- [x] 取消/并发：无取消点；单条只读查询。
- [x] 时间/ID：不生成时间/ID。

## 命令 `cloud_config_ssot_save`

<!-- BEGIN GENERATED:cmd:cloud_config_ssot_save -->
- Rust：`src-tauri/src/cloud_config_commands.rs:10` · async
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:441`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：config: SafeCloudStorageConfig__De
  - 结果：CloudConfigSsotResponse · 错误：CommandError · 注入：state
<!-- END GENERATED:cmd:cloud_config_ssot_save -->

- [x] 输入：`config: SafeCloudStorageConfig__De`（webdav/s3/ftp 判别联合；`root?`、`allow_insecure?`）（`cloud_config_commands.rs:10–16`）。
- [x] 输出：规范化后的 `{configured:true,provider,root?,config}`；`config` 中 endpoint/username/bucket 等已 trim 并校验，`allow_insecure` 仅保留实际生效值（`dstu-sync/.../cloud_config_commands.rs:561–574,299–470`）。
- [x] 错误：字段空/超长/控制字符/URL 非法/内嵌凭据/root 遍历 → `E_CLOUD_CONFIG_INVALID`；公网 HTTP WebDAV 或明文 FTP 未带 `allowInsecure` → 同码；Android FTP → `E_CLOUD_FTP_UNSUPPORTED_ON_ANDROID`；无 S3 构建 → `E_CLOUD_S3_UNAVAILABLE_IN_BUILD`；序列化超过 16 KiB → `E_CLOUD_CONFIG_INVALID`；设置写入失败 → `E_CLOUD_CONFIG_STORAGE`（`cloud_config_commands.rs:180–205,487–516`）。
- [x] 事件：无。
- [x] DB 读写：UPSERT 主库 `settings` 的 `cloud.config.ssot`（`dstu-storage/src/database/mod.rs:4108–4120`）。
- [x] 取消/并发：无取消点；单条同步 SQLite UPSERT；同键后写者覆盖。
- [x] 时间/ID：写入 `updated_at = Utc::now().to_rfc3339()`；不生成其他 ID。

## 命令 `debug_get_database_stats`

<!-- BEGIN GENERATED:cmd:debug_get_database_stats -->
- Rust：`src-tauri/src/debug_commands.rs:67` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：DebugDatabaseStats · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:debug_get_database_stats -->

- [x] 输入：无参数；取主库连接（`debug_commands.rs:67`）。
- [x] 输出：`{total_mistakes,mistakes_with_chat,total_messages,messages_with_images,messages_with_thinking,messages_with_rag_sources,messages_with_memory_sources,messages_with_web_sources,messages_with_persistent_id}`（`debug_commands.rs:49–66`）。
- [x] 错误：主库连接失败 → `AppError::Database("获取数据库连接失败: …")`；单条查询失败按 0 处理（`debug_commands.rs:72–90`）。
- [x] 事件：无。
- [x] DB 读写：只读主库 `mistakes`（`COUNT(*)` 与 `chat_history` JSON 解析）（`debug_commands.rs:74–139`）。
- [x] 取消/并发：同步查询；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `debug_vfs_migration_status`

<!-- BEGIN GENERATED:cmd:debug_vfs_migration_status -->
- Rust：`src-tauri/src/debug_commands.rs:244` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：VfsMigrationDiagnostic · 错误：string · 注入：state
<!-- END GENERATED:cmd:debug_vfs_migration_status -->

- [x] 输入：无参数；取 VFS 库连接（`debug_commands.rs:244`）。
- [x] 输出：`{recorded_version,expected_version,migration_history,resources_columns,missing_index_columns,vfs_index_units_exists,vfs_index_segments_exists,vfs_indexing_config_exists,diagnosis,suggested_fix}`，`expected_version=18`（`debug_commands.rs:244–390`）。
- [x] 错误：连接/查询失败返回 `Err(String)`（`debug_commands.rs:250–330`）。
- [x] 事件：无。
- [x] DB 读写：只读 VFS 库 `refinery_schema_history`、`pragma_table_info('resources')`、`sqlite_master`（`debug_commands.rs:255–370`）。
- [x] 取消/并发：同步查询；无取消点。
- [x] 时间/ID：不生成时间/ID；`applied_at` 原样来自迁移表。

## 命令 `debug_vfs_textbook_pages`

<!-- BEGIN GENERATED:cmd:debug_vfs_textbook_pages -->
- Rust：`src-tauri/src/debug_commands.rs:402` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：DebugTextbookPageInfo[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:debug_vfs_textbook_pages -->

- [x] 输入：无参数；取 VFS 库连接（`debug_commands.rs:402`）。
- [x] 输出：`[{textbook_id,resource_id,file_name,page_count,has_ocr_pages_json,ocr_pages_json_len,has_extracted_text,extracted_text_len}]`；长度按 UTF-8 字节数（`debug_commands.rs:402–455`）。
- [x] 错误：VFS 未初始化 → `AppError::Database("VFS 数据库未初始化")`；连接/查询失败 → `AppError::Database(…)`（`debug_commands.rs:405–430`）。
- [x] 事件：无。
- [x] DB 读写：只读 VFS 库 `files` 表（`debug_commands.rs:409–430`）。
- [x] 取消/并发：同步查询；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `ensure_debug_log_dir`

<!-- BEGIN GENERATED:cmd:ensure_debug_log_dir -->
- Rust：`src-tauri/src/commands.rs:636` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：string · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:ensure_debug_log_dir -->

- [x] 输入：无参数（`commands.rs:636`）。
- [x] 输出：`debug-logs` 目录绝对路径字符串（`commands.rs:636–641`）。
- [x] 错误：应用日志目录解析失败 → `AppError`；创建目录失败由 `ensure_debug_log_dir` 记录并返回路径（`commands.rs:636–641`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步创建目录；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `export_diagnostics_bundle`

<!-- BEGIN GENERATED:cmd:export_diagnostics_bundle -->
- Rust：`src-tauri/src/diagnostics.rs:447` · async
- 前端：app（1 处，例 `src/logging/exportDiagnostics.ts:47`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：options: DiagnosticsExportOptions
  - 结果：DiagnosticsExportResult · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:export_diagnostics_bundle -->

- [x] 输入：`options:{destination:string,includeDebugLogs?:boolean}`（`diagnostics.rs:63–69`）。
- [x] 输出：`{path,file_count,skipped_count,size_bytes}`（`diagnostics.rs:71–77`）。
- [x] 错误：等待日志 flush 超时 → 字符串「等待详细请求日志写入超时，请稍后重试」；阻塞任务失败 → 「诊断包任务失败: …」；ZIP/IO 失败向上返回字符串（`diagnostics.rs:447–462`）。
- [x] 事件：无。
- [x] DB 读写：无；读取日志目录并写 ZIP（`diagnostics.rs:340–445`）。
- [x] 取消/并发：`spawn_blocking` 内同步扫描/压缩；无取消点；先写临时文件再原子替换（`diagnostics.rs:447–462`，`export_bundle_sync`）。
- [x] 时间/ID：manifest `generated_at` 为 `Utc::now().to_rfc3339()`；文件名含时间戳；不生成持久 ID（`diagnostics.rs:79–90`）。

## 命令 `get_auto_backup_status`

<!-- BEGIN GENERATED:cmd:get_auto_backup_status -->
- Rust：`src-tauri/src/backup_config.rs:231` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:207`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：AutoBackupStatus · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_auto_backup_status -->

- [x] 输入：无参数（`backup_config.rs:231–234`）。
- [x] 输出：`AutoBackupStatus { lastAttemptAt, lastSuccessAt, lastError, nextDueAt, lastJobId }`，缺失设置时为五项全 `null`（`backup_config.rs:204–221`）。
- [x] 错误：设置读取失败 → `AppError::Database("数据库错误: …")`；存储 JSON 损坏 → `AppError::internal("解析自动备份状态失败: …")`（`backup_config.rs:215–221`）。
- [x] 事件：无。
- [x] DB 读写：只读 `backup.auto_backup_status`（`dstu-storage/src/database/mod.rs:4122–4135`）。
- [x] 取消/并发：无取消点；单条只读查询。状态由调度器串行写入，本命令只读。
- [x] 时间/ID：字段是调度器写入的 RFC3339 字符串（`backup_config.rs:618`），本命令不生成时间/ID。

注册：Rust `generate_handler!`（`src-tauri/src/lib.rs:2219–2223`）未注册本命令，前端调用在 ACL 层得到 command not found。Host 同样不注册（WP-126），`loadAutoBackupStatus`（`settings/backup-commands.ts`）保留上述读取与错误语义，供内部调用。

## 命令 `get_backup_config`

<!-- BEGIN GENERATED:cmd:get_backup_config -->
- Rust：`src-tauri/src/backup_config.rs:115` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:195`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：BackupConfig · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_backup_config -->

- [x] 输入：无参数（`backup_config.rs:115–118`）。
- [x] 输出：`BackupConfig` camelCase；无设置时为 `{backupDirectory:null,autoBackupEnabled:false,autoBackupIntervalHours:24,maxBackupCount:5,slimBackup:false}`，`backupTiers` 为 `None` 时省略字段（`backup_config.rs:28–70`，serde `skip_serializing_if`）。
- [x] 错误：设置读取失败 → `AppError::Database("数据库错误: …")`；JSON 解析失败 → `AppError::internal("解析备份配置失败: …")`（`backup_config.rs:74–83`）。
- [x] 事件：无。
- [x] DB 读写：只读主库 `settings` 表 `backup.config`（`dstu-storage/src/database/mod.rs:4122–4135`）。
- [x] 取消/并发：无取消点；单条只读查询。
- [x] 时间/ID：不生成时间/ID；`updated_at` 仅在写入时更新。

## 命令 `get_debug_logs_info`

<!-- BEGIN GENERATED:cmd:get_debug_logs_info -->
- Rust：`src-tauri/src/commands.rs:603` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：DebugLogsInfo · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:get_debug_logs_info -->

- [x] 输入：无参数；先 flush 待写调试日志（`commands.rs:603`）。
- [x] 输出：`{count,total_size_bytes,total_size_display,oldest_file,newest_file}`（`debug_log_service.rs:560–566`）。
- [x] 错误：等待待写日志超时 → `AppError::FileSystem("等待调试日志写入超时，请稍后重试")`；日志根解析失败 → `AppError`（`commands.rs:603–613`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：先 await flush，再同步扫描根目录；无取消点。
- [x] 时间/ID：`oldest_file`/`newest_file` 来自文件 mtime 排序后的文件名（`debug_log_service.rs:591–617`）。

## 命令 `get_default_backup_directory`

<!-- BEGIN GENERATED:cmd:get_default_backup_directory -->
- Rust：`src-tauri/src/backup_config.rs:183` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_default_backup_directory -->

- [x] 输入：无参数（`backup_config.rs:183–188`）。
- [x] 输出：默认恢复点目录字符串；`FileManager::get_writable_app_data_dir()` 的 `base` 下 `recovery/backups`；若 base 形如 `<base>/slots/slotA` 则提升到 `<base>`（`backup_config.rs:649–657`）。
- [x] 错误：无可写目录时不报错，最终使用临时目录 `deep_student_data` 并只记录警告（`file_manager.rs:198–218`）；Rust 命令签名无错误分支。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：无取消点；每次调用做一次可写性探测（`mkdir` + `.write_test`，随后删除）（`file_manager.rs:169–196`）。
- [x] 时间/ID：不生成时间/ID。

## 命令 `get_test_logs`

<!-- BEGIN GENERATED:cmd:get_test_logs -->
- Rust：`src-tauri/src/commands.rs:6296` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：logType: string
  - 结果：string[] · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:get_test_logs -->

- [x] 输入：`logType: string`，仅 `backend` / `frontend` / `debug` / `crash`（`commands.rs:6296`，`structured_log_subdir`）。
- [x] 输出：相对路径数组 `"<subdir>/<file>.log"`，按 mtime 降序；目录不存在返回空数组（`commands.rs:6296–6343`）。
- [x] 错误：不支持的日志类型 → `AppError::Validation("不支持的日志类型")`（`commands.rs:6255–6262`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步读目录并排序；排序时对每个文件取 metadata；无取消点。
- [x] 时间/ID：按文件 mtime 降序，mtime 读取失败按 `UNIX_EPOCH`（`commands.rs:6322–6338`）。

## 命令 `log_debug_message`

<!-- BEGIN GENERATED:cmd:log_debug_message -->
- Rust：`src-tauri/src/debug_commands.rs:154` · async
- 前端：app（1 处，例 `src/features/workbench/core/wallpaperDiagnostics.ts:50`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：message: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:log_debug_message -->

- [x] 输入：`message: string`（`debug_commands.rs:154`）。
- [x] 输出：`null`（`Result<(), String>`）。
- [x] 错误：无错误分支；日志写入不会失败（`debug_commands.rs:154–160`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步写 tracing 与 stdout；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `open_log_file`

<!-- BEGIN GENERATED:cmd:open_log_file -->
- Rust：`src-tauri/src/commands.rs:6345` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：logPath: string
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:open_log_file -->

- [x] 输入：`logPath: string`（`commands.rs:6345`）。
- [x] 输出：`null`（`Result<()>`）。
- [x] 错误：含 `..` 或以 `/`/`\` 开头 → `AppError::Validation("非法的文件路径")`；文件不存在 → `AppError::NotFound("日志文件不存在: …")`；规范化后越界 → `AppError::Validation("非法的文件路径访问")`；启动打开命令失败 → `AppError::FileSystem("打开日志文件失败: …")`（`commands.rs:6345–6401`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步 canonicalize + 启动系统打开命令；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `open_logs_folder`

<!-- BEGIN GENERATED:cmd:open_logs_folder -->
- Rust：`src-tauri/src/commands.rs:6403` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：logType: string
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:open_logs_folder -->

- [x] 输入：`logType: string`，`all`/`backend` 映射日志根，`frontend`/`debug`/`crash` 映射子目录（`commands.rs:6403`）。
- [x] 输出：`null`（`Result<()>`）。
- [x] 错误：未知类型 → `AppError::Validation("不支持的日志类型")`；创建目录失败 → `AppError::FileSystem("创建日志目录失败: …")`；启动打开命令失败 → `AppError::FileSystem("打开日志文件夹失败: …")`（`commands.rs:6403–6460`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步创建目录并启动系统打开命令；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `pick_backup_directory`

<!-- BEGIN GENERATED:cmd:pick_backup_directory -->
- Rust：`src-tauri/src/backup_config.rs:136` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：string | null · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:pick_backup_directory -->

- [x] 输入：无参数；弹出目录选择框，标题固定「选择备份目录」，取消返回 `null`（`backup_config.rs:136–170`）。
- [x] 输出：选中的绝对路径，或取消时 `null`；选中后立即把 `backupDirectory` 写回 `backup.config`（`backup_config.rs:157–168`）。
- [x] 错误：读/写设置失败 → `AppError::Database("数据库错误: …")`；配置 JSON 损坏 → `AppError::internal("解析备份配置失败: …")`；对话框取消不是错误（`backup_config.rs:157–168`）。Electron 侧走 F2 `dialog.open`（`electron/shell/plugins/dialog.ts:123–141`）。
- [x] 事件：无。
- [x] DB 读写：读后写主库 `settings` 表 `backup.config`；仅更新 `backupDirectory`，其余字段保留（`backup_config.rs:161–163`）。
- [x] 取消/并发：对话框取消返回 `null` 且不写设置；没有额外锁，写入是单条 SQLite UPSERT。
- [x] 时间/ID：写入时 `updated_at = Utc::now().to_rfc3339()`；不生成其他 ID。

## 命令 `read_debug_log_file`

<!-- BEGIN GENERATED:cmd:read_debug_log_file -->
- Rust：`src-tauri/src/commands.rs:644` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：path: string
  - 结果：string · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:read_debug_log_file -->

- [x] 输入：`path: string`；先 flush 待写日志（`commands.rs:644`）。
- [x] 输出：文件完整 UTF-8 内容（`commands.rs:644–652`，`debug_log_service.rs:694–710`）。
- [x] 错误：等待 flush 超时 → `AppError::FileSystem(…)`；路径 canonicalize 失败 → 字符串「路径解析失败: …」；不在任一 `debug-logs` 根下 → 「非法路径：不在 debug-logs 目录中」；非 `.json` → 「非法文件类型：仅允许读取 .json 文件」；读取失败 → 「读取调试日志失败: …」（`debug_log_service.rs:694–710`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：先 await flush，再同步 canonicalize/读取；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `report_frontend_log`

<!-- BEGIN GENERATED:cmd:report_frontend_log -->
- Rust：`src-tauri/src/commands.rs:6519` · async
- 前端：app（2 处，例 `src/features/learning-hub/apps/views/media/useMediaPlayback.ts:160`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：payload: FrontendLogPayload
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:report_frontend_log -->

- [x] 输入：`payload: FrontendLogPayload`，字段 `level,message,stack,component,route,url,line,column,user_agent,extra,kind`（`commands.rs:6519`）。
- [x] 输出：`null`（`Result<()>`）。
- [x] 错误：全局 logger 未初始化 → `AppError::Internal("前端日志记录器未初始化")`（`commands.rs:6519–6560`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：await `logger.log(...)`，由 DebugLogger 串行写入队列；无取消点。
- [x] 时间/ID：日志条目由 DebugLogger 生成时间戳；`line`/`column` 原样来自前端。脱敏与上限：message 16k、stack 64k、component 256、route 2k、URL 去 `?`/`#` 后 2k、UA 1k；extra 深度 4/20 项/40 键/单串 8k（`commands.rs:6462–6517`）。

## 命令 `save_test_log`

<!-- BEGIN GENERATED:cmd:save_test_log -->
- Rust：`src-tauri/src/commands.rs:6261` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：fileName: string, content: string, logType: string
  - 结果：null · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:save_test_log -->

- [x] 输入：`fileName,content,logType`（`commands.rs:6261`）。
- [x] 输出：`null`（`Result<()>`）。
- [x] 错误：`basename(fileName) !== fileName` → `AppError::Validation("非法的日志文件名")`；未知 logType → `AppError::Validation("不支持的日志类型")`；建目录/写文件失败 → `AppError::FileSystem("创建日志目录失败: …"/"写入日志文件失败: …")`（`commands.rs:6261–6294`）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：Rust 此命令体使用同步 fs；Host 按 v2 §1.7 使用异步 FS IO pool，依次 await 建目录、写满文件后才返回。校验仍先于 IO；不新增取消点或原子替换/串行保证。`log/tests/test-log-async-io.test.ts` 经 kernel 验证延迟写入期间其他命令/计时器可运行、完成后真实字节相等及原错误包装。
- [x] 成功日志：Rust `commands.rs:6292` → `ctx.logger.debug`，只在写入完成后记录带引号的路径、不记录content；校验/IO失败不记成功。沿现有路径Debug格式惯例，既有延迟IO回归观察调用顺序。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secret_prompt_capabilities`

<!-- BEGIN GENERATED:cmd:secret_prompt_capabilities -->
- Rust：`src-tauri/crates/dstu-platform/src/secret_prompt.rs:178` · sync
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：Value
<!-- END GENERATED:cmd:secret_prompt_capabilities -->

- [x] 输入：无参数（`secret_prompt.rs:178`）。
- [x] 输出：`{memoryOnly:true,oneShot:true,defaultTtlSeconds:300,maxTtlSeconds:600,chatToolAvailable:false,decryptorIntegration:{available:false,reasonCode:"DECRYPTOR_INTEGRATION_UNAVAILABLE"}}`（`secret_prompt.rs:178–192`）。
- [x] 错误：无错误分支。
- [x] 事件：无。
- [x] DB 读写：无；句柄仅在内存。
- [x] 取消/并发：无状态读取；存储内部用 Mutex 串行。
- [x] 时间/ID：TTL 常量 300/600 秒；不生成 ID。

## 命令 `secret_prompt_discard`

<!-- BEGIN GENERATED:cmd:secret_prompt_discard -->
- Rust：`src-tauri/crates/dstu-platform/src/secret_prompt.rs:173` · sync
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：handleId: string（rename_all = camelCase）
  - 结果：boolean · 注入：state
<!-- END GENERATED:cmd:secret_prompt_discard -->

- [x] 输入：`handleId: string`（`secret_prompt.rs:173`）。
- [x] 输出：是否删除了句柄 `boolean`（`secret_prompt.rs:173–175`）。
- [x] 错误：无错误分支；不存在返回 `false`。
- [x] 事件：无。
- [x] DB 读写：无；仅内存。
- [x] 取消/并发：Mutex 串行；丢弃时先 prune 过期项（`secret_prompt.rs:116–130`）。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secret_prompt_status`

<!-- BEGIN GENERATED:cmd:secret_prompt_status -->
- Rust：`src-tauri/crates/dstu-platform/src/secret_prompt.rs:161` · sync
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：handleId: string（rename_all = camelCase）
  - 结果：Value · 注入：state
<!-- END GENERATED:cmd:secret_prompt_status -->

- [x] 输入：`handleId: string`（`secret_prompt.rs:161`）。
- [x] 输出：`{available:boolean,consumerAvailable:false,reasonCode:"DECRYPTOR_INTEGRATION_UNAVAILABLE"}`（`secret_prompt.rs:161–170`）。
- [x] 错误：无错误分支。
- [x] 事件：无。
- [x] DB 读写：无；仅内存。
- [x] 取消/并发：Mutex 内 prune 后查询；无取消点。
- [x] 时间/ID：prune 用 monotonic `Instant`；不生成 ID。

## 命令 `secret_prompt_submit`

<!-- BEGIN GENERATED:cmd:secret_prompt_submit -->
- Rust：`src-tauri/crates/dstu-platform/src/secret_prompt.rs:138` · sync
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：request: SecretPromptSubmitRequest（rename_all = camelCase）
  - 结果：SecretPromptHandle · 错误：string · 注入：state
<!-- END GENERATED:cmd:secret_prompt_submit -->

- [x] 输入：`request:{purpose,secret,ttlSeconds?,memoryOnly?}`（camelCase；`secret_prompt.rs:138`）。
- [x] 输出：句柄 `{handleId,purpose,expiresInSeconds,memoryOnly,oneShot,consumerAvailable}`；当前实现因 `decryptor_integration_available()` 硬编码 false 总是失败（`secret_prompt.rs:17–19,138–158`）。
- [x] 错误：固定返回字符串 `DECRYPTOR_INTEGRATION_UNAVAILABLE`；若集成可用，非法 purpose/空 secret 分别返回 `SECRET_PROMPT_UNSUPPORTED_PURPOSE`/`SECRET_PROMPT_EMPTY`（`secret_prompt.rs:138–158`）。
- [x] 事件：无。
- [x] DB 读写：无；secret 只进内存，`Drop`/consume 时清零（`secret_prompt.rs:20–115`）。
- [x] 取消/并发：Mutex 串行；TTL `clamp(30,600)`；无取消点。
- [x] 时间/ID：句柄 ID 为随机 UUID/随机串（`secret_prompt.rs:60–100`）；TTL 为秒。

## 命令 `secure_clear_cloud_encryption_password`

<!-- BEGIN GENERATED:cmd:secure_clear_cloud_encryption_password -->
- Rust：`src-tauri/src/secure_store.rs:66` · sync
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:1097`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：CloudStorageCredentialStatus · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:secure_clear_cloud_encryption_password -->

- [x] 输入：无参数（`secure_store.rs:66`）。
- [x] 输出：`CloudStorageCredentialStatus` 四个 `*Configured` 布尔（`secure_store.rs:66–74`，`dstu-security/src/secure_store.rs:2309–2314`）。
- [x] 错误：安全存储操作失败 → `CommandError {code,message,data:{operation:"clear_cloud_encryption_password",retryable}}`（`secure_store.rs:66–74`）。
- [x] 事件：无。
- [x] DB 读写：只改安全存储文件，不写主库。
- [x] 取消/并发：Rust `SecureStore` 内部 `secret_operation_lock` 串行；TS 用插件内 Promise 链复刻。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secure_delete_cloud_credentials`

<!-- BEGIN GENERATED:cmd:secure_delete_cloud_credentials -->
- Rust：`src-tauri/src/secure_store.rs:59` · sync
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:1105`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：null · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:secure_delete_cloud_credentials -->

- [x] 输入：无参数（`secure_store.rs:59`）。
- [x] 输出：`null`（`Result<()>`）。
- [x] 错误：删除失败 → `CommandError(operation="delete_cloud_credentials")`（`secure_store.rs:49–64`）。
- [x] 事件：无。
- [x] DB 读写：只删安全存储文件。
- [x] 取消/并发：安全存储串行锁；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secure_get_cloud_credentials`

<!-- BEGIN GENERATED:cmd:secure_get_cloud_credentials -->
- Rust：`src-tauri/src/secure_store.rs:42` · sync
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:1087`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：CloudStorageCredentialStatus · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:secure_get_cloud_credentials -->

- [x] 输入：无参数（`secure_store.rs:42`）。
- [x] 输出：只返回存在状态 `{webdavPasswordConfigured,s3SecretAccessKeyConfigured,ftpPasswordConfigured,encryptionPasswordConfigured}`，绝不返回 secret 值（`secure_store.rs:42–53`）。
- [x] 错误：读取状态失败 → `CommandError(operation="get_cloud_credentials")`（`secure_store.rs:42–53`）。
- [x] 事件：无。
- [x] DB 读写：只读安全存储。
- [x] 取消/并发：安全存储串行锁；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secure_save_cloud_credentials`

<!-- BEGIN GENERATED:cmd:secure_save_cloud_credentials -->
- Rust：`src-tauri/src/secure_store.rs:26` · sync
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:1077`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：credentials: CloudStorageCredentials, encryptionPasswordIsPreexisting?: boolean | null
  - 结果：CloudStorageCredentialStatus · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:secure_save_cloud_credentials -->

- [x] 输入：`credentials: CloudStorageCredentials`，可选 `encryptionPasswordIsPreexisting?:boolean`（`secure_store.rs:26`）。
- [x] 输出：保存后的 `CloudStorageCredentialStatus`（`secure_store.rs:26–40`）。
- [x] 错误：口令过短/过弱 → `CommandError` 带 `E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT` / `E_CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK`；其他安全存储错误 → `{code,message,data:{operation:"save_cloud_credentials",retryable}}`（`secure_store.rs:26–40`）。
- [x] 事件：无。
- [x] DB 读写：只写安全存储；不写主库。
- [x] 取消/并发：安全存储串行锁；`encryptionPasswordIsPreexisting=true` 时跳过新设口令策略（`secure_store.rs:20–26`）。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secure_store_get_keystore_protection`

<!-- BEGIN GENERATED:cmd:secure_store_get_keystore_protection -->
- Rust：`src-tauri/src/secure_store.rs:84` · sync
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：KeystoreProtectionStatus · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:secure_store_get_keystore_protection -->

- [x] 输入：无参数（`secure_store.rs:84`）。
- [x] 输出：`{supported,enabled,seedInKeystore}`（`secure_store.rs:84–93`，`dstu-security/src/secure_store.rs:1523–1530`）。
- [x] 错误：读取状态失败 → `CommandError(operation="get_keystore_protection")`（`secure_store.rs:84–93`）。
- [x] 事件：无。
- [x] DB 读写：只读文件系统标记与密钥库状态，不触碰密钥值。
- [x] 取消/并发：只读；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secure_store_is_available`

<!-- BEGIN GENERATED:cmd:secure_store_is_available -->
- Rust：`src-tauri/src/secure_store.rs:77` · sync
- 前端：app（1 处，例 `src/utils/cloudStorageApi.ts:1116`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：boolean · 注入：app-handle
<!-- END GENERATED:cmd:secure_store_is_available -->

- [x] 输入：无参数（`secure_store.rs:77`）。
- [x] 输出：`boolean`（`secure_store.rs:77–81`）。
- [x] 错误：无错误分支。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步检查；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 命令 `secure_store_set_keystore_protection`

<!-- BEGIN GENERATED:cmd:secure_store_set_keystore_protection -->
- Rust：`src-tauri/src/secure_store.rs:96` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：enabled: boolean
  - 结果：KeystoreProtectionStatus · 错误：CommandError · 注入：app-handle
<!-- END GENERATED:cmd:secure_store_set_keystore_protection -->

- [x] 输入：`enabled: boolean`（`secure_store.rs:96`）。
- [x] 输出：迁移后的 `{supported,enabled,seedInKeystore}`（`secure_store.rs:96–114`）。
- [x] 错误：迁移失败 → `CommandError(operation="set_keystore_protection")`；阻塞任务 join 失败 → `CommandError("SECURE_STORE_INTERNAL","任务执行失败: …")`（`secure_store.rs:96–114`）。
- [x] 事件：无。
- [x] DB 读写：迁移 `.key_seed` 与平台密钥库，不写主库。
- [x] 取消/并发：`spawn_blocking` 执行，可能阻塞在系统授权弹窗；安全存储串行锁（`secure_store.rs:96–114`）。
- [x] 时间/ID：不生成时间/ID。

## 命令 `set_backup_config`

<!-- BEGIN GENERATED:cmd:set_backup_config -->
- Rust：`src-tauri/src/backup_config.rs:121` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:203`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：config: BackupConfig__De
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:set_backup_config -->

- [x] 输入：`config: BackupConfig__De`；字段全部可缺省，缺省值 = serde `default`（`backupDirectory=null`、`autoBackupEnabled=false`、`autoBackupIntervalHours=24`、`maxBackupCount=null`、`slimBackup=false`、`backupTiers=None`）；`BackupTier` 接受 `core_config_chat`/`vfs_full`/`large_files` 别名并规范化为 `core`/`important`/`large_assets`（`backup_config.rs:28–57`，`dstu-sync/.../backup/mod.rs:1935–1945`）。
- [x] 输出：`null`（Rust `Result<()>`）。
- [x] 错误：序列化失败（实际不可达）→ `AppError::internal("序列化备份配置失败: …")`；设置写入失败 → `AppError::Database("数据库错误: …")`（`backup_config.rs:86–91`，`models.rs:1081–1085`）。
- [x] 事件：无。
- [x] DB 读写：UPSERT 主库 `settings` 表 `backup.config`；值未变化时 `updated_at` 不更新（`dstu-storage/src/database/mod.rs:4108–4120`）。
- [x] 取消/并发：无取消点；单条同步 SQLite UPSERT，后写者覆盖。
- [x] 时间/ID：`updated_at = Utc::now().to_rfc3339()`；日志输出 `auto/interval/max/slim/tiers`，不生成其他 ID。

## 命令 `tauri_lab_frontend_log`

<!-- BEGIN GENERATED:cmd:tauri_lab_frontend_log -->
- Rust：`src-tauri/src/debug_commands.rs:163` · async
- 前端：app（1 处，例 `src/main.tsx:165`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：level: string, message: string, stack?: string | null
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:tauri_lab_frontend_log -->

- [x] 输入：`level,message,stack?`（`debug_commands.rs:163`）。
- [x] 输出：`null`；未设置 `TAURI_LAB_INSTANCE_ID` 与 `TAURI_LAB_FRONTEND_LOG` 时直接 no-op（`debug_commands.rs:163–180`）。
- [x] 错误：建父目录/打开/追加文件失败 → `Err(String)`（io 错误文本）（`debug_commands.rs:180–210`）。
- [x] 事件：无。
- [x] DB 读写：无；追加 JSONL 到 `TAURI_LAB_FRONTEND_LOG`。
- [x] 取消/并发：同步追加；无取消点。
- [x] 时间/ID：每行 `ts = Utc::now().to_rfc3339()`，`instance_id` 来自环境变量（`debug_commands.rs:180–195`）。

## 命令 `toggle_devtools`

<!-- BEGIN GENERATED:cmd:toggle_devtools -->
- Rust：`src-tauri/src/debug_commands.rs:474` · sync · `#[cfg(any(debug_assertions, feature = "devtools"))]`
- 前端：app（1 处，例 `src/dev/devtools.ts:21`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：（无）
  - 结果：boolean · 错误：string · 注入：webview-window
<!-- END GENERATED:cmd:toggle_devtools -->

- [x] 输入：无参数；Rust 注入当前 `WebviewWindow`（`debug_commands.rs:474–483`）。
- [x] 输出：切换后的 DevTools 打开状态 `boolean`（打开→false，关闭→true）（`debug_commands.rs:475–482`）。
- [x] 错误：`Result<bool, String>`；仅命令编译门控（`#[cfg(any(debug_assertions, feature = "devtools"))]`）决定是否存在，toggle 本身无错误分支（`debug_commands.rs:473–483`）。Host 侧 shell op 失败时透传字符串错误。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步切换；无取消点；同一 webview 的 DevTools 状态由 Electron 主进程串行维护。
- [x] 时间/ID：不生成时间/ID。

## 命令 `write_debug_logs`

<!-- BEGIN GENERATED:cmd:write_debug_logs -->
- Rust：`src-tauri/crates/dstu-platform/src/debug_logger.rs:892` · async
- 前端：app（1 处，例 `src/utils/debugLogger.ts:535`）
- 契约：`contracts/ipc/F4-security.json`
  - 参数：logs: LogEntry[]
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:write_debug_logs -->

- [x] 输入：`logs: LogEntry[]`（`debug_logger.rs:893`）。
- [x] 输出：`null`（`Result<(), String>`）。
- [x] 错误：阻塞任务失败 → `Err("frontend log task failed: …")`（`debug_logger.rs:893–905`）。
- [x] 事件：无。
- [x] DB 读写：无；写 `<appLogDir>/{frontend,backend,debug}` 结构化日志。
- [x] 取消/并发：`spawn_blocking` 内 `write_frontend_entries`，按 DebugLogger 队列/5 秒周期落盘；无取消点（`debug_logger.rs:893–934`）。
- [x] 时间/ID：条目时间由 DebugLogger 生成；不生成 ID。

## 命令 `write_test_report`

<!-- BEGIN GENERATED:cmd:write_test_report -->
- Rust：`src-tauri/src/commands.rs:7436` · async
- 前端：none
- 契约：`contracts/ipc/F4-security.json`
  - 参数：filename: string, content: string
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:write_test_report -->

- [x] 输入：`filename,content`（`commands.rs:7436`）。
- [x] 输出：`{success:true,path,filename}`（`commands.rs:7436–7463`）。
- [x] 错误：建目录失败 → `AppError::FileSystem("创建测试报告目录失败: …")`；写文件失败 → `AppError::FileSystem("写入测试报告失败: …")`（`commands.rs:7436–7460`）。
- [x] 事件：无。
- [x] DB 读写：无；写 `<writable_app_data_dir>/test-reports/<filename>`。
- [x] 取消/并发：同步建目录/写文件；无取消点。
- [x] 时间/ID：不生成时间/ID。

## 事件 `event_name`

<!-- BEGIN GENERATED:event:expr:event_name -->
- 动态事件名（表达式）
- 发送点：`src-tauri/src/utils/chat_helpers.rs:161`（emit）
<!-- END GENERATED:event:expr:event_name -->

- [x] 载荷：`{stage, total, groups}`；`groups` 按 `origin::provider_id` 归并，条目含 `group/provider_id/provider_label/provider_icon/items`，`items` 按 `score` 降序，`count` 为条目数（`utils/chat_helpers.rs:65–160`）。
- [x] 触发时机与顺序：仅由私有函数 `emit_unified_sources` 在 `sources` 非空且至少一条为对象时发出；**该函数在 Rust 生产代码中零调用**（`rg "emit_unified_sources" src-tauri/src` 只有定义），因此生产路径不会触发。
- [x] 节流/合并：无节流；同一次调用内按 group 合并。
- [x] 是否在事务提交后：不涉及事务；若被调用是在流式阶段同步 emit。
- [x] 目标窗口（emit / emit_to / emit_filter）：`Window::emit(&format!("{}_unified_sources", stream_event), &payload)`（`chat_helpers.rs:160–165`）；事件名随 `stream_event` 变化。
- [x] 生产接线：同一文件内的 `augment_source_metadata`、`infer_provider_info`、`truncate_snippet` 以及 `build_mistake_context`/`build_review_context`/`merge_images_into_user_message` 也均无调用方。TS 不为死代码新增生产 emit；建议协调者批准本事件按 `obsolete:zero-production-callers` 处理（尚未自行标 obsolete）。

## 跨 lane 阻塞（本 lane 自有范围之外）

F4 的 44 个命令、SPEC 清单与平台服务均已达到 A；`migration/testmap/F4-security.md` 中剩余
30 条 `pending` 全部是共享 crate（dstu-core/dstu-util）与 `src-tauri/tests` 的测试，
按 `docs/dev/electron-migration/decisions.md`「共享 crate 的测试归属」随使用方 lane 迁移。
逐行归属、缺失符号与证据见 `migration/testmap/F4-security.md` 的「BLOCKERS」表，摘要：

- **L07（9 条）**：`task_objects.rs` 的 `BatchManifest`、`CorpusManifest` 与 serde legacy 解析
  （string lineage / derived edge）已随 `ec3921030` 进入 main 的
  `host/plugins/agent-skills/api.ts`，并有 `tests/task-objects-manifests.test.ts` 9 条原名测试；
  但 main 生产代码只有定义、无真实调用方，待 L07 真实消费后逐项回证。F4 已移植其余 16 条并调用
  L07 生产实现。
- **已解除（11 条）**：`canonical_tools` 8 条已由 L03 合入 main 的
  `host/plugins/chat-pipeline/tests/canonical-tools.test.ts` 原名测试覆盖；
  `prompt_contracts` 的 `latex_output_brief_is_consistent_with_full_rules` 经
  `llm-providers/api.ts` 常量移植（F4 同名重复文件 `host/platform/util/tests/prompt-contracts.test.ts`
  已删除，4 个断言由 L03 同名用例原样保留），`latex_rules_contains_core_constraints` 由 L03
  `chat-pipeline/tests/prompt-contracts.test.ts` 原名测试覆盖；`models` 1 条经 L02
  `ctx.llm.getModelAssignments()` 移植到 `host/platform/util/tests/model-assignments.test.ts`。
- **消费方 lane（19 条）**：`agent`(3 → L04)、`prompt_contracts`(1 → L03)、
  `spaced_repetition`(15 → L15)。实现已存在于消费方插件（`review/src/review-plan.ts` 等）
  或随其流式管线迁移；L15 候选 `c4a8ba935` 已有 SM-2 导出、16 例（含 15 条原名测试）与
  `review-plan.ts::processReviewImpl` 的真实消费，待 main 集成。
- **已解除（28 条）**：`dstu-util/src/utf8_stream.rs` 8 + `utils/sse_buffer.rs` 20 已由 F4
  在 `host/platform/util/sse-buffer.ts` 收敛为单一共享实现（`Utf8StreamDecoder`、
  `SseLineBuffer`、`SseEventBuffer`、`extractStreamDataPayload`，默认 10 MiB + `scan_from`），
  28 条原名测试移植到 `host/platform/util/tests/sse-buffer.test.ts`；生产 `dstu.platform.log`
  插件已在 apply 时绑定 SSE logger（target `dstu_util::utils::sse_buffer`）。L01 的 16 MiB 本地副本与
  L02 的 `stream_validation.ts:163`、`single_shot_stream.ts:217` 两份副本待各自 lane 改用平台入口。
- **F1（1 条，已解除）**：`dstu-core/src/lib.rs::tests::app_version_is_injected_from_app_manifest`
  已随 main `e60e7a771`（包含 `1b3cedeaa`）正式可见，映射为
  `merged:host/kernel/connection.test.ts::app_version_is_injected_from_app_manifest`（main `:130`）：
  读取真实 `src-tauri/Cargo.toml` 的 `[package] version`，断言非空/≠ `"0.0.0"`；`serveHost`
  handshake 后 `runtime.app.version` 与 `ctx.app.version` 等于输入（job `20261104072840-0fec1d`
  4 tests exit 0）。无需另测三 manifest 一致性。
- **F7（2 条）**：F7 分支 `migration/testmap/F7-native.md` 已把 `token_budget.rs` 4 条全部 `ported`
  到 `host/platform/native/tests/tokenizer.test.ts`：200K 原“数”<5 秒与 100K..400K 范围保留，
  真实 Rust/WASM BPE 约 494ms，120K ratio 0.8..1.25 断言保留。当前阻塞是 tiktoken 1.0.22
  根依赖/正式集成未进 main，不是 js-tiktoken 算法性能；F4 2 行保持 pending 待映射。
- **已解除（17 条，C2 2026-11-04 确认归 F4）**：`dstu-util/src/utils/model_special_tokens.rs`
  已由 F4 实现并发布到 `host/platform/util/{api,index,model-special-tokens}.ts`；17 条测试移植到
  `host/platform/util/tests/model-special-tokens.test.ts`。L02 负责按 provider/model 选择策略，
  L01/L03 消费 `ModelWrapTokenStreamFilter`，不再各自复制策略或 token 表；L03 当前默认
  `identityWrapTokenFilter` 仅作禁用路由默认值，实际注入在 L02/L03 的流式构造点（跨 lane）。
- **已解除（5 条）**：`tests/cloud_half_configured_credentials_tests.rs` 已用 L23 发布的
  `host/plugins/sync-providers/api.ts` `validateConfig` 与真实插件的
  `ctx.syncProvider.createStorage` 移植到
  `host/platform/errors/tests/cloud-half-configured.test.ts`（含网络 I/O 前 fail-closed 计数断言）。
- **obsolete（7 条，C2 已批准）**：`error_recovery.rs`(2)、`workflow_error_handler.rs`(2)、
  `chat_query.rs`(3) 在 Rust 生产代码中零调用方（只有 `pub mod`/`pub use`），C2 已于
  2026-11-04 批准 `obsolete:zero-production-callers`
  （`migration/approvals.d/C2-platform.json`）；main 已聚合 `approvals.d/`，
  TESTMAP 已标 `obsolete:zero-production-callers`，ledger 按 B 计。
- **Argon2 性能（F7）**：`decisions.md` 已裁定 hash-wasm / @node-rs/argon2 的评估交给 F7；
  F4 侧保持 `@noble/hashes` 路径（OpenSSL 可用时优先），未引入新依赖。

生产接线已确认：`host/profiles/generate.ts` 扫描 `host/platform/*/index.ts`，
`desktop.json` 已加载全部平台入口；`cloud_config_*` 依赖的 `cloudConfig` 服务由 L21
`host/plugins/backup/index.ts:81` provide。
