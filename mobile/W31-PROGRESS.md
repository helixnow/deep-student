# W31 移动端运行时修复：进度

分支 `assault/W31-mobile-runtime`，起点 INT `6c491e6f`。依据 `.reports/reviews/V06-mobile-runtime.md`。
每项都先在修复前的代码上跑出红，再修到绿；红的跑法是把该文件换成 HEAD 版本跑同一个测试，再换回。

## V06 主项

| 项 | 结果 | 提交 | 测试 |
| --- | --- | --- | --- |
| V06-01 SQL 执行期错误不是 StorageError | 已修 | `da436dd6` | `mobile/tests/unit/storage-errors.differential.test.ts`（与桌面 better-sqlite3 逐条对照） |
| V06-01 附带：失败 SQL 原文打到 console | 已修 | `856bab71` | `mobile/tests/unit/sqlite-warnings.test.ts` |
| V06-02 迁移失败被吞 | 已修（同时修了 V06-L4） | `aaa2412f` | `mobile/tests/unit/startup-recovery.test.ts`（与桌面 `MigrationCoordinator` 差分 + 插件层核心恢复屏障） |
| V06-03 诊断插件进生产 Worker | 已修 | `43697f90`、`4b6ddcfd` | `mobile/tests/boot/worker-boot.test.ts`、`mobile/tests/unit/diagnostics-storage-batch.test.ts` |
| V06-04 空契约 | 已修 | `0af3bc97` | `mobile/tests/unit/contracts.test.ts`；启动测试断言产物含全部 `contracts/ipc/*.json` |
| V06-05 外壳无 Host 生命周期保护 | 已修 | `df580b28` | `mobile/tests/unit/host-supervisor.test.ts`；启动测试覆盖有序退出后调用立即失败 |
| V06-06 同一库第二条连接 | 已修 | `85da3c48` | `mobile/tests/unit/single-connection.test.ts` |
| V06-07 SAH pool 被占用即整机失败 | 已修 | `159aa5d6` | `mobile/tests/unit/sqlite-pool-retry.test.ts` |
| §5.2 去掉 Node 全局的 Worker 启动测试 | 已加 | `43697f90`、`3a04d060` | `mobile/tests/boot/worker-boot.test.ts`（要构建，经 `bin/heavy` 跑） |

### 与评审建议不同的决定

- V06-02：评审建议让 `startupMigrationFailure()` 非空。Rust（`lib.rs:1098-1141`）和桌面都把单库迁移失败当作带 warnings 的成功报告：
  受阻库进入组件健康的 blocked，vfs/mistakes 受阻时进入核心恢复屏障；`startupMigrationFailure` 只用于全局失败（快照、日志、磁盘预检），
  移动端没有这些来源，所以保持 null。迁移状态事件 `data-governance-migration-status` 的载荷与桌面逐字段相同。
- V06-03：诊断插件只在开发服务器和 `vite build --mode diagnostics` 中装载；Playwright 的 webServer 改用 diagnostics 模式（用例经 `mobileDiagnostics` 驱动 Host）。
  `storageBatch` 改在同表结构的临时库上跑，e2e 期望值不变。`tempSessionRoundTrip` 仍写真实 temp_sessions（后续 `readTempSession` 依赖它），只在开发/诊断构建中存在。
- V06-05：常量与桌面 `electron/shell/host.ts` 相同（就绪 `STARTUP_READY_WAIT` 120 s、60 s 内最多重启 3 次、fatal 宽限 5 s、有序退出 5 s；r2 随桌面 W06 `e5728fbd` 改为 8 s），测试读桌面源码比对。
  `READY_TIMEOUT_MS` 写成字面量而不是导入 `electron/api.ts`：后者带桌面的 cordis 类型扩充，在移动端 tsconfig 下会破坏 `Context` 类型。
- V06-07：重试间隔 `[100, 200, 400, 800, 1600, 3200, 3200]` ms（共 9.5 s），依据 S2 spike 的 10 s 轮询窗口和 V06 建议的 10–15 s。
  用尽后不让 Host 启动失败：每个库按桌面“库被锁住”的错误（`SQLITE_BUSY database is locked`）打开失败，Host 进入核心恢复屏障，原因经迁移状态事件给前端。

## 低级项

| 项 | 结果 |
| --- | --- |
| V06-L1 `node-globals.ts` / `buffer` 无用 | W14 正在删除（`5b7b93d0`，未进 INT）；本 lane 按分工不动这两个文件 |
| V06-L2 `serveHost` 没传 `platform: 'mobile'` | 已修 `3a04d060` |
| V06-L3 生产不调用 `persist()` | 已修 `0b87173a`（主线程启动时申请；真机回收策略仍需设备验证） |
| V06-L4 迁移永久关闭已持有句柄 | 已修 `aaa2412f`（迁移时只断开连接，同一对象重开） |
| V06-L5 数值绑定差异 | 不改：移动端与 Rust 一致（整数按 INTEGER 绑定），差异在桌面 better-sqlite3 一侧，交 W07 |
| V06-L6 BLOB / 大 rowid 读值类型 | 不改：移动端 `Uint8Array` / bigint 是可移植的一侧；桌面 `Buffer` / 丢精度 number 交 W07，插件侧假设交 V08 |
| V06-L7 前端接入前置缺口 | 未做：`main.ts` 仍是验证页，无用户影响；`osName`、`protocol` 请求、`onShellRequest` 要随 React 前端接入一起定（W14/W06） |
| V06-L8 非安全上下文无 `crypto.subtle` | 未做：`host/platform/crypto/web.ts:77` 不在本 lane 路径；只影响开发期 http 局域网调试，交 W14 |
| V06-L9 AJV `new Function` 与 CSP | 未做：目前 `index.html` 与 Capacitor 配置都没有 CSP，Host 能编译契约（启动测试验证）。加 CSP 时必须允许 `'unsafe-eval'` 或改用 AJV standalone 预编译校验器 |
| V06-L10 `source` 不是模块 URL | 已修 `3a04d060`（Worker 安装不带 `source`，UI 清单 v2 为 builtin） |

## 交接

- W14 `host/platform/storage-mobile/migrations.ts:89-90`（INT `6c491e6f` 行号）：SQL 失败时报告的是原始错误消息，
  缺桌面 `host/platform/storage/migration/errors.ts:21,29` 的 `Refinery error: …` / `Verification failed for migration N: …` 前缀，
  所以迁移 SQL 失败时的受阻原因文本与桌面不同（打开失败的文本已一致）。本 lane 按分工没有改这个文件。
- storage API 文档（`host/platform/storage/api.ts:505` `openFile`）：移动端对已登记库路径返回共享同一连接的句柄、对同一非登记文件重复打开抛 BUSY（V06-06），桌面没有这条限制。
- 移动端没有 ACL（`mobile/src/worker/host-worker.ts` 的 `serveHost` 不传 `acl`，`host/kernel/serve.ts:29`）：生产构建里已没有 remote 方法，接入前端业务命令前需要决定移动端的能力清单。

## 第二轮（r2，起点 INT `390f244b`，合并提交 `1444fc4a`）

### 任务结论

| 任务 | 结果 | 提交 | 测试 |
| --- | --- | --- | --- |
| 合并后真实 Chromium e2e | 第一次 7 过 1 败，失败不在本 lane 路径（见下）；合并 INT `2be7ed80`（带进 W14 修复）后第二次 8/8 | — | `bin/heavy npx playwright test`（`wt/W31/mobile`） |
| W06 交接：Android 平台标识 | 已做：`osName` 取 `Capacitor.getPlatform()`（android / ios，web 仍为 linux） | `71395712` | `mobile/tests/unit/platform.test.ts` |
| 移动端命令 ACL | 已做：清单 + Worker 接入；kernel 部分交 W01 | `9bcba7b2` | `mobile/tests/unit/command-acl.test.ts`、启动测试 ACL 夹具 |
| V06-L9 AJV 预编译 | 不能在本 lane 路径内闭环，写了设计（见下）；启动测试锁定产物里仅有的两处运行时代码生成 | `9bcba7b2` | `worker-boot.test.ts` “generates code at run time only …” |
| V06-L5 / L6 | W07 已在 `0bbcb15a`（未进 INT）修了桌面一侧：整数按 INTEGER 绑定、超过 2^53 的 rowid 返回 bigint | — | W07 `host/platform/storage/tests/integer-parity.test.ts` |
| V06-L7 | 随前端接入再定（`osName` 一项本轮已做） | — | — |
| V06-L8 | 写交接（`host/platform/crypto/web.ts:77`） | — | — |
| 事务语义对拍 | 已加：同一脚本在移动端与桌面跑，结果与错误形状逐条相等 | `77f85984` | `mobile/tests/unit/storage-transactions.differential.test.ts` |
| R02 备注：启动测试探针缺 `caller` | 已补；同时断言生产 Worker 启动、调用、退出全程 Host logger 没有 warn / error | `4a5dd9d9` | `worker-boot.test.ts` |
| Node 内建模块进 Worker 的入口 | 启动测试按模块图锁定导入 shim 的模块（kernel 的 acl / connection / contracts / profile）；`vite.config.ts` 注释里过时的 `runtime.ts` 已更正 | `b71b496c` | `worker-boot.test.ts` |
| Host 生命周期补强 | 外壳 + supervisor + 真实 Host 会话（本线程假 Worker）：就绪前的 invoke 就绪后回复、有序退出中止进行中命令并清理插件、启动 fatal 后重启；supervisor 补关停超时、messageerror、已替换 Worker 的迟到事件、关停中崩溃、worker-loaded | `f26ef352` | `mobile/tests/unit/host-lifecycle.test.ts`、`host-supervisor.test.ts` |
| 合并 INT `2be7ed80` 后的对齐 | 桌面关停预算改为 8 s（W06 `e5728fbd`：大于 Host 等后台任务的 5 s），移动端 `SHUTDOWN_TIMEOUT_MS` 跟随；对照测试按桌面新常量读取 | `ea6b1c22` | `host-supervisor.test.ts` “uses the desktop supervisor values” |
| Worker 退出报告改走 Host 端口 | 原来 Host 的 fatal 走端口、退出报告走 Worker 自身 `postMessage`，两条通道没有先后保证：退出报告先到时 supervisor 断开端口，fatal 的日志和退出原因里的 fatal 文案都丢了（目录级单测负载下 `host-lifecycle` fatal 用例因此失败）。现在 `mobile/src/worker/exit-report.ts` 把 kernel 的 `close()` 推迟到 `exit(code)`，在同一端口上先发 `dstu-worker-exit` 再关端口，外壳收到后通知 supervisor | `d5012b05` | `exit-report.test.ts`、`host-supervisor.test.ts` “an exit reported right after the fatal …”、`host-lifecycle.test.ts`、启动测试（退出码经端口记录） |
| 参数绑定对拍 + 瘦身 | `MobileConnection.bind` 改用共用的 `forEachBinding`（删掉复制的校验）；新差分测试在改动前后都绿 | `05446f68` | `mobile/tests/unit/storage-params.differential.test.ts` |

迁移状态事件载荷：移动端 `storage-mobile/startup.ts` 的 `migrationStatusPayload` 与桌面 backup 插件 `governance.ts:310` + `startup-events.ts:52` 逐项对过
（`global_version` 两边都是未阻断库的最大版本，警告去重规则相同）；桌面一侧绑在 `Governance`（迁移 worker 线程、按文件聚合 registry）上，
做插件级差分成本过高，现有覆盖是协调器级报告 + 组件健康逐字段差分（`startup-recovery.test.ts`）加两边同一公式断言。

可继续的瘦身（不在本 lane 路径）：`storage-mobile/database.ts` 的 `Scope` / `runSyncCallbacks` / `AsyncTx` 与桌面 `host/platform/storage/database.ts` 同构，
可抽成两边共用的可移植模块；`storage-transactions.differential.test.ts` 可作回归保护。

e2e 唯一失败：`host-e2e.spec.ts:43` 冷启动 `mistakes sqlite_master` 比桌面基准少 `pending_memory_candidates` 表和 3 个索引。
INT 带进了 W14 `aebcc2df`（桌面迁移协调器在 mistakes 校验后跑 `ensurePendingMemoryCandidatesSchema`，桌面基准因此有这张表），
移动端 runner `host/platform/storage-mobile/migrations.ts`（W14 路径）还没跟上。W14 已在 `68567604` 修好，经 INT `c250bf14` 进入 `2be7ed80`；合并后 e2e 8/8，本 lane 未改该文件。

### 命令 ACL 方案

- 清单 `mobile/src/worker/command-acl.ts`：把 Rust `src-tauri/capabilities/mobile.json` 的应用命令部分写成 kernel 的 `Capability` 数据
  （identifier `mobile`、`main` 窗口、只对本地页面、权限 `allow-application-commands`），交给 kernel 自己的 `CapabilityAcl` 判定，拒绝文案与桌面一致。
  插件权限（`core:*`、`fs:*` 等）归外壳，不在这里。
- 命令表按插件列：只列移动端实际装配的插件（外壳绑定 + `host/profiles/mobile.json`），每个插件只列 `meta.commands` 中、且在 Rust
  `allow-application-commands` 里的命令。当前五个插件都没有这样的命令，所以表是空的：注册了但不在表里的命令一律拒绝（fail closed）。
- `platforms: null`：Host 协议的 `platform` 只有 darwin / win32 / linux，移动端握手是 linux；`CapabilityAcl` 的目标映射（`host/kernel/acl.ts:172`）没有 android / iOS，
  写成 Rust 的 `["android", "iOS"]` 这条 capability 就永远不生效。清单只打进移动端 Worker，不影响桌面。
- 接入：`host-worker.ts` 的 `serveHost` 传 `acl: app => mobileCommandAcl(app.platform)`。
- 守护：单测核对清单 = Rust capability 的应用命令部分、键 = 移动端插件、每项 = `meta.commands` ∩ Rust 允许表且都有契约；判定经 `createTestHost` 与
  `MobileShell → MessagePort → serveImportedHost` 两条路径；启动测试用夹具 profile（多一个注册 `get_setting` 的插件）按生产模式打包，
  未接入前回复 `{ ok: true, body: 'fixture-value' }`（红），接入后为 `Command get_setting not allowed by ACL`。
- 前端业务插件进入移动端 profile 时：给对应插件的条目加命令，单测会要求它同时在 `meta.commands`、Rust 允许表和契约里。

### V06-L9 设计（未实现，需要 kernel 改动）

产品 Worker 里运行时生成代码的只有两处（启动测试锁定）：`ajv/dist/compile/index.js` 的 `new Function` 和 `@deepseek-ai/schemastery` 反序列化字符串 callback 时的
`new Function`（在 try 里，移动端不走）。Ajv 不能只在 `mobile/src/worker/contracts.ts` 一侧换掉，原因：

1. `host/kernel/contract-set.ts:65` 在模块求值时就 `new Ajv2020().compile(...)` 契约文件 schema，Worker 一加载就要 `new Function`；
2. `ContractSet`（`contract-set.ts:139-161`）开 `validateSchema: true`，按命令惰性 `compile`（`:224`、`:245`、`:298`），
   exact 模式还有带 `validate` 回调的自定义关键字（`:151-152`），Ajv standalone 不能序列化这种关键字；
3. `host/kernel/manifest.ts:115` 也用 Ajv 编译 manifest schema。

需要 W01 提供的钩子：契约文件校验改为惰性（或对构建期已校验的包跳过）；`ContractSet` 接受注入的预编译校验器表（按 `file#command/args|result|error` 取）；
exact 关键字改成 Ajv 代码生成关键字（`code` 而不是 `validate`）或在预编译路径外单独处理；`manifest.ts` 同样可注入。
移动端一侧随后做：构建期用 `ajv/dist/standalone` 只预编译 ACL 放行命令的契约（ACL 检查在 `checkArgs` 之前，表外命令根本不会校验；当前为 0 条），
启动测试把 “只有两处” 收紧为 “没有 Ajv”。另：加 CSP 时 SQLite WASM 仍需 `'wasm-unsafe-eval'`；页面 meta CSP 对用 URL 加载的专用 Worker 是否生效在 WebKit 上未验证。

### 交接（r2）

- W01 `host/kernel/acl.ts:4-6,15,189-223`：文件读取（`node:fs` / `node:path` / `node:url`、`TAURI_DIR`、`fromDirectory`）拆到只给 Node 用的模块，
  让 `acl.ts` 可移植（移动端 Worker 现在经 shim 带上这三个 Node 模块）。调用点 `host/kernel/main.ts:75`、`host/kernel/bench/startup-profile.ts:50`、
  `host/e2e/coverage/agent-tool-coverage.test.ts:50`、`host/kernel/tests/file-decoding.test.ts:19`、`host/kernel/API.md:658`。
  验证：移动端启动测试 “Node built-ins reach the Worker only through …” 的期望表去掉 `host/kernel/acl.ts` 一条后通过（产物里 acl.ts 不再导入 shim），其余启动测试保持通过。
- W01 `host/kernel/acl.ts:172` + Host 协议 `platform`：增加 android / ios 后，目标映射加 `android: 'android'`、`ios: 'iOS'`，
  移动端清单的 `platforms` 即可写成 Rust 的 `["android", "iOS"]`。
- W01 L9 钩子：见上节。
- W23 `electron/shell/bridge-messages.ts:221`：`BridgeInit.osName` 加 `'android' | 'ios'`；之后去掉 `mobile/src/shell/platform.ts` 里的类型断言。
- W06 `electron/preload/bridge.ts:44`：`convertFileSrc` 的条件改为 `osName === 'windows' || osName === 'android'`（Tauri core.js 同款），
  验证：`installTauriBridge(transport, mobileBridgeInit('android'))` 后 `convertFileSrc('/a b.png')` 为 `https://asset.localhost/%2Fa%20b.png`。
- `host/platform/crypto/web.ts:77`（V06-L8）：创建时检查 `crypto.subtle` 与 `randomUUID`，缺失就抛出说明“需要安全上下文”的错误，而不是首次 digest 时的 TypeError；
  验证：`createWebCrypto({ crypto: { getRandomValues: a => a } })` 立即抛错。
- W08 / W30 移动端自动备份（W30 报告交接 2）：需要 `host/profiles/mobile.json`（W14）加备份插件，且 `host/platform/settings/backup-config.ts` 先有移动端实现，本 lane 路径内做不了。

## 第三轮（r3，起点 `628b9fdf`，合 INT `1d1fdb78` 于 `3144692e`、`065a68f3` 于 `20dd72d3`）

### 任务结论

| 任务 | 结果 | 提交 | 测试 |
| --- | --- | --- | --- |
| storage-mobile 卸载后静默重开（W07 交来，V09 P2-1） | 已修：插件卸载走 `unload()`（先跑 `beforeShutdown` 收尾，再终态 `shutdown()`）；之后 `database` / `openFile` / `migrations.*` / 批处理抛 `TX_CLOSED: Storage service is disposed`；裸实例 `dispose()` 仍可重开 | `9a178c0c` | `mobile/tests/unit/storage-dispose.test.ts`（修前 4/4 红） |
| 卸载语义与桌面差分 | 已提交：INT `1d1fdb78` 含 W07 `027ea23c` / `11017a6d`，合入后对真实桌面实现 2/2 绿（修前移动端 2/2 红） | `6e3b5df3` | `mobile/tests/unit/storage-dispose.differential.test.ts` |
| V07 P3-1 移动端 schema 指纹（我的部分） | 已做：`MobileConnection` 对 `:memory:` 接受 `journal_mode=memory`（原来直接抛 `journal_mode=WAL was not accepted`）；`SqliteRuntime.openMemory()`（不占 pool 槽位，pool 被锁时也可用）；`MobileStorageService.openScratch()`。`capabilities.ts:30` 等 W14 落地后随补丁 B 翻 `supported` | `0ccf194e` | `schema-fingerprint.differential.test.ts`（8 条：移动端迁出的库指纹 = 桌面协调器写下的行；WASM scratch 的 scope 与 schema = 桌面）；`sqlite-pool-retry.test.ts` 新增 scratch 用例 |
| V07 P3-1（W14 的部分） | 交接补丁 A（W14 文件）+ B（W31 文件，同一提交）：`.reports/W31-handoffs/W14-P3-1-mobile-schema-fingerprint.{md,A.patch,B-W31-files.patch}`。本机打上后：相关单测 92/92、对拍 12/12、boot 6/6、host tsc 0 错、移动端 e2e 8/8（冷启动 schema 与桌面 golden 全等）；已还原 | — | 见交接文档 |
| Worker 包体与启动 | 测量见下；零行为变化优化：契约 JSON 构建期去空白 | `79605844` | `compact-contracts.test.ts`（3 条）；boot 6/6 |
| V06-L8 WebCrypto 创建时检查（本轮临时归属） | 已做：缺 `subtle` / `getRandomValues` / `randomUUID` 时创建即抛 `WebCrypto is unavailable (missing …): … secure context …`；移动端 crypto 插件安装失败带这个原因 | `1ecd1929` | `host/platform/crypto/tests/web-availability.test.ts`（修前 4/5 红）；调用方 8 个测试文件 44/44 |
| finalizer 委托（AL-07） | 已做（INT `065a68f3` 带进 W10 `5f4df9a8` / `b6693579`）：`registerFinalizer` / `finalizerNames` / `runStartupFinalizers` 委托桌面同一个 `StartupFinalizerRegistry`，返回 disposer，认 `late` / `signal`；`late: 'run'` 异步失败经 `onLateError` 记 error 日志（Worker 里的未处理拒绝到不了外壳）。修前与桌面的差异：错误文案、不认 `late` / `signal`、无 disposer、整轮完成后再跑返回 `skipped` = 全部、插件卸载不注销钩子（重装抛 `FINALIZER_DUPLICATE`）。桌面包装层仍丢弃 disposer（W07 补丁未落地，AL-15），移动端已按接口返回 | `7afe77fa` | `startup-finalizers.differential.test.ts`（5 条，修前 5/5 红：与桌面 `StorageServiceImpl` 逐步对拍、disposer 对拍桌面 registry、异步失败记日志、插件卸载/重装） |
| `main.ts` hostCall 带 caller（W17 交来） | 早已带：W14 `cfdd082a`（已在 INT）传 `dstu.mobile.diagnostics`；W01 的答复（`.reports/W01-handoffs/K2-caller-require.md` 第 2 节）就是这个 id。本轮把 id 收成一个常量（`mobile/src/diagnostics-id.ts`），`hostCall` 加可选 `caller` 参数 | `e18b6894` | `mobile/tests/unit/diagnostics-caller.test.ts`（require 模式） |

### Worker 包体与启动（`79605844` 前后，本机，负载高）

- 生产构建（`mobile/vite.config.ts`，压缩后）`host-worker-*.js` 3 497 871 B（gzip 438 110 / br 337 835），另有 `sqlite3.wasm` 868 907 B（gzip 402 022）。
- Worker 包的主要组成（按 sourcemap 归属压缩后字节）：IPC 契约原文约 2.3 MB（L13 393 KB、L14 283 KB、L04 259 KB……），
  `@sqlite.org/sqlite-wasm` 胶水 222 KB，迁移 SQL 约 330 KB（vfs 201 KB；不能动，refinery checksum 按原文），ajv 118 KB，`host/platform/storage` 65 KB。
- 优化：契约 JSON 构建期去空白（`compactContracts()`），解析结果不变（单测逐文件比对 + 两份 `ContractSet` 全等）。
  boot 测试的生产包（未压缩）3 790 288 → 2 521 204 B；gzip 约少 25 KB；契约原文是模块级常量，Worker 堆里常驻的字符串约少 1.48 MB（6 个文件含中文，按双字节计）。
- 启动：boot runner 在 Node 中的 `readyMs`（WASM 初始化 + 握手 + 新库迁移）前 494–537 ms、后 541–565 ms，在噪声内，没有可测的启动收益；
  启动主要耗时在 WASM 初始化、迁移和 Ajv 编译，不在包体解析。P3-1 落地后每次启动多一次 scratch 回放（约 350–530 ms，见 W14 交接“代价”节）。

### 交接（r3）

- W14：P3-1 补丁 A + B（见上表与 `.reports/W31-handoffs/W14-P3-1-mobile-schema-fingerprint.md`）。
- W07：`.reports/W31-handoffs/W07-storage-dispose-busy-and-tx-scope.md`：
  - 桌面 `dispose()` 遇到进行中的异步事务抛 BUSY 并泄漏其余连接（本机复现）；移动端记 warn 关其余连接，但带事务的那条连接没关。建议统一为“卸载强制回滚 + 全部关闭”，W07 定语义后 W31 跟随并补差分。
  - Scope / runSyncCallbacks / AsyncTx 抽到 `host/platform/storage/tx-scope.ts` 的设计（两边只差三处）。
- W14 / 合并代理：AUDIT-TO-LANES 让 W14 在 `diagnostics-storage-batch.test.ts:48` 加 `caller: 'dstu.mobile.diagnostics'`；W31 `e18b6894` 已改成 `caller: MOBILE_DIAGNOSTICS_PLUGIN_ID`（同值）。
  INT `065a68f3` 带来字面量版本，合入 `20dd72d3` 时冲突，按同值保留常量。

### 待办（INT 前进后）

- W14 落地 P3-1：确认 `capabilities.ts:30`、`service.ts` 调用点与指纹行对拍已随补丁 B 进来。
- W07 定卸载遇异步事务的语义：移动端跟随，`storage-dispose.differential.test.ts` 加一步。
- W07 落地 `tx-scope.ts`：删 `storage-mobile/database.ts` 的副本改为导入。
- W07 让桌面包装层返回 disposer（AL-15）后：`startup-finalizers.differential.test.ts` 的生命周期脚本可以连返回值一起对拍。
- W14 给 `api.ts` 的 `StartupFinalizerOptions` 加 `late` / `signal`、`registerFinalizer` 返回 `() => void` 后：移动端签名已一致，无需再改。
- W10 `5439f6f2`（执行中被卸载又以 `late: 'run'` 重注册）进 INT 后移动端自动带上，`startup-finalizers.differential.test.ts` 可加一步。

## 测试与运行

- 单元 / 差分：从仓库根目录 `DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c mobile/vitest.config.ts tests/unit/<file>`。
- 启动测试：`bin/heavy npx vitest run -c mobile/vitest.config.ts tests/boot/worker-boot.test.ts`。
  它用 `mobile/vite.config.ts` 导出的插件与 Node shim 按生产模式打包 Worker（只把 `@sqlite.org/sqlite-wasm` 换成注入的 Node 版模块），
  断言闭包，再在独立 Node 进程里删掉 `process`、`Buffer`、`setImmediate`、`clearImmediate`、`global` 后启动产物，经 `MobileShell` 握手、迁移、调用、有序退出。
