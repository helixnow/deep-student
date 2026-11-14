结论：部分完成，initialized 原名 wire 修复及 Node 真实入口回归已完成；官方 gate 被 foreign 账本 dirty 阻断，Electron 双目录另有旧路径失败，均交 C2 正常组合/后继处理，未签全绿。

## 提交与基线

- 生产/测试：`d2379149aab84bcf9545a9a5bceca76073d28f0a`（协调者自动检查点，已核实三文件内容完整）。
- 正式来源说明：`be24c297ef290f87069c1602ebaa5b70153881a9`；提交说明逐条引用 Rust client.rs:1272，覆盖五处旧通知序列期待。
- 正常合并 main：起点 `fd9d654d7dddee26913a1f8ab2b064445ff99dc0` → `be646f2522f1028ae6e6553f5afeb201b05e76c4`，合并提交 `5365230fd`。WP-154/118 已含在 `acc3ecac3` 历史中。
- 最终 tip/base 见 wp-done 报告末尾的交付回执（含本报告的收尾提交）。本包代码净改只在 `host/plugins/mcp/`；未改 Rust、browser、TESTMAP 或 foreign 账本。

## 行为与证据

- `src/probe.ts:216` 仅把 `notifications/initialized` 改成 `initialized`。Rust `client.rs:1263-1274`：store session/serverInfo → ServerInfoReceived → await notification → return；`104-109,1736-1746`：无 id，None params 省略，通知原字节 `{"jsonrpc":"2.0","method":"initialized"}`。
- `equivalence/mcp-service.test.ts:84-100,237-249`：经真实注册 test_mcp_connection / test_mcp_http，完整序列 initialize→initialized→tools/list→prompts/list→resources/list，另断言原通知 bytes。SSE 序列与 lifecycle 也完整保留。
- `equivalence/mcp-service.test.ts:282-303`：安装真实 mcp provider，经 initializeGlobalClient/connectMcpClient 完成真实 stdio/HTTP connect→tools/list，断言三步完整序列、通知 bytes、原 clientInfo 与工具结构。
- `equivalence/mcp-service.test.ts:305-387`：真实 HTTP 服务暂不返回 notification 响应，事件回调读已存 server，远端收到通知后 initialize 仍未 settle；202/503/断连后分别成功/原错误。503/断连另走已注册 test_mcp_http 与 mcp.initializeGlobalClient，验证初始化阶段前缀、global client null、原失败日志、没有后续 tools/list。
- 旧 stdio disconnect/garbage 两条真实等待者仍断言固定 30s 后 settle、原错误及超时日志、子进程退出/空会话；未放宽时间预算、删步骤或把 toEqual 改成 contains。
- `tests/client-protocol.test.ts:91-96` 保留 Rust :2370-2382 原 serializer 输入及 None 断言（:2373 的现代 method 字符串只是 serializer 测试数据）；:100-103 另增 Rust :1272 实际通知 bytes，未重定向原 TESTMAP。

## 作业原件

所有 raw 为 `/home/dsdev/.oc-jobs/done/<job>.log`。Errors0 表示完整 Vitest 输出没有 Errors / Unhandled Errors 项，不把 CLI -t 未选计为全量通过。

| 检查 | job | 结果 |
|---|---|---|
| 起点 typecheck | 20261105220504-3ee2a3 | exit0 |
| 起点两文件 | 20261105220505-acee64 | 30 passed / 0 failed / 0 skipped / Errors0 / exit0 |
| 最窄红：真实 stdio/HTTP | 20261105220756-ea5f87 | 2 failed / 24 因 -t 未选 / Errors0 / exit1；均只差通知名 |
| 最窄绿+新增入口/发送时序 | 20261105220840-4a1129 | 7 passed / 19 因 -t 未选 / Errors0 / exit0 |
| Node 完整双目录 | 20261105220920-5b2eb6 | 51 files / 469 passed / 0 failed / 0 skipped / Errors0 / exit0 |
| 首轮修改后 typecheck | 20261105220840-803a34 | exit2：新增测试 Promise.withResolvers 不在当前 TS lib，已改普通 Promise；不是他人红 |
| 普通 Promise 修正后两文件 | 20261105221240-0d9e4a | 36 passed / 0 failed / 0 skipped / Errors0 / exit0 |
| 合并后最终 typecheck | 20261105221148-3794c3 | exit0，已包含普通 Promise 修正 |
| Electron 完整双目录 | 20261105220929-a6af3e | 46 files passed / 5 failed；456 passed / 13 failed / 0 skipped / **Errors9 / exit1** |
| strict | 20261105220920-33cf96 | 0 violation / exit0 |
| 双入口 importable | 20261105220920-ef9ee8 | importable: ok / exit0 |
| wiring mcp | 20261105220920-158afb | ported100 / 未接入0 / exit0 |
| wiring browser | 20261105220921-1ebcb2 | ported105 / 未接入0 / exit0 |
| ledger --check --no-write | 20261105220920-7f4767 | exit0，原文如下 |

```text
ledger: commands 1058 (A 99.8% B 0% C 0%), tests 8109 (A 89.5% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 16 (unknown 3591, not vetoed)
```

lane 的 foreign 旧生成物只读快照仍报 commands62/A62/B62（100%/100%）、tests206/A204/B0（99%/0%），inputs.vitest=null；这是旧账本状态，不能当本包当前 A/B 等价证据。本次 no-write 只输出上述全局摘要，未重写账本或自抬本 lane 等级。

## TESTMAP、所有权与未完成

- 去向零改动。MCP 100 ported / pending0，browser 105 ported / pending1；全 lane pending **1→1**，无 merged/obsolete 申请。唯一原 pending 为 `tests/browser_capability_contract.rs::embedded_browser_capabilities_match_tauri_schema`（Rust :24 → browser/TESTMAP.md:124），仍等 F2 的等价 capability schema。
- 本包不新增公共 api.ts / 依赖 / npm 包；所用 MCP provider/transport 均为正式实现。通知只改本 lane 外发字节，无表写入。
- 原所有权证据保留：X6-SW-0003 / L19-V2-01 对应 `browser/repository/vfs-metadata.ts:11` 直接 UPDATE L11 resources；Rust `index_webpage_executor.rs:720-745` 为 serialize→同conn UPDATE(metadata_json,updated_at)→unit sync，SQL 错误保 WEBPAGE_SAVE_FAILED。main `be646f252` 已有 L11 `types/files.ts:158` / `repository/resources.ts:439` 的 updateResourceMetadataWithConn(conn, resourceId, metadataJson, updatedAtMs): void；消费由 WP-196 后继处理，旧 browser BLOCKERS 的缺接口描述不再是当前阻塞，实际直写 finding 未关闭。
- browser typed 链 WP-195 仍按 brief 等 WP-194main，本包不处理。typed列表/分页/unknown server 默认值/完整错误分类及原其他 serde/运行时未决保留。A/C/G1 不因本包 B wire 修复签收。
- 官方 gate 的两份 foreign 账本 dirty 属起点已知生成物，未 add/commit/restore；需 C2 对当前候选正常组合跑全 gate，不能以表内分项绿替代。

### Electron 双目录原红与归属

`20261105220929-a6af3e.log:291-440` 完整列出13项失败：

- `tests/client.test.ts` 4项（isError、connect/list/call、版本warn、registry）及 `stdio-stderr.test.ts` backend 1项：`Timeout error: Request expired during periodic cleanup`，`client-dispatch.ts:81`。
- `stdio-proxy.test.ts` close三项：两次 `expected 1 to be +0`（:200/:227）、一次 `expected null to be 'SIGKILL'`（:249）。
- `stdio-stderr.test.ts` frontend 1项：完整warn数组多出 `Missing X server or $DISPLAY`、`The platform failed to initialize. Exiting.` 和 D-Bus 错误；没有删除这些观测或放宽原数组断言。
- `stdio-stdout.test.ts` backend三项：`Transport error: Channel closed`（:130），两次 `expected false to be true`（:150）。
- `transport-auth.test.ts::stdio_probe_parses_spec_camel_case_tools`：`Test timed out in 30000ms`，原预算未改。
- 原 `Errors 9 errors` 全是 `cannot get required service "log" in inactive context`，栈 `mcp/index.ts:83` → `stdio-proxy.ts:251 monitorStderr`；来源 stdio-length-text / stdio-stdout 的清理阶段（raw:441-595）。

归属证据：这些测试及 `index.ts` / `stdio-proxy.ts` 与 main 无差异；旧测试 `process.execPath` 在 Electron 下为 Electron binary，`client.test.ts:119`、`stdio-proxy.test.ts:192/222/244`、`transport-auth.test.ts:327` 等传 env `{}`，生产 `stdio-proxy.ts:360` 只复制最小 env，未带 ELECTRON_RUN_AS_NODE。原日志已证明裸 Electron 启动图形环境报错；底层close/stdout/session路径也不执行本包改变的 JsonRpcProbe.initialize 通知行。尚未对旧tip运行Electron作差分，不冒称全部既有红已由旧tip实跑确认。

需要 L19 后继单元处理旧测试 runtime/env 与 reader结束后host dispose的时序；不是要求F2提供新API，也不在本包扩大生产env继承。此整run中本包 mcp-service26 + client-protocol10通过，但 Errors9 使整run不合格；独立两文件Electron作业用于核实本包Errors，不替代双目录红。

### 原工具回执摘录

正式提交 `be24c297e` 后正常 merge main，再**直接**执行
`node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs`，未套 jobs 父进程。
原退出码2，gate job **无**（前置失败，没有执行任何分项）：

```text
有未提交的改动，先提交再自检（自检结果按提交记录）：
M migration/LEDGER.md
 M migration/ledger.json
```

最终收尾提交后同样正常 merge 并直接复跑，回执附交付末尾；不删除、提交、移动或还原这两份foreign文件以换取gate通过。

```text
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
boundaries: scanned 3130 files, 0 violation(s), 241 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

## 供抽检

1. Rust client.rs:1272 / :104-109 / :1736-1746 → 已注册 stdio、HTTP probe 与 connect 的完整序列和原 notification bytes（mcp-service.test.ts:98-99,244-245,297-298）。
2. Rust client.rs:1263-1274 的事件/await/失败先后 → mcp-service.test.ts:305-387；连同旧 :189-205 的真实断连/30s waiter settle，核查不会提前返回成功、继续列工具或漏掉失败日志。
