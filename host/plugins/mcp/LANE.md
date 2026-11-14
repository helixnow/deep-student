# L19-mcp-browser：MCP 与浏览器

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L19-mcp-browser（MCP 与浏览器） |
| 目录 | `host/plugins/mcp/`（同 lane 另有 `host/plugins/browser/`，文件划分见 `scripts/electron-migration/lib/lanes.mjs` 的 DIR_SPLIT） |
| Rust 范围（lanes.md） | dstu-mcp、dstu-browser，cmd 下的 mcp、network、web_search，以及 browser、index_webpage 工具 |
| 主要提供 | `mcp@1`、`browser@1`、`websearch@1` |
| 主要消费 | F4 |
| 特别注意 | MCP stdio 子进程生命周期；搜索重试分类（402 不重试） |
| 规模（本目录） | 15234 行 · 22 个文件 · 32 个命令（前端调用 21） · 100 个测试 |
| 规模（整条 lane，inventory） | 27060 行 · 43 个文件 · 70 个命令（前端 33） · 206 个测试 |
| 契约 | [`contracts/ipc/L19-mcp-browser.json`](../../../contracts/ipc/L19-mcp-browser.json) |
| 服务草稿 | [`contracts/services/DRAFT-L19-mcp-browser.md`](../../../contracts/services/DRAFT-L19-mcp-browser.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-mcp/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-mcp/src/lib.rs` | 32 | 0 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/auth.rs` | 1869 | 22 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/client.rs` | 2471 | 13 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/commands.rs` | 99 | 0 | 5 |
| `src-tauri/crates/dstu-mcp/src/mcp/config.rs` | 244 | 0 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/global.rs` | 1245 | 12 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/http_transport.rs` | 352 | 3 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/mod.rs` | 86 | 2 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/oauth_callback.rs` | 233 | 1 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/protocol_version.rs` | 337 | 5 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/rmcp.rs` | 74 | 0 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/sse_transport.rs` | 613 | 4 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/stdio_proxy.rs` | 223 | 2 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/test_helpers.rs` | 377 | 0 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/transport.rs` | 5 | 0 |  |
| `src-tauri/crates/dstu-mcp/src/mcp/types.rs` | 53 | 0 |  |
| `src-tauri/crates/dstu-mcp/src/tools/mod.rs` | 1384 | 2 |  |
| `src-tauri/crates/dstu-mcp/src/tools/web_search.rs` | 3812 | 17 |  |
| `src-tauri/src/cmd/mcp.rs` | 1246 | 9 | 20 |
| `src-tauri/src/cmd/network.rs` | 83 | 0 | 1 |
| `src-tauri/tests/mcpbench_integration.rs` | 378 | 8 |  |

另有命令定义在其他 lane 拥有的文件里（按命令名分派）：`src-tauri/src/commands.rs`——只迁移下表列出的命令。

### 命令（32）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `cancel_mcp_oauth` | `crates/dstu-mcp/src/mcp/commands.rs:43` | async | app | src/features/settings/components/mcp-editor/McpOAuthControls.tsx:94 | (serverId: string) → null ! string |
| `export_mcp_config` | `src/commands.rs:7025` | async | none | — | (config: McpConfig__De, format: string) → string ! AppError |
| `export_mcp_config` | `src/commands.rs:7053` | async | none | — | (config: McpConfig__De, format: string) → string ! AppError |
| `get_mcp_config` | `src/commands.rs:7003` | async | none | — | (（无）) → McpConfig ! AppError |
| `get_mcp_config` | `src/commands.rs:7038` | async | none | — | (（无）) → McpConfig ! AppError |
| `get_mcp_oauth_access_token` | `crates/dstu-mcp/src/mcp/commands.rs:81` | async | app | src/mcp/mcpService.ts:256 | (serverId: string, resourceUrl: string) → string \| null ! string |
| `get_mcp_oauth_status` | `crates/dstu-mcp/src/mcp/commands.rs:61` | async | app | src/features/settings/components/mcp-editor/McpOAuthControls.tsx:30 | (serverId: string, resourceUrl: string) → McpOAuthStatus ! string |
| `get_mcp_status` | `src/cmd/mcp.rs:25` | async | app | src/utils/settingsApi.ts:196 | (（无）) → Value ! AppError |
| `get_mcp_stdio_allow_unapproved` | `src/cmd/mcp.rs:792` | async | app | src/features/settings/components/McpDangerZoneSection.tsx:33 | (（无）) → boolean ! AppError |
| `get_mcp_tools` | `src/cmd/mcp.rs:58` | async | none | — | (（无）) → Value[] ! AppError |
| `import_mcp_config` | `src/commands.rs:7016` | async | none | — | (path: string) → McpConfig ! AppError |
| `import_mcp_config` | `src/commands.rs:7044` | async | none | — | (path: string) → McpConfig ! AppError |
| `mcp_stdio_close` | `src/cmd/mcp.rs:654` | async | app | src/mcp/tauriStdioTransport.ts:206 | (sessionId: string) → null ! AppError |
| `mcp_stdio_send` | `src/cmd/mcp.rs:639` | async | app | src/mcp/tauriStdioTransport.ts:195 | (sessionId: string, payload: string) → null ! AppError |
| `mcp_stdio_start` | `src/cmd/mcp.rs:553` | async | app | src/mcp/tauriStdioTransport.ts:161 | (command: string, args: string[], env?: object \| null, framing?: string \| null, cwd?: string \| null) → string ! AppError |
| `network_probe` | `src/cmd/network.rs:38` | async | none | — | (url: string, method?: string \| null, timeoutMs?: integer(u64) \| null) → NetworkProbeResult ! string |
| `preheat_mcp_tools` | `src/cmd/mcp.rs:822` | async | app | src/features/settings/components/mcp-editor/mcpServerOps.tsx:43<br>src/features/settings/components/mcp-editor/mcpServerOps.tsx:68<br>src/mcp/mcpService.ts:2128 | (（无）) → Value ! AppError |
| `reload_mcp_client` | `src/cmd/mcp.rs:784` | async | app | src/utils/settingsApi.ts:174 | (（无）) → Value ! AppError |
| `revoke_mcp_oauth` | `crates/dstu-mcp/src/mcp/commands.rs:49` | async | app | src/features/settings/components/mcp-editor/McpOAuthControls.tsx:80 | (serverId: string) → null ! string |
| `save_mcp_config` | `src/cmd/mcp.rs:688` | async | none | — | (config: Value) → boolean ! AppError |
| `set_mcp_stdio_allow_unapproved` | `src/cmd/mcp.rs:801` | async | app | src/features/settings/components/McpDangerZoneSection.tsx:49 | (enabled: boolean) → null ! AppError |
| `start_mcp_oauth` | `crates/dstu-mcp/src/mcp/commands.rs:15` | async | app | src/features/settings/components/mcp-editor/McpOAuthControls.tsx:59 | (serverId: string, resourceUrl: string, clientId?: string \| null, clientSecret?: string \| null, scopes?: string[] \| null) → StartOAuthOutcome ! string |
| `test_mcp_connection` | `src/cmd/mcp.rs:65` | async | app | src/utils/settingsApi.ts:107 | (command: string, args: string[], env?: object \| null, cwd?: string \| null, framing?: string \| null) → Value ! AppError |
| `test_mcp_connection` | `src/cmd/mcp.rs:103` | async | app | src/utils/settingsApi.ts:107 | (command: string, args: string[], env?: object \| null, cwd?: string \| null, framing?: string \| null) → Value ! AppError |
| `test_mcp_http` | `src/cmd/mcp.rs:172` | async | app | src/utils/settingsApi.ts:154 | (endpoint: string, apiKey: string, env?: object \| null) → Value ! AppError |
| `test_mcp_http` | `src/cmd/mcp.rs:189` | async | app | src/utils/settingsApi.ts:154 | (endpoint: string, apiKey: string, env?: object \| null) → Value ! AppError |
| `test_mcp_sse` | `src/cmd/mcp.rs:142` | async | app | src/utils/settingsApi.ts:144 | (endpoint: string, apiKey: string, env?: object \| null) → Value ! AppError |
| `test_mcp_sse` | `src/cmd/mcp.rs:159` | async | app | src/utils/settingsApi.ts:144 | (endpoint: string, apiKey: string, env?: object \| null) → Value ! AppError |
| `test_mcp_websocket` | `src/cmd/mcp.rs:119` | async | app | src/utils/settingsApi.ts:134 | (url: string, env?: object \| null) → Value ! AppError |
| `test_mcp_websocket` | `src/cmd/mcp.rs:130` | async | app | src/utils/settingsApi.ts:134 | (url: string, env?: object \| null) → Value ! AppError |
| `test_rmcp_streamable_http` | `src/cmd/mcp.rs:671` | async | none | — | (url: string, apiKey?: string \| null) → Value ! AppError |
| `test_rmcp_streamable_http` | `src/cmd/mcp.rs:680` | async | none | — | (url: string, apiKey?: string \| null) → Value ! AppError |

### 发出的事件（13）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `mcp-bridge-request` | 字面量 | crates/dstu-mcp/src/tools/mod.rs:472 (emit) |
| `mcp-test-progress` | 字面量 | src/cmd/mcp.rs:76 (emit) |
| `{}_web_search` | 动态（format!） | crates/dstu-mcp/src/tools/mod.rs:1141 (emit) |
| `{}-closed` | 动态（format!） | crates/dstu-mcp/src/mcp/stdio_proxy.rs:107 (emit) |
| `{}-error` | 动态（format!） | crates/dstu-mcp/src/mcp/stdio_proxy.rs:91 (emit) |
| `{}-message` | 动态（format!） | crates/dstu-mcp/src/mcp/stdio_proxy.rs:85 (emit) |
| `McpEvent::Connected` | 动态（表达式） | crates/dstu-mcp/src/mcp/client.rs:966 (emit) |
| `McpEvent::Disconnected` | 动态（表达式） | crates/dstu-mcp/src/mcp/client.rs:976 (emit) |
| `McpEvent::PromptsChanged` | 动态（表达式） | crates/dstu-mcp/src/mcp/client.rs:1169 (emit) |
| `McpEvent::ResourcesChanged` | 动态（表达式） | crates/dstu-mcp/src/mcp/client.rs:1166 (emit) |
| `McpEvent::RootsChanged` | 动态（表达式） | crates/dstu-mcp/src/mcp/client.rs:1172 (emit) |
| `McpEvent::ServerInfoReceived(server_info.clone())` | 动态（表达式） | crates/dstu-mcp/src/mcp/client.rs:1267 (emit) |
| `McpEvent::ToolsChanged` | 动态（表达式） | crates/dstu-mcp/src/mcp/client.rs:1129 (emit) |

### 契约中的事件（6，`contracts/ipc/L19-mcp-browser.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `{}_web_search` | 是 | object \| object \| object | crates/dstu-mcp/src/tools/mod.rs:1141 (emit) |
| `mcp-bridge-request` | 否 | object | crates/dstu-mcp/src/tools/mod.rs:472 (emit) |
| `mcp-test-progress` | 否 | object | src/cmd/mcp.rs:76 (emit) |
| `{}-closed` | 是 | object | crates/dstu-mcp/src/mcp/stdio_proxy.rs:107 (emit) |
| `{}-error` | 是 | object | crates/dstu-mcp/src/mcp/stdio_proxy.rs:91 (emit) |
| `{}-message` | 是 | object | crates/dstu-mcp/src/mcp/stdio_proxy.rs:85 (emit) |
<!-- END GENERATED:lane -->

## 备注

### WP-214：stdio 双运行时与结束日志（2026-11-05，WP-184 后继）

- 起点 `a69530132645e8b2f6349ae58be90fecedb7a66f`，正常合并 main
  `33d1323a9df2205f3c13cacf89f157242ada9b90` 得 `13d2ff42719db0387f163babbd94ed3f3bc59806`。
  两份 foreign migration 账本保持起点状态。类型起点 job `20261105222522-f1942e` exit0。
- 六文件复用已有 currentStdioRuntime；批准条目与实际请求带同一 command/env，不放宽生产白名单。
  runtime-only Electron 定位 job `20261105222628-e2186b`：102 passed / Errors0 / raw0，
  原13失败路径全部保原断言通过。原 WP-184 Electron 456p13f/Errors9/raw1 原件不改写。
- 新真实 stdin EOF→stderr 尾部→host dispose 回归进一步证明 logger 生命周期是独立缺陷：
  Node `20261105222522-94618c`（起点排队后读到新增用例，不能冒作纯起点测试）
  102 passed / 2 failed / Errors6 / raw1；Electron `20261105222808-b343ab`
  4 passed / 2 failed / Errors6 / raw1，栈覆盖 index.ts 的 stdio/MCP logger → reader/close。
- 只在 index.ts 活跃 apply 中绑定真实两 target logger，原 effect 返回 dispose Promise。
  无 stdio-proxy 算法/预算改动；修后 Electron stderr 六条 `20261105222929-4895b4`
  6 passed / Errors0 / raw0，真实日志文件保 WARN/ERROR/terminated/close，dispose 后 PID 已退出。
- 夹具提交 `a06b304c6`；新回归已由协调者检查点 `e90d55c56` 保存，正式修复承接其历史。
  最终双目录 Node/Electron、精确 tip/base/gate 与交付回执见 `WP-214-REPORT.md`。
- 最终正式修复版本双目录：Node `20261105223012-be876d`、Electron
  `20261105223333-d1917c` 各51文件 / 471 passed / failed0 / skipped0 / Errors0 / raw0。
  Node 队列去重后只实际跑一次；中间 Electron optional logger 回归18failed及修正原件保留于报告。
- TESTMAP 仍 MCP100 + browser105 ported / pending1；WP-184 保持部分 blocked，待 C2 用本包
  新候选完整组合，不借旧 a695 tip 的两文件36绿替代整域证据。不自签 A/B/C/G1 或 mac/Windows。

### WP-184 / D079：initialized 原通知名（2026-11-05）

- 开始正常 fast-forward 到 main `fd9d654d7`，已包含 WP-154 `578bcfba3`、WP-118 与官方
  `acc3ecac3` 集成历史；未重做依赖。起点 typecheck `20261105220504-3ee2a3` exit0，
  client-protocol + mcp-service `20261105220505-acee64` 30 passed / failed0 / skipped0 / Errors0。
- 对照 Rust `client.rs:1263-1274,1736-1746`，生产只改 `probe.ts:216` 为
  `await notify('initialized')`，store→ServerInfoReceived→await send→return 顺序保留。
  通知字节为 `{"jsonrpc":"2.0","method":"initialized"}`（无 id / params）。
- 最窄红 `20261105220756-ea5f87` exit1：真实注册 stdio/HTTP 两条完整序列均只在通知名失败，
  2 failed / 24 因 CLI -t 未选 / Errors0；绿 `20261105220840-4a1129` exit0：7 passed /
  19 因 CLI -t 未选 / Errors0，含真实 registered connect 及 HTTP 通知等待/503/断连。
  完整无过滤回归及 gate 结果见 WP-184 交付报告，过滤运行不冒作全量。
- 五处旧 probe 序列期待分别按 Rust :1272 更正：stdio success、tools-list-error、stdio
  disconnect/garbage timeout、HTTP success、SSE success；不删步骤、不把 toEqual 放宽。
  Rust :2373 serializer 单测的现代 method 输入仍保留，另增实际 :1272 字节用例。
- 生产及测试三文件已被协调者自动检查点 `d2379149a` 保存；后续正式提交承接该历史并逐条
  说明 Rust :1272 的旧期待纠正，不重写检查点。提交前再次正常 merge main，接收 L11 正式更新。
- 双目录 Node 回归 `20261105220920-5b2eb6`：51 files / 469 passed / failed0 / skipped0 /
  Errors0 / exit0。新测试最初用 Promise.withResolvers，typecheck `20261105220840-803a34`
  按仓库 TS lib 报 TS2339 / exit2；已只改为普通 Promise 构造器，保留发送挂起/恢复的全部断言。
- 修正后两文件 `20261105221240-0d9e4a`：36 passed / failed0 / skipped0 / Errors0 / exit0；
  合并后 typecheck `20261105221148-3794c3` exit0。Electron 双目录原红见 BLOCKERS 与
  WP-184-REPORT，不能以 Node 或本包分项绿签整域。
- TESTMAP 去向不变：MCP pending0 / browser pending1（生成表头不手改）。typed列表/分页、
  unknown server 默认值、全错误分类均留后继；browser WP-195 等194main、WP-196 网页归属
  按独立工作包处理。此 B wire 候选不签 A/C/G1 或全域等价，独立复验由协调者安排。

### v2 接手盘点（2026-11-04，GPT-6.1 Sol）

接手基线 `33583d9aa`；main 合并 `3fef8b8e8`。旧 ACCEPTANCE 为复核人所有，不修改；
其中全勾选不代表通过 v2。共享 SSE/F1 target 已在 `ca54a4a73` 接线，本轮不重做。
恢复后 typecheck 作业 `20261104093338-76b3d7` exit 0；SSE/HTTP/target 最小集
`20261104093338-a544f4` 25 passed、exit 0，无 Errors。

八类编号：①生产接线 ②所有权 ③serde ④日志/错误 ⑤测试真实性 ⑥分支完整性
⑦运行时 ⑧复核闭环。下表为接手定位，不把尚未逐分支复审的旧实现签成等价。

| 命令/模块（覆盖本目录全部命令） | 八类自查结果与证据 |
|---|---|
| get/import/export/save_mcp_config、get_mcp_status、get_mcp_tools | ①入口 index.ts:106-117；②settings API；③config.ts:44 读取 Value 后逐字段处理，宽整数/D3仍需复审；④错误 index.ts:115；⑤⑥旧 config.test.ts 尚需逐断言核对；⑦save 顺序见 SPEC；⑧未签 v2 |
| get/set_mcp_stdio_allow_unapproved、mcp_stdio_start/send/close、test_mcp_connection | ①index.ts:118-169；②无自写跨表 SQL；③mcp-settings.ts:17/stdio-validation.ts 校验；④index.ts:125-146 审计日志；⑤Rust测试映射见 TESTMAP:103-111，尚需逐断言复核；⑥⑦stdio-proxy.ts 清理/退出平台路径待 v2 审读；⑧未签 v2 |
| test_mcp_sse/http/websocket、test_rmcp_streamable_http | ①index.ts:171-184→probe.ts；②无跨表写；③JSON-RPC解析 probe.ts:72；④错误以 failure Value 返回；⑤⑥SSE真实HTTP分片/快速失败已复验；⑦probe.ts:658 用 Date.now 测 deadline，记 L19-V2-03；⑧共享尾CR仍属F4，不复制修补 |
| start/cancel/revoke_mcp_oauth、get_mcp_oauth_status/access_token | ①index.ts:203-254→oauth-manager；②secureStore API；③oauth-manager.ts:140 持久化JSON断言需对照Rust结构复核；④⑤⑥OAuth原测试逐断言/日志复核未结束；⑦取消/dispose待复核；⑧未签 v2 |
| reload_mcp_client、preheat_mcp_tools | ①index.ts:185-201 调正式依赖；②不写llm表；③返回载荷见SPEC；④缺API明确失败；⑤tool-cache-commands用依赖替身不代表真实L02链；⑥⑦⑧main的llm/api.ts仍无两个方法（L02 W20阻塞） |
| mcp服务/ToolRegistry/frontend bridge | ①index.ts:88-104 provide；②无跨表写；③service.ts:145 Value解析；④桥错误需按Rust继续核验；⑤target广播/定向/错误窗口最小集已通过；⑥无window回退保留；⑦service.ts:197 墙钟计时记L19-V2-03；⑧真实Electron窗口未验 |
| webSearch（由browser提供，mcp拥有实现） | ①browser/index.ts:97 provide→web-search.ts:202；②settings API；③web-search-config.ts:250 `JSON.parse as ProviderStrategies` 绕过serde，记L19-V2-02；④坏JSON语义错误时未warn；⑤web-search.test需逐断言复核；⑥重试402分类已实现；⑦web-search.ts:259 信号未贯穿semaphore/rate wait、计时Date.now，记L19-V2-03；⑧未签v2 |

处理顺序：无复核未勾选 finding（用户派发为0），先处理自查 L19-V2-01（同lane browser表所有权）、
L19-V2-02（策略设置解码）、L19-V2-03（单调时钟/取消），每类先补生产入口反例；
其余旧实现保持“未完成v2复审”，不沿用旧B级作为等价证明。
真实依赖与最小接口请求记录在本目录 BLOCKERS.md 及 browser/BLOCKERS.md。

#### v2 进度
- L19-V2-02 已修（`49d3ecad3` 及检查点 `03c1e1613`/`35dd84995`）：策略覆盖经 `parseProviderStrategies`，坏结构 warn 并保留默认。
- L19-V2-03 时钟部分已修：Rust `Instant`（web_search.rs:768-825 缓存/限速、各 provider `t0`、tools/mod.rs:180/340、test_helpers.rs:357、browser_executor.rs:892/1079、index_webpage_executor.rs:283/506、cmd/web_search.rs、network.rs）全部改 `performance.now()`，毫秒按 `as_millis` 截断；`Utc::now().timestamp_millis()`（index_webpage_executor.rs:726）保留墙钟。证据：`tests/web-search.test.ts` 墙钟跳变不使缓存过期。取消信号已贯穿 semaphore/rate 等待（Rust drop future 语义：排队中 abort 移出等待队列、不泄漏 permit、不占限速窗口），证据见 `tests/web-search.test.ts` 两条 doSearch 用例。
- 撤销 L19-V2-04（误报）。仍开放：V2-01（L11 API，已上报）、V2-05、V2-06。

### v2 排雷清单（X6 基线 2ee9a9cbe，按当前 SHA 9782d55aa 核验）
证据原文：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。info / 计数类只作人工线索。

| 门禁 | 位置（基线行） | 当前核验 | Rust 证据 | finding / 状态 |
|---|---|---|---|---|
| unchecked-decode | src/oauth-manager.ts:140 parseSession | unknown→对象守卫修复后，本轮补正 map 必填/Option/Vec 类型；chrono 日期内容、重复字段、序列 struct 仍开放 | auth.rs:65-104,219 `from_str(..).ok()` | X6-UD-0042 = X6-decode-mcp-oauth-manager-140；`c9064df4e` / `257f2cbf4` 均是分项候选，不签整条 serde |
| unchecked-decode | src/oauth-manager.ts:294 discovery | 真缺陷：`null` 响应抛 TypeError，Rust 走 fallback；`authorization_endpoint` 非字符串时 Rust 进入并报 Missing；坏 URL Rust 报 `Invalid <key>` | auth.rs:979-1026、911-926 | X6-decode-mcp-oauth-manager-294，已修 `c9064df4e`，测试 `tests/oauth-manager.test.ts` X6 组 |
| unchecked-decode | src/oauth-manager.ts:365 DCR | 真缺陷：`null` 抛 TypeError；空串 client_id 被 TS 拒绝而 Rust `as_str()` 接受 | auth.rs:395-405 | X6-decode-mcp-oauth-manager-365，已修 `c9064df4e` |
| unchecked-decode | src/oauth-manager.ts:450 postToken | 改为返回 unknown，经 `jsonGet` 解码字段 | auth.rs:470-482（oauth2 crate 解析） | X6-decode-mcp-oauth-manager-450，已修 `c9064df4e` |
| unchecked-decode | src/probe.ts:425/462 | 解析的是本端 JSON.stringify 的请求，行为不变；改为解析一次并对象守卫 | — | X6-decode-mcp-probe-425/462，已修 `c9064df4e` |
| unchecked-decode | src/web-search-config.ts:250 | 后接严格 decoder `parseProviderStrategies`（L19-V2-02 已修） | web_search.rs:358 | 无需改动 |
| unchecked-decode | src/web-search-core.ts:69、web-search-providers.ts:45 | 更正：并不等价。孤立代理项、深嵌套、非法 UTF-8 字节（`resp.json()` 即 from_slice）在 Rust 会报错 | web_search.rs:1992 等 `resp.json()`、:1969 等 `from_str(&body)` | 已修，见下方 X6-UD 更正 |
| unchecked-decode[info] | src/web-search.ts:145（现 :163） | 测试复位钩子访问私有 Map，非解码 | — | 无需改动 |
| assert-parity | tests/stdio-proxy.test.ts:117 | 按 Rust 4 条 assert 逐条断言 | global.rs:1109 | X6-assert-mcp-stdio-proxy-117，已修（检查点 `bd57c6b7d`，提交 `9782d55aa`） |
| assert-parity | tests/stdio-validation.test.ts:19/31 | 按 Rust 5/3 条 assert 逐条断言 | cmd/mcp.rs:901/968 | X6-assert-mcp-stdio-validation-19/31，已修（同上） |
| log-parity[info] | auth-token / client-dispatch / client / oauth-manager / protocol-version / probe（文件级计数） | 计数线索，未逐条核；不按数量补日志 | — | pending 人工逐位置复核 |

#### C2 稳定 ID 映射（冻结报告 0119143715c0，源码基线 2ee9a9cbe）
只映射到上表条目，不重编 ID，也不重复整改。

| C2 ID | 对应条目 / 旧 finding | 状态 |
|---|---|---|
| X6-UD-0042 | X6-decode-mcp-oauth-manager-140 | 对象守卫 `c9064df4e`、map 字段补正 `257f2cbf4`；chrono 日期/原文级形式仍开放，待独立复验 |
| X6-UD-0043..0045 | X6-decode-mcp-oauth-manager-294/365/450 | 分项修复 `c9064df4e`，main 合并后待独立复验；不作为原始 JSON 整条例外 |
| X6-UD-0046、X6-UD-0047 | X6-decode-mcp-probe-425/462 | 已修 `c9064df4e`，同上 |
| X6-UD-0048 | web-search-config.ts:250 = L19-V2-02 | 已修 `49d3ecad3`（检查点 `03c1e1613`/`35dd84995`），改走严格 decoder `parseProviderStrategies` |
| X6-UD-0049、X6-UD-0050 | web-search-core.ts:69、web-search-providers.ts:45 | 已修，见下方 X6-UD 更正 |
| X6-AP-0313 | X6-assert-mcp-stdio-proxy-117 | 已修（检查点 `bd57c6b7d`），待独立复验 |
| X6-AP-0314、X6-AP-0315 | X6-assert-mcp-stdio-validation-19/31 | 已修（同上），待独立复验 |
| X6-LP-0164..0175 | log-parity[info] 行 | pending：按分支、字段和时序逐个位置人工核对，不按计数补日志 |

#### LP 逐位置增量（X6-LP-0171 / X6-LP-0172）
- X6-LP-0171：protocol_version.rs:102/121/127 的三处 warn 全在 `ProtocolNegotiator::negotiate`。当前 Rust 仓库只在该文件的测试 :278/285/292 调用，mcp/mod.rs:34 仅 reexport；生产 client.rs 不调用此协商器。TS 生产也只消费 parseVersion（client.ts），不调用 negotiate。此为生产不适用候选证据，不为补 warn 数量而新接协商路径、不伪造生产可达；保留待独立判定，不据此签全模块。
- X6-LP-0172：test_helpers.rs:158/165 两处真实缺日志已修候选。`mapEnvToHeaders` 按 Rust trim/头字段规则过滤，记录原始 key 或 key/value 的 warn，然后继续；logger 由 mcp/index.ts 命令入口传入。
- 同根发现：testSse 原来完全丢弃 env；现 GET/POST 均消费验证后的 header。校正 HTTP/SSE 显式 API key 覆盖 Authorization、HTTP 强制 Accept、SSE 仅 GET 强制 SSE Accept 的顺序；值保持 HeaderValue 的 UTF-8 字节语义。
- 生产入口证据：`tests/probe-headers.test.ts` 安装 MCP 插件、经两个 kernel 命令连接真实 node:http 服务器，完成 HTTP/SSE 握手并验证两条 warn 与请求字段；无替身 transport、未弱化旧测试。
- 验证：`20261104160518-0762fe` 两文件 18 passed / exit0；`20261104160518-900b23` typecheck exit0。其余 LP、D3、serde 原文及 owner 接口缺口仍开放，独立复验前不自签。

#### LP 逐位置增量（X6-LP-0166，client.rs:1361；其余分支仍待审）
- 真实缺陷：JsonRpcProbe.callTool 原来把 `isError:true` 原样返回；Rust :1345-1366 会提取 Text 内容、以 `; ` 拼接、warn `Tool '<name>' execution failed: <text>`，再抛 `ToolExecutionError`。现生产 connectMcpClient 把 host logger 传入 RPC，保持该顺序及无 Text 时的 `Tool execution failed` 兜底。
- 同处 :1345-1372 按 result→error→缺失结果的优先级恢复。server error 为 `Server error: ...`，无结果无错误为 `Protocol error: Tool call failed`；不再统一捏成 Tool execution failed。无关 invalid-result 的 serde 详细错误仍未对齐，不签全错误等价。
- 证据：client.test.ts 新用真实 stdio 子进程覆盖多 Text+Image、只有 Image、server error、缺 result、result/error 同在，断言 warn 与 error 字段；失败后连接仍有效。`20261104161715-73fd87` 6 passed；`20261104161715-201f5e` typecheck exit0；strict `20261104161715-760751` 全仓 0 violation。
- X6-LP-0164/0165 另已逐位置审读：auth.rs:1030 discovery fallback warn→oauth-manager.ts discovery 末尾，auth.rs:769 open-browser error→startOAuth 对应 catch；两处均已有 host logger，入口 mcp/index.ts OAuth runtime 注入 auth target。属于已有实现的源码对应证据，不为原计数补重复日志，待独立核验。

#### D3 首个独立命令边界（L19-V2-11，get_mcp_status，候选待复核）
- 真实缺陷：cmd/mcp.rs:39 的设置 u64 在 config.ts 过早 Number 转换，`9007199254740993` 内部已变成 9007199254740992。mcpStatus 现在返回精确 BigInt，直到 F1 kernel 的 wire 转换才舍入。
- 同处 `str::parse::<u64>` 不接受尾换行，原 JS 正则 `$` + BigInt 会错误接受；新共享精确解析拒绝所有非 ASCII 数字（除可选前导 +），保持有效上限 u64::MAX 与缺省 300000。
- `tests/status-u64.test.ts` 使用真实 F3/F4，断言内部精度、IPC 形状和默认分支；旧 config.test.ts 断言全部保留。作业 `20261104165531-285d28` 6 passed / exit0；`20261104165531-9f16ba` typecheck exit0。
- 撤销 SPEC 的旧全域 D3 签记。McpConfig 运行时/保存入参、ProviderStrategies、任意 JSON 数值以及 serde 错误原文仍开放；没有把本单元当作整个 D3 完成。
- 同一命令的 selected_mcp_tools 空白分支另改走 F4 rustTrim，真实设置入口覆盖 U+0085 与 U+FEFF。共享 parser 的 arbitrary_precision Value 数字/raw 与错误原文缺口已精确记录于 BLOCKERS，交 C1/C2 集中，不自行唤醒停放 owner 或复制共享 parser。

#### X6-UD-0042：persisted OAuth map 字段规则补正（候选待复核，非整条 serde 签收）
- 对照 auth.rs:65-71,93-104：token_type、token.scopes、session.scopes 均必填；两组 Vec<String> 不得过滤坏项后继续，缺失也没有 [] 默认。client_secret / refresh_token / expires_at 的 Option 只容许缺省/null/正确类型；resource_origin 只有缺省才默认空串，显式 null/非字符串要失败。
- 现 parseSession 按上述规则拒绝整条错误 map，不再默认 Bearer、过滤混合数组或把错误类型 Option 改成 null。合法空字符串/空 scopes、缺省或 null Option、legacy 缺 resource_origin、未知字段继续遵循原规则。
- `tests/oauth-session-decode.test.ts` 使用真实 F3/F4 settings 与加密 SecureStore（正常 no-system-keystore 模式），通过生产 restoreSession 和 get_mcp_oauth_status/access_token 命令验证，不以 MemorySecureStore 替身冒充持久化。未知字段含合法任意精度 `1e400`，防止后续 decoder 错拒绝。
- 首轮 `20261104200520-478969` 两文件 21 passed；补齐显式 null Option 正例后的最终矩阵 `20261104201415-07d355` 1 passed，`20261104201415-fae0df` typecheck exit0、`20261104201416-5efadc` strict 全仓 0 violation；所有既有 OAuth 测试断言未改。
- 明确保留：日期字符串内容/纳秒精度、原文重复字段、struct 序列形式仍未对齐。chrono serde 的正式共享接缝已记录 BLOCKERS 并集中上报，不把本轮 guard 称为完整 serde 解码。

#### L19-V2-13：stdio EOF 尾行重复/空转修复（候选待复核）
- 真实缺陷：LineReader.readLine 在读到 EOF 时返回最后无 LF 行，但未清空 buffer 或检查 _ended；StdioSessionManager 的 for-await 可重复发出尾行，阻止自然 EOF 清理。对照 Rust global.rs:575-581、stdio_proxy.rs:99-107，现消费尾行一次后稳定返回 null。
- 修前 `20261104204807-011f16` 的有限读取测试真实失败（期望 null，得到重复 JSON）；未运行会无限空转的旧循环来制造挂起。
- 修后新用例启动真实 Node 子进程，经生产 session start 验证两个原始 payload（末行无 LF）、唯一 closed 和空会话表；观察器保留并拒绝意外第三条，确保回归有限而非跳过测试。
- `20261104205238-c90841` 完整 stdio-proxy/client 两文件 26 passed；`20261104205238-e7bc97` typecheck exit0，`20261104205239-a318dc` strict 全仓 0 violation。所有旧 Rust 移植断言保留，CLI -t 只用于修前有限复现，最终未过滤旧测试。
- 其他 stdio framing/UTF-8、stderr 日志与退出并发仍需逐位置复核；不宣称整个 stdio 模块完成。

#### X6-LP-0168/0169：global.rs stderr 分支补正（仅 :721-742，候选待复核）
- 真实差异：StdioSessionManager 原先按 chunk.toString 解码，UTF-8 跨 chunk 可损坏；JS trimEnd 也不同于 Rust。backend/probe 的 stdioTransport 只缓存未使用的 stderr chunks，不记录原 warn/error/terminated 日志。
- 现每个 createStdioTransport 仅启动一个 monitorStderr，使用 LineReader 的原始字节行 + F4 decodeUtf8Strict/rustTrimEnd。无效 UTF-8 映射 Tokio read_line 的 `stream did not contain valid UTF-8`，记录 error 后停止，再 info terminated，并在 finally 关闭 iterator。没有新增长度限额。
- factory 共享后删除 Manager 重复监控和 backend 未用 ring；logger 经 connectMcpClient/探针命令贯穿到传输。会话/后台都记录一次，不再一处缺失、一处重复或替换坏字节后继续。
- `tests/stdio-stderr.test.ts` 的真实 Readable 字节 fixture 强制每个 UTF-8 边界，验证 NEL/FEFF/前导空格、EOF 尾行、非法字节/后续不再记录和 reader 销毁；另两条测试用真实 Node 子进程证明 backend 与 frontend session 的生产接线。未替换解码器或输出日志结果。
- `20261104211312-bc2f80` 三文件 30 passed，`20261104211312-62fe35` typecheck exit0；旧 stdio/client 断言保留。其余 global.rs warn/error、stdout UTF-8、完整 framing/退出语义仍开放，不把此分支当整条 LP 已签收。

#### L19-V2-14：stdout UTF-8 与逐行终态（C1 限定候选，非整个 framing 签收）
- 核实旧差异：LineReader.readLine、配置 Content-Length 帧体、JSONL 首帧回退的帧体仍 `toString('utf8')` 替换非法字节；C-L→JSONL 回退后读错未使用对应上下文。backend 另有简化读取路径，缺少 JSONL→C-L 识别且读取退出未拒绝已等待的 receive。
- 现复用 F4 decodeUtf8Strict / rustTrim*，没有复制 parser。行读取错误按 Tokio read_line 显示 `stream did not contain valid UTF-8`；配置帧体保留 `Invalid UTF-8 in message body: ...`；首帧回退 body/header/read-exact 错误分别按 global.rs:623/631/639 记录，不再替换坏字节或把截断 body 当正常 EOF。
- frontend/backend 共用 readStdioStdout 生产读取逻辑，finally 关闭原生 iterator；配置 C-L 分支的 saw_any_message 按 Rust :670 设置，不凭“无消息”硬补 warning。结束后 channel 表现为 `Transport error: Channel closed`，既有有效消息仍先排空；会话 wrapper 再清理、error→closed。
- 新增 `tests/stdio-stdout.test.ts`：14 条通过真实 kernel mcp_stdio_start（仍经启用条目批准门），覆盖 JSONL、配置 C-L、两个方向回退、行/帧体/EOF 非法 UTF-8、部分有效前缀、短 body、合法 Unicode/空白/BOM 保留；逐个断言原始消息、错误日志上下文、EOF诊断、终态事件及关闭后发送的 Unknown session 错误。该错误按 cmd/mcp.rs:645、models.rs:1006-1007 是 Unknown 类型并带 Transport error 前缀。
- 另 3 条真实 backend 子进程验证等待 receive 被拒绝、已缓冲有效消息排空后才关闭、不传坏行和后续行。`20261104224927-e9e607` 新 17 条全过；`20261104222625-e69a4e` 完整红记录为 **13 failed / 32 passed / exit1**（其中旧 EOF/stderr/client 30 条通过），新夹具当时缺 getSecret，绝不记成整体通过。新增关闭后发送断言的 Unknown 类型另已据 cmd/mcp.rs:645 / models.rs:1006-1007 更正，全部断言保留；typecheck `20261104224300-4f0b54` exit0、strict `20261104224300-d26731` 全仓0违规。
- 范围边界：100 MiB 配置帧限制保留，JSONL 首帧回退未新增该限制；旧 Number 长度词法/大整数、超1024字节首次预览、主动 close 竞态、外层 RPC 计时/连接状态仍需独立复核。本项不改超时/重试预算，不关闭 D3/chrono/rerank/native 下载等独立未决。

#### L19-V2-15：两处长度文本与配置精确 cap（C1 授权窄单元，候选待复核）
- 查过正式 platform API，未发现整数文本 FromStr 面；F4 JSON reader 的 JSON 数字语法不支持 +02，不能替代。本 lane 的 usize-text.ts 只实现 ASCII 十进制/可选+、原 Empty/InvalidDigit/PosOverflow 分类，不复制 F4 JSON parser。按实际 Node ABI 决定 usize 位宽；本机64位上限18446744073709551615，32位架构对应4294967295，32位/Windows实机未声称已验证。
- 配置 C-L 仍完整读 header 后解析，按 ParseIntError→零值→精确 BigInt 100 MiB 比较→body 顺序处理；合法64位大值直接报原 Message size ... exceeds ...104857600，不再经 Number 舍入或先被 MAX_SAFE 误判。
- JSONL 首帧 fallback 仍先 parse/>0，再读剩余 header，不加100 MiB或MAX_SAFE admission cap。readExact 接受精确 bigint 目标、仅逐次把最多64KiB的实际IO请求转number，完整缓冲已存在后才取数值offset；无巨大body分配测试。
- stdio-length-text.test.ts 新39条（38条真实批准门/stdio IPC输入+1组分类断言）覆盖指数/小数/进制/FEFF/-0/+02/空/零/溢出、合法大配置值无body、坏length+坏后续header的先错以及header EOF。fallback usize::MAX 仅验证到坏剩余header，未到分配。
- `20261104233439-4b40d2` 39 passed / exit0；`20261104233439-3194aa` typecheck exit0。原stdout17范围/断言、旧30矩阵与完整红记录保持，未为本单元重排它们。
- **独立未决**：Node 延迟 Buffer 聚合不同于 Rust 先分配 Vec；合法大 fallback 的容量/分配失败与超大Buffer/String运行时等价未签收，不能凭语法成功或小输入称完整usize/整framing完成。长预览、主动close/RPC预算状态、D3全域、chrono/rerank/native下载仍开。

#### X6-UD 更正（X6-UD-0049/0050）
- 新增 `src/serde-json.ts`：`parseSerdeJson` 对应 from_str::<Value>，`parseSerdeJsonBytes` 对应 from_slice（非法 UTF-8 报错、不跳过 BOM）。`jsonOrNull` 和 provider 的 `responseJson` 都改走这里。
- 证据：`tests/serde-json.test.ts`，其中一条经生产 `doSearch`（tavily）验证非法 UTF-8 报 `error decoding response body: invalid unicode code point`。
- 已知差异与 browser LANE 相同：语法错误文本、行列号未与 Rust 比对，大整数精度归入 D3，状态 pending。

#### L19-V2-09 共享 registry 修复（候选待复核）
- `createWebSearchToolRegistry` 构建只有本地 WebSearchTool 的真实 McpToolRegistry，供 browser 的 test_search_engine 使用；正常 MCP 调用也走同一本地分支。
- 超时从只 Promise.race 改为同时 abort 底层搜索；WebSearchService 的 signal 贯穿 browser webSearch provider。结果映射恢复 Rust error.message / 失败无 citations 和 inject / 缺 usage 填 elapsed_ms。
- 证据与剩余项见 browser/LANE.md 的 L19-V2-09；rerank API 请求已写入本目录 BLOCKERS.md 并上报。不是完整 WebSearchTool 等价签收。

### WP-014 / B7 / D21-MCP（2026-11-05）

- 真实 provider 新增 `mcp.registry.callToolWithDetails`，返回 `ToolInvocationWithDetails` 七元组，
  第七项复用 F4 ErrorDetails。Rust 分支、错误优先级、usage 和日志对应见 SPEC 同名节。
- `tests/tool-details.test.ts` 的原测试 + 分类矩阵经真实 registry/browser 搜索服务、本地 HTTP、
  kernel 事件桥执行；初版 24 passed / failed 0 / skipped 0 / Errors 0，job
  `20261105141135-f212ec` exit0。后续最终门禁记录见本包交付报告。
- 起点 typecheck `20261105140540-3aaf95` exit0；起点双目录作业排队期间读到了先写的新测试，
  `20261105140540-cd6538` 为 409 passed / 24 failed / skipped0 / Errors0 / exit1：
  旧49文件中的48文件通过，新文件全部报 `callToolWithDetails is not a function`，不是他人缺陷。
- 原 Rust enabled=false 分支不可从公共构造/调用触发（私有 enabled 仅初始化 true）；保留此审读边界。
  无新依赖；全 MCP 数值/日期/rerank 不作为本包完成结论。F4 Value 原文面已发布的证据已更正 BLOCKERS。

#### L22 调用示例

安装真实 `browser/index.ts`（webSearch provider）与 `mcp/index.ts` 后：

```ts
import type { ToolContext, ToolInvocationWithDetails } from '../mcp/api.ts';
const context: ToolContext = {
  supports_tools: true, mcp_client: null, window: null,
  stream_event: null, stage: 'test', memory_enabled: null,
};
const result: ToolInvocationWithDetails = await host.ctx.mcp.registry.callToolWithDetails(
  'nonexistent_tool', {}, context,
);
const [ok, data, error, usage, citations, inject, details] = result;
// false, null, '未知工具: nonexistent_tool', null, null, null
// details.code === 'TOOL_NOT_FOUND'; details.suggestions[0].action_type === 'settings'
```

已有真实 `ctx.webSearch` 时亦可经 `mcp/api.ts` 的
`createWebSearchToolRegistry(ctx.webSearch).callToolWithDetails(...)` 调同一实现。
L22 `tests/tools_integration_tests.rs:196` 的 pending 行仍归 L22 登记，本包仅提供生产入口与逐断言证据。
