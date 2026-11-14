# F3 存储服务（`ctx.storage`）

接口：[`api.ts`](api.ts)（冻结边界，只能增补）。实现：本目录其他文件。业务插件只 import `api.ts`，
**不得**直接 import `better-sqlite3`（边界门禁会拦）。

## 1. 获取数据库

```ts
import { defineQuery, type SqlExecutor } from '../../platform/storage/api.ts';

export default definePlugin({
  meta: { id: 'dstu.qbank', lane: 'L14-qbank' },
  inject: ['storage'],
  apply(ctx) {
    const vfs = ctx.storage.database('vfs'); // 首次调用时打开并应用 PRAGMA
  },
});
```

| 名称 | 文件 | PRAGMA（每条连接，按 Rust 顺序） | Rust |
|---|---|---|---|
| `mistakes` | `<active>/mistakes.db` | foreign_keys=ON, busy_timeout=3000, journal_mode=WAL, synchronous=FULL | `database/mod.rs:1208-1209`（主连接）、`database/manager.rs:85-90`（池：WAL/NORMAL） |
| `vfs` | `<active>/databases/vfs.db` | foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000 | `dstu-vfs/src/vfs/database.rs:131-140` |
| `chat_v2` | `<active>/chat_v2.db` | foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL, busy_timeout=10000, auto_vacuum=INCREMENTAL | `dstu-agent/src/chat_v2/database.rs:113-125` |
| `llm_usage` | `<active>/llm_usage.db` | foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL, busy_timeout=3000 | `dstu-storage/src/llm_usage/database.rs:152-160` |
| `audit` | `<active>/databases/audit.db` | 无显式 PRAGMA（rusqlite 默认 busy_timeout=5000；synchronous=FULL） | `dstu-storage/src/audit/mod.rs:169-171` |
| `browser` | `<active>/browser.db` | foreign_keys=ON, journal_mode=WAL, synchronous=NORMAL, busy_timeout=3000；首次打开跑 `migrations/browser` | `dstu-browser/src/browser/database.rs:191-211` |
| `sync_state` | `<dataLocalDir>/deep-student/sync/sync_state.db` | busy_timeout=5000（synchronous=FULL） | `dstu-sync/src/data_governance/sync/state.rs:23-36` |
| `workspace`（openFile 配置） | `<active>/workspaces/ws_<id>.db` | foreign_keys=ON, journal_mode=WAL, busy_timeout=5000（synchronous=FULL） | `dstu-agent/src/chat_v2/workspace/database.rs:286` |

- `<active>` 是数据空间活动槽 `<AppInfo.dataDir>/slots/slot{A,B}`，解析规则同 `data_space.rs`
  （`state.json` → `state.json.tmp` → 目录推断，启动时应用 `pending` 切换）。
- `dataLocalDir` = Rust `dirs::data_local_dir()`：macOS `~/Library/Application Support`，
  Linux `$XDG_DATA_HOME` 或 `~/.local/share`，Windows `FOLDERID_LocalAppData`。插件路径取
  `ctx.paths.os.dataLocal`（外壳经 `DS_SHELL_OS_DIRS` 传入的 Known Folder 优先）；未传
  `dataLocalDir` 的独立实例（worker、脚本）用同一个 `resolveOsDirs`，不另算。
- SQLite 编译选项差异（rusqlite bundled vs better-sqlite3）：两边 `DEFAULT_FOREIGN_KEYS=1`；
  better-sqlite3 额外有 `SQLITE_DQS=0`（**双引号字符串字面量是错误**）、
  `DEFAULT_WAL_SYNCHRONOUS=1`（因此 Rust 未显式设置 synchronous 的库这里显式设为 FULL 以保持一致）、
  `LIKE_DOESNT_MATCH_BLOBS`、`DEFAULT_CACHE_SIZE=-16000`。移植 SQL 时如遇
  `no such column: "x" - should this be a string literal`，改成单引号——那是 Rust 版里的字符串字面量。
- 连接关闭了 better-sqlite3 默认的 `SQLITE_DBCONFIG_DEFENSIVE`（`unsafeMode(true)`），与 rusqlite 一致
  （允许 `writable_schema`、FTS 影子表写入、迭代中写入）。
- **启动期（pre-storage）独立开库**：purge reset 发生在 `ctx.storage` 发布之前，provider 只
  inject `paths`，因此不能走 `ctx.storage.openFile`。用本文件公共导出的
  `openStartupDatabase(path, { label?, profile?, nativeSqliteBusy? })`（默认 `PROFILES.sync_state`）独立打开
  `<dataLocalDir>/deep-student/sync/sync_state.db`，返回 `StartupDatabase` =
  `SqlExecutor` + `begin()`（默认 deferred）/`commit()`/`rollback()`/`close()`；不打开业务库、
  不跑迁移、不复制 schema。W13 的 L20 provider 用它替代直接 import
  `host/platform/storage/connection.ts` / `profiles.ts`。
  - WP-164：传入 F7 `ctx.nativeSqliteBusy` 后可调用
    `db.setBusyHandler(handler: ((priorInvocations: number) => boolean) | null): void`。
    使用本句柄同一连接、同线程、同一次 SQLite step；true 让 SQLite 再尝试，false/异常结束等待。
    异常按 rusqlite 0.40.1 busy.rs:60 吞为 false，语句保留 SQLite 的结果（通常 SQLITE_BUSY，
    checkpoint 则为 busy=1 行）；无 JS 重试/延后重抛。null 禁用等待，不恢复默认5000ms；
    后续 `PRAGMA busy_timeout=N` 替换 handler。替换/null/close 释放引用；timeout 覆盖的旧引用
    由下一次 setBusyHandler 或 close 释放。无 provider 时 SQL 照常可用，注册 handler 抛
    `StorageError('INVALID_PARAM')`。F7 当前仅有 Linux-x64 预编译，其他平台尚未交付。
    pre-storage 消费方依赖 `nativeSqliteBusy` 即可，不需 inject 尚未发布的 `storage`。
- 动态库用 `ctx.storage.openFile(path, { profile: 'workspace' })`，用完 `ctx.storage.close(h)`。
  - 默认与既有行为一致：递归创建父目录，允许创建缺失的库文件；`mustExist: true` 或只读
    profile 时要求文件已存在。
  - `createParentDirs: false` 对应 Rust `Connection::open` 的文件语义：**不 mkdir**；
    父目录存在时允许创建缺失的库文件，父目录缺失时打开失败。失败统一抛
    `StorageError { code: 'SQLITE', sqliteCode: 'SQLITE_CANTOPEN', phase: 'execute' }`
    （驱动对缺目录抛 `TypeError`，F3 在打开边界转换成 SQLite 的错误形状）。
  - L03 的 `readBudgetSettingFromFile` 精确用法（`host/plugins/chat-pipeline/repository/budget.ts`）：
    ```ts
    let conn: DatabaseHandle;
    try {
      conn = storage.openFile(path, {
        profile: { busyTimeoutMs: 2000 }, // budget.rs 的独立短连接
        createParentDirs: false,          // Connection::open 不创建父目录
      });
    } catch (error) {
      warn(...);                          // 保留原 warn 日志
      return null;
    }
    try { return readSettingWithConn(conn, key); }
    finally { storage.close(conn); }
    ```
    不要再用 `statSync(dirname(path))` 预检父目录，也不要递归 `mkdir`。
- Rust 字段类型是 `DateTime<Utc>` 的 IPC 输出用 chrono serde 表示：UTC 写 `Z`、小数秒
  0/3/6/9 位（`to_rfc3339_opts(SecondsFormat::AutoSi, true)`），例如
  `llm_usage_recent.createdAt`、`llm_usage_summary.startDate/endDate`。这只影响对外 JSON；
  库内时间文本（可能是 `+08:00` 或历史 `Z`）原样保留。`to_rfc3339()` 的 `+00:00` 表示用于写库和查询参数。

## 2. 仓储约定（`host/plugins/<domain>/repository/`）

SQL 只出现在插件的 `repository/` 目录。仓储函数签名对应 Rust 的 `xxx_with_conn(conn: &Connection, …)`：

```ts
// host/plugins/vfs-repos/repository/folders.ts
const getFolder = defineQuery<{ id: string }, FolderRow>(
  'SELECT id, parent_id, title FROM folders WHERE id = :id AND deleted_at IS NULL',
  { name: 'vfs.folders.get' },
);
export function getFolderWithConn(db: SqlExecutor, id: string): FolderRow | undefined {
  return db.get(getFolder, { id });
}
```

- `get` = `query_row(..).optional()`；`one` 无行抛 `StorageError('NO_ROWS', 'Query returned no rows')`；
  `pluck` = `query_row(.., |r| r.get(0))`；`run` = `execute`；`exec` = `execute_batch`。
- 参数：数组（`?`、`?1`）或对象（`:name`/`@name`/`$name`）。`boolean` 绑定为 0/1（同 rusqlite），
  `undefined` 抛 `INVALID_PARAM`。
- 整数值的 `number`（含 `boolean`）按 INTEGER 绑定（同 rusqlite 的 i64 和移动端 sqlite-wasm），小数、
  `NaN`/`Infinity` 和超出 i64 的值按 REAL。所以 TEXT 列写出 `"5"` 而不是 `"5.0"`，`json_object`/`json_set`
  写出 `5`；参数参与除法时是整数除法。对应 Rust 的 f64 又需要 REAL 语义时，在 SQL 里写 `CAST(? AS REAL)`。
- 整数默认 `number`。会超过 2^53 的列在 `defineQuery` 里设 `options: { safeIntegers: true }`，
  按 Rust 的序列化（number 还是 string）在业务层转换。
- 查询按 SQL 文本缓存预编译语句（= `prepare_cached`）。
- Rust 迁移 SQL 本身不复制：迁移器直接读取 `src-tauri/migrations/**`（同一批文件，同一 checksum）。

### 2.1 批处理（`batch_operations.rs`）

`ctx.storage` 同时提供 Rust `Database::with_batch_operations` 的两个方法，均在 `mistakes` 库上以
单个 deferred 事务执行：

- `batchArchiveOldMistakes(daysOld)`：把 `created_at < now - daysOld` 且 `status != 'archived'`
  的错题改为 `archived`，`updated_at`/`last_accessed_at` 写同一时刻，返回影响行数。
- `batchCleanupOrphanedMessages()`：删除 `chat_messages` 中 `mistake_id` 不在 `mistakes` 的行，
  返回删除行数（兼容早于外键约束的历史库）。

## 3. 事务

| Rust | TS |
|---|---|
| `conn.transaction()` | `db.transaction(tx => …)`（deferred） |
| `transaction_with_behavior(Immediate)` / `BEGIN IMMEDIATE` | `db.transaction(fn, { behavior: 'immediate' })` |
| `tx.savepoint()` | `tx.savepoint(sp => …)` |
| 跨 `.await` 持有事务 | `await db.withTransaction(async tx => …, { signal })` |
| 事务提交后 `app.emit(..)` | `tx.afterCommit(() => ctx.backendEvents.emit(..))` |

- **同步事务**：`fn` 必须同步；抛错回滚重抛。最常用，期间不让出事件循环，天然无交错。
- **`db.write(fn)`**：异步代码里的写库首选——在写者槽上排队，然后执行同步 `immediate` 事务。
- **异步事务**（`begin` / `withTransaction`）：绑定一条独占连接，跨 `await` 原子。同一库同时只有一个；
  持有期间主连接上的**写**立即抛 `BUSY`（不阻塞事件循环——Node 单线程里阻塞等待会死锁），
  读照常（WAL 读到已提交数据）。`signal` 中止或回调抛错即回滚；已结束句柄上执行语句抛 `TX_CLOSED`。
  不要在异步事务里等待网络/LLM 等长操作。
- **afterCommit**：只在 COMMIT 成功后、按注册顺序执行；回滚（含保存点回滚）丢弃。回调抛错时数据已提交，
  调用方收到 `AfterCommitError`（`committed: true`）。
- **batch(statements)**：一个 `immediate` 事务里顺序执行，失败整体回滚。
- **跨库**：不提供分布式事务。跨库操作（如 vfs + chat_v2）保持 Rust 的专门协调语义（journal/outbox），
  在业务 lane 中显式实现。

### 3.1 SQLite 写锁观测的当前限制（WP-008 / L20b S06）

`busyTimeoutMs` 是原生 timeout，不能通知调用方“当前 SQL 已进入 busy handler”。
已安装 better-sqlite3 13.0.3（SQLite 3.53.4）无公开 handler/interrupt；`openStartupDatabase`
与 `DatabaseHandle` 均没有这种通知接口。进程内 WriterSlot 的 FIFO 也不代表跨连接 SQLite 写锁。
同步 SQL 运行期间，同线程 AbortSignal/定时器不能抢占原生等待。
需要精确握手的 L20b Rust `state.rs:597-664` 仍 pending；最小 native 签名、真实双连接证据、
回调取消/释放协议见 `L20B-OBSERVABILITY.md`。不得用 verbose、Statement.busy、固定延时或
捕获 SQLITE_BUSY 后的 JS 回调冒充“同一次 SQL 调用正在真实 handler 内等待”。

## 4. 维护屏障

`const lease = await ctx.storage.enterMaintenance(['vfs'])`：拒绝新借用（`MAINTENANCE`）、等待在途异步事务、
`wal_checkpoint(TRUNCATE)`、关闭连接；`lease.release()` 后恢复。备份/恢复/数据空间切换（L21/L20）使用。

### 4.1 线程/子进程参与者

主线程 `handles`/`adHoc` 之外的连接（worker 线程自建的 `SqliteDatabase`、子进程）必须注册：

```ts
const off = ctx.storage.registerMaintenanceParticipant('vfs-worker', {
  databases: ['vfs'],                 // 省略 = 所有库
  enterMaintenance: () => pool.pause(), // 拒绝新任务 → 等待在途 → close/terminate 连接
  exitMaintenance: () => pool.resume(), // 必须同步返回；恢复后按需惰性重开
});
```

- F3 先拒绝该库的新借用，再调用 `enterMaintenance`（停新任务、drain、关闭线程内连接），最后
  才 drain/checkpoint/关闭主线程连接；`exitMaintenance` 在所有数据库 lease
  释放后按注册逆序调用。同一参与者被多个重叠 lease 覆盖时按引用计数只 enter 一次、最后一个
  lease 释放时 exit 一次。参与者 enter 抛错时 F3 回滚已进入的参与者并恢复存储可用。
- 维护屏障期间注册抛 `MAINTENANCE`；重名抛 `MAINTENANCE_PARTICIPANT_DUPLICATE`。
  注销函数可重复调用；维护中注销不会跳过已进入实例的 exit。
- 参与者只拿自己线程内的连接，不把 raw better-sqlite3 暴露给业务层，也不接受任意 SQL 文本。
- L11 的 `vfsWorker`（persistent worker + short-lived search worker）已在其候选分支实现
  `pauseAndDrain(timeoutMs?)` / `resume()`，并在 `index.ts:160-174` **候选注册**：
  ```ts
  ctx.storage.registerMaintenanceParticipant('vfs-worker', {
    databases: ['vfs'],
    enterMaintenance: async () => { try { await worker.pauseAndDrain(); } catch (e) { worker.resume(); throw e; } },
    exitMaintenance: () => worker.resume(),
  });
  ```
  `pauseAndDrain` 停新请求、等待已接受请求与 short-lived search、terminate worker 连接；
  `resume` 放行排队任务并按需重建 worker。L11 不得为异线程另开绕过维护的裸连接。
  **L11 注册已在 main `host/plugins/vfs-repos/index.ts:175-193`，通过能力探测调用。
  F3 注册方法尚待本分支集成，因此不能据消费者代码存在就签收真实维护组合；
  集成后用真实 `enterMaintenance`/release 核验。不是 L11 未写注册。**
- `createDatabaseWorkerPool` 已提供 `pause(): Promise<void>`（暂停新任务、等待在途任务、terminate
  全部 worker）和 `resume(): void`（放行排队任务、按需重建）。L13b 直接把它包成参与者即可。

## 5. 迁移

`ctx.storage.migrations.runAll()` = `MigrationCoordinator::run_all()`。迁移器与 refinery 0.9 兼容：
同一张 `refinery_schema_history`、同样的文件名解析、SipHash-1-3 checksum、每个迁移的 SQL 与历史记录
分两个事务提交（refinery 非 grouped 模式）。细节和测试映射见 [`TESTMAP.md`](TESTMAP.md)。

单库迁移入口：`ctx.storage.migrations.migrateSingle(name)` = `MigrationCoordinator::migrate_single(name)`
（不定序检查依赖、不做全库快照/恢复；单库内部 repair/checksum 修复/verifier/fingerprint 全部保留，
失败 reject）。需要 Rust `with_audit_db(None)` 的调用方用
`createStorageService({ baseDir, dataLocalDir, auditDbPath: null })`；省略 `auditDbPath` 时仍是
`<活动槽>/databases/audit.db`，与 `runAll` 相同。

启动迁移快照（D2）：本进程第一次 `runAll()` 即启动迁移，结果只记录一次，后续调用不覆盖。
- `ctx.storage.startupMigrationReport()`：成功返回的 `MigrationReport`；未运行、恢复模式跳过或全局失败时 `null`。
- `ctx.storage.startupMigrationFailure()`：`run_all` 返回 Err 时的 `{ error, kind, recovered, maintenanceForced }`。
  `error` = Rust `DataGovernanceError` 的 `to_string()`（`Migration error: …`）；`maintenanceForced` 按
  `should_force_maintenance_mode_on_init_failure`（schema 指纹漂移不强制，`RecoveredFromBackup` 恒强制）。
  同时按 `lib.rs:1252-1279` 重建 `componentHealth`：强制时 vfs/mistakes/chat_v2/llm_usage blocked，否则 mistakes degraded。
- storage 插件 apply 对这类全局失败只记录、不再抛出，Host 继续装配；失败载荷、`.last_migration_error` 与
  全组件维护屏障由数据治理（L21 `backup.restore-activation` finalizer）负责。迁移前的数据空间准备失败仍按原样中止。

## 6. 错误

`StorageError.code`：`SQLITE`（`sqliteCode` 为扩展码名，`message` = `sqlite3_errmsg`，与 rusqlite Display
一致）、`BUSY`、`NO_ROWS`、`TX_CLOSED`、`ABORTED`、`ASYNC_IN_SYNC_TX`、`MAINTENANCE`、
`MAINTENANCE_DRAIN_TIMEOUT`、`INVALID_PARAM`、`UNKNOWN_DATABASE`，以及启动 finalizer 的
`FINALIZER_DUPLICATE` / `FINALIZER_INVALID` / `FINALIZER_UNKNOWN_DEPENDENCY` / `FINALIZER_CYCLE` /
`FINALIZER_LATE_REGISTRATION`，以及维护参与者的 `MAINTENANCE_PARTICIPANT_DUPLICATE`。业务 lane
负责把它们映射成 Rust 命令的 `Err(..)` 文案。

`StorageError.phase` 是 SQL 物理阶段，F3 在分层处直接打标，**不解析错误文案**：

| `phase` | 产生位置 | 典型错误 |
|---|---|---|
| `prepare` | `Connection.statement()` / `isReadonly()` | 表不存在、语法错误 |
| `bind` | `bindArgs()`、`safeIntegers`/`pluck` 配置 | 参数个数/`undefined`/非法类型 |
| `execute` | `stmt.get/all/iterate/run`、`exec`、`pragma`、`BEGIN/COMMIT/ROLLBACK`、`backup` | UNIQUE/CHECK 约束、busy、I/O |

L20b 的 `SyncStateStore` 应据 `phase` 映射 Rust 的 `读取…失败`（prepare）与 `查询…失败`（bind/首次
execute）；拿到首行之后的 `execute` 才能映射成 `遍历…失败`。仅用 `all()` 时只能诚实地归到
`execute`，不要按文案猜。`phase` 为 `undefined` 表示不是 SQL 路径（如 `BUSY`/`NO_ROWS`）。

## 7. 测试替身

`api.ts` 的数据库类型不暴露 better-sqlite3；它同时重导出真实 worker/文件/删除编排入口。
测试中用 `createStorageService({ baseDir: tmp, dataLocalDir: tmp })`
（`host/platform/storage/service.ts`，真实 SQLite，临时目录）即可，不需要 mock。`sync_state` 默认落在
真实 `dirs::data_local_dir()`，测试必须传 `dataLocalDir`。

## 8. 宿主接线

- Cordis：`new StorageCordisService(ctx, { migrationsDir })` 注册 `ctx.storage`（依赖 `ctx.app.dataDir`），
  卸载时先依次等待 `beforeShutdown(drain)` 登记的收尾（后登记先执行，失败只记 warn），再 `impl.shutdown()`
  关闭全部连接。此后同一服务对象（含卸载前取走的引用）的 `database()`、`openFile()`、`switchToPath()`、
  `migrations.*` 一律抛 `StorageError('TX_CLOSED', 'Storage service is disposed')`，不会再静默开出没人关闭的新连接；
  重装插件得到新的服务对象，照常开库。Cordis 并发释放同一插件的顶层 `ctx.effect`，所以要在关库前写库的收尾
  不能靠 effect 的登记顺序，必须走 `beforeShutdown`。测试：`tests/service-dispose.test.ts`。
- `createStorageService(...)` 返回的裸实例：`dispose()` 只关闭连接，实例仍可再开库（测试用来模拟进程重开）；
  `shutdown()` 是终态。
- 迁移 SQL 目录默认是仓库 `src-tauri/migrations`；打包时外壳（F2）需把该目录作为资源随包发布并传入
  `migrationsDir`（文件必须逐字节保留：checksum 依赖原文）。F2 通过
  `DS_MIGRATIONS_DIR` 传给 Host，F3 在 profile 未配置 `config.migrationsDir` 时读取该变量；
  无效目录直接失败，不回退仓库路径。
- 启动顺序（Rust `lib.rs` setup）：数据空间恢复预检 / `initialize_on_start`（pending 切换）/ 启动清理 →
  `ctx.storage.migrations.runAll()` → 业务插件打开各库。main 已含 F2 startupGate 与 F1
  finishStartup；F3 本分支 get_startup_recovery_status 等待真实 gate 120s，再读取状态。
  purge 的同步基线重置（W13）契约见下，L20 的真实 pre-storage provider 仍待合入。
- **W13 `storageStartupSync`**：purge 发生在 `ctx.storage` 发布之前，所以 L20 必须在
  `dstu.platform.storage` 之前安装一个**不 inject `storage`** 的插件（建议
  `dstu.sync-startup`，`inject: ['paths']`）并 `provide('storageStartupSync', { resetDefaultAfterLocalPurge })`。
  实现用 `syncStateDatabasePath(ctx.paths.os.dataLocal)`（本文件公共导出）独立打开
  `<dataLocalDir>/deep-student/sync/sync_state.db`，按 Rust `state.rs:528-552` 在同一事务清空
  `consume_cursor` / `legacy_processed_key` / `tombstone_watermark` / `instance_binding` /
  `device_history`，保留 `upload_seq`。F3 在删除数据后、清除 `.purge_on_next_start` 前 await 它；
  失败计入 `startup_cleanup` 并保留标记。不能把该服务挂在 `sync-support`（`inject: ['storage']`
  会形成环），也不能推迟到迁移后/D2 finalizer。安装顺序由 loader 的 inject 拓扑与就绪顺序
  决定，不等于目录扫描顺序；F1 正在核实最小显式先后保证。
  详见 `STARTUP-WIRING.md` §3。
- better-sqlite3 13.0.3 的预编译产物是 N-API，在 Node 26 与 Electron 45（ABI 150）中均可直接加载，
  无需 `@electron/rebuild`。
- `browser` 首次打开迁移失败抛 `BrowserMigrationError`（message = Rust `Failed to migrate browser.db: …`）。

## 9. 启动 finalizer（D2）

Rust 启动顺序（`src-tauri/src/lib.rs` setup）：

1. `StartupReadyGuard::new()`（`:838`，所有退出路径最后 mark）；
2. `should_purge_on_start` → `purge_all_local_data`（含 L20b `reset_default_after_local_purge`）→ 清
   `.purge_on_next_start`；失败保留标记且不打开业务库；
3. 数据治理初始化 / 迁移（`:1080` 起）；
4. `finalize_restore_activation`（`:1169`，恢复槽激活事务提交后的收尾）；
5. 业务存储初始化完成后的恢复清扫（`:3667` 资产删除恢复等）。

Host 对应顺序：

```text
storage.apply
  ├─ DataSpaceStartup.start()：preflight / pending 切换 / purge
  └─ migrations.runAll()
其余插件 apply（L21 / F2 / L20b 在这里注册 finalizer）
组合根 installAll 返回后
  ├─ recovery_required ? 跳过 : await ctx.storage.runStartupFinalizers()
  └─ startupGate.markStartupReady()
```

F1 main 组合根（`host/kernel/connection.ts:111-127`，`finishStartup`）符合
上述顺序：正常启动先执行全部 finalizer，再 mark F2 gate；任一 finalizer 抛错会让 boot 走
`HostFatal`、exit 1，不发送 `HostReady`，也不 mark gate。恢复模式跳过业务 finalizer，但仍 mark gate。

候选真实组合已验证：F1 证据分支 `a612c4496`（F1 `5d373dbf2` + F3 `9900d8dda`，测试
`7fdd36afe`）用真实 `StorageCordisService` + `StartupFinalizerRegistry` + F2 gate 经 `serveHost`，
job `20261104075748-2c9c0f` 为 8 passed / exit 0。**组合根已在 main，F3 registry 尚待集成**；
本 lane 不复制 F1 组合根，集成后仍需按该版本重跑真实组合门禁。

公开 API（`StorageService`）：

```ts
ctx.storage.registerFinalizer(name, fn, { after?: string[] });
await ctx.storage.runStartupFinalizers(); // 组合根调用一次
ctx.storage.finalizerNames();            // 诊断/测试
```

语义：

- 注册顺序 = 无依赖 finalizer 的执行顺序；`after` 里的名称先执行。
- `runStartupFinalizers()` 按拓扑序逐个 `await`；某个失败立即停止并抛
  `StartupFinalizerError`，其中 `finalizer` 是失败名称、`cause` 是原始错误、`completed` 是已成功列表。
- 执行失败后 registry 保持 failed 状态与 `completed` 列表；**没有自动重试**。调用方需要显式再次
  `runStartupFinalizers()` 才会跳过已成功项、重试失败项及其后继。依赖解析失败（未知依赖/环）同样
  使该次 run 失败并保留已完成列表，不会自动执行任何钩子。
- 失败后的注册尝试不会执行 callback：late、duplicate、invalid 一律抛结构化错误
  （`FINALIZER_LATE_REGISTRATION` / `FINALIZER_DUPLICATE` / `FINALIZER_INVALID`），注册本身
  从不调用 callback。“注册失败”不是“执行失败后立即跑 callback”的授权。
- 未知依赖抛 `FINALIZER_UNKNOWN_DEPENDENCY`，依赖环抛 `FINALIZER_CYCLE`（附成环路径），第一次
  `run` 开始后注册抛 `FINALIZER_LATE_REGISTRATION`。
- **F3 不会自动执行 finalizer**：消费方在 `apply` 里注册，组合根在所有插件安装完成后调用。恢复模式
  是否执行由组合根决定（Rust 在恢复模式提前返回，不会进入业务初始化）；至少必须保证
  `startupGate` 在恢复模式下也会 mark，否则前端 `get_startup_recovery_status` 会等待超时。
- **F1 main 已有组合根 / F3 registry 待集成**：F1 证据分支 `a612c4496` 的 8 passed 已使用真实
  `StorageCordisService` + `StartupFinalizerRegistry` + F2 gate，不再是合成 storage fixture；
  F1 finishStartup 已合入 main；F3 registry 合入后仍需以该版本重跑 `serveHost`
  真实组合门禁，才能关闭 D2 整链。
- **注册失败政策边界待裁定**：F3 只定义注册错误码与“不执行 callback”；注册失败时是让当前插件
  inactive（F1 当前 profile 安装的隔离语义）、还是让 boot fatal、还是允许重试，属于 F1/C1 的组合根
  政策；真实证据已交架构师，未裁定前不擅自改成全 fatal。本文不把任一选择写成已决定。
- 推荐挂接：L21 `finalizeRestoreActivation` 用 `after: []`（迁移已完成）；L20b 的 panic-safe
  baseline 重试用 `after: []`；F2 gate 用 `after: [全部业务 finalizer]`，或直接放在组合根最后。

## 9.1 图片质量服务（FileManager / L12）

Rust `FileManager::adjust_image_quality_{bytes,base64}`（`file_manager.rs:74-167`）是 L12
PDF 预览的活生产链（`dstu-vfs/pdf_processing_service.rs:483` 调 `adjust_image_quality_bytes("low")`）。
F3 已提供正式服务入口，消费者不得导入私有 `file-manager.ts`，也不得在 L12 重造策略。

```ts
// ctx.imageQuality 由 F3 plugin provide（api.ts: ImageQualityService）
await ctx.imageQuality.adjustImageQualityBytes(bytes, 'low', ctx.nativeImage);
const b64 = await ctx.imageQuality.adjustImageQualityBase64(base64, 'auto', ctx.nativeImage);
```

精确签名（`host/platform/storage/api.ts`）：

```ts
interface ImageQualityService {
  adjustImageQualityBytes(
    bytes: Uint8Array,
    visionQuality: string,
    codec: ImageQualityCodec, // 传真实 ctx.nativeImage
  ): Promise<Uint8Array>;
  adjustImageQualityBase64(
    base64Data: string,
    visionQuality: string,
    codec: ImageQualityCodec,
  ): Promise<string>;
}
```

`ImageQualityCodec` 是 `dimensions` + `resizeAndEncodeJpeg(bytes, { maxDimension, quality })`
的最小端口。**main 与 F7 分支状态必须分开核对**：

- main 的 `host/platform/native/image/api.ts` 目前只有 `dimensions` / `decodeRgba`，
  **没有** `resizeAndEncodeJpeg`；因此 main 上的 `ctx.nativeImage` 还不能直接作为
  `ImageQualityCodec` 传给本服务。
- F7 候选分支 `ds-mig/F7-native`（HEAD `f8e38e9c4`）的 `NativeImage` 已增加
  `resizeAndEncodeJpeg`（以及 `resizeTriangleJpeg`、`cropRgba`、`encode` 等）；
  F7 合入 main 后 L12 才能直接传 `ctx.nativeImage`。在合入前，L12 若只写
  `ctx.imageQuality.adjustImageQualityBytes(bytes, quality, ctx.nativeImage)` 会类型不通过，
  不得为此在 L12 重造策略。

F3 负责 high/unknown、auto 2MP/4MP 阈值、`<500KB` 且无需缩放的 no-op、invalid
decode/encode 原样回退与参数顺序；编码器本体仍是 F7。`image-quality-service.test.ts` 的
`bytes_quality_preserves_original_on_noop_or_invalid_image` 已用真实 64×32 PNG、真实
`image = 0.24` WASM 解码与真实 invalid decode 经 `ctx.imageQuality` 通过（encode 分支不触发）；
`bytes_quality_matches_base64_policy_and_limits_dimensions` 仍待 F7 的原生 resize+JPEG。

L12 当前 `host/plugins/vfs-index/src/image-codec.ts` 的 `adjustImageQuality` 是自有 sharp
实现，`pdf-runtime.ts:951` 仍通过 `deps.adjustImage ?? adjustImageQuality` 调用它。L12 应改为
把 `ctx.imageQuality.adjustImageQualityBytes(bytes, quality, ctx.nativeImage)` 注入
`deps.adjustImage`，并删除本地策略；F7 encode 合入 main 前，第二条 JPEG 等价测试保持 pending。

## 9.2 无损注入预算（L02 / R1 L02-04）

F3 的实际 `ctx.injectionBudget` 提供 `ExactInjectionBudgetService`（extends 原接口）：

```ts
const config: ExactBudgetConfig = ctx.injectionBudget.defaultExactConfig();
// L02 JsonReader 解出的 usize 直接放进这些 bigint 字段，不先 Number()。
config.total_budget = 9007199254740993n;
config.reserved_for_user_input = 9007199254740992n;
config.reserved_for_system = 0n;
const manager = ctx.injectionBudget.createExactManager(config);
manager.addItem(ctx.injectionBudget.newItem('Rag', '你', 1, 'example'));
const result: ExactAllocationResult = manager.allocate(); // used=1n, remaining=0n
const summary = manager.generateInjectionSummary(result);
```

- `ExactBudgetConfig` 三个预算字段与 `type_limits: Map<InjectionType,bigint>` 保持 usize/u64
  精确；priority_weights 仍 Map<Priority,number>（Rust f32），bool 不变。类型由 api.ts 公开。
- `ExactInjectionBudgetManager` 保留 addItem/addItems/clear/pending_items；allocate 返回
  total_chars_used/budget_remaining 和 allocation_stats 的 **bigint**。smartTruncate 的上限
  参数为 bigint。newItem 仍计算真实 JS 字符串的 Unicode 字符数，单项长度可精确用 number。
- 两次 saturating_sub、类型限制、累计/扣减均为 BigInt；合法 u64::MAX 不拒绝、不套 safe-integer cap。
  仅在截断上限已小于真实字符数组长度后转为 number 做索引；summary 的 f32 百分比是 Rust 明确
  的精度转换，执行直接 usize→f32 舍入、f32 算术及 `{:.1}` ties-to-even；十进制预算/计数不丢位。
- 原 InjectionBudgetService/defaultConfig/createManager 和 number-valued结果不变；旧 manager
  委托**同一份** BigInt allocator，不复制算法。ExactInjectionBudgetService 是增补接口，老的
  类型化提供方声明继续兼容；F3 实际 provider 始终提供两个精确方法，无可选静默降级。
- L02 继续负责 typed JSON 解码、已知字段重复/错误顺序与存储/IPC 形状。返回 IPC 时只将 Map
  转普通对象，保留 BigInt 到 F1 线上边界；不得在到达 allocator 前 Number(config)。
- allocator 保留 Rust clone 语义、所有 info/debug 日志和 warning 字符串；不按 HashMap 的迭代
  顺序比较整份摘要文本。priority_weights 与 Rust 一样不参与当前最高优先级优先分配算法。

## 9.3 LLM 用量记录（`ctx.llmUsage`，L02 / L03）

`dstu-storage/src/llm_usage/mod.rs:78-340` 的统一记录入口，写入 F3 自有的 `llm_usage.db`（`UsageCollector`：
50 条或 5 秒批量、单事务）。消费方以 `ctx.reflect.get('llmUsage', false)` 取用（api.ts: `LlmUsageService`）：

```ts
ctx.llmUsage.recordLlmUsageCacheExtWithIdentity({
  callerType: 'chat_v2', model, promptTokens, completionTokens,
  reasoningTokens, cachedTokens, cacheWriteTokens,      // Option → null（落库 NULL = 无测量）
  sessionId, variantId, runId, durationMs, success, errorMessage, adapter, tokenSource,
});
// 另有 recordLlmUsageCacheExt / recordLlmUsageExt / recordLlmUsage / recordUsageRecord、cacheDebugEnabled()
```

- collector 只在 `llm_usage` 组件初始化成功（非恢复模式、未 blocked）时存在（lib.rs:1585-1607）；
  之前的记录进有界待写队列（1000，满丢最旧 + warn），下一次记录先冲刷。
- `success=false` 且无消息 → `"Unknown error"`；`tokenSource=null` 落库 `"api"`。
- 插件卸载时先冲刷缓冲再关闭连接（经 `StorageCordisService.beforeShutdown` 排序）。测试：`tests/f3-owner-services.test.ts`。

## 9.4 FileManager 路径（`ctx.fileManagerPaths`，L02 / translation）

`FileManager::new(active_app_data_dir)`（lib.rs:3482）的路径方法（api.ts: `FileManagerPathsService`）：

- `getPersistentAppDataDir()`：只返回活动槽目录（先 `create_dir_all` 再写 `.write_test` 探针）；不可用时
  **抛错，不回退**（RF-W07-persistent-app-data-no-silent-relocation）。
- `getTempAppDataDir()`（file_manager.rs:169 的回退链）：活动槽目录 → `dirs::data_dir()/DeepStudent` →
  `temp_dir()/deep_student_data`；每级同样探针，失败 error 日志；最后一级不可写也返回并 warn。
- `getWritableAppDataDir()`：`@deprecated`，与 `getTempAppDataDir()` 完全相同。生产代码已没有调用方，
  将连同 `api.ts` 的接口成员一起删除；新代码不要再用。

调用方迁移（Rust 所有调用方都用 `get_writable_app_data_dir`；活动槽不可写时持久数据会被静默写到回退目录，
活动槽恢复后再也读不到，所以按数据性质拆开）：

| 数据 | 用哪个 | 调用点 |
|---|---|---|
| 数据库、笔记资源、备份根、`anki_media`、测试库 `test_*.db` | `getPersistentAppDataDir()` | `anki/src/plugin-handlers-media.ts:38`（`apkg_import.rs:90/310`）；`platform/settings/backup-commands.ts:165`（备份默认目录）；storage 内部测试库（`index.ts`） |
| OCR 暂存、翻译 `temp/`、导出 staging、`pdf_ocr_temp` | `getTempAppDataDir()` | `translation/index.ts:101-103`、`translation/src/ocr_extract.ts:23`、`media/src/register-ocr.ts:143-145`（`pdf_ocr_temp`）；llm `LlmFileManagerPaths`（`llm/api.ts:155`） |

- 错误形态：`AppError.file_system(...)` 是**普通值**（`{ error_type: 'FileSystem', message, details }`），不是
  `Error` 实例；命令处理函数里直接冒泡，IPC 结果与其他 `FileSystem` 错误一致。命令外部捕获时用
  `isAppErrorValue(e)` 判断，不要 `instanceof Error`。
- 文案：`持久数据目录不可用（创建目录失败|目录不可写）: <活动槽目录> (<io 文案>)`，io 文案与 Rust
  `io::Error` Display 相同，如 `Read-only file system (os error 30)`、`Permission denied (os error 13)`。
- 典型触发：数据目录在只读卷、外置盘被拔出或以只读方式挂载、磁盘满、权限被改。调用方不要自己再找别的目录兜底：
  让操作失败并把错误给用户，比把数据写到下次找不到的地方好。
- 每次调用都会探测一次（写入并删除 `.write_test`），不要在热循环里调用；同一操作内取一次后复用。
- `resolveImagePath(path)`（file_manager.rs:237）：绝对路径原样；否则剥 `images/` 与前导 `/` 后拼到
  `<活动槽>/images`；可 canonicalize 时必须在 canonical(images) 内，否则返回 images 目录；不存在时含 `..`
  组件返回 images 目录。注意基准是**活动槽**，不是 `ctx.app.dataDir`。

## 9.5 虚拟路径判定（`ctx.virtualFilePolicy`，L13 / D29-path）

`unified_file_manager::is_virtual_uri`（unified_file_manager.rs:413）的服务形态（api.ts:
`VirtualFilePolicyService`）。实现就是可移植模块 `file-names.ts` 的 `isVirtualUri`（`api.ts`、`node.ts` 转出的是同一函数对象），不另写判定：
trim 后按 `content:// asset:// ph:// image:// camera://` 或 `primary: secondary: raw:`
前缀（大小写不敏感）判定；`file://`、`tauri://`、URL 编码后的 `content%3A...` 都返回 false。

```ts
// L13 vfs/index.ts:216：四项服务到齐后才登记 mindmap_import
ctx.inject(['agentTools', 'chatSession', 'mindmapXml', 'virtualFilePolicy'], (scoped) => {
  const policy = scoped.virtualFilePolicy; // 或 scoped.get('virtualFilePolicy')
  if (!policy.isVirtualUri(originalPath)) { /* builtin_resource_executor.rs:2901 读本地文件 */ }
});
```

- 在 `startup.start()` 之前 provide，恢复模式（`recovery_required`）下同样可用。
- storage 卸载时撤销，注入它的 scope 随之 dispose。测试：`tests/virtual-file-policy-service.test.ts`。

## 10. 文件删除 journal 端口（D1/D4）

### L10 deletion journal / retention 注册（F3-V2-05）

api.ts 正式公开 `registerDeletionJournal(repo: DeletionJournalRepository): Disposer`，
`registerNoteAssetRetention(retention: NoteAssetRetention): Disposer` 亦已使用 F1 Slot。
两者重复注册均抛 SlotOccupied，先注册者有效；L10 apply 的 ctx.effect 持有 disposer，卸载释放。
旧调用方忽略返回值不会自动释放，L10 必须接入 scope，不能保留永久全局回调。

`DeletionJournalRepository` 六方法完全按 L10 提案，同步接收调用方 SqlExecutor：
insertPreparedIntent(conn, PrepareDeletionJournalIntent) → DeletionJournalIntent|null；
listPreparedIntents(conn, targetKind) → DeletionJournalIntent[]；cancelRetainedIntent(conn, operationId)；
cancelConflictIntent(conn, operationId, message)；markReady(conn, targetKind, intent) → boolean；
cancelReadyWorkspaceDeletion(conn, workspaceId)。精确字段见 api.ts 重导出的类型。

`DeletionJournalIntent.size` 与 `PrepareDeletionJournalIntent.size` 均为 **bigint|null**；
为增补兼容，原 `PreparedDeletionIntent.size` 扩为 number|bigint|null。L10 必须按 Rust
as i64 写入、try_from<u64> 读取（负数→null），不得先经过 Number。
insert 返回 null 由 F3 构造 DuplicateOperation；markReady 返回 false 由 F3 构造
InvalidState("operation {id} 无法推进到 ready")。SQL 错误原样抛，F3 包 Database。
markReady/cancelReadyWorkspaceDeletion 内部保留 Rust 自带 savepoint；F3 的外层准备/finish
事务、哈希及物理文件编排不移动。这是已发布注册/类型接口，L10 仓储与 F3 SQL 委托仍待真实
实现集成，不以注册接口测试宣称 journal 单写者已完成。

### L05 workspace_index owner 注册（F3-V2-05）

公共入口均从 `host/platform/storage/api.ts` 导入：

```ts
type WorkspaceIndexDeletionOwner = (conn: SqlExecutor, workspaceId: string) => void;
registerWorkspaceIndexDeletionOwner(owner: WorkspaceIndexDeletionOwner): Disposer;
```

L05 apply 直接注册其真实 `deleteWorkspaceIndexWithConn`（现 `deleteWorkspaceIndex` 同义函数），
并用 `ctx.effect(() => { const d = registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndexWithConn);
return () => d.dispose(); })` 保存生命周期。重复注册抛 F1 `SlotOccupied`，先注册者继续有效；
dispose 幂等、旧 disposer 不会清掉重注册后的 owner。平台不 import L05。

F3 `prepareWorkspaceDeletion` 的调用点保持 Rust `file_deletion_queue.rs:261-289`：
同一 `SqlExecutor` 上 SAVEPOINT → insert prepared intent → owner(conn, workspaceId) → RELEASE。
缺记录由 owner 成功/no-op；SQL 失败由 F3 包成 `删除意图数据库错误: {e}`，回滚 prepared 行和
索引删除，物理文件保持原状。缺 owner 明确报错并回滚，绝不回退平台直接 DELETE。
prepare/finish/recover/cancel 四个 workspace 编排入口与 PreparedDeletionIntent 从 `node.ts` 导入（依赖 Node，仅桌面）。
本次只关闭 workspace_index 这处越权 SQL；journal/outbox 的 L10 接缝仍未闭合。

**v2 审读更正（F3-V2-05）**：下述是既有公开调用约定；所有权整改尚未闭合。
当前 `file-deletion-queue.ts` 仍有 journal/outbox 与 workspace_index 的直接 SQL，
不能依据旧“只提供 executor”描述宣称单写者通过。L10 的 journal WithConn API 尚未公开，
请求及生命周期缺口见 BLOCKERS.md；本分支未为它复制新的仓储或改弱测试。

表所有者是 L10-notes（`__file_deletion_journal` / `__asset_deletion_queue`）；F3 只发布
`SqlExecutor` 与文件锁原语，不复制表写入，也不让插件拿到 raw better-sqlite3。

```ts
import {
  prepareAssetDeletionWithConn,
  finishAssetDeletionWithConn,
  recoverAssetDeletions,
  recoverWorkspaceDeletions,
  prepareWorkspaceDeletion,
  finishWorkspaceDeletion,
  cancelReadyWorkspaceDeletion,
  type PreparedDeletionIntent,
} from '../../platform/storage/file-deletion-queue.ts';

// 笔记删除：同一事务里写 intent + 删业务元数据，提交后才碰文件。
const intent = db.transaction((tx) => {
  const prepared = prepareAssetDeletionWithConn(tx, activeDir, key, localPath);
  noteRepository.purgeNoteWithConn(tx, noteId);
  return prepared;
});
finishAssetDeletionWithConn(db, activeDir, intent); // autocommit；physical delete -> ready
```

边界：

- `prepareAssetDeletionWithConn` 接受事务作用域，允许与业务元数据删除同事务；**不要**
  collect → purge → 另开事务写 journal。
- `finishAssetDeletionWithConn` / `recoverAssetDeletions` / `recoverWorkspaceDeletions` /
  `prepareWorkspaceDeletion` / `finishWorkspaceDeletion` / `cancelReadyWorkspaceDeletion` 要求
  autocommit（`SqlExecutor.inTransaction !== true`），否则抛 `TransactionBoundary`。
- 顺序固定：`prepared` → 物理 rename/unlink（quarantine 防半删）→ outbox `ready` → 同步 drain 删除
  outbox 行时由 SQLite trigger 推进到 `published`。物理删除只发生在调用方事务提交之后。
- `NoteAssetRetention.assetIsReferenced(conn: SqlExecutor, relativePath)` 与 prepare 使用同一个事务
  快照；L10 注册该回调后，F3 在 `notes_assets/**` 上先查引用再写 intent。
- 旧 notes 调用点仍可传 raw 连接（运行时适配层 + 标 `@deprecated` 的结构化
  `LegacyConnection` 重载）；新调用方只应使用 `SqlExecutor`，L10 迁移完成后删除该重载。

## 11. 数据库 worker 执行端口（L13b R13-02）

### L21 完整迁移任务入口

api.ts 已公开 `createMigrationWorker({ baseDir: string }): MigrationWorker`：

```ts
const migrations = createMigrationWorker({ baseDir: ctx.app.dataDir });
ctx.effect(() => () => migrations.close());
const report = await migrations.runAll({
  appDataDir: candidateOrTestSlotDir,
  migrationsDir,             // 可省略，保持 coordinator 原默认
  auditDbPath: null,          // null 禁审计；省略仍是目标目录 databases/audit.db
});
// 日志不可配置：worker 内每条 storageLog 按原 Rust target（如 dstu_storage::migration::coordinator）转给 Host 主日志。
```

- `runAll(options: MigrationWorkerOptions): Promise<MigrationWorkerReport>` 把整段真实
  `MigrationCoordinator.runAll()`（预检、备份/故障重试、依赖顺序、迁移、恢复/验证/审计）放进
  现有 pool 的一个 worker task；没有第二套迁移算法，没有在 Host 循环中偶尔 yield 冒充 worker。
  不隐式打开另一个 active-slot 库，不把 main-thread 连接或回调函数传进 worker。
- 报告保留 databases/success/totalDurationMs/error，另有纯数据 componentHealth.components；
  threadId 仅用于内部执行证据，不是 Rust IPC 字段，L21 仍按原命令返回值组装响应。
  Error 的 name/message/code/detail 等字段跨线程保留；不保证跨线程 instanceof 原类。
- 无默认超时、不接受前端取消 signal；Rust spawn_blocking 已启动作业不会因 invoke abandon
  被杀。close 拒绝新任务，等待**全部已接收任务**（含队列）settle，最后 terminate；调用方
  不得在 runAll 返回前清理/重置目标目录。
- 一个 L21 插件 scope 持有一个 size=1 的长期 runner。启动备份 guard 从 Host 的实际
  STARTUP_CORE_BACKUP_GUARD 传入任务，完成/异常后合并回同一 guard；close/recreate 不会
  忘掉已完成备份。不是另建第二份业务缓存算法。数据治理操作许可/目标目录稳定性仍由 L21
  按 D2 保证；活动库迁移须先持有其维护许可，不能让该迁移 runner 自己被同一许可 pause 而死锁。
- Coordinator 自己在各 finally 关闭迁移/备份连接；worker task 只在真实 runAll 返回后报告。
  日志经已有 worker context.log 送父 Host logger，包含原级别、消息与字段文本。
  L21 诊断/克隆命令的其他业务步骤仍归 L21，不能因平台迁移任务过测就宣称整条命令闭合。

`migration-worker.test.ts` 以真实四库 SQL 迁移验证 threadId、作业开始后 Host timer 仍响应、
报告/health、幂等重跑、close drain 已接受任务、错误传播，以及 worker→Host 的备份 guard。

### R4-SYNC-06：多库 open-existing 任务

`createDatabaseWorkerPool`、所有 `DatabaseWorker*` / `MultiDatabaseWorker*` 类型，以及
`isVirtualUri` / `rejectDoubleEncodedVirtualUri` / `queuePersistableSafUri` / `copyFileVerified`
现从 **storage/api.ts** 公开。消费者不再导入 worker-pool/service/unified-file-manager 实现。

```ts
// L20 的任务模块导出（实际收集/序列化/文件清理由 L20 实现）
export const multiDatabaseWorkerTasks: MultiDatabaseWorkerTasks = {
  export_sync_data({ openExisting, close, activeDir, payload, threadId }) { /* owner implementation */ },
};
// 主线程：固定本次 activeDir，整个导出只 run 一次，不把收集移回主线程。
await pool.runWithDatabases('export_sync_data', payload, {
  activeDir: ctx.storage.locations.activeDir,
  databases: ['vfs', 'llm_usage', 'chat_v2', 'mistakes'],
  timeoutMs: 0,
});
```

- `openExisting(name, { readonly?: boolean })` 默认只读，返回 DatabaseHandle 或 undefined。
  不建缺失库/父目录、不迁移、不重新解析/写入 slots/state.json；每次调用独立打开。
  缺文件按 Rust `db_path.exists()` 跳过；存在但打不开/损坏则抛错，由 owner 按原分支处理。
  只允许本次声明的四个 core 库；不会自动打开某个主库。
- **Rust 精确打开方式**：`commands_backup.rs:113-118` 的 open_sync_connection 实际为
  read-write，并设 busy_timeout=5000；L20 若保持该打开权限语义，应显式传
  `{ readonly: false }`，仍 mustExist=true、不创建。默认 readonly 适用于明确只读的任务；
  不能把它与 Rust 的读写打开失败条件宣称完全相同。连接 synchronous=FULL 保持 rusqlite 默认。
- `close(handle)` 可在每库采集完后提前关闭；任务成功/失败均 finally 关闭剩余句柄，回复在清理后。
  SQLITE code/phase/database 随错误跨线程保留。完整变更和缓冲写文件均应在任务里执行。
- task context 的 `log(target, level, message)` 把日志转交主线程 F3 已绑定的 Host logger，
  保留 Rust info/warn/error 的 target/级别/字段文本；同 worker 消息按顺序先日志后结果，
  不用 console，不把警告分支静默丢弃。
- Rust 本导出没有超时/取消点：使用 `timeoutMs: 0`、不传前端 AbortSignal。
  原单库 `run` 语义保留。新入口复用同一 pool 的 pause/drain/resume/close；L20 必须按
  §4.1 将 parent pool 注册到真实 storage 维护屏障，覆盖上述四库，卸载时撤销并 close。
- 文件 API 签名：`isVirtualUri(path): boolean`、`rejectDoubleEncodedVirtualUri(path): void`、
  `queuePersistableSafUri(appDataDir, uri): void`、`copyFileVerified(source, target): Promise<number>`。
  原 AppError 对象照抛；桌面虚拟目标在 copy 阶段报 `写入文件失败: … (虚拟路径在当前平台不可用)`。
  L20 仍需先完成 staging，并按 `commands_sync.rs:2483-2490` 两种结果清理 staging；
  worker/文件原语通过不等于 L20 export 命令已接通。

### WP-140：任务内临时文件 `openFile`（L16 APKG collection）

`MultiDatabaseWorkerTaskContext.openFile(path: string, options?: OpenFileOptions): DatabaseHandle`
在**当前 worker 线程**打开任务自有的 SQLite 文件（如解包出的临时 `collection.anki2`、导出时新建的
collection），与 `ctx.storage.openFile` 共用同一开库函数：默认 `plain` profile（synchronous=FULL、
busy_timeout=5000，= rusqlite `Connection::open`）、`mustExist=false`、`createParentDirs=true`；
`label` 缺省为文件 basename；路径/打开失败抛同一 `StorageError`（code/sqliteCode/message 一致）。

```ts
// L16 任务模块（APKG 业务 SQL、ZIP/媒体解析、临时目录清理都归 L16）
export const multiDatabaseWorkerTasks: MultiDatabaseWorkerTasks = {
  apkg_parse_collection({ openFile, close, payload, log }) {
    const { collectionPath } = payload as { collectionPath: string };
    const parsed = parseCollectionDatabase({
      openDatabase: (file) => openFile(file),   // ApkgCollectionRuntime.openDatabase
      closeDatabase: (db) => close(db),         // ApkgCollectionRuntime.closeDatabase
      /* ... */
    }, collectionPath /* ... */);
    return parsed;                              // 只返回纯数据
  },
};
// 主线程：不声明任何 core 库；最终 L16＋L15 同事务落库仍在主线程 ctx.storage 上做。
const parsed = await pool.runWithDatabases('apkg_parse_collection', { collectionPath }, {
  activeDir: ctx.storage.locations.activeDir, databases: [],
});
```

- **关闭职责**：`close(handle)` 可提前关闭（openExisting/openFile 句柄都接受）；任务成功、抛错后
  finally 关闭剩余句柄，再回复主线程。`signal` 中止 / `timeoutMs` 超时会 terminate worker，
  better-sqlite3 在线程退出时关闭连接，未提交事务回滚、文件锁释放（测试有证据）。
  句柄只属于本次任务，不进入 `StorageService.handles/adHoc`，主线程维护屏障也看不到它。
- **返回值**：只能是 structured-clone 数据。结果中任一层含 `DatabaseHandle` / 驱动连接时，
  任务以 `StorageError('INVALID_PARAM', 'database worker task result must not contain a database handle or driver connection')`
  失败（否则 clone 会静默得到一个失效的普通对象）。
- **Rust 边界**：Rust 导入端 `apkg_importer_service.rs:1301-1302` 用
  `Connection::open_with_flags(path, READ_ONLY | NO_MUTEX)`；导出端 `apkg_exporter_service.rs:1904/2130`
  为 `Connection::open` 后执行 `PRAGMA journal_mode = DELETE; synchronous = FULL; temp_store = MEMORY`。
  只读打开请传 `{ profile: { readonly: true, busyTimeoutMs: 5000 } }`；导出 PRAGMA 由 L16 自己的
  SQL 执行。F3 不改这些选择，也不提供远程 SQL 通道。

Rust 用 `tokio::task::spawn_blocking` 把同步 SQLite 事务移出 async runtime（`todo_handlers.rs:77-103`、
`vfs/handlers.rs:843-922`）。Node 的 `DatabaseHandle` 不可 structured-clone，Promise 包同步 SQL 也
没有换线程；F3 提供的是**任务模块 + 自有连接**的端口，不是远程 SQL 通道：

```ts
// 所有者 lane（L11/L13b）提供任务模块，导出 workerTasks。
// host/plugins/vfs-handlers/src/worker-tasks.ts
export const workerTasks: DatabaseWorkerTasks = {
  todo_get_list({ db, payload }) {
    return todoRepository.getList(db, (payload as { listId: string }).listId);
  },
};

// 命令层
const pool = createDatabaseWorkerPool({
  baseDir: ctx.storage.locations.baseDir,
  dataLocalDir: ctx.paths.appLocalDataDir,
  // 需要 browser 懒迁移时才传；普通 vfs 读写不强制，默认沿用仓库路径。
  taskModule: new URL('./worker-tasks.ts', import.meta.url),
  tasks: ['todo_get_list', 'todo_list_items'],
});
ctx.effect(() => () => pool.close());
const list = await pool.run('todo_get_list', { listId }, { database: 'vfs' });
```

契约：

- worker 内每个任务新开 `createStorageService(...).database(database)`，任务结束即 `dispose()`；
  因此数据空间切换/维护后不会复用陈旧连接。
- **每任务新建实例不会自动被主线程维护屏障看到**：它不进 `StorageService.handles/adHoc`。消费者
  必须在实际 parent `ctx.storage` 上注册参与者，否则 `enterMaintenance` 不会暂停/关闭这些连接：
  ```ts
  const off = ctx.storage.registerMaintenanceParticipant('vfs-worker-pool', {
    databases: ['vfs'],
    enterMaintenance: () => pool.pause(),
    exitMaintenance: () => pool.resume(),
  });
  ctx.effect(() => () => { off(); void pool.close(); });
  ```
  已核对：main 没有 F3 的 `registerMaintenanceParticipant`；L11 候选分支 `30272e2c4` 虽已
  注册 `vfs-worker`，但其测试用注册接口替身，且 main 的 `vfs-repos/src/worker-entry.ts:40`
  仍直接 `new SqliteDatabase(...)`，L13b 生产代码尚无 `createDatabaseWorkerPool` 调用。
  因此 main/本分支生产 worker 连接冻结仍是待集成项，不能以“F3 已有 hook”或“L11 分支已有
  注册代码”签收。
- 任务收到 `{ db, payload, threadId }`，`db` 是 `DatabaseHandle`（`SqlExecutor`），由所有者仓储函数
  执行 SQL；F3 不接受 SQL 文本、不序列化 Sqlite 句柄。
- 结果只走 structured clone；业务 `Err` 用 `CommandError.value` 原样返回（字符串错误也保留在
  `value`），其他异常保留名称/栈/附加字段。
- `tasks` 白名单在主线程校验；`timeoutMs` 超时或 `signal` 中止会 terminate 该 worker（SQLite 回滚）。
- `pool.pause()` / `pool.resume()` 是维护屏障端口：pause 在同步轮次内拒绝新任务、等待已分配到
  槽位的在途任务结束，再 terminate 所有 worker；暂停前已在排队等槽位的任务保持排队、不启动，
  等 `resume()` 后按 FIFO 继续。暂停期间 `run()` 只排队不执行。
  L11/L13b 用 `registerMaintenanceParticipant` 挂到 `ctx.storage`，不要自己另建一套关闭顺序。
- 测试必须断言任务内 `threadId !== mainThreadId`（`worker-pool.test.ts`），不能用“同步执行后读到
  自己的写入”冒充换线程。

L13b 接线前需 L11 确认：`vfsRepo`/todo 仓储的公开函数签名接受 `SqlExecutor`（而不是绑定
`VfsDatabase` 实例），这样 worker 任务模块可直接复用所有者实现，不需要在 F3 里重建仓储。

## 12. 启动接线
