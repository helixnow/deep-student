# WAVE0 deterministic MCP service (L19)

Gives A (Tauri+Rust) and B (Electron+TS) the same MCP server behaviour for the same client input, for WAVE0 §3 differential runs. The service only supplies inputs and a server-side request log. Whether A and B agree is decided by the X7 comparator on A/B recordings, never by these records alone.

Files:

| File | Content |
|---|---|
| `protocol.ts` | The only tool set and reply logic. A reply depends only on (scriptId, message text). It also defines the record types. |
| `stdio-server.ts` | Stdio child process (JSONL). `tests/fixtures/mcp-test-server.mjs` (MCPBench) runs its `success` script. |
| `runtime.ts` | Chooses the Node executable that runs the stdio child (see "Electron"). |
| `mcp-service.ts` | HTTP/SSE/WebSocket endpoints, stdio launch descriptors, the OAuth server and stand-in browser wiring, records, reset/stop, and the CLI. |
| `__fixtures__/websocket.ts` | RFC 6455 handshake and frame codec (no extensions, no subprotocol). |
| `__fixtures__/oauth-server.ts` | Deterministic OAuth 2.1 authorization server (see "OAuth"). |
| `__fixtures__/oauth-browser.ts` | Stand-in browser that `<logDir>/bin/xdg-open` runs (see "OAuth"). |
| `mcp-service.test.ts` | Service tests through the real `mcp` plugin commands. |
| `oauth-websocket.test.ts` | WebSocket and OAuth tests through the real `test_mcp_websocket` / `start_mcp_oauth`. |

## start / config / reset / stop

In process:

```ts
import { startMcpService } from 'host/plugins/mcp/equivalence/mcp-service.ts';
const mcp = await startMcpService({ host: '127.0.0.1', port: 0, oauthPort: undefined, logDir: undefined, nodeCommand: null, selfContained: false }); // all optional; G3: see "G3 接线"
mcp.url;                         // http://127.0.0.1:PORT
mcp.oauthUrl;                    // http://127.0.0.1:OAUTH_PORT (default PORT+1 for a fixed port, else ephemeral)
mcp.stdioLaunch('success');      // {command, args, env, cwd, framing:'jsonl', runtime, nodeVersion}
mcp.toolsListEntry('success');   // enabled mcp.tools.list entry matching that launch exactly
mcp.sseUrl('success');           // legacy SSE endpoint
mcp.httpUrl('success');          // streamable HTTP endpoint
mcp.wsUrl('success');            // ws://127.0.0.1:PORT/ws/success
mcp.browserLaunch();             // {pathDir, command, logFile}: <logDir>/bin/xdg-open, see "OAuth"
mcp.placeholders();              // ${mcp.*} values, see below
mcp.bindings();                  // the same values nested without the `mcp.` prefix: bindings().success.args
mcp.records();                   // {network, stdio, oauth, browser}, each in arrival order
await mcp.whenIdle(15_000);      // false = something is still open or a stdio child is alive (a finding)
await mcp.reset();               // ends streams/sockets/held requests, clears records, session numbering and OAuth state, truncates the stdio and browser logs
await mcp.stop();                // ends streams, closes both ports; records stay readable
```

Out of process (X7 recorder, X1 driver):

```sh
node host/plugins/mcp/equivalence/mcp-service.ts [--port N] [--oauth-port N] [--host 127.0.0.1] [--log-dir DIR] [--node /path/to/node] [--self-contained]
# stdout line 1: {"url","oauthUrl","control","pid","logDir","stdioLogFile","scripts"}
# control (separate loopback port, never in the records):
#   GET  $control/records | /placeholders | /idle | /launch/<script> | /browser     POST $control/reset
# SIGTERM / SIGINT / stdin EOF (only when stdin is a pipe) → last stdout line {"stopped":true,"records":{...}}, exit 0
```

Isolation and lifecycle:
- Use one service per backend take. Each service has its own port (default 0), its own `logDir` (default a new `mkdtemp`, which `stop()` deletes; `records()` still returns what was recorded up to `stop()`; a caller-supplied `logDir` is left in place) and its own stdio log. The service only binds to loopback, and no real account or API key is involved.
- The backend under test starts the stdio child itself and owns it. The child exits on stdin EOF (`exit:stdin-end`), on SIGTERM/SIGINT (it re-raises the signal, so the exit status stays signal-based), or when a `disconnect-*` script fires (`exit:disconnect-script`, exit 0).
- `liveStdio()` returns children that have a `start` record, no `exit` record, and a live pid. A child killed with SIGKILL leaves no `exit` record, but its pid is gone, so it is not counted as live.
- Cancellation: the `hold` tool never replies. The client's `notifications/cancelled` is recorded as `cancelled-notice`, and the request stays unanswered. A held HTTP request stays open until the client aborts it, or until `reset()` or `stop()` destroys it.
- Session ids are deterministic per reset: SSE uses `s1, s2, …` and HTTP uses `http-1, …`. They are assigned only on a successful `initialize`. WebSocket connections are `ws1, ws2, …` from the upgrade on.

## Scripts

| script | behaviour |
|---|---|
| `success` | `initialize` (protocol `2025-06-18`, serverInfo `mcp-test-server`/`1.0.0`). `tools/list` returns `web_search`, `echo_args`, `fail_tool` and `hold`. `prompts/list` and `resources/list` return empty lists, and `ping` returns `{}`. |
| `initialize-error` | `initialize` → JSON-RPC error `-32603 "fixture initialize failure"` with `data:{script}`. |
| `tools-list-error` | `tools/list` → `-32603 "fixture tools/list failure"`. |
| `protocol-invalid-tools` | `tools/list` → `result.tools = "not-an-array"`. |
| `protocol-garbage` | `tools/list` → the text `mcp-fixture: this is not json-rpc` (as a stdio line, HTTP body or SSE `data`), then the connection is closed. |
| `disconnect-on-list` | `tools/list` → no reply; the connection is closed (stdio child exits, HTTP socket is destroyed, SSE stream ends). |
| `disconnect-on-call` | Same as `success`, except `tools/call` → no reply and the connection is closed. |

Tools (`success` and `disconnect-on-call`):
- `web_search {query}`: returns the canned MCPBench answers, or `No answer`.
- `echo_args {...}`: `content[0]` is `JSON.stringify(arguments)`, and `content[1]` is the **raw JSON-RPC text exactly as received**. Numbers beyond 2^53, `-0`, escapes and key order sent by each backend are kept byte for byte. The `raw` field of the record holds the same text.
- `fail_tool {kind}`: returns `isError: true` with a fixed text. The kinds `timeout`, `rate_limit` and `network` contain the substrings that Rust `dstu-mcp/src/tools/mod.rs:277-298` matches when it builds ErrorDetails (`tool_timeout`, `rate_limit_error`, `network_error`). `generic` maps to `service_unavailable`.
- Unknown tool name: ToolNotFound, `{"code":-32602,"message":"Tool not found: <name>","data":{"tool":<name>,"script":"success"}}`. The message contains `tool not found`, which is the `tool_not_found` branch in `tools/mod.rs:279`.
- `hold`: no reply (see Cancellation above).

Records (`protocol.ts` `MessageRecord` / `LifecycleRecord`): `transport`, `script`, `session` (stdio pid, SSE `sN`, HTTP `Mcp-Session-Id`), `method`, `id`, `params`, `raw`, `outcome`, `replies` (exact texts; `null` = disconnect), `headers` (HTTP/SSE request headers with lower-case keys, unfiltered: `authorization`, `mcp-protocol-version`, `user-agent`, …). The records contain no timestamps. Stdio pids and the temp `logDir` path change between runs and between A and B; this is a fact about the runs, not a normalisation rule.

## WebSocket

`GET {url}/ws/<script>` with an RFC 6455 handshake upgrades to a connection. Each text message is one JSON-RPC message for `handleMessage(script, text)`, and each reply is sent as one text frame. Behaviour:
- Fragmented messages are joined before handling. A ping is answered with a pong.
- An unmasked client frame gets close 1002. A message over 1 MiB gets close 1009.
- A client close frame is echoed back (`client-close-frame`). A `disconnect-*` script, or `protocol-garbage` after its reply, closes with 1000 (`disconnect-script`). `reset()` and `stop()` close open connections with 1001.
- An upgrade to an unknown script or path gets 404, and a bad handshake gets 400. Each is recorded as a `websocket` `not-found` together with the request headers. A plain HTTP request to `/ws/…` goes to the HTTP handler and gets its usual 404.

Records use `transport:'websocket'` and `session:'wsN'`. `stream-open` records carry the handshake headers in `detail.headers`, and message records have `headers:null`.

## OAuth

The authorization server (`__fixtures__/oauth-server.ts`) listens on its own loopback origin, `oauthUrl`. A token is bound to the origin of the resource URL (Rust `auth.rs:619-645`), so it cannot share `url`. The origin-level `/.well-known/*` documents return 404 there, just as on `url`, so the existing `start_dcr_404_on_local_service` scenario is unaffected. Two profiles are selected by the resource path:

| placeholder | resource | discovery (`{resource}/.well-known/oauth-authorization-server`) |
|---|---|---|
| `${mcp.oauth.resourceUrl}` | `{oauthUrl}/dcr/mcp` | RFC 8414 metadata with `registration_endpoint` (RFC 7591) |
| `${mcp.oauth.noRegistrationResourceUrl}` | `{oauthUrl}/no-registration/mcp` | the same metadata without it; `auth.rs:724-733` fails before opening a browser |

The endpoints are `/<profile>/oauth/{register,authorize,token,revoke}`.
- **Registration and authorization.** `register` returns `wave0-dcr-N` with `token_endpoint_auth_method:'none'`. `authorize` approves only a client registered on this service. It checks the redirect_uri, `response_type=code` and an S256 challenge, then answers 302 to `redirect_uri?code=wave0-code-N&state=…`. Any other `client_id`, such as the pre-set `clientId` of `start_mcp_oauth`, gets 400 with no redirect (RFC 6749 §4.1.2.1), so that flow keeps waiting until it is cancelled or times out.
- **Token endpoint.** Codes are single-use. The endpoint checks the client (Basic or form), the redirect_uri and the PKCE verifier. Responses are JSON: `{access_token:'wave0-access-N', token_type:'Bearer', refresh_token:'wave0-refresh-N', scope?}`. They have no `expires_in`, so both sides store `expires_at: null` instead of a clock value. A `refresh_token` grant works too.
- **Records and reset.** `records().oauth` keeps path, headers, body, status, outcome and response for every request. The state, PKCE challenge and callback port in them vary per run, so they are evidence only. `reset()` clears clients, codes, tokens and counters.

`start_mcp_oauth` always opens a browser (`commands.rs:36`) and then waits for its local callback (`auth.rs:767-778`). A runs `tauri_plugin_opener::open_url`. On Linux that is the `open` crate, which tries `xdg-open` first (`wslview` is used only under WSL). B's `plugin:opener|open_url` calls Electron `shell.openExternal`, which also runs `xdg-open` on Linux. The service writes `<logDir>/bin/xdg-open`, a shell wrapper that runs `__fixtures__/oauth-browser.ts` with the stdio runtime. Putting `browserLaunch().pathDir` first on the app's PATH therefore makes both backends "open" the authorization URL in the same stand-in browser. The browser follows redirects manually, at most 5 hops, and only to http loopback hosts. Each hop is appended to `records().browser` as `{url, outcome:'fetched'|'refused'|'failed'|'hop-limit', status, location, detail}`. It always exits 0, so a refused URL shows up in the records rather than as an opener error. `selfContained` copies `oauth-browser.ts` into `<logDir>/fixture/` along with the stdio server.

## Command chain (front-end reachable, owners)

The backend has no MCP tool-call IPC (`get_mcp_tools` returns `[]`, `cmd/mcp.rs:59`). The front-end SDK (`src/mcp/mcpService.ts:1452 callTool`) runs `tools/list` and `tools/call` through these commands:

| step | command (owner) | Rust | front end |
|---|---|---|---|
| approve the stdio entry | `save_setting {key:'mcp.tools.list', value}` (L19 browser plugin) | `src/cmd/web_search.rs:542` → `save_secret` | settings editor |
| probe | `test_mcp_connection {command,args,env,cwd,framing}` (L19 mcp) | `src/cmd/mcp.rs:65`, `test_helpers.rs:38` | `src/utils/settingsApi.ts:107` |
| open session | `mcp_stdio_start` | `src/cmd/mcp.rs:553` (allowlist `:473`) | `src/mcp/tauriStdioTransport.ts:161` |
| JSON-RPC out | `mcp_stdio_send {sessionId,payload}` → `null` | `src/cmd/mcp.rs:639` | `tauriStdioTransport.ts:195` |
| JSON-RPC in | events `mcp-stdio-<sessionId>-message {message}` / `-error` / `-closed` | `global.rs` reader | `tauriStdioTransport.ts:227/247` |
| close | `mcp_stdio_close {sessionId}` | `src/cmd/mcp.rs:654` | `tauriStdioTransport.ts:206` |
| SSE probe | `test_mcp_sse {endpoint, apiKey}` | `src/cmd/mcp.rs:142`, `test_helpers.rs:92` | `settingsApi.ts:144` |
| HTTP probe | `test_mcp_http {endpoint, apiKey}` | `src/cmd/mcp.rs:172`, `test_helpers.rs:114` | `settingsApi.ts:154` |

Replies to `mcp_stdio_send` arrive only on scoped events whose channel names contain the session id. The A side therefore needs an emit tap; listening to fixed event names in advance is not enough (the same point X5 raised for X7).

## Using it in a v0 scenario (X7 / X1)

Scenario JSON cannot know the per-run executable, port or temp path. The runner substitutes `mcp.placeholders()` keys written as `${mcp.<key>}`. This extension is the same kind as X5's `${llm.baseUrl}` and needs X7's acceptance. A string that is exactly one placeholder takes the JSON value (array or object); otherwise the placeholder is replaced inside the string.

```json
{
  "domain": "mcp",
  "commands": ["save_setting", "test_mcp_connection", "mcp_stdio_start", "mcp_stdio_send", "mcp_stdio_close", "test_mcp_http", "test_mcp_sse"],
  "scenarios": [
    {
      "id": "mcp.stdio.call.echo_and_not_found",
      "seed": "empty",
      "mcp": { "scripts": ["success"] },
      "steps": [
        { "cmd": "save_setting", "args": { "key": "mcp.tools.list", "value": "${mcp.success.toolsList}" } },
        { "cmd": "test_mcp_connection", "args": { "command": "${mcp.success.command}", "args": "${mcp.success.args}", "env": "${mcp.success.env}", "cwd": "${mcp.success.cwd}", "framing": "jsonl" } },
        { "cmd": "mcp_stdio_start", "args": { "command": "${mcp.success.command}", "args": "${mcp.success.args}", "env": "${mcp.success.env}", "framing": "jsonl", "cwd": "${mcp.success.cwd}" } },
        { "cmd": "mcp_stdio_send", "args": { "sessionId": "${2}", "payload": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"wave0\",\"version\":\"0\"}}}" } },
        { "cmd": "mcp_stdio_send", "args": { "sessionId": "${2}", "payload": "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"echo_args\",\"arguments\":{\"big\":12345678901234567890}}}" } },
        { "cmd": "mcp_stdio_send", "args": { "sessionId": "${2}", "payload": "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"missing_tool\",\"arguments\":{}}}" } },
        { "cmd": "mcp_stdio_close", "args": { "sessionId": "${2}" } }
      ],
      "capture": { "events": true, "db": ["*"] },
      "normalize": []
    }
  ]
}
```

- `"${2}"` refers to the whole result of step 2 (the session id string). Wait for the matching `-message` event before the next send, or for `-closed` after a disconnect script. This waiting rule belongs to the runner.
- Probe-only failure scenarios: use `test_mcp_connection` with the `${mcp.<script>.*}` placeholders, `test_mcp_http {endpoint:"${mcp.<script>.httpUrl}", apiKey:""}` or `test_mcp_sse {endpoint:"${mcp.<script>.sseUrl}", apiKey:""}`.
- Call `reset()` (or `POST $control/reset`) between scenarios, and store `records()` next to the A/B take as server-side evidence only. Events (`mcp-test-progress`, `mcp-stdio-*`) and return values remain the oracle; A is the reference.
- This README contains no expected answers, and the example above is a usage illustration, not corpus. Corpus for the mcp domain is a separate package.

## Electron

When tests run in Electron (`npm run test:host:electron`) or inside the app, `process.execPath` is the Electron binary. Both spawners clear the child environment: Rust `create_stdio_transport` uses env_clear plus minimal keys, and TS `src/stdio-proxy.ts:358-361` does the same. The parent's `ELECTRON_RUN_AS_NODE` therefore does not reach the child, and `<electron> script` starts the GUI app instead of the server. This is why existing tests that spawn `process.execPath` pass under Node and fail under Electron. `runtime.ts` picks an executable that runs as Node:
1. `nodeCommand`, if given;
2. `process.execPath`, if the current process is not Electron;
3. the first `node` on PATH that reports `process.features.typescript`;
4. otherwise Electron with `ELECTRON_RUN_AS_NODE=1` in the launch `env`. The variable is then part of the approved `mcp.tools.list` entry and of the start request, so both backends validate it and pass it to the child.

Every candidate is first started once as a probe. A candidate that still reports `process.versions.electron` without the variable is rejected. If no candidate works, `startMcpService` throws with the list of what it tried; there is no silent fallback.

## Source notes for A/B review (not conclusions)

- Rust SSE (`sse_transport.rs:160-215`) POSTs to the configured endpoint URL itself. Before the first send it waits up to `timeout` (60 s in `test_helpers.rs`) for a `sessionId` to appear in a `data:` JSON. It does not use the standard `event: endpoint` URL. The TS probe (`src/probe.ts:584`) POSTs to the `endpoint` event URL. This service implements the standard dialect only: a POST to `/sse/<script>` is recorded as `not-found` with its body and headers. If A shows a slow or failed SSE probe here, that is A's real behaviour on a standard server. Do not change the server to make A pass.
- MCPBench `tests/fixtures/mcp-test-server.mjs` now uses this protocol. Behaviour changes compared with the old inline fixture: an unknown tool returns `-32602 Tool not found: <name>` (previously `-32601 Method not found`), `prompts/list` and `resources/list` return empty lists, and three more tools are listed. `web_search` answers are unchanged. `tests/mcpbench.test.ts` now spawns it through `currentStdioRuntime()` rather than `process.execPath`, so it also passes under Electron. Other existing tests that spawn `process.execPath` are not changed by this package.
- B side, seen while testing this service and fixed in WP-118 (`src/probe.ts` gatherProbe/probeTransport): probe failures now carry Rust's stage prefix and McpError Display (`连接失败:` / `初始化失败: Protocol error: Initialize failed: code=<c> message=<m>` / `tools/list 调用失败: Protocol error: Failed to list tools`, `test_helpers.rs:301/309/318`, `client.rs:1281-1287/1327`), the client is disconnected before the command returns (the stdio child exits on stdin EOF), and `testStdio`/`testHttp` only use `无法启动进程:`/`HTTP 初始化失败:` for transport creation. With `disconnect-on-list` or `protocol-garbage` over stdio the pending `tools/list` settles through Rust's fixed 30 s `send_request` timeout (`client.rs:1708-1732`) as `tools/list 调用失败: Timeout error: Request timeout`. Original evidence before the fix: jobs `20261105162056-557fae` and `20261105162504-b348ac`.

## 语料（WAVE0 G3 v1，WP-232）

格式为 `board/WAVE0-EQUIVALENCE.md` §3 v0。这些场景**尚未在 A/B 上运行，没有 golden，不计 C 级**。`expect:"error"` 只是说明，以 A 端实际结果为准；没有写任何预期返回值。

| 文件 | 场景数 | 步骤数 | 标注 `expect:error` | 说明 |
|---|---|---|---|---|
| `mcp-commands.json` | 36 | 147 | 46 | 18 条 MCP 命令；`save_setting`/`get_setting` 用于批准 stdio 条目和读回开关。`test_websocket.success`、`oauth.no_registration_endpoint` 两个场景原在 `pending-mock/`，服务提供 WebSocket 端点和 OAuth 授权服务器后移入，步骤不变 |
| `pending-runner/mcp-oauth-browser.json` | 2 | 8 | 1 | 服务侧已就绪，还需要运行器支持替身浏览器和 `concurrent`（见 pending 表），**不计覆盖** |

settings/browser/websearch 的语料在 `host/plugins/browser/equivalence/`。

**G3 状态（D-158）**：本目录 18 条 MCP 命令里，除 get_mcp_tools（981 外延）外都在 768 分母内，主语料里都有场景。start_mcp_oauth 主语料只有错误步骤，成功路径还在 pending（见 pending 表）。L19 的错误分支今后由 W-lane（`g3w-*.json`）写；本包已有的 `expect:error` 步骤保留。所有场景都是 `seed:"empty"`、`capture:{events:true, db:["*"]}`、`normalize:[]`。

### 运行器前提（X7 验收）

1. **占位符先于步骤引用替换**。除整值占位符（`${mcp.success.args}` 等）外，场景还在字符串里嵌入 `${mcp.url}`（如 `"${mcp.url}/mcp/success"`）。`resolveReferences`（`scripts/electron-migration/record/scenario-v0.mjs:62`）遇到内嵌 `${` 会抛错，所以必须先替换 `${mcp.*}`，再解析 `${n}`。
2. `"mcp":{"scripts":[...]}` 列出场景会用到的脚本；`[]` 表示只需要服务的 HTTP 端口或 OAuth 端口（OAuth 发现、DCR 在本地得到确定性的 404，或者无注册端点的元数据）。`"oauth":true` 表示这个场景会打开浏览器，运行器必须先装好替身浏览器（"G3 接线"第 9 条）。
3. **stdio 等待规则**。`mcp_stdio_send` 返回 `null`，回复只在 `mcp-stdio-<sessionId>-message` 事件里。有 id 的请求要等对应 `-message` 再发下一步；通知、非 JSON、空串没有回复，要等事件静默；`disconnect-*`、`protocol-garbage` 脚本断开后要等 `-closed` 再执行后面标注 `expect:error` 的 send，否则结果取决于 reader 退出的时机。`mcp-commands.json` 已按这条规则写好 14 个 `waitAfter`：有 id 的请求写 `{"channel":"mcp-stdio-${N}-message","jsonrpcId":<id>}`，断开写 `{"channel":"mcp-stdio-${N}-closed"}`，其中 `N` 是 `mcp_stdio_start` 的步骤下标。`mcp_stdio_close` 不等：两端在这条路径上都不发事件（Rust `dstu-mcp/src/mcp/stdio_proxy.rs:134-137` 中止 reader；B `host/plugins/mcp/src/stdio-proxy.ts:495-501`）。规格见 W13 的 `g3-wait.mjs`，只认本步 invoke 之后到达的事件。
4. **超时**。A 的 SSE 探针在标准 SSE 服务上最多等 60 s（见上文 Source notes）；stdio `disconnect-on-list`/`protocol-garbage` 的探针按 30 s `send_request` 超时结束。运行器单步超时要大于这些值。
5. **OAuth 管理器是进程级全局状态**（`dstu-mcp/src/mcp/auth.rs`）。OAuth 场景之间会共享状态，要么每个场景用新进程，要么固定执行顺序并记录下来。
6. normalize 候选（只列出，等 A 录两次后由 C2 决定，现在不忽略）：stdio 会话 uuid 及其在事件通道名中的出现；端口（url、错误文案）；stdio pid；探针返回里的 `response_time`/`timestamp`。

### G3 接线（W21，回应 `G3-RECORDING-RUNBOOK.md` §13.4）

使用 `${mcp.*}` 的场景共 44 个：41 个可运行，即本目录 `mcp-commands.json` 29 个、`browser/equivalence/browser-session.json` 11 个、`settings-websearch.json` 1 个（browser 的两个文件只用 `${mcp.url}` 作回环 HTTP 端点）；3 个 pending，即 `pending-runner/` 2 个、`browser/equivalence/pending-network/websearch-network.json` 1 个。服务的任何改动都会让这 44 个场景的 A 失效（指纹闭包是 `mcp-service.ts` 及其 import，含 `__fixtures__/`）。

占位符值会进入事件、错误文案，以及 DB 快照里 `mcp.tools.list` 那一行，所以 A、A2、B 必须拿到逐字节相同的值。本包提供：

- `startMcpService({ port, logDir, nodeCommand, selfContained: true })`（CLI：`--port --log-dir --node --self-contained`）。`selfContained` 把 `stdio-server.ts`、`protocol.ts`、`oauth-browser.ts` 复制到 `<logDir>/fixture/`，stdio 子进程和替身浏览器都从那里启动，于是启动参数里不再出现本 checkout 的路径。`port`、`logDir`、`nodeCommand` 三者固定时，`placeholders()` 每次运行都相同（测试 `selfContained launches a copy under logDir`、`fixed port, logDir and node give run-independent oauth and wsUrl placeholders`）。`logDir` 必须已存在；服务启动时清空其中的 `stdio-records.jsonl` 和 `browser-records.jsonl`。
- OAuth 授权服务器默认监听 `port + 1`（G3 用 47130 时是 47131），也可以用 `oauthPort`（CLI `--oauth-port`）指定。新增占位符：`${mcp.<script>.wsUrl}`、`${mcp.oauth.url}`、`${mcp.oauth.resourceUrl}`、`${mcp.oauth.noRegistrationResourceUrl}`。
- `bindings()`：去掉 `mcp.` 前缀的嵌套对象（`${mcp.success.args}` 对应 `bindings().success.args`），可以直接放进 `startScenarioServices` 的 `bindings.mcp`。

运行器侧（W13）需要做的：

1. `g3-services.mjs:16` 的 `SERVICE_NAMESPACES` 加入 `mcp`。`startScenarioServices`（`:29`）在步骤含 `${mcp.` 时启动服务，参数为固定端口（建议 47130，避开 `LLM_PORT` 47110 和 `CLOUD_PORTS` 47120-47122）、固定 `logDir`、`nodeCommand` 取运行器自己的 node，以及 `selfContained:true`；然后设 `bindings.mcp = service.bindings()`。`record()` 里存 `service.records()`，只作服务端证据，pid 和会话号随运行变化，不进比较；`stop()` 调 `service.stop()`。
2. 固定 `logDir` 意味着同一台机器上两个 worker 不能同时用同一路径。做法二选一：（a）worker 已在 `unshare -rn` 里，改成 `unshare -rnm`，在私有 mount namespace 里把一个 per-worker 空目录挂到固定路径（例如 `/run/g3-mcp`），只需挂这一个目录，`stdio-server` 已经复制在里面；（b）带 `${mcp.` 的场景串行执行，并固定使用一个宿主路径。
3. `scenario-v0.mjs` 的 `resolveReferences`：`:62` 和 `:75` 两处的命名空间正则要加 `mcp`，键段要允许 `-`（`disconnect-on-list`、`initialize-error` 等）。整值占位符要按 JSON 原值返回：`:66` 现在只接受字符串，而 `args` 是数组、`env` 是对象。内嵌占位符（如 `"${mcp.url}/mcp/success"`）仍只接受字符串。`g3-services.mjs:78` 的 `lookupBinding` 同理。
4. `g3-inputs.mjs`：`CLOSURE_ENTRIES`（`:21-26`）加 `mcp: ['host/plugins/mcp/equivalence/mcp-service.ts', 'host/plugins/mcp/equivalence/stdio-server.ts']`（`stdio-server.ts` 只按 URL 引用，不在 import 闭包里）；`:79-80` 的用法判定加 `steps.includes('${mcp.')`。
5. 等待：`mcp_stdio_send` 的回复只出现在 `mcp-stdio-<sessionId>-message` 事件里，payload 是裸 JSON-RPC，没有 `eventType`/`type:phase`。`g3-wait.mjs:7` 的 `eventMatches` 匹配不到，而且 `waitForEvent` 只要求"已记录的事件里有一条命中"，同一会话里的第二次 send 会被第一条回复提前满足。需要一种等待规格：通道等于 `mcp-stdio-${N}-message`（`N` 引用 `mcp_stdio_start` 的结果），且 payload 的 JSON-RPC `id` 等于本步请求的 id；或者等 `-closed`，并且只认本步之后到达的事件。W13 的 `g3-wait.mjs`（`channel` + `jsonrpcId`，只认 invoke 之后到达的事件）就是这种规格，本目录已补 `waitAfter`（见"运行器前提"第 3 条）。
6. 静默：捕获前除 N-013 外还要等 `service.whenIdle(ms)`，即 HTTP/SSE 请求都已结束、stdio 子进程都已退出；超时记为发现，不能当作通过。
7. 超时：A 的 SSE 探针最多等 60 s，stdio `disconnect-on-list`/`protocol-garbage` 等 30 s（见上文"运行器前提"第 4 条）。单步超时要大于这些值，`g3-wait.mjs:3` 的 `WAIT_DEADLINE_MS` 15 s 只管事件等待。
8. OAuth 管理器是进程级全局状态（第 5 条）。G3 每个场景都新起应用进程，满足这一条。
9. 浏览器：`start_mcp_oauth` 的成功路径要打开授权 URL（见上文 "OAuth"）。带 `${mcp.oauth.` 的场景启动应用时，要把 `service.browserLaunch().pathDir` 放在应用进程 `PATH` 的最前面，A、A2、B 三次都要。否则 A 会调用真实的 `xdg-open`，而且流程会一直等回调，直到超时。`record()` 里的 `service.records().browser` 应当为每次 start 记录一条 `fetched 302` 和一条回调 `fetched 200`；如果为空，说明 PATH 没有生效，这是运行器的问题，不是 A/B 的差异。
10. 端口：OAuth 端口 47131 必须和 47130 一起在 worker 的网络命名空间里可用。`wsUrl` 与 `url` 同端口。

### 命令入口与分支覆盖

前端行号相对 `src/`；`mcp.rs` 指 `src-tauri/src/cmd/mcp.rs`，`commands.rs` 指 `src-tauri/crates/dstu-mcp/src/mcp/commands.rs`。场景引用写作 `场景id[步骤下标]`，省略前缀 `mcp.`。探针类命令（`test_mcp_*`）在探测失败时仍返回 Ok，失败写在返回体里；下表把“handler 返回 Ok”和“探测真正连通”分开说明。

| 命令 | 前端 invoke | Rust | 成功场景 | 错误场景 | 理由 |
|---|---|---|---|---|---|
| get_mcp_status | `utils/settingsApi.ts:196` | `mcp.rs:25` | `status_tools_reload[0][3]` | 无 | 无参数，handler 无可达 Err |
| get_mcp_tools | `settingsApi.ts:205` | `mcp.rs:58` | `status_tools_reload[1]` | 无 | 同上（恒返回 `[]`） |
| reload_mcp_client | `settingsApi.ts:174` | `mcp.rs:784` | `status_tools_reload[2]` | 无 | 同上 |
| preheat_mcp_tools | `features/settings/components/mcp-editor/mcpServerOps.tsx:43` | `mcp.rs:822` | `preheat.no_bridge_listener[0]` | 无 | 同上；只发事件 |
| get_mcp_stdio_allow_unapproved | `features/settings/components/McpDangerZoneSection.tsx:33` | `mcp.rs:792` | 默认、开、关、` TRUE `、`1` → `allow_unapproved.toggle_and_parse[0][2][5][7][9]` | 无 | 无可达 Err，逐条理由见下文 g3w 判定（WP-268） |
| set_mcp_stdio_allow_unapproved | `McpDangerZoneSection.tsx:49` | `mcp.rs:801` | `allow_unapproved.toggle_and_parse[1][4]`、`stdio.unapproved_mode[0][6]` | 字符串 `"true"` → `toggle_and_parse[10]` | |
| mcp_stdio_start | `mcp/tauriStdioTransport.ts:161` | `mcp.rs:553` | 已批准 → `stdio.session_success_list_ping_close[1]`、`disconnect_on_list_autocleans[1]` 等；未批准模式 → `unapproved_mode[3]` | 未批准（无列表、空列表、别的条目、framing 不符、env 不符）→ `start_rejected_not_approved[0][3][5][6][7]`；列表不是 JSON/不是数组 → `tools_list_invalid[1][4]`；cwd 不存在/不是目录、可执行文件不存在、PATH 找不到、命令为空 → `start_rejected_path_checks[1-5]`；未批准模式下空命令、spawn 失败、关闭开关后 → `unapproved_mode[1][2][7]`；缺 command → `bad_args[9]` | |
| mcp_stdio_send | `tauriStdioTransport.ts:195` | `mcp.rs:639` | initialize/通知/list/prompts/ping/call → `session_success_list_ping_close[2-8]`；非 JSON、空串 → `protocol_garbage_and_raw_payloads[3][4]` | 关闭后 → `session_success…[11]`；断开后自动清理 → `disconnect_on_list_autocleans[4]`、`disconnect_on_call[5]`、`protocol_garbage…[6]`；未知会话、空串 → `stdio.unknown_session[0][1]`；缺 payload → `bad_args[8]` | |
| mcp_stdio_close | `tauriStdioTransport.ts:206` | `mcp.rs:654` | 关闭、重复关闭、未知会话 → `session_success…[9][10]`、`stdio.unknown_session[2][3]` | 缺参 → `bad_args[7]` | handler 恒返回 Ok |
| test_mcp_connection | `mcpServerOps.tsx:226` | `mcp.rs:65` | `test_connection.stdio.success[1]`、`.defaults_null_framing[1]`；其余 5 个脚本 → `test_connection.stdio.<script>[1]`（探测失败，handler Ok） | 未批准 → `start_rejected_not_approved[1]`；列表无效 → `tools_list_invalid[2][5]`；空命令、可执行文件不存在 → `start_rejected_path_checks[6][7]`；缺 command → `bad_args[10]` | |
| test_mcp_http | `settingsApi.ts:154` | `mcp.rs:172` | `test_http.success[0]`；5 个失败脚本；apiKey 带空格、端口不通、非法 URL、未知路径 → `test_http.api_key_trim_and_unreachable[0-3]` | 缺 endpoint → `bad_args[0]` | |
| test_mcp_sse | `settingsApi.ts:144` | `mcp.rs:142` | `test_sse.success[0]`、`.initialize_error[0]`、端口不通/非法 URL → `test_sse.unreachable_and_invalid[0][1]` | 缺 apiKey → `bad_args[1]` | A 的 SSE 方言与本服务不同（见 Source notes），`test_sse.success` 在 A 上很可能是 60 s 后探测失败；只能算 handler Ok 覆盖，是否“连通”以 A 为准 |
| test_mcp_websocket | `settingsApi.ts:134` | `mcp.rs:119` | 连通成功、初始化报错 → `test_websocket.success[0][1]`；探测失败（端口不通、非法 URL、HTTP 端点、未知路径）→ `test_websocket.failures[0-3]` | 缺 url → `bad_args[2]` | |
| get_mcp_oauth_status | `features/settings/components/mcp-editor/McpOAuthControls.tsx:30` | `commands.rs:61` | 未授权、非法 URL、revoke 后、start 失败后 → `oauth.status_token_cancel_revoke_unauthorized[0][2][8]`、`oauth.start_rejected_resource_url[5]`、`oauth.start_dcr_404_on_local_service[2]` | 缺 resourceUrl → `bad_args[3]` | 已授权状态只在 pending |
| get_mcp_oauth_access_token | `mcp/mcpService.ts:256` | `commands.rs:81` | 无令牌 → `status_token…[1][3]` | 缺 serverId → `bad_args[4]` | 有令牌分支只在 pending |
| cancel_mcp_oauth | `McpOAuthControls.tsx:94` | `commands.rs:43` | 无进行中流程、空 id → `status_token…[4][5]` | 缺参 → `bad_args[5]` | 取消进行中的流程只在 pending |
| revoke_mcp_oauth | `McpOAuthControls.tsx:80` | `commands.rs:49` | 无令牌、重复 → `status_token…[6][7]` | 类型错误 → `bad_args[6]` | 撤销已有令牌只在 pending |
| start_mcp_oauth | `McpOAuthControls.tsx:59` | `commands.rs:15` | **无** | 非 HTTPS 非回环、带 userinfo、URL 解析失败、ftp、file → `oauth.start_rejected_resource_url[0-4]`；本地发现 404 后 DCR 404 → `oauth.start_dcr_404_on_local_service[0][1]`（含全空白 clientId）；发现成功但无注册端点 → `oauth.no_registration_endpoint[0]` | 授权服务器已就绪，但成功路径会打开浏览器并等待回调，需要运行器装好替身浏览器，所以只在 pending |

### 本包没有覆盖的分支

- **`backend_mcp_disabled` / 移动端 cfg 分支**：编译期或构建配置决定，桌面构建不可达。
- **`cannot resolve current working directory`**（`mcp_stdio_start`）：需要进程 cwd 已被删除，种子无法制造。
- **DB/设置读写错误**、**`AppState not available`**：空种子下不可触发。
- **opener 失败**（`start_mcp_oauth` 打开浏览器）：取决于桌面环境。
- 上表“只在 pending”的分支：OAuth 成功/有令牌/取消进行中流程。

### pending（不计覆盖，owner）

| 场景 | 缺什么 | owner | 解除条件 | 复核人 |
|---|---|---|---|---|
| `pending.oauth.start_success_with_mock_as` | 服务侧已提供授权服务器和 `${mcp.oauth.resourceUrl}`（见 "OAuth"）。`start_mcp_oauth` 固定 `open_browser:true`（`commands.rs:36`），然后阻塞等待本地回调，最多 120 s（`auth.rs:767-778`，`oauth_callback.rs:20`），比运行器的 MCP 单步上限 90 s 还长。所以运行器要把 `browserLaunch().pathDir` 放在应用 PATH 最前面 | 运行器：W13（X7） | 运行器对 `"mcp":{"oauth":true}` 的场景装好替身浏览器，并且 `records().browser` 在 A、A2、B 上都非空 | C2 |
| `pending.oauth.start_with_client_id_then_cancel` | 同上，另需场景字段 `concurrent:[[0,1]]`：start 阻塞等待回调时并发执行 cancel。预设的 clientId 在本服务上未注册，authorize 返回 400，流程只能靠 cancel 结束 | 同上；`concurrent` 语义：W13（X7） | 同上，加上运行器支持 `concurrent`；在此之前运行器必须把这个场景判为 unsupported，否则会顺序执行，第 0 步卡到超时 | C2 |

## G3 错误分支判定（g3w）

### get_mcp_stdio_allow_unapproved：`seed:"empty"` 下无可达 Err（WP-268）

不写 `expect:"error"` 场景。下列每条 Err 路径都需要存储故障，或者需要空种子不会产生的启动/维护状态。

- `src-tauri/src/cmd/mcp.rs:792-796`：命令无参数，只取 `State<AppState>`；前端调用点 `src/features/settings/components/McpDangerZoneSection.tsx:33` 也不传参，不存在参数反序列化错误。函数体只有一次 `read_mcp_allow_unapproved(&state.database)`，错误经 `AppError::internal` 映射。
- `dstu-agent/src/chat_v2/tools/mcp_settings_store.rs:66-71`：唯一的 `?` 在 `db.get_secret("mcp.stdio.allowUnapproved")` 上。取到的值交给 `parse_allow_unapproved_value`（`:135-140`），它返回普通 `bool`：缺失、`"false"`、`"1"` 或其他任何值都得 `false`，所以存了怪值也不会产生 Err（成功场景 `allow_unapproved.toggle_and_parse` 已覆盖）。
- `dstu-storage/src/database/mod.rs:4289-4292`：`mcp.stdio.allowUnapproved` 不是敏感键。它不匹配 `SENSITIVE_KEY_PATTERNS`（`dstu-security/src/secure_store.rs:134-150`，MCP 相关前缀只有 `mcp.transport.`、`mcp.tools.`、`mcp.servers.`），也不以 `.api_key`/`.apiKey` 结尾（`:563`）。因此不走安全存储分支（存储不可用、解密失败），直接调用 `get_setting`。
- `database/mod.rs:4122-4131`：`get_setting` 只会因 `get_conn_safe` 或 SQLite `query_row` 本身失败而出错；没有该行时 `optional()` 返回 `Ok(None)`。SQL 失败属于 IO/DB 故障。
- `database/mod.rs:729-737`：`get_conn_safe` 在主库处于维护模式时拒绝；互斥锁中毒会被恢复，不返回错误（`:742-754`）。主库进入维护模式的地方有三处，`seed:"empty"` 都触发不了：
  - 启动时数据治理初始化失败（`src-tauri/src/lib.rs:1370-1417`；标志在 `:1175`、`:1251`、`:1265` 置位）。需要迁移或恢复槽激活失败的种子。
  - 备份快照屏障（`data_governance/commands_backup.rs:1093-1150`，在 `:2006`/`:2808` 和 `commands_zip.rs:427` 进入）。屏障在备份任务结束时释放，命中它需要与进行中的备份竞态。
  - 恢复切槽（`data_governance/commands_restore.rs:265-318`）。需要已有备份。
- Tauri `State<AppState>` 提取失败（`state not managed`）只出现在恢复模式启动：setup 在 `app.manage(state)`（`lib.rs:1336`）之前提前返回，位置是 `lib.rs:959`、`:972`、`:986`、`:1043`、`:1053`、`:1062`、`:1317`。与 WP-246 对 `openai_codex_auth_status` 记录的种子要求相同。

X3 以后若提供维护模式或恢复模式种子，在该种子上加一步 `{ "cmd": "get_mcp_stdio_allow_unapproved", "args": {}, "expect": "error" }` 即可覆盖剩余分支。
