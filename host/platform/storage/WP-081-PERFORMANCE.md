# WP-081：完整 C/D 迁移阶段测量

结论：定位完成，性能验收阻塞；没有已证明的等价主要开销优化，原 5s 未闭合，D35 open。
此文件记录测量，不将直接 runner 当成 L21 kernel 诊断验收。

## 可复跑测量

所有重命令经 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs run -- <命令>`。
源码在 `tests/migration-profile{,-hooks,-summary}.mjs` 与 `tests/migration-profile-io.c`。

1. 独立进程创建一次 active 输入（目录必须不存在）：
   `node host/platform/storage/tests/migration-profile.mjs --seed /tmp/opencode/WP081-seed-20261106`。
   seed job `20261105180111-0c7c17` exit 0。真实完整迁移；不是 Rust/A 录制数据。
2. Linux 原生 I/O 探针：
   `cc -shared -fPIC -O2 -Wall -Wextra host/platform/storage/tests/migration-profile-io.c -o /tmp/opencode/wp081-io.so -ldl`。
   build job `20261105180111-e7551c` exit 0，无编译警告；只使用现有 C 编译器/libc，未安装依赖。
3. 计量：
   `env WP081_IO_LOG=/tmp/opencode/WP081-before-node.io LD_PRELOAD=/tmp/opencode/wp081-io.so node --import ./host/platform/storage/tests/migration-profile-hooks.mjs host/platform/storage/tests/migration-profile.mjs /tmp/opencode/WP081-seed-20261106`。
   每次新进程、新冷 worker、新空 Slot C；C 完成后用原 SQLite online backup 克隆相同 seed 到 D，再执行完整 runAll。
4. Electron 用 `env ELECTRON_RUN_AS_NODE=1 ... node_modules/electron/dist/electron --import ...`。
5. 汇总（纯证据分析）：
   `node host/platform/storage/tests/migration-profile-summary.mjs JOB.log IO.tsv [BASELINE_JOB.log]`。
   比较时同时核 schema/history 名称与 checksum/canonical fingerprint、journal/synchronous、完整内部报告及业务日志顺序；
   只归一化临时根路径、内部 threadId、报告 duration、总耗时日志、可用磁盘量与新快照时间/PID。
   磁盘所需量、备份消息、级别/顺序仍逐项相等；业务错误原样比较。

`--import` 仅用于测量进程；loader 在原生产模块尾部安装 pass-through 包装，每个原方法调用一次。
F3 生产文件、SQL、事务、PRAGMA、报告和日志实现未改。没有把测量钩子接到正常 Host。
任务计时用 `process.hrtime.bigint()`，C 探针用相同的 `CLOCK_MONOTONIC`；原报告内的 duration 另存，不用它推导阶段。

- 冷 worker：父线程创建 Worker → worker preload 第一条计时；包含线程启动/初始 preload 加载。
- 加载：preload 起点 →真实 task 入口，包含模块读取、类型擦除、解析、求值、入口调度及探针安装。
  `loader.ms` 只是 nextLoad 调用本身，不等于全部加载成本；不把余量全部称为 CPU。
- 构造：task 总时长减 coordinator.runAll；含构造、定义读取及任务报告封装，不伪称纯 constructor CPU。
- 迁移执行：runRefineryMigrations（含 repair、runner/checksum）；refinery.run、COMMIT 独立列出。
- 校验：全部 MigrationVerifier + verifySchemaFingerprint；scratch SQL 重放单列。
- 原生 I/O：截获真实 fsync/fdatasync/pread64/pwrite64，保留参数、返回值与 errno；计时后才写 TSV。
  包含调用中内核/调度等待，不等于裸设备 latency，也不覆盖所有系统调用。Node fs.*Sync 另计。
- 指标存在包含关系：COMMIT 包含 fsync，校验包含 scratch；不得把嵌套指标相加。
- 原件带测量扰动且机器有其他 jobs；没有把一次样本外推为稳定 p95、最低耗时或 Rust 同机性能。

## Node 基线（生产未改）

job `20261105180542-66dab8`，exit 0，Node 26.5.0。
原件 `/home/dsdev/.oc-jobs/done/20261105180542-66dab8.log`，原生 I/O `/tmp/opencode/WP081-before-node.io`。

| 阶段（ms） | C | D |
|---|---:|---:|
| runAll worker 等待 | 6490.02 | 1964.07 |
| 冷 worker 到 preload | 243.56 | 已存在的同一 worker |
| preload → task | 826.85 | 无冷加载 |
| task 构造/封装余量 | 22.95 | 7.90 |
| coordinator.runAll | 5392.43 | 1954.32 |
| runRefineryMigrations 四库合计 | 3676.42 | 194.17 |
| refinery.run | 3354.60 | 5.28 |
| COMMIT 同步调用 | 2415.64（270次） | 0.15（8次） |
| 全部校验 | 1681.46 | 1707.38 |
| 其中 fingerprint | 1542.50 | 1455.54 |
| 其中 scratch SQL 重放 | 947.13（131条） | 1039.35（131条） |
| 原生 fsync | 2398.11（1084次） | 66.18（16次） |
| 原生 pread64 / pwrite64 | 16.47 / 48.69 | 17.84 / 0.39 |
| Node 同步 readFile | 18.44（266次） | 11.72（271次） |

C/D 加在线 clone 合计 **8666.51ms**，clone **209.29ms**。C 应用 71/8/29/23 条，D 全部 0，
四库顺序 VFS→LLM→Chat→Mistakes，8 个库 integrity_check=ok，journal=delete、synchronous=2（FULL）。
仅两个coordinator.runAll就累计7346.75ms：该样本即使完全消除冷加载、构造与clone，仍超过5000ms，
因此证据不支持“只优化worker加载即可关闭D35”。这不是对未来算法优化的不可行性证明。
按同一单调时钟区间归属，C的1036次fsync/2247.11ms在runRefineryMigrations，另外48次/151.00ms在校验；
D的16次/66.18ms均在校验。因此上表task级fsync与COMMIT不是完全相同的包围区间，不能直接相减得到CPU。

| 库 | C 执行 / 校验 | D 执行 / 校验 | C fsync |
|---|---:|---:|---:|
| vfs | 2473.56 / 1113.98 | 149.97 / 1110.22 | 1495.52（568次） |
| llm_usage | 143.54 / 96.81 | 3.95 / 35.65 | 168.14（80次） |
| chat_v2 | 612.91 / 295.72 | 17.45 / 270.79 | 450.07（240次） |
| mistakes | 446.41 / 174.95 | 22.81 / 290.73 | 284.38（196次） |

明确慢点：C 的落盘提交，C/D 的 VFS 指纹范围 scratch 重放与 schema 查询，以及约 1.07s 冷加载。
代表性 SQL：C 内存重放 `V20260523__add_missing_sync_coverage` 120.59ms、
`V20261023__question_authoring_v2` 118.90ms；D 后者 164.29ms。不是单条 SQL 的稳定排名。

## 等价优化边界

- `src-tauri/vendor/refinery-core/src/traits/sync.rs:84-99` 和 `drivers/rusqlite.rs:39-45`：
  SQL 和 history 每项各自 BEGIN/COMMIT；当前 TS refinery.ts:520-524 与原行为一致。
  合并成每迁移一个事务或 grouped=true 会改变故障可见性及持久性，不能作为本包优化。
- `coordinator.rs:4755-4768,5008-5079`：每次用内存 scratch 重放迁移再取管理范围；
  TS 的两次完整校验不是多跑了一次诊断。不能用 C 的结果代替 D 校验，也不能删重放。
- `coordinator.rs:282-428`：磁盘预检→恢复重试→备份 guard→依赖顺序→逐库迁移/验证→失败恢复；
  `commands.rs:1199-1217`：完整 C 后完整 D。禁止并行重排。
- 文件读取与 checksum 非主要成本（Node 读取分别18/12ms，createRunner分别74/24ms）；
  尚无足以支持改其语义或增加缓存的性能证据。

以下是同输入无探针对照、Electron测量和原L21复验请求；没有通过删减上述步骤制造提速。

## Electron 与无探针对照（同 seed、生产核心未改）

Electron 45.2.1 / Node 24.22.1：job `20261105180837-e11cb6` exit 0，
原件 `/home/dsdev/.oc-jobs/done/20261105180837-e11cb6.log`；I/O `/tmp/opencode/WP081-before-electron.io`。
无探针 Node 26.5.0：job `20261105180837-040b37` exit 0，原件同目录同 job `.log`。

| 阶段（ms） | Electron C | Electron D |
|---|---:|---:|
| worker 等待 | 12970.73 | 2443.13 |
| 冷 worker 到 preload / 加载到 task | 137.75 / 769.89 | 无冷加载 |
| task 构造/封装余量 | 12.64 | 14.47 |
| coordinator.runAll | 12040.88 | 2426.78 |
| runRefineryMigrations | 9646.97 | 318.15 |
| refinery.run | 9203.81 | 5.11 |
| COMMIT | 8002.09（270次） | 0.12（8次） |
| 校验 / 其中 fingerprint | 2289.95 / 2144.29 | 1960.97 / 1793.58 |
| 其中 scratch 重放 | 1336.52（131条） | 1279.96（131条） |
| 真实 fsync | 8152.14（1084次） | 129.30（16次） |
| 真实 pread64 / pwrite64 | 20.34 / 84.59 | 13.15 / 0.40 |

Electron 完整 C/D direct runner **15643.01ms**，clone226.98ms。
无探针 Node **13828.93ms**（C11494.26 / clone118.75 / D2213.16）。
无探针仍慢，证明并非必须开启测量探针才出现超5s；**不**用不同调度时刻的样本相减估算探针开销，
也不据此声称Electron运行时比Node慢。这里真实fsync本身从Node样本2398ms波动到Electron样本8152ms，
次数相同，机器并发/文件系统等待影响显著，不能把该差额当算法差异。

同输入比较：无探针 Node、带探针 Electron 分别与带探针 Node 比较，8库schema/history/checksum/
canonical fingerprint/PRAGMA/integrity、内部报告和364条业务日志的级别/顺序一致。
分析输出 `/tmp/opencode/WP081-uninstrumented-node-summary.json`、`WP081-before-electron-summary.json`。
首次日志比较返回1，仅因 available_mb 与新快照时间/PID 是实测动态量；汇总器按上面明确规则归一化后两次返回0。
原件未改，没有删除业务日志或修改L21断言。
正式jobs收据：无探针对照`20261105182658-f24fa1`、Electron对照`20261105182658-89ff15`，均exit0。

本包**无优化前后提速结论，也无优化实现提交**：没有将上述已证成本误称为冗余。
候选中的 migration-worker/worker-entry/worker-pool/connection/migration 目录对main diff为空。
测量单独提交（含自动检查点），结论/复跑收据另提交；不为完成“优化”名目改动正确的业务。

## L21 / C2 交付边界

已两次经 coord queue 请求C2组合候选与原 `host/plugins/backup/tests/migration-diagnostic.test.ts`，
按原5000ms断言复验Node/Electron。该测试在L21候选中、此时main未有；F3只读，未复制/编辑。
原WP-005完整kernel报告八段及清槽/日志断言仍是诊断验收依据。direct runner不覆盖该命令的报告排版与清槽。
F3原worker回归仍验证响应性、accepted jobs drain、错误传播、备份guard同步：
Node job `20261105175622-cc1210`、Electron job `20261105181208-64625c` 各3 passed /0 failed /0 skipped /exit0，无Errors。

官方lane-gate@0ffa29d69（main4723d8d46）5/5通过，自动目录测试`20261105181209-b6dfd4`
为49files /606passed /0failed /1既有fixture环境skip /exit0，无Errors。该门禁不包含L21原5秒红例。

后继如继续优化，应围绕已实测的同步提交和完整校验证明等价；当前源码不支持直接移除它们。
保留5s、X1 85/175/180；未运行Rust、未推断Rust同机耗时，未把“返回了完整报告”写成性能通过。
