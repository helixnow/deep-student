# 移动端存储设计（W14 第三轮，仅设计）

范围：移动端（Capacitor WebView：iOS WKWebView、Android System WebView）以及 Web 上的
`StorageService` / `DatabaseHandle` 实现方案。本文不新增依赖，也不改 `host/platform/storage`
的任何文件（W08 正在改其中的启动迁移部分）。文中数字均于 2026-11-07 在 W14 工作树上用 `rg` 统计，
统计时排除 `tests/` 和 `*.test.ts`。

## 0. 结论

1. **推荐方案：SQLite WASM + OPFS，跑在 Dedicated Worker 里，且整个 Host（Cordis + 插件 + 仓储）
   也搬进这个 Worker。** UI 留在 WebView 主线程，通过与 Electron IPC 相同的命令 RPC 和 Worker 通信。
   这样 SQLite 调用是**同步**的，现有 `SqlExecutor` / `transaction()` / `savepoint()` 契约原样成立，
   406 个仓储/服务文件不用改。
2. **Capacitor SQLite 原生插件暂不采用**：它的每次调用都要过 JS↔原生桥，只能是 Promise。现有契约是同步的
   （见 §3），换成它就得把约 400 个文件改成 async，并且会失去"同步事务期间不让出事件循环"这条原子性前提。
   FTS5 trigram 和 SQLite 版本也无法由我们控制（见 §5）。
3. **迁移**：用同一批 `src-tauri/migrations/<db>/V*.sql`，构建时把原文按字节打包成模块。
   refinery 校验和（`SipHasher13`，纯 TS）不变；只需把 `fingerprint.ts` 的 `node:crypto` sha256
   换成可移植实现。
4. **FTS5 trigram**：只要 WASM 构建开启 FTS5 且 SQLite ≥ 3.34，trigram 就可用。我们自编 `sqlite3.wasm`，
   版本固定为与 better-sqlite3 13.0.3 相同的 **SQLite 3.53.4**，编译选项也对齐桌面（§5）。
5. **跨设备一致性**靠"同一份 SQL + 同一 SQLite 版本与编译选项 + 同一份 TS 业务代码"。i64 一律走
   `safeIntegers`。另做一套 desktop ↔ browser 的金值回放测试来证明一致（§6）。

## 1. 现状约束（为什么关键在"同步"）

| 事实 | 数量 / 位置 |
|---|---|
| `SqlExecutor` 所有方法同步（`get/one/pluck/all/iterate/run/exec`），文档写明"不会在中途让出事件循环" | `api.ts:236-266` |
| 引用 `SqlExecutor` 的非测试文件 | **406 个文件 / 3785 处**（vfs-repos 42、notes 37、chat 31、sync 26、anki 26、vfs-index 25、qbank 25、vfs 22、agent-workspace 22、memory 20 …） |
| 同步事务 `db.transaction(fn)`（回调返回 Promise 视为编程错误） | 62 个文件 / 122 处（chat 11、qbank 9、sync 8、anki 5、agent-orchestration 5 …） |
| `savepoint(fn)`（同步） | 6 处：`memory/src/service.ts:1216`、`chat/repository/blocks.ts:188`、`qbank/src/question-service.ts:206,344`、`qbank/src/practice-service.ts:485` |
| `iterate()`（同步迭代器） | 6 处：`memory/repository/audit.ts:95`、`sync/repository/conflicts.ts:154`、`sync-support/repository/state.ts:96`、`backup/repository/diagnostics.ts:15` 等 |
| 异步事务 `DatabaseHandle.begin` / `withTransaction` / `write` | 只有 2 处：`chat-pipeline/src/incremental-persistence.ts:55`、`final-persistence.ts:49`（`sync/repository/startup-state.ts:33` 的 `conn.begin()` 是 `StartupDatabase` 的同步 `BEGIN`；`vfs-index` 的 `write()` 是它自己的 `VFS_MUTATION_LOCK`/`KB_MUTATION_LOCK`） |
| `checkpoint()`（WAL 专用） | 9 处：`backup/src/backup-manager.ts:150,158,727,731,745`、`browser/src/database.ts:19`、`sync/repository/workspace-files.ts:37` 等 |
| `backupTo(path)` | 5 处：`backup/src/backup-manager.ts:153,737`、`backup/src/governance.ts:515`、`storage/migration/backup.ts:283` |
| `openFile(path)`（按路径打开工作区库） | 29 个文件：sync 16、backup 3、anki 3、storage 2、chat / chat-pipeline / agent-workspace / agent-orchestration / log 各 1 |
| `safeIntegers` | 67 个文件 / 135 处（同步序号、纳秒时间戳、`sync_version`） |
| `db.exec('…')` 脚本 | 60 个文件 / 333 处 |
| 直接 import `better-sqlite3` | `storage/connection.ts`、`storage/repository/data-space.ts`、`storage/file-deletion-queue.ts`（另有 e2e fixtures） |
| storage 内部的 Node 依赖 | `connection.ts`（fs/path/better-sqlite3）、`service.ts`、`migration/{definitions,coordinator,backup,audit-log,repairs,refinery,schema-registry,fingerprint}.ts`（fs/path/crypto）、`worker-pool.ts` / `worker-entry.ts`（`worker_threads`）、`worker-databases.ts` |
| 并发模型 | `database.ts` 文件头：主连接执行同步 API；异步事务用**独立连接**跨 `await` 持有写者槽（FIFO），持有期间主连接写立即 `BUSY` |

结论：**现有 `DatabaseHandle` 假设同步，确实会挡住任何纯异步实现。** 要么让 SQLite 在 Host 所在线程同步可用
（方案 B），要么把上表的调用点全部 async 化（方案 A，代价见 §4）。

## 2. 方案对比

| 维度 | A. Capacitor SQLite 原生插件（`@capacitor-community/sqlite` 类） | B. SQLite WASM + OPFS（Worker 内） |
|---|---|---|
| 调用模型 | JS→原生桥，**只能异步**（Promise） | Worker 内 **同步**（`sqlite3` C API / oo1） |
| 现有调用点改动 | ~400 个文件 async 化，事务语义要重新论证 | `StorageService` 换一个实现；插件代码不改 |
| SQLite 版本 / 编译选项 | 由插件和系统决定（iOS 常用 SQLCipher 或系统库，Android 由插件打包），**FTS5 / trigram 要逐平台验证** | 自编 wasm，版本和 `-D` 选项与桌面逐项对齐 |
| 持久化 | 原生文件，系统不会回收 | OPFS；需 `navigator.storage.persist()`，并定期用 `VACUUM INTO` 导出到原生文件系统作兜底（§7） |
| 性能 | 原生 I/O，单次调用有桥开销（批量查询还好，N+1 查询会很糟） | `opfs-sahpool` 是同步访问句柄，无桥开销；WASM 计算比原生慢约 1.5–2 倍 |
| 线程 | 原生侧可并发 | 单 Worker 单线程，与 Node Host 模型一致 |
| 包体 | 原生库 | `sqlite3.wasm` 约 1 MB 级（再加我们的编译选项） |
| 依赖 | 新 npm 依赖 + 原生工程配置 | 新 wasm 产物（可像 `f7-native-wasm.wasm` 一样自编后提交，或申请 `@sqlite.org/sqlite-wasm`） |

**选 B。** A 只在以下情况重新考虑：iOS 目标版本的 WKWebView 不支持 OPFS 同步访问句柄，或者 §7 的持久化验证不通过。
即便如此，A 也应先做"Worker 内的同步门面 + 原生侧批处理"再评估，而不是直接 async 化 400 个文件。

## 3. 推荐架构（方案 B）

```
WebView 主线程（UI，src/）
   │  命令 RPC（与 Electron preload/IPC 相同的命令名与载荷）
   ▼
Dedicated Worker：移动端 Host
   ├─ Cordis + host/profiles/mobile.json 中的插件
   ├─ MobileStorageService（新，host/platform/storage-mobile/）
   │    └─ sqlite3.wasm + OPFS VFS（首选 opfs-sahpool：不需要 COOP/COEP 和 SharedArrayBuffer）
   ├─ F7 引擎：host/platform/native/wasm/engine.ts（第三轮已可移植，同步 _start 在 Worker 内不卡 UI）
   └─ ctx.files / ctx.crypto / ctx.http 的移动端实现（第一轮已有）
```

`MobileStorageService` 实现 `api.ts` 的 `StorageService` / `DatabaseHandle` 接口（同一类型，不分叉）：

| 接口 | 移动端实现 | 与桌面差异 |
|---|---|---|
| `get/one/pluck/all/run/exec` | `sqlite3_prepare_v3` 语句缓存（按 SQL 文本，对应 `prepare_cached`）+ step | 无 |
| `iterate` | 同步生成器包装 step | 无 |
| 参数绑定 | 位置参数直接绑；命名参数用 `sqlite3_bind_parameter_name` 去掉 `:`/`@`/`$` 前缀后查对象键（oo1 默认要求键带前缀，不能直接用）；`boolean`→0/1；`bigint`→`bind_int64`；`undefined` 抛错 | 无 |
| 读值 | 按 `sqlite3_column_type`：INTEGER 用 `column_int64`（BigInt），未开 `safeIntegers` 时转 `Number`（与 better-sqlite3 相同，超过 2^53 会丢精度）；BLOB 复制成 `Uint8Array` | BLOB 是 `Uint8Array`，不是 `Buffer`（见 §3.1） |
| `transaction(fn, {behavior})` | `BEGIN DEFERRED/IMMEDIATE/EXCLUSIVE` … `COMMIT`/`ROLLBACK`，回调返回 Promise 时回滚并抛 `ASYNC_IN_SYNC_TX` | 无 |
| `savepoint` / `afterCommit` | 同桌面（`SAVEPOINT`/`RELEASE`/`ROLLBACK TO`） | 无 |
| `write()` | 写者槽 FIFO + 同步事务 | 无 |
| `begin()` / `withTransaction()` | 首选：与桌面一样用**第二条连接**。OPFS VFS 能否在同一 Worker 内对同一文件开两条连接、并正确加锁，是 spike 验证项 S2。不行则退到"单连接 + 异步事务期间对其他代码的任何语句抛 `BUSY`"，并把 §1 列出的 2 个 `begin` 调用点改成 `write()` | 回退方案下，异步事务期间的读也会 `BUSY` |
| `batch` | 同桌面 | 无 |
| `checkpoint(mode)` | 原样执行 `PRAGMA wal_checkpoint`；非 WAL 库上 SQLite 自己返回 `[0,-1,-1]` | 结果值不同；调用方（backup、browser、sync）只在 `try` 里调用，不依赖返回值 |
| `backupTo(path)` | `VACUUM INTO '<OPFS 路径>'`；如果自编构建导出了 `sqlite3_backup_*`，则用在线备份 | 输出是 VACUUM 后的紧凑库，页布局与在线备份不同，内容一致 |
| `ConnectionProfile.journalMode` | OPFS VFS 通常不支持 WAL（需要共享内存，见 S3）。移动端 profile 覆盖为 `TRUNCATE`；`synchronous`、`foreign_keys`、`auto_vacuum` 不变 | 日志模式不同（数据层面无差异） |
| `busyTimeoutMs` / `nativeSqliteBusy` | 单线程下第二连接的冲突只可能来自我们自己的写者槽，照常设置 `busy_timeout`；`sqlite3_busy_handler` 不提供 | 无 |
| `openFile(path)` | `locations.ts` 产出的路径映射为 OPFS 下的名字（`/<slot>/<相对路径>`），用 `ctx.files` 统一路径规则 | 绝对路径变成虚拟路径 |
| `StorageError` | `sqlite3_extended_errcode` 经 `sqlite3_js_rc_str` 得到 `SQLITE_CONSTRAINT_UNIQUE` 一类字符串，message 用 `sqlite3_errmsg`，与 better-sqlite3 的 `SqliteError.code` / `message` 同源 | 无 |
| worker pool（`createDatabaseWorkerPool`，仅 notes 使用） | 移动端在 Host Worker 内**内联执行**任务函数（任务本来就只拿 `{db, payload}`） | 没有线程跳转 |

### 3.1 仍需适配的点（方案 B 下也要改）

1. **storage 内部的 Node 依赖**（§1 表中那些文件）：用新目录下的 `connection.ts` / `service.ts` 替代，
   复用 `database.ts` 中与驱动无关的部分。具体做法是先把 `database.ts` 依赖的连接接口抽成
   `Connection` 端口（W08 释放 storage 之后再做，避免冲突）。
2. **直接 import `better-sqlite3` 的生产文件**：`storage/repository/data-space.ts`、`storage/file-deletion-queue.ts`。
   改为经 `DatabaseHandle`。
3. **`Buffer` 假设**：BLOB 读出后调用 `Buffer` 方法（如 `.toString('base64')`）的地方在移动端会坏。
   在扫描器里加一条规则，统计 `Row` 值上的 `Buffer` 方法调用，逐个改用 `util/portable.ts` 的 base64/utf8 工具。
4. **`checkpoint` / `backupTo` 调用方**：语义上已兼容，但 `backup-manager.ts` 里依赖 `-wal` / `-shm` 文件存在的逻辑要按平台分支。
5. **迁移相关的文件读写**：见 §4。

## 4. 若必须异步（方案 A）的改造清单与计划

只有 §2 的回退条件成立时才执行。受影响的调用点就是 §1 的表，具体为：
`SqlExecutor` 406 个文件、`transaction(fn)` 62 个文件、`savepoint` 6 处、`iterate` 6 处、
`safeIntegers` 67 个文件（只需改调用形状，语义不变）。

计划：

1. 在 `api.ts` 旁新增 `AsyncSqlExecutor`（方法返回 Promise）和 `AsyncTransactionScope`，`DatabaseHandle` 两套都实现。
   桌面实现直接包装同步版，零风险。
2. 写 codemod：`(db: SqlExecutor, …) => T` 改为 `async (db: AsyncSqlExecutor, …) => Promise<T>`，
   调用处补 `await`；`db.transaction(tx => …)` 改为 `db.withTransaction(async tx => …)`。
   按依赖层次推进：vfs-repos → vfs → notes / qbank / anki → chat / chat-pipeline → sync / sync-support。
   每一层用该层的全部测试守住。
3. 原子性重新论证：同步事务现在靠"不让出事件循环"保证没有交错。async 化之后，所有写入都必须经写者槽，
   读也要接受"事务外看到的是提交前快照"。sync 的 `__change_log` 触发器链和 tombstone 序列测试
   （`sync-support` 的 handshake 测试）是验收门槛。
4. 估算：约 400 个文件机械改写，外加约 60 处事务语义复核。工作量明显高于方案 B 的"一个新 `StorageService` + §3.1"。

## 5. 迁移与 FTS5

### 5.1 在移动端运行迁移（同一份 SQL，同一校验和）

1. **SQL 来源**：`migration/definitions.ts:64` 现在用 `fs.readFileSync` 从 `src-tauri/migrations/<db>/` 读。
   移动端改由构建步骤生成 `migrations.bundle.ts`，内容是 `{ db, file, sql }[]`，`sql` 为**原始字节**的 UTF-8 文本
   （不做换行规范化，不去 BOM）。`loadSqlMigrations` 改为接受一个"SQL 源"端口（目录或 bundle）。
2. **校验和**：refinery 校验和 = `SipHasher13(name, version, sql)`，实现在 `migration/refinery.ts:28-127`，是纯 TS。
   只要 SQL 文本逐字节相同，`refinery_schema_history.checksum` 就相同。
   需加一个测试：对每个文件，bundle 算出的校验和 == 从目录读出算出的校验和。
3. **`fingerprint.ts` / `schema-registry.ts`** 用 `node:crypto` 的 sha256：换成 `@noble/hashes/sha2`（已是根依赖）
   或 `ctx.crypto`（第一轮已提供可移植实现）。输出 hex 不变。
4. **`audit-log.ts`**：`randomUUID` 换成 `crypto.randomUUID()`；日志文件写到 OPFS（经 `ctx.files`）。
5. **迁移前备份**（`migration/backup.ts`）：`backupTo` 改为 `VACUUM INTO` OPFS 文件（§3）。
6. **协调器**（`coordinator.ts`）的逻辑和顺序不变，只替换 fs/path 端口。
   `refinery_schema_history.applied_on` 仍是 RFC3339，由 JS 时钟生成，与桌面相同。
7. **验收**：在 browser smoke（扩展 `scripts/portability/browser-wasm-smoke.mjs`）里对空库跑全部迁移，
   比较 `refinery_schema_history` 和 `fingerprint.ts` 的 schema 指纹与桌面金值，要求完全一致。

### 5.2 FTS5 trigram 可用性

- 使用情况：`trigram` 用于 vfs 的 `notes_fts`（`V20260724__notes_fts.sql`）和 `insight_fts`（`V20260908__insight_fts.sql`）；
  `unicode61` 用于 `questions_fts`（vfs init）和 `chat_v2_content_fts`。
- 桌面实测（better-sqlite3 13.0.3）：SQLite **3.53.4**，编译选项含 `ENABLE_FTS3/FTS4/FTS5`、`ENABLE_MATH_FUNCTIONS`、
  `ENABLE_RTREE`、`SOUNDEX`、`DQS=0`、`LIKE_DOESNT_MATCH_BLOBS`、`MAX_LIKE_PATTERN_LENGTH=50000`、`THREADSAFE=2`；
  `CREATE VIRTUAL TABLE … USING fts5(x, tokenize='trigram')` 成功。
- trigram 分词器是 FTS5 本体的一部分（SQLite ≥ 3.34），没有单独的编译开关。所以方案 B 只要开 FTS5 就有 trigram。
- **自编 `sqlite3.wasm` 时对齐上面的 `-D` 选项**，尤其是 `DQS=0`：否则用双引号写的字符串字面量在一端报错、另一端放行。
  `MAX_LIKE_PATTERN_LENGTH` 也影响行为。spike S1 用 `PRAGMA compile_options` 与桌面逐项比对。
- 方案 A 下，FTS5 / trigram 取决于插件打包的 SQLite（或 SQLCipher）构建，必须在 iOS 和 Android 真机上分别验证。
  这也是不选 A 的原因之一。

## 6. 跨设备同步一致性

同步建立在 SQLite 触发器（`V20260131__add_change_log.sql` 等）写 `__change_log`、`sync_version`（i64）、
HLC（`"<millis:015>-<counter:05>"`）和 LWW 比较（`sync-support/src/lww.ts`，纯 TS）之上。

| 一致性来源 | 移动端如何保证 |
|---|---|
| 触发器、`json_*`、`strftime`、浮点转文本、`NOCASE`/`LIKE` 行为 | 同一 SQLite 版本（3.53.4）+ 同一编译选项。这些内建函数的输出在不同 SQLite 版本之间并不保证逐字节相同（例如浮点转文本），所以必须钉版本 |
| i64（`sync_version`、序号、纳秒时间戳） | 现有 67 个文件的 `safeIntegers` 原样生效（§3 读值规则）；JSON 载荷里的 i64 走 `kernel/serde.ts` 规则（F1 已有） |
| HLC / 设备时钟 | HLC 逻辑在 TS 里共用；移动端被挂起后时钟跳变由 HLC 的 counter 吸收；HLC 状态持久化在库中，与桌面相同 |
| 校验和排除 | `sync/src/classification.ts:75-94` 已把 FTS 影子表和派生表排除在校验和之外，两端 FTS 索引各自重建即可 |
| 资产文件 | 路径规则走 `ctx.files`（第一轮）。iOS 文件系统可能给出 NFD 文件名，导入时统一规范为 NFC 再入库 |
| 事务边界 | 方案 B 下与桌面完全相同（同步事务、写者槽）。这一点是方案 A 拿不到的 |

**验证手段**：用"金值回放"测试。同一串命令（建笔记、改题、删卡、冲突解决）分别在桌面（better-sqlite3）
和 headless Chromium（sqlite3.wasm + OPFS）上执行，导出 `__change_log`、业务表和 tombstone 后逐字节比较。
框架沿用本轮的 `scripts/portability/browser-wasm-smoke.mjs`（Vite + Playwright），它已证明 FSRS / tokenizer / Argon2
在纯浏览器里与桌面金值一致。

## 7. 风险与 spike 验证项（实现前必须完成）

| 编号 | 验证内容 | 不通过时 |
|---|---|---|
| S1 | 自编 `sqlite3.wasm`（3.53.4，§5.2 的选项）在 Chromium 和 iOS WKWebView 中运行，`PRAGMA compile_options` 与桌面一致，trigram 建表和查询结果一致 | 调整构建 |
| S2 | `opfs-sahpool` 在同一 Worker 内对同一库开两条连接时，加锁行为正确（异步事务一条 + 主连接一条） | 退到单连接回退方案（§3 表 `begin` 行） |
| S3 | OPFS VFS 是否支持 WAL；不支持时 `TRUNCATE` 日志下的崩溃恢复（在事务中途杀掉 App） | 必须通过，否则不能上线 |
| S4 | Capacitor iOS（目标最低版本）的 WKWebView 支持 `FileSystemSyncAccessHandle`；Android System WebView 版本下限 | 不支持则转方案 A 的"同步门面"评估 |
| S5 | 持久化：`navigator.storage.persist()` 结果；存储压力下是否被回收；定期 `VACUUM INTO` 导出到原生目录作兜底 | 改为每次提交后增量导出，或转方案 A |
| S6 | 内存：Worker 内 sqlite3.wasm + F7（7.9 MB）+ tiktoken 同时驻留时，在低端 Android 上的峰值 | F7 改为按需实例化后释放（`engine.ts` 已是每请求一个实例） |

## 8. 分阶段落地

1. **依赖申请**（主代理 / 架构师）：自编 `sqlite3.wasm` 产物（推荐，与 `f7-native-wasm.wasm` 同样做法），
   或 `@sqlite.org/sqlite-wasm`。Capacitor 外壳另由移动端工作流申请。
2. **端口抽取**（等 W08 释放 `host/platform/storage` 后）：`Connection` 端口、迁移 SQL 来源端口、
   `fingerprint` 哈希端口。桌面行为不变，现有 storage 测试守住。
3. **`host/platform/storage-mobile/`**：`MobileStorageService` + sqlite3.wasm 驱动 + OPFS 路径映射；
   对 `api.ts` 契约复用 storage 现有契约测试（参数化驱动）。
4. **迁移 bundle 生成器** + 校验和一致性测试 + 浏览器内全量迁移金值。
5. **跨设备金值回放**（§6）。
6. 把 storage 放进 `host/profiles/mobile.json`：新增 `host/platform/storage/mobile.ts`（生成器对移动端优先取目录下的 `mobile.ts`，`meta.platforms` 需含 `mobile`），由它装配 `storage-mobile/` 的实现。
