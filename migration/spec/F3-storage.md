# F3-storage 行为规格（`migration/spec/F3-storage.md`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 33 个 · 发出事件 0 种 · 契约：`contracts/ipc/F3-storage.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

### G1：llm_usage_session_summary 的 caller_id 列（有意偏离 Rust 缺陷）

Rust `dstu-storage/src/llm_usage/repo.rs:450-480` 注释“caller_id = session_id”，SQL 却是
`WHERE caller_id = ?1`；`src-tauri/migrations/llm_usage/` 8 个迁移（最新 V20260826）都没有 caller_id 列，
Rust 运行时同样报 `no such column: caller_id`。写入（repo.rs:49/73、collector.rs:299）把 caller_id 存进
session_id，读取（repo.rs:497/523）从 session_id 取回。按 commander G1 指令，TS 改为 `WHERE session_id = ?`；
其余（COUNT/COALESCE/SUM(cost) 为 NULL 时省略 estimatedCostUsd、错误映射）不变。不新增迁移：
迁移文件与 refinery checksum 必须与 Rust 一致。需架构师写入 decisions.md，并由 Rust 侧同步修正。

### WP-164：Connection / StartupDatabase 原生 busy handler

语义源：完整 `dstu-sync/src/data_governance/sync/state.rs:597-664`、rusqlite **0.40.1**
`busy.rs:12-69`；F7 WP-161 已由 main `676b29852` 发布。

| Rust 分支 | TS 落点 / 行为 |
|---|---|
| busy.rs:57-69 Some(fn) | `Connection.setBusyHandler` → F7 `NativeSqliteBusy.setBusyHandler(this.raw, handler)`，使用同一 sqlite3* |
| busy.rs:38-46 true/false/count | 原生 step 同步调用；true仅由SQLite重试锁，false回SQLite；首轮0，每次争用重置 |
| busy.rs:48-52 None/替换/timeout | null取消等待，不恢复timeout；安装替换原5000ms；后续PRAGMA替换回调 |
| busy.rs:60 catch_unwind | F7清除异常并返回false，保留SQLITE_BUSY或checkpoint busy行；F3不包装回调、不重抛原异常 |
| state.rs:626-657 屏障 | StartupDatabase公开单参数方法；worker内等待，父writer在放行前成功COMMIT |
| Connection Drop | StartupDatabase.close→Connection.close→驱动close；回滚未提交事务、F7释放callback引用 |

公开工厂参数仅增补可选 `nativeSqliteBusy?: NativeSqliteBusy`，旧签名/默认profile不变。
未提供能力时仅setBusyHandler抛INVALID_PARAM，普通SQL不依赖native服务；pre-storage无需ctx.storage。
F7参数/已关闭/回调重入TypeError原样保留，SQLite错误沿现有toStorageError保code/phase。
无新增业务表、日志、事件、定时器、取消点或JS重试；Rust此原语没有warn/error日志。
F7 timeout覆盖时仅SQLite移除回调，native引用在下一次注册或close释放，按其公开契约明确记录。
测试走真实 `dstu.native` provider + `api.ts.openStartupDatabase`；S06序号算法仍归L20b，
本包lock_probe只证明底层握手，不修改原测试映射。非Linux-x64产物和panic hook另行验收。

### WP-081：完整诊断迁移性能定位

生产入口仍为 api.ts → createMigrationWorker.runAll → migration/worker-tasks.ts →
MigrationCoordinator.runAll，对照 Rust coordinator.rs:282-428 与 commands.rs:1199-1217。
本包测量工具只在 tests/ 显式 preload；真实空 C、同输入在线克隆 D 串行，冷 worker，
单调时钟分别计加载/构造/迁移/校验与 Linux 原生 fsync/pread/pwrite，详见
`host/platform/storage/WP-081-PERFORMANCE.md`。SQL/history/逐项事务/备份恢复/顺序/日志/报告保持。
原 5s 及 X1 85/175/180 不变；测量通过不等于预算达标，D35 未闭合。

### WP-008 / B5-D17：真实 SQLite busy 握手（阻塞，2026-11-05）

Rust `dstu-sync/src/data_governance/sync/state.rs:234-239,597-664`：IMMEDIATE 在任何 SELECT
之前取写锁；真实 busy_handler 发 waiting 并暂停同次调用，writer 在 DELETE journal 下可
COMMIT，然后放行并取包含已提交事件的序号 2。三条断言均不可由最终值或计时替代。
main 的 openStartupDatabase 已提供同步 SQL 与 begin/commit/rollback/close；实际安装
better-sqlite3 13.0.3 没有公开 handler/interrupt，verbose 在 step 前，Statement.busy 是迭代锁。
本包未改生产行为、日志/错误/事务/业务表所有权；测试使用独立 lock_probe 表。
`host/platform/storage/tests/busy-capability.test.ts` 证明真实 BUSY 返回后的状态及 DEFERRED
负控的读锁阻塞/rollback/close 清理，不能证明原生回调屏障。因此 L20b 测试保持 pending，
所需 `setBusyHandler(handler: ((priorInvocations: number) => boolean) | null): void` 原生产物
由架构师/F7 裁定交付；callback 同步、null 禁用等待、timeout 覆盖及 worker 取消/引用释放
限制详见 `host/platform/storage/L20B-OBSERVABILITY.md`，当前未发布空实现。

### WP-059 / D29-path：virtualFilePolicy 服务

Rust `unified_file_manager.rs:413` `is_virtual_uri`（trim；`SPECIAL_SCHEMES` :16、`ANDROID_SAF_PREFIXES`
:19，小写前缀匹配）已由 `unified-file-manager.ts:42` 移植并经 api.ts 导出。index.ts 以
`{ isVirtualUri }` provide `virtualFilePolicy`（同一函数对象，无新判定逻辑），meta.provides 声明一致；
provide 位置在 data_space 启动之前，恢复模式下可用。消费点 builtin_resource_executor.rs:2901 →
L13 vfs/index.ts:216。测试 `host/platform/storage/tests/virtual-file-policy-service.test.ts`。

### R1 L02-04：F3 注入预算无损整数接缝

Rust `injection_budget.rs:99-106,139-158,210-325,393-432` →
`injection-budget.ts::ExactInjectionBudgetManager`，经 index.ts 的实际 injectionBudget provide 可达。

- [x] 输入：ExactBudgetConfig 的三个 usize 预算及 type_limits 均 bigint；L02 负责原文词法、
  已知字段重复、u64 范围/错误上下文，F3 不重复 JSON decoder、不拒绝合法 >2^53 值。
- [x] 分支：两次 saturating_sub；类型限制先于总预算；Critical/High/Medium 且剩余类型额度 >100
  才截断；截断后不能容纳则丢原项；类型额度不足分支不额外生成 Critical 总预算警告；优先级序
  与同组输入序保持；未配置类型额度为 1000。
- [x] 输出：精确入口的 total_chars_used/budget_remaining/allocation_stats 为 bigint；
  选中/丢弃项保留源字段，源自真实字符串的 char_count 仍为精确 number；警告文案逐条保留。
  原 number-valued manager 仅适配到同一 BigInt 核心，分配算法没有两份。
- [x] summary：十进制整数完整输出；仅 Rust :411 显式 usize as f32 位置降精度，直接一次
  舍入（避免先转 f64 的 double rounding），f32 除法/乘法后 `{:.1}` 使用 ties-to-even。
  HashMap 行序不作为测试条件。
- [x] 日志：:193 add/debug、:212 开始/info、:240 分组/debug、:293 选中/debug、:310 完成/info
  均经 storageLog 的 Rust target 输出；warning 列表不是额外 warn 日志。
- [x] 所有权/运行时：无 SQL/文件/事件/取消新增；allocate 按 Rust clone 输入项，结果修改不污染
  pending_items；只有上限已小于实际字符数组长度时才转 number 作截断索引。
- [x] 生产入口测试：injection-budget-exact.test.ts 通过真实 ctx.injectionBudget，覆盖全部五条
  Rust 原测试断言、9007199254740993−9007199254740992=1、u64::MAX、饱和减、Unicode
  截断/丢弃、零限制、摘要/日志、旧接口兼容。Node `20261104151748-925c83`、Electron
  `20261104151748-cc4988` 各 17 passed / exit 0，无 Errors；typecheck `20261104150139-85ca6b`
  exit 0，importable `20261104151748-32c80a` exit 0。
- [x] 证据等级：Rust 逐分支审读 + 生产服务入口回归；L02 typed decoder 的三个 R1 finding
  仍归 L02，不能以 F3 此接缝单元代替其命令端到端签收。

### F3-V2-05 / R4-SYNC-06 公共 owner 与 worker 接缝

新增 L21 迁移任务使用同一 worker pool，内部唯一迁移实现仍为 MigrationCoordinator.runAll。
输入为 appDataDir/migrationsDir/auditDbPath/logTarget，返回原内部报告字段和纯数据 health；
无 invoke 取消/默认超时，close 先 drain 已接受任务再 terminate。Rust `coordinator.rs:1071-1151`
启动备份 once guard 通过原 guard 的 key 集在线程间同步，不因 worker 重建重复备份；L21 仍持有
D2 操作许可来保证同目标并发边界。日志保留并送回 Host；连接关闭仍由原 coordinator finally。
真实 worker/SQLite 证明见 migration-worker.test.ts，不在主线程复制迁移算法。

- Rust workspace 准备 `file_deletion_queue.rs:261-289`：同一 SAVEPOINT 内插 prepared、
  DELETE workspace_index、RELEASE；任一步失败 rollback，文件尚不删除。
  TS 改用公开 registerWorkspaceIndexDeletionOwner，实际 SQL 由 L05 提供；缺回调明确失败，
  不回退跨 owner SQL。重复注册/释放采用 F1 Slot/Disposer，L05 scope 负责 dispose。
  `workspace-deletion-owner.test.ts` 调真实 L05 仓储，逐项核连接身份、已写 prepared、事务状态、
  SQL trigger 故障整体回滚、物理文件保留、缺记录及注册生命周期。
- Rust export `commands_sync.rs:2374-2504` 为一个 spawn_blocking 任务，依次遍历四库；
  文件不存在跳过，打开错误由调用方 if-let 决定忽略。F3 公开 runWithDatabases，任务自己调用
  openExisting；平台不替 owner 采集/吞错/构造 manifest。所有句柄在 task finally 关闭。
- `commands_backup.rs:113-118` 实际读写打开 + 5s busy；F3 既支持默认 readonly open-existing，
  也支持显式 readonly=false 的 read-write-existing。默认只读不能冒充 Rust 打开失败等价；
  L20 需选择显式模式并保持其错误/日志分支。无多库事务或额外锁。
- 文件策略公共导出保持原实现；真实 staging/copy/cleanup 完整链仍归 L20。测试仅证明 F3
  线程 hop、跨库读取、缺库不创建/目录不创建、写入拒绝、损坏库抛错以及异常退出关闭。

### v2 校正：F3-V2-02 featureFlags 版本条件和设置读取错误

- Rust `feature_flags.rs:397-403` 逐段 `parse::<u64>().unwrap_or(0)`，以 Vec 字典序比较；
  **不是 semver**，`1.0 < 1.0.0`，非法片段回退 0，可有前导 `+`，u64 溢出回退 0。
- Host `feature-flags.ts::compareVersions` 先验证完整 ASCII 数字段，再用 BigInt 做 u64
  范围校验/比较；共同前缀相等时按长度比较。不使用 parseInt，不补尾零。
- Rust `:115-122` 读取设置失败立即返回 `Failed to load feature flags: {e}`；解析失败是不同
  前缀 `Failed to parse feature flags: {e}`。Host 在 getSetting 边界补齐前者，不初始化默认值。
- 生产入口：`index.ts:85-99` 发布的 `ctx.featureFlags.load` → manager.isFeatureEnabled →
  isVersionCompatible → compareVersions；版本不兼容时在依赖和 state 分支前返回 false。
- 所有权：设置只经 F4 store；此单元无新增 SQL、文件写入、日志、取消或时钟行为。
- 证据：`tests/feature-flags-service.test.ts` 安装真实 F3/F4 插件，9 组版本条件和读取故障；
  旧实现 job `20261104112010-6bc325` **7 failed / 3 passed / exit 1**。
  修复后 Electron job `20261104112959-c89686`：该文件 10 passed，四文件合计 42 passed / exit 0，无 Errors。
- 尚未闭合：持久化 FeatureFlag/FeatureState 的严格 serde 解码与 f32 表示；公共 JSON
  原语已请求 F4/L23（见 BLOCKERS），业务结构解码仍是 F3 工作，不以本单元测试宣称完整通过。

### v2 校正：F3-V2-03 staged upload 的时间、完整写入及读取上界

适用命令 `staged_upload_begin`、`staged_upload_append`、`staged_upload_from_path`、
`staged_upload_abort` 以及消费方 `takeStagedUpload().readBounded()`。
以下是已核实的独立行为单元，不代表四条命令已完成全部 v2 验收。

| Rust 分支 | Host 落点 | 断言证据 |
|---|---|---|
| `staged_upload.rs:159-184`，Instant age > 30min 清登记项 | `staged-upload.ts::sweep` / `Entry.lastTouch` 使用 performance.now | kernel begin 触发 sweep；墙钟前跳不误删、后跳不延期、等于 TTL 不删、append 刷新 |
| `:199-208`，未登记文件以 SystemTime 和 mtime 比较 | sweep 孤儿分支保留 Date.now | 旧孤儿删除、未来 mtime 保留 |
| `:277-287`，write_all 失败 abort；成功才更新 received/last_touch | append → writeAll → 更新条目 | 真实文件模拟短写后全部 6 字节；零写拒绝且文件/登记项删除 |
| `:338-365`，io::copy 完整写入；失败移除部分文件 | stageFromReader → writeAll / catch 清理 | kernel from_path 经真实文件源，短写仍输出全部字节 |
| `:117-137`，先拒绝声明 size 超限，读取至 max+1，先判断上限再判断磁盘大小变化 | StagedFile.readBounded 有界分块读 | kernel 上传后真实磁盘增长到 9 字节；max=10 报 read 9，max=6 先报超限 |

- [x] 入口：Rust `:447,462,491,511` → `index.ts:366-391`；readBounded 为 L13 消费端公共入口。
- [x] 本单元边界：只处理已解码的上传条目/字节；未改变 IPC 键及返回类型。
- [x] 日志：sweep 过期 info、StagedFile 删除失败 warn 保持原有落点；本修复未吞错误。
- [x] 错误顺序：短写继续；WriteZero 文案 `failed to write whole buffer`；append 失败先 abort 再返回原前缀；readBounded 上限先于大小变化。
- [x] 所有权：只读写 appCacheDir/staged_uploads 及调用方指定的只读源文件；不写数据库。
- [x] 资源/时钟：文件描述符在 finally 关闭；登记项用单调时钟；孤儿文件 mtime 用墙钟；不添加前端取消语义。
- [x] 生产入口证据：`tests/staged-upload-runtime.test.ts` 经真实 kernel 注册命令；原有九条 Rust 用例断言保持，新增七条回归。
- [x] 红绿证明：job `20261104110429-33c429` 旧实现 6 failed / 1 passed / exit 1；job `20261104110800-138210` 修复后 17 passed / exit 0，无 Errors 行。
- [x] offset：Rust `:384-390` trim + parse u64 支持前导加号、拒绝负数/溢出；header 超安全整数保留 BigInt，append 精确比较并输出原十进制。JSON `:407-411` 已解码整数按 u64 范围处理，不额外拒绝 >2^53。新增六条 kernel 用例，`20261104112623-5b5bc0` 6 passed / exit 0；Electron `20261104112959-c89686` 覆盖全部 13 条运行时回归。
- [x] base64 错误 Display：F4 共享 decoder 已在 main，staged_upload.rs:416-421 的 UTF-8 字节长度前置检查与 STANDARD DecodeError 完整前缀已接入；非法符号/长度/padding/尾位分别保留原文，错误不写上传文件。file_manager.rs:56-69 的非法尾位原字符串回退及 error 日志（含原因/target）也已对齐。
- [x] 红绿证据（共享 decoder）：旧实现 `20261104141704-9a5eeb` 7 failed / 14 passed / exit 1；Node `20261104142339-f96491`、Electron `20261104142339-5997a4` 各四文件 37 passed / exit 0，无 Errors；typecheck `20261104142339-0c9167` exit 0。
- [ ] 四条命令剩余 v2 审读：同步 IO / CPU 解码的 spawn_blocking 对应边界。offload 仍是自有工作；共享词法库不能替代其他持久化结构的 typed decoder。

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：`Option::None` 字段一律省略（`skip_serializing_if = "Option::is_none"`，llm_usage/types.rs:206）；Host 用 `undefined`/条件展开，不输出 `null`；命令参数里的 `null` 视为缺省（contracts.ts:225）。
- [ ] u64/i64 超过 2^53 的表示：按 D3 内部必须精确；旧“计数远低于 2^53”不能作为证据。版本条件已用 BigInt，llm_usage 聚合/恢复 size_bytes/上传 offset 仍待逐项修复与核验。
- [x] 字段顺序（serde_json preserve_order）：Host 对象按 Rust 结构声明顺序构造；serde_json 未开 preserve_order，前端不得按字节序比较。
- [ ] f32 精度：feature_flags 的 Gradual/rollout_percentage/哈希阈值仍需对齐 Rust f32 舍入及 JSON 表示，旧“仅存 settings”不是豁免。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：data_space 命令抛 `CommandError(AppError)`（error_type/message/details）；staged upload 与 llm usage 抛 `CommandError(string)`，对应 Rust `Result<_, String>`；panic 路径未复刻为永不 settle。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：Host 为每次 invoke 建 AbortController 并传入 CallContext.signal；本 lane 的 Rust 命令均不观察取消，Host 同样不因页面关闭中止（staged upload 由前端显式 abort）。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：data_space 状态读写经 DataSpaceManager 同步串行；staged upload 注册表为单线程 Map；llm usage 走 better-sqlite3 同步连接，维护屏障期间 `storage.database()` 抛 `MAINTENANCE`（service.ts:79）。
- [x] 时间与 ID：生成方式、格式、时区：普通时间统一走 F4 `host/platform/time`（chrono `to_rfc3339()` AutoSi，偏移 `+00:00`；F3 `time.ts` 只是保留毫秒精度的入口，`migration/refinery.ts` 的 `time` crate 格式与 `coordinator.rs:1087` 的快照格式也用其格式化原语）；IPC 字段类型为 `DateTime<Utc>` 的（`llm_usage` 的 `createdAt`/`startDate`/`endDate`）按 chrono serde 输出 UTC `Z` 并保留 9 位纳秒（X3-F3-01，见下方 llm_usage 节）；ID 用 `crypto.randomUUID()`（`usage_` 前缀、staged upload 32 位 hex）。
- [x] 启动预检的旧版根目录扫描：忽略 `slots`/`logs`/`recovery`/`.purge_on_next_start`（data_space.rs:517、1060-1080）以及 F4 安全工件 `.secure`/`.master_key`/`.key_seed`/`.crypto_restore_journal.json`/`.crypto_restore_rollback`。Rust 的 `prepare_startup_recovery`（lib.rs:933）早于 `SecureStore::new_with_dir` 创建这些路径；Host 插件装配期 `secrets` 已创建 `.secure`，若按 Rust 列表扫描会让每次启动误入恢复模式。实现见 `locations.ts` `isLegacyRootEntry`。
- [x] 不对含 HashMap 的结构做序列化后比对：命令结果不含 HashMap；settings/feature flags 的 JSON 仅透传字符串，不做序列化后比对。

## 命令 `clear_test_slots`

<!-- BEGIN GENERATED:cmd:clear_test_slots -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2598` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:210`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:clear_test_slots -->

- [x] 输入：无参数（契约 `Record<string, never>`）。
- [x] 输出：固定字符串 `测试插槽 C 和 D 已清空`（index.ts:104；Rust data_space.rs:2598）。
- [x] 错误：`clearTestSlots` 失败包装为 `AppError.file_system('清空测试插槽失败: …')`。
- [x] 事件：无。
- [x] DB 读写：仅删除 slotC/slotD 目录内容，不触碰活动槽数据库。
- [x] 取消/并发：同步执行，DataSpaceManager 串行。
- [x] 时间/ID：无。

## 命令 `export_startup_recovery_incident`

<!-- BEGIN GENERATED:cmd:export_startup_recovery_incident -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2231` · async
- 前端：app（1 处，例 `src/features/data-recovery/dataRecoveryApi.ts:139`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：incidentId: string, destination: string
  - 结果：string · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:export_startup_recovery_incident -->

- [x] 输入：`incidentId: string, destination: string`（data_space.rs:2231）。
- [x] 输出：目标路径字符串（本地路径原样返回；虚拟 URI 返回原 `destination`）。
- [x] 错误：定位失败 → `AppError.file_system('定位恢复事件目录失败: …')`；打包失败 → `导出恢复事件失败: …`；虚拟目标写入失败 → `写入目标位置失败: …`；双重编码 URI → `AppError.validation`（unified_file_manager.rs:423）。
- [x] 事件：无。
- [x] DB 读写：不读写数据库；读取 `recovery/incidents/<id>`，打包为 ZIP（`zip.partial` → `zip.previous` 回滚语义），虚拟目标经 `recovery/export-staging/<uuid>.zip` 暂存后复制并回读校验。
- [x] 取消/并发：Rust `spawn_blocking`；Host 以 async 顺序执行同一流程，无取消点（页面关闭不中止）。
- [x] 时间/ID：暂存文件名用 `crypto.randomUUID()`；不生成业务 ID。

## 命令 `export_startup_recovery_report`

<!-- BEGIN GENERATED:cmd:export_startup_recovery_report -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2269` · sync
- 前端：app（1 处，例 `src/features/data-recovery/dataRecoveryApi.ts:151`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：destination: string
  - 结果：string · 错误：AppError · 注入：app-handle, window, state
<!-- END GENERATED:cmd:export_startup_recovery_report -->

- [x] 输入：`destination: string`（data_space.rs:2269）。
- [x] 输出：目标路径字符串（本地路径原样返回；虚拟 URI 返回原 `destination`）。
- [x] 错误：读取状态失败 → `AppError.internal('读取恢复状态失败: …')`；序列化失败 → `生成诊断报告失败: …`；虚拟目标暂存失败 → `创建诊断报告临时文件失败: …`；写入失败 → `写入诊断报告失败: …`；目录创建失败 → `创建诊断报告目录失败: …`；复制失败 → `写入目标位置失败: …`。
- [x] 事件：无。
- [x] DB 读写：不读写数据库；只读恢复状态与 `recovery/incidents` 清单，`component_health` 取启动迁移报告的内存快照（恢复模式下为 `null`，对应 Rust data_governance 状态尚未注册）。
- [x] 取消/并发：Rust 同步命令；Host async 写文件，无取消点。
- [x] 时间/ID：`generated_at` 为当前 UTC（Rust `chrono::Utc::now().to_rfc3339()`；Host 用 `toISOString` 毫秒精度）；`format_version` 固定 1。

## 命令 `get_data_space_info`

<!-- BEGIN GENERATED:cmd:get_data_space_info -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2493` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:164`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：DataSpaceInfo · 错误：AppError
<!-- END GENERATED:cmd:get_data_space_info -->

- [x] 输入：无参数。
- [x] 输出：`{ active_slot, inactive_slot, pending_slot, active_dir, inactive_dir }`，slot 仅 slotA/slotB（data_space.rs:2493）。
- [x] 错误：`readState` 失败 → `AppError.internal('读取数据空间状态失败: …')`。
- [x] 事件：无。
- [x] DB 读写：只读 state.json，不打开数据库。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `get_database_info`

<!-- BEGIN GENERATED:cmd:get_database_info -->
- Rust：`src-tauri/src/commands.rs:7308` · async
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_database_info -->

- [x] 输入：无参数（契约 `Record<string, never>`）。
- [x] 输出：`{ production_db_path, test_db_path, test_db_exists, production_db_exists, active_database }`（键序同 Rust `serde_json::json!`，commands.rs:7308）。
- [x] 错误：数据空间未初始化 → `AppError.internal('数据空间管理器未初始化')`（Host 恢复模式下 AppState 不构建，Rust 对应 Tauri state 提取失败）。
- [x] 事件：无。
- [x] DB 读写：只读：`activeDir/mistakes.db`、`activeDir/test_mistakes.db` 的 `exists`；`active_database` 取 L22 `appCommandState`（缺省 `production`）。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `get_slot_directory`

<!-- BEGIN GENERATED:cmd:get_slot_directory -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2616` · sync
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：slotName: string
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:get_slot_directory -->

- [x] 输入：`slotName: string`。
- [x] 输出：槽目录绝对路径。
- [x] 错误：非法名称 → `AppError.validation('无效的插槽名称: …')`（data_space.rs:2616）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `get_startup_recovery_status`

<!-- BEGIN GENERATED:cmd:get_startup_recovery_status -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2169` · async
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：StartupRecoveryStatus · 错误：AppError · 注入：app-handle
<!-- END GENERATED:cmd:get_startup_recovery_status -->

- [x] 输入：无参数。
- [x] 输出：`{ recovery_required, incident? }`（StartupRecoveryStatus，data_space.rs:2169）。
- [x] 错误：wait false → AppError.internal(`应用启动初始化超时（120 秒），请重启应用`)；status 读取失败 → AppError.internal(`读取启动恢复状态失败: {e}`)。缺 gate 是 Host 组合配置错误，明确返回 `启动完成闸门服务未注册`，不静默视作 Ready。
- [x] 事件：无。
- [x] DB 读写：只读 recovery 事件目录，不打开业务库。
- [x] 取消/并发：异步等待 F2 真实 startupGate 120000ms；不因页面放弃 invoke 取消等待。F1 负责成功/恢复启动 mark；F3 不 mark，不用 finally 强行放行。
- [x] 时间/ID：事件 `created_at`/`resolved_at` 原样返回（ISO UTC）。

### v2 完成清单（F3-V2-06）

- [x] 入口：Rust `data_space.rs:2170-2187` → storage/index.ts 注册 handler。
- [x] 分支：`:2176` wait true/false → `waitStartupReady(120_000)` / 精确超时 AppError；`:2185-2187` status Result → try/catch AppError。Rust `:2182-2184` state 缺失在 Host 本命令注册前构造 DataSpaceStartup 的结构下不可达，不能用空状态冒充。
- [x] 数据边界：无入参，输出恢复状态保持原形状，AppError details=null。持久化 incident 的完整 serde 解码另由 F3-V2-01 跟踪，未因此签收。
- [x] 日志：此 Rust handler 没有 warn/error/info；不新增日志替代错误返回。
- [x] 错误映射：先等待、后读取，超时不读取状态；缺 provider 显式配置失败。
- [x] 所有权：只读内存 recovery state，F2 所有 readiness 状态；不写表或文件。
- [x] 运行时：真实 gate 定时器负责有界等待；不引入取消点；晚订阅立即返回；恢复模式也等待后返回 recovery_required=true。
- [x] 测试证据：`tests/startup-gate-command.test.ts` 真实 F2 shell/F3 插件，经 kernel 验证正常/恢复模式等待、晚订阅、120s 超时、读错和无 provider；job `20261104114016-056342` 三文件 20 passed / exit 0，无 Errors。状态读取异常是边界故障注入，不冒充 Rust Mutex poisoning 测试。
- [x] Electron 同入口：`20261104114330-df8fd9` 5 passed / exit 0，无 Errors；类型检查 `20261104114016-807a86` exit 0，原生类型擦除导入 `20261104114330-fab974` exit 0。
- [x] 证据等级：源码逐分支审读 + 生产入口测试；未声明 F1 组合根端到端复验已完成。

## 命令 `get_test_slot_info`

<!-- BEGIN GENERATED:cmd:get_test_slot_info -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2576` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:202`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：TestSlotInfo · 错误：AppError
<!-- END GENERATED:cmd:get_test_slot_info -->

- [x] 输入：无参数。
- [x] 输出：`{ slot_c_dir, slot_d_dir, slot_c_exists, slot_d_exists, slot_c_file_count, slot_d_file_count }`（data_space.rs:2576）。
- [x] 错误：无（目录读取失败按 0）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `list_startup_recovery_incidents`

<!-- BEGIN GENERATED:cmd:list_startup_recovery_incidents -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2469` · sync
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：StartupRecoveryIncident[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:list_startup_recovery_incidents -->

- [x] 输入：无参数。
- [x] 输出：`StartupRecoveryIncident[]`。
- [x] 错误：读取失败 → `AppError.file_system('读取启动恢复记录失败: …')`。
- [x] 事件：无。
- [x] DB 读写：只读 `recovery/incidents` 目录。
- [x] 取消/并发：同步。
- [x] 时间/ID：事件时间字段原样返回。

## 命令 `llm_usage_by_caller`

<!-- BEGIN GENERATED:cmd:llm_usage_by_caller -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:39` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:108`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：startDate: string, endDate: string（rename_all = camelCase）
  - 结果：CallerTypeSummary[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_by_caller -->

- [x] 输入：`startDate: string, endDate: string`。
- [x] 输出：`CallerTypeSummary[]`（`caller_type` 解析为枚举，Other 为 `{other}`）。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：只读。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `llm_usage_by_model`

<!-- BEGIN GENERATED:cmd:llm_usage_by_model -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:29` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:105`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：startDate: string, endDate: string（rename_all = camelCase）
  - 结果：ModelSummary[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_by_model -->

- [x] 输入：`startDate: string, endDate: string`。
- [x] 输出：`ModelSummary[]`（按 total_tokens DESC）。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：只读，`date_key` 范围过滤。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `llm_usage_cleanup`

<!-- BEGIN GENERATED:cmd:llm_usage_cleanup -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:89` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:124`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：beforeDate: string（rename_all = camelCase）
  - 结果：integer(usize) · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_cleanup -->

- [x] 输入：`beforeDate: string`。
- [x] 输出：删除行数 number。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：`DELETE FROM llm_usage_logs WHERE date_key < ?`。
- [x] 取消/并发：同步单写者。
- [x] 时间/ID：无。

## 命令 `llm_usage_daily`

<!-- BEGIN GENERATED:cmd:llm_usage_daily -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:79` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:121`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：startDate: string, endDate: string（rename_all = camelCase）
  - 结果：DailySummary[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_daily -->

- [x] 输入：`startDate: string, endDate: string`。
- [x] 输出：`DailySummary[]`（`date_key` DESC）。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：只读。
- [x] 取消/并发：同步。
- [x] 时间/ID：`date` 为 `date_key`。

## 命令 `llm_usage_get_trends`

<!-- BEGIN GENERATED:cmd:llm_usage_get_trends -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:11` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:102`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：days: integer(u32), granularity: string
  - 结果：UsageTrendPoint[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_get_trends -->

- [x] 输入：`days: number, granularity: string`（hour/day/week/month，未知按 day）。
- [x] 输出：`UsageTrendPoint[]`，`timestamp` 为 `MIN(timestamp)` 毫秒。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：只读 `llm_usage_logs`，`strftime` 分组 + `datetime('now', '-N days')`。
- [x] 取消/并发：同步。
- [x] 时间/ID：`timeLabel` 按粒度格式；`timestamp` 解析失败为 0。

## 命令 `llm_usage_recent`

<!-- BEGIN GENERATED:cmd:llm_usage_recent -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:70` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:118`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：limit?: integer(u32) | null
  - 结果：UsageRecord[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_recent -->

- [x] 输入：`limit?: number | null`（默认 50）。
- [x] 输出：`UsageRecord[]`（timestamp DESC）。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：只读。
- [x] 取消/并发：同步。
- [x] 时间/ID：`createdAt` 按 Rust `DateTime<Utc>` serde 输出 UTC `Z`（AutoSi，保留 9 位纳秒）；解析失败回退 `1970-01-01T00:00:00Z`；库内时间文本不改写。

## 命令 `llm_usage_session_summary`

<!-- BEGIN GENERATED:cmd:llm_usage_session_summary -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:61` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:115`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：sessionId: string（rename_all = camelCase）
  - 结果：SessionUsageSummary · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_session_summary -->

- [x] 输入：`sessionId: string`。
- [x] 输出：`SessionUsageSummary`（无记录时计数为 0）。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：只读 `caller_id = ?`。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `llm_usage_summary`

<!-- BEGIN GENERATED:cmd:llm_usage_summary -->
- Rust：`src-tauri/crates/dstu-storage/src/llm_usage/handlers.rs:49` · async
- 前端：app（1 处，例 `src/api/llmUsageApi.ts:111`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：startDate?: string | null, endDate?: string | null（rename_all = camelCase）
  - 结果：UsageSummary · 错误：string · 注入：state
<!-- END GENERATED:cmd:llm_usage_summary -->

- [x] 输入：`startDate?: string | null, endDate?: string | null`。
- [x] 输出：`UsageSummary`（含 `avgTokensPerRequest`；start/end 用请求边界、首末记录或 now）。
- [x] 错误：数据库错误转字符串。
- [x] 事件：无。
- [x] DB 读写：只读聚合。
- [x] 取消/并发：同步。
- [x] 时间/ID：日期边界 UTC 00:00:00 / 23:59:59.999；`startDate`/`endDate` 按 Rust `DateTime<Utc>` serde 输出 `Z`（AutoSi）。

## 命令 `mark_data_space_pending_switch_to_inactive`

<!-- BEGIN GENERATED:cmd:mark_data_space_pending_switch_to_inactive -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2523` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:181`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:mark_data_space_pending_switch_to_inactive -->

- [x] 输入：无参数。
- [x] 输出：`已标记下次重启切换到 <slot>`。
- [x] 错误：`markPendingSwitch` 失败 → `AppError.file_system('标记切换失败: …')`。
- [x] 事件：无。
- [x] DB 读写：写 state.json 的 pending 字段，不打开业务库。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `open_startup_recovery_incident_folder`

<!-- BEGIN GENERATED:cmd:open_startup_recovery_incident_folder -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2197` · sync
- 前端：app（1 处，例 `src/features/data-recovery/dataRecoveryApi.ts:128`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：incidentId: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:open_startup_recovery_incident_folder -->

- [x] 输入：`incidentId: string`。
- [x] 输出：`null`。
- [x] 错误：定位/打开失败 → `AppError.file_system('定位恢复事件目录失败: …' / '打开恢复事件目录失败: …')`。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：异步 spawn 系统文件管理器，等待 spawn 成功。
- [x] 时间/ID：无。

## 命令 `purge_active_data_dir_now`

<!-- BEGIN GENERATED:cmd:purge_active_data_dir_now -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2552` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:252`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:purge_active_data_dir_now -->

- [x] 输入：无参数。
- [x] 输出：不返回，直接抛错。
- [x] 错误：固定 `AppError.validation('为保证数据库连接安全，移动端清空数据需要完整退出并重新打开应用，不能仅刷新页面')`（data_space.rs:2552）。
- [x] 事件：无。
- [x] DB 读写：不执行任何删除。
- [x] 取消/并发：同步。
- [x] 时间/ID：无。

## 命令 `purge_all_database_files`

<!-- BEGIN GENERATED:cmd:purge_all_database_files -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2539` · sync
- 前端：app（1 处，例 `src/utils/systemApi.ts:240`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:purge_all_database_files -->

- [x] 输入：无参数。
- [x] 输出：固定 `已标记：下次启动将清空所有数据（备份保留），即将重启应用以完成清空。`
- [x] 错误：写标记失败时向上抛底层异常。
- [x] 事件：无。
- [x] DB 读写：写 purge marker 文件，不直接删库。
- [x] 取消/并发：同步。
- [x] 时间/ID：marker 由下次启动消费。

## 命令 `reset_test_database`

<!-- BEGIN GENERATED:cmd:reset_test_database -->
- Rust：`src-tauri/src/commands.rs:7215` · async
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:reset_test_database -->

- [x] 输入：无参数（契约 `Record<string, never>`；`src-tauri/src/commands.rs:7215`）。
- [x] 输出：`{ success: true, test_db_path, deleted_files, message: '测试数据库已重置', active_database }`；`deleted_files` 按主库、`-wal`、`-shm` 的顺序记录实际存在的文件（commands.rs:7226-7244），`active_database` 为切换状态原值（`production`/`test`；commands.rs:7262-7270）。
- [x] 错误：删除主库失败 → `AppError.file_system('删除测试数据库文件失败: …')`；重建失败 → `AppError.file_system('重新创建测试数据库失败: …')`；活动库为测试库时切换连接/连接池失败 → `AppError.internal('切换数据库连接失败: …')` / `AppError.internal('刷新数据库连接池失败: …')`（commands.rs:7231-7259）。Host 对应实现见 index.ts:224-244。
- [x] 事件：无。
- [x] DB 读写：删除 `<active>/test_mistakes.db` 及 `-wal`/`-shm`，再用 `Database::new` 重建空库；仅当 `active_database == Test` 时把主连接与连接池切回该测试库（commands.rs:7226-7259；index.ts:224-244）。
- [x] 取消/并发：Rust 异步命令，读取 `active_database` 锁；Host 同步执行并直接更新既有的 `appCommandState.activeDatabase`（index.ts:224-244）。
- [x] 时间/ID：不生成时间/ID；路径由活动数据目录 + `test_mistakes.db` 决定（test-database.ts:18-20）。
- [x] 日志：删除 `-wal`/`-shm` 失败按 Rust `let _ =` 忽略并继续；重置成功记 `info!("[测试模式] 已重置测试数据库: {:?}")`（commands.rs:7246-7250），Host 用 `storageLog(... 'info')` 记录同一文案（index.ts:243）。

## 命令 `resolve_startup_recovery`

<!-- BEGIN GENERATED:cmd:resolve_startup_recovery -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2478` · sync
- 前端：app（1 处，例 `src/features/data-recovery/dataRecoveryApi.ts:157`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：candidateId: string
  - 结果：StartupRecoveryResolveResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:resolve_startup_recovery -->

- [x] 输入：`candidateId: 'legacy' | 'slotA' | 'slotB'`。
- [x] 输出：`{ resolved, restart_required, selected_candidate, incident_id }`。
- [x] 错误：非法 id → `AppError.validation('候选 id 必须是 legacy、slotA 或 slotB')`；解决失败 → `AppError.file_system('解决启动恢复事件失败: …')`。
- [x] 事件：无。
- [x] DB 读写：写恢复事件 manifest 与 pending 选择，不打开业务库。
- [x] 取消/并发：同步。
- [x] 时间/ID：`resolved_at` 用当前 UTC ISO。

## 命令 `restart_app`

<!-- BEGIN GENERATED:cmd:restart_app -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2610` · sync
- 前端：app（3 处，例 `src/features/data-recovery/dataRecoveryApi.ts:177`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：null · 注入：app-handle
<!-- END GENERATED:cmd:restart_app -->

- [x] 输入：无参数。
- [x] 输出：`null`。
- [x] 错误：shell `plugin:process|restart` 失败向上抛。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：异步等待 shell 回复。
- [x] 时间/ID：无。

## 命令 `retry_startup_recovery_preflight`

<!-- BEGIN GENERATED:cmd:retry_startup_recovery_preflight -->
- Rust：`src-tauri/crates/dstu-storage/src/data_space.rs:2190` · sync
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：StartupRecoveryStatus · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:retry_startup_recovery_preflight -->

- [x] 输入：无参数。
- [x] 输出：`StartupRecoveryStatus`。
- [x] 错误：预检失败写入 incident 并返回 `recovery_required=true`（与 Rust 同）。
- [x] 事件：无。
- [x] DB 读写：只读恢复目录。
- [x] 取消/并发：同步。
- [x] 时间/ID：incident `created_at` 用当前 UTC。

## 命令 `seed_test_database`

<!-- BEGIN GENERATED:cmd:seed_test_database -->
- Rust：`src-tauri/src/commands.rs:7330` · async
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：config?: Value | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:seed_test_database -->

- [x] 输入：`config?: Value | null`；每个 `create_*` 字段取 `as_bool()`，缺失键、非布尔值、非对象一律回退 `true`（commands.rs:7344-7372；Host 实现 test-database.ts:62-80）。
- [x] 输出：`{ success: true, mistakes_created, messages_created, errors, test_db_path }`（commands.rs:7384-7393）；Rust 播种器已废弃为显式空操作，固定返回 `0`/`0`/`[]`（`database_seed.rs:32-39`）。
- [x] 错误：测试库不存在且 `Database::new` 失败 → `AppError.file_system('初始化测试数据库失败: …')`；打开测试库失败 → `AppError.file_system('打开测试数据库失败: …')`；播种器错误按 Rust `?` 向上抛（commands.rs:7326-7342）。Host 对应错误形状见 index.ts:256-263。
- [x] 事件：无。
- [x] DB 读写：只打开/创建 `<active>/test_mistakes.db` 并调用播种器，不触碰生产库；Host 在 `finally` 关闭独立句柄（index.ts:256-276）。
- [x] 取消/并发：Rust 异步命令；Host 同步打开测试库、播种后关闭，不占用活动连接。
- [x] 时间/ID：无。
- [x] 日志：播种完成记 `info!("[测试模式] 测试数据库播种完成: 错题{}条, 消息{}条, 数据库: {:?}")`，每个错误记 `error!`（commands.rs:7374-7382）；Host 用同一文案（index.ts:267-271）。

## 命令 `set_test_run_id`

<!-- BEGIN GENERATED:cmd:set_test_run_id -->
- Rust：`src-tauri/src/commands.rs:7424` · async
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：testRunId: string
  - 结果：Value · 错误：AppError
<!-- END GENERATED:cmd:set_test_run_id -->

- [x] 输入：`testRunId: string`。
- [x] 输出：`{ success: true, test_run_id }`（commands.rs:7425）。
- [x] 错误：无（Host 仅记录日志）。
- [x] 事件：无。
- [x] DB 读写：无数据库读写。
- [x] 取消/并发：同步。
- [x] 时间/ID：`test_run_id` 原样回显，不做规范化。

## 命令 `staged_upload_abort`

<!-- BEGIN GENERATED:cmd:staged_upload_abort -->
- Rust：`src-tauri/crates/dstu-storage/src/staged_upload.rs:510` · async
- 前端：app（1 处，例 `src/utils/stagedUpload.ts:70`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：uploadId: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:staged_upload_abort -->

- [x] 输入：`uploadId: string`。
- [x] 输出：`null`。
- [x] 错误：无（幂等）。
- [x] 事件：无。
- [x] DB 读写：无数据库；删除 `.part`。
- [x] 取消/并发：单线程 Map。
- [x] 时间/ID：无。

## 命令 `staged_upload_append`

<!-- BEGIN GENERATED:cmd:staged_upload_append -->
- Rust：`src-tauri/crates/dstu-storage/src/staged_upload.rs:461` · async
- 前端：app（2 处，例 `src/utils/stagedUpload.ts:97`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：integer(u64) · 错误：string · 注入：request
<!-- END GENERATED:cmd:staged_upload_append -->

- [x] 输入：raw body（Uint8Array / JSON / byte array）+ headers `x-upload-id`/`x-upload-offset`。
- [x] 输出：累计字节数。
- [x] 错误：`Missing x-upload-id header` / `Unexpected chunk offset …` / `Chunk too large …`（字符串）。
- [x] 事件：无。
- [x] DB 读写：无数据库；追加写 `.part`。
- [x] 取消/并发：偏移必须等于已收字节，超出声明大小即 abort。
- [x] 时间/ID：每次更新 lastTouch。

## 命令 `staged_upload_begin`

<!-- BEGIN GENERATED:cmd:staged_upload_begin -->
- Rust：`src-tauri/crates/dstu-storage/src/staged_upload.rs:446` · async
- 前端：app（1 处，例 `src/utils/stagedUpload.ts:87`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：name: string, totalSize: integer(u64)
  - 结果：string · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:staged_upload_begin -->

- [x] 输入：`name: string, totalSize: number`。
- [x] 输出：`uploadId`（32 位 hex）。
- [x] 错误：超限/创建失败 → 字符串 `File too large: …` / `Failed to create staging directory: …`。
- [x] 事件：无。
- [x] DB 读写：无数据库；写 `appCache/staged_uploads/<id>.part`。
- [x] 取消/并发：单线程 Map；首次扫描孤儿。
- [x] 时间/ID：`randomUUID()` 去横线。

## 命令 `staged_upload_from_path`

<!-- BEGIN GENERATED:cmd:staged_upload_from_path -->
- Rust：`src-tauri/crates/dstu-storage/src/staged_upload.rs:490` · async
- 前端：app（1 处，例 `src/utils/stagedUpload.ts:123`）
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：path: string
  - 结果：StagedFromPath · 错误：string · 注入：window
<!-- END GENERATED:cmd:staged_upload_from_path -->

- [x] 输入：`path: string`。
- [x] 输出：`{ uploadId, size }`。
- [x] 错误：隐藏路径/虚拟路径/超限 → 字符串。
- [x] 事件：无。
- [x] DB 读写：无数据库；流式复制到暂存区。
- [x] 取消/并发：同步流读取，超过上限即删除临时文件。
- [x] 时间/ID：`uploadId` 同 begin。

## 命令 `switch_to_production_database`

<!-- BEGIN GENERATED:cmd:switch_to_production_database -->
- Rust：`src-tauri/src/commands.rs:7276` · async
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:switch_to_production_database -->

- [x] 输入：无参数（commands.rs:7276）。
- [x] 输出：`{ success: true, production_db_path, message: '已切换回生产数据库', active_database: 'production' }`（commands.rs:7291-7300）。
- [x] 错误：`Database::switch_to_path` 失败 → `AppError.internal('切换数据库连接失败: …')`；`DatabaseManager::switch_database` 失败 → `AppError.internal('刷新数据库连接池失败: …')`（commands.rs:7286-7289）。Host 对应实现见 index.ts:247-254。
- [x] 事件：无。
- [x] DB 读写：把 `mistakes` 主连接重定向到 `<active>/mistakes.db`，新连接参数为 WAL / synchronous=NORMAL / foreign_keys=ON / busy_timeout=3000（database/mod.rs:869-899；Host 实现 database.ts:577-594、service.ts:140-161）。
- [x] 取消/并发：Rust 异步命令后取 `active_database` 写锁；Host 同步设置状态；维护屏障期间抛 `MAINTENANCE`（service.ts:143-146），异步事务持写者槽时抛 `BUSY`（database.ts:582）。
- [x] 时间/ID：无。
- [x] 日志：切换前记 `info!("[测试模式] 切换回生产数据库: {:?}")`（commands.rs:7283），Host 用同一文案（index.ts:250）。

## 命令 `switch_to_test_database`

<!-- BEGIN GENERATED:cmd:switch_to_test_database -->
- Rust：`src-tauri/src/commands.rs:7169` · async
- 前端：none
- 契约：`contracts/ipc/F3-storage.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:switch_to_test_database -->

- [x] 输入：无参数（commands.rs:7169）。
- [x] 输出：`{ success: true, test_db_path, message: '已切换到测试数据库', active_database: 'test' }`（commands.rs:7201-7207）。
- [x] 错误：创建目录失败 → `AppError.file_system('创建测试数据库目录失败: …')`；初始化测试库失败 → `AppError.file_system('初始化测试数据库失败: …')`；切换连接 → `AppError.internal('切换数据库连接失败: …')`；刷新连接池 → `AppError.internal('刷新数据库连接池失败: …')`（commands.rs:7176-7199）。Host 对应实现见 index.ts:207-222。
- [x] 事件：无。
- [x] DB 读写：确保 `<active>/test_mistakes.db` 存在（不存在则 `Database::new` 创建），把 `mistakes` 主连接切换到该文件并把连接池指向同一文件，最后置 `active_database = Test`（commands.rs:7176-7205；Host 实现 index.ts:207-222、service.ts:140-168）。
- [x] 取消/并发：Rust 异步命令后取 `active_database` 写锁；Host 同步设置状态；维护屏障期间抛 `MAINTENANCE`，异步事务持写者槽时抛 `BUSY`（service.ts:143-146、database.ts:582）。
- [x] 时间/ID：无；路径由活动数据目录 + `test_mistakes.db` 决定（test-database.ts:18-20）。
- [x] 日志：新建测试库记 `info!("[测试模式] 已创建测试数据库: {:?}")`，已存在记 `info!("[测试模式] 使用现有测试数据库: {:?}")`（commands.rs:7188-7194），Host 用同一文案（index.ts:215-219）。
