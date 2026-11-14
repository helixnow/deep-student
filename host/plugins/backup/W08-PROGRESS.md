# W08 进度（备份与大文件 I/O）

## 第 1 轮（已交付）

基线 `21c9d80`；提交 `10e58f8` `ccd4a40` `504f1b2` `9f1cc47` `dde1735` `2de955c` `271a41d`。
流式 ZIP64 备份、热路径异步 I/O、共享 `host/platform/zip`、两个启动事件。

## 第 2 轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 1 | D2 降级维护启动（Rust `lib.rs:1098-1419`） | 完成 | `6b3cb85` `7ccee1a` `a71fd6e` `bd8cbe5` |
| 2 | `StorageService.startupMigrationReport()` / `startupMigrationFailure()` | 完成 | `6b3cb85` |
| 3 | `recovery-export.ts` / `checkZipSecurity` 改用 `platform/zip` 流式 | 完成 | `57188ce` |
| 4 | `host/platform/API.md` zip 节；`sync-support/SPEC.md:89` S03 说明 | 完成 | `9d9c96e` |
| 5 | 终检 + 边界（zip reader 的 Rust 原文标注） | 完成 | `adff576` |

### D2 行为（对照 Rust）

- 全局迁移失败（`run_all` Err）：storage 记录失败、按 `should_force_maintenance_mode_on_init_failure`
  重建组件健康，apply 不再抛出；`backup.restore-activation` finalizer 写 `.last_migration_error`、发
  `{success:false,error,degraded_mode:true,maintenance_mode_forced}`（`RecoveredFromBackup` 发 `recovered`
  + `message` 载荷），跳过恢复激活；强制时进入全组件维护屏障。
- 恢复激活失败：先发成功/警告载荷，再写错误文件、发 `restore_activation_failed` 载荷并进入维护屏障。
- 维护屏障：mistakes（main/manager）、vfs、chat_v2、llm_usage + agentWorkspace，持有到 Host 卸载；
  屏障建立失败仍抛 `无法建立完整数据治理维护屏障: …`（= Rust setup Err，Host 不启动）。
- `startup-finalizers.ts`、`host/kernel/connection.ts` 均未修改：finalizer 自身不再因 D2 失败而抛出。

### 有意偏离 Rust

- Rust 核心组件 blocked 时 setup 提前返回（不建 AppState）；Host 无法“不装配”已安装插件，改为对同组
  数据库建立维护屏障。维护状态命令因此报告 `is_in_maintenance_mode: true` 与被屏障的组件（Rust 此时为
  空列表 + component_issues）。恢复激活失败时 Rust 的 chat_v2/llm_usage/workspaces 是“未初始化”，Host 为
  “维护中”，对外同样是明确错误。
- 迁移定义目录缺失属于打包错误（Rust 编译期内嵌），仍让启动失败，不记为 `run_all` 失败。

### 交接

- 全局失败时，旧 schema 上的业务插件会在 apply 阶段降级（官方 profile 实测 13 个：vfs-index、notes、
  memory、sync-support、vfs、chat、chat-pipeline、llm、chatanki、mcp、sync、translation、vfs-handlers），其命令
  返回“未找到命令”而非维护错误；平台核心与 dstu.backup 在线。是否让这些插件在维护期注册“维护中”桩命令，
  需架构裁定。
- apply 与 finalizer 之间的窗口：屏障在 finalizer 阶段建立，期间插件 apply 仍可访问旧 schema 的库
  （Rust 不初始化）。如需更早 fail-close，需要 F3 允许维护期注册参与者，涉及 W07/W10/L11。
- 只有单库 blocked 的核心恢复启动模式（Rust `requires_core_recovery()` 且 Ok 分支）TS 仍未实现，非本轮范围。
- 未装 dstu.backup 的 profile 不会建立维护屏障（只有 storage 记录失败）。
- `startup-busy-handler.test.ts` 8 例失败为环境问题（缺 darwin-arm64 的 f7-sqlite-busy 预编译），
  `device_identity.test.ts` 2 例为基线 Linux 路径用例，均与本轮无关。

## 第 3 轮

| # | 任务 | 状态 | 提交 |
|---|------|------|------|
| 1 | 降级插件的维护占位命令 | 完成 | `9d84bef6` |
| 2 | 吸收 L21 / L20b / L23 在途补丁 | 完成 | `5048cdef` `ca0c332b` `638d9f63` |
| 3 | 审核 X7-cross-owner 的 sync-support 部分 | 完成（不吸收，见下） | — |
| 4 | backup / storage 不再直接读 `homedir()` | 完成 | `4f91eff3` |
| 5 | 单库 blocked 的核心恢复启动模式 | 只做设计（见下） | — |

### 维护占位命令

- `installProfile` 结束时把降级插件 `meta.commands` 交给 `CommandService._setPlaceholders`（每次装配替换）。
  占位不进 `_registrations`：同名真实命令可随时注册且优先派发，占位自动让位；`has()` / coverage 不受影响。
- 派发时才判定：`storage.startupMaintenance()`（kernel 按形状探测）非 `null` 才返回错误，否则照常
  `command not found`；ACL 先于占位判定。
- 错误形状按命令错误契约挑选第一个合法者：字符串 → AppError `{error_type:'Database',message,details}` →
  CommandError `{code:'MAINTENANCE',message,data}` → DstuError `{type:'VfsError',message}`；文本沿用 Rust
  `VfsError::Maintenance`：`MAINTENANCE_MODE: <插件短名> is temporarily unavailable`，`details/data` 带
  `{code:'MAINTENANCE', component, reason}`。
- `startupMaintenance()` 目前只在启动迁移全局失败且强制维护时给出原因。

### 在途补丁

- L21：12 个文件（WP-234 等价场景 + `migration-diagnostic.test.ts`）干净应用；场景经 `validateScenario` 校验、
  命令均在契约中。
- L20b：`sync_state` 延迟打开（首次读写才 `open_default` 并建表；打开失败映射 `Database error: 打开
  sync_state.db 失败`、不缓存可重试；直接传句柄仍构造即建表）。**TESTMAP.md 段未应用**（规则禁止改 TESTMAP），
  需要的话由账本 owner 补记。变异验证：恢复 apply 时打开，`state-lazy-open` 失败。
- L23：检查器说可直接重置，核对后发现内容并未吸收（纯文档：`get_device_id` / `is_s3_enabled` 无错误场景
  的理由 + 行号修正），引用逐条核对属实后吸收。

### X7 sync-support 审核（未吸收）

- `index.ts` 与 L20b 相同，已由 L20b 带入。
- `state.ts`：同为延迟打开，但对直接传入的句柄也延迟建表、无打开失败映射和重试；会让
  `host/e2e/data-compat/owner-databases.test.ts:123`（构造即建表）失效。以 L20b 为准。
- `tests/state.test.ts` 的 `ensureOpen()`：L20b 保持“句柄即建表”，不需要该方法。
- `tests/service-host.ts` 补 `registerFinalizer/finalizerNames`：本分支的 sync-support 依赖链（notes、
  vfs-repos）不调用这两个方法，套件 132 例全过，不需要。

### homedir

- backup：`userHomeDir(ctx)` = `ctx.paths.os.home`；用户技能目录（`backup/mod.rs:2920-2922`，无主目录时退回活动槽）
  与 `sanitize_path_for_user` 都改用它。测试把进程 `$HOME` 指向放了诱饵技能的“真实目录”，证明只读隔离目录。
- storage：插件把 `ctx.paths.os.dataLocal` 作为 `dataLocalDir`（与 integration 上 W07 `3909c309` 同一行，合并无冲突）。
  `locations.ts` 中独立实例用的 `dataLocalDir()` 未改：integration 已由 W07 改为 `paths/os-dirs.ts`，
  本分支没有该文件（paths 非本组所有），再改只会制造冲突。

### 核心恢复启动模式（设计，未实现）

Rust（`lib.rs:1098-1140` + `1312-1318`）：`initialize_with_report` 为 Ok，但报告不完全成功且 vfs 或
mistakes blocked（例如迁移失败后从快照恢复也失败）时，照常发 `{success:true, has_warnings:true, warnings}`、
不写 `.last_migration_error`，然后 setup 提前返回，不建 AppState。TS 目前在这种情况下照常装配业务插件，
插件会直接打开 blocked 的库。

方案：
1. storage `runAll` Ok 后若 `componentHealth.requiresCoreRecovery()`，记为“核心恢复”，并在 apply 内（业务插件
   之前）对 mistakes/vfs/chat_v2/llm_usage 建立维护租约，持有到 dispose；`startupMaintenance()` 同时返回原因。
   这样 apply 期就开库的插件降级并由占位命令返回 MAINTENANCE，延迟开库的插件拿到 StorageError MAINTENANCE。
2. backup：`runDataGovernanceStartup` 识别该状态，跳过恢复激活；`enterStartupFailClose` 改为复用 storage 已持有的
   租约（避免重复进入同一屏障），维护状态与 `blockedComponents()` 照 D2 报告。
3. 测试：用 coordinator 故障点 `before_db_migration::vfs` + `before_restore`（`coordinator.test.ts:990`）造出
   “Ok + vfs blocked”，跑官方 profile 全组合根，断言 `notes_list` 返回 MAINTENANCE、维护状态为真、事件为
   `has_warnings`。
4. 有意偏离 Rust：同 D2，Host 不能“不装配”插件，以维护屏障 + 占位命令代替“无 AppState”。

估算一轮，需要 storage（本组）与 backup（本组）配合，不涉及 W10 的 `startup-finalizers.ts`。

### 交接（第 3 轮）

- 第 2 轮“降级插件命令返回未找到命令”一项已由占位命令解决。
- `startupMaintenance()` 只覆盖全局迁移失败；核心恢复模式按上面的设计在下一轮实现。
- L20b 的 TESTMAP 记录（WP-278）未写入，需账本 owner 处理。
- `migration-diagnostic.test.ts`（来自 L21）本机耗时约 3 秒，预算 5 秒，高负载下可能抖动。
- 环境性失败同第 2 轮（busy-handler 8 例、device_identity 2 例）。

## 第 4 轮

### 合并态验证（merge `cb96113b` ← integration `b1f622ad`）
- `commands.ts` 自动合并后语义检查：W01 的 `_dispatch` try/catch 外壳与 `_fallbackReply` 不触及占位；占位分支仍在
  `_dispatchOnce` 内，error-model 导入改为 `./error-model.ts` 后编译通过。全量 tsc 0 错误。
- 新出现 3 例失败均在 integration `b1f622ad` 上原样复现（临时 detached worktree 验证），与本组无关：
  - `kernel/tests/profile-isolation.test.ts` W13 early reset（success / marker-error）：sync-startup 用
    `ctx.paths.os.dataLocal`（W07，测试 runtime 隔离到 `.test-home`），测试按 `XDG_DATA_HOME` 断言路径。
  - `sync-support/tests/state.test.ts` tombstone 并发例：子线程以原生 ESM 加载 `service-host.ts` → sync → chat，
    触发 `chat/src/executor-registry.ts:18` 的 `MCP_SERVER_UPDATE` 循环导入 TDZ。

### 核心恢复启动模式（已实现，`b625136a`）
Rust `lib.rs:1312-1318`：迁移 Ok 但 vfs / mistakes blocked → 发 warning 状态事件、不写 `.last_migration_error`、
不建 AppState 直接结束 setup。TS：
- storage：`runAll` 之后、业务插件装配之前调用 `enterCoreRecoveryBarrier()`，对被阻断的核心库按
  mistakes → vfs → chat_v2 → llm_usage 顺序进入维护屏障，租约随插件 effect 释放；原因取直接阻断（非依赖闭包）
  组件的 reason。`startupMaintenance()` 返回该原因，第 3 轮占位命令随之返回 MAINTENANCE；新增
  `startupCoreRecovery()` 供 backup 探测。
- backup：`Operations.adoptStartupBarrier()` 只登记 storage 已持有的库对应组件，`enterStartupFailClose()`
  跳过已接管的库，不重复进入维护；启动摘要的 schema 聚合跳过已阻断库（`init.rs` with_health 的
  `is_blocked → continue`），否则损坏的 vfs.db 让聚合抛错、事件丢失。
- 状态事件逐字段与 Rust 一致：`{success:true, global_version, migrations_applied, duration_ms, warnings,
  has_warnings:true}`，warnings 为非审计问题原因去重。
- 测试 `core-recovery-profile.test.ts`：现有故障点只是 `MigrationCoordinator` 构造选项，官方 profile 够不到，
  改用真实损坏的 `vfs.db`（8 KiB 0x5a）造出“Ok + vfs blocked”；跑官方 profile 全组合根，断言事件、维护态、
  `notes_list` MAINTENANCE 错误、llm_usage 可用、storage/backup/shell 未降级。
- 有意偏离 Rust：
  - Rust 无 AppState，全部业务命令不可用；Host 保留未阻断组件（如 llm_usage）可用，以屏障 + 占位命令代替。
  - agent workspace 不进入维护（Rust 该模式也未进入 fail-close 屏障）。
  - TS `componentHealth` 只来自 coordinator 报告，未阻断库的 schema 读取错误不像 Rust with_health 那样再隔离为 blocked。

### 迁移诊断测试（`3f77a7e4`）
- 拆成两例：正确性 + 阶段证据（日志转接、exporter、spy、5ms 计时器全保留，断言不变）；预算例只计时裸调用，
  窗口内无任何测试插桩，断言 8 个段落标题与数据目录尾行。
- 预算保持 5000ms（U-003 产品口径，C1 定为“不删不改”）。负载 23/15 核下实测：整套 backup 内 1.27–2.1s，单文件
  1.2–1.8s，余量 2.4–4 倍；插桩开销在噪声内，拆分的价值主要是超预算时不再掩盖正确性结果。
- 计时器回调由每 tick 扫描全部日志改为 exporter 置位标志。

### 交接（第 4 轮）
- 上述 3 例 integration 失败分别交 W07/W13（paths 与 early reset 测试口径）和 chat owner（循环导入）。
- `boundaries.mjs` 退出码 1：20 条均在 `electron/`、`host/e2e/`，来自 integration，本组路径无违规。
- 环境性失败同前（busy-handler 8 例无 darwin-arm64 预编译、device_identity 2 例 Linux 路径）。

## 第 8 轮

### device_identity 两例 Linux 默认路径（`6349fcde`）
- 只在非 Linux 主机上红：fixture 让 F4 `paths` 按主机 OS 推默认目录，macOS 上 `dataLocal` 是
  `~/Library/Application Support`，测试按 Linux 的 `~/.local/share` 布置旧设备 ID。服务器 Linux 日志里这两例本来就是绿的。
- fixture 加 `pathsPlatform`，两例显式传 `'linux'`，与 Rust `dirs::data_local_dir()` 的 Linux 口径一致；断言不变。
  F4 生产代码无需改动。

### FTP 仅桌面（`fa6053b1`、`e000747a`）
- 主代理决定：FTP 正式定为仅桌面。插件主体移到 `src/entry.ts`（不导入 `ftp.ts`），`index.ts` 是桌面入口，
  `DESKTOP_PLATFORM` 链接 FTP 传输；声明 `DESKTOP_ONLY_PROVIDERS = ['ftp']`。没有 FTP 传输的入口在任何 I/O 之前
  返回 `Configuration` + `E_FTP_UNSUPPORTED_ON_ANDROID`（mod.rs:271-275 兜底分支）。
- `tests/ftp_desktop_only.test.ts` 12 例：声明、闭包（共享主体 / api.ts 不含 `ftp.ts`，桌面入口只多 `ftp.ts`，
  唯一运行时导入方是 `index.ts`）、行为（含对真实回环 FTP 服务的端到端：移动形态零命令拒绝，桌面形态正常登录）。
  变异验证：往 `entry.ts` 加一条 `ftp.ts` 导入，3 条闭包断言变红。
- `--mobile-readiness` 本轮不变（sync-providers own=14），扫描器按 `index.ts` 计算；插件有 `mobile.ts` 后自动排除 `ftp.ts`。

### 未开工
- 移动端迁移：INT 的 `ctx.files` 仍无定位读写句柄、无备份根（W14 分支 `2f8c51b8` 的 OPFS 版也只有流式
  `openRead`/`openWrite`）；`password_proof` 等 W07 流式 BackupCrypto。
- backup 网关复查：INT `1fcc7743` 的 `storage/api.ts` 仍再导出 `worker-pool.ts` / `migration-worker.ts`，
  backup 仍为 own=18 gateways=11。
- §8：本组无点名条目；路径内的候选（FTP 拒绝文案按平台区分、连接检查区分环境失败）都要改前端和 i18n，只作建议。

## 第 9 轮

起点：合入 INT `fd621db5`（`59b39d2f`），无冲突。

### 数据安全：落盘顺序与 Rust 对齐（`cfdb493f`）
- `saveManifest`（mod.rs:1615-1630）、恢复激活标记（commands_restore.rs:67-90）、密钥暂存
  （mod.rs:244-315）原来都是写完直接改名或复制，断电后可能留下已改名但内容为空的文件。改为：
  临时文件 → `fsync` → `rename`（标记再 `fsync` 目录）；密钥暂存用 `create_new`、限长复制、`fsync`、0600。
- `tests/durability.test.ts` 8 例：跟踪 fs 调用顺序，逐步注入 errno，断言 Rust 同款错误前缀、失败时目标不变、临时文件被删。

### 事件循环：恢复域消费与持久域备份（`0efa61d6`、`f3f075c2`、`6d22aa6d`）
- 恢复时消费完整域（agents、user skills、webview 设置）和备份持久域时，每个文件都用
  `copyFileSync` / `readSync` 复制和哈希；4 MiB 技能文件约 8 MiB 同步 I/O。改为 `fs/promises`，报错文案和校验顺序不变。
- `restoreAuditDb` 原来 `serialize()` 整库进内存再 `writeFileSync` 覆盖目标。目标目录残留未检查点的
  `audit.db-wal` 时，旧 WAL 帧会叠到新库上：恢复报告 `restored`，库里却是旧数据。Rust（mod.rs:4098-4124）
  经目标连接跑 Backup API，先接管 WAL。改用 `Connection.backupTo`（better-sqlite3 每步 100 页，步间让出事件循环）。
  这是移植偏差，不是 Rust bug，不登记 RF。
- 槽 C/D 诊断沙箱的 `resetDir` 用同步递归删除清掉克隆的生产库，改为异步。
- 复现测试（改前红、改后绿）：`sync-io-hot-path.test.ts` 4 例（同步 I/O 字节数 < 256 KiB，另有篡改文件仍被拒）、
  `audit-restore.test.ts` 2 例（残留热 WAL、空目录）、`slot-tests.test.ts` 新增 1 例（无同步递归删除）。

### 移动端就绪（`a0f8d6ed`、`6dcb44cc`、`cbe4c655`）
`--mobile-readiness`（own = 插件内 Node 文件数，gateways = 闭包触达 Node 的插件外值导入）：

| 插件 | 本轮前 | 本轮后 |
|---|---|---|
| sync-support（移动核心） | own=1 gateways=3 | own=1 gateways=1 |
| sync-providers（移动核心） | own=14 gateways=6 | own=14 gateways=4 |
| sync（W10，移动核心） | own=55 gateways=6 | own=55 gateways=5 |
| backup（声明仅桌面） | own=18 gateways=11 | own=18 gateways=9 |

- sync-support：`util/index.ts`、`sync/api.ts` 换成 `util/portable.ts`、`util/lossless-json.ts`、`util/path.ts`、
  `storage/errors.ts`（同一个值，只是不经过 Node 桶文件）。
- backup `api.ts` 不再值导出 `governance-tool.ts`（经 cloud-config 触达 sync-providers/secrets 的 fs/dns/zlib），
  只发布类型；执行器本来就由 `index.ts` 从 `src/` 注册，插件外没有值导入方。sync、sync-providers 从这里只取
  `isOperationGuardError`，网关随之消失。
- backup、sync-providers 其余 `util/index.ts` / `util/api.ts` 导入换成 `util/portable.ts`。

剩余阻塞与归类：
- sync-support `storage/api.ts`：只用 `defineQuery`，交 W14（见交接）。
- sync-support `src/tombstone-files.ts`（own=1）：`statSync`/`lstatSync`/`readdirSync`/`existsSync`/`rm`。可以改用
  `ctx.files`（stat/readDir/exists/rm 都有），但 `ctx.files` 目前没有任何业务插件注入，`kernel/testing.ts` 的
  `createTestHost` 也不提供；sync-support 一旦依赖它，sync、sync-providers、integration、e2e 里所有不装
  `dstu.platform.files` 的测试宿主在应用 tombstone 时都会失败。需要先定测试宿主默认装 files（见交接），本轮不改。
- sync-providers own=14：`http.ts`（node:http/https）需要 `ctx.http` 流式请求；`fsutil`/`resume`/`cloud_transfer`/
  `delta_*`/`repo_check`/`password_proof`/`sync_manager`/`traits`/`webdav`/`s3` 的文件读写需要 `ctx.files` 定位句柄；
  `s3.ts` 的 `@smithy/node-http-handler` 需要换成走 `ctx.http` 的 handler；`ftp.ts` 天然仅桌面（第 8 轮已定）。
  网关：`net-policy/index.ts`（W06）、`paths/index.ts`、`secrets/backup-crypto.ts`（W07）都是纯函数放在 Node 模块里，
  见交接；`zip/index.ts` 是 `delta_restore.ts` 的 `ZipFileWriter`，等定位句柄后换成 `zip/core` + `ctx.files.openFile`。
- sync 的 `sync-providers/api.ts` 网关：sync 用的就是 `CloudSyncManager`、`runRepoCheck`、`persistDownload` 等文件实现，
  拆 api.ts 不能让 sync 变可移植，要随上面的文件 I/O 一起迁。
- backup：不是天然仅桌面（Rust 移动端同样有备份与恢复）。需要 `ctx.files` 定位句柄 + 备份根、移动端存储的
  Backup API（`backupTo`）与完整性检查、W07 流式 `BackupCrypto`；`storage/api.ts`、`storage/node.ts`、
  `migration-worker` 等网关随 W14 存储拆分。

### W14 定位句柄
- INT（含 `6c491e6f`）仍没有；W14 分支 `a18a1ec7` 已有 `ctx.files.openFile` → `RandomAccessFile`
  （`size`/`read(position,length)`/`write(data,position)`/`truncate`/`sync`/`close`）。它在结构上就是
  `zip/core` 的 `ZipByteSource` + `ZipByteSink`，ZIP 核心不需要再加适配层（核心已有内存源/目标 + Web 编解码的完整测试，
  闭包不触达 Node）。合入 INT 后 backup 的导出/导入可改为 `ctx.files.openFile` + `ZipWriter`/`ZipReader`，
  收尾顺序同桌面 `ZipFileWriter.finish`：`finish()` → `sync()` → `close()`。
- 仍需要：备份根（`FileRootName` 没有备份目录；用户自定义备份目录走 `grant()`）。

### 交接
- **W14** `host/platform/storage/api.ts:224`：`defineQuery` 定义在 api.ts，而 api.ts 第 25、27、29、31、33、34、48、165、174
  行值再导出 `workspace-deletion-owner` / `file-deletion-queue` / `deletion-journal-owner` / `worker-pool` /
  `migration-worker` / `unified-file-manager` / `locations` / `startup-database`，闭包含 better-sqlite3、fs、worker_threads。
  请把 `defineQuery` 挪到叶子模块（api.ts 再导出），或把这些 Node 值导出移到 `storage/node.ts`。
  sync-support `repository/{conflicts,pragma,state,note-history,records}.ts` 只值导入 `defineQuery`。
- **W14** 把 `a18a1ec7`（`openFile`）送进 INT；`FileRootName` 增加备份根或说明备份目录统一走 `grant()`。
- **kernel/testing.ts 负责方**：`createTestHost` 默认不提供 `files`；sync-support 改用 `ctx.files` 前需要默认装
  `dstu.platform.files`（或由各宿主补上）。
- **W06** `host/platform/net-policy/index.ts:148` `isLoopbackHost` 是纯函数，但同文件第 15 行导入 `node:dns/promises`；
  请移到叶子模块。调用方 `sync-providers/src/config.ts:1`、`backup/src/cloud-config.ts:13`（经 sync-providers/api.ts）。
- **W07** `host/platform/paths/index.ts:39,54` `normalizeDeviceId` / `deviceIdShortHash` 用 `Buffer` + `node:crypto`
  的 SHA-256，可改 `platform/crypto` 的 Web 哈希放进叶子模块；调用方 `sync-providers/src/device_id.ts:10-14`。
  `host/platform/secrets/backup-crypto.ts:350` `isEncryptedBackup` 只比较 4 字节魔数，请移到叶子模块；调用方
  `sync-providers/src/{delta_gc.ts:30,delta_restore.ts:42,delta_upload.ts:35,repo_check.ts:24}`。流式 `BackupCrypto` 仍待提供。

## 第 10 轮

起点：合入 INT `6c491e6f`；之后合入 INT `fe5feb68`（merge `1543c682`，含 W14 `a18a1ec7`）。

### 备份 ZIP 经 `ctx.files.openFile`（`476d667d`）
- 新增 `backup/src/zip-io.ts`（不导入 Node）：`ArchiveWriter.create(io, path)` = `new ZipWriter(await files.openFile(path,
  { mode: 'exclusive' }))`，`ArchiveReader.open(io, path)` = `ZipReader.open(await files.openFile(path))`；`addFile` 用
  `openFile(source)` + `sourceRangeStream` 按 1 MiB 读源文件；收尾 `finish()` → `sync()` → `close()`，`abort()` 关闭并删除。
  `zip/core` 补导出 `sourceRangeStream`。
- `zip.ts`：导出临时 ZIP、条目源文件、发布前自检、导入读 ZIP、解压临时文件、密封载荷内层 ZIP、预检临时文件都走
  `ctx.files`。没装 `files` 的宿主退回直接 fs 句柄（与原实现相同）。桌面仍用 `nodeZipCodec`，产物与无 `files` 时逐字节相同；
  报错文案不变（`FileError` 与 node 错误的 `ioMessage` 一致）。
- 备份根：INT 上 `FilesService` 没有 `backupRoot`（W14 `7992f87a` 未合入）。默认备份目录 `<appData>/recovery/backups`
  在 appData 根内，不需要授权；用户选的根外路径（导出目标、导入源与目标、待导出目录）用 `allowPath` → `grant()`
  只在本次调用内放行，成功、失败、取消都撤销。移动端 `grant()` 抛 `UnsupportedOnPlatform`，根外路径不能用。
- 仍是 node:fs 的部分（插件仍仅桌面）：`lstat`/`readdir`/`realpath`/`mkdir`/`rename`/`unlink`、清单与哈希读取、
  `ctx.secrets.backup.encryptBackupFile/decryptBackupFile`（路径式）。移动端完整备份还需要这些改走 `ctx.files`。
- 测试 `zip-files.test.ts` 18 例：zip-io 用例在桌面（node:fs + zlib）与移动（内存 OPFS + Web 编解码）各跑一遍
  （往返 + JSZip 互通、exclusive 拒绝已存在、abort 释放、目录源、损坏 ZIP、NotFound/OutsideRoots）；OPFS 产物与桌面逐字节相同；
  桌面插件层的 `openFile` 调用序列、有无 `files` 字节一致、根外授权生命周期、官方桌面 profile 往返。原有 7 个 zip/备份
  测试文件 98 例通过；`DS_ZIP_SLOW_TESTS=1` 的 7 万条目往返通过（导出 43 s、导入 522 s，与之前实测约 574 s 同量级）。
  2000 条目对比有无 `files`：导入 14.5 s / 14.4 s、12.6 s / 12.5 s，没有回退。

### 迁移诊断提速（`b1bceda9`，RF-W08-diagnostic-slots-concurrent）
- 服务器上「migration diagnostic settles within X1 5000ms」超时。剖析本地一次空库迁移约 830 ms：refinery 事务约 520 ms
  （其中提交/fsync 约 240 ms，`PROFILES.plain` 为同步 FULL）、`verifySchemaFingerprint` 约 230 ms（其中
  `buildMigrationScratch` 约 150 ms 在 `:memory:` 重放全部迁移只为算 scope）、`loadSqlMigrations` 的惰性 `sql` getter
  每次访问都重读文件约 47 ms；另有 worker 冷启动约 185 ms。后三项都在 storage，见交接。
- 本 lane 内：槽 D 用独立 worker 与槽 C 并发（两槽目录互不相干），每槽仍串行排队；报告仍按 C、D 顺序写入，C 的异常优先，
  另一槽结束并清理后才抛出。Rust 是先 C 后 D，登记 RF（proposed）。
- 本地交错基准（每版 3 轮 × 4 次冷启动）：中位数约 2570 ms → 约 1380 ms。服务器上单跑槽 C 就要 7.6 s，仅靠并发
  不能保证 < 5 s，预算未放宽。
- 测试：`migration-diagnostic.test.ts` 阶段断言改为两线程 + D 在 C 结束前开始；新增 RF 三例（D 在 C 迁移中开始并结束、
  任一槽失败时另一槽先清理）。恢复串行实现时其中两例变红（D 失败那例串行下本来也成立）。

### sync-providers 走 `ctx.http`（`bfd8f73a`、`64d9b56d`、`5a6be6c0`）
- `http.ts`：插件 `setHttpLookup(() => ctx.get('http'))`；无宿主的直接构造（测试、工具）退回全局 fetch（同样
  `accept-encoding: identity`、无整请求计时）。每跳 `redirect: 'manual'`，重定向策略仍在本文件；`timeoutMs` 取定时器上限，
  否则 `ctx.http` 默认 300 s 会截断大文件。响应头 120 s、总超时、取消只管等响应头阶段；响应体逐块 90 s 停滞；
  文案全部不变。传输错误取 `cause`，与 node:http 逐字相同（`connect ECONNREFUSED …`；对端关闭在响应头前为
  `socket hang up`、读体时为 `aborted`，code 均为 ECONNRESET）。`statusText` 仍是 node:http `STATUS_CODES`
  （与 Rust `canonical_reason` 在 203/418/509 不同，按现状保留）。上传体改为首次读取时才打开文件的 Web 流。
- `s3_http.ts` 替换 `NodeHttpHandler`：请求行/排序查询串/签名头/请求体、状态码与原因短语、`,` 合并的重复头、
  AbortError、连接超时文案、ECONNRESET/EPIPE/ETIMEDOUT 标 `TimeoutError` 都与旧 handler 逐项对比测试。
- 发现：`@smithy/node-http-handler` 4.14 的 `requestTimeout` 不带 `throwOnRequestTimeout` 时只打印告警、空闲超时也关闭，
  移植后丢了 s3.rs:194 的 `operation_attempt_timeout(120s)`，对端半开时会一直挂住。`5a6be6c0` 单独恢复：无响应头 120 s
  以 `TimeoutError`/`ETIMEDOUT` 失败，标准重试按瞬时错误重试（测试：第二次尝试成功）。这是对齐 Rust，不登记 RF。
- 与旧实现不可避免的差异（都来自 fetch / `ctx.http`）：无 body 的 GET/MKCOL/DELETE 不再带 `content-length: 0`
  （同 reqwest）；`Expect: 100-continue` 被 fetch 拒绝，S3 改为直接发送请求体（同 Rust SDK）；连接超时 30 s（桌面传输，
  同 reqwest `connect_timeout`），无宿主回退路径为 undici 默认 10 s；fetch 拒绝「bad port」（如 6000、10080）；
  服务端无视 `identity` 仍回 `content-encoding: gzip` 时 undici 会解压（Rust 未开 gzip 特性、旧实现给原始字节），见交接。
- 测试：`http_transport.test.ts` 16 例、`s3_http.test.ts` 11 例；`http.test.ts` 两例改用 Web 流/显式解码，断言不变。

### 治理工具在聊天上下文里取服务（`d48873b9`，V01-01）
- `backup_status`、`sync_status`、`sync_run` 由 chat-pipeline 的工具运行时调用，该上下文没有 inject backup/sync，
  直接读 `ctx.backup` / `ctx.sync` 抛 `cannot get property … without inject`，三个工具在官方桌面 profile 下都失败。
  改为 `ctx.get('backup')` / `ctx.get('sync')`；backup 缺失沿用原「未初始化」文案，sync 缺失为
  `The sync service is not initialized.`，分别落到 `SYNC_STATUS_FAILED` / `SYNC_FAILED`（Rust `try_state` 同款路径）。
- `governance-tool-profile-wiring.test.ts` 3 例：官方 profile 真实装配下三个工具的结果；卸载 `dstu.sync` 后
  `sync_status` 报未初始化而 `backup_status` 不受影响。改前全红。
- V01-03（`chat-pipeline/src/tool-executor-binding.ts:20`，备份屏障期间仍做 `main_db` 维护）归 W02，见交接。

### 其他
- `BLOCKERS.md:96`：`runAll` 文档去掉 `logTarget?`（类型里还在但已不生效，迁移日志固定走协调器 target）。
- 同步 I/O 复查：backup/sync-providers 热路径上已没有随数据量增长的同步读写。剩余同步调用是逐条 `lstat`/`readdir`
  （每个文件之间有 `await` 让出事件循环）、小 JSON（清单、任务记录、激活标记）和有大小上限的密钥文件
  （`crypto-restore.ts` 限长复制、`backup-manager.ts:282` 只对 crypto 文件用同步 `fileEntry`）。sync-providers `src/` 无同步 fs。

### 默认备份目录改用持久目录（`659d0784`，RF-W08-default-backup-dir-no-relocation）
- INT `fe5feb68` 的 `storage/api.ts:692` 已声明 `getPersistentAppDataDir`。W07 调用方表把 `backup-commands.ts:85` 定为持久目录，
  INTEGRATION-NOTES 12:45 把该文件归 W08。
- `get_default_backup_directory`：装了 `fileManagerPaths` 时取 `getPersistentAppDataDir()`（活动槽，与 Rust FileManager 同根，
  正常情况下结果仍是 `<数据根>/recovery/backups`），活动槽不可用时抛 `FileSystem` 错误；没装的宿主保留原回退链。
  备份插件本身一直用 `backupDir(ctx.app.dataDir)`，不经回退链；修复前这个命令是唯一还会报出回退目录的地方。
- 测试：`settings/tests/backup-commands.test.ts` 新增 RF 一例（活动槽 0555 → 报错，不建 `DeepStudent`），旧实现下变红；
  官方 profile `profile-backup-config.test.ts` 与 `backup-config.test.ts` 通过。

### sync-providers 去掉 net-policy 网关（`c2922aa1`）
- `isLoopbackHost` 已在纯函数文件 `net-policy/ip.ts:148`（只有类型导入），`sync-providers/src/config.ts:1` 改从它导入，
  不再经 `net-policy/index.ts`（第 7 行 `node:dns/promises`）。sync-providers 网关 4 → 3；原交给 W06 的一项取消。

### 仍未完成
- Task 3（sync-support `tombstone-files.ts` 改 `ctx.files`）：INT `fe5feb68` 的 `host/kernel/testing.ts:208-218` 只装
  `options.provide` / `options.plugins`，没有默认 `dstu.platform.files`，保持原样。另外 sync-support 对外的
  `pathModifiedAfter(): boolean`、`validateBlobRelativePath(): string`（`tombstones.ts:70,72` 转出）是同步签名，
  `ctx.files` 只有异步接口；sync 侧 `tombstone-needs.ts:15` 已接受 `boolean | Promise<boolean>`，`validateBlobRelativePath`
  的调用方还需要一起改成异步。
- W07 13:16 交接：`device_id.ts:14` 改从 `paths/device-id-core.ts` 导入——W07 `2cfd86b9` 未进 INT，文件不存在；
  `password_proof.ts:185-187`、`cloud_transfer.ts:160-172` 改 `decryptBackupStream`——API 已在 INT，但输入流需要
  sync-providers 先有 `files` 查找（与 `delta_restore` 同一前置），且两处错误都进用户文案，要逐条对齐，本轮只记设计；
  `BLOCKERS.md:96` 已改，`SPEC.md:458-459` 没有 `runAll` 签名，只写「不传 logTarget」，仍准确，不改。

## 第 11 轮

起点：合入 INT `390f244b`（merge 提交见 `git log`），无冲突。上一轮 tip `8de6d1cd` 未改写。

### V09-P1-3 backup 侧（`fdeff778`）
- INT 与 W10 分支（`719c916c`）的 `startup-finalizers.ts` 都没有注销接口：`register()` 返回 void，晚注册抛
  `FINALIZER_LATE_REGISTRATION`，重名抛 `FINALIZER_DUPLICATE`。
- 新增 `backup/src/startup-finalizers.ts` 的 `bindStartupFinalizer`：每个 Host（`ctx.root`）每个名字只登记一个转发钩子，
  插件实例存活期间挂上自己的回调，`ctx.effect` 卸载时摘下。卸载后不再执行旧实例、不再持有旧 ctx；重装不重复登记、不抛；
  finalizer 已开始后才首次安装则跳过并记 warn（恢复激活不能晚补）。名字已被别的模块副本登记时保留首个并记 warn。
- 测试 `startup-finalizer.test.ts` 新增 4 例 + 1 例 `it.fails`（registry 条目在卸载后移除，等 W10 的 disposer）。
  旧实现下 4 例全红；其中“卸载后再跑 finalizer”旧实现会让整个 `runStartupFinalizers()` 以 StartupFinalizerError 失败。
- 剩余（需要 W10）：registry 里的转发钩子条目本身不会移除；mobile storage 的 `storage.migration-status` 用
  `finalizerNames().includes('backup.restore-activation')` 判断是否让位，backup 在 finalizer 前卸载时状态事件会无人发送。

### H4 迁移诊断（未改代码，只有测量）
- 服务器（`land-test-1fcc774324a1`，串行版）：worker 冷启动约 1160 ms；Slot C 迁移 6592 ms（vfs 71 个迁移 4122 ms，
  每个迁移约 40 ms，四个库一致）；Slot D 0 个迁移仍 1963 ms。
- refinery 非批量（Rust 同），每个迁移两个事务；沙箱库走 `PROFILES.plain`（回滚日志 + synchronous=FULL），每次提交多次 fsync。
- 本机分段（临时计时，已撤回）：registry 7-10 ms、审计 1-1.5 ms、两次 reset 约 1 ms、D 复制 23-51 ms（不在关键路径）、
  C worker 冷启动约 250 ms + 协调器 825-1064 ms。backup 侧串行工作在 C 开始前只有约 10 ms。
- 试过 D 四个快照并行：负载 38 下 29-56 ms，与串行无差别（小库一步完成），已撤回。
- 本机交错对比（负载 32-41，4 轮）：INT 串行中位约 2150 ms，`b1bceda9` 并发中位约 1340 ms；并发版有一次 4653 ms。

### 其他
- `a8393427` device_id 改从 `paths/device-id-core.ts` 导入（sync-providers 网关 3 → 2）。
- `224abd87` ZIP 条目名按 zip 0.6.6 `enclosed_name`：Windows 盘符前缀、NUL 判为越界（V10 P3-3、S01 L5），密封载荷同样。
- `dad61bfe` Slot C/D 沙箱 reset 失败不抛（Rust `let _ =`），诊断报告照常给出失败段。

### 第 11 轮续
- `2447a975` sync-support `applyBlobTombstones` 走注入的 `TombstoneLocalFiles` 端口（默认 `fs.promises`），删除路径上
  不再有同步 fs 调用；对外同步导出（`pathModifiedAfter` 等，W10 sync 在用）不变。测试打补丁到 `node:fs` 同步函数，断言零调用。
- `3bfab4df` sync-providers `files.ts`（`setFilesLookup`，入口 effect 装、卸载清空）；`password_proof` 整文件试解改为
  `files.openRead` → `decryptBackupStream` → 丢弃明文（RF-W08-password-proof-discards-plaintext，proposed：Rust
  `sync_manager.rs:1462` 把明文写到下载目录旁）。无 `files` 时退回 `decryptBackupFile`。错误文案逐条对 Rust：打开失败
  `打开加密文件失败: …`、密码错误原文、`tempfile::tempdir` 的 ` at path "…"`。注：RF 与 files 查找同在一个提交，未拆。
- `70efcd4b` V09 P2-4：卸载 backup 时 Jobs 取消运行中/排队任务且不再发事件、不留定时器；三个沙箱命令（诊断、Slot C/D）
  在 `CallContext.signal` 中止时立即返回（内核先等在途命令再跑 effect）；governance disposer 最多等
  `GOVERNANCE_DISPOSE_WAIT_MS`（10 s），超时记 warn 不再等。剩余：`MigrationWorker.close()` 无期限（W10）。
- `dacce659` R01 I1：同一外部目录上的重叠操作各自持有 grant（W14 grant 无引用计数）。`04326165` 断言 `files.backupRoot`。
- `9185c48e` sync-support repository 的 `defineQuery` 改从 `storage/query.ts` 取值导入。
- `17a9b666` W12 冷启动：`@aws-sdk/client-s3` 推迟到第一次创建 S3 存储（本机约 55 ms）；子进程测试断言入口不加载。
- 拆分（行为不变，导出不变；新文件都不含 Node 依赖，portability 基线 0 new）：
  `48c36b88` zip.ts 1185 → 1015 + `zip-policy.ts`；`9987ef70` cloud-config.ts 922 → 529 + `cloud-config-model.ts`；
  `0b838b5d` ftp.ts 1092 → 997 + `ftp-rules.ts`；`c8514a81` manifest.ts 965 → 168 + `manifest-model.ts`（809）；
  `e7901a86` webdav.ts 910 → 758 + `webdav-rules.ts`。`zip-policy.ts` 与 `manifest-model.ts` 的 `sep`/`isAbsolute` 改从
  `platform/util/path.ts` 取（与 `node:path` 同语义），`windows-paths.test.ts` 相应多 mock 一个模块。
- 仍超 800 行：zip.ts、ftp.ts、backup-manager.ts、restore-commands.ts、delta_upload.ts。剩余部分都直接用 fs/net/crypto，
  拆成新文件会在 portability 基线里出现 NEW 条目（基线归 W14），本轮不拆。

### 合 INT `1d1fdb78`（D 趟，merge `f85496f4`）后的语义修正
- `cloud-config-model.ts` 导出 `serializableConfig`（INT 的 `wireConfig` 用到；拆分后它在模型文件里）。
- AL-09 / FROM-MAIN FM-14 (a)：W30 的自动备份调度器原先直接 `registerFinalizer`，卸载重装会撞 `FINALIZER_DUPLICATE`，
  改用 `bindStartupFinalizer` 并加进 `BACKUP_FINALIZERS`。(c)：`startup-finalizer.test.ts` 三例改用
  `startupEventSink(host)` 断言 Host 内部的迁移状态事件（W30 V03-02 把它从 webview 通道挪走了，原 `eventsNamed`
  断言会落空），断言内容不变。
- `e43872ac` `bindStartupFinalizer` 增加 `late: 'skip' | 'run'`（默认 skip）。调度器用 `run`：启动收尾已跑过之后
  卸载重装（或收尾期间恰好卸载）时，新实例在安装时立即 `start()`，否则这次进程里自动备份不再启动。恢复激活、可续任务
  仍是 skip。`run` 的回调同步抛或异步拒绝都只记 warn。测试：`auto-backup-profile.test.ts` 两例（重装后 120 s 首检恰好
  一次；收尾期间卸载再装），`startup-finalizer.test.ts` 一例（真实 F3 registry 上 skip / run / reject）。去掉 `late: 'run'`
  两例重装用例变红。
- `governance-tool-profile-wiring.test.ts` 的“without the sync plugin…”一例没有退役：INT 上 W30 的
  `governance-tool-profile.test.ts` 只有两例，都不卸载 sync，这一例是 `SYNC_SERVICE_UNAVAILABLE` 的唯一覆盖。

### AL-10（`477ca425`）
- `sync_run` 每次调用建一个 `AbortController`，作为 `services.sync.runSync` 第 4 参；`cancellation_token` 中止和 600 s
  超时都先 `abort()` 再拒绝（SYNC_CANCELLED / SYNC_TIMEOUT 不变）。sync 插件卸载的取消由 W32 在服务内部合成，不在这里。
- 测试 `governance-sync-run-signal.test.ts` 3 例：取消、超时（假定时器，599 999 ms 未中止、600 000 ms 中止）、正常完成不中止。
  HEAD 版本三例全红（没有第 4 参）；只去掉两处 `abort()` 时取消、超时两例红。

### 其他交接（lane 编排 ORCH-LOG 第 99、106、119 行）
- `3ec7c96b` W07：`delta_gc.ts:30`、`delta_restore.ts:42`、`delta_upload.ts:35` 的 `isEncryptedBackup` 改从无依赖的
  `secrets/dsbk-stream.ts` 导入（`backup-crypto.ts` 原本就是转导出同一个函数）；`repo_check.ts:379` 的
  `Buffer.from(head.subarray(0,4)).equals(DSBK_MAGIC)` 改为 `isEncryptedBackup(head)`（长度不足 4 时两者都为 false）。
- FM-08 `zip-io.ts` allowPath：已由 `dacce659` 处理（每个操作各自持有 grant）。
- W14 `crypto-restore.ts:227,231,423-426` 改 `renameWithRetrySync`：该函数只在 `assault/W14-portable-platform`
  （`6fbaec4a`），INT 的 `platform/util/node.ts` 没有，未改。
- W14 sync-providers `http.ts:291`、`s3_http.ts:153` 改 `timeoutMs: null`：INT 的 `HttpRequestInit.timeoutMs` 仍是
  `number`（W14 `0aa2b2a8` 未进 INT），继续用 `NO_WHOLE_REQUEST_TIMEOUT_MS`。
- W14 `decompress: false`：W14 结论是不做。`traits.ts:32-36` 按 `content-encoding` 置空 declared 是有意偏离，要 RF，未做。
- AL-07：W10 `5f4df9a8` 仍未进 INT，`bindStartupFinalizer` 保留（审计编排同意），`it.fails` 不变。

### H4 再测（W14 存储缓存，未提交、已还原）
- 服务器 C 趟（含 `b1bceda9` 并发）：5224 ms > 5000（FROM-MAIN FM-15）。之前串行版：A 趟 5770 ms、8196 ms、land-test 9015 ms。
- 本机临时打上 W14+W35 进 E 趟的两项（`8ad4d1f8`+`8cb83906` refinery SQL 缓存、`10ef0fca` fingerprint scope 缓存，
  只取 `refinery.ts`/`fingerprint.ts` 的三点 diff），与 INT 交错各 3 轮（负载 28-31）：预算用例 base 1064/979/1591 ms，
  patched 1093/1352/1270 ms；phases 用例 base 2012/933/1376，patched 1353/1122/1203。差异在噪声内。
- 原因：诊断的 Slot C 每次新建迁移 worker，两项缓存都按 worker（模块状态）存，首个调用不受益（W14 提交说明里也写了
  “first call unchanged”）。服务器 Slot C 的大头是每个迁移两次事务提交的 fsync（`PROFILES.plain`，synchronous=FULL），
  只有 `coordinator.ts:230` 沙箱 profile（W14，需 RF）和 `worker-entry.ts:8,71` 懒加载（冷启动）能动到它。
- 结论：E 趟两项进 INT 后服务器预计仍约 5.0-5.2 s，余量约 0 或为负；backup 侧串行工作约 10 ms，没有可再省的。
  沙箱 profile 改为不逐次 fsync 后，按本机提交/fsync 占迁移事务约一半估，服务器 Slot C 约 1.2-2.9 s、总计约 2-3 s、余量约 2-3 s。

### zlib 取消竞态（`c2824987`，新高危申请）
- 现象：heavy 目录跑 1828 例全过但 `Errors 1`（exit 1）：`TypeError: Invalid state: Controller is already closed`，
  `InflateRaw.onData`（`node:internal/webstreams/adapters`），发生在 `rust-fixes.test.ts` 的
  RF-W08-zip-entry-overflow-aborts-early 用例；单跑该文件 6 次有 2 次出现。
- 根因：Node `Duplex.toWeb` 读端 `cancel()` 只置 `wasCanceled` 并 destroy，`onData` 不检查它；pull 已调用
  `resume()` 时，排在 nextTick 的 `resume_` → `flow` 仍会把 zlib 缓冲里的块 `enqueue` 进已关闭的 controller，
  异常在 nextTick 里抛出，成为未捕获异常。Node 全局 `DecompressionStream` 用的是同一个适配器。
- 影响：`host/kernel/main.ts:69` `process.on('uncaughtException', reportFatal)` → `exitSoon(1)`，Host 进程退出。
  触发条件是解压中途取消条目流：中央目录少报大小的 ZIP（损坏或构造的备份，走 overflow 提前中止）、导入中途失败或取消。
- 修复：`platform/zip/node/file.ts` 的 `zlibTransform` 包一层读端，取消时先 `stream.pause()`（flowing 关掉后
  `resume_` 不再发 data），再取消适配器读端。deflate 同样处理。
- 测试 `platform/zip/tests/node-codec-cancel.test.ts`：子进程里 inflate / deflate 各 20 轮“有缓冲输出时取消”，统计未捕获
  异常。HEAD 版 `file.ts`：inflate 20、deflate 20；修复后 0、0。`rust-fixes.test.ts` 修复后连跑 6 次无 Errors。
- 其他调用：仓内非测试代码只有这里用 `toWeb` 适配器；`webZipCodec`（全局 Compression/DecompressionStream）只在未传
  codec 时用，桌面的 `ZipReader.open` / `ZipWriter` 调用都传了 `nodeZipCodec`。

### 待做
- W10 `5f4df9a8` 进 INT 后：`startup-finalizer.test.ts` 的 `it.fails` 转正（`bindStartupFinalizer` 用 register 返回的 disposer）。
- W14 `6fbaec4a`/`0aa2b2a8` 进 INT 后：`crypto-restore.ts` rename 重试、sync-providers `timeoutMs: null`。
