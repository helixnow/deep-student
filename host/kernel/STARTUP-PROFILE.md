# Host 启动剖析（W01，2026-11-07）

起点：W12 的 Electron 实测（`host/e2e/smoke/__tests__/golden/09-perf-baseline.spec.ts`）Host ready 3.65 s（fork 后约 2.9 s）。
本文件给出 Host 进程内部的分解、热点与已做的内核侧优化。

## 怎么测

- 内核自带计时（`host/kernel/startup-timing.ts`）：`serveHost` 记录阶段标记，`importProfile` 记录每个插件模块的
  导入耗时，`installIsolated` 记录每个插件的 `apply`（含启动校验）耗时。HostReady 时写一行 info 日志
  `startup: ready at …ms after process start (…); slowest apply: …`（`dstu_host::host`，落盘到主日志），
  真实 Electron 启动也能直接看到。时间原点是进程启动。
- 剖析脚本：`node host/kernel/bench/startup-profile.ts --runs=5 [--no-compile-cache] [--json=<file>]`。
  每次测量是一个独立 Node 子进程，用生产 `serveHost`（与 `main.ts` 相同的 ACL、契约、官方桌面 profile），
  经内存传输立即握手，到 HostReady 为止。cold = 每次全新数据目录（首次启动：建库、迁移）；warm = 同一数据目录
  （日常启动）。没有 fork / IPC 往返，所以“handshake”阶段 ≈ Node 启动 + 加载内核静态模块图。
- CPU 剖析：`node --cpu-prof host/kernel/bench/startup-profile.ts --child=<dataDir>`。

环境：Apple M5 Pro，Node v26.5.0（Electron 的 utilityProcess 是 Node 24.22），42 个插件全部装载、0 个 degraded、
启动期间没有 shell 请求，Host RSS ≈ 290–300 MB。**测量时整机负载很高（load average ≈ 28，其他 lane 在跑测试），
绝对值偏大且有噪声**；同一时段内的 A/B 对比才有意义。

## 数据（每组 5 次，中位数，ms）

阶段时刻（距进程启动）与相邻阶段间隔：

| 阶段 | warm 无缓存 | warm 编译缓存 | cold 无缓存 | cold 编译缓存 |
|---|---:|---:|---:|---:|
| handshake（Node 启动 + 内核模块） | 228 | 185 | 266 | 232 |
| contracts loaded（读取并编译 `contracts/ipc`） | +179 | +173 | +181 | +148 |
| runtime created / profile resolved | +15 | +14 | +24 | +14 |
| **modules imported**（42 个插件模块的动态导入） | **+3994** | **+2601** | **+4174** | **+2441** |
| **plugins installed**（全部 `apply`） | +690 | +616 | +1638 | +1391 |
| finalizers done（`storage.runStartupFinalizers`） | +36 | +14 | +22 | +20 |
| **ready** | **5032** | **3588** | **6531** | **5046** |

负载较低时（同一台机器，早些时候单次测量）warm ready ≈ 3.2 s、cold ≈ 3.6 s（无缓存），与 W12 的 3.65 s 一致。

导入耗时最高的插件模块（warm，编译缓存 / 无缓存）。ESM 模块图只求值一次，**先导入的插件承担共享依赖的成本**，
所以这是“增量”耗时：

| 插件 | 缓存 | 无缓存 |
|---|---:|---:|
| `dstu.agent-orchestration`（第一个拉起 chat / agent 依赖栈的条目） | 576 | 527 |
| `dstu.notes` | 230 | 318 |
| `dstu.anki` | 186 | 291 |
| `dstu.vector`（静态导入 `@lancedb/lancedb` + `apache-arrow`） | 183 | 255 |
| `dstu.media` | 144 | 232 |
| `dstu.sync` | 121 | 149 |
| `dstu.qbank` | 94 | 189 |
| `dstu.platform.http` | 75 | 84 |
| `dstu.chat-pipeline` | 67 | 143 |
| `dstu.vfs-repos` | 62 | 99 |

`apply` 耗时：`dstu.platform.storage` 一家独大（warm 483–572，cold 1229–1414）；其余插件都在 20 ms 以下
（`dstu.shell` 16、`dstu.vfs-repos` cold 18–82、`dstu.chat` 9、`dstu.vfs-handlers` 8……）。

CPU 剖析（warm、无缓存，总采样 3.55 s）：TypeScript 类型剥离（Node 内置 amaro，WASM）≈ 840 ms；V8 编译
`compileSourceTextModule` ≈ 400 ms；读取源文件 / 打开文件 / `package.json` 解析与模块解析 ≈ 900 ms（高负载下 `open`
本身 ≈ 420–575 ms）；`node_modules` 顶层求值 ≈ 380 ms；业务代码自身 ≈ 235 ms；GC ≈ 70 ms。
开启编译缓存后类型剥离降到 ≈ 320 ms，WASM 剥离器从剖析里消失（缓存命中）。

## 前 10 个热点

| # | 热点 | 耗时（warm） | 归属 | 处理 |
|---|---|---:|---|---|
| 1 | 插件模块的 TS 类型剥离 + V8 编译 | ≈ 1.2 s | 内核（加载方式） | **已做**：Host 入口启用 Node 编译缓存，模块导入 −35%（3994 → 2601 ms），ready −29% |
| 2 | 模块文件 I/O 与解析（open / read / stat / package.json） | ≈ 0.9 s | 内核（加载方式） | 建议：打包时把 Host 预编译成少量 JS 产物（esbuild/rolldown），见下文“建议” |
| 3 | `dstu.platform.storage` apply：迁移校验 | 370–570 ms（cold 0.85–1.4 s） | W07 | 交接，见下 |
| 4 | `dstu.agent-orchestration` 导入（chat/agent 依赖栈首次加载） | 530–580 ms | 各插件 | 交接：按需导入大依赖 |
| 5 | `@lancedb/lancedb` + `apache-arrow` 静态导入（`host/platform/vector/service.ts`） | 单独导入 ≈ 200 + 220 ms | vector 负责 lane | 交接：首次使用向量库时再动态导入 |
| 6 | `@aws-sdk/client-s3` 静态导入（`host/plugins/sync-providers/index.ts:35` → `src/s3.ts:41`） | 单独导入 ≈ 180 ms | sync-providers 负责 lane | 交接：只在配置了 S3 时动态导入 |
| 7 | `dstu.notes` / `dstu.anki` / `dstu.media` / `dstu.qbank` 导入 | 各 95–230 ms | 各插件 | 交接：命令实现按需导入 |
| 8 | 契约加载（3.1 MB JSON，两套 Ajv 的 `$ref` 解析 + 元模式校验 + `exactSchema`） | 130–180 ms | 内核 | 未改：分散在多处，见“考虑过但没做” |
| 9 | 内核静态模块图（Cordis、Ajv 导入 ≈ 67 ms 等）+ Node 启动 | 185–230 ms | 内核 | 编译缓存已覆盖动态部分；静态部分见建议 |
| 10 | 开发态 `electron/build-info.ts` 每次启动 `execFileSync('git', …)` | 每次数十 ms（仅开发态） | W06 | 交接：打包产物读 `electron/.build/version.json` 不受影响 |

## 已做的内核优化

1. **编译缓存**（`host/kernel/compile-cache.ts`，`main.ts` 第一个 import）：`module.enableCompileCache()`，缓存目录
   `<os.tmpdir()>/node-compile-cache`（约 35 MB），按文件内容哈希 + Node 版本自动失效；HostReady 5 s 后
   `module.flushCompileCache()` 写盘（Electron 可能直接结束 Host，不能只靠正常退出时写盘）。不改变模块加载顺序与
   求值语义；`NODE_DISABLE_COMPILE_CACHE=1` 关闭；启用或写盘失败时静默退化为不缓存。
   - 效果（同一时段 A/B，各 5 次中位数）：warm ready 5032 → 3588 ms（−29%），cold 6531 → 5046 ms（−23%；
     第一次 cold 运行缓存为空）。
   - 注意：Electron 内置 Node 24.22 的编译缓存是否也缓存“类型剥离结果”取决于该版本；V8 代码缓存部分一定生效。
     打包后的实际收益需要 W12 在 Electron 里复测（`09-perf-baseline`）。
   - W12 在 Electron 里复测后：冷启动（缓存为空）慢 0.2–0.5 s、多约 27 MB 原生内存，热启动快约 0.3 s。主代理
     2026-11-07 决定保留，取舍与堆收缩评估见 `API.md` §10“编译缓存”。
2. **启动计时**（不是优化，是持续观测）：每次启动在主日志里留一行分解，回归时能直接定位到阶段和插件。

## 考虑过但没做

- **并行导入 profile 模块**（`Promise.all(import(...))`）：会改变各插件模块图的求值先后。现在每个模块单独导入都能
  成功（`tests/plugin-isolation.runtime.test.ts`），但并行导入属于装载语义变化，而且瓶颈是主线程 CPU（剥离、编译、
  求值），并行 I/O 收益有限。不做。
- **契约加载**：A/B 实测跳过 `exactAjv.addSchema` 的重复元模式校验没有可测收益（8 次交替测量中位数无差别），已撤回。
  剩余成本分散在 Ajv `$ref` 解析、元模式校验、`exactSchema` 转换和 JSON 解析；要明显减少只能惰性编译，
  会把“契约无效”从启动失败推迟到首次调用，属于语义变化。不做。
- **插件内部热点**（存储迁移校验、大依赖静态导入）：不在内核路径内，写成交接。

## 交接

- **W07（`host/platform/storage/**`）**：存储 `apply` 是唯一显著的 apply 热点。CPU 剖析（warm）：
  `migration/coordinator.ts:96 runAll` ≈ 520 ms，其中 `verifyMigrations`（`coordinator.ts:450`）→
  `fingerprint.ts:448 verifySchemaFingerprint` → `fingerprint.ts:126 buildMigrationScratch` ≈ 175–225 ms：
  **每次启动都把全部迁移在临时库里重放一遍来计算期望指纹**，可以按“迁移文件集合哈希”缓存期望指纹；
  `coordinator.ts:83/481 pendingMigrationsCount`（经 `backup.ts:525 maybeBackupCoreDatabasesBeforeMigration`）
  再单独打开一遍数据库 ≈ 95 ms；`refinery.ts:266 loadSqlMigrations` 读取迁移 SQL ≈ 77 ms。
- **vector 负责 lane**：`host/platform/vector/service.ts` 顶层静态导入 `@lancedb/lancedb` 与 `apache-arrow`，
  改为首次打开向量表时动态导入。
- **sync-providers 负责 lane**：`host/plugins/sync-providers/index.ts:35` 静态导入 `src/s3.ts`（顶层导入
  `@aws-sdk/client-s3`），改为创建 S3 存储时动态导入。
- **chat / agent 相关 lane**：`dstu.agent-orchestration` 是第一个拉起 chat/agent 依赖栈的条目（≈ 0.55 s），
  各插件把只在命令里用到的大模块改为命令内 `await import()`。
- **W06（打包）**：考虑把 Host 预编译为 JS 产物（去掉运行时类型剥离和大部分文件解析）；`electron/build-info.ts`
  开发态每次启动跑 `git`。
- **W12**：在 Electron 里复测 `09-perf-baseline`，确认编译缓存在 Node 24.22 下的收益（第二次启动起生效）。

## 复现

```sh
node host/kernel/bench/startup-profile.ts --runs=5 --no-compile-cache --json=/tmp/nocache.json
node host/kernel/bench/startup-profile.ts --runs=5 --json=/tmp/cache.json
```
