结论：部分完成，stdio 双运行时夹具与卸载日志已修复，Node/Electron 双目录各471通过、Errors0/raw0；官方 lane-gate 被两份既有 foreign 账本 dirty 前置阻断，交 C2 清洁完整组合。

## 提交与基线

- WP-184 原候选：`a69530132645e8b2f6349ae58be90fecedb7a66f`；原报告 `WP-184-REPORT.md` 与 raw 均保留。
- 开工正常合并 main `33d1323a9df2205f3c13cacf89f157242ada9b90`，merge
  `13d2ff42719db0387f163babbd94ed3f3bc59806`。main 已有 `equivalence/runtime.ts` 的正式 descriptor，未复制 runtime 框架。
- `a06b304c6`：五文件 runtime fixture 修正及逐条 Rust 来源说明。
- `e90d55c56c97680fb0dd3e347bebf4e13cebde50`：协调者自动检查点保存 stderr fixture 和两条真实卸载回归，未重写历史。
- `1b2d48075`：活跃期 logger 绑定、返回既有 dispose Promise、SPEC/LANE/BLOCKERS 来源与边界。
- `f7bd10661ae1a99ed6f01358e7709fbbccdf0051`：协调者自动检查点保存交付报告草稿；后续正式报告补齐最终回执，不覆盖该历史。
- 最终分支 tip/base 由 wp-done 回执追加；本包新候选替换旧 a695 tip，**C2 不得借旧 tip 两文件36绿签整域**。

## 实施与真实时序

1. 六文件复用 `currentStdioRuntime()` 的 canonical command + explicit env；stdout/length 的批准条目和 start 请求使用同一 descriptor。Rust `global.rs:491-504` 的最小环境清理原样保留。
2. runtime-only Electron 六文件102绿后，用 stdin EOF 驱动真实子进程在 host dispose 后写中文 WARN 和非法 UTF-8。两端都复现2失败/Errors6：不是把原 Errors9 全归 GUI fixture，也不是负载解释。
3. 根因：`index.ts` 两 logger 闭包在 stderr finally、stdout finally、transport close 中重新读取 inactive `ctx.log`；两个 disposer 又丢弃清理 Promise。Rust `global.rs:683,721-742,788-848` 的日志生命周期不依赖会话活跃性。
4. 最窄修复只在 `index.ts` apply 期间绑定原 target 的真实 logger，保留原 optional logger 调用语义；原 effect 返回 sessions/mcpService dispose Promise（Cordis 会等待）。无 active 吞日志、空 catch、sleep、pending 框架、transport 算法或预算改动。
5. 新测试走真实 MCP 插件、批准门、Node 子进程与 F4 文件日志，断言原 WARN/ERROR/两 reader terminated/graceful close；dispose 返回后 PID 确已消失；主动 close 无 error/closed 事件。原 stdio-proxy exitCode/SIGTERM/SIGKILL 断言、stdout receive 等待者 settle、WP-184 固定30s与 initialize→initialized 无id/params字节继续由原测试验证。

## 每个修改夹具的 Rust 依据

所有旧断言/输入 payload/时限原样保留，仅替换解释器 command/env。以下源文件均已审读：

| TS 文件 | Rust 依据与保留断言 |
|---|---|
| tests/client.test.ts | client.rs:1345-1372：isError 文本拼接、完整 WARN 数组、result/error 优先级、失败后连接仍有效；global.rs:491-504 明确 env |
| tests/stdio-proxy.test.ts | global.rs:575-683 EOF 一次消费；:788-848 graceful/SIGTERM/SIGKILL 原 exitCode/signalCode 与阶段日志及预算 |
| tests/stdio-stderr.test.ts | global.rs:721-742：UTF-8 跨块、trim_end、完整 WARN、非法字节 ERROR、唯一 terminated；新增真实卸载测试沿 stdio_proxy.rs:134-140/client.rs:970-977 的 close 清理 |
| tests/stdio-stdout.test.ts | global.rs:560-684、:780-785：原始消息、framing/UTF-8 错误、stdout终态、buffer drain 与 receive 拒绝；批准条目/request 同 descriptor |
| tests/stdio-length-text.test.ts | global.rs:598-649、:869-942：原 usize 文本/溢出/精确 cap/解析先错顺序；批准条目/request 同 descriptor |
| tests/transport-auth.test.ts | cmd/mcp.rs:1164-1243：真实解释器 fixture；success=true、tools_count=1、preview echo_upper 与原 camelCase |

## Jobs / raw

所有原件：`/home/dsdev/.oc-jobs/done/<job>.log`（同名 `.json` 保命令、cwd、时间与原退出码）。Errors0 指完整输出没有 Unhandled Errors 项，不删除任何 Errors 行。

| 阶段 | job | passed / failed / skipped / Errors / raw exit |
|---|---|---|
| 起点类型 | 20261105222522-f1942e | typecheck exit0 |
| runtime-only Electron 六文件 | 20261105222628-e2186b | 102 / 0 / 0 / 0 / 0 |
| Node 六文件红（排队后读到新增卸载回归，不冒作纯起点） | 20261105222522-94618c | 102 / 2 / 0 / 6 / 1 |
| Electron stderr 生命周期红 | 20261105222808-b343ab | 4 / 2 / 0 / 6 / 1 |
| Electron stderr 修后 | 20261105222929-4895b4 | 6 / 0 / 0 / 0 / 0 |
| 修后类型 | 20261105222929-065409 | typecheck exit0 |
| 双入口 importable | 20261105223012-41c5b9 | ok / exit0 |
| strict | 20261105223012-75466c | 0 violation / exit0 |
| wiring MCP | 20261105223028-ea9041 | ported100 / 未接入0 / exit0 |
| wiring browser | 20261105223028-0f307e | ported105 / 未接入0 / exit0 |
| ledger --check --no-write | 20261105223012-2d22ac | exit0；原文如下 |
| 中间版本 Electron 双目录 | 20261105223012-ecc331 | 453 / 18 / 0 / 0 / 1 |
| **最终 Electron 双目录** | **20261105223333-d1917c** | **471 / 0 / 0 / 0 / 0；51 files** |
| **最终 Node 双目录** | **20261105223012-be876d** | **471 / 0 / 0 / 0 / 0；51 files** |

中间版本 Electron 的18失败是本包初版绑定 logger 时
漏保留原 optional 调用，旧 config/bridge/tool-cache/sse 宿主的 logger 返回 undefined 时
启动失败；已恢复原 `logger?.[level]?.(message)`，不更改这些旧测试，也不归为 foreign 问题。
该作业加载的初版代码与错误展示时磁盘上的已修代码不同，完整原红保留。
最终双端回归针对已提交 `1b2d48075edb02fa897824a911253855b7fb3f2b` 启动。
Node 最终提交命令被队列去重为原尚未启动的 `20261105223012-be876d`，只实际跑一次；
作业 JSON 的 startedAt=`2026-11-05T22:35:56.702Z`，晚于正式修复提交
`2026-11-05T22:31:43Z`。两个 shell 回执是同一作业，不计为两次独立验证。
Node raw:132-133 保两条真实30s timeout，:230-231 为51文件471项全绿。
最终 Electron raw:153-154 保两条真实30s timeout 用例，:181-204 覆盖 stderr6、close20、
transport-auth16、client6，:30/:94 保 length39/stdout17；:234-235 为51文件471项全绿。
首轮 wiring 错传完整目录，
`20261105223012-663200` / `20261105223012-860d35` 虽 exit0 但 ported0，**不算接线证据**；已用 `--lane mcp/browser` 正确参数提交。

门禁分项原文（本 lane）：

```text
ledger: commands 1058 (A 99.8% B 0% C 0%), tests 8109 (A 89.5% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 16 (unknown 3609, not vetoed)
合计 ported 100，其中所测模块未从 index.ts 接入 0（0.0%）
合计 ported 105，其中所测模块未从 index.ts 接入 0（0.0%）
(allowed) host/plugins/browser/src/browser-bridge.js:42:7 [empty-catch]
(allowed) host/plugins/browser/src/browser-bridge.js:388:9 [empty-catch]
(allowed) host/plugins/browser/src/browser-service.ts:102:30 [empty-catch]
(allowed) host/plugins/browser/src/browser-service.ts:852:45 [empty-catch]
(allowed) host/plugins/browser/src/download-hash.ts:34:30 [empty-catch]
(allowed) host/plugins/browser/src/network-probe.ts:27:42 [empty-catch]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:10:26 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:12:26 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:14:28 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:16:30 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:18:31 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:20:34 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:22:32 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:24:37 [cross-plugin-impl]
(allowed) host/plugins/browser/tests/index-webpage-execute.test.ts:26:37 [cross-plugin-impl]
(allowed) host/plugins/mcp/src/oauth-manager.ts:720:34 [empty-catch]
(allowed) host/plugins/mcp/src/probe.ts:742:31 [empty-catch]
(allowed) host/plugins/mcp/src/probe.ts:772:33 [empty-catch]
boundaries: scanned 3132 files, 0 violation(s), 241 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

原 WP-184 证据保持：Node `20261105220920-5b2eb6` 469p/0f/Errors0/raw0；Electron
`20261105220929-a6af3e` 456p/13f/Errors9/raw1。原13路径为 client4、stdio-proxy close3、
stderr2、stdout backend3、transport-auth probe1；六文件 runtime-only 定位已全部转绿。

## 官方门禁

正式修复提交后正常 merge main（Already up to date），直接绝对路径运行、没有 jobs 父：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs
有未提交的改动，先提交再自检（自检结果按提交记录）：
M migration/LEDGER.md
 M migration/ledger.json
Exited with code 2
```

gate job 无：前置退出，没有进入分项。两份 foreign 起点账本未提交/还原。C2 需对本包最终新 tip 作清洁完整组合；WP-184 保持部分 blocked，不能将分项绿写成官方 gate 通过。

## TESTMAP 与未完成

- pending **1→1**，MCP100 + browser105 ported；去向零改动，无 merged/obsolete 申请。唯一 pending：`tests/browser_capability_contract.rs::embedded_browser_capabilities_match_tauri_schema`（Rust :24），等 F2 等价 capability schema。
- 无新增 API/依赖/npm 包；不消费尚未 main 的 WP-194，不处理 WP-195/196、F1/F2 或 Rust 业务。
- 仍需 C2 完整 gate/独立签收；macOS/Windows、真实壳窗口及原其他 framing/serde/rerank/下载未决不借此关闭。未自抬 A/B/C/G1。
- 旧 foreign ledger 只读快照：commands62/A62/B62（100%/100%）、tests206/A204/B0
  （99%/0%），inputs.vitest=null；这是既有生成物，不作为本包当前 A/B 等价评分。
  当前 no-write 全局摘要见上，不重写账本或自行提升等级。

## 供抽检

1. `stdio-stderr.test.ts` 新 session/backend 用例：EOF 确由生产 dispose 关闭 stdin 触发，F4 文件 logger 保留 WARN、InvalidData ERROR 与 terminated；PID 退出断言不能被日志替身冒充。
2. `stdio-proxy.test.ts` 三阶段真实关闭及 `equivalence/mcp-service.test.ts` 原30s/wire序列：runtime/env 替换后原预算、exitCode/SIGKILL、initialized bytes 与完整失败方向均保留。
