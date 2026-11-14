# L19-mcp-browser 验收记录（MCP）

本文件记录 `host/plugins/mcp/` 的验收范围、证据与仍然存在的真实缺口。
验收以实时账本（`node scripts/electron-migration/ledger.mjs --vitest latest` 或监控面板，见 `migration/LEDGER.md`）的计算结果为准，本文件只列出可复核的证据；
同 lane 的浏览器目录见 `host/plugins/browser/ACCEPTANCE.md`。

## 范围

- Rust 范围：`dstu-mcp`（`auth`、`client`、`config`、`global`、`http_transport`、
  `oauth_callback`、`protocol_version`、`rmcp`、`sse_transport`、`stdio_proxy`、
  `test_helpers`、`tools/mod.rs`、`tools/web_search.rs`）、`cmd/mcp.rs`、`cmd/network.rs`、
  `src-tauri/tests/mcpbench_integration.rs`。
- Host 目录：`host/plugins/mcp/`（`index.ts`、`api.ts`、`src/`、`tests/`）。
- 命令：LANE 中的 32 条 Rust 定义按命令名合并为 24 个唯一命令，全部按
  `contracts/ipc/L19-mcp-browser.json` 声明并注册。
- 服务：`mcp@1`（`HostMcpService`，提供全局 MCP 客户端与 `ToolRegistry`）；
  `webSearch` 由同 lane 的 `host/plugins/browser/index.ts` 提供，本插件通过 `inject` 消费。

## 命令验收

- [x] 24 个命令全部 `meta.commands` 声明并逐一 `ctx.commands.register`，ledger 本目录命令 A 级 24/24：
  `get_mcp_config`、`import_mcp_config`、`export_mcp_config`、`get_mcp_status`、`get_mcp_tools`、
  `save_mcp_config`、`mcp_stdio_start`、`mcp_stdio_send`、`mcp_stdio_close`、
  `get_mcp_stdio_allow_unapproved`、`set_mcp_stdio_allow_unapproved`、`test_mcp_connection`、
  `test_mcp_websocket`、`test_mcp_sse`、`test_mcp_http`、`test_rmcp_streamable_http`、
  `reload_mcp_client`、`preheat_mcp_tools`、`start_mcp_oauth`、`cancel_mcp_oauth`、
  `revoke_mcp_oauth`、`get_mcp_oauth_status`、`get_mcp_oauth_access_token`、`network_probe`。
- [x] 每个命令的参数键、返回形状、`null`/缺省语义与错误字符串按 Rust 逐条核对，结论写在
  `SPEC.md` 对应命令的 7 项清单中，并全部勾选；命令 B 级依赖的全局语义 9 项同样全部勾选。
- [x] `import_mcp_config` / `export_mcp_config` 与 Rust 一致返回
  `AppError.validation("Import/Export functionality has been removed")`，不伪造成功。
- [x] `get_mcp_status` / `get_mcp_tools` 保持 Rust 的“后端 MCP 已禁用”语义：前者返回
  `enabled` / `resolution` / `last_built_at=null` 的固定形状，后者返回空数组。
- [x] `mcp_stdio_start` 的严格模式逐项比对命令、参数、env、cwd、framing（含 canonicalize），
  未批准模式记录含 command/args/cwd/framing/env_keys 的 warn 审计日志。
- [x] `mcp_stdio_send` / `mcp_stdio_close` 的未知会话错误统一包为 `AppError.internal(<Display>)`；
  stdio 读取循环按 Rust 事件名发送 `mcp-stdio-<id>-message/-error/-closed`。
- [x] OAuth 命令（`start`/`cancel`/`revoke`/`status`/`access_token`）直接复用
  `McpOAuthManager` 的 `startOAuth` / `cancelOAuth` / `revokeToken` /
  `hasOAuthSessionForResource` / `getBearerTokenForResource`；`access_token` 的读取错误按
  Rust 吞为 `null`，`StartOAuthOutcome.access_token` 不下发给前端。
- [x] 测试进度事件 `mcp-test-progress` 在 `test_mcp_connection` 的每个步骤发送 `{ step }`；
  `tools/list_changed` 清理缓存后发送 `mcp_tools_changed`。

## 测试验收

- [x] `TESTMAP.md` 共 100 条真实 Rust 测试，`pending 0`、`ported 100`：每条标题逐字包含
  Rust 测试函数名，分别落在 `host/plugins/mcp/tests/` 的 17 个测试文件中。
- [x] `npx vitest run -c vitest.host.config.ts host/plugins/mcp` 通过：17 个测试文件、
  142 条用例全部通过；无 `.skip` / `.todo` / `.only`，无 mock/stub 生产实现。
- [x] `tests/mcpbench_integration.rs` 的 8 条集成用例全部移植到 `tests/mcpbench.test.ts`；
  其中 `test_modelscope_hosted_connection` 与 Rust 相同，仅在提供 `MODELSCOPE_API_KEY`
  时访问外部服务，未设置时提前返回；`test_mcpbench_websearch_dataset` 使用
  `tests/fixtures/mcp-test-server.mjs` 本地 fixture，不依赖外网。
- [x] 覆盖范围：OAuth/PKCE/刷新/并发、JSON-RPC 分发与协议版本、stdio 严格校验与帧格式、
  HTTP/SSE/WebSocket/Streamable HTTP 探测（含 SSE 空 endpoint/连接拒绝/流提前结束快速失败、
  慢 endpoint 事件、共享 `SseEventBuffer` 的 HTTP/SSE 分片与 UTF-8 分片），
  F1 target 广播/定向 MCP 桥响应，web_search 重试分类（402 不重试）与内容清洗、
  MCPBench 配置导入导出/兼容矩阵/并发连接。
- [x] `npm run migration:wiring -- --lane mcp`：ported 100，所测模块未从 `index.ts` 接入 0（0.0%）。

## 门禁证据

- [x] `npx tsc -p tsconfig.host.json` 通过（作业 `20261104091902-29926c`，退出码 0）。
- [x] 本轮 F4/F1 最小集：`npx vitest run -c vitest.host.config.ts
  host/plugins/mcp/tests/sse-command.test.ts host/plugins/mcp/tests/transport-auth.test.ts
  host/plugins/mcp/tests/bridge.test.ts` 通过，25 条用例。（作业 `20261104091902-c7e337`，退出码 0）
- [x] `npx vitest run -c vitest.host.config.ts host/plugins/mcp` 通过：17 个测试文件、
  142 条用例。（作业 `20261104092208-6363bd`，退出码 0）按 C1 要求未重复跑 browser+mcp 全量。
- [x] `npm run migration:boundaries:strict` 本轮全局退出码 1（其他 lane 4 条未抑制
  `empty-catch` / `console-log`）；本 lane 仅有已抑制的 `(allowed)` 记录
  （本目录 `oauth-manager.ts` 1 条、`probe.ts` 1 条 empty-catch；同 lane 浏览器目录
  另有 `browser-bridge.js` 2 条、`browser-service.ts` 1 条与
  `index-webpage-execute.test.ts` 9 条 `cross-plugin-impl`），无未抑制违规。
  （作业 `20261104080508-04ab66`）
- [x] `node scripts/electron-migration/importable.mjs host/plugins/mcp/index.ts` 输出 `importable: ok`。
  （作业 `20261104092208-9c95de`，退出码 0）
- [x] `npm run migration:ledger -- --check --no-write` 退出码 0（作业
  `20261104080227-9ce452`）：本 lane commands 62，A 级 62/62、B 级 62/62；
  tests 206，A 级 204/206，pending 2，本 lane problems 0。

## 已知缺口（不阻塞本目录的命令 A 级）

- [x] 共享 SSE 缓冲（F4）已接线（main `3c90895fa`，API 发布 `d85995b4b` / `679b53948`）：
  `probe.ts::sseTransport`（`test_mcp_sse`）与 `httpTransport` 的 HTTP SSE 响应分支
  均删除私有 `TextDecoder` / `\n\n` 拆分，改为 `SseEventBuffer.processBytes` +
  `flush` + `extractStreamDataPayload`；保留 endpoint 事件优先、data 消息、10 MiB 预算、
  截断 UTF-8 flush、60s 预算与空 endpoint/连接拒绝/endpoint 前断流快速失败。
  `tests/sse-command.test.ts` 覆盖真实连接、快速失败、跨 chunk 与 UTF-8 分片；
  `tests/transport-auth.test.ts` 覆盖 HTTP `text/event-stream` 的 CRLF 与分片。
  共享 `extractStreamDataPayload` 对尾 `\r` 仍只去一个，C2/F4 待修，本 lane 不复制补丁。
- [x] 接线：`preheat_mcp_tools` / `reload_mcp_client` 每次调用经 `ctx.reflect.get('llmMcpTools')`
  取 L02 服务，await `preheat(call.source)` / 调 `clear()`，真实缓存副作用后返回 Rust 载荷；
  服务缺失抛 `AppError.internal`（调用失败同样抛），不再以 warn + success/count=0 占位；
  index.ts、`tests/tool-cache-commands.test.ts`（装载真实 llm 插件）覆盖调用、窗口传递、缺失与失败。
- [x] `test_mcp_sse` 的传输快失败：`send()` 等待可拒绝的 `postUrlReady`，空 endpoint、
  连接拒绝、非 2xx 与 endpoint 事件前流结束都会立即返回真实错误；已连接但慢的服务器仍
  保留 60s 预算并在收到 endpoint 事件后 POST 到该 URL；`tests/sse-command.test.ts`
  通过真实 Host 命令验证失败与成功两条路径。
- [x] `McpEvent` 的 `Connected` / `Disconnected` / `ServerInfoReceived` 已按 Rust 的连接/
  初始化/关闭时序发出：`JsonRpcProbe.start()` 发 Connected，`initialize()` 在写入
  serverInfo 后、发送 `notifications/initialized` 前发 ServerInfoReceived，`close()` 在
  transport 关闭后发 Disconnected；接收错误且非主动关闭时发 Error。
  `tests/client-events.test.ts` 断言事件顺序与 ServerInfo 载荷（含 `capabilities`）。
- [x] `web_search` 本地工具在 `window` 与 `stream_event` 都存在且 citations 非空时发送
  `{stream_event}_web_search`（Rust `tools/mod.rs:1123` 的 `if let (Some(window), Some(stream_event))`），
  载荷字段与 Rust `tools/mod.rs:1124-1150` 一致，`score` 按 f32 最短十进制输出；
  `tests/client.test.ts` 断言事件名、source 映射与 `stage`，`tests/web-search-routing.test.ts`
  断言无 window 不发。
- [x] `mcp-bridge-request` 前端桥已移植：`ToolContext.window` 存在时
  `McpService.registry.callTool` 走 `callFrontendMcpTool`，按 Rust 语义生成 UUID v4
  correlation token、移除 `_serverId` / `_timeoutMs`(`__bridgeTimeoutMs`)、按 1s–300s clamp
  超时（默认 180s），用 `ctx.backendEvents.emitTo({kind:'Window',label})` 发请求并通过
  F1 `listenWindow` 收 `mcp-bridge-response:<corr>`；响应 usage 补
  `bridge:"frontend"` / `trace_id` / `tool_name` / `source:"mcp-frontend"`，成功、错误、
  超时与监听注销均有 `tests/bridge.test.ts` 覆盖。无 window 时保留既有全局客户端回退。
  F1 target 路由已在 main 落地（`a86321fec` 说明、实现 `902d86ee3`）：`listenWindow`
  按 `EventTarget::Window` 注册，广播 target `Any` 与定向 `Window` 都按 target 投递，
  source 不参与过滤。`tests/bridge.test.ts` 覆盖请求 target 为调用窗口、响应经 `Any`
  广播、经目标 `Window` 定向，以及发往其他窗口的响应不投递。真实 Electron 窗口消费
  仍未验证；`SPEC.md` 该事件小节已按 target 语义更新。
