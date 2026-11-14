# X6 机械门禁审计

## 版本与口径（先读）

**最新读数优先级：** single-writer 已按架构师 15:19 追加要求，在合并固定 main `4525e11ac972a195e968d49eceb096f238117325` 后，仅刷新一次，使用 `6002c7fbd` 的 temp_sessions→integration 裁定；新计数与精确源码/规则 SHA 见文末“single-writer 全仓快照”及同一 JSON 的 snapshot/byLane。旧 202 不代表本轮存量。PR/AP 仍是 `8d7b05d14` 报告，不随本次刷新重算；其他门禁未重跑。以下旧基线段落保留作历史，不代表当前 main 或全部规则仍 report-only；账本否决与 SW/UD 待 infra 接入的权限区别见下一节。

- 扫描对象：分支 `ds-mig/X6-gate-checks` 的 `host/plugins/` 树，该树等于 main `2ee9a9cbe`（X6 只改 `scripts/electron-migration/gate-checks/` 与本文）。门禁代码版本 `a121d1566`（assert-parity 的 cfg 区分在其后的提交中）。
- 当前 main 是 `4c6cd1ba8`，已合入 L11/L12 等分支。下文样例是**基线 `2ee9a9cbe` 的状态**，不代表 main 现状。例如 L04 X6-SW-CHAT-01 已在候选 `796ec` 改为委托 owner，但尚未入 main；L13 createNote 的委托也只在候选上。合入后需要在新 main 上重扫。
- 全部数字都是**候选**，不是已确认的生产缺陷。`severity: info` 项（重复仓储、`as unknown as`、cfg 门控断言差、log-parity 全部）不触发 `--check`。
- 五个门禁都是 report-only，尚未接入 `integrate-parallel.mjs` 或 `ledger-core.mjs`。外部文件写权限已提交架构师审批，未获批准前不改。

## WP-C2-GATE-020：已证 stdio fixture 输入表达式误归因窄修

**结论：实现与定点反证完成，交 C2 独立审读。** 本节是工具候选的定向差分，不追改 C2 冻结全测/账本的旧工具读数。官方 lane-gate 的最终 tip/base、原 exit 与 job 回执随正式 `.oc-runs/board/wp/WP-C2-GATE-020.report.md` 交付；历史 RUN-016 不重做。

### 固定输入与范围

- 开工分支 `ds-mig/X6-gate-checks`，原 tip `ba552babcc908aa44d5b141949434566b39d4867`，工作树干净；正常 merge 固定 main `df2cd30a1cacf598df851f40d643bb12ceacc7f2`，merge tip `1d516b1aa4922ee2730cdb1e48343aaf76baf932`。全部命令 cwd 为本 lane 工作树。
- 已完整读 WORKER、任务卡、LANE、standard-v2、quality，以及 prod-reachable / reachability-graph / testmap / 原 5 测试。本 lane 没有独立 BLOCKERS.md / TESTMAP.md；外部事项在 LANE。main 的 `lib/lane-paths.mjs:44` 已核准目录权限。
- 改动仅 `gate-checks/fixture-inputs.mjs`、`gate-checks/prod-reachable.mjs`、`gate-checks/prod-reachable.test.mjs` 与本审计。生产图、ledger 标准/生成物、业务源码、TESTMAP、调度配置均无本包编辑。
- 协调者自动检查点 `5f317f6af312501a6011ec3cb8d1fa177a7bfbe6` 在 23:29:20Z 保存了 helper 与新增测试；已核实内容仍在 HEAD，未重写该提交。实现接入另作正常提交。

### 判定规则及边界

复用现有 `graph().program/checker` 的 AST/符号身份，仅识别以下**单次调用表达式**：

1. 同插件导入的无参调用直接初始化具名局部 `const`；该值的全部符号引用恰为两次读取 `command` / `env`，分别赋给**同一个**对象字面量的同名字段。引用按 checker 身份（含 shorthand 的值符号）收集，不靠变量名字；import alias 正常解析。
2. 对象无 spread、无重复字段，`type: 'stdio'`；`args` 是单元素数组，其值可直接或经 const 定位到真实 `node:url` 的 `fileURLToPath(new URL(相对字符串, import.meta.url))`。目标脚本实际存在，且是既有 `production()` 判定排除的测试资源。这里判定的是**被启动资源**，不是对该目录中的函数免检。
3. 描述符直接作为已解析、有函数体的 call/new 参数，其返回值直接（可经 await）落入 const。规则证明的是 command/env 在此表达式中的装配角色，不给 helper 增加生产图边，不把所有参数调用视为 fixture。
4. 每个排除项仍输出 `fixtureInputs`，包含原 Rust ID、symbol、原声明点、使用行、本地脚本与原因。相同导入在另一表达式/另一 case 被断言时仍计入被测符号。排除后没有可证受测生产目标的 case 为 `unknown`，即使共享 setup 中另有 reachable 符号，也不能借此签 reachable。

**明确边界：** 不推导一般跨函数数据流、动态脚本地址、namespace 调用、解构/可变变量或任意别名链；不把不符合此窄式的调用自动认作 fixture。这些仍走既有逐 case 图判定（有真实断开目标则 unreachable；未解析目标/动态分派仍 unknown）。额外返回值读取、变量传递/逃逸、直接断言、普通 `live(dead())` 均不能利用本规则消失。此处不是通用 fixture 分类器，也不证明测试的断言语义等价；后者仍由独立复核验收。

### 最小回归与原始作业

全部测试/类型检查/扫描经官方 jobs：

| 作业 | 内容 | 原 exit / 计数 |
|---|---|---|
| `20261105232511-ac8928` | 修前 `node --test scripts/electron-migration/gate-checks/prod-reachable.test.mjs` | 0；5 passed / 0 failed / 0 skipped |
| `20261105232511-848051` | 起点 `npx tsc -p tsconfig.host.json --incremental --tsBuildInfoFile .integration.tsbuildinfo` | 0；无诊断 |
| `20261105232837-1f537d` | 修后同一 node:test 文件 | 0；10 passed / 0 failed / 0 skipped / 0 cancelled |
| `20261105232553-afe21e` | 固定源码唯一修前定向扫描 | 0；22 ported，15 unreachable，4 unknown |
| `20261105232925-c01ac5` | 同选择集唯一修后扫描 + 逐 ID/完整 finding 差额断言 | 0；22 ported，14 unreachable，4 unknown |

原 `.log/.json` 在 `/home/dsdev/.oc-jobs/done/<job>.{log,json}`。原 5 测试的全部断言未改；新增 5 个测试含 7 个反证变体：同模块 dead 直接断言、live(dead())、返回值经变量传参、函数别名、返回值别名、额外字段断言、shorthand 逃逸、描述符直接作为断言对象；另验单符号跨表达式/跨 case 归因及 harness-only unknown。夹具实际写出 index/模块/TESTMAP/本地脚本后调用扫描器，没有 mock 图或手填扫描结果。

### 唯一固定 main 定向差额（逐 ID/符号）

选择集为原归因原件中不可达项所属测试文件，加 mcpbench：`llm/tests/settings_models_executor.test.ts`、`mcp/tests/mcpbench.test.ts`、`qbank/tests/qbank-read.test.ts`、`sync/tests/state.test.ts`（均位于 `host/plugins/`）。这是 4 文件/22 行的选择集，不称为新全仓读数。

完整原件：`/tmp/opencode/x6-gate020-before.json`、`/tmp/opencode/x6-gate020-after.json`、`/tmp/opencode/x6-gate020-diff.json`。按完整 finding 对象（含 testIds/declaration/message）逐项比较，**仅删除以下 1 项，无新增 finding，其他 finding 完全相同**；22 个行 ID 集合不变，unknown 的 4 行不变。

- 唯一状态变化 ID：`tests/mcpbench_integration.rs::test_mcpbench_websearch_dataset`，unreachable → reachable。
- 唯一移出受测符号：`currentStdioRuntime`，原声明 `host/plugins/mcp/equivalence/runtime.ts:100`，使用 `host/plugins/mcp/tests/mcpbench.test.ts:116`；现保留为 fixtureInputs 证据，脚本 `host/plugins/mcp/tests/fixtures/mcp-test-server.mjs`。
- 实际受测目标仍为原生产图中的 `createTransportForConfig`（`host/plugins/mcp/src/probe.ts:334`）及 `JsonRpcProbe`（同文件 `:89`）；未补 export/call 或更改任何业务测试。该 row 的 reachable 来自这些原有目标，不来自 runtime helper。

**保留的 14 个 unreachable 原 ID：** 以下前 13 条统一前缀为 `src/chat_v2/tools/settings_models_executor.rs::tests::`，完整 ID 与全部原声明点均在上述 before/after 原件：

1. `exposes_exact_tool_surface_with_expected_risk`
2. `profile_add_arguments_redact_api_key_before_crossing_boundaries`
3. `profile_add_fields_allow_api_key_but_nothing_else_sensitive`
4. `profile_add_validation_rules`
5. `sensitive_names_are_separator_and_case_insensitive`
6. `request_fields_and_database_rows_both_fail_closed`
7. `settings_values_use_exact_types_and_ranges`
8. `assignment_args_require_explicit_nullable_occ_value`
9. `model_directory_pagination_is_bounded`
10. `model_capability_matrix_matches_runtime_consumers`
11. `model_directory_projection_never_contains_runtime_secrets`
12. `assignment_update_is_atomic_and_occ_guarded`
13. `all_tool_strings_are_unicode_bounded`
14. `src/qbank_read/tests.rs::canonical_context_reads_current_questions_and_deduplicates_materials`

**TESTMAP 改动 0**，ported/pending 状态与行集合不变；未运行业务测试/完整 ledger，未据 15→14 或 A 涨幅签完成。首检查点已于 23:30Z 经 coord queue 交 C2；最终提交→正常 merge main→直接官方 lane-gate→wp-done，最终回执见本节首段的正式报告。

## WP-C2-RUN-016：固定 L04 候选的 Vitest RPC 退出定性

**结论：完成本包独立定性，候选仍未全绿。** 固定 L04 tip 的唯一低并发完整复验仍 raw1：77 files / 709 passed / 0 failed / 2 既有 skipped / Errors 1，与原 job 的 77 文件逐项一致。单 fork 没有消除 `onTaskUpdate` RPC 超时；不再复验、不改写原 raw1，不把本结果解释为 CPU 负载因果证据。L06 原红及最终红均为同签名运行器错误，非已报告的断言失败。

### 固定输入、恢复与原件保全

- L04 WP-168 tip：`7069af80b9e2622d9358bdd8fccb6962b40c7c40`；原官方 gate base：`676b298524095280d617b529e4e4993f07654453`。供方报告：`/home/dsdev/dev/deep-student/.oc-runs/board/wp/WP-168.report.md`。
- 本次恢复先查 git status / worktree list、X6 audit、全局 queue/running/done JSON：没有此前已提交的本包低并发复验，也没有本包 detached 树或审计段落。因此下面是唯一一次复验提交，不是恢复后重复投测。供应商 quota 故障不计业务失败。恢复时另发现旧会话已投递的无 `--vitest` ledger 作业 `20261105195949-ddeacc`；它不属于本包 RPC 证据，本会话没有续跑或重算账本。
- 原件目录：`/home/dsdev/.oc-jobs/done/`。L04 原 job 与下列 L06 jobs 的 `.json` / `.log` 已原样复制到独立 `/tmp/opencode/x6-run016-evidence/`；同处保留读取时的 L04/L06 selfgate JSON、L06 reflog、运行环境观测与文件集合。
- 任务卡要求的 `scripts/electron-migration/gate-checks/LANE.md` 已完整阅读；本 lane 没有独立 `BLOCKERS.md` / `TESTMAP.md`，外部事项在 LANE 中。本包不修改业务 TESTMAP，也不恢复旧 AUD-006。
- X6 工作分支开工正常 fast-forward 合并 main `f3753b68228afed1d70bb3422d681bddce6533e3`；这是审计交付树，不是受测 L04 树。main 上的官方 job / lane-gate 接口已只读核实。

### L04 原始退出与唯一复验

原 job `20261105192826-5650a8` 的 JSON 原始字段：

```json
{"cwd":"/home/dsdev/dev/ds-mig/L04-chat-session","cmd":["npx","vitest","run","-c","vitest.host.config.ts","host/plugins/chat/"],"submittedAt":"2026-11-05T19:28:26.709Z","startedAt":"2026-11-05T19:30:13.525Z","endedAt":"2026-11-05T19:38:31.477Z","code":1}
```

原日志 `:579-606`：

```text
Vitest caught 2 unhandled errors during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../deep-student/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../deep-student/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:635:17
 ❯ processTimers node:internal/timers:571:7
```

相同错误/堆栈出现两次；摘要为 **77 files passed / 709 passed / 0 failed / 2 skipped / Errors 2 / raw exit 1**。原件没有断言失败或业务异常栈；这只定性已报告的退出，不宣称全部业务行为正确，也不抹去 Vitest 的 false-positive 警告。

唯一复验 job：`20261105200637-9f3d37`，提交 `2026-11-05T20:06:37.589Z`，开始 `20:06:50.094Z`。真实 git detached worktree `/tmp/opencode/x6-run016-l04-7069af80b` 的 HEAD 核实为上述完整 tip，运行前 tracked/untracked status 均干净。仅沿项目既有 `node_modules` 链接到 `/home/dsdev/dev/deep-student/node_modules`，未安装/修改依赖；Node `v26.5.0`，Vitest 与 `@vitest/runner` 均 `3.2.7`，与候选 `package-lock.json` 锁定版本一致。

精确 job 命令（cwd 为上述 detached 树）：

```sh
env VITEST_MAX_FORKS=1 VITEST_MAX_THREADS=1 THREADS=1 npx vitest run -c vitest.host.config.ts host/plugins/chat/ --reporter=dot --reporter=json --outputFile.json=/tmp/opencode/x6-run016-evidence/l04-retest.json
```

由官方 `job.mjs submit` 提交、同 job `wait` 收取回执。环境设置放在命令内 `env`，因为 job 客户端不转存调用者环境，runner 会注入默认 forks/threads；只在 submit 外设置变量不够。只读 `/proc` 观测已保存 `runtime-env.json`：Vitest 主进程与当时唯一 `vitest 1` worker 均实际收到三个值 `1`。候选配置仍为 `pool: 'forks'`、`testTimeout: 30_000`；未增加 hook/RPC 时限或改动断言、业务预算。

**复验回执：`2026-11-05T20:26:34.907Z` 结束，raw exit 1。** 官方 job 的 JSON/log 已复制到同一私有目录。原日志 77 条文件完成行（`l04-original-files.txt`）与本次 JSON 的 `testResults[].name` 去掉各自 cwd 前缀后逐项比较：**77 对 77，missing=[]，added=[]**（`comparison.json`、`l04-retest-files.txt`）。受测树运行后仍干净。

```text
Vitest caught 1 unhandled error during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../../home/dsdev/dev/deep-student/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../../home/dsdev/dev/deep-student/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 ❯ listOnTimeout node:internal/timers:635:17
 ❯ processTimers node:internal/timers:571:7
 Test Files  77 passed (77)
      Tests  709 passed | 2 skipped (711)
     Errors  1 error
   Duration  1181.64s
```

JSON 的断言状态逐条计数为 passed=709、failed=0、skipped=2；两项 skipped 恰为 `ocr.test.ts:51,71` 的既有 macOS/Windows 原生 OCR 条件测试（标题分别为 `native OCR runs sequentially and joins only nonempty results without trimming` / `retains native OcrError Display and stops before later images`）。JSON `numTotalTestSuites=158` 含嵌套 suite，不是文件数；`testResults.length=77` 才是文件数。该 JSON 的 `success:true` 没有覆盖这次未处理错误；**整体结论仍为 raw1 / Errors1**，不以 JSON success 冒充全绿，也没有另做 reporter probe。

### 锁定源码能证明的机制

以下路径以共享 `node_modules/` 为前缀；关键 RPC 文件也已复制到私有证据目录。只读源码审读，没有重做 JSON reporter probe。

1. `@vitest/runner/dist/chunk-hooks.js:1453-1505`：任务更新按 100ms 节流，`sendTasksUpdate` 收集 `runner.onTaskUpdate` Promise；拒绝被保留，`finishSendTasksUpdate` 用 `Promise.all` 等待。因此测试结果已通过与结果上报 Promise 失败可以同时存在。
2. `vitest/dist/chunks/index.CwejwG0H.js:46-51`：runner 的 `onTaskUpdate` 经 `rpc().onTaskUpdate(task, events)` 发给主进程。这是测试运行器的任务状态上报，不是产品 RPC/业务调用。
3. `vitest/dist/worker.js:84` → `workers/forks.js:19-22` → `chunks/utils.CAioKnHs.js:25-41`：fork worker 使用 Node IPC / v8 序列化，无 timeout 覆盖；`chunks/rpc.-pEldfrD.js:42-55` 不把 `onTaskUpdate` 列为免回执 event，超时文案在 `:49-53` 构造。
4. `chunks/index.B521nVV-.js:3,21,53-71,132-142`：默认 RPC 时限 **60,000ms**；timer 回调调用 `onTimeoutError`，拒绝并删掉对应 pending RPC；正常响应处理才清 timer。已证含义是“该 pending RPC 在超时回调执行时尚未完成响应处理”，不能仅凭这一行区分发送/接收排队、主进程 reporter 等待、worker 事件循环阻塞或其他调度原因。
5. `chunks/coverage.DfSpMS-b.js:2503-2512` → `chunks/cli-api.DVe0nWUx.js:8876-8884`：主进程先更新任务状态，再等待逐事件 reporter 与 `onTaskUpdate` reporter 完成，之后 RPC 才能回执。`cli-api…:9647-9666,9893-9895` 会收集运行池错误并在存在未处理错误时设置 exitCode=1，独立于测试断言的 pass 数。
6. `chunks/coverage.DfSpMS-b.js:3719-3751` 确认 `VITEST_MAX_THREADS` / `VITEST_MAX_FORKS` 分别控制对应 pool；本次 forks=1 生效。原 job JSON 没有环境快照，不能把当前 runner 默认值冒称为原运行时实测值。

**未知范围：** 原始错误没有 task id、对应 RPC payload 或精确响应时间，无法从末尾错误栈唯一定位到某个业务测试/SQL/Host 操作，也没有 CPU 负载因果证据。此次同时改变并发、reporter、cwd 与运行时刻，且共享作业机其他任务仍在运行；即使绿也只是本次条件下未复现，不能单因子归因。没有证据把这两条错误派给 L04 业务 owner，也不自行批准隔离、忽略 unhandled errors 或豁免原红。

### L06 WP-169 只读交叉核对

brief 的 `c9167d8b` / 19:38 原红对应 **job `20261105193034-126837`**，而不是 19:38 提交的另一个 job。分支 reflog 记录 `c9167d8b21dc0207873eae969da771b6e2791cef` 于 `19:30:32Z` 合并，下一 tip `700a7f711` 于 `19:38:44Z` 合并；job JSON 运行区间 `19:36:00.511Z–19:38:22.075Z`。旧 selfgate 单文件已被后续 gate 覆盖，本次没有伪造旧 selfgate 备份；tip 关联依据 brief + reflog + 原 job 时间。原 base 为 `676b298524095280d617b529e4e4993f07654453`（c916 的 merge parent）。

三个已读取原件的 cwd 都是 `/home/dsdev/dev/ds-mig/L06-agent-orchestration`，命令均为 `npx vitest run -c vitest.host.config.ts host/plugins/agent-orchestration/`：

| job | 提交 / 开始 / 结束（2026-11-05 UTC） | 文件 / passed / failed / skipped / Errors | raw |
|---|---|---|---|
| `20261105193034-126837`（brief 原红） | 19:30:34.618 / 19:36:00.511 / 19:38:22.075 | 39 / 482 / 0 / 0 / 1 | 1 |
| `20261105193845-763322`（区分同名时刻） | 19:38:45.862 / 19:45:17.961 / 19:47:19.801 | 39 / 482 / 0 / 0 / 1 | 1 |
| `20261105195225-c8a942`（当前最终报告） | 19:52:25.845 / 19:52:26.096 / 19:54:16.539 | 39 / 482 / 0 / 0 / 1 | 1 |

三份日志均原样包含以下签名和同一 RPC 堆栈，无断言失败摘要：

```text
Vitest caught 1 unhandled error during the test run.
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 ❯ Object.onTimeoutError ../../deep-student/node_modules/vitest/dist/chunks/rpc.-pEldfrD.js:53:10
 ❯ Timeout._onTimeout ../../deep-student/node_modules/vitest/dist/chunks/index.B521nVV-.js:59:62
 Test Files  39 passed (39)
      Tests  482 passed (482)
     Errors  1 error
```

当前最终 selfgate：tip `e87480c4bcfeef026e7cb38276c10dd7f328a34a`、base `53aca35533b6704e3b1f2563c680aadb64130c71`、at `19:54:17.005Z`、`ok:false, failed:["tests"]`。与 L04 **签名同类**，但不因此认定根因同一。WP-169 报告将其归因 CPU 争用/认定“不属于本包”的文字超出这些原件所能证明的范围；交 C2 裁定，不按该文字自动豁免。本次没有复跑 L06 或修改其 WIP。

### 交 C2 的最窄处置建议与边界

- 将 L04 原 `5650a8` 与唯一复验 `9f3d37`、L06 原 `126837` 与最终 `c8a942` 归为“**相同 RPC 超时签名，根因未定**”集中记录；不将它们转换成断言失败工单，也不因同签名宣布根因相同。
- L04 继续保持固定候选 / tests gate 未绿，L06 保留其最终 tests gate 原红。已有其余 4 项 gate 的绿与局部测试证据仍仅覆盖各自范围；X6 本次审计的 lane-gate 不替代 L04/L06 的业务 gate，不授予隔离或集成豁免。
- 本包唯一新假设的实测结果是“单 fork + dot/json 条件下仍复现”。停止投测，不再消耗第二次完整复验，也不派业务 owner 调整断言、预算、hook/test/RPC 时限。若 C2 决定继续调查，最小新增证据应是获授权 runner 维护方记录同一个 RPC 的发送/响应处理时间与 worker/main/reporter 等待位置；这是后续授权事项，本包没有改共享 runner 或注入探针。
- 本包仅改本文；TESTMAP 无新增/改向，pending 前后不变（X6 无独立 TESTMAP）。未运行 Rust、未安装依赖、未修改实现/断言/skip/超时、未重算账本。供抽检：① `comparison.json` 的 77 文件集合与原/复验完整 log；② `chunk-hooks.js:1453-1479` → `rpc.-pEldfrD.js:48-53` → `index.B521nVV-.js:53-71` 的状态上报失败路径及 L06 两份原红。

## WP-C2-AUD-006：phase0 后 ledger --check 49 条测试问题与 14 条 unreachable 归因（只审计）

**结论：** 49 条都是真实的 B 级缺口，不是账本误报；其中没有一条是用例执行失败。按 evidence.json 分类为 S 44 / W 2 / M 3。46 条在 87b 已存在（44 S + 2 W）：S 是匹配用例 skipped，按 owner 为 F3 1、F4 2、L05 16、L23 20、L13 2、L18 2、L16 1；W 是 F4 两条整文件 merged 映射连带同文件的 Windows skipped。3 条 M 是 phase0 新增：F3 `ae7415784` 新映射的用例不在旧的 87b 全测报告里。14 条 unreachable 在 87b 与 967f 中逐 id 相同，phase0 没有新增或解除。unknown 从 3560 增到 3660，增加的 100 条全部来自 phase0 新增 ported 行。unknown 表示未证明生产可达：不作为可达证据，也不否决，不等于 3660 条失败。

### 原件与复算

| 项 | 87b 基线 | phase0 main 967f |
|---|---|---|
| 源码 | `87b1032a7b521fa74bfb7b7bbf8c4e07c69bb494` | `967f43c7547d1ed29a7e3d736b8118fb95d3661e` |
| 作业 | `20261105141455-9ea5bf`，exit 1 | `20261105141455-dd16ca`，exit 1；与 C2 原件 `20261105135406-f758b7`（exit 1）摘要逐项相同 |
| 命令 | 1058，A 100% / B 0% / C 0% | 相同 |
| 测试 A / B | 7145（88.1%）/ 7099（87.5%） | 7255（89.5%）/ 7206（88.9%） |
| 测试问题 | 46 | 49（无一条消失，新增 3 条） |
| orphan registrations | 4（`electron/tests/fixtures/raw-json-plugin.ts:21,25,26,27`） | 0（`20867bd7b` 将该 fixture 归为 test-only） |
| prod-reachable | ported 6372 / unreachable 14 / unknown 3560 | ported 6474 / unreachable 14 / unknown 3660 |
| TESTMAP 去向 | ported 6961 / merged 45 / obsolete 153 / pending 950 | ported 7066 / merged 50 / obsolete 153 / pending 840 |

- 两次 B 的输入是同一份全测 `.oc-runs/fulltest/latest.json`：head `87b1032a7`，at `2026-11-05T12:29:36.898Z`，sha256 `eabeda523f30123ac83e3c35d14bed76856fd51a373fdce76c42c2341c880a2e`；12588 tests / 12515 passed / 3 failed / 70 pending，`success=false`。复算前已把它复制到私有目录，避免并行全测改写输入。
- 复算方法：从两个提交 `git archive` 出私有快照，Rust/HEAD 读取固定到对应 SHA，只额外导出计算结果；ledger 代码在两个快照中均为 sha256 `3b738c75…2921a`。没有写 main 或 lane 的 `migration/ledger.json` / `LEDGER.md`，没有跑测试或编 Rust。私有证据在 `/tmp/opencode/WP-C2-AUD-006/`（before/after-ledger.json、evidence.json）。
- 输入全测的 3 个 failed 用例（`dstu-delete`、`dstu-copy` 的 qbank.examCascade，以及 `kernel/services.test.ts:364`）不在这 49 条中，它们没有对应 ported 行进入测试问题。三项修复是否清零要等 967f 新全测（`.oc-runs/fulltest/c2-v3-phase0-20261105.log`）出结果。
- **追记（只读核对）：** 审计期间 `.oc-runs/fulltest/latest.json` 已刷新为 head `967f43c75`，at `2026-11-05T14:17:42.222Z`，sha256 `613a4648…a7551bf`，12595 tests / 12525 passed / 0 failed / 70 pending / 0 failed suites，但 `success=false`：原始分片 2/8、4/8、5/8 退出码为 1（作业 `20261105135112-4d8ceb`、`20261105135112-3f0904`、`20261105135112-db7e4b`，C2 已列入 BASELINE/INTEGRATION），所以这次全测**不算全绿**。#24、#25（`anki-domain.test.ts`）与 #26（`image-quality-native.test.ts`）三个标题在其中均为 passed，但这只说明断言层面没有失败；在分片非零退出的原因查明之前，它不能当作这 3 条复核条件已经满足的最终证据。本包没有用它重算 B，也不做新的全测诊断。上面的 49 条归因仍以 87b 输入为准，不因这次全测而改变。其余 46 条 skipped 用例的门控没有变化。
- 另：作业 `20261105143501-962aa8`（exit 0，main 合并后的 lane 树）跑的是不带 `--vitest` 的 `npm run migration:ledger -- --check --no-write`，B 未计算（1.9%），所以 0 problems 不代表 B 变绿。它报告 unreachable 22 / unknown 3720，多出的部分来自 967f 之后的 main 合并，不属于本包 phase0 范围，未逐条归因。

### phase0 账本变化归属

| owner | phase0 提交 | 测试 A/B 变化 | 可达性 |
|---|---|---|---|
| L13-vfs-api | `e596e1b5e`、`3ca2dcac0` | 73：A0B0→A1B1 | 73 条全部 unknown：动态派发 54，无静态生产符号 17，仅共享 helper 2 |
| L07-agent-skills-ptc | `d82417d62` | 20：A0B0→A1B1 | 20 条 unknown（动态派发） |
| L05-agent-workspace | `00d70cb59`、`a8b71a187` | 9：A0B0→A1B1 | 2 reachable，7 unknown（仅共享 helper） |
| F4-security | `247143c98` | 5：A0B0→A1B1 | 不在 prod-reachable 扫描范围（只扫 `host/plugins/*/TESTMAP.md`） |
| F3-storage | `ae7415784` | 3：A0B0→A1B0，**新增 3 条问题** | 同上，未分析 |

phase0 新增的 110 条 A 中，只有 2 条有静态可达证明；98 条 unknown，10 条不在扫描范围。这些 A 只表示 TESTMAP、测试名和用例结构这三项机械条件成立。生产接线与断言等价仍由 R1–R4 抽检负责，不能把 89.5% 当作“生产可达已证”。

### 49 条测试问题（按 owner）

problem 原文分三类：S 表示“<文件> 的对应用例未全部通过”，且匹配用例 status 为 skipped；W 同为 S 的原文，但匹配范围是整个文件（merged 未写用例名）；M 表示“vitest 报告中没有 <文件> 的 "<名>" 用例”。

#### F3-storage（4 条：phase0 新增 3，87b 既有 1）

| # | 归属 | Rust id（文件:行） | TESTMAP 行 → TS | 类 | 原因与修复/复核条件 |
|---|---|---|---|---|---|
| 24 | **phase0 新增**（`ae7415784`） | `crates/dstu-storage/src/database/mod.rs::tests::agent_library_reads_and_content_cas_cover_null_and_foreign_sessions`（mod.rs:9497） | `migration/testmap/F3-storage.md:116` → `host/platform/storage/tests/anki-domain.test.ts:501` | M | 用例在 87b 后才加入，旧全测无此标题。F3 作业 `20261105120118-f47e5a`（exit 0，47 files / 601 passed / 1 skipped）的日志 :102 已通过。**条件：** 967f 新全测中该标题 passed 后 B 自动成立，不需要改代码或映射。**复核点（交 R4/F3，不改等级）：** Rust :9516-9525 传 page_size 100 并断言夹到 20，TS :560 直接传 20，没有覆盖夹取（夹取在 L16 `anki/tests/agent-library-page.test.ts:44-45` 走真实服务）；Rust 从返回值 locator 取 document_id，TS 改为另查 `document_tasks`。 |
| 25 | **phase0 新增**（`ae7415784`） | `crates/dstu-storage/src/database/mod.rs::tests::agent_library_cards_by_ids_preserve_order_and_fail_closed`（mod.rs:9589） | `F3-storage.md:117` → `anki-domain.test.ts:563` | M | 同 #24，f47e5a 日志 :103 已通过。断言与 Rust :9623-9656 的顺序、字段、missing 文案和 soft-delete 拒绝逐条对应。**条件：** 967f 新全测 passed。 |
| 26 | **phase0 新增**（`ae7415784`） | `crates/dstu-storage/src/file_manager.rs::image_quality_tests::bytes_quality_matches_base64_policy_and_limits_dimensions`（file_manager.rs:1513） | `F3-storage.md:140` → `host/platform/storage/tests/image-quality-native.test.ts:18` | M | 87b 全测里没有该文件。f47e5a 日志 :271 显示 1 test 通过。JPEG 魔数、768×576、base64 往返与 Rust :1516-1527 对应。**条件：** 967f 新全测 passed。附带陈旧注释（不影响账本）：`host/platform/storage/file-manager.ts:9-11` 仍写“byte/pixel-equivalent JPEG test remains pending”，F3 可顺手更正。 |
| 29 | 87b 既有 | `tests/migration_fixture_upgrade_gate.rs::fixture_upgrade_gate`（:103） | `F3-storage.md:352` → `host/platform/storage/tests/migration-integration.test.ts:696/700/704` | S | 三个同名用例中仓库 fixture 的 upgrade/fault 两个已通过，`MIGRATION_FIXTURE_ROOT` 用例以 `it.runIf` 跳过。Rust 原文件头说明它是 CI 运行时复制的模板，没有 env 时 `expect` panic（:104-107），并非 ignore。**条件：** 在提供 `MIGRATION_FIXTURE_ROOT` 的 CI/作业中跑通该用例，或由 F3 提出拆分映射并经 C2 裁定。不能为 B 把 runIf 删掉。 |

#### F4-security（4 条，均为 87b 既有）

| # | Rust id（文件:行） | TESTMAP → TS | 类 | 原因与条件 |
|---|---|---|---|---|
| 20 | `crates/dstu-security/src/secure_store.rs::tests::plaintext_seed_migrates_to_dpapi_wrapping`（:1635，`#[cfg(windows)]`） | `migration/testmap/F4-security.md:171` → `host/platform/secrets/secure-store.test.ts:136`（`it.runIf(!offWindows)`） | S | 门控与 Rust 一致，Linux 全测必然 skipped。**条件：** 在 Windows runner 上实跑（资源属“待用户裁定”）。 |
| 21 | `…secure_store.rs::tests::reseal_wraps_imported_plaintext_seed_on_windows`（:1715，`cfg(windows)`） | `F4-security.md:174` → `secure-store.test.ts:149` | S | 同 #20。 |
| 22 | `…secure_store.rs::cloud_hydration_tests::debug_output_redacts_all_secret_values`（:2749） | `F4-security.md:195`：`merged:host/platform/secrets/secure-store.test.ts`（无 `::用例名`） | W | `ledger-core.mjs:52-54` 在 merged 无用例名时 needle=null，`assertionsFor` 取全文件 59 个用例，其中第 9、10 个是 #20/#21 的 Windows skipped，所以判未全通过。把映射改成 `::用例名` 能消除这条机械连带，但对应 TS 用例 :326 用一条 `credentialStatus` JSON 断言同时承接两条 Rust 测试。Rust :2758-2774 是对 `{:?}`/`{:#?}` 逐字段的脱敏断言，:2786-2793 是精确 Debug 字符串。两边断言不逐条对应，属于 v2 §1.5 待 F4 说明或补齐。**条件：** F4 先给出逐条断言对应，并写成带用例名的 merged；在此之前不应只靠改映射让 B 变绿。 |
| 23 | `…cloud_hydration_tests::debug_output_preserves_presence_information`（:2779） | `F4-security.md:196`，同上 | W | 同 #22。 |

#### L05-agent-workspace（16 条，均为 87b 既有，Rust 与 TS 平台门控一致）

| # | Rust id（文件:行，Rust 门控） | TESTMAP 行 → TS 文件:行（TS 门控） |
|---|---|---|
| 1 | `crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs::tests::shell_kind_marker_discards_probe_stderr_and_reports_actual_shell`（:2478，cfg windows） | `host/plugins/agent-workspace/TESTMAP.md:300` → `tests/tools-shell-output.test.ts:24`（win32） |
| 2 | `…local_shell_execute_executor.rs::tests::windows_init_failure_exit_code_is_reported_unsigned_and_hex`（:2491，cfg windows） | `:301` → `tools-shell-output.test.ts:31`（win32） |
| 3 | `…local_shell_execute_executor.rs::tests::cancellation_terminates_and_reaps_sandbox_process_tree`（:2877，cfg macos） | `:315` → `tests/tools-shell-execute.test.ts:158`（darwin） |
| 4 | `…local_shell_execute_executor.rs::tests::successful_foreground_exit_still_kills_background_group`（:2910，macos） | `:316` → `tools-shell-execute.test.ts:182` |
| 5 | `…local_shell_execute_executor.rs::tests::runtime_read_roots_include_active_developer_toolchain`（:3161，macos） | `:327` → `tools-shell-execute.test.ts:335` |
| 6 | `…local_shell_execute_executor.rs::tests::minimal_env_prefers_the_trusted_xcode_toolchain`（:3423，macos） | `:337` → `tools-shell-execute.test.ts:323` |
| 7 | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs::tests::profile_denies_network_and_protects_write_roots`（:1048，模块 `cfg(all(test, target_os = "macos"))` :1039） | `:369` → `tests/tools-shell-sandbox.test.ts:162`（darwin） |
| 8 | `…shell_sandbox.rs::tests::seatbelt_blocks_write_outside_writable_roots`（:1082） | `:370` → `tools-shell-sandbox.test.ts:186` |
| 9 | `…shell_sandbox.rs::tests::seatbelt_allows_shell_operators_interpreters_and_children_inside_root`（:1106） | `:371` → `:205` |
| 10 | `…shell_sandbox.rs::tests::seatbelt_allows_script_runner_while_network_is_denied`（:1138） | `:372` → `:221` |
| 11 | `…shell_sandbox.rs::tests::seatbelt_denies_network_even_to_loopback`（:1198） | `:373` → `:255` |
| 12 | `…shell_sandbox.rs::tests::timeout_kills_descendant_process_group`（:1220） | `:374` → `:270` |
| 13 | `…shell_sandbox.rs::tests::seatbelt_profile_is_private_temp_file_and_not_inline_argv`（:1278） | `:375` → `:305` |
| 14 | `crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs::tests::spawn_failure_cleanup_removes_unconsumed_payload`（:2171，整个文件只在 Windows 编译，:6-7 `std::os::windows`） | `:379` → `tests/tools-shell-sandbox-windows.test.ts:95`（win32） |
| 15 | `…shell_sandbox/windows.rs::tests::full_access_helper_cwd_stays_at_payload_root`（:2192） | `:380` → `tools-shell-sandbox-windows.test.ts:110` |
| 16 | `…shell_sandbox/windows.rs::tests::powershell_contract_uses_trusted_binary_encoded_script_and_utf8`（:2226） | `:382` → `tools-shell-sandbox-windows.test.ts:139` |

全部是 S 类。**条件：** 在 macOS / Windows runner 上实跑（资源属“待用户裁定”）。不得删门控，也不得在 Linux 上伪记 pass。

#### L23-sync-providers（20 条，均为 87b 既有）

`tests/sync_provider_contract_tests.rs` 中这些函数都标 `#[ignore = "requires scripts/dev/docker-compose.sync-test.yml and DS_SYNC_TEST_DOCKER=1"]`，S3 还有 `cfg(feature = "cloud_storage_s3")`（如 :2293-2296）。TS 为 `host/plugins/sync-providers/tests/sync_provider_contract.test.ts`，以 `DS_SYNC_TEST_DOCKER === '1'`（:24）门控。

| # | Rust 函数（rs 行） | TESTMAP 行 | TS 行 |
|---|---|---|---|
| 30 | `webdav_basic_object_contract`（1999） | 399 | 293 |
| 31 | `webdav_object_semantics_contract`（2006） | 400 | 297 |
| 32 | `webdav_file_checksum_contract`（2013） | 401 | 301 |
| 33 | `webdav_encrypted_backup_payload_contract`（2020） | 402 | 305 |
| 34 | `webdav_file_checksum_mismatch_preserves_local_target_contract`（2027） | 403 | 309 |
| 35 | `webdav_bad_credentials_rejected`（2132） | 418 | 313 |
| 36 | `s3_basic_object_contract`（2144） | 419 | 318 |
| 37 | `s3_object_semantics_contract`（2152） | 420 | 322 |
| 38 | `s3_file_checksum_contract`（2160） | 421 | 326 |
| 39 | `s3_encrypted_backup_payload_contract`（2168） | 422 | 330 |
| 40 | `s3_file_checksum_mismatch_preserves_local_target_contract`（2176） | 423 | 334 |
| 41 | `s3_bad_credentials_rejected`（2296） | 438 | 338 |
| 42 | `s3_list_pagination_contract`（2308） | 439 | 343 |
| 43 | `s3_multipart_file_contract`（2316） | 440 | 347 |
| 44 | `ftp_basic_object_contract`（2323） | 441 | 351 |
| 45 | `ftp_object_semantics_contract`（2330） | 442 | 355 |
| 46 | `ftp_file_checksum_contract`（2337） | 443 | 359 |
| 47 | `ftp_encrypted_backup_payload_contract`（2344） | 444 | 363 |
| 48 | `ftp_file_checksum_mismatch_preserves_local_target_contract`（2351） | 445 | 367 |
| 49 | `ftp_bad_credentials_rejected`（2456） | 460 | 371 |

**条件：** 起 docker-compose 服务、设 `DS_SYNC_TEST_DOCKER=1` 后实跑（AP0425 的口径相同，见下文）。

#### L13-vfs-api（2 条，87b 既有）

| # | Rust id | TESTMAP → TS | 条件 |
|---|---|---|---|
| 27 | `crates/dstu-vfs/src/file_stream_protocol.rs::tests::test_hidden_segment_check_with_mixed_verbatim_forms_on_windows`（:1038，cfg windows） | `host/plugins/vfs-handlers/TESTMAP.md:22` → `host/plugins/vfs/tests/protocols.test.ts:204`（win32） | Windows 实跑 |
| 28 | `crates/dstu-vfs/src/pdf_protocol.rs::tests::test_path_is_within_mixed_verbatim_forms_on_windows`（:941，cfg windows） | `host/plugins/vfs/TESTMAP.md:154` → `protocols.test.ts:465`（win32） | Windows 实跑 |

#### L18-media-docs（2 条，87b 既有）

| # | Rust id | TESTMAP → TS | 条件 |
|---|---|---|---|
| 18 | `crates/dstu-media/src/media/bilibili.rs::tests::live_lookup_fetches_real_subtitles`（:1882，`#[ignore]` 需联网） | `host/plugins/media/TESTMAP.md:91` → `tests/bilibili-live.test.ts:47`（`DS_BILIBILI_LIVE==='1'`） | 联网作业中实跑 |
| 19 | `crates/dstu-media/src/media/bilibili_stream.rs::tests::live_native_playurl_and_range_share_one_attempt`（:1010，ignore“requires live public Bilibili API and CDN”） | `media/TESTMAP.md:100` → `bilibili-live.test.ts:14` | 同上 |

#### L16-anki（1 条，87b 既有）

| # | Rust id | TESTMAP → TS | 条件 |
|---|---|---|---|
| 17 | `crates/dstu-anki/src/apkg_importer_service.rs::tests::external_apkg_env_smoke`（:5082，ignore，需 `DEEP_STUDENT_EXTERNAL_APKG`） | `host/plugins/anki/TESTMAP.md:405` → `tests/apkg-importer.test.ts:1982`（skipIf 同名 env） | 提供真实 APKG 后实跑 |

**口径说明（交 C2 判断，本包不改）：** 44 条 S 类中，43 条对应的 Rust 用例本身也不在默认 Linux 测试中执行（cfg 平台或 `#[ignore]`），TS 用对应门控 skipped 符合 quality §10.8。唯一例外是 F3 #29 `fixture_upgrade_gate`：Rust 没有 cfg/ignore，缺 `MIGRATION_FIXTURE_ROOT` 时会 `expect` panic；TS 的 `it.runIf` 跳过与 Rust 行为不同，详见 #29。账本把它们记为 problem，是因为现行定义要求 B“对应用例全部通过”，而 skipped 不算通过。这些用例确实没有在目标平台验证，所以不是误报。是否另设“平台门控未验证”分类，或接入目标平台全测，属于修改完成定义，按 ORCHESTRATION-v3 §7 应提交用户裁定。在裁定或实跑之前，ledger --check 会持续因这 44 条 S 与 F4 的 2 条 W exit 1。

### 14 条 unreachable（87b 与 967f 相同，A 均被否决）

| owner | Rust id（文件:行） | TESTMAP 行 → TS | 不可达符号（定义处） |
|---|---|---|---|
| L02-llm-manager | `src/chat_v2/tools/settings_models_executor.rs::tests::exposes_exact_tool_surface_with_expected_risk`（:1623） | `host/plugins/llm/TESTMAP.md:688` → `host/plugins/llm/tests/settings_models_executor.test.ts` | `SettingsModelsToolExecutor`（`src/settings_models_executor.ts:52`） |
| L02 | `…::profile_add_arguments_redact_api_key_before_crossing_boundaries`（:1651） | `:689` | `redactCredentialArguments`（`src/settings_models_arguments.ts:123`） |
| L02 | `…::profile_add_fields_allow_api_key_but_nothing_else_sensitive`（:1675） | `:690` | `MODEL_PROFILE_ADD_FIELDS`:26、`SETTINGS_GET_FIELDS`:21、`argumentsObject`:109、`argumentsObjectAllowingCredentials`:113 |
| L02 | `…::profile_add_validation_rules`（:1697） | `:691` | `profileCapabilityFlags`:156、`urlsSameOrigin`:180、`validateBaseUrl`:168、`validateProviderType`:175 |
| L02 | `…::sensitive_names_are_separator_and_case_insensitive`（:1750） | `:692` | `containsSensitiveIdentifier`:213 |
| L02 | `…::request_fields_and_database_rows_both_fail_closed`（:1775） | `:693` | `SETTINGS_GET_FIELDS`:21、`argumentsObject`:109、`isSafeSettingKey`:230 |
| L02 | `…::settings_values_use_exact_types_and_ranges`（:1790） | `:694` | `validateSettingValue`:231 |
| L02 | `…::assignment_args_require_explicit_nullable_occ_value`（:1811） | `:695` | `argumentsObject`:109、`MAX_MODEL_CONFIG_ID_CHARS`:15、`MODEL_ASSIGNMENTS_SET_FIELDS`:24、`requiredNullableString`:190、`parseAssignmentSlot`（`settings_models_assignments.ts:15`） |
| L02 | `…::model_directory_pagination_is_bounded`（:1840） | `:696` | `MAX_USIZE`:20、`optionalPositiveInteger`:200 |
| L02 | `…::model_capability_matrix_matches_runtime_consumers`（:1869） | `:697` | `validateModelForSlot`（`settings_models_assignments.ts:50`） |
| L02 | `…::model_directory_projection_never_contains_runtime_secrets`（:1907） | `:698` | `safeModelJson`（`settings_models_assignments.ts:74`） |
| L02 | `…::assignment_update_is_atomic_and_occ_guarded`（:1939） | `:699` | `updateModelAssignmentAtomic`（`settings_models_assignments.ts:105`） |
| L02 | `…::all_tool_strings_are_unicode_bounded`（:2004） | `:700` | `MAX_TOOL_STRING_CHARS`:14、`boundJsonStrings`:267、`boundedString`:258 |
| L14-qbank | `src/qbank_read/tests.rs::canonical_context_reads_current_questions_and_deduplicates_materials`（:16） | `host/plugins/qbank/TESTMAP.md:245` → `host/plugins/qbank/tests/qbank-read.test.ts` | `contextText`:78、`contextWithConn`:26（`repository/qbank-read.ts`） |

未标文件的符号都在 `host/plugins/llm/src/settings_models_arguments.ts`。**条件：** owner 从插件 `index.ts` 的 register/provide 真实接入这些执行体（L02 是 settings/models 工具执行器的注册，L14 是 qbank-read 上下文的生产调用方），或在没有生产调用方时改回 pending。不得为过检补空调用或假导出。

### unknown 3660（未证明可达，不否决）

按原因：动态派发 1941，无静态生产符号（source-lock/namespace import/仅 harness）1389，仅在共享 setup/helper 用到 281，找不到 TS 用例标题 49。967f 比 87b 多的 100 条全部来自 phase0 新 ported 行，分布见“phase0 账本变化归属”表；没有已有行从 reachable 或 unreachable 退到 unknown。按 2026-11-04 裁定，unknown 继续不否决，也不构成生产可达证据。复核 phase0 映射（R1–R4 的 ≥10% 抽检）时，应对这 98 条逐条给出生产调用点（文件:行）。

### 本审计不做的事

没有修改 ledger 质量定义、TESTMAP、审批、实现或生成账本。所列“条件”交各 owner 与 C2，由 C1 记入 DEPS/WORKPLAN 后派发。C2 已亲核 F3 #24（TS 直接传 20 代替 100，并另查 `document_id`，没有验证原夹取和返回 locator）和 F4 #22/#23（一条 `credentialStatus` 断言不能代替 Rust 两种 Debug 格式、4 个秘密值以及原 presence 断言），并交 C1 owner 修正：要补断言，不能只改映射拿 B。

## 账本否决：prod-reachable unreachable 否决测试 A（架构师 14:11 裁定，main 8d7b05d14）

**规则。** `lib/ledger-core.mjs` 的 `evaluateTest`：ported 行若在 prod-reachable 的 `unreachable` 集合中（按 TESTMAP 行 id，不按文件），A 置否，计入 `testUnreachable`，不算 problem。`unknown` 不降级；commands 评分不变；obsolete/pending 不进入集合。`ledger.mjs` 进程内调用 `gate-checks/prod-reachable.mjs`；分析抛错时不否决，并在汇总行写明“prod-reachable 不可用”。回归测试在 `scripts/electron-migration/ledger.test.ts`（`-c vitest.host.config.ts`，11/11）。

**与 SW/UD 窄门禁的区别。** 本条是账本评分（降 A），权限来自架构师对 `ledger-core.mjs`/`ledger.mjs` 的单项授权，已生效。SW/UD 是 changed-only 的集成拦截，接入点 `lib/gate-checks.mjs` 仍待 infra 应用 patch，两者权限分开。

**差分（作业 `20261104143146-dcf5d8`，`gate-checks/ledger-diff.mjs`，ok=true）。** 同一 main 8d7b05d14 树上，加规则前后：
- 测试 8109 条不变；A 6700 → 6675，**受影响 25 条**，全部是 A→非 A 且在报告中为 unreachable；unreachable 中已非 A 的 0 条，仍为 A 的 0 条。
- commands 1058 条 A/B/C 全部相同；unknown 3631 条无一变化。
- 按 lane：L02-llm-manager 13、L14-qbank 6、L06-agent-orchestration 3、L03-chat-pipeline 1、L17-memory-research 1、L10-notes 1。

**当前 main 报告（替换 2ee9a9cbe 基线）。** prod-reachable：ported 5947，unreachable 25，unknown 3631。assert-parity：deficit 416 + cfg-only 1。逐行分发清单：`gate-checks/reports/handoff-8d7b05d14.md`。

**逐行核对的两处（架构师点名）。**
- memory query-rewriter：当前 TESTMAP 只有 2 行 `query_rewriter.rs`，均为 C1 批准的 obsolete，未复活。`memory/tests/pure-modules.test.ts` 映射 10 行：5 行 reachable，5 行 category_manager/daily_log 为 unknown（动态派发），均不否决。“10+”是整文件口径；按逐用例归因，当前 main 上没有 ported 的 query-rewriter 行可否决。`src/query-rewriter.ts` 确实无生产引用，其 TS 用例没有 ported 行。
- chat-pipeline memory-flush：`repository/memory-flush.ts` 无生产引用。该文件 ported 3 行中，只有 `long_memory_flush_input_is_split_without_omitting_the_middle` 被否决，原因是用例用了 `repository/memory-flush.ts` 的 `MEMORY_FLUSH_SEGMENT_MAX_CHARS`；被测函数 `splitMemoryFlushSegment` 来自可达的 `src/memory-flush.ts`。属于“常量来自死模块”的边界情形，交 L03 判断（改从 `src/memory-flush.ts` 取常量即真实可达）。另 2 行 reachable，其余 repository 相关行本就是 pending。

**陈旧批准。** main 上 `sync-support/repository/records.ts` 已不再有 `as` 断言，C2 的 `parseLlmUsageDailyRecordId` 批准现为陈旧（`unchecked-decode` 报告 `staleApprovals`），保留不删，由 C2 决定。

**C2 后续批准删除陈旧例外。** 已按 C2 指令仅从 `approved-decoders.json` 移除 `host/plugins/sync-support/repository/records.ts` / `parseLlmUsageDailyRecordId` / `json-parse-assertion` / `JSON.parse(recordId) as Record<string, unknown> | null` / sites=1 这一条。其历史依据为 C2 `037376b1e`、Rust `sync/mod.rs:9240-9273` 与原 TS `records.ts:136-138` 逐字段验证；不撤销该历史裁定。当前有效例外剩五条 C1 原记录，内容未变；旧断言未来再引入会重新检出，需重新审批。回归仅覆盖例外配置与账本，不改业务代码、评分规则或共用 `lib/gate-checks.mjs`，不刷新历史报告或全仓重扫。

最小回归作业 `20261104150112-99e803` exit 0：unchecked-decode 7/7、ledger 11/11；覆盖旧断言重新检出、当前 unknown 中间值不命中、同函数/同文件新 parse 仍检出，配置仅保留五条 C1 例外。

**AP0425 来源修正（C2）。** 核过当前树、固定报告基线 `8d7b05d14` 及旧基线 `2ee9a9cbe`：`sync_provider_contract_tests.rs:2293-2303` 的 `s3_bad_credentials_rejected` 原有 `cloud_storage_s3` cfg 和 Docker/`DS_SYNC_TEST_DOCKER=1` 的 ignore。已定点补到 JSON 的 finding/detail 与原 ID 分发条目，未全仓重扫、未改计数。Rust 两断言中一条只是 Docker 开关检查，TS 对应标题精确为 `s3_bad_credentials_rejected`；静态 2/1 不代表真实少一条业务校验或新增平台待裁定。解析器/后续报告保留函数原始 attributes（含 cfg/ignore），回归覆盖相邻同前缀函数与 TS 标题不串行。保原门控，不新增 skip；本次没有执行该 Docker 用例，不记 pass。

## 当前状态（无剩余可执行工作）

本轮自动续派已先合并 main `1e893eb61`，`2eeef335b` 自检通过，并按 standard-v2 §1 八类对 X6 源码审读一轮，未发现新增可修代码缺陷。完成证据与外部事项现统一记录在允许路径内的 `scripts/electron-migration/gate-checks/LANE.md`；本轮不重复全仓报告或已绿测试。

- 准备单元已完成：C2 和 C1 均已亲取作业 `20261104125010-5cf75f`（30/30，exit 0）并确认两条窄规则。
- 等待 infra 回执：由架构师/infra 把 `gate-checks-integration.patch` 应用到共用的 `lib/gate-checks.mjs`。X6 无权写该文件，未修改。未接入前不称“已门禁”。
- 新 main 重扫只在正式接入后或所有者映射变化时做一次，并按已分发给各 lane 的稳定编号关联，旧计数不当作新 main 的存量。
- 其余情况只在出现有证据的误报时才修改，不循环全扫。

## 接入准备（12:50Z，门禁代码见 X6 本轮提交）

**获准范围（C1 12:14Z、C2 12:32Z）。** 只对 changed 的 `host/plugins/*/` 生产文件生效：
- `single-writer(changed)`：只拦截 `foreign-table-write` 中所有者有明确裁定（D1、C1/C2 裁定，或精确命名空间）且 `context=executed` 的写入。推导所有者、sql-text、unknown、duplicate-repository 只报告。
- `unchecked-decode(changed)`：只拦截 `json-parse-assertion` 和 `raw-ipc-destructure`；`double-assertion` 只报告。诊断文字统一为“无校验断言语法风险，后续是否有解码器需人工核”，删掉 `as` 本身不算修复。
- prod-reachable、assert-parity、log-parity 继续只报告，不接入，不自动降 A。

**接入方式。** 接入点是集成与 lane-gate 共用的 `lib/gate-checks.mjs`，最小 diff 见 `scripts/electron-migration/gate-checks/gate-checks-integration.patch`。该文件不在 X6 允许路径内，**未修改**，交架构师/infra 执行，也不涉及 ledger 评分。

**所有权落盘。**
- `owner-rulings.json` 逐条收录 C2 X6-OWN-C2-20261104（`037376b1e`）的 118 项和 V2-OWNER-QBANK 的 5 张表，每条带证据。生成器先应用裁定，调用方引用不能反推所有者；`questions`、`question_history` 仍归 vfs-repos。
- 命名空间分两种：精确文件（APKG 导出的 `collection.anki2`），以及插件自身数据库（browser.db 的 downloads/history/sessions/site_permissions/settings，workspace 库的六个短表名）。这些短表名在命名空间之外是 unknown，不会套用全局所有者。19 个 fixture/vendor 名字标为 not-production，在生产代码里出现时记为 unknown，需重新裁定。
- 回归测试确认：118 项全覆盖、无重复、无遗留 ambiguous、每项都有 schema 证据。

**批准例外（共 6 条，均为 sites=1）。** C1 批准了 R2 的 5 条；C2 批准了 `sync-support/repository/records.ts` 中 `parseLlmUsageDailyRecordId` 的 `JSON.parse(recordId) as Record<string, unknown> | null`。`rowToAutomation:92` 未批准。测试使用真实文件，证明同函数、同文件新增的 parse 仍会拦截。

**changed 正反例（作业 `20261104125010-5cf75f`，30/30 测试 exit 0）：**

| changed 文件 | single-writer | unchecked-decode | 说明 |
|---|---|---|---|
| anki/repository/apkg-export.ts | 0 | 0 | APKG 命名空间负例 |
| sync-support/repository/records.ts | 0 | 0 | C2 例外生效 |
| agent-workspace/src/runtime-root-records.ts | 0 | 0 | C1 例外生效 |
| qbank/repository/authoring.ts | 1 | 1 | 只拦截 `questions` 写入（L11）；qbank_* 自有表不再误报 |
| sync/repository/note-history.ts | 1 | 1 | 越权写 notes 的表 |
| agent-orchestration/repository/automation-definitions.ts | 0 | 1 | `:92` 仍拦截，`:150` 已批准 |
| browser/repository/vfs-metadata.ts | 1 | 0 | 写 L11 `resources`（C1 亲核为真） |

**已知存量（基线 2ee9a9cbe，并非全仓清零）。**
- single-writer：会拦截 202 条（executed 且所有者已裁定），只报告 66 条；duplicate info 142 条，unknown 8 个，ambiguous 0。会拦截的 202 条按插件：vfs-index 65、vfs 33、qbank 25、sync 20、notes 12、anki 11、vfs-repos 11、agent-workspace 6、memory 5，其余 ≤3。
- unchecked-decode：会拦截 104 条（json-parse-assertion），double-assertion info 107 条。

**抽样口径。**
- single-writer：C1 抽 5 条，4 真 1 假，假报是 qbank_materials，已按裁定修正；C2 抽 5 条，全真。
- unchecked-decode：C1 抽 5 条均命中语法风险，其中能直接确认业务缺校验的只有 2 条；C2 抽 5 条，4 真 1 结构误报（已精确豁免）。
- 以上只是小样本，不能推算全仓误报率。

**本轮其他修正。**
- prod-reachable 改为逐 TESTMAP 行归因：符号只记给用例体实际使用它的那一行；共享 setup/helper 中用到的符号记为 unknown。只统计 ported 行，obsolete（如已批准的 query_rewriter 两条）不计。结果：ported 5702 条，unreachable 66 条，unknown 3341 条。
- assert-parity/prod-reachable 的用例匹配改为按标识符边界匹配，修正了 L04 报告的 `test_backend_event_deserialization` 误配 `..._with_variant`。现为 deficit 429 条、cfg-only 1 条。

## 使用

`node scripts/electron-migration/gate-checks/<名称>.mjs [--check] [--json] [--changed <文件...>]`

- 不传 `--changed` 扫全仓；`--changed` 后不跟文件则不扫描。
- `--check`：有非 info 的发现退出 1，运行错误退出 2。log-parity 永远退出 0。
- 全仓快照：`audit-scan.mjs <名称>` 写出 `gate-checks/reports/<名称>.json`（逐条文件:行、规则、依据），并刷新本文对应的快照一节。
- 测试：`node --test scripts/electron-migration/gate-checks/*.test.mjs`，经 jobs 队列运行。

## single-writer

### C2 单表纠偏：mistakes.db.temp_sessions → integration（L22）

按架构师 15:09 转交证据及 C2 后续正式裁定，撤销 `037376b1e` 中把 `temp_sessions` 归 legacy chat 的这一项，唯一业务 owner 改为 integration/L22；其余 117 项、V2-OWNER-QBANK 与命名空间不变。证据：Rust `src-tauri/src/commands.rs:166-171` 持久化、`:248-285` modify/read-back/persist、`:356-395` pin/unpin 调用；main `integration/api.ts::APP_STATE_OWNERS.temp_sessions='L22-app-commands'`；L22 候选 `780b9b9e6` 的真实 `repository/temp-sessions.ts` / `modifyTempSession`。F3 建 schema 不代表运行时业务 owner。

仅改 `owner-rulings.json` 的该表裁定，使用原 `build-table-owners.mjs::build()` 生成并回填 `table-owners.json` 的 `temp_sessions` 条目，保留其他快照字段，不改检测规则、不全局豁免、不全库重扫、不重跑 30 测试。用候选真实仓储源码作最小映射验证，integration 自写不报 foreign，同一直接写入放到 chat/media 仍应按 ruled-owner + executed 报错。

最小映射作业 `20261104151702-78a880` exit 0：生成项 owner=integration，其余映射/命名空间不变；候选 `780b9b9e6` 的真实 L22 仓储有 1 条 executed 写入、0 条 foreign；相同源码分别放入 chat/media 各检出 1 条 blocking foreign，owner 均为 integration。未执行业务数据库写入或唤醒 parked 的 L22。

**判定。** 所有权按以下优先级确定：
1. C2 的明确裁定（2026-11-04T11:00Z）：`vfs_index_units`、`vfs_index_segments`、`vfs_embedding_dims`、`vfs_index_profiles`、`resources`、`files`、`exam_sheets`、`__lance_orphan_queue` 归 L11 vfs-repos；
2. decisions.md D1 列出的表；
3. 其余表由 Rust schema、LANE 拥有的 Rust 仓储、SPEC 引用三方交叉推出唯一所有者。

推不出唯一所有者的表 owner 为 null，这类表上的写点进入 `unknown`，不报违规。`__file_deletion_journal`、`vfs_indexing_config` 尚未核实，保持 null。

**扫描范围。** TS 字符串和模板字面量中的 INSERT/UPDATE/DELETE/REPLACE/UPSERT（含 `OR IGNORE`、限定名、带引号的名字）。SQL 注释和 SQL 字符串值都会剥除；TS 注释不是字面量；测试目录不扫。`${...}` 动态表名跳过，不做猜测。

**边界。**
- `context: executed`：字面量直接作为 `run/exec/prepare/get/all/iterate/query` 的参数。`context: sql-text`：常量或拼接片段。不做数据流追踪，所以 sql-text 不能证明一定被执行。
- 把同事务的 `SqlExecutor` 交给 owner 的 `*WithConn` 方法，本身不会被报（测试覆盖）。
- 不同数据库里的同名表只能靠精确的“文件+表”命名空间豁免。现有唯一一条：APKG 导出的 `collection.anki2`（`anki/repository/apkg-export.ts` 的 col/notes/cards/revlog/graves）。负例测试：同一插件其他文件写 `notes` 仍报越权。
- 只按目录判断是否生产代码。生产目录里只被测试消费的写点（例如 C1 指出的 `memory/repository/learning.ts:240` 起 6 个 `insert*` fixture）仍会被报：这是路径违规，不代表已证实的生产写链，应由 owner 把它们移到 tests/。不按注释豁免。

**结果（基线 2ee9a9cbe）。** 越权写 202 条（executed 193 / sql-text 9），重复仓储 info 143 条，未知所有权写点 370 个，待裁定表 118 张。

**抽样。** C1 亲核 3 条真越权：`sync/repository/note-history.ts:177`、`chat/repository/vfs-folders.ts:144`、`memory/repository/vfs.ts:498`。C2 确认的真越权样例：sync note-history、vfs create notes/resources、backup vfs-restore。已知误报源 1 类：APKG 同名表，已用命名空间修正并有负例测试。当前没有可靠的误报率分母，所以不声称误报率可接受，交 C2 继续抽样。

**测试。** `20261104112702-e05069`：6 个 single-writer 用例通过，exit 0。changed 示例 `20261104102657-3c659e`：`--check` 预期 exit 1。

## unchecked-decode

**规则。**
- `json-parse-assertion`（error，入站解码候选）：`JSON.parse(...)` 直接或经 `as unknown` 断言为具体类型。
- `raw-ipc-destructure`（error）：原生 `ipcMain` 回调或 kernel 私有注册回调直接解构入参。kernel `commands.register` 的入参已由 `host/kernel/commands.ts` 按契约解码，因此不报。
- `double-assertion`（info）：`as unknown as T`。这条只标出类型断言风险，**不判断方向**，入站绕过解码与出站或内部的类型拓宽在静态上无法区分。例如 `automation-definitions.ts:150` 是出站 JsonValue（R2 已归入出站）。

**批准机制（已按 C1/C2 收窄）。** `approved-decoders.json` 每条批准只绑定一个可复核的断言：精确路径、外层函数、规则、断言表达式原文（空白规范化），加可选 `sites`（默认 1），并写明 approvedBy 和 evidence。不接受文件、目录、glob 或只写函数的批准。负例测试证明以下情况仍会检出：同文件其他函数新增的业务 parse、同函数内新增的 parse、改过断言类型的原表达式、超出 `sites` 的重复位置、其他文件中相同的文本。当前生效批准为 **0 条**。

**R2 分类（`849255bc7`），提议批准，待 C1/C2 写入后才生效：**

| 文件:行（基线） | 函数 | 规则 | 表达式 | R2 结论 |
|---|---|---|---|---|
| agent-workspace/src/runtime-root-records.ts:39 | RecordReader.string | json-parse-assertion | `JSON.parse(this.text.slice(start, this.offset)) as string` | 单 token 反转义，前面已扫描到完整引号并校验 escape |
| …:255 | decodeWorkspaceRootRecord | double-assertion | `value as unknown as WorkspaceRootRecord` | schema/record/identity/finish 之后的收窄 |
| …:266 | decodeAuthorizedRootRecords | double-assertion | `record(reader, item, 'AuthorizedRootRecord', schema) as unknown as AuthorizedRootRecord` | 同上 |
| …:276 | decodeSkillTrustRecord | double-assertion | `value as unknown as SkillTrustRecord` | 同上 |
| agent-orchestration/repository/automation-definitions.ts:150 | automationVersionConflictError | double-assertion | `automationToListObject(current, Date.now()) as unknown as JsonValue` | 出站，可从入站规则中排除 |

这些批准不代表整个 parser 等价（W1 错误优先级仍在 R2 跟进）。`automation-definitions.ts:92`（rowToAutomation 把持久化的 trustedProfile 直接断言）仍是真报，已派修为 X6-UD-L06-01。

**结果（基线 2ee9a9cbe）。** 共 217 条：json-parse-assertion 106、double-assertion 111（info）。不能把 217 条都说成业务缺校验。

**测试。** `20261104114356-a57d2d`：6 passed，exit 0。changed 示例 `20261104105044-92b07a`：预期 exit 1。

## prod-reachable

**判定。** 对每条 TESTMAP `ported:` 行，取测试文件中实际用到的、本插件内的生产符号（类型 import、未使用的 import、其他插件的 harness 符号、本插件 `index.ts` 都排除）。用 TS 编译器 API 按符号建图：
- 起点是 `ctx.commands.register` / `ctx.provide` 的载荷，以及继承 Cordis `Service` 且调用 `super(ctx, …)` 的类。
- 被 provide 的实例只公开其公开方法；只构造实例不算公开。
- 同文件里的其他函数不会因为同在一个文件就被视为可达。
- 经 `api.ts` 被其他插件的生产图到达的符号也算可达。

**结论只有三种：**
- `reachable`：存在静态路径。
- `unknown`：插件存在动态分派（元素访问、`import()`、interface 方法调用），且模块被生产入口加载，因此无法证明不可达；或者测试没有可解析的生产 import。**unknown 不证明可达，不能用来获得新的 A 级。**
- `unreachable`：插件没有动态分派却也没有路径；或者模块根本没有被任何生产入口 import（消息里注明）。只有这一种会被 `--check` 拦截。

**结果（基线 2ee9a9cbe）。** ported 5702 条：unreachable 240 条（119 个符号），unknown 4265 条，其余 reachable。unknown 占比高，说明这个门禁目前只能可靠拦截“模块未接线”这类明确问题。

**抽样（亲核为真）。**
- `agent-orchestration/src/headless.ts:96` 的 `clampSessionTurnTimeout`：全仓只有测试调用；
- `notes/src/user-todo-schemas.ts:39` 的 `getUserTodoSchemas`：只有测试调用；
- `llm/src/input_guard.ts`：除自身外无人 import；
- `memory/src/query-rewriter.ts`：生产代码无人 import。

已修复的误报源两类，均有回归测试：测试 import 其他插件当 harness（chatanki→review `FsrsReviewService`、sync-providers→sync 插件）；符号经 `api.ts` 被其他插件使用（vfs-index pdf-processing）。

**接入 A 级的影响（未接入）。** 只影响测试 A，不改命令 A（commands 0）。按基线计算，若把 `unreachable` 设为测试 A 的否决条件，受影响 240 条；若要求 `reachable` 才算 A，则另有 4265 条 unknown 会掉级，不建议这样做。这项改动要修改 `lib/ledger-core.mjs` 的 `evaluateTest`（复用现有 `ctx.unwired` 通道即可）和 ledger 调用方，需等架构师授权。

**测试。** `20261104113552-d41f47`：4 passed，exit 0。

## assert-parity

**判定。** 按 TESTMAP 配对 Rust 测试函数和 TS 用例。若 TS 有多个同名用例（参数化、cfg 变体），逐个独立比较，不跨用例借 expect。
- Rust 侧：tree-sitter 统计 `assert!/assert_eq!/assert_ne!/assert_matches!`，`#[should_panic]` 计 1。`panic!` 单列，不计入断言。字符串和注释中的内容不计。
- TS 侧：统计 `expect(...)`、`expect.soft/poll` 及别名，同文件 helper 展开一层；`expect.assertions(n)` 不计。

计数是静态调用位置，不代表语义对应。TS 少于 Rust 时报 `assertion-deficit`。如果差额全部来自 `#[cfg(...)]` 门控的 Rust 断言，则报 `assertion-deficit-cfg`（info），需要人工判断该 cfg 在默认构建中是否生效。样例：`backup/tests/jobs.test.ts:46` 少的正是 `#[cfg(feature = "data_governance")]` 的那条 assert。

**结果（基线 2ee9a9cbe）。** 配对 5748 个用例：assertion-deficit 459，assertion-deficit-cfg 1（info）；TS 用例标题缺失或非字面量的 46 条进入 unknown。

**抽样。** `backup/tests/jobs.test.ts:46`：差额来自 cfg 门控断言，已归入 info。`backup/tests/cloud-config.test.ts:114`（Rust `cloud_config_commands.rs:1132`）：Rust 6、TS 5，缺少的是“常量等于字面量”这条 `assert_eq!`，TS 用 `toContain` 字面量部分覆盖。计数确实不足，但语义可能已覆盖，需要 lane 人工确认。所以本门禁的发现只代表“需要逐条核对”，不能直接当作断言被削弱。

**测试。** `20261104115158-c119a7`：4 passed，exit 0（含 cfg 用例）；全仓快照同一作业。

## log-parity（只报告）

**判定。** 对每个插件 LANE 列出的 Rust 文件，用 tree-sitter 统计非测试函数中的 `warn!/error!`（含 `tracing::` 限定形式）。对应的 TS 文件是本插件中在源码里提到该 Rust 文件名的生产文件，统计其 logger `.warn/.error` 与 `logWarn/logError` 调用（不含 console）。另给插件总计。尚未解析 SPEC 中函数级的 Rust→TS 映射；一个 TS 文件同时引用多个 Rust 文件时会重复计入，这只会漏报，不会虚增差额。

**结果（基线 2ee9a9cbe）。** 文件级：warn 差 188、error 差 69；插件级：warn 22、error 18。全部为 info。

**测试。** `20261104112823-d232da`：3 passed。

## 待协调事项

- 已完成：五条 C1 精确例外落盘；C2 陈旧例外按后续授权删除；118 项 owner 裁定与 temp_sessions 单项纠偏落盘；获授权的 ledger 否决及回归完成。上述不再作为未处理请求。
- 待有权 infra：应用 SW/UD 共享 `lib/gate-checks.mjs` 最小 patch；该文件仍不在 X6 权限内，不称已上线。
- 业务修复/签收：C1/C2 按固定报告原 ID 分发；L10 mfjs 原 test-only 登记待架构师裁定，当前 A 否决不自豁免，候选未入 main 不称已关闭。
- 新扫描只按明确追加要求或有证据误报进行；已要求的 single-writer 单次刷新完成，不能因自动续派重复全库扫描。
- L24 新交接四条（AP0198/0204/0211/0207）：固定 main `d51544ecf` 仍 ported，helper 仅定义/tests 消费；问题是执行路径，不是组合/循环断言少 expect。生成器按旧 TESTMAP 原 ID 保留状态，单独 refresh 不会纠正为 pending。权威来源链与四行原 ID 对账表已记录在 `gate-checks/LANE.md`；待架构师授权维护方回写，不改业务 TESTMAP、旧快照或评分规则，不全文件降级。

## log-parity 全仓快照

发现 297 条（包含 info）；完整明细：`scripts/electron-migration/gate-checks/reports/log-parity.json`。

| 插件 | 条数 |
|---|---:|
| agent-orchestration | 17 |
| agent-skills | 17 |
| agent-workspace | 24 |
| anki | 9 |
| backup | 16 |
| browser | 8 |
| chat | 18 |
| chat-pipeline | 25 |
| chatanki | 7 |
| integration | 4 |
| llm | 18 |
| mcp | 12 |
| media | 23 |
| memory | 26 |
| notes | 11 |
| qbank | 8 |
| review | 5 |
| sync | 6 |
| sync-providers | 5 |
| translation | 3 |
| vfs | 16 |
| vfs-index | 12 |
| vfs-repos | 7 |

典型样例：
- `host/plugins/agent-orchestration/src/inbound.ts:1` [log-warn-deficit] inbound.rs: Rust warn! 2 > TS warn 0 across 2 citing file(s)
- `host/plugins/agent-orchestration/src/super-inbox-drain.ts:1` [log-warn-deficit] prompt.rs: Rust warn! 1 > TS warn 0 across 3 citing file(s)
- `host/plugins/agent-orchestration/src/attempt-completion.ts:1` [log-warn-deficit] attempt_completion.rs: Rust warn! 2 > TS warn 0 across 1 citing file(s)
- `host/plugins/agent-orchestration/src/automation-tool-args.ts:1` [log-warn-deficit] automation_executor.rs: Rust warn! 2 > TS warn 0 across 1 citing file(s)
- `host/plugins/agent-orchestration/src/custom-agent.ts:1` [log-warn-deficit] custom_agent_executor.rs: Rust warn! 2 > TS warn 0 across 1 citing file(s)
- `host/plugins/agent-orchestration/src/goal-tools.ts:1` [log-warn-deficit] goal_executor.rs: Rust warn! 3 > TS warn 0 across 1 citing file(s)

## unchecked-decode 全仓快照

发现 211 条（包含 info）；完整明细：`scripts/electron-migration/gate-checks/reports/unchecked-decode.json`。

| 插件 | 条数 |
|---|---:|
| agent-orchestration | 16 |
| agent-skills | 4 |
| agent-workspace | 19 |
| anki | 13 |
| backup | 5 |
| browser | 13 |
| chat | 10 |
| chat-pipeline | 1 |
| chatanki | 5 |
| llm | 18 |
| llm-providers | 5 |
| mcp | 11 |
| media | 3 |
| memory | 4 |
| notes | 7 |
| qbank | 22 |
| review | 6 |
| sync | 7 |
| sync-providers | 7 |
| sync-support | 2 |
| translation | 1 |
| vfs | 5 |
| vfs-handlers | 2 |
| vfs-index | 7 |
| vfs-repos | 18 |

典型样例：
- `host/plugins/agent-orchestration/index.ts:446` [double-assertion] as unknown as: type-assertion risk candidate; direction (inbound decode vs outbound/internal) needs review
- `host/plugins/agent-orchestration/index.ts:469` [double-assertion] as unknown as: type-assertion risk candidate; direction (inbound decode vs outbound/internal) needs review
- `host/plugins/agent-orchestration/index.ts:470` [double-assertion] as unknown as: type-assertion risk candidate; direction (inbound decode vs outbound/internal) needs review
- `host/plugins/agent-orchestration/index.ts:483` [double-assertion] as unknown as: type-assertion risk candidate; direction (inbound decode vs outbound/internal) needs review
- `host/plugins/agent-orchestration/index.ts:488` [double-assertion] as unknown as: type-assertion risk candidate; direction (inbound decode vs outbound/internal) needs review
- `host/plugins/agent-orchestration/index.ts:493` [double-assertion] as unknown as: type-assertion risk candidate; direction (inbound decode vs outbound/internal) needs review

## prod-reachable 全仓快照

发现 56 条（包含 info）；完整明细：`scripts/electron-migration/gate-checks/reports/prod-reachable.json`。

| 插件 | 条数 |
|---|---:|
| agent-orchestration | 4 |
| agent-workspace | 3 |
| chat-pipeline | 1 |
| llm | 37 |
| llm-providers | 2 |
| media | 4 |
| memory | 1 |
| notes | 1 |
| qbank | 3 |

典型样例：
- `host/plugins/agent-orchestration/tests/legacy.test.ts:1` [production-unreachable] migrateLegacyDb (host/plugins/agent-orchestration/repository/legacy.ts:7) has no register/provide call/value path from any plugin index.ts (module not imported by any production entry); used by 2 TESTMAP row(s)
- `host/plugins/agent-orchestration/tests/tool-schemas.test.ts:1` [production-unreachable] canHandleGoalTool (host/plugins/agent-orchestration/src/goal-tools.ts:70) has no register/provide call/value path from any plugin index.ts (module not imported by any production entry); used by 1 TESTMAP row(s)
- `host/plugins/agent-orchestration/tests/tool-schemas.test.ts:1` [production-unreachable] goalToolSchemas (host/plugins/agent-orchestration/src/goal-tools.ts:66) has no register/provide call/value path from any plugin index.ts (module not imported by any production entry); used by 1 TESTMAP row(s)
- `host/plugins/agent-orchestration/tests/tool-schemas.test.ts:1` [production-unreachable] parseGoalTokenBudget (host/plugins/agent-orchestration/src/goal-tools.ts:76) has no register/provide call/value path from any plugin index.ts (module not imported by any production entry); used by 1 TESTMAP row(s)
- `host/plugins/agent-workspace/tests/workspace-injector.test.ts:1` [production-unreachable] InjectionThrottle (host/plugins/agent-workspace/src/workspace/injector.ts:17) has no register/provide call/value path from any plugin index.ts (module not imported by any production entry); used by 3 TESTMAP row(s)
- `host/plugins/agent-workspace/tests/workspace-injector.test.ts:1` [production-unreachable] WorkspaceInjector (host/plugins/agent-workspace/src/workspace/injector.ts:28) has no register/provide call/value path from any plugin index.ts (module not imported by any production entry); used by 5 TESTMAP row(s)

A 级影响：{"commands":0,"portedTests":5702,"unreachableTests":66,"unknownTests":3341}。

## assert-parity 全仓快照

发现 430 条（包含 info）；完整明细：`scripts/electron-migration/gate-checks/reports/assert-parity.json`。

| 插件 | 条数 |
|---|---:|
| agent-orchestration | 13 |
| agent-skills | 12 |
| agent-workspace | 9 |
| anki | 18 |
| backup | 79 |
| browser | 1 |
| chat | 17 |
| chat-pipeline | 23 |
| chatanki | 46 |
| integration | 21 |
| llm | 15 |
| llm-providers | 39 |
| mcp | 3 |
| media | 31 |
| memory | 4 |
| notes | 12 |
| qbank | 23 |
| review | 10 |
| sync | 14 |
| sync-providers | 12 |
| sync-support | 1 |
| vfs | 20 |
| vfs-index | 3 |
| vfs-repos | 4 |

典型样例：
- `host/plugins/agent-orchestration/tests/automation-repository.test.ts:149` [assertion-deficit] action_type_serde_uses_snake_case: Rust 5 assertions (0 cfg-gated) > TS 2 expects
- `host/plugins/agent-orchestration/tests/automation-repository.test.ts:293` [assertion-deficit] ensure_heartbeat_in_list_is_idempotent: Rust 9 assertions (0 cfg-gated) > TS 8 expects
- `host/plugins/agent-orchestration/tests/automation-repository.test.ts:439` [assertion-deficit] active_run_guard_does_not_remove_a_newer_token: Rust 5 assertions (0 cfg-gated) > TS 4 expects
- `host/plugins/agent-orchestration/tests/automation-repository.test.ts:313` [assertion-deficit] full_update_can_clear_nullable_agent_fields: Rust 8 assertions (0 cfg-gated) > TS 5 expects
- `host/plugins/agent-orchestration/tests/automation-repository.test.ts:332` [assertion-deficit] full_update_rejects_stale_version_without_overwriting_current_value: Rust 11 assertions (0 cfg-gated) > TS 9 expects
- `host/plugins/agent-orchestration/tests/headless.test.ts:227` [assertion-deficit] execution_policy_blocks_non_whitelisted_calls_fail_closed: Rust 15 assertions (0 cfg-gated) > TS 4 expects

## single-writer 全仓快照

发现 275 条（包含 info）；完整明细：`scripts/electron-migration/gate-checks/reports/single-writer.json`。

| 插件 | 条数 |
|---|---:|
| anki | 2 |
| browser | 2 |
| chat | 10 |
| media | 3 |
| memory | 25 |
| notes | 23 |
| qbank | 14 |
| review | 4 |
| sync | 40 |
| sync-support | 8 |
| translation | 8 |
| vfs | 76 |
| vfs-handlers | 3 |
| vfs-index | 21 |
| vfs-repos | 36 |

典型样例：
- `host/plugins/browser/repository/vfs-metadata.ts:11` [foreign-table-write] UPDATE resources (executed, owner ruled): owner=vfs-repos, writer=browser
- `host/plugins/chat/repository/vfs-folders.ts:144` [foreign-table-write] INSERT folders (executed, owner derived): owner=vfs-repos, writer=chat [report-only]
- `host/plugins/chat/repository/vfs-folders.ts:175` [foreign-table-write] DELETE path_cache (executed, owner derived): owner=vfs-repos, writer=chat [report-only]
- `host/plugins/chat/repository/vfs-folders.ts:186` [foreign-table-write] DELETE path_cache (executed, owner derived): owner=vfs-repos, writer=chat [report-only]
- `host/plugins/chat/repository/vfs-folders.ts:198` [foreign-table-write] UPDATE folders (executed, owner derived): owner=vfs-repos, writer=chat [report-only]
- `host/plugins/chat/repository/vfs-folders.ts:207` [foreign-table-write] UPDATE folder_items (executed, owner ruled): owner=vfs-repos, writer=chat

所有权待裁定 0 张表，详见 registry 的 ambiguous；本次未知所有权写点 6。

### single-writer 本次基线与按 lane 计数

本次仅重生成 single-writer 一次：源码 main `4525e11ac972a195e968d49eceb096f238117325`；合并后扫描提交 `dc192a27f446bdaacc8341a811ab94e1cd5f2f54`；所有权规则 `6002c7fbd56ef99f38845db0f7e7b83aca27f016`。扫描前后均核对 host/plugins 与固定 main 一致，检测器及规则无漂移。

刷新作业 `20261104153042-ad53c2` exit 0。本基线尚无 `host/plugins/integration/repository/temp-sessions.ts` 候选仓储，报告中无 temp_sessions 写点，不把“未出现候选”说成已完成接线；候选真实写入的映射正反例仍沿用 `20261104151702-78a880`，本轮不重复。

当前 blocking foreign **114**；report-only foreign 50；duplicate info 111；unknown 6；ambiguous 0。旧 **202** 仅是 `2ee9a9cbe` 基线，不能当新存量，也不能把差额全归因于 temp_sessions 纠偏（源码也已更新）。

| lane | blocking foreign | report-only foreign | duplicate info | unknown |
|---|---:|---:|---:|---:|
| L02-llm-manager | 3 | 2 | 3 | 0 |
| L04-chat-session | 1 | 4 | 5 | 0 |
| L10-notes | 12 | 0 | 11 | 0 |
| L11-vfs-repos | 11 | 1 | 24 | 0 |
| L12-vfs-index | 17 | 0 | 4 | 3 |
| L13-vfs-api | 33 | 28 | 15 | 0 |
| L13b-vfs-handlers | 2 | 0 | 1 | 0 |
| L14-qbank | 5 | 1 | 8 | 0 |
| L15-review-analytics | 2 | 0 | 2 | 0 |
| L16-anki | 0 | 0 | 2 | 3 |
| L17-memory-research | 5 | 8 | 12 | 0 |
| L18-media-docs | 2 | 0 | 1 | 0 |
| L19-mcp-browser | 1 | 0 | 1 | 0 |
| L20-sync | 20 | 6 | 14 | 0 |
| L20b-sync-support | 0 | 0 | 8 | 0 |

同一 `single-writer.json` 已包含 snapshot 与 byLane。SQL 写点仍按路径/表/操作/源码位置关联历史发现，不按新数组顺序重编编号；历史编号基准 `011914371` 保留，PR/AP 的原 Rust TESTMAP ID 与报告完全未改。SW/UD 仍待 infra 接入，未唤醒 parked owner。
