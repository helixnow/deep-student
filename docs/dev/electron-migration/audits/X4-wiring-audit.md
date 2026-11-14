# X4 插件孤岛与服务接线审计

## WP-C2-RUN-012：固定 e120 全测第 2/5 片 raw exit 1 归因（2026-11-06）

结论：**原原因未定，当前固定复验通过。** 原第 2/5 片 raw exit 1 记为"未归因的工具残差"，**不签全绿**，也不改写第一次的 raw 1。第 2、5 片在 e120 上各有一次有效复验，都是 dot+json 双 reporter，结果都是 raw 0，没有 Errors 段，入选文件集合与原件逐行相同。复验不重现，所以不派任何业务 owner。

- 原件里没有错误原文：两片 log 中 `Unhandled|Uncaught|error|originated|Worker exited|timed out|ERR_|Killed|heap` 计数均为 0，JSON 都是 167 文件全 passed、`failureMessages` 全空、`success=true`。形态与 RUN-008 相同（json-only reporter 不输出 errorsSet），机制直接引用 RUN-008，本包没有再造 probe。
- 本包一共跑了 3 次复验作业，下文全部列出。其中第 5 片第一次尝试 `20261105185406-4f6287` 环境无效：隔离树用 `git archive` 展开，没有 `.git`。`electron/build-info.ts:18-28` 在缺少 `electron/.build/version.json` 时调用 `git`，报 `fatal: not a git repository`，导致 5 个用例失败。**这 5 个失败不是 e120 缺陷，也不能解释原 raw 1。** 原因是本包建树前只 grep 了测试文件，漏查了生产代码中的这处 git 调用，这是本包的疏漏。C2 随后批准纠正一次环境，第 5 片的有效复验是 `ed9b7d`。
- 范围依据：C2 最终裁定"第 2、5 片各一次有效复验，片 5 另允许一次环境纠正"。之前回调里"仅第 5 片"的说法已作废。C2 也确认 shared clone 算等价 git 环境，fork=3 与原全测一致，覆盖了 brief 里"1fork1thread"的建议。

### 原件（只读复制到 `/tmp/opencode/x4-run012/orig/`，保留 mtime；八份 shard JSON 与 C2 的 `/tmp/opencode/c2-fulltest-e120-raw-1852/` 逐字节相同）

| 片 | 作业 | started → ended (Z) | raw | note | JSON | files | passed / failed / pending | log 行 / fork pid 数 | 错误原文 |
|---|---|---|---|---|---|---|---|---|---|
| 2/8 | `20261105181610-69702c` | 18:22:15.300 → 18:35:23.998 | **1** | — | success=true，360 suites 全 pass | 167 | 1784 / 0 / 14 | 171 / 4 | 无；非 WASI 行只有 dstu_llm INFO、`[SingleShot] 关闭响应流失败: This operation was aborted`、教材页 DEBUG、1 行 `收集数据库统计信息`，结尾 `JSON report written` |
| 5/8 | `20261105181610-57603c` | 18:18:44.577 → 18:26:40.903 | **1** | — | success=true，349 suites 全 pass | 167 | 1949 / 0 / 4 | 151 / 9 | 无；非 WASI 行只有 6 行 `收集数据库统计信息`、2 行 secure_store 启用，结尾 `JSON report written` |

- 第 5 片 JSON sha256 `35f70a71…1bd`；其中文件最早开始于 18:18:49.576Z，最后结束于 18:26:39.933Z（`host/plugins/browser/tests/bridge-serde.test.ts`），之后 0.97s 作业结束。4 个 skipped 是平台限定用例（keystore macOS ×2、sandbox Seatbelt、system-ocr native binding）。
- 其余六片 raw 都是 0：1/8 `6c9905`、3/8 `20204f`、4/8 `a49d1a`、6/8 `9aef42`、7/8 `9a945d`、8/8 `94ba5f`。合并后的 `latest.json`（sha256 `4cd6c328…7a`，`at=18:47:43.951Z`，`head=e1204ee8a`）共 12927 用例 / 12857 passed / 0 failed / 70 pending，与 C2 的 ledger 输入 `/tmp/opencode/c2-stable-e1204ee8a-1754.json` 同 sha。`success=false` 是 `fulltest.mjs:74` 写死的常量，不是本次失败的证据。
- 作业层：runner `child.on('exit')` 记的是 `code ?? 128`，没有信号 note，所以是 vitest 主进程自己以 exitCode 1 退出（npx 层语义见 RUN-008）。`dsdev.slice` 的 memory.events 为 `oom 0 / oom_kill 0`。本账号读不到内核日志，所以无法排除或确认段错误一类的事件。
- 预算：job.mjs 不传 env，作业继承 runner（`ds-jobs.service` v3.conf）的 `VITEST_MAX_FORKS=3`、`VITEST_MAX_THREADS=3`，`vitest.host.config.ts` 是 `pool: 'forks'`、`testTimeout: 30_000`。brief 写的"1fork1thread"与实际环境不符。复验沿用原件的实际环境，没有改预算，C2 已确认这一做法。
- 并发：第 5 片运行期间队列里同时有约 60 个其他作业（tsc、lane 级 vitest、ledger），其中 L13 `181916-c1891a`、L02 `182013-b905c6`、L21 `182356-8f566a` 这几个 lane 测试 exit 1。它们跑在各自的工作树里，与第 5 片没有共享文件，**不作归因证据**，也不签"负载误报"。

### 复验（全部尝试，均经 jobs，输出在 `/tmp/opencode/x4-run012/` 下，没有改官方 fulltest 目录的 shard/latest）

时机：用 pidfd 等待 1754 唯一链 `3382617` 的一次退出事件（18:51:54.872Z），之后才提交。没有轮询，也没有取消任何作业。三次复验的实际预算都是 runner 继承的 `VITEST_MAX_FORKS=3`/`VITEST_MAX_THREADS=3`，`pool: 'forks'`，与原全测相同。

| 尝试 | 作业 | 树 | 命令 reporter | started → ended (Z) | raw | JSON | 文件集合 vs 原件 | Errors / 失败原文 | log |
|---|---|---|---|---|---|---|---|---|---|
| 片 5 #1（**环境无效**） | `20261105185406-4f6287` | `tree`：`git archive` 展开，**没有 `.git`** | default+json | 18:54:31.680 → 19:01:09.067 | 1 | success=false，1944 / 5 failed / 4 | 167 个，逐行相同 | 没有 `Unhandled Errors` 段。5 个失败分布在 `electron/tests/shell-restart-host.test.ts`（1 个）和 `host/platform/storage/tests/startup-gate-command.test.ts`（4 个），原文都是 `git cat-file -e 64edcb77…^{commit}` → `fatal: not a git repository`，栈为 `electron/build-info.ts:18:38 ← :26 ← getAppVersion :10 ← electron/index.ts:38`。这两个文件在原件中都是 passed | `replay/20261105185406-4f6287.log`（744 行） |
| 片 2（有效） | `20261105190724-23f439` | `tree2` | dot+json | 19:07:25.503 → 19:19:41.152 | **0** | success=true，360 suites，1784 / 0 / 14 | 167 个，逐行相同 | 没有 Errors/Unhandled/FAIL（计数 0） | `replay2/20261105190724-23f439.log`（305 行） |
| 片 5 #2（有效，环境纠正后） | `20261105191008-ed9b7d` | `tree2` | dot+json | 19:20:00.922 → 19:25:56.250 | **0** | success=true，349 suites，1949 / 0 / 4 | 167 个，逐行相同 | 没有 Errors/Unhandled/FAIL（计数 0） | `replay5b/20261105191008-ed9b7d.log`（170 行） |

两棵树的差别（片 5 两次复验的环境差别就在这里）：
- `tree`：执行 `git archive e1204ee8a | tar -x`。没有 `.git`，`buildInfo` 必然失败。
- `tree2`：执行 `git clone --shared --no-checkout <本工作树> tree2 && git checkout --detach e1204ee8a`。源仓库的对象只读共享，不写源仓库的 `.git/worktrees`。HEAD 是 `e1204ee8a02f1cfb3255fb1a75bb234c72236ce9`，`git status` 只有未跟踪的 `src/version.ts`，与 ds-fulltest 原状一致。`rev-list --count 64edcb77..HEAD`=10659，与 ds-fulltest 在 e120 时相同。`getAppVersion()` 实测为 `0.11.0 (Build 25297, e1204ee8)`，与 `src/version.ts` 一致。C2 已接受它作为等价 git 环境。
- 两棵树共同的部分：`node_modules` 软链主仓库，与 ds-fulltest 相同。`src/version.ts` 从 ds-fulltest 原样复制，逐字节相同，不是伪造版本。`vitest.host.config.ts`、`package.json`、`package-lock.json`、`fulltest.mjs`、`job.mjs` 都与 ds-fulltest 逐字节相同。`diff -rq` 与 ds-fulltest 相比只差 4 个由测试或构建生成的 ignored 目录（`electron/.build` 里只有测试自己用 `buildPreload` 生成的 `preload.cjs`，没有 `version.json`；`fixtures/db`；`fixtures/differential/runs`；`host/e2e/data-compat/.tmp`）。第 2 片里引用这些目录的测试只有 `shell-real-host`，它会自己生成 preload。
- 与原件的不同：原件只用 json reporter，跑在 ds-fulltest，与 8 片同时争用槽位。复验用双 reporter，跑在自有树，各片单独运行。**复验 raw 0 只说明当前固定复验通过，不能改写原件第一次的 raw 1，也不能反推原件全绿。**

### 后续（C2 决定，本包停止重跑）

1. 原第 2/5 片 raw 1 记为"未归因的工具残差"。没有错误原文，复验又不重现，所以不派业务 owner，也不签"负载误报"。
2. 让错误原文能落盘，仍然需要 RUN-008 列出的 `fulltest.mjs:51` 双 reporter 维护建议（owner 由 C2 指派）。没有这一步，每次 JSON-only 的 raw 1 都只能事后复验。
3. 隔离复验树必须带真实的 `.git`。当前 `electron/build-info.ts` 在没有 `electron/.build/version.json` 时依赖 git，这是生产语义（对应 `build.rs`），不需要改。以后复验时，`git archive` 树不可用。

## WP-C2-RUN-008：固定 967f 全测 raw 退出异常归因（2026-11-06，只读取证）

结论：**具体根因未定（尚未归因）；不签"负载误报"。967f 不能宣称全绿。** 证据分三级，不能互相替代：

1. **原件直接观测到的**：全测 `967f43c7547d1ed29a7e3d736b8118fb95d3661e` 的 2/8、4/8、5/8 三片 raw code=1，runner 没有记录信号 note；三片 JSON `success=true`，没有失败用例或失败套件，`failureMessages` 全为空；log 里没有任何报错文本，最后一行是 `JSON report written`。
2. **由源码和实测排除推出的**：退出原因不是信号/OOM/超时，也不是断言/套件失败。按 vitest 3.2.7 源码逐条排除后，与上述形态不矛盾的只剩一条路径：主进程 `state.errorsSet` 非空，`_checkUnhandledErrors` 置 `process.exitCode=1`。`--reporter=json` 既不打印 errorsSet，也不把它计入 `success`。**这是排除推论，不是对当时 errorsSet 的直接观测。**
3. **已复现的**：在仓库外用同一 vitest 制造一个 unhandled rejection，json-only 运行的退出形态与历史三片相同（作业 `20261105162218-16b453`）。这证明该机制**能**产生这种形态，不证明历史三片**就是**它，更不能说明错误是 rejection、exception 还是 pool/reporter 错误，也不能说明来自哪个文件。

errors 原文当时没有写入任何原件，所以历史三片的错误类型和来源文件**未证明**。

本节不改 G1–G4，不改命令 C，不改 fulltest/runner/测试/账本。

### 固定受测点与原件

| 项 | 证据 |
|---|---|
| 受测点 | `ds-fulltest` 工作树 HEAD `967f43c75`（提交时间 2026-11-05T21:47:18+08:00）；`.oc-runs/fulltest/c2-v3-phase0-20261105.log`：13:51:12.030Z 开始，14:17:42.381Z 完成，用例 12595 / 通过 12525 / 失败 0 / pending 70 / 失败套件 0 |
| 驱动源码 | `scripts/electron-migration/fulltest.mjs` 在 967f、当前 HEAD、工作区三者 blob 相同 `064b70980877`；`jobs/job.mjs` 同为 `50dff7388a4b`；`vitest.host.config.ts` 同为 `e9eea2cf0e10`（`pool: 'forks'`，无 globalSetup/coverage） |
| runner 版本 | `journalctl -u ds-jobs.service`：`Nov 05 21:47:43 node[2068047] 作业执行器启动 … 并发上限 {"typecheck":6,"test":6,"build":2,"other":6}`。没有 `rust` 键，与 967f 的 `runner.mjs`（blob `8a6f00b34`）一致；工作区里未提交的 rust 类改动 mtime 是 22:37:39，晚于本次全测。退出码记录逻辑在 967f `runner.mjs:93-94`：`child.on('exit', (code, signal) => finish(code ?? 128, signal ? '被信号…' : undefined))` |
| 工具链 | vitest 3.2.7（`ds-fulltest/node_modules` 是指向主仓库 `node_modules` 的符号链接，vitest dist mtime 2026-11-04 10:32，早于本次运行；967f `package-lock.json:22873` 锁定 3.2.7）；npm 11.17.0（mtime 2026-06-24）；node v26.5.0 |
| merged 报告 | `.oc-runs/fulltest/latest.json` sha256 `613a4648f8e24c1def0d9c8ff4bb2622d671e39cd81d0432fc1582f50a7551bf`，`at=2026-11-05T14:17:42.222Z`，`head=967f…`。只读副本 `/tmp/opencode/x4-967f-latest.json`（同 sha，保留 mtime 22:17:42）；C2 先前副本 `/tmp/opencode/c2-fulltest-967f-1605.json` 同 sha |
| 分片 JSON | **以 C2 原样复制为准：`/tmp/opencode/c2-fulltest-967f-before-1619/{latest.json,shard-1.json…shard-8.json}`**。C2 在 16:22Z 启动 `4dc4c8ed9` 新全测之前，用 COPYFILE_EXCL 复制了这 9 份（mtime 2026-11-06 00:22:03 +0800）；`.oc-runs/fulltest/` 下的同名文件已被新全测删除或覆盖（`fulltest.mjs:50`），**不得与 967f 混用**。sha256：latest `613a4648…51bf`（与上行相同）；shard-1 `ba3baeab…27eb`、2 `86f11f8e…874c`、3 `ee4ede18…bc7`、4 `81078f1b…a7fa`、5 `63fd3a44…fed`、6 `1dab6058…a8a`、7 `3af6a426…6bf`、8 `542e7f7b…2e8`。下表和"8 片 assertion 共 passed 12525 / skipped 70、非空 `failureMessages` 0、无额外顶层键（无 errors 字段）"都直接读自这 9 份原件。本包此前用 latest.json 切片重建的成员表 `/tmp/opencode/x4-967f-shard-membership.json` 与原件核对零差异，只作为交叉校验，不代替原件 |

### 8 片原始数据（`~/.oc-jobs/done/<id>.json` + `/tmp/opencode/c2-fulltest-967f-before-1619/shard-<i>.json` 顶层）

| 分片 | 作业 | started → ended (Z) | raw code | note | JSON success | files | passed / failed / pending | log 行数 |
|---|---|---|---|---|---|---|---|---|
| 1/8 | `20261105135112-2ac9db` | 13:51:12.374 → 14:07:14.683 | 0 | — | true | 163 | 1534 / 0 / 2 | 66 |
| **2/8** | `20261105135112-4d8ceb` | 13:51:12.386 → 14:09:43.034 | **1** | — | true | 163 | 1717 / 0 / 14 | 171 |
| 3/8 | `20261105135112-04a6d8` | 13:51:12.368 → 14:02:20.918 | 0 | — | true | 163 | 1385 / 0 / 28 | 272 |
| **4/8** | `20261105135112-3f0904` | 13:51:12.378 → 14:00:04.729 | **1** | — | true | 163 | 1506 / 0 / 9 | 400 |
| **5/8** | `20261105135112-db7e4b` | 14:00:05.399 → 14:09:42.785 | **1** | — | true | 163 | 1894 / 0 / 4 | 149 |
| 6/8 | `20261105135112-fe8a89` | 14:09:43.406 → 14:17:41.330 | 0 | — | true | 163 | 1427 / 0 / 2 | 158 |
| 7/8 | `20261105135112-d61ba0` | 13:51:12.390 → 14:04:03.614 | 0 | — | true | 163 | 1802 / 0 / 5 | 167 |
| 8/8 | `20261105135112-3f233d` | 13:51:12.382 → 14:01:54.241 | 0 | — | true | 158 | 1260 / 0 / 6 | 1523 |

8 片 `numFailedTestSuites=0`，每个文件 `status=passed`、`message=""`。三片 log 去掉 WASI ExperimentalWarning 和 secure_store 启用行后，分别只剩以下内容（全文去重计数），最后一行都是 `JSON report written to …/shard-<i>.json`：
- 2/8：dstu_llm 的 INFO、`[SingleShot] 关闭响应流失败: This operation was aborted`、教材页 DEBUG；
- 4/8：`[CryptoPublication]` journal 回滚/前滚、`[Translation] SSE 流未收到完成标记就结束`；
- 5/8：6 行 `收集数据库统计信息` DEBUG。

这些都是测试有意制造的场景日志。exit 0 的 7/8 也有同样的 `SingleShot … aborted` 行，所以不能用它们区分分片。没有 `npm error`、`Killed`/`Terminated`、`Unhandled`、`Uncaught`、`heap out of memory`、`close timed out`、`something prevents`、`Worker exited`、`ERR_IPC` 中的任何一个。

### 调用链与各层退出语义

`fulltest.mjs:51` spawn `job.mjs run --tail 5 -- npx vitest run … --reporter=json --outputFile=…`（`stdio: 'ignore'`）→ `job.mjs` 写 queue → `runner.mjs` `spawn(npx…)`，stdout/stderr 都进 `done/<id>.log` → `child.on('exit')` 把 `code ?? 128` 写进 `done/<id>.json` → `job.mjs:72` `process.exit(s.code)` → `fulltest.mjs:53` 拿到 `code`，**只在 `:64` 缺报告时用到；`:69-77` 合并时丢弃 code，`:74` 写死 `success: false`**（自 `d84e29565` 起就是常量，`44b66353c` 只是换行）。所以 `latest.success=false` 对任何一次全测都成立，不能当作这次失败的证据，raw 退出码才是。`:105-112` 的 main 红灯分派只看 `assertionResults` 的 failed 和 `status==='failed'` 的文件，所以 `dispatched.json` 里没有任何 `@967f…` 键：3 片 exit 1 没有通知任何人。

**npx 层（实测，非推断）**：`/tmp/opencode/x4probe/probe.mjs` 用本机 npm 11.17.0 让 `npx <bin>` 的子进程分别 `process.exitCode=1` / 自杀 SIGKILL / SIGTERM / SIGINT，父进程看到的 `(code, signal)` 依次为 `(1,null,"")`、`(137,null,"Killed")`、`(143,null,"Terminated")`、`(130,null,"")`。所以 exit 1 且无输出说明 vitest 主进程自己以 exitCode 1 正常退出，不是被信号终止。`/sys/fs/cgroup/dsdev.slice/memory.events`：`oom 0`、`oom_kill 0`、`oom_group_kill 0`（自 slice 创建累计）。

**vitest 3.2.7 能让主进程 exitCode=1 的路径（`node_modules/vitest/dist/chunks/`）逐条核对：**

| 路径 | 位置 | 会留下的痕迹 | 967f 三片 |
|---|---|---|---|
| 有文件 `result.state==='fail'` | `cli-api.DVe0nWUx.js:8891`（`TestRun.end`），`:9705`（collect）；`ok()` 在 `:7925` | JSON 中该文件 `status=failed` | 排除：全部 passed |
| `startVitest` catch | `:10531` | 打印 `Unhandled Error` 横幅 | 排除 |
| `start()` Startup Error | `cac.BfaZ95xE.js:1421` | 打印 `Startup Error`，且不会写 JSON | 排除 |
| 主进程 unhandledRejection | `cli-api…:5633` | `printError(…'Unhandled Rejection')` 后立即 exit | 排除：无输出，JSON 已写 |
| Node 主进程未捕获异常 | node 默认 | stderr 栈 | 排除 |
| 关闭超时 | `:9941-9950` | `close timed out after …` 警告 | 排除 |
| 信号 | `:5614-5619` 及 npx 层 | 128+N 或 `Killed`/`Terminated` | 排除（见上） |
| coverage 阈值 / 缺依赖 / 无测试 | `coverage.DfSpMS-b.js:4165,4179`；`:10504,10554`；`hasFailed` 空集 | 未开 coverage；缺依赖会打印 `MISSING DEPENDENCY`；有 163 个文件 | 排除 |
| **`errorsSet` 非空** | `runFiles` finally `:9663-9665` → `_checkUnhandledErrors` `:9893-9894`；入口：worker `execute.B7h3T_Hc.js:479-494`（uncaughtException/unhandledRejection 经 rpc `onUnhandledError`，`coverage.DfSpMS-b.js:2511`）、`pool.runTests` 抛错 `:9648-9650`（如 tinypool `Worker exited unexpectedly`、`Failed to terminate worker`）、reporter 抛错 `:8879` | **只有 BaseReporter 的 `printErrorsSummary` 打印**（`index.VByaPkjc.js:208-210,463-464`）；`JsonReporter.onFinished(files, _errors)` 忽略 errors（`:1765`），`success` 只看失败套件和失败用例（`:1711`） | **唯一不与原件矛盾**（排除推论，非直接观测） |

**最小机制复现**（独立目录 `/tmp/opencode/x4vt`，不碰仓库；同一 vitest 3.2.7、`pool: 'forks'`）：一个用例通过后留下一个未处理的 rejection，一个干净用例。
- 作业 `20261105162218-16b453`：`--reporter=json`，**exit 1**；JSON `success=true`，2 passed，两个文件都是 `status=passed`、`message=""`；log 只有一行 `JSON report written to …`。外在形态（raw code、JSON 字段、log 内容）与 967f 三片相同；这只说明该机制能产生这种形态，不能反推历史三片的错误。
- 作业 `20261105162233-c11741`：同样加 `--reporter=dot`，exit 1；log 出现 `Unhandled Errors / Unhandled Rejection / This error originated in "leak.test.ts" / Errors  1 error`。
- 作业 `20261105162246-98f947`：只跑干净文件，exit 0。

这说明了"C2 grep 不到 Errors"的原因：只用 json reporter 时，`Errors` 汇总行根本不会输出。

### 每片结论

| 分片 | 原件直接观测 | 排除推论（非直接观测） | 未证明 |
|---|---|---|---|
| 2/8 `4d8ceb` | raw code 1，无信号 note；shard-2.json success=true，1717/0/14，163 文件全 passed，failureMessages 全空；log 无报错文本，以 `JSON report written` 结束 | 不是信号/OOM/超时（npx 实测 + cgroup `oom_kill 0`）；不是断言/套件失败；按上表只剩 `errorsSet` 非空一条路径 | 当时 errorsSet 是否非空（无直接观测）、错误类型（rejection/exception/pool/reporter）、来源文件、时间。原文没有落盘 |
| 4/8 `3f0904` | 同上（1506/0/9） | 同上 | 同上 |
| 5/8 `db7e4b` | 同上（1894/0/4）；14:00:05Z 才开始，等 4/8 让出槽位 | 同上 | 同上 |

不作为证据的观察：2/8 和 5/8 结束时间只差 0.25s（14:09:42.785 / 43.034），可能是同一时刻的外部事件，也可能是巧合，现有原件无法区分。另外，用 `~/.oc-jobs/done/*.log` 中别的提交上默认 reporter 打出的 `This error originated in` 文件做交叉对照：`media/tests/question-import-vision.test.ts` 在 2/8，`mcp/tests/stdio-stdout.test.ts` 在 4/8，5/8 没有命中；但 `stdio-length-text`、`worker-pool`（1/8）、`execute-entry`、`script-runtime-wiring`（3/8）、`vfs/upload-file`（6/8）在 exit 0 的分片里，而且这些都是别的提交、别的 lane 跑出来的，所以这不能定位到文件。不能据此推断"负载误报"。

### fulltest.mjs 最窄维护建议（本包不改；合法 owner 另接，C2 指派）

1. `fulltest.mjs:69-81`：把每片 `{ i, code, jobId }` 写进 merged 报告和 `history.jsonl`，`success` 改为"8 片 raw code 全 0 且 `numFailedTests===0` 且 `numFailedTestSuites===0`"。这只会更严格，967f 在新定义下仍为 false。**不能**为了消红而改成只看 JSON。
2. `fulltest.mjs:51`：在 `--reporter=json` 之外再加一个会打印 `printErrorsSummary` 的 reporter（例如 `--reporter=dot`）。这样 unhandled error 的原文（类型、`This error originated in`、最后一个用例名）会进 `done/<id>.log`，下次可以静态归因。只增加输出，不改断言和预算。
3. `fulltest.mjs:105-112`：raw code≠0 但没有失败断言的分片，不应静默跳过，应作为"分片异常退出"分派给 C2-platform。
4. `fulltest.mjs:52` 的 `stdio: 'ignore'` 丢掉了 job id，`:53` 的 code 也只在缺报告时出现，导致事后只能按 cwd + 时间去 `done/` 里反查。上面第 1 条已覆盖这一点。

### 最小取证复验方案（未执行；需要 C2 授权排队）

1. 新建独立 detached 工作树固定到 `967f43c75`，**不要用** `ds-fulltest`，它被 fulltest 定时器复用，16:22Z 已切走；`node_modules` 按 `fulltest.mjs:39-40` 软链；执行 `npm run -s version:generate`。
2. 经作业队列**只跑 1 片**，选 4/8，三片里最快（墙钟 8m52s）：`node …/jobs/job.mjs run -- npx vitest run -c vitest.host.config.ts --shard=4/8 --reporter=json --outputFile=<新路径>/shard-4.json --reporter=dot`。
3. 先核对新 shard-4.json 的文件集合与原件 `/tmp/opencode/c2-fulltest-967f-before-1619/shard-4.json` 完全相同，否则结果不可比。
4. 复现 exit 1 时，log 中的 `Unhandled Errors` 段会给出错误类型、`This error originated in "<文件>"` 和最后一个用例。据此按文件归属派给对应 lane，并对 2/8、5/8 分别提出是否复验，由 C2 决定，本包不擅自跑。exit 0 时记"未复现"，保持"尚未归因"，不据此改判。
5. 不改预算、断言、超时，不改 shell 错误码，不抹 Errors。

## 增量刷新（main `3b2758d7a`；当前结论，取代下方 9c13dfc39 计数）

固定基线：**main `3b2758d7a`，本 worktree 合并提交 `a7fc71dfbb9556488a8ad42b069921c5608efc41`**。经全局队列只跑一次既有审计器（作业 `20261104085238-4518e9`，命令 `node scripts/electron-migration/wiring-audit/audit.mjs --check --json`），`job.mjs result` **原退出码 1**（预期发现，不是 agent 失败），`loadErrors=[]`，完整日志仅 Node WASI ExperimentalWarning。evidence.md 由同一 JSON 渲染（已在检查点 `163ffb40e`）。没有重扫，也没有重分类前次 14 项；审计器、分类规则和夹具都没改。

| 计数 | 9c13dfc39 | 3b2758d7a |
|---|---:|---:|
| 插件入口 / 声明服务名 | 36 / 93 | **36 / 94** |
| 无其他插件消费者 | 46 | **44** |
| 已分类接线孤岛（未驱动 + 绕行） | 30（26+4） | **28（25+3）** |
| needs-review（新出现的服务名） | 0 | **2**：`sync`、`examSheetSession` |
| 悬空名字 / 顶层硬悬空 | 12 / 1 | **9 / 0** |
| 硬 inject 环 / loadErrors / profile 遗漏 | 0 / 0 / 0 | **0 / 0 / 0** |
| 诊断候选 / 条件分支 / 测试提供位置 | 313 / 218 / 558 | **328 / 234 / 670**（不是缺陷数） |

这里的 28 只是已分类孤岛数，不是全应用孤岛总数。“导入可达 ≠ apply 成功 ≠ 方法被生产入口调用”这条边界仍然成立。

### 本轮关闭（只记有调用链变化的项）

| 原项 | 新证据（3b2758d7a） | W |
|---|---|---|
| `anki@1` 硬注入（唯一启动阻塞） | chatanki/index.ts:476 `inject: ['settings','review','llm','anki']`，:330 lookup 只读 `anki`。L24 修复已集成，**硬悬空归零**。这不代表所有 ChatAnki 工具已能端到端执行。 | W04 |
| `agent.tools@1` 旧名 attach | chatanki/index.ts:479-484 只 attach `agentTools`；:222-247 把 executor 包一层后经 hydrate 注册。 | W02/W04 |
| `sync.provider@1` 旧键回退 | backup/index.ts:203 只读 `syncProvider`。 | W12 |
| L21 共享许可（D2） | backup/index.ts:54-61 `tryAcquireOperation`/`acquireOperation(timeout)`，api.ts:182-188；L23 sync-providers/index.ts:124-168 直接调用并在 finally `release`；L20 经 backup/src/sync-ports.ts:57-88 的同一 Operations（kind=`sync`）拿 permit，run-sync.ts:57,90 释放。**W12 的许可部分关闭**，不再派 L21/L23 重写。 | W12 |
| L20 消费 syncSupport | sync/index.ts:73 inject `syncSupport`/`nativeCompression`/`vfsRepo`，:89-106 把 `syncSupport.state` 与压缩服务传给 commit/execute/upload/download；backup/src/restore-commands.ts:182-190 读 `syncSupport.state.recordDeviceRotation`。`syncSupport` 与 `nativeCompression` **都不再是孤岛**。 | W13 / W08 |
| browser/index 工具执行器 | browser/index.ts:133-177 构造真实 BrowserToolExecutor / IndexWebpageToolExecutor，并经 `agentTools.registerToolExecutors` 注册；runtimeRoots 已有消费者（:137）。 | W02 |
| mcp reload/preheat 静默兼容结果 | mcp/index.ts:31-36,185-200 现在在 L02 方法缺失时显式抛 CommandError，不再返回 success/count=0。L02 方法本身仍未发布，见下表 W20。 | W20 |

### 仍在（9 个悬空名，逐位置见 evidence.md）

| 名字 | 位置 | 状态 / 提供方候选 |
|---|---|---|
| `chat.send@1` | agent-orchestration/index.ts:486-487,593；src/super-inbox-drain.ts:220 | W01 仍在：没有 headless/send 执行服务，由 L03/L04 提供。 |
| `ankiGeneration@1` | anki/src/generation-port.ts:39,56 | W05：由 L02 拼出两方法端口；`llmAnkiRouting` 已提供但未被消费，不能直接当作这个端口。 |
| `llm.adapter-infos@1` | anki/src/model-adapters.ts:28 | W15：提供方 `llmAdapterInfos` 已在 main，只需 L16 改消费键。 |
| `reviewPlan` | qbank/index.ts:94 | W05：L15 有局部 ReviewPlanService，缺公开的 getOrCreatePlan 消费面。 |
| `embedding@1` | vfs-index/src/runtime-adapter.ts:48,143 | W06：需接已有 `llmEmbeddingModels` 并补实际调用面。 |
| `pdf@1` | vfs-index/index.ts:168 | W07：PdfStageRuntime 尚未组装。 |
| `vector` | vfs-index/index.ts:66；vfs-handlers/index.ts:314-315 | W07：F7 `dstu.vector` 只在 F7 分支，main 还没有，不算 main runtime provider。 |
| `storageStartupSync` | platform/storage/index.ts:72 | W13：F3/L20 的 purge reset 已按 D2 续派；不能形成 storage↔业务硬环。 |
| `browserSurface` | browser/index.ts:115 | **可选 seam**：已有 ShellBrowserSurface 默认实现，不派新 provider。严格 `--check` 仍把它计为缺名，见下面门禁交接。 |

两个新 `needs-review` 只是登记，按要求没有重新分类：`sync`（L20 由 `ctx.reflect.provide('sync')` 提供，sync/index.ts:171；按 D7，L21 应按需 `ctx.get('sync')`，main 里还没读到）与 `examSheetSession`（media/index.ts:122,299-306 提供；media/src/exam-sheet-service.ts:803-822 有三个方法，但没有外部消费者）。它们留给下一次需要时人工归类，不算孤岛，也不算正常面。

其余 W 项沿用 9c13dfc39 的结论，已按 C2 的 W01–20 派发执行，不在本轮重复下发：W03 outbox 消费、W09 vfsIndexMaintenance 的 reset/delete 子面、W10 roots/task、W11 Memory 删除 hook、W16 分类/promotion/dedup、W17 budget/noteAssets/backgroundTasks 的剩余消费、W18 notes blocks、W19 通知回执、W20 L02 MCP 缓存方法、W21 startupGate 完成闸门。llmRag 仍是 rust-unwired-candidate，nativeHeic 仍按 D5 not-approved，都不算必接。

### 集成门禁接入（命令与退出语义）

在固定提交的仓库根目录执行：`node scripts/electron-migration/wiring-audit/audit.mjs --check --json`

- **exit 0**：在扫描范围内 `missing`、`cycles`、`loadErrors` 均为空。不代表 apply、启动或业务验收通过。
- **exit 1 且 stdout 是有效 JSON**：上面三者至少一项非空，属于正常发现，按 JSON 回派责任方。
- **非零退出但没有有效 JSON**（崩溃、被信号杀死）：工具或基础设施错误，单独留存 stderr 与退出码。队列 `result` 返回 75 只表示作业未完成。
- 孤岛分类、诊断候选、profile 遗漏不影响退出码。

**在固定基线 `3b2758d7a`（合并 `a7fc71dfb`）上此命令退出 1**：9 个缺名都会触发，其中可选 `browserSurface` 只要不新增 provider 就会一直触发。该结论只对这个 SHA 成立，不外推到之后的 main。本 lane 不加豁免、不删扫描、不造假 provider、不改全局门禁配置。C2 已确认 `--check` 暂为 report-only；何时上线、按什么精确规则，由架构师/X6 决定。禁止用 `|| true`、过滤日志或丢弃 JSON 冒充门禁通过。同样内容写在 scripts/electron-migration/wiring-audit/README.md 的「集成门禁交接」一节。

### 本轮验证记录

| 作业 | 命令 | `job.mjs result` 原始结果 |
|---|---|---|
| `20261104085051-b32afb` | npm run migration:ledger -- --check --no-write（恢复检查，合并前） | **退出码 0**；commands 1058（A 92%、B 7.2%、C 0%），tests 8036（A 78%、B 0.9%），problems 全为 0。账本绿不等于逐 ID 断言闭合。 |
| `20261104085238-4518e9` | 审计 `--check --json`（3b2758d7a 合并后） | **退出码 1（预期发现）**，`loadErrors=[]`。 |

本 lane 是新工具，没有 Rust TESTMAP。工具回归已在 9c13dfc39 跑过（13/13）；这轮没有改动工具、测试和夹具，所以没有重跑。

---

## 历史：定点分类与门禁修复（9c13dfc39；计数已被上方增量刷新取代）

固定主线：**main `9c13dfc39`，本 worktree 合并提交 `34d3890c810093b96bda249a5d262c7de2c077f0`**。本轮完成前次未决 14 项的逐项分类，分类数据写入 `classifications.mjs`；未重写扫描算法，未为数字归零重复扫描。只因 main 已换基线排队运行一次现有审计器，仍保留“导入可达 ≠ apply 成功 ≠ 请求方法被生产入口调用”的边界。下方 e127/489dcf 快照只作历史，不再作为现行派工依据。

| 当前计数 | 结果（一次审计、同一 JSON） |
|---|---|
| 可导入插件 / meta 声明服务名 | **36 / 93**，不是已成功 apply 的数量 |
| 没有其他插件消费者 | **46** |
| 接线孤岛（服务契约/方法面） | **30 = 26 未驱动 + 4 绕过服务**；不是全实例或全应用运行能力数量 |
| 正常命令面 / 正常局部实例 | **12 / 2**（局部实例为 lanceEngine、mcp） |
| Rust 未接线候选 / 架构禁止后端扩展 | **1 / 1**（llmRag / nativeHeic），均不算必接任务 |
| needs-review | **0**；前次 14 项已逐项分类，不再把旧 20 当总孤岛数 |
| 悬空名字 / 顶层硬悬空 | **12 / 1（anki@1）** |
| 硬 inject 环 / 入口加载 Errors | **0 / 0** |
| profile 遗漏（已发现的入口） | **0**，已含 shell |
| 诊断候选 / 条件分支 / 测试提供位置 | **313 / 218 / 558**；不是相同数量的缺陷或不同替身 |

本轮 12 个悬空名字为 `agent.tools@1`、`anki@1`、`ankiGeneration@1`、`browserSurface`、`chat.send@1`、`embedding@1`、`llm.adapter-infos@1`、`pdf@1`、`reviewPlan`、`storageStartupSync`、`sync.provider@1`、`vector`；逐位置证据见 [evidence.md](../../../../scripts/electron-migration/wiring-audit/evidence.md)。可选 browserSurface 仍有正确默认 shell 实现，不派新 provider。L24 的 ade2dd598 修复尚不在本次固定 main，不能提前消除 anki@1 硬阻塞。

较 e127，**vfsMaintenance 与 vfsRepo 旧键两项已从悬空列表关闭**：L11 提供方已进 main，L06 index.ts:289 已读 vfsRepo.todos；agentVfsResolver 已由 L03 index.ts:177,378 消费，PTC/nativeStarlark、nativeRegex、featureFlags、backgroundTasks 也已有新生产读取，不再沿旧孤岛列表派工。只有已改变的状态在本轮更正，未变化的 W01–W20 不重复下发实现。

### 前次 14 个 needs-review 的逐项结论

这里的“接线孤岛”是**已发布的服务契约没有生产请求入口驱动**，不是“实现不存在”。有对象传递/方法调用点时逐项说明它是不是尚未接入的父请求内部调用；不拿声明、grep 命中、测试替身来证明生产运行。

| 服务 | 提供对象与实际调用链（本轮 SHA 下） | 分类 / 余项 |
|---|---|---|
| llmAdapterInfos | llm/index.ts:100 将 adapters/registry.ts:115-119 的真实注册表枚举发布；anki/src/model-adapters.ts:28 仍获取 llm.adapter-infos@1，不是这个对象。 | **消费键断点 / island，W15**。提供方已实现，不重派。 |
| llmEmbeddingModels | llm/index.ts:101 → embedding_service.ts:8-35，方法读取真实 settings/configs 并用 EmbeddingDefaults；VFS runtime-adapter.ts:141-168 仍自己解析 assignments、期待 embedding@1，没有调用此实例。 | **模型选择面未接 / island，W06**。不是 embedding HTTP 调用已通，也不要求重写选择器。 |
| llmOcrModels | llm/index.ts:102-106 的同一 ocrModels 实例被传入 hedge/regions；ocr_hedge_service.ts:87 调 isOcrThinkingEnabled，ocr_regions_service.ts:28 调 getOcrEngineType，但均在父 prepareCandidates/parse 被调用后才执行。 | **未驱动请求链的支撑对象 / island，W06**，不是“完全没有源代码调用点”；当前外部入口还在获取旧 OCR/LLM 形状。 |
| llmOcrRegions | llm/index.ts:105-106 → ocr_regions_service.ts:27-80；parse 真正调 nativeImage.dimensions、OCR adapter 与 grounding parser，但只在 parse 被请求时执行。没有绑定到现行媒体/题目命令的这个服务调用。 | **区域解析入口未接 / island，W06**；不能拿构造成功证明页面 OCR 可用。 |
| llmOcrHedge | llm/index.ts:104 → ocr_hedge_service.ts:68,102 的 prepareCandidates/runPrepared；:138-143 再调 streaming 或 runSingleOcrRequest。对象构造本身不启动 hedge。 | **对冲外层入口未接 / island，W06**；内部并发代码存在，不是要求重新实现。 |
| llmStreaming | llm/index.ts:93-95,104 将同一 streaming 传到 parsing/hedge；question_parsing_service.ts:79,85、ocr_hedge_service.ts:138 有真实 singleShotCompletion 调用，但这些父方法尚未连接命令。exam_engine.ts:133 另临时创建同实现的实例，仅属于 OCR helper 链。 | **请求根未接的支撑服务 / island，W01/W05/W06**。不误写“HTTP/SSE 实现缺失”，也不把 helper 内调用当已走通请求。 |
| llmModel2Messages | llm/index.ts:96 把 model2_messages.ts:54 的 buildModel2Messages 作为 build 发布；当前 model2 发送执行器没有驱动此服务。 | **model2 组装面未接 / island，W01/W05**；不是因目录可达就算消息构建已被发送使用。 |
| llmProviderRequests | llm/index.ts:97 → provider_requests_service.ts:11-19 的 prepareModel2；其中共享 preparePlainProviderRequest 的确也被其他角色实现使用，但不是对该 prepareModel2 对象的调用。 | **角色专用请求面未接 / island，W01/W05**。共享 helper 已迁移，不推导本角色入口已接。 |
| llmQuestionParsing | llm/index.ts:95 → question_parsing_service.ts:77-98 的 parse/parseStreaming，内部调用 streaming；当前 qbank 命令没有消费此对象，且 grading-service.ts:69-78 仍为未接调用面返回错误。 | **题目解析入口未接 / island，W05**；不拿其单元测试的直接调用充当生产消费者。 |
| llmRag | llm/index.ts:107 → rag_service.ts:17-55 只提供非流式 translateText。对照 Rust llm_manager/rag_extension.rs:896-1004 的 translate_text，`.rs/.rs.in` 引用未见该方法调用；活跃 translation_executor.rs:28,1028 明确走 run_translation streaming pipeline，TS translation/index.ts:22-52 也走自己的命令管线。 | **rust-unwired-candidate / 不列迁移必接孤岛**。与活跃同名 translate_text 工具不是同一入口；保留待 C1 精确 ID 裁定，未经批准不删测试，也不为此启用新生产功能。 |
| vfsIndexMaintenance | vfs-index/index.ts:179-190 的同一 unitIndex 同时作为 vfsUnitBuilder、vfsIndexMaintenance，并传入后台 indexing；runtime-adapter.ts:221-222 调 syncResourceUnitsForResource，unit-sync-service.ts:107-110 再调 syncResourceUnits。**已有使用的是 sync 子面**；resetUnitIndex :114 与 deleteResourceIndex :140 仍未被这条链调用，L13b index-admin.ts:74,110 还调 deps.maintenance。 | **部分方法面孤立 / island，W09**。不把整个实例或 unit-sync 报成死岛，只保留 reset/delete 的 handoff；已在 main 的能力不重发。 |
| browserToolPolicy | browser/index.ts:94 发布 src/tool-executor.ts:192-208 的单例。其 canHandle/sensitivity/concurrency 调真实纯函数；browser 命令调用的是 browserService，不是这个 policy，L04 roster 也没用此对象。 | **Agent 策略面未接 / island，W02**，不等于浏览器命令未实现，也不能把 policy 冒充执行器。 |
| webpageToolPolicy | browser/index.ts:95 发布 src/index-webpage.ts:217-225 的单例；方法调用 indexToolCanHandle/Sensitivity/Concurrency，未绑定 VFS 持久化/索引执行器的生产调用。 | **网页工具策略面未接 / island，W02**；纯函数测试只验证策略，不证明保存/重建业务可运行。 |
| mcp | mcp/index.ts:67-82 提供同一 mcpService，并调用 startBackendMcp；:24-46 在 mcp.mode=backend 时调用 initializeGlobalClient。service.ts:152-159 创建真实 client，:162-165 dispose 会断开。卸载 hook 绑定同一实例；但 registry.callTool :95-119 仍需外部 dispatcher。 | **local-implementation / 正常局部运行面，不是全实例孤岛**。backend 模式与生命周期已接的源码路径不是实际运行通过证明；工具 registry 子面仍属 W02，不能宣称所有 MCP 工具已通。 |

14 项至此无未分类：**12 个契约/方法面接线缺口 + 1 个 Rust 未接线候选 + 1 个局部生产实例**。这不是全应用孤岛总数。新 main 另出现的 llmStreamEvents/llmAnkiRouting、llmCodexAuth、runtimeRoots、vfsWorker、startupGate 在本轮规则中分别按外层驱动缺口、共享命令面或启动接点分类，不回退到按服务名猜功能。

### 新架构裁定与过期建议撤回

- **D1/D4**（decisions.md:106-124）：所有者公开 `*WithConn(..., SqlExecutor)`、调用方在同一事务中只传递连接是合法接缝。**出现 SqlExecutor 参数不是违规，不要求批量改名**；调用方执行他表 SQL、裸任意 SQL 入口或拆散 Rust 原子提交仍要报告。本轮工具不靠参数类型判越权。
- **D2**（:113-116）：F3 提供启动 finalizer 注册/顺序，L21 是唯一 tryAcquire/acquire(timeout)/release 许可实例；业务通过注册点参与恢复 finalize/F2 gate，不再提平台反向依赖业务的临时接法。
- **D3**（:118-121）：仅 IPC 序列化边界按原 Tauri JSON 数字行为转换；内部 JSON/DB 的 i64/u64、游标、版本与纳秒比较仍必须精确。不能将边界裁定泛化成内部随处 Number。
- **D5/D9**（:129,152）：nativeHeic 无消费者改记 **not-approved**，不是必须补的后端接线；拒绝 libheif-js，保持 Rust 桌面后端校验错误。Chromium HEIC 预览退化是另一个前端评估问题，不由本 lane 添加新后端能力。
- F7 的 vector/nativeSandbox/nativeWindowsFiles/nativeWindowsSandbox 已核到**分支 `0624f9cee`**（vector/index.ts:5-8，native/index.ts:27-29,54-57），**本轮 main 未集成，不计为 main runtime provider**。Office/平台桥同样不因分支导出而自动验收。
- **delta 审批状态更正**：`294cbe65f` 的 C2 精确 ID 审批已进入当前 main，`migration/approvals.d/C2-platform.json:21-69` 为 **49 条 experimental 行为用例 obsolete**；五条 source-lock 保留。旧“全部待审批”描述仅属历史，不能复活实验协议，也不能把审批扩展到活跃 ZIP/E2EE/记录同步。

### W21 shell 当前结论

旧 e1278b78e 缺 shell 的结论仅对旧 SHA 成立。**本轮 desktop.json:41-42 已有 dstu.shell → ../../electron/index.ts**，生成器已扩展收 shell，已知清单为 36 插件；所以 **W21 的“漏装 shell/23 命令”部分关闭**。electron/index.ts:31,35-44 提供 startupGate 与 systemNotification；前者“已提供/已入 profile”仍不等于已在启动完成时 mark ready，D2 的 F3 finalizer 接点继续单列。systemNotification 已有提供方与 L06 消费路径，不再要求 F2 重写通知服务。

现有扫描器可以从 profile 发现 shell meta，但静态文件枚举仍限 host/，**不宣称 electron/ 方法使用已经自动穷尽**；本轮手工读了 shell 提供/启动边界。禁止把 profile 全包含与整个 Host 全部 apply 成功混为一谈。

### 夹具类型门禁（不增加任何 provider）

consumer/index.ts、unused.ts、tests/bridge.test.ts 的类型引用改为同夹具目录的 `context.ts`。该文件只有局部 interface：get/inject/provide 接受要故意审计的字符串，未扩充生产 Cordis Context、未注册新服务。原 old@1/bracketMissing/childMissing/wrappedMissing 等悬空请求和四个既有提供服务保持不变；既有 CLI 缺名退出 1 回归仍通过。

| 作业 | 固定工作树基线 / 命令 | job.mjs result 原始结果 |
|---|---|---|
| `20261104064643-648165` | main 9c13dfc39；npx tsc --noEmit -p scripts/electron-migration/wiring-audit/tsconfig.fixtures.json（执行器附增量缓存参数） | **退出码 0**，无诊断输出 / Errors；只检查本 lane 夹具，不能冒称全仓类型检查通过。 |
| `20261104064643-1bf9e2` | 同基线；node --test scripts/electron-migration/wiring-audit/audit.test.mjs | **退出码 0，13 tests / 13 pass / 0 fail / 0 cancelled / 0 skipped**，约 14.3 秒；仅本工具测试，不替代业务运行。 |
| `20261104065851-7d4b5c` | 同基线；bash -lc 'node scripts/electron-migration/wiring-audit/audit.mjs --check --json > /tmp/opencode/x4-9c13dfc39.json' | **退出码 1（预期发现）**；36 插件、93 服务、12 悬空、0 环、`loadErrors=[]`。完整日志仅 Node WASI ExperimentalWarning，无加载异常堆栈；并非 agent 失败。 |

结果由全局队列的 `job.mjs result <id>` 取得，不是截取日志中的通过行。完整日志在 `/home/dsdev/.oc-jobs/done/<id>.log`，退出码和 Errors 边界保留。验证状态为固定 main 加本 lane 的局部类型补丁/分类数据；没有据此签收全应用生产能力或 F4 原测试映射（仍须逐 ID 原断言证据）。从审计作业产生的同一 JSON 重渲染 evidence.md，没有再跑第二轮全扫或全仓类型/业务测试。作业器生成在仓库根的 `.lane.tsbuildinfo` 缓存已仅删除本次自有临时产物，未纳入提交。

---

## 历史刷新结论（e1278b78e；由上方本轮结论取代）

本轮已执行 `git merge --no-edit main`，固定审计基线为 **main `e1278b78e` / 合并提交 `ef6290fdf`**，不是旧 `f23c98702`，也不是尚未集成的提供方分支。使用既有审计器扫描一次、从同一 JSON 渲染 [evidence.md](../../../../scripts/electron-migration/wiring-audit/evidence.md)；**未修改 audit.mjs、分类规则或测试实现**，未改任何插件/profile/契约，未运行 Rust。

### 计数与扫描边界

| 项 | 旧快照 `489dcf5e3` | 当前 main 实测 |
|---|---:|---:|
| 扫描范围内插件 / 提供的不同服务 | 35 / 70 | **35 / 85** |
| 无其他插件消费者 | 34 | **45** |
| 既有规则已分类的接线孤岛 | 23（16 未接 + 7 绕行） | **20（13 未接 + 7 绕行）** |
| 正常命令面 / 内部引擎（机器分类） | 10 / 1 | **10 / 1** |
| 新服务尚未进入既有分类规则 | 0 | **14 needs-review**，不是“已证明正常”或“已证明死功能” |
| 悬空获取/注入的不同名字 | 15 | **14** |
| 顶层硬 inject 悬空 | 1 | **1：anki@1** |
| 顶层硬 inject 环 / 入口导入错误 | 0 / 0 | **0 / 0** |
| 扫描范围内 profile 遗漏 | 1（vfs-handlers） | **0**；不含下面的 electron 手工补项 |
| 诊断候选 / 条件与默认分支 / 测试提供声明位置 | 304 / 184 / 387 | **316 / 202 / 487** |

**不能把 20 当全应用孤岛总数**：既有分类器保留旧映射，新出现的 14 项明确留待判断。本轮按要求不重写工具/分类器。旧孤岛减少包含 `websearch` → `webSearch` 且被 MCP 消费（browser/index.ts:55,73；mcp/index.ts:57,69），`nativeAudio` 已被 L18 获取（media/index.ts:353,379）、`nativeImage` 已被 L02 注入（llm/index.ts:78,101）；不是只有“服务名改了”就算业务已全通。

**已核实的扫描盲区 / W21（F1 已获 C2 派工，不再派实现）**：

- `electron/index.ts:28-35` 的默认插件 **dstu.shell / F2-shell / 23 commands / startupGate** 已通过单独运行时导入读取 meta 确认，但不在当前 desktop.json。`host/profiles/generate.ts:18,59-62` 仅列 kernel + host/platform + host/plugins，既有审计器也只发现这些入口和 profile 项；因此两个工具的扫描范围内 `profileOmissions=0` / `generate --check` 绿，**都不能证明 shell 已装入**。
- `host/` 下没有 `startupGate` 消费者；`electron/startup-gate.ts:5-22` 有 ready/wait/guard 实现，但缺正式 Host 装配。需由 F1 装入真实 shell 插件并按启动完成边界连接 guard；Rust 对照 `src-tauri/src/lib.rs:835-838` 的 StartupReadyGuard，以及 :1913、:1985、:2125 的 shell 命令注册。这里不是要求 F2 重写 23 条命令。
- 人工补项后**已知至少 36 个插件入口、86 个提供服务名**（85 + startupGate），不混进既有工具的 35/85 输出，也不声称已成功 apply/启动。全应用已知仍有 **1 个 profile 遗漏：dstu.shell**。

### 当前全部 14 个悬空名字

| 名字 | 当前 main 文件:行 | 当前状态 / 责任（不重复派已实现能力） |
|---|---|---|
| anki@1 | host/plugins/chatanki/index.ts:93,181 | **main 仍硬阻塞**。`ade2dd598` 的 :454 已改硬 inject 为 anki，是 L24 修复待集成；不能提前称 Host 恢复。 |
| agent.tools@1 | host/plugins/chatanki/index.ts:190 | 旧 attach 仍在；真实 agentTools.registerToolExecutors 已在 main（agent-skills/index.ts:157-162），只留旧名清理/真实 dispatcher 集成，不再要求 L07 重写注册表。 |
| ankiGeneration@1 | host/plugins/anki/src/generation-port.ts:39,56 | **新增可达消费期待**；L16 已有生成编排，但仍等两方法业务端口；已有 llmStreaming 不等于完整 Anki 生成服务（见 W05 补项）。 |
| browserSurface | host/plugins/browser/index.ts:77 | 有 ShellBrowserSurface 默认实现；**非新增 provider 任务**。严格审计仍列这个可选查询。 |
| chat.send@1 | host/plugins/agent-orchestration/src/super-inbox-drain.ts:220 | 当前 main 仍无发送执行服务；保留 W01 集成项，不以 helper 改名代替执行链。 |
| embedding@1 | host/plugins/vfs-index/src/runtime-adapter.ts:48,143 | llmEmbeddingModels 已提供模型选择面，但不能自动当 embedding 调用端口；保留 W06 消费接点/剩余接口范围。 |
| llm.adapter-infos@1 | host/plugins/anki/src/model-adapters.ts:28 | **提供方已在 main**：llmAdapterInfos.listAdapterInfos（llm/index.ts:96，api.ts:50-53）；只待 L16 改消费键，不再索取 L01/L02 重发接口。 |
| pdf@1 | host/plugins/vfs-index/index.ts:168 | 仍等 PdfStageRuntime，不是 nativePdfium 同形别名（W07）。 |
| reviewPlan | host/plugins/qbank/index.ts:94 | **新增可达消费期待**；实际 L15 ReviewPlanService 已供命令局部使用，未提供该 Context 名（见 W05 补项）。 |
| storageStartupSync | host/platform/storage/index.ts:72 | main 仍无提供方；启动 purge/reset 次序继续走 W13 原协调任务，不能造 storage↔syncSupport 硬环。 |
| sync.provider@1 | host/plugins/backup/index.ts:105 | 新名 syncProvider 已正确获取；这是无效旧键 fallback，不是证明当前连接必失败。 |
| vector | host/plugins/vfs-index/index.ts:66；host/plugins/vfs-handlers/index.ts:314-315 | main 仍无 runtime vector provider；W07 保留。 |
| vfs.repo.core@1 | host/plugins/agent-orchestration/index.ts:205 | main 仍读旧键；L06 应接已经提供的 vfsRepo.todos，沿原 W09。 |
| vfsMaintenance | host/plugins/vfs-handlers/index.ts:202-203 | main 尚缺；L11 分支已发布该 provider（所读分支 tip `3d003c3cc`，index.ts:125），**待集成/消费者对接**，不是再要求 L11 重做。不能把 L12 的 vfsIndexMaintenance 当整套 VFS 维护接口同形替换。 |

已从悬空列表删除：**vfsMindmaps、vfsAttachments、vfsUnitBuilder**。前两项已绑定 `vfsRepo` 真仓储（vfs-handlers/index.ts:213-227,240-248）；后者由 L12 提供（vfs-index/index.ts:188）并在 L13b 子注入（:310-312）。

### 新增 14 个 needs-review 服务：不误报“提供方没做”

| 服务 | 已有发布证据 / 本轮判断 |
|---|---|
| llmAdapterInfos | llm/index.ts:96；W15 是消费方旧键，非提供方缺实现。 |
| llmEmbeddingModels、llmOcrModels、llmOcrRegions、llmOcrHedge | llm/index.ts:97-102，api.ts:54-105；外部消费图未接。W06 先复用这些已发布面，再精确登记真正剩余的 embedding/OCR 请求能力。 |
| llmStreaming、llmModel2Messages、llmProviderRequests、llmQuestionParsing、llmRag | llm/index.ts:91-95,103；api.ts:42-49,77-80,107-139。W01/W05 的集成条件已变化，不能继续笼统说“L02 没流式/请求接口”。singleShotCompletion 也不等于完整 raw-prompt/Anki 角色管线。 |
| vfsIndexMaintenance | vfs-index/index.ts:189 已提供；L13b 仍只订阅 vfsMaintenance，**现成索引维护面未消费**。C2 已派消费方对接，不再派 L12 重发。 |
| browserToolPolicy、webpageToolPolicy | browser/index.ts:94-95 已提供；没有其他插件 Context 消费，后续随既有 W02 roster/policy 接线核定，不凭名字存在宣称工具 dispatch 已通。 |
| mcp | mcp/index.ts:67-82 用同一 mcpService 启动/释放后端客户端，是已使用的**局部生产实例**；没有外部 Context 消费不代表功能死岛。机器仍 needs-review，因为本轮未改旧分类规则。 |

### W01–W20 当前状态（只保留余项，不重复下发原实现）

路径缩写与下方历史清单相同：A=src-tauri/crates/dstu-agent/src/chat_v2/；V=src-tauri/crates/dstu-vfs/src/vfs/；S=src-tauri/crates/dstu-sync/src/；LL=src-tauri/crates/dstu-llm/src/；M=src-tauri/crates/dstu-memory/src/memory/。

| ID / lane | 当前状态、剩余调用点与接口 |
|---|---|
| W01 L03/L04/L06 | **main 执行主链集成未闭合**。Rust A/handlers/send_message.rs:624-654、headless.rs:1275,1322 → chat/src/register.ts、chat-pipeline/index.ts、orchestration/super-inbox-drain.ts:220；继续原发送/headless/取消/持久化任务，不因新 LLM 服务出现就宣称主链跑通。 |
| W02 F1/L04/L03/L07 | **L07 registerToolExecutors 提供方已完成并进 main**；仅剩 roster、真实 dispatcher、各域工具/policy/context 接线。Rust src-tauri/src/agent_wiring/roster.rs:43-147 → host/kernel/agent-wiring.ts、chat-pipeline/index.ts；不得重派注册表实现。 |
| W03 L04/L06/L05 | **main outbox 消费仍缺**。A/handlers/workspace_handlers.rs:1844-1876、completion_dispatcher.rs:170,653 → worker 完成/派发；已有 agentCompletionOutbox 不重做。 |
| W04 L24/L16/L15 | **L24 ade2dd598 改名待集成；main 仍 anki@1**。L15 getReviewStatesForSession/Library 已在 review/api.ts:64-69、index.ts:40-44，不再要求 L15 新实现。余下 cards/documents/blocks/scope/APKG/regex hydrate 与真实工具执行仍按原任务接接口；单改 inject 不算工具已通。 |
| W05 L02 与 L14/L16/L24 消费方 | **部分公共能力已进 main，消费桥仍未接**。LL/model2_pipeline.rs:8570,8590 → llm 新服务与 qbank/src/grading-service.ts:69-78；该 adapter 仍固定返回“未发布流式补全”。先适配现有 llmStreaming/request 面，只补未交付角色语义，不重写 SSE/鉴权。下方新增消费期待补到此既有任务。 |
| W06 L01/L02/L12/L18 | **模型配置/OCR 子服务已发布，消费点仍旧**。V/indexing.rs:4830,4910、multimodal_service.rs:170,538 → vfs-index/runtime-adapter.ts:48,143 和媒体 OCR；模型选择、候选、实际调用分别核定，不把“有 config API”当全量 embedding 端口。 |
| W07 F7/L12/L18/L11 | **vector/PdfStageRuntime/附件 processing 尚未接**。V/indexing.rs:1849-1850、pdf_processing_service.rs:1231-1556、handlers.rs:1337-1344 → index.ts:66,168、media/src/service.ts:251-262、vfs-repos/repository/attachments.ts:738-744。不得将桌面默认为无向量版本；沿原同步仓储/异步 native 边界协调。 |
| W08 F7/各消费者 | **部分前进，保留其余**：nativeAudio 已在 L18 消费、nativeImage 已在 L02 消费；仍无外部消费的 nativeHeic/OfficeText/Pdfium、以及七类绕服务实现沿原任务核对。F7/各 lane 不重复实现已交付能力；Office 文本接口不冒充 Excel 写接口。 |
| W09 L13b/L11/L12/L06 | **导图/附件真仓储接线、vfsUnitBuilder 悬空已关闭**。Rust V/handlers.rs:1649-1978,5088-5351 → L13b index.ts:213-248。L12 vfsIndexMaintenance 已提供未消费，L11 vfsMaintenance 是分支待集成；保留维护/事务接点与 L06 repo 旧名，不重派已完成部分。 |
| W10 L05/L04/L06 | **main runtime-root/task/sleep 消费边界仍保留**。A/runtime_roots.rs:1350、handlers/group_handlers.rs:130 → chat/index.ts:107-121、workspace/api.ts；分支交付按 C1 既有集成任务处理，不从旧报告再派一轮同实现。 |
| W11 F1/L17/L13b | **vfs-handlers profile 遗漏已关闭**，desktop.json:133-134 已纳入且生成检查绿；Memory 删除 capture/提交后 continuation 消费 vfsHooks 仍缺（M/delete_hook.rs:92-109 → memory/index.ts）。shell 遗漏另记 W21，不能合并成“profile 全绿”。 |
| W12 L21/L23 | **共享 try-acquire/release 分支已发布待集成**：8df888920 的 backup/api.ts:91-109。main api.ts:92-98 仍无该方法，所以 main 云写仍 fail-closed。L23 main index.ts:142-150 已 finally release，不再要求重写释放；保留 `'backup'/'restore'/'prune'` 与 L21 `'Backup'/'Restore'/'Prune'` 的 P03 契约对齐及等待型/DeletePropagation 余项。**delta-v2 接生产建议撤回**，见下一节。 |
| W13 L20/L20b/F3/L23 | **L20 消费与 API 已在分支，不要求重写**。b101677ca 的 sync/index.ts:71,86-103 注入并使用 syncSupport/syncProvider；api.ts:103,115-174 已有多库 apply、upload/download/format。main 仍旧 sync@1 窄面、syncSupport 无消费者。下一步为集成、同事务/codec/共享许可对齐；storageStartupSync 仍无提供方，沿原启动 reset 次序协调。 |
| W14 L19/F2 | **关闭旧 storage 注入缺口**：browser/index.ts:68 已 inject settings/storage/log。browserSurface 的 shell fallback 有真实实现，不新增 provider；它仍出现在严格缺名列表不代表功能必坏。 |
| W15 L16 | **提供方关闭，只待消费方**。LLM 已有 llmAdapterInfos.listAdapterInfos（api.ts:50-53、index.ts:96）；src-tauri/src/cmd/anki_cards.rs:20-24 → anki/src/model-adapters.ts:28 改读真实接口。C1 已派，不再索取 L01 重发。 |
| W16 L17/L02/L15/L12 | **evolution runner 已实现并接入，query_rewriter 两条 dead-in-rust 已批准关闭**。memory/src/service.ts:429-430 调 runThrottledEvolution，evolutionCycleHost :440-469 接真实存储/索引。只保留分类刷新、promotion、semantic dedup（:423-436）及相关角色/学习接口余项；**禁止重新激活 query rewrite**。 |
| W17 F3/F4/L02/L19/L18 | **公共 utility/后台生命周期消费余项保留**。src-tauri/src/commands.rs:6917,6934、lib.rs:1701,3264、file_manager.rs:902,1041 → budget/flags/noteAssets/backgroundTasks；不因相似 suite 或总数绿认定 F4 原 TESTMAP 闭合。 |
| W18 L10/L20b/L20 | **main notes.format.blocks/同事务 sync 原子面仍需 owner 接线**。S/data_governance/sync/note_history.rs:5,145 → notes/api.ts 与 sync-support/src/note-history.ts；不复制 notes 写 SQL 或测试 parser。按 C1/C2 已有任务推进，分支状态不代替 main。 |
| W19 F2/L06 | **OS 通知接点保留**。A/automations.rs:3112 → agent-orchestration/index.ts:195-229、shell op；成功后才写通知回执，不把 fail-closed 告警改成成功。 |
| W20 L02/L19 | **main 仍缺 llm.clearMcpToolCache/preheatMcpTools**。Rust src/cmd/mcp.rs:785-788,823-828 → mcp/index.ts:162-181；L19 已补 warn（不再说静默），但兼容 success/count=0 不等于真实副作用完成。mcpService 的发布不是这个 llm 方法缺口的修复。 |

W05 的两处新增可达期待不是额外重做任务：

- **ankiGeneration@1**：LL/model2_pipeline.rs:9799、src-tauri/src/commands.rs:3912-4026 → host/plugins/anki/src/generation-port.ts:23-34,39,56，要求 generateAnkiCardsFromDocument/processTaskAndGenerateCardsStream。L16 的生成编排已写，按 L02 已发布服务拼接并明确存储/usage/取消所有权；不为过门禁注册空旧名服务。
- **reviewPlan**：src-tauri/crates/dstu-qbank/src/qbank_grading/pipeline.rs:442 → qbank/index.ts:94、src/grading-service.ts:457。L15 已有局部 ReviewPlanService（review/src/review-plan-commands.ts:13-23），缺可复用的 getOrCreatePlan 公开消费面；不要复制 L15 的表写。

### W12 更正：原 Rust 零生产接线，不为消孤岛启用 delta-v2

本轮只读检索全 src-tauri 的 publish_verified_staging / restore_snapshot_to_staging：除定义与测试引用外，无生产调用；不是仅采信 TS 文件头。

1. `src-tauri/crates/dstu-sync/src/cloud_storage/mod.rs:23-47` 明确 experimental 隔离、只有裸 mod 声明；实际命令 :513,:614 仍调用 whole-ZIP upload/download。入口定义为 delta_upload.rs:568、delta_restore.rs:521。
2. `src-tauri/tests/sync_r12_delta_upload.rs:815-904` **显式断言零生产调用**、整 ZIP put_file 及模块声明边界；restore 测试 :912-973 同样锁定零接线。本轮读源码，未运行 Rust。
3. 已有 `docs/dev/wave2-D-backup-v2-decision.md:11-22,40-58` 裁决“不排接线”，:18-19 与 :100-103 要保留相关测试；不是迁移 agent 可擅自启用的新功能。

因此 **撤回旧 W12 的“L23 接 delta-v2 实际生产入口 / L21 发布 inventory 以使它上线”建议**。现行 W12 仅处理活跃 ZIP 路径的共享许可和契约。记录为“原 Rust dead-in-production / experimental 隔离”，**不自动等于 obsolete 测试已审批**：如 L21/L22/L23 请求减少相应用例，必须提交精确 Rust 测试 ID、原断言和单独审批；目前不因“无生产接线”替他们批准删除/跳过协议测试。

与之分开，`migration/approvals.d/C1-app.json:43-44` 已逐 ID 批准 query_rewriter 的 `test_no_rewrite_short_query`、`test_parse_json` 为 dead-in-rust（所有 Rust 生产 search_with_rerank 调用传 false）。这两条 W16 不再是迁移遗漏，不复活死分支；不扩展豁免到其余 Memory runner。

### 验证记录与交付边界

- 现有 `audit.test.mjs`：**13/13 通过，0 fail，约 9.6 秒**；没有重写工具、测试或为数字归零放宽门禁。
- `audit.mjs --check --json`：**exit 1（发现问题的预期结果）**，85 services / 14 missing / 1 hard missing / 0 cycles / 0 loadErrors；只有 Node WASI ExperimentalWarning。errors 中历史 upstream_error 不当作本轮 agent 失败。
- 同一 JSON 渲染 evidence.md，未为生成不同格式重复扫描。新旧分类规则的历史行号不能当新实现证据，本节的当前文件行号与任务状态优先。
- `node host/profiles/generate.ts --check`：**exit 0**；范围盲区 dstu.shell 已在 W21 单列，不冒充完整 Host 启动验收。
- `npm run migration:ledger -- --check --no-write`：**exit 0**；commands 1058（A 91.5%、B 7.2%、C 0%），tests 8036（A 76.6%、B 0.7%），problems commands/tests/orphan registrations 均 0。**账本统计绿不是逐 ID 断言证明，更不等于 F4 的原测试映射或全应用 B 级已闭合**；本轮没有替 F4 勾验收。
- L21/L20/L11 的分支 API 与 L24 固定修复提交仅只读核对，未擅自合入它们；只合了 main。分支证据分别是 8df888920、b101677ca、3d003c3cc、ade2dd598，尚未进入本次固定 main 的部分一律记待集成。
- 只更新本报告、既有证据与工具 README 的扫描边界说明；未重派任何实现，也未对旧任务未变化部分重复要求重做。

---

<details>
<summary>历史快照 489dcf5e3（仅溯源；以下旧数字、旧行号、旧任务措辞均不得继续派工）</summary>

**以下是 70 服务 / 15 悬空时的旧报告，不是当前状态。尤其旧 W12“delta 接生产”、W16“恢复 query rewrite”建议已由上方现行结论撤回；已发布的 L07/L12/L15/L02 能力不得按旧描述重复派实现。**

日期：2026-11-04。历史范围：`f23c98702`（续跑检查点 `657d37165`）。以下保留原始发现以便与新 evidence/提交比对。

## 结论与口径

| 项 | 数量 / 结论 |
|---|---|
| 可运行导入的插件 | **35**：26 业务 + 8 平台 + 1 kernel；入口加载错误 0 |
| 插件声明提供的不同服务 | **70**；另有 kernel 根服务 app/commands/backendEvents/protocols/shell，不混入这个分母 |
| 没有其他生产插件消费者 | **34** |
| 其中正常命令面 | **10**，不能当死功能 |
| 其中本插件内部引擎 | **1**（lanceEngine） |
| 实质接线孤岛 | **23** = **16 完全缺消费接线 + 7 绕过服务/重复实现** |
| 悬空获取/注入的不同名字 | **15**，其中顶层硬 inject 悬空 **1**（anki@1）；其他含子注入、可选 get、旧名回退 |
| 顶层硬 inject 环 | **0**；notes ↔ vfs-repos 已在 `8176f4199` 解环，不能再报旧问题 |
| profile 遗漏 | **1**：dstu.vfs-handlers（入口在，desktop.json 无此插件） |

“消费者”包括真实 Context 读取、get/reflect.get、inject；排除 tests/、纯类型导入和提供方自己的读取。生产图是**全部插件入口导入可达图**，不声称这些插件全在当前 profile 成功启动；profile 遗漏和 apply 时序另列。`chatPipeline` 虽有消费者，也只消费到 plan gate 等 helper，**不等于发送执行链已接通**。

机器全量证据：[evidence.md](../../../../scripts/electron-migration/wiring-audit/evidence.md)（全部 meta / 服务边 / 悬空位置 / **304 个诊断候选、184 个条件/默认分支、387 处测试提供声明/调用** / 动态表达式）。测试数按位置计，meta 与 provide 可同时记录，不代表 387 个不同替身。这里列可分发的实际断点，而不是把所有 “unavailable” 都当缺陷。

## 使用与门禁

```sh
node --test scripts/electron-migration/wiring-audit/audit.test.mjs
node scripts/electron-migration/wiring-audit/audit.mjs --check
node scripts/electron-migration/wiring-audit/audit.mjs --json
```

`--check` 遇缺提供方名字、硬注入环或入口加载错误退出 1；孤岛不单独使门禁失败。严格模式也报告可选 seam 和已失效旧名回退，不静默豁免。接 CI 的命令就是第二行，不改现有 CI/package.json（超出本 lane 写权限）。

## 1. 全部 15 个悬空名字

| 名字 | 生产位置 | 判断与交付责任 |
|---|---|---|
| anki@1 | host/plugins/chatanki/index.ts:90,154 | **启动阻塞**：L16 只提供 anki。L24 改硬 inject 与 lookup；不是加旧名兼容层（W04）。 |
| agent.tools@1 | host/plugins/chatanki/index.ts:163 | 旧名 attach。agentTools 已有，但缺 registerToolExecutors；改名也不足以让 ChatAnki 可执行（W02）。 |
| vfs.repo.core@1 | host/plugins/agent-orchestration/index.ts:205 | L11 已提供 vfsRepo，L06 仍读旧名，通知待办交付拿不到 todos（W09）。 |
| sync.provider@1 | host/plugins/backup/index.ts:105 | **失效回退**，新名 syncProvider 已被上一行正确获取；不是当前草稿连接必坏。L21 删除无提供方的旧键回退（W12）。 |
| chat.send@1 | host/plugins/agent-orchestration/src/super-inbox-drain.ts:178,220 | 根本没有 SendMessagePipeline 服务，不是 chatPipeline 的简单拼写替换（W01）。 |
| embedding@1 | host/plugins/vfs-index/src/runtime-adapter.ts:48,143 | L02 缺真正调用 embedding 的公共面；L01 llmMultimodal 已提供但无生产消费者（W06）。 |
| pdf@1 | host/plugins/vfs-index/index.ts:166 | 等待的是页处理运行时，不是 F7 nativePdfium 的同形别名；需组装 PdfStageRuntime（W07）。 |
| llm.adapter-infos@1 | host/plugins/anki/src/model-adapters.ts:28 | L16 等适配器枚举，L01/L02 未发布此只读面（W15）。 |
| storageStartupSync | host/platform/storage/index.ts:69 | 本地 purge 后同步状态复位入口缺提供方；只在测试提供（W13）。不能直接给 storage 增加顶层 syncSupport 依赖，会反向依赖 storage。 |
| vector | host/plugins/vfs-index/index.ts:64；host/plugins/vfs-handlers/index.ts:301 | F7 vector 目录只有 api.ts，无运行时插件。L12 在 apply 时捕获 undefined 后常驻 disabled，后续晚发布也不会自动恢复（W07）。 |
| vfsMaintenance | host/plugins/vfs-handlers/index.ts:202 | 表所有者原子写业务面未发布，测试桥替代（W09）。 |
| vfsMindmaps | host/plugins/vfs-handlers/index.ts:212 | **已有实现但接错面**：vfsRepo.mindmaps 在 L11 index.ts:50 已提供，不存在独立 vfsMindmaps 服务；L13b 适配现有仓储（W09）。 |
| vfsAttachments | host/plugins/vfs-handlers/index.ts:232 | 同上：vfsRepo.attachments（L11 index.ts:49）已提供，需绑定 conn/blobsDir，不要另造同功能孤岛（W09）。 |
| vfsUnitBuilder | host/plugins/vfs-handlers/index.ts:297 | L12 尚未暴露 syncResourceUnits 业务入口（W09）。 |
| browserSurface | host/plugins/browser/index.ts:77-78 | **可选扩展口，不是证实的功能缺陷**：已有 ShellBrowserSurface(ctx.shell) 默认实现。F2/L19 确定是否真需要发布覆盖服务；不应为了数字归零造替身（W14）。 |

所有旧名逐字匹配，不做 `@1` 去尾猜测。`sync@1` 则确有生产提供方，不属于悬空名；类型声明里的 notes@1 也没有自动算作提供方。

## 2. 34 个无其他插件消费者服务的逐项分类

### 正常命令面（10；不是“前端直接读 Context”）

| 服务 | 真实调用证据 |
|---|---|
| agentSkills | host/plugins/agent-skills/index.ts:208-259：skill_* 命令调用同一 skills 实例；工具执行路径仍需 W02。 |
| browser | host/plugins/browser/index.ts:92-135：browser_* 命令调用 browserService。 |
| diagnostics | host/platform/diagnostics/index.ts:23-31：包管理器命令调用 service。 |
| dstu | host/plugins/vfs/index.ts:98-99：暴露 parseDstuPath 与 dstu_parse_path 共用实现。 |
| governance | host/plugins/backup/index.ts:107-108,117-130：数据治理命令。 |
| media | host/plugins/media/index.ts:126-187：媒体/TTS 命令；PDF 等未接功能单列 W07/W08。 |
| memory | host/plugins/memory/index.ts:90-245：记忆命令；后写维护缺口单列 W16。 |
| plugins | host/kernel/plugins.ts:80-118：plugin_* 命令调用 manager。 |
| sync@1 | host/plugins/sync/index.ts:73-103：同步管理命令调用 service；完整 SyncManager 仍缺 W13。 |
| translation | host/plugins/translation/index.ts:22-52：五个翻译命令与服务共用 commands；OCR 未实现见 W06。 |

另 **lanceEngine** 为本插件内部引擎：host/plugins/vfs-index/index.ts:65-67,160-175 已把局部实例送入 VFS LanceStore；没有跨插件读取不代表该局部引擎没人调用。当前 disabled 的原因是 vector 缺失，不是这个服务名无人读取。

### 完全缺消费接线（16）

| 服务（提供方） | 应有消费者 / 接线任务 |
|---|---|
| agentWorkspaceTools、agentVfsResolver（L05） | L03/L04 的执行器花名册、context refs 编译（W02）。 |
| agentCompletionOutbox（L05） | L04 worker 完成路径、L06 完成派发器（W03）。 |
| chatankiTools（L24） | L07 注册表、L03 dispatch（W02/W04）。 |
| websearch（L19） | L03 builtin retrieval executor（W02）；搜索命令自身虽可运行，发布的工具服务无人消费。 |
| llmOcr、llmMultimodal（L01） | L02 模型路由、L12 检索/embedding、L18 OCR（W06）。 |
| nativePdfium（F7） | L12 页流水线、L18 PDF/OCR（W07）。 |
| nativeAudio、nativeHeic、nativeImage、nativeOfficeText（F7） | L18 解码/转换/文档解析（W08）。其中 Office 文本已有 F7 能力，Excel 编辑不是 NativeOfficeText 的现有方法，仍要对方补接口。 |
| syncSupport（L20b） | L20 SyncManager（W13），不是只装插件就算接通。 |
| vfsHooks（L13b） | L17 Memory 删除延续 hook（W11）。 |
| backgroundTasks（F4） | L04 completion dispatcher、L06 自动化、Host 关闭追踪（W17）。 |
| noteAssets（F3） | L18/笔记资源导入与路径解析（W17）。 |

### 实现绕过服务 / 重复实现（7）

| 服务 | 绕行证据与处理 |
|---|---|
| nativeFsrs | host/plugins/review/src/fsrs-scheduler.ts:11,106-111 直接导入 F7 fsrs 实现。算法确实有人调用，但 profile 覆盖 nativeFsrs 不生效（W08）。 |
| nativeRegex | host/plugins/agent-workspace/src/tools/code-navigation.ts:17、host/plugins/notes/src/canvas-commands.ts:5 直接导入。L24 transform-executor.ts:543 另等工具上下文里的 nativeRegex，生产 hydrate 没有注入它（W04/W08）。 |
| nativeStarlark | host/plugins/agent-skills/src/tools/ptc-runtime.ts:12 直接导入，且工具花名册未接（W02/W08）。 |
| nativeCompression | host/plugins/anki/src/apkg-import-zstd.ts:4,68-74 直接 node:zlib；接 F7 时必须保留现有 windowLog / 输出上限语义，不能只换函数名（W08）。 |
| nativeProtobuf | host/plugins/media/src/bilibili-grpc.ts:6,24-65 自己实现 protobuf/gzip，未消费 F7 的 encodeDmViewRequest/decodeDmViewReply（W08）。不是 APKG protobuf 的同形通用接口。 |
| featureFlags | host/plugins/browser/index.ts:11,316-320 使用自己那份 FeatureFlagManager，而 F3 同能力发布未消费（W17）。 |
| injectionBudget | host/plugins/llm/index.ts:15-18,205 使用自己那份 InjectionBudgetManager，F3 版本孤立（W17）。 |

这些 7 项是可替换服务接线缺陷，不可据此声称算法完全未迁移。正常命令面也仍可能有局部方法未发布；服务级图只回答连接关系。

## 3. 按断点分发的可执行清单（Rust 调用点 → TS 目标）

下表路径缩写仅为可读性：

- **A** = `src-tauri/crates/dstu-agent/src/chat_v2/`
- **V** = `src-tauri/crates/dstu-vfs/src/vfs/`
- **S** = `src-tauri/crates/dstu-sync/src/`
- **LL** = `src-tauri/crates/dstu-llm/src/`
- **M** = `src-tauri/crates/dstu-memory/src/memory/`

所有“发布”指在提供方 api.ts 定义并由生产插件实例供给；消费方不复制对方实现。表中是**待协调者分配的任务**，本审计没有代改这些文件。

| ID / 优先级 | 主责 lane（协作方） | Rust 文件:行 → TS 目标调用点 | 要发布/连接的接口与完成条件 |
|---|---|---|---|
| **W01 / P0** | L03 + L04（L02、L06） | A/handlers/send_message.rs:624-654、A/headless.rs:1275,1322 → host/plugins/chat/src/register.ts、host/plugins/chat-pipeline/index.ts、host/plugins/agent-orchestration/src/super-inbox-drain.ts:220 和 index.ts:190-193 | L03 发布真正 send/retry/continue/compact、headless 执行面（目前 ChatPipelineService 只有 helper）；L04 接命令/流注册/取消/事件与持久化，提供 SendMessagePipeline / runHeadlessTurn 供 L06。新名按 camelCase 协商，不把不存在的 chat.send@1 直接改成 helper 服务就结单。 |
| **W02 / P0** | F1 + L04/L03（L05、L07、L10、L14–L24） | src-tauri/src/agent_wiring/roster.rs:43-126,128-147；src-tauri/src/agent_wiring/services.rs:20-31 → host/kernel/agent-wiring.ts、host/plugins/chat-pipeline/index.ts、host/plugins/agent-skills/index.ts:146-175 | 建真实 executor roster / dispatcher，连接 agentWorkspaceTools、agentVfsResolver、chatankiTools、websearch 及 notes.tools 等各 lane executor。L07 agentTools 需发布 registerToolExecutors 或共同确定注册表接口（当前没有该方法）；L03 调执行器而不只返回 schema。用已有 verifyRosterCoverage 校验 specific executor 覆盖，不以 General 兜底假通过。 |
| **W03 / P0** | L04 + L06（L05） | A/handlers/workspace_handlers.rs:1844-1876,1937,1981；A/completion_dispatcher.rs:170,653 → host/plugins/chat/src/workspace-actions.ts、host/plugins/agent-orchestration/index.ts | 用已发布 agentCompletionOutbox.enqueue/claimPending/markDelivered/releaseClaim；补 worker 生命周期与完成派发，成功持久化后才标投递，启动恢复 claim。L05 无需再复制一份表操作。 |
| **W04 / P0** | L24（L16、L15、L04、F7） | src-tauri/src/chat_v2/tools/chatanki_executor.rs:2407,2664,6234,9991 → host/plugins/chatanki/index.ts:90-135,154、src/transform-executor.ts:543 | 先 anki@1→anki 解启动阻塞；L16 发布 cards/documents/preferenceMemory/apkgImporter/apkgVfs 等真实仓储业务面；L04 发布 chatBlocks、会话资源所有权/worker 只读 scope；L15 发布 getReviewStatesForSession；L02 raw prompt 见 W05。hydrate 原生 regex 与工具 context。不要把测试 CardStoreDouble 搬生产。 |
| **W05 / P0** | L02（L01、L03、L10/L13b/L14/L17/L24） | LL/llm_manager/model2_pipeline.rs:8570,8590；V/todo_handlers.rs:697 → host/plugins/llm/api.ts:42-66、host/plugins/chatanki/index.ts:128-134、host/plugins/vfs-handlers/src/todo.ts:696-699 | 发布模型单次/流式/raw-prompt 调用、Anki 专用调用、practice grading、工具 schema 规范化的真实接口；保留取消、usage、路由。当前 LLMManager 只公开配置与取消等面，不能用 getApiConfigs 替代调用。L03/W01 和 L17/W16 共同依赖此项。 |
| **W06 / P0** | L02 + L01（L12、L18、L04） | LL/llm_manager/mod.rs:7405,7671；V/multimodal_service.rs:170,538；V/indexing.rs:4830,4910 → host/plugins/llm/index.ts、host/plugins/vfs-index/src/runtime-adapter.ts:46-100,141-168、host/plugins/chat/index.ts:124-130 | 消费现成 llmOcr / llmMultimodal，发布文本/多模态 embedding、OCR adapter/raw prompt、候选与 observation。L12 改 embedding@1 获取并适配 OCR 方法：当前 media.ocr 服务虽存在，却没有 getStructuredOcrCandidates/observeImage/ocrImage，直接改名仍会空候选或抛错。translation/index.ts:53-54 的 OCR 固定失败也需此接线。 |
| **W07 / P0** | F7 + L12（L18、L13b、F1） | V/indexing.rs:1849-1850；V/pdf_processing_service.rs:1231-1556,3526；src-tauri/crates/dstu-docs/src/pdfium_utils.rs:147 → host/platform/vector/、host/plugins/vfs-index/index.ts:64,166-173、src/pdf-service.ts:220、host/plugins/media/src/service.ts:251-262 | F7 发布 vector.connect 实现；L12 组装 PdfStageRuntime（PDFium + image codec + OCR），不把 nativePdfium 伪装成 pdf@1。L18 使用已发布 nativePdfium 消除固定失败。把必需依赖放进 inject 或可重连子 fiber，避免 apply 时捕获永久 undefined；桌面不能默认当 mobile-slim 无向量版本。 |
| **W08 / P1** | L18/L16/L15/L10/L05/L07（F7） | src-tauri/crates/dstu-media/src/media/decoder.rs:165、media/pipeline.rs:193、media/bilibili_transport/grpc.rs:59；src-tauri/crates/dstu-docs/src/document_parser.rs:814,859；src-tauri/crates/dstu-anki/src/apkg_importer_service.rs:945 → host/plugins/media/src/document-parser.ts:708-762、bilibili-grpc.ts、host/plugins/anki/src/apkg-import-zstd.ts、各直接 native import 点 | L18 消费 nativeAudio/nativeHeic/nativeImage/nativeOfficeText/nativeProtobuf；各 lane 经 Context 获取 nativeFsrs/nativeRegex/nativeStarlark/nativeCompression，不绕过 profile 替换。F7 的 Office 文本接口不包含 XLSX 编辑/Office 生成，需补相应读写接口后再接，不能宣称现有 NativeOfficeText 已覆盖全部。 |
| **W09 / P0** | L13b + L11/L12（L06） | V/handlers.rs:1649-1978,5088-5351,5860-6020；V/index_service.rs:285-354,375-414 → host/plugins/vfs-handlers/index.ts:202-234,297、src/maintenance-needs.ts:10-36、src/index-admin.ts:77-80；host/plugins/agent-orchestration/index.ts:205 | L13b 把 vfsMindmaps/vfsAttachments 接到**已有 vfsRepo.mindmaps/attachments**，显式绑定 conn/blobsDir；L11/L12 发布维护原子写业务面（整个事务由所有者执行）、syncResourceUnits/processPendingBatch；L06 旧 repo 名改 vfsRepo。不要把 pending-maintenance-provider.ts 里的跨所有者 SQL 当作生产 provider 搬过去。 |
| **W10 / P1** | L05（L04、L06） | A/runtime_roots.rs:1350；A/handlers/group_handlers.rs:130；src-tauri/src/agent_wiring/roster.rs:128-147 → host/plugins/chat/index.ts:107-121、host/plugins/agent-workspace/api.ts:93-129 | 发布 runtimeRootById/resolveRoot 的会话感知只读面，接分组 defaultRuntimeRootId 校验。L04/L06 所需 task/sleep/agent runner 也必须公开成业务接口，而不以 coordinator 类里私有字段存在为已交付。worker 执行链依赖 W01/W03。 |
| **W11 / P0** | F1（L13b、L17） | src-tauri/src/lib.rs:2631-2638；V/handlers.rs:659；M/delete_hook.rs:92-109 → host/profiles/generate.ts、host/plugins/vfs-handlers/index.ts:266-273、host/plugins/memory/index.ts | F1 在集成后重新生成 desktop profile，纳入 vfs-handlers，不手改生成清单。L17 注册 Memory note-delete 延续 hook 到 vfsHooks；删除时 capture 与提交后 continuation 的语义都要保留。现在 vfsHooks 没消费者且提供插件也未入 profile。 |
| **W12 / P0** | L21（L23） | S/cloud_storage/mod.rs:420,561,721；S/cloud_storage/delta_upload.rs:599；S/cloud_storage/delta_restore.rs:424,478 → host/plugins/backup/api.ts:92-98、host/plugins/sync-providers/index.ts:118-126、src/delta_upload.ts:92-94 | L21 发布共享 tryAcquireOperation(kind) + release 的生命周期守卫和 buildCrossChecked(stagingRoot) inventory，L23 使用真守卫。现有所有受 guard 控制的云备份/恢复/裁剪均 fail-closed。v2 upload/restore primitive 不能因测试存在就算已接命令（文件头明确无生产调用）；L23 接实际入口与 L21 staging。L21 顺带去掉 index.ts:105 的旧名回退。 |
| **W13 / P0** | L20（L20b、L23、F3） | S/data_governance/sync/note_history.rs:217,433；state.rs:528；src-tauri/src/lib.rs:1021 → host/plugins/sync/index.ts、host/plugins/sync-support/index.ts、host/platform/storage/index.ts:68-71 | L20 的生产 SyncManager 消费 syncSupport.state/tombstones/noteHistory/pomodoroCounts/conflicts 与 syncProvider；提供 storageStartupSync.resetDefaultAfterLocalPurge。F3 启动 purge 发生在 storage 正式发布前，初始化 reset 不能依赖等 storage 才启动的插件：由 F1/F3/L20 装配不依赖业务库的 reset port，或共用公开平台 API，不能制造 storage↔syncSupport 新硬环。 |
| **W14 / P1** | L19（F2、F1） | src-tauri/crates/dstu-browser/src/cmd/browser.rs:111-129、browser/window.rs:560 → host/plugins/browser/index.ts:71,77-83、src/surface-host.ts:57-72 | browserSurface 的 default shell 路径是正确的 fallback，不列“必须实现一个新 provider”；F2 已在 electron/main.ts:452、electron/shell/browser-protocol.ts:345-360 接对应 shell ops。另 browser 在 apply 中直接使用 ctx.storage，却只 inject settings，需声明 storage 依赖避免晚装/重载时序断点。 |
| **W15 / P1** | L16（L01/L02） | src-tauri/src/cmd/anki_cards.rs:20-35 → host/plugins/anki/src/model-adapters.ts:27-28、相应命令 handler | 提供 listAdapterInfos（可作为现 llmAdapters 的公开方法，由 L01 提供适配器注册表顺序）；L16 改读真接口，删除悬空 llm.adapter-infos@1 的期待。不要返回测试静态列表来替代动态注册表。 |
| **W16 / P1** | L17（L02、L15、L12） | M/service.rs:726,761；M/evolution.rs:14-17 → host/plugins/memory/src/service.ts:414-434、src/search-store.ts:55 | 接分类刷新、evolution cycle、promotion、semantic dedup、query rewrite，不只 warnOnce。依赖 W05 完成调用面，L15 profile/learning 输入与 L12 向量清理按现有预算/隐私开关接入。memory 命令活着不代表这些后台维护已运行。 |
| **W17 / P1** | F3/F4（L02、L18、L19、L04/L06） | src-tauri/src/commands.rs:6917,6934；src-tauri/src/lib.rs:1701,3264；src-tauri/crates/dstu-storage/src/file_manager.rs:902,1041 → host/platform/storage/index.ts:75-102、host/plugins/llm/index.ts:205、host/plugins/browser/index.ts:316、host/platform/diagnostics/index.ts:18-20 | L02/L19 消费统一 injectionBudget/featureFlags 而非重复 manager；L18/笔记资源路径消费 noteAssets；L04/L06 用 backgroundTasks 追踪 fire-and-forget 并由 Host 关闭等待。提供方接口已存在，先适配消费方，不新建重复服务。 |
| **W18 / P1** | L10（L20b、L20） | S/data_governance/sync/note_history.rs:5,145；src-tauri/crates/dstu-notes/src/notes_exporter.rs:1016 → host/plugins/notes/api.ts:63-70、host/plugins/sync-support/src/note-history.ts:201 | Notes.format 缺 blocks 的公开能力；由 L10 发布真实 Markdown block parser，L20b 接入缺失 block 的 relation invalidation。不能把 tests/fake-notes.ts 的简单 parser 当正式实现。 |
| **W19 / P1** | F2（L06、F1） | A/automations.rs:3112（system_notification 策略） → host/plugins/agent-orchestration/index.ts:195-229、electron shell handler | 发布带通知禁用策略/结果的 OS 通知 shell op 或服务；L06 成功送达后才写通知回执。当前仅 warn 不写成功回执是正确 fail-closed，但功能确实没接，保留这一差异而不是吞掉警告。 |
| **W20 / P1** | L02（L19） | src-tauri/src/cmd/mcp.rs:785-788,823-828 → host/plugins/mcp/index.ts:108-118、host/plugins/llm/api.ts | L02 发布 clearMcpToolCache / preheatMcpTools 的真实公共面（含调用窗口的工具清单请求）；L19 不再在方法缺失时直接返回 success 或 count=0。Rust 虽禁用 backend MCP，仍显式执行缓存清理和前端工具清单预热，不能拿禁用说明当省略副作用的依据。 |

W10 的 TS runtime-root 缺口与 W14 的 shell fallback 属于不同接口；后者没有虚构一个不存在的 Rust 服务名。新 TS 接口命名由 F5 协调，但必须保留 Rust 调用语义，不为过门禁增旧名别名。

W07 还包含 **L11 附件上传 → PDF 预览**：`V/handlers.rs:1337-1344` 调上传业务；TS `host/plugins/vfs-repos/index.ts:49` 用无 processing 适配器的 `new AttachmentRepo()`，`repository/attachments.ts:738-744` 因而对有效 PDF 固定抛 “PDF processing adapter not wired”。L11/L12/L18 应把文档加密检测、同步 renderPdf/text extraction 的处理端口接入附件仓储；若 F7 现接口异步，需同时明确同步仓储与异步原生之间的调用边界，不能把 Promise 当 PdfPreviewResult。

## 4. 测试桥与降级的证据

全量位置见 evidence.md。以下是会让“单 lane 测试绿、生产接线仍断”的典型实例，不是批评使用单元测试替身本身：

| 测试位置 | 补的能力 | 生产断点 |
|---|---|---|
| host/plugins/chatanki/tests/service-wiring.test.ts:42-46 | anki@1 仓储集合、带 registerToolExecutors 的 agentTools | 实际 anki 改名且接口只有模板/AnkiConnect 等；实际 agentTools 无此注册方法（W02/W04）。 |
| host/plugins/chatanki/tests/wired-executors.test.ts:43-59,62-86 | CardStoreDouble 同时充当 cards、reviewStates；ChatBlockStoreDouble | 直接执行 executor 并传 ToolExecutionContext，不证明 ChatAnkiToolsService.hydrate 或正式 roster 连通（W04）。 |
| host/plugins/vfs-handlers/tests/pending-maintenance-provider.ts:14,51 | vfsMaintenance 服务，测试可在本地执行拟议 SQL | 无生产提供方；应交表所有者发布原子操作（W09）。 |
| host/plugins/vfs-handlers/tests/mindmaps.test.ts:25、attachments.test.ts:20 | vfsMindmaps/vfsAttachments | 生产应适配已发布的 vfsRepo 子仓储，而非继续等两个独立服务（W09）。 |
| host/plugins/vfs-index/tests/commands.test.ts:91-154,202-234 | vector.connect → 测试 engine | 正式 F7 没有 vector provider，apply 选择 disabled（W07）。 |
| host/plugins/anki/tests/model-adapters.test.ts:22 | llm.adapter-infos@1 的 ADAPTER_INFOS | 正式无提供方（W15）。 |
| host/platform/storage/tests/startup.test.ts:17、staged-upload.test.ts:157 | storageStartupSync.resetDefaultAfterLocalPurge | 正式 purge 后复位服务缺失（W13）。 |
| host/plugins/vfs-index/tests/embedding.test.ts:27-35 | 额外测试 helper embeddingRuntime | 这是测试局部服务，不算生产提供方；正式 runtime-adapter.ts 仍等 embedding@1（W06）。 |

已确认的典型永久降级/失败：

- L06 自动化 dispatch 固定抛 `not published yet`（index.ts:193），super inbox 等 chat.send@1。
- L12 index.ts:64-66 在 apply 取不到 vector 即永久选 disabled；runtime-adapter.ts:71-76 在 OCR 方法不匹配时返回空候选；:80,:166 embedding 固定缺失。
- L18 `OcrCordisService` 四个入口无条件抛 PDF 不可用（src/service.ts:251-262）；`document-parser.ts:708-731` 对 Rust 支持的 Office 类型报 UnsupportedFormat，即使错误文案没写“待接线”也是真断点。
- L13b requireMaintenance / mindmap / attachment / unit-builder 直接抛服务未发布；todo AI breakdown 固定返回 LLM raw prompt 不可用。
- L17 后写分类、evolution、promotion、dedup 只 warn（src/service.ts:414-434），query rewrite 警告后用原 query（src/search-store.ts:55）。
- L19 reload/preheat MCP 的可选方法判断后静默 success/count=0（index.ts:108-118），无 “not available” 文案；已经加入 Context 来源条件/默认值分支扫描，不只搜错误字符串（W20）。

**不算新的断点**：notes↔vfs-repos 旧硬环已解；Chat 的 ctx.inject(chatPipeline/agentApproval/agentAutomation/agentWorkspace/llm/agentSubagent) 是已接的延迟订阅，其缺失分支是合理生命周期防护，不自动算“从没接”；AnkiConnect 未打开、维护模式、移动平台不支持也不能仅凭错误字样判迁移失败。

## 5. 按 lane 的分发表

| 主责/参与 lane | 任务 |
|---|---|
| F1 kernel / profile | W02 roster 装配；W11 重新生成 profile；W13 启动 reset port 次序；W17 关闭追踪 |
| F2 shell | W14 浏览器 shell/default seam；W19 OS 通知 |
| F3 storage | W13 purge reset 启动次序；W17 utility 服务消费收口 |
| F4 platform | W17 backgroundTasks 与生命周期 |
| F5 contracts | W01–W20 新公开接口与 camelCase 名称确认，不造 @1 兼容层 |
| F7 native/vector | W07 vector/PDF；W08 缺失 Office 写面与 native 可注入性 |
| L01 providers | W06 OCR/多模态；W15 适配器枚举 |
| L02 manager | W05 完整调用面；W06 embedding/OCR；W17 budget；W20 MCP cache/preheat |
| L03 pipeline | W01 执行主链；W02 tools/context；W06/W07 依赖消费 |
| L04 chat | W01 命令/stream；W02 roster；W03 completion；W04 blocks/scope；W10 roots |
| L05 workspace | W02 tools/resolver；W03 已有 outbox 对接；W10 公开 roots/task/sleep；W08 regex |
| L06 orchestration | W01 headless/inbox；W03 dispatcher；W09 repo 改名；W19 通知 |
| L07 skills | W02 executor registry；W08 starlark |
| L10 notes | W18 format.blocks；W08 regex；W02 notes.tools |
| L11 repos | W09 现有仓储适配 + 原子维护面；W07 附件 PDF processing 端口 |
| L12 index | W06 embedding/OCR；W07 vector/PDF；W09 unit/batch 与维护 |
| L13 VFS / L13b handlers | W09 接已有子仓储；W11 profile/hook；W05 todo AI |
| L14 qbank | W05 判题调用、W02 executor 集成（可选 mastery/index 保留 Rust warn 语义） |
| L15 review | W04 session review snapshot；W08 FSRS；W16 learner profile |
| L16 anki | W04 cards/docs/APKG 公开面；W08 compression；W15 adapter infos |
| L17 memory | W11 删除 hook；W16 维护 runners；W02 工具集成 |
| L18 media | W07 PDF；W08 audio/image/HEIC/Office/protobuf；W17 assets |
| L19 browser/MCP | W02 websearch；W14 browser storage/shell；W17 flags；W20 cache/preheat |
| L20 sync + L20b support | W13 SyncManager + startup reset；W18 notes format 接入 |
| L21 backup | W12 guard/inventory/旧名回退 |
| L22 integration | 各任务完成后在真实 profile 中验证，不用跨域测试桥证明正式接线 |
| L23 providers | W12 guard/v2 实际入口；W13 SyncManager 对接 |
| L24 chatanki | W04 改名和 hydrate；W02 register/dispatch |

## 6. 验证记录与边界

- 已执行要求的 `git log --oneline -20` / `git status`；本 lane 是新工具，没有既有 Rust TESTMAP。工具自己的回归覆盖清单在 scripts/electron-migration/wiring-audit/README.md。
- `npm run migration:ledger -- --check --no-write`：exit 1；commands 1058（A 88.8%、B 1.8%、C 0%），tests 8036（A 70.3%、B 0.4%）；problems commands 0、tests 250、orphan registrations 0。未改全局账本或替其他 lane 修测试。
- `node --test scripts/electron-migration/wiring-audit/audit.test.mjs`：**13/13 通过**，0 fail，约 7.4 秒；包含真实 CLI 正常模式 0 / 缺失服务检查模式 1、profile 遗漏、无诊断字样的服务条件分支。
- 实际 `node scripts/electron-migration/wiring-audit/audit.mjs --check --markdown`：**exit 1（预期）**；生成 evidence.md，70 services / 15 missing / 0 cycles / 0 loadErrors。原生模块导入仅出现 Node WASI ExperimentalWarning，不是加载失败。不能把审计发现悬空当作工具失败。
- 这不是 A/B/C 全量验收：不装全部插件、不跑业务全量测试、不触真实用户数据；模块导入成功不代表 apply 成功，导入可达不证明每个方法确被调用。复杂动态名已列 unresolved；任意 JS 数据流不作穷尽证明。对于检出的每类实际断点，上表均给到责任 lane、Rust 调用关系、TS 接点和待发布接口。

</details>
