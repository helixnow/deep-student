# L20b 同步观测端口：S05 / S06 跨 lane 说明

## WP-164 当前接缝（覆盖下方 WP-008 历史能力调查）

F7 WP-161 已在 main `676b29852`；F3 使用其公开 `NativeSqliteBusy` 服务类型，
`openStartupDatabase(path, { nativeSqliteBusy: ctx.nativeSqliteBusy })` 返回的句柄现在支持
`setBusyHandler(handler: ((priorInvocations: number) => boolean) | null): void`。
pre-storage 仅需native provider，不依赖ctx.storage。回调位于同一连接的同一次step内，
抛错吞为false，保留SQLite自己的返回，不延后重抛。替换/null/close释放引用，timeout覆盖
后的旧引用在下一次注册/close释放。测试 `startup-busy-handler.test.ts` 覆盖真实双连接与worker。
L20b仍需将此接口接入原reserve测试，F3平台lock_probe不会代签业务seq=2；非Linux产物和panic
hook独立。旧WP-008报告与WP-140提交保留，F3原测试映射pending仍0。

日期：2026-11-05（WP-008 复核）。本文由 F3-storage 维护，记录 L20b-sync-support 复核中依赖 F3（以及
F7 原生层）的两个未闭合项。当前 F3 映射 pending 为 0，不包含这两项；它们是跨 lane
集成/观测能力，不能靠 F3 测试或 L20b 测试替身冒充完成。

- S05：`SyncStateStore` 需要区分 SQL 的 prepare / bind / step（查询启动）/
  遍历 / 列解码阶段，以便保留 Rust 的错误文案。
- S06：`tombstone_sequence_waits_for_writer_before_reading` 需要真实的
  SQLite busy 回调通知；JS 层 sleep / 重试不能证明 contender 进入了 busy handler。

L20b 侧证据（分支 `ds-mig/L20b-sync-support`，核对时 HEAD `156868713`）：

- `host/plugins/sync-support/SPEC.md:63`：S05 已修事务 BEGIN/COMMIT 和列错误，
  但 F3 `SqlExecutor` 只有 `get/all/iterate` 合并接口，无阶段元数据。
- `host/plugins/sync-support/REPORT.md:62-66`：S06 等待 F3 的实际 SQLite busy
  通知；保留的最终序号测试不冒充 busy handshake。
- `host/plugins/sync-support/tests/state.test.ts:24-54`：当前补充用例用
  `setTimeout(300)` 检查未结算，注释已明确这不是 busy handler 证明。

## S05：SQL 阶段错误

### Rust 语义

`src-tauri/crates/dstu-sync/src/data_governance/sync/state.rs` 的 `cursors`
（`:417-441`）与 `device_rotations_for_new`（`:291-310`）分别对每个阶段给出不同
文案：

| 阶段 | Rust 调用 | `cursors` 文案 | `device_rotations_for_new` 文案 |
|---|---|---|---|
| prepare | `conn.prepare` | `读取消费游标失败: {e}` | `读取设备轮换历史失败: {e}` |
| bind + 首次 step | `stmt.query` / `stmt.query_map` | `查询消费游标失败: {e}` | `查询设备轮换历史失败: {e}` |
| 后续 step | `rows.next()` | `遍历消费游标失败: {e}` | — |
| 列解码 | `row.get(0/1)` | `读取游标设备失败` / `读取游标序号失败: {e}` | `解析设备轮换历史失败: {e}` |

Rust 的 `rusqlite::Error` 能区分 `SqliteFailure`、`InvalidColumnType` 等；L20b
当前在 `host/plugins/sync-support/src/state.ts:154-195` 每个方法只用一个
guard：`deviceRotationsForNew` 是 `查询设备轮换历史失败`，`cursors` 是
`查询消费游标失败`；prepare / 首次 step / 遍历 / 列解码错误都被合并，
所以无法通过测试逐阶段断言。

### Host 现状（2026-11-04 已发布 `StorageError.phase`）

F3 已实现 `StorageError.phase: 'prepare' | 'bind' | 'execute'`：

- `connection.ts` 在 `statement()` 失败时标 `prepare`；`bindArgs`/`safeIntegers`/`pluck`
  配置失败标 `bind`；`get/all/iterate/run/exec/pragma/begin/commit/rollback/backup`
  运行期失败标 `execute`。不解析错误文案，`sqliteCode`/`cause` 原样保留。
- 三条回归在 `tests/database.test.ts`：不存在的表 → prepare；`undefined` 参数/参数个数
  → bind；UNIQUE 约束 → execute + `SQLITE_CONSTRAINT_*`。
- L20b 仍可用 `SqlExecutor.iterate()` 区分“首次 step”和“已拿到首行后的遍历错误”：
  两者都是 `execute`，由调用方按是否已产出首行映射文案。

`host/platform/storage/connection.ts` 的物理分层：

- `Connection.statement(sql)`：`raw.prepare(sql)`，失败进 `toStorageError`；
- `Connection.prepared(...)`：设置 `safeIntegers` / `pluck`；
- `bindArgs(plan, params)`：参数数量/类型校验，失败是普通 `Error`，且发生在
  `try` 之外（`get/all/iterate/run` 都是先 `bindArgs` 再执行）；
- `stmt.get/all/iterate/run`：better-sqlite3 内部完成 bind、step、行物化，
  失败统一被 `toStorageError` 包成 `StorageError('SQLITE')`，只保留
  `sqliteCode` 与 message。

`better-sqlite3` 13.0.3 没有公开 `sqlite3_step`/`sqlite3_column_*` 的逐阶段
API；`Statement.busy` 是“同一连接正在执行查询”的标志（`src/objects/statement.cpp:377`），
与锁争用无关，不能用于阶段判断。

### 已发布的最小端口（原建议，现为实际接口）

给 `StorageError` 增加可选阶段，并由 F3 在任何文本解析之前打标：

```ts
export type SqlPhase = 'prepare' | 'bind' | 'execute';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly sqliteCode: string | undefined;
  readonly database: string | undefined;
  /** 新增：失败发生在哪一阶段；旧构造点保持 undefined。 */
  readonly phase?: SqlPhase;
}
```

保证：

1. `Connection.statement()` 内 `prepare` 抛错 → `phase: 'prepare'`；
2. `bindArgs()` / `pluck`/`safeIntegers` 配置抛错 → `phase: 'bind'`；
3. `stmt.get/all/iterate/run` 执行期抛错 → `phase: 'execute'`；
4. `exec/begin/commit/rollback/backup` → `phase: 'execute'`；
5. 不解析错误字符串；`sqliteCode`、`cause` 原样保留。

L20b 的映射（在它自己的 `repository/` 内完成，F3 不写同步文案）：

- `phase === 'prepare'` → `读取…失败`；
- `phase === 'bind'`，或第一次 `iterate().next()` 的 `execute` → `查询…失败`；
- 已经拿到第一行之后的 `execute` → `遍历…失败`；
- 自己 `row.get`/字段解码抛错 → `读取游标设备失败` / `读取游标序号失败` /
  `解析设备轮换历史失败`（这些是 L20b 的类型契约，不需要 F3 知道列类型）。

因此 L20b 要把 `cursors`/`deviceRotationsForNew` 从 `all()` 改成
`iterate()`（或 F3 增加 `iterateRaw`/`allRaw` 并返回列元数据），才能把“首次
step 失败”和“遍历中途失败”分开。仅用 `all()` 只能诚实地归到
`phase: 'execute'`，不要按文案猜。

如果要求严格复刻 `InvalidColumnType`（Rust `row.get::<String>` 读到整数/BLOB），
推荐由 L20b 用显式字段解码 + 自己的 `SyncError` 文案完成；F3 只负责把原始
`sqlite3_column_type` / 值交给调用方（可在 `Row` 中保留 `Uint8Array`/`bigint`）。
F3 不应把“列类型不符合某个业务字段”当成 SQL 引擎错误。

### F3 验证结果（已落地）

- prepare 阶段：`SELECT * FROM table_that_does_not_exist` → `phase === 'prepare'`；
- bind 阶段：`undefined` 参数与参数个数错误 → `phase === 'bind'`；
- execute 阶段：UNIQUE 约束错误 → `phase === 'execute'` 且 `sqliteCode` 保留；
- 旧 `StorageError` 消费者不受影响（`code`/`sqliteCode`/`database` 不变）。

## S06：SQLite busy 回调

### Rust 语义

`state.rs:597-664` 的 `tombstone_sequence_waits_for_writer_before_reading` 做了
三件事，缺一不可：

1. writer 用 `BEGIN IMMEDIATE` 占住写者槽；
2. contender 安装 `Connection::busy_handler`，在回调里向测试线程发“已等待”信号，
   并阻塞到测试线程放行；
3. 测试线程收到信号后提交 writer，证明 contender **没有持有读锁**、只在 busy
   handler 中等待；随后 contender 的 `BEGIN IMMEDIATE` 成功，序号必须包含
   writer 已提交的事件（`seq == 2`）。

`state.rs:234-237` 的注释说明为什么必须是 `BEGIN IMMEDIATE`：deferred 的
`SELECT → INSERT` 升级在争用时会立刻失败（`SQLITE_BUSY`），绕过
`busy_timeout`，所以不能靠普通读事务模拟。

### WP-008：现有绑定能力与等价性裁定请求

main `967f43c75` 的 `api.ts:165-166` / `startup-database.ts:134-142` 已有真实
`openStartupDatabase`，不是 D18 缺失。`llmUsage` 也已公开，本包不重做。
安装包 `node_modules/better-sqlite3/package.json:3` 为 **13.0.3**；可重复执行的
运行时清单为 `tests/busy-capability-probe.mjs`（命令经 jobs，见本包报告）。

实测 Node 26.5.0 / Electron 45.2.1（Node 24.22.1），两者 N-API 10，加载同一安装包、
SQLite **3.53.4**，busyHandler/setBusyHandler/interrupt 均 undefined，默认 timeout 5000。
探针 jobs `20261105140509-7b2828` / `20261105140509-dafe16` 均 exit 0。

源码证据（均为本机实际安装版本）：

| 能力 | 证据 / 能否提供原测试屏障 |
|---|---|
| timeout | `src/objects/database.cpp:167` 设置 `sqlite3_busy_timeout`；`lib/database.js:33-35,57-58` 只传 timeout/verbose，无 handler 选项 |
| 原生公开方法 | `src/objects/database.cpp:123-136` 注册表无 busy handler、interrupt、锁状态观察方法；JS 包装列表 `lib/database.js:63-78` 同样没有 |
| `Statement.busy` | `src/objects/statement.cpp:377-379` 返回 `alive && locked`，是该 statement 的迭代锁，不是 SQLite 文件写锁等待 |
| verbose | `src/objects/database.cpp:239-244` **先**调用 Log，**再** sqlite3_step；即使收到通知，SQL 也可能还未尝试取锁 |
| C 引擎内部 handler | `deps/sqlite3/sqlite3.c:189245-189258` 的 timeout 内部调用 sqlite3_busy_handler；引擎有能力，但 JS 无法安装/观测它，不应写成“SQLite 没有 handler” |
| loadExtension/nativeBinding | 确实存在扩展加载入口，但没有已提供的 busy 扩展/桥。使用它仍须新增原生产物；不能用另一个 SQLite 库操作本绑定的私有 sqlite3 指针 |

原测试的三条断言准确含义：

1. `:644,653-656` 的 10s 接收成功，证明**当前业务调用已经实际争用**；`:627-632`
   的 handler 尚未返回，不是预先发出的 “about to begin”，也不是已返回的 SQLITE_BUSY。
2. `:645,657` 在该屏障期间 COMMIT 成功。在默认 rollback-journal/DELETE 模式下，
   contender 没有阻碍 writer 升级到 EXCLUSIVE 的读锁。不能改 WAL：WAL 读者不阻挡 COMMIT，
   会丢掉此断言的检错能力。
3. `:649-651,658-662` 放行**同一次**调用并 join，业务结果 `2` 包含 writer 刚提交的 `1`。
   不是捕获 BUSY 后重启一次新的业务调用。

DEFERRED 的 SELECT→INSERT 在这里构成锁升级死锁，SQLite 可以直接返回 BUSY，
不调用 handler（SQLite 文档随源码 `sqlite3.c:3342-3356`）。这正是回调通知断言的作用：
**任意 SQL 返回 BUSY 后自行触发回调会把这个负例变成“已等待”，反而掩盖原 bug。**
只重试 BEGIN IMMEDIATE 也只覆盖一个新包装器，无法观察 L20b 现有完整业务调用是否先读。

### 当前可执行证据（不是 S06 的 ported 测试）

`tests/busy-capability.test.ts` 经公开 `openStartupDatabase` 使用临时文件和真实 SQLite：

- 主线程持有 IMMEDIATE + 未提交写入；不同 threadId 的 worker 独立连接尝试 IMMEDIATE，
  原生 50ms timeout 结束后返回真实 `SQLITE_BUSY / phase=execute / inTransaction=false`。
  parent 此时 COMMIT 成功，显式新一次 BEGIN 后读到 `1`，正常 close/exit 后仍可取 EXCLUSIVE。
  输出 elapsedMs 仅供诊断，**不以时长或调用未 settle 推断 handler 在途状态**。
- DEFERRED 负控：先读到 `0`，INSERT 返回 BUSY，事务仍活跃；writer COMMIT 也返回 BUSY。
  contender rollback 后 writer COMMIT 成功。另验证 close 回滚未提交写入并释放锁。

测试没有复制 tombstone schema/序号算法，没有修改 L20/L20b 测试。它验证当前真实连接的边界，
尚不能把“超时已返回”升级成“handler 内暂停”。合并 main 后的 F3 pending 0→0，L20b 该条 pending→pending。

Node job `20261105140509-cee8ea` / Electron job `20261105140509-13217d`：各 2 files / 4 passed /
0 failed / 0 skipped / exit 0，无 Errors（含 startup-database 原有 2 条）。真实 worker 返回
BUSY 的 elapsedMs 分别 71.461848 / 53.294348；并不据此认定在途通知可用。

### 请求裁定的最小原生签名与实现落点

需要 F7/架构师批准并交付 **better-sqlite3 同一 N-API 绑定的增补构建**，不换数据库驱动。
F3 随后才在 Connection → StartupDatabase → api.ts 发布以下方法；当前未发布空实现：

```ts
interface SqliteBusyHandler {
  setBusyHandler(handler: ((priorInvocations: number) => boolean) | null): void;
}
```

- native 方法注册到 `Database::Init`；用现有 `db_handle` 调
  `sqlite3_busy_handler(db_handle, callback, this)`，保持 callback 的 Napi::FunctionReference。
  callback 只能由 SQLite 在该连接的同步 exec/step 栈内触发；参数原样传递（首轮为 0）。
  返回严格 boolean，true→1 重试，false→0 使当前语句返回 SQLITE_BUSY。
- 不增加 busyCount、通用任务框架或另一个连接。回调在拥有连接的 worker JS 线程同步执行，
  不接受 Promise，不把回调异步排到被 sqlite3_step 阻塞的同一事件循环。
  历史提案曾要求退出 SQLite 栈后重抛；WP-161/164 已按 rusqlite 0.40.1 busy.rs:60 更正：
  抛错时 native 回调返回 0，清除 JS pending exception，不保存、不延后重抛；
  禁止跨 C ABI 传播异常。回调内禁止该连接上的 SQL、close、重设 handler。
- **更正旧提案**：`null` 是移除 handler、禁用等待，不是恢复默认 timeout。
  SQLite 每连接只有一个 handler，`PRAGMA busy_timeout=N` 会替换它；安装必须在 profile 后。
  需要恢复时，调用方在 SQL 返回后的 finally 显式 `exec('PRAGMA busy_timeout=5000')`
  （或恢复安装前保存的 timeout）。替换、null、close 都必须释放 native 回调引用。
- native 构建/预编译交付由 F7 负责；Node 和 Electron 都要验证，同版本所有支持桌面产物随包。
  本包不安装依赖、不编 Rust、不编原生库，也没有通过私有指针/FFI 绕过 driver。

### 取消、放行及后续验收协议

Rust 原生产函数没有前端取消点；这里的取消仅是测试握手的放弃，不新增 invoke 取消语义。
原测试 `send().is_ok() && recv().is_ok()` 在对端断开时返回 false，不能永久卡住 join。

真实 native seam 到位后的最小执行时序：

1. worker 安装上述 handler 后调用 L20b **原生产** reserve 方法；handler 通过 MessagePort
   发 waiting，并在共享 Int32Array 的 control 上 Atomics.wait（0=等待、1=放行、2=取消）。
   只有这个真实 handler 可以发 waiting，父线程 recv 仍以 Rust 的 10s 为限。
2. parent 收到 waiting 后、control 仍为 0 时 COMMIT，保存成功/错误；失败则 ROLLBACK。
   正常置 1 并 Atomics.notify，worker callback 返回 true，原调用继续，核对业务序号 `2`。
3. parent 的 finally 无论断言/COMMIT/消息错误都置 2、notify，然后等待 worker 退出。
   worker wait 使用有限上限并循环读取 control（处理提前 notify/虚假唤醒），超时/2 返回 false；
   这样 parent 消失时也能退出，不依赖 worker.terminate 强行中断 C 调用。
4. worker 的 SQL 返回后 finally rollback（如事务仍在）→ 移除 handler/恢复 timeout → close；
   parent 只在 worker 结束后删除临时文件。真实取消回归需断言 BUSY 返回、无事务/读锁残留、
   writer 仍能 COMMIT、下一连接能 EXCLUSIVE；再覆盖 handler throw/null/timeout 覆盖/close 引用释放。

**现有同步绑定没有 interrupt 或正在等待通知；AbortSignal 的 JS 事件也不能抢占同步 C 栈。**
当前测试只保证有限原生 timeout 后的回滚/close，不宣称已实现等待中取消。纯 JS catch BUSY 后
重试/计时通知改变这个屏障，须由架构师明确改变验收标准才可采用，F3 本包不自行降级。

### 当前处置

- L20b 的 `tombstone_sequence_waits_for_writer_before_reading` 保持 pending；
- 现有 `[final-sequence only; busy handshake pending]` 补充用例保留，但继续
  明确标注它不冒充 S06；
- 不引入 `setTimeout`/轮询来“证明” busy 回调，也不把 `Statement.busy` 当锁
  争用信号。

## 交接清单

| 项 | 所有者 | 需要产出 |
|---|---|---|
| S05 阶段字段 | F3-storage | **已完成**：`StorageError.phase` + `Connection` 打标 + 三条阶段测试（2026-11-04）；L20b 再映射文案 |
| S05 列类型 | L20b-sync-support | 显式字段解码与 `SyncError` 文案；如需原始列类型，向 F3 提 `iterateRaw` |
| S06 busy handler | F7-native / 架构师 | 带 `sqlite3_busy_handler` 的绑定或明确降级决定 |
| S06 测试状态 | L20b-sync-support | 原生 seam 落地前保持 pending，不删原测试意图 |
