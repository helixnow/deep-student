# L19-mcp-browser 行为规格（`host/plugins/mcp/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 24 个 · 发出事件 13 种 · 契约：`contracts/ipc/L19-mcp-browser.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：命令参数 `Option<T>` 接受 `null` 并按 Rust `None` 处理；`get_mcp_oauth_access_token` 的 `Option<String>` 结果显式返回 `null`，`McpOAuthStatus` 两个字段始终输出；commands.rs:15-99。
- [ ] D3 全域尚未完成，撤销旧“number 可承载全部 u64”签记。`get_mcp_status.cache_state.ttl_ms` 现从字符串精确解析为 BigInt（L19-V2-11），只由 F1 kernel 的 toWireJson 在 IPC 边界转换；运行时 McpConfig、ProviderStrategies、其他任意 JSON 数值仍待逐项迁移。
- [x] 字段顺序（serde_json preserve_order）：`src-tauri/Cargo.toml:101` 启用 `serde_json` 的 `preserve_order`，`json!`/结构体字段按声明顺序输出；TS 对象字面量保持同一插入顺序（如 `mcpStatus`、`StartOAuthOutcome`）。
- [x] f32 精度：本 lane 无 f32 字段；时间、计数、RTT 均为整数或 RFC3339 字符串。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：OAuth/网络命令的 `Err(String)` 直接 `CommandError(string)`；cmd/mcp 的 `AppError` 经 `CommandError(AppError)` 序列化为 `{error_type,message,details}`；Rust 无 panic 分支，TS 不抛裸错。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：`cancel_mcp_oauth` 取消待决 OAuth；stdio close 先 cancel 再 kill；网络探测用 `AbortSignal.timeout`；子进程 Drop 对应 `ctx.effect` 的 dispose。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：OAuth manager 按 serverId 串行化待决流；stdio 会话以 sessionId 映射单写者；settings 读写走同一 F3 store。
- [x] 时间与 ID：生成方式、格式、时区：OAuth `expires_at` 与事件时间用 chrono AutoSi RFC3339（`+00:00`）；session id / OAuth state 用 UUID；RTT 用毫秒整数。
- [x] 不对含 HashMap 的结构做序列化后比对：stdio env 以键值逐项比较（`src/stdio-validation.ts`），测试不断言 HashMap 序列化后的键顺序。

## 内部模块：MCP 客户端与 `mcp` 服务（`src/client.ts` / `src/service.ts`）

### WP-214：stdio 双运行时夹具与卸载结束日志（候选待 C2 组合）

- Rust `global.rs:491-504` 清空父环境，只保最小键与显式批准 env。六个自有测试复用
  `equivalence/runtime.ts::currentStdioRuntime()`，Node/Electron 均启动描述符指定的真实 Node；
  stdout/length 的批准条目与 start 请求使用同一 command/env。生产环境白名单不变。
- Rust `global.rs:721-742` 的 detached stderr task 在 EOF/读错后仍记录 WARN/ERROR/terminated，
  :683 stdout 结束日志及 :788-848 close 阶段日志同样不依赖会话是否仍活跃。
  `index.ts` 在 apply 时绑定真实 stdio/MCP logger；异步收尾不再从 inactive Cordis context
  解析 `ctx.log`。不按 active 状态丢弃日志，不捕获并吞掉 logger 错误。
- `client.rs:970-977` await transport.close 后发 Disconnected，`stdio_proxy.rs:134-140`
  await close 后结束 reader；插件两个既有 effect 返回原 dispose Promise，交 Cordis 等待。
  未改 stdin EOF→graceful→SIGTERM→SIGKILL 预算，也未新增 reader 等待上限或全局 pending 表。
- 真实回归 `tests/stdio-stderr.test.ts` 两条新用例分别安装 session/backend 路径，以 stdin EOF
  驱动子进程写末尾有效中文与非法 UTF-8；走真实 F4 文件 logger，验证卸载后 WARN/ERROR/
  stdout 与 stderr terminated、graceful close 原日志，dispose 返回后 PID 已退出且无主动关闭事件。
  无 sleep、替换 transport/reader/logger 或错误屏蔽。
- 六文件夹具依据逐项：client → client.rs:1345-1372（完整 WARN/result-error 优先级）；
  stdio-proxy → global.rs:575-683/:788-848（原始 EOF 消息、exitCode、SIGKILL）；
  stdio-stderr → global.rs:721-742（完整 WARN 与 UTF-8/read error）；
  stdio-stdout → global.rs:560-684/:780-785（字节、framing、等待 receive settle）；
  stdio-length-text → global.rs:598-649/:869-942（原长度解析顺序/错误）；
  transport-auth → cmd/mcp.rs:1164-1243（真实解释器与 success/tools_count/echo_upper）。
  原 payload、断言和超时全部保留；WP-184 initialized 无 id/None params 字节不变。
- 证据仅为生产入口测试及 Rust 审读。TESTMAP 去向不变；不签全域 B/C 或其他平台。

### WP-014 / B7 / D21-MCP：`call_tool_with_details`

- 正式入口：`api.ts` 的 `DetailedToolRegistry.callToolWithDetails(name, args, context)` →
  `index.ts` provide 的 `ctx.mcp.registry` → `src/service.ts` 同一 `McpToolRegistry`。
  `createWebSearchToolRegistry(ctx.webSearch)` 也返回同一实现；旧 `callTool` 仍返回六项。
  `DetailedToolRegistry extends ToolRegistry`，基础 `ToolRegistry` 不变，chat/backup 测试替身无需补方法。
- 输出七元组依次为 ok/data/error/usage/citations/inject/ErrorDetails；Option 用 null。
  ErrorDetails 直接消费 F4 `platform/errors/api.ts`，逐字段对应
  `dstu-core/src/error_details.rs:9-103,186-324,365-390`：code 的 serde 形式为
  SCREAMING_SNAKE_CASE（Rust `ToolNotFound` → `TOOL_NOT_FOUND`），message/user_message/
  suggestions/trace_id/context 全保留；建议中的 url/data 为 null，不省略。

| Rust tools/mod.rs | TS service.ts 分支与错误顺序 |
|---|---|
| :163-176 enabled=false | Rust enabled 是私有 map，仅 :87 写入 true，无 setter；当前公开构造/调用路径无法进入 false 分支。没有为不可达分支新增禁用 API |
| :178-199 本地优先、超时 | `callToolWithDetails` 先匹配真实 web_search，沿用 `invokeWebSearchTool`（`src/web-search-tool.ts`）/withTimeout；15s 超时 abort 底层 HTTP，返回 `tool timeout`、仅 elapsed_ms 的 usage 和 TOOL_TIMEOUT/context.timeout_ms=15000 |
| :200-209 usage | 工具已有 usage 原样保留；仅 null 时补 elapsed_ms/UUIDv4 trace_id/tool_name/source=local；非对象值也不覆盖 |
| :212-243 err | 根据 error 是否非 null（不是 ok）调用共享 infer_error_code_from_message；API key missing/invalid、network、rate limit 调原 builder；其他 code 原 message + `工具'<name>'执行失败` + retry；没有 error 则第七项 null |
| :246-261 window/名字 | 先检查 window，才解码外部名字；无效名字返回原输入名的 ToolNotFound；无 window 即未知工具，不读取后台/global client |
| :262-276 桥与 usage | 保留原 details info 文本，复用 callFrontendMcpTool；仅对象 usage 写入新 UUIDv4/tool_name=解码名/source=mcp，其他字段保留 |
| :277-303 桥错误 | 按 tool not found → timeout → rate limit → connection/transport/network → service unavailable 顺序；故中文 `MCP 调用超时` 和 `Too many requests` 仍为 SERVICE_UNAVAILABLE，不能擅自扩展匹配 |
| :306-317 无窗口/未知工具 | error=`未知工具: <原名>`，第七项用原名生成 ToolNotFound；其余五项与 Rust 对应 |

- 所有权：无新表/文件写入；搜索设置继续经 F4；计时 performance.now 截整毫秒，ID 用 randomUUID。
  桥复用原 listener/timer finally 清理。未引入另套 transport/错误 builder。
- 证据：`tests/tool-details.test.ts` 安装真实 browser+MCP provider，经真实 SearXNG HTTP 和
  kernel 前端事件桥调用公开 registry。L22 原测试 :207-215 七条断言全部对应，并加完整返回形状、
  成功/失败/超时、局部与桥的不同分类顺序断言。平台 settings/log/llm 只为依赖夹具，未替换 registry、
  WebSearchTool、doSearch、HTTP fetch 或 ErrorDetails。无 usage 的本地成功分支当前真实 WebSearchTool
  不产生，补值逻辑按 Rust 审读，不声称已有该分支的真实 HTTP 测试。
- 本包证据级别：生产入口测试 + Rust 源码审读；全 MCP Value 精度与 WebSearchTool rerank 等另包消费。

### v2 L19-V2-02：搜索设置 ProviderStrategies 边界

- Rust入口 `web_search.rs:1128-1136`，TS入口 `browser/index.ts:97-100` 的正式
  `webSearch.loadConfig(settings)` → `loadToolConfig` → `applyDbOverrides`。
- 分支：无设置/trim空串不覆盖；合法serde结构覆盖且置overridden；语法或结构无效保持
  原默认/环境策略且warn `解析 web_search.provider_strategies 失败，忽略该覆盖`，不让后续search崩溃。
- 逐字段：`ProviderStrategies.default` 必填非null对象；九个provider为Option；
  `ProviderStrategy`全部字段Option；SpecialHandling两bool必填；无deny_unknown_fields，忽略未知字段。
  Option缺省/null归一为null，沿用生产 `parseProviderStrategies`；u32上限已校验。
  现有number策略字段的大u64内部精度仍待D3复审，不把本次结构修复签为全部serde完成。
- 所有权：只经F4读取settings，无SQL/事务/写入；无取消点与计时。
- 证据：`browser/tests/search-commands.test.ts` 通过正式service读取真实被测解码路径，
  无效矩阵逐个断言保留策略/overridden=false/warn，合法Option/未知字段逐个断言。

### v2 X6-UD-0042：OAuth persisted map 字段补正（候选待复核）

| Rust auth.rs | parseSession map 分支 |
|---|---|
| :65-71 access_token/token_type 为 String、scopes 为 Vec<String> | 三者必填且类型准确；不默认 Bearer、不对混合数组过滤后接受；String 不擅自加非空约束 |
| :68-69 expires_at / refresh_token 为 Option | 缺省/null 允许；错误 JSON 类型拒绝整条记录。expires_at 字符串内容/纳秒语义仍开放，见 BLOCKERS |
| :93-100 client/auth/token/redirect 字符串、session scopes 必填 | 保留必填字符串校验；session scopes 不再给 [] 默认或过滤坏项 |
| :96 client_secret Option<String> | 缺省/null/String 接受，其他类型失败 |
| :103-104 resource_origin 的 serde(default) | 仅缺省用空串；显式 null/非字符串失败；legacy 空绑定仍须重新授权 |
| :219 from_str(...).ok() | map 字段错误返回 None，不抛命令错误；对应状态 authorized=false / access_token=null；未知字段仍忽略 |

- 证据：oauth-session-decode.test.ts 通过真实加密 F4 SecureStore、F3 数据库和 MCP 命令入口，另调用同一生产 restoreSession；验证 13 类错误 map 与缺省/null Option、legacy、未知任意精度字段等正例。旧 OAuth 断言未变。
- 非完成声明：原文重复字段、struct 的序列形式、chrono relaxed DateTime 字符串/纳秒表示仍需精确 decoder；不得把上述字段 guard 当作完整 serde 或批准例外。
- 所有权：经 F4 SecureStore 读取，无自写 SQL/保存/补齐或删除坏记录；解析失败保持 Rust 的静默 None，不新增包含敏感载荷的日志。

### MCP 客户端与 webSearch 既有接线记录

- [x] 跨插件 `webSearch`：`WebSearchService.doSearch(input)` 保持 MCP 内部 `web_search` 工具兼容；同时发布 `CancellableWebSearchPort.loadConfig(settings|null)` 与 `doSearch(config, input, signal)` 给 L13（`api.ts`、`browser/index.ts`）。L13 先加载配置再发 start 事件，随后把同一 signal 传入搜索；builtin_retrieval_executor.rs:666-741。
- [x] 取消贯穿传输：调用方 signal 经 `doSearch` → `Provider.search` → `send` 与每请求 timeout 以 `AbortSignal.any` 合并，取消时 fetch 立即中止并以 AbortError 拒绝（不伪装成 `ok:false` 的搜索失败）；`src/web-search.ts`、`src/web-search-providers.ts`。

- [x] 输入：`McpConfig` 的 transport 四类分支；stdio 使用 command/args/env/working_dir/framing，websocket 使用 url，sse 使用 endpoint/api_key/headers，http 与 streamable_http 使用 url/api_key/headers；timeout 取 `performance.timeout_ms`；clientInfo 固定 name=`deep-student`、version=`1.0.0`；global.rs:47-267。
- [x] 输出：`initialize` 返回 `serverInfo.name/version` 与 `protocolVersion`（缺失字段落空串）；`listTools` 逐页跟随 `nextCursor`，最多 100 页，返回 camelCase `inputSchema`；`callTool` 返回 `{content,isError}`；client.rs:1182-1370。
- [x] 错误：transport 创建失败/初始化失败原样抛出并记 error；`initialize` 仅 result 缺失/null 失败：`Protocol error: Initialize failed: code=<code> message=<message>`，无 error 时为 `Protocol error: Initialize failed: response contained no result`，并记 error `[McpClient] initialize rejected by server: <detail>`（client.rs:1196/1275-1287，WP-118）；每个请求固定 30s 后 `Timeout error: Request timeout` 并记 error `MCP send_request timeout: method=<m>, id=<id>, transport=<label>`（client.rs:1708-1732）；`tools/list` 首页失败 `Failed to list tools: <message>`，无 tools 为 `Failed to list tools`，坏 tool 为 `Failed to list tools: invalid tool spec`；`tools/call` 错误 `Tool '<name>' execution failed: <message>`，坏结果 `Tool '<name>' execution failed: invalid result`；global.rs:271-279，client.rs:1302-1360。
- [x] 日志：每类 transport 创建前记 info（字段顺序与 global.rs:78/91/113/163/213 一致）；连接失败记 error `Failed to connect MCP client: <e>`；初始化失败记 error `Failed to initialize MCP client: <e>`；缺 protocolVersion 记 warn，未知版本记 warn（含支持列表），成功记 info `MCP client connected to server: <name> v<version>`；`tools/list_changed` 记 info 并发出 `mcp_tools_changed`，载荷 `{ts}` 用 chrono AutoSi `+00:00`；client.rs:1200-1220，global.rs:271-285，lib.rs:3845-3858。

### v2 `McpClient::call_tool` 结果/日志分支（X6-LP-0166 的 :1361，候选待复核）

| Rust client.rs | TS JsonRpcProbe.callTool / 真实 stdio 测试 |
|---|---|
| :1345-1366 result 存在且 is_error=true | 先拼接 Text 内容（忽略 Image/Resource）、warn，然后抛 `Tool execution error: <text>`；无文本时错误用 `Tool execution failed`，warn 仍保留空文本 |
| :1368 普通 result | 返回 parsed ToolResult，不因同时存在 error 而改走 server error |
| :1369-1370 无 result、有 error | 抛 `Server error: <message>`，不发工具执行失败 warn |
| :1371 两者均无 | 抛 `Protocol error: Tool call failed` |

- host logger 由 connectMcpClient 注入 RPC；无新事务/存储或连接重建，单个工具失败不关闭连接。证据：client.test.ts 新增真实子进程分支测试。
- JSON-RPC/ToolResult 非法结构的 serde 详细错误、其余 client warn/error、限速和 request timeout 等仍需逐项核验；本项不宣称完整 client 等价。
- [x] 事件：JSON-RPC notification 经 `handleMcpMessage` 映射 `McpEvent::ToolsChanged/ResourcesChanged/PromptsChanged/RootsChanged/Connected/Disconnected`；本插件只订阅 ToolsChanged 以清缓存并转发 `mcp_tools_changed`；client.rs:1126-1148、1761。
- [x] DB 读写：无；配置由调用方传入（`load_mcp_config_from_db` 在 L02 settings 侧，lib.rs:3862-3900）。
- [x] 取消/并发：`close` 先 `cancelAll` 再关 transport，并等待接收循环结束；并发 initialize 由调用方串行（服务先断开旧 client）；client.rs:970-1010。
- [x] 时间/ID：JSON-RPC id 从 1 递增；`mcp_tools_changed.ts` 为 `Utc::now().to_rfc3339()`；client.rs:1185，lib.rs:3850。
- [x] 本地工具：`web_search` 优先于前端 MCP 桥；参数解析与 Rust 一致（非字符串 query→空串、非 u64 top_k/start→5/None、空 query 返回 `query is empty` 与 `{elapsed_ms:0}`）；15s `default_timeout_ms` 超时返回 `tool timeout` 与 `{elapsed_ms}`；`detect_tool_conflicts` 恒空、`strip_mcp_namespace` 仅去前缀；tools/mod.rs:81-140、320-355、703-805。

### W21 LA-03：`WebSearchTool::invoke` 引擎门、会话路由与聚合

- 正式入口：`index.ts` 给 `HostMcpService` 传 `webSearchDb: { settings: ctx.settings, port: ctx.webSearch }`
  （Rust `ToolContext.db = Some(..)`）与 `dstu_mcp::tools` 日志；`src/web-search-tool.ts::invokeWebSearchTool`
  实现下表。`createWebSearchToolRegistry(service, { db, emitEvent, log })` 同样可选带 db；不带 db 时
  等同 Rust `db = None`：只走 `service.doSearch(input)`，不读设置、不过门。
- 顺序（`tools/mod.rs:722-930`）：解析参数 → 空 query → 门 1.5 → 读配置 → 门 2 → DB 覆盖 →
  无有效 key 的 engine 置空 → 路由。`stage == "test"` 只跳过两道门（:776），路由仍按会话设置。
  Rust `from_env_and_file` 吞掉所有错误（`web_search.rs:1283-1299`），:812 的 `config error` 不可达；
  TS `port.loadConfig` 含 DB 覆盖，放在门 2 之后，只有读设置失败才返回 `config error`。

| Rust tools/mod.rs | TS `invokeWebSearchTool` |
|---|---|
| :776-810 门 1.5 | 非 test 且 `session.selected_search_engines` 读到值：`input.engine` 不在去重列表 → `引擎 '<e>' 不在允许列表中。可用引擎: <a, b>。请到设置页配置相应API密钥。`，usage `{elapsed_ms:0, available_engines}`。Rust HashSet 顺序不定，TS 用首次出现顺序 |
| :812-826 配置错误 | `port.loadConfig(settings)` 抛错 → `config error: <e>`、`{elapsed_ms:0}` |
| :828-845 门 2 | 非 test 且设置读取失败/缺失/trim 空 → `请在输入栏选择搜索引擎以启用外部搜索功能`，usage null（registry 补 elapsed_ms）；debug 日志与 Rust 同文 |
| :852-866 engine 无 key | 指定 engine 无有效 key → 置空并 info 日志 |
| :869-928 路由 | 设置缺失直接 doSearch；`force_engine` 最优先；多选且未指定 engine：可用 >1 聚合、=1 用它、0 走默认；单选且未指定 engine 用所选 |
| :1167-1382 聚合 | 各引擎并发；citation 重建 SearchItem（snippet 取 chunk_text 前两行）；全失败 → `ok:false`，工具错误 `web_search error`，usage `{elapsed_ms, failed_providers, aggregated:true}`；CN 白名单 + 规范 URL 去重、稳定降序、截断 `reranker.top_k ?? top_k`、按名次重算 score；inject provider=`aggregated` |
| :931-1079 reranker | 未接：L02 无 rerank API，见 BLOCKERS L19-V2-09；聚合 usage `reranking_time_ms: null` |

- 与 Rust 对齐的细节：文件名/白名单/黑名单取 `url::Url::host_str()` 等价的 `URL.hostname`（不含端口）；
  `normalize_score` 与 citation `score` 按 f32 计算，JSON 输出 f32 最短十进制（`[1,0.6666667,0.33333334]`）；
  `buildInjectText` / citation 判空用 Rust `str::trim`（`rustTrim`）。
- 公开 helper：`api.ts` 导出 `normalizeUrl`、`hostAsFileName`、`normalizeScore`、`buildInjectText`、
  `isUrlWhitelisted` 与 `SearchItem` / `ProviderResponse` / `CnWhitelistConfig` 类型，供 W05 回退路径改为导入。
- 证据：`tests/web-search-routing.test.ts`（门、路由、聚合、全失败、emit 窗口条件；生产接线用真实
  browser+mcp 插件与 stub fetch 的 DeepSeek/SearXNG）、`tests/web-search-rust-parity.test.ts`（host_str、f32、rustTrim、导出）。

## 命令 `cancel_mcp_oauth`

<!-- BEGIN GENERATED:cmd:cancel_mcp_oauth -->
- Rust：`src-tauri/crates/dstu-mcp/src/mcp/commands.rs:43` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-editor/McpOAuthControls.tsx:94`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：serverId: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:cancel_mcp_oauth -->

- [x] 输入：`serverId: string`，无 trim/校验；commands.rs:43-47。
- [x] 输出：恒 `null`（Ok(())）；commands.rs:43-47。
- [x] 错误：`cancel_oauth` 不返回错误，命令无 Err 分支；commands.rs:43-46。
- [x] 事件：无；commands.rs:43-47。
- [x] DB 读写：无；取消只操作内存中的待决授权表；auth.rs:start_oauth/cancel_oauth。
- [x] 取消/并发：取消该 serverId 的待决 OAuth 流并唤醒等待者；其他 server 不受影响；auth.rs:1710-1745。
- [x] 时间/ID：不生成时间；使用传入 serverId 定位待决项；commands.rs:43-46。

## 命令 `export_mcp_config`

<!-- BEGIN GENERATED:cmd:export_mcp_config -->
- Rust：`src-tauri/src/commands.rs:7025` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/commands.rs:7053` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：config: McpConfig__De, format: string
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:export_mcp_config -->

- [x] 输入：桌面 mcp feature 分支；config/format 校验后忽略；commands.rs:7026-7030。
- [x] 输出：无 Ok 分支；commands.rs:7032。
- [x] 错误：Validation / Export functionality has been removed / details=null；commands.rs:7032-7034。
- [x] 事件：无；commands.rs:7026-7035。
- [x] DB 读写：无；commands.rs:7026-7035。
- [x] 取消/并发：无；commands.rs:7026-7035。
- [x] 时间/ID：无；commands.rs:7026-7035。

## 命令 `get_mcp_config`

<!-- BEGIN GENERATED:cmd:get_mcp_config -->
- Rust：`src-tauri/src/commands.rs:7003` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/commands.rs:7038` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：McpConfig · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_mcp_config -->

- [x] 输入：桌面 mcp feature 分支，无参数；commands.rs:7004。
- [x] 输出：default config 加 lib.rs:3868-4200 全部覆盖；仅使用 tools.list 第一项；存在但无效列表不回退 legacy；不读 mcp.enabled。Option 字段 None 省略；config.rs:19-208。
- [x] 错误：读取/解析错误在加载器中吞为默认；commands.rs:7006-7011 的 error 分支在当前加载器无可达 Err；lib.rs:4199。
- [x] 事件：无；commands.rs:7004-7013。
- [x] DB 读写：F4 get 非 secret，保持 Rust tools.list 旧读取路径；lib.rs:3874。
- [x] 取消/并发：不取消，顺序同步读；lib.rs:3868-4200。
- [x] 时间/ID：不生成；lib.rs:3868-4200。

## 命令 `get_mcp_oauth_access_token`

<!-- BEGIN GENERATED:cmd:get_mcp_oauth_access_token -->
- Rust：`src-tauri/crates/dstu-mcp/src/mcp/commands.rs:81` · async
- 前端：app（1 处，例 `src/mcp/mcpService.ts:256`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：serverId: string, resourceUrl: string
  - 结果：string | null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:get_mcp_oauth_access_token -->

- [x] 输入：`serverId`、`resourceUrl`；无显式校验；commands.rs:81-99。
- [x] 输出：`Option<String>` → 有可用 Bearer 时返回字符串，否则 `null`；commands.rs:88-98。
- [x] 错误：`get_bearer_token_for_resource` 的任何 Err 被吞为 `Ok(None)`，命令不会抛错；commands.rs:88-98。
- [x] 事件：无；commands.rs:81-99。
- [x] DB 读写：不直接读库；`attach_secure_store_dir` 后由 auth manager 读 secure store；commands.rs:83-86。
- [x] 取消/并发：读取共享 manager 的会话表；过期时按 refresh 流程处理（见 auth.rs），本命令不持有取消令牌；commands.rs:88-98。
- [x] 时间/ID：不生成时间；过期判断用 token `expires_at`（RFC3339）；auth.rs:token 刷新。

## 命令 `get_mcp_oauth_status`

<!-- BEGIN GENERATED:cmd:get_mcp_oauth_status -->
- Rust：`src-tauri/crates/dstu-mcp/src/mcp/commands.rs:61` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-editor/McpOAuthControls.tsx:30`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：serverId: string, resourceUrl: string
  - 结果：McpOAuthStatus · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:get_mcp_oauth_status -->

- [x] 输入：`serverId`、`resourceUrl`；无显式校验；commands.rs:61-79。
- [x] 输出：`{ server_id, authorized }`，`authorized` 为按 resource origin 归一化后的会话判定；commands.rs:67-78。
- [x] 错误：命令签名 `Err(String)`，但 `has_oauth_session_for_resource` 返回 bool，无错误分支；commands.rs:67-78。
- [x] 事件：无；commands.rs:61-79。
- [x] DB 读写：不直接读库；secure store 由 manager 在 attach 后读取；commands.rs:63-66。
- [x] 取消/并发：只读共享 manager 会话表；无取消点；commands.rs:67-78。
- [x] 时间/ID：不生成时间；按 resource origin 与 token 过期状态判定；auth.rs:resource origin 归一化。

## 命令 `get_mcp_status`

<!-- BEGIN GENERATED:cmd:get_mcp_status -->
- Rust：`src-tauri/src/cmd/mcp.rs:25` · async
- 前端：app（1 处，例 `src/utils/settingsApi.ts:196`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_mcp_status -->

- [x] 输入：无；cmd/mcp.rs:26。
- [x] 输出：Rust 固定 backend-disabled 状态；selected.trim 非空即 enabled（包括字符串 []）；缺省 enabled_reason=null；resolution 默认 use_namespace；cmd/mcp.rs:28-51。
- [x] 错误：所有读错误吞为 None；cmd/mcp.rs:36-45。
- [x] 事件：无；cmd/mcp.rs:26-56。
- [x] DB 读写：5 个 F4 get；缓存 ttl 严格 u64 parse、默认 300000；cmd/mcp.rs:36-45。

### v2 D3 边界（L19-V2-11，候选待复核）
- Rust cmd/mcp.rs:39 使用 `str::parse::<u64>()`，无需/不得 trim。TS parseExactU64 只允许可选 `+` 加 ASCII 数字，按 BigInt 检查 `[0, 18446744073709551615]`；缺失、空、溢出或非法文本使用默认 `300000n`。原正则 `$` 可接受末尾换行，现明确拒绝。
- 生产 mcpStatus 返回的 ttl_ms 保持 BigInt，包括默认值；不在本 lane 做 Number 转换。F1 kernel/json.ts:60-71 在命令 wire 边界转换，等价于 Rust 序列化数字后前端 JSON.parse 的舍入，不修改内部值。
- 证据：status-u64.test.ts 使用真实 F3 数据库、F4 settings/secrets/paths 插件；同时检查生产核心的内部 BigInt 和真实注册命令的 wire 输出，覆盖 `2^53+1`、u64::MAX、u64::MAX+1、正号/前导零、0、负数、浮点/指数与尾换行。既有 config.test.ts 原断言未改。
- 此项不改变 generated McpConfig 或自行扩大 timeout 上限；get_mcp_config 的内部运行时精度、save_mcp_config 的宽整数入参仍开放。
- 相邻状态分支 cmd/mcp.rs 对 selected_mcp_tools 用 Rust `str::trim`：已消费 F4 rustTrim（U+0085 视为空白、U+FEFF 不视为空白），新增同一真实设置/命令测试；无本地 Unicode 实现。
- [x] 取消/并发：无取消点；cmd/mcp.rs:26-56。
- [x] 时间/ID：不生成，last_built_at=null；cmd/mcp.rs:40。

## 命令 `get_mcp_stdio_allow_unapproved`

<!-- BEGIN GENERATED:cmd:get_mcp_stdio_allow_unapproved -->
- Rust：`src-tauri/src/cmd/mcp.rs:792` · async
- 前端：app（1 处，例 `src/features/settings/components/McpDangerZoneSection.tsx:33`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_mcp_stdio_allow_unapproved -->

- [x] 输入：无；cmd/mcp.rs:792-798。
- [x] 输出：`mcp.stdio.allowUnapproved` 的布尔值，缺失/空串为 false；mcp_settings_store.rs:62-73。
- [x] 错误：读 secret 失败 → `AppError::internal`（含 `failed to read ...` 文案）；cmd/mcp.rs:792-797。
- [x] 事件：无；cmd/mcp.rs:792-798。
- [x] DB 读写：读 secret 键 `mcp.stdio.allowUnapproved`；mcp_settings_store.rs:62-73。
- [x] 取消/并发：无取消点；单次读；cmd/mcp.rs:792-798。
- [x] 时间/ID：不生成时间/ID；cmd/mcp.rs:792-798。

## 命令 `get_mcp_tools`

<!-- BEGIN GENERATED:cmd:get_mcp_tools -->
- Rust：`src-tauri/src/cmd/mcp.rs:58` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_mcp_tools -->

- [x] 输入：无；cmd/mcp.rs:59。
- [x] 输出：Rust 明确空数组（前端 SDK 提供工具），非替身；cmd/mcp.rs:60-61。
- [x] 错误：无；cmd/mcp.rs:59-62。
- [x] 事件：无；cmd/mcp.rs:59-62。
- [x] DB 读写：无；cmd/mcp.rs:59-62。
- [x] 取消/并发：无；cmd/mcp.rs:59-62。
- [x] 时间/ID：无；cmd/mcp.rs:59-62。

## 命令 `import_mcp_config`

<!-- BEGIN GENERATED:cmd:import_mcp_config -->
- Rust：`src-tauri/src/commands.rs:7016` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/commands.rs:7044` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：path: string
  - 结果：McpConfig · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:import_mcp_config -->

- [x] 输入：桌面 mcp feature 分支，path 校验后忽略；commands.rs:7017。
- [x] 输出：无 Ok 分支；commands.rs:7019。
- [x] 错误：Validation / Import functionality has been removed / details=null；commands.rs:7019-7021。
- [x] 事件：无；commands.rs:7017-7022。
- [x] DB 读写：无；commands.rs:7017-7022。
- [x] 取消/并发：无；commands.rs:7017-7022。
- [x] 时间/ID：无；commands.rs:7017-7022。

## 命令 `mcp_stdio_close`

<!-- BEGIN GENERATED:cmd:mcp_stdio_close -->
- Rust：`src-tauri/src/cmd/mcp.rs:654` · async
- 前端：app（1 处，例 `src/mcp/tauriStdioTransport.ts:206`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:mcp_stdio_close -->

- [x] 输入：`sessionId: string`；unknown id 由会话管理器报错；cmd/mcp.rs:654-667。
- [x] 输出：`null`；cmd/mcp.rs:654-667。
- [x] 错误：manager 错误包为 `AppError::internal(<Display>)`；cmd/mcp.rs:658-661。
- [x] 事件：关闭时 stdio proxy 发 `{id}-closed`，载荷含 session id；stdio_proxy.rs:100-115。
- [x] DB 读写：无；会话仅内存；stdio_proxy.rs。
- [x] 取消/并发：先取消读循环并关闭 stdin，超时后 SIGKILL（Rust `close` 语义）；stdio_proxy.rs / global.rs:close。
- [x] 时间/ID：使用传入 sessionId；关闭等待有超时，不生成新 id；stdio_proxy.rs。

## 命令 `mcp_stdio_send`

<!-- BEGIN GENERATED:cmd:mcp_stdio_send -->
- Rust：`src-tauri/src/cmd/mcp.rs:639` · async
- 前端：app（1 处，例 `src/mcp/tauriStdioTransport.ts:195`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, payload: string
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:mcp_stdio_send -->

- [x] 输入：`sessionId`、`payload` 原样字符串；cmd/mcp.rs:639-651。
- [x] 输出：`null`；cmd/mcp.rs:639-651。
- [x] 错误：未知会话/写 stdin 失败 → `AppError::internal(<Display>)`；cmd/mcp.rs:643-647。
- [x] 事件：stdio proxy 在收到子进程输出时发 `{id}-message`/`{id}-error`；stdio_proxy.rs:80-95。
- [x] DB 读写：无；stdio_proxy.rs。
- [x] 取消/并发：写入同一子进程 stdin，按会话串行；无取消点；cmd/mcp.rs:643-647。
- [x] 时间/ID：使用传入 sessionId；不生成时间；cmd/mcp.rs:639-651。

## 命令 `mcp_stdio_start`

<!-- BEGIN GENERATED:cmd:mcp_stdio_start -->
- Rust：`src-tauri/src/cmd/mcp.rs:553` · async
- 前端：app（1 处，例 `src/mcp/tauriStdioTransport.ts:161`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：command: string, args: string[], env?: object | null, framing?: string | null, cwd?: string | null
  - 结果：string · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:mcp_stdio_start -->

- [x] 输入：`command`、`args`、可选 `env`/`framing`/`cwd`；严格模式要求与已启用 stdio 条目逐项相等（命令/参数/env/cwd/framing，canonicalize 后比较）；cmd/mcp.rs:553-636、validate_stdio_start_against_entries:446-548。
- [x] 输出：stdout 会话 id（UUID 字符串）；cmd/mcp.rs:630-635。
- [x] 错误：未授权/校验失败 → `AppError::internal("mcp_stdio_start rejected: ...")`；spawn 失败带诊断；cmd/mcp.rs:624-635、global.rs:spawn。
- [x] 事件：子进程输出发 `{id}-message`/`{id}-error`，关闭发 `{id}-closed`；stdio_proxy.rs:80-115。
- [x] DB 读写：读 `mcp.tools.list`（严格模式）与 `mcp.stdio.allowUnapproved`；cmd/mcp.rs:568-583。
- [x] 取消/并发：每个 session 独立子进程；close/dispose 先 cancel 再 kill；spawn 不阻塞其他会话；stdio_proxy.rs。
- [x] 时间/ID：会话 id 为 UUID；创建时记录启动时间用于诊断；stdio_proxy.rs。
- [x] 日志：未批准模式每次 spawn 记 warn（command/args/cwd/framing/env_keys），严格模式不记；cmd/mcp.rs:600-618。

### v2 L19-V2-13：末尾无换行行的 EOF（候选待复核）

- Rust global.rs:575-581 每次先清空 String，BufReader.read_line 返回最后无换行文本一次，下一次读得 0 后退出；stdio_proxy.rs:99-107 随后自动清理并发 closed。
- TS LineReader 以前在 EOF 只设置 _ended，却未消费 _buffer，也未读取该标志，重复返回同一文本，可能让会话循环不断重复发消息。现 EOF 取出并清空尾缓冲，后续稳定返回 null。
- 测试：先用三次有限读取在原实现复现（20261104204807-011f16，第二次错误返回同一文本）；修后真实子进程输出两行、最后一行无 LF，经 StdioSessionManager.start 的生产路径只发两条 message、一次 closed，移除会话。观察器在意外第三条时终止错误循环以保持回归有限，但保留第三条给外层精确断言，不忽略多余数据、不新增业务限额。
- 不改 byte limit、Content-Length 算法、错误形状、超时或主动 close 的事件策略。其他 framing/UTF-8/并发退出分支仍待完整复核，不以此签整个 stdio 等价。

### v2 stderr 日志与读取（X6-LP-0168/0169 的 global.rs:721-742）

| Rust 分支 | Host |
|---|---|
| :727-733 完整 UTF-8 行、trim_end、非空 warn | factory 的唯一 monitorStderr，通过原始字节行消费 F4 decodeUtf8Strict/rustTrimEnd，保留前导空格/FEFF、去除 Rust 尾空白 |
| :735-737 read_line 错误，error 后停止 | 原生流错误保留原因；Utf8DecodeError 映射 `Error reading from MCP stderr: stream did not contain valid UTF-8`，不替换为 U+FFFD 或继续输出后续行 |
| :741 任务终止 info、reader drop | finally 返回/关闭原生 iterator，再记录 `MCP stderr reader terminated` |

- 每个 stdio transport 一份监控，覆盖 frontend session / backend client / testStdio 生产命令；不新增 DB、worker、限额或超时。不与另一个 data listener 竞争 stderr，也不保留未使用的截断 ring。
- 证据：stdio-stderr.test.ts 两条确定性字节流输入 + 两条真实子进程生产路径；stdio-proxy/client 全部旧测试保持。stdout 的现有解码及其他协议分支不在此完成声明内。

### v2 stdout UTF-8 / 退出收尾（L19-V2-14，候选待复核）

| Rust global.rs / stdio_proxy.rs | 生产 TS 落点 |
|---|---|
| :578/659-661 JSONL read_line InvalidData | LineReader.readLine 使用 F4 strict decode，readStdioStdout 记录 `(JSONL)` 错误并停止，不发 U+FFFD 替换消息 |
| :880、:936-940 配置 C-L header / body | strict 行解码；帧体按 F4 FromUtf8Error 文案保留 `Invalid UTF-8 in message body: ...`，统一 `(Content-Length)` 日志；read_exact 短 body 报 early eof |
| :985-992、:954-967 C-L→JSONL | 首行按 Rust trim，后续按 trim_end；后续行错误为 `(JSONL fallback)`，不继续发送坏行后的有效行 |
| :614-640 JSONL→C-L 的首帧 header/body | 剩余 header 错误、body early eof、body FromUtf8Error 各保原上下文；失败时保持未接收消息的 EOF 诊断 |
| :669-683、:780-785 reader 结束 / sender drop | frontend/backend 共享读取逻辑；finally 关闭流并记录 stdout reader terminated；receive 消费剩余有效消息后 Channel closed，已等待 receive 也得到关闭错误 |
| stdio_proxy.rs:90-107 error→清理→closed | 真 IPC 用例断言消息顺序、唯一 error/closed；关闭后 mcp_stdio_send 按 Rust internal(Unknown)+Transport error 响应，证明会话已移除 |

- 未加帧限额，100 MiB 配置帧上限仍按原位置应用；未改 RPC timeout、重试或进程关闭预算。长度数字词法/D3 和原诊断预览的大字节边界、主动关闭竞态另列待审，不宣称本节覆盖整个 stdio。
- 证据：stdio-stdout.test.ts 的 14 条 kernel 批准门+真实子进程用例及3条 backend 传输用例，错误文本取自上述原分支；合法字节的空白/BOM 不擅自规范化为另一消息。旧测试未删改断言。

### 两处长度 FromStr 与精确上限（L19-V2-15，候选待复核）

| Rust global.rs | TS / 验证 |
|---|---|
| :878-909 完整header读取→首个匹配 Content-Length: 空格→trim→parse usize | prefix/完整读取次序保持；usize-text.parseUsizeText 只接受非空 ASCII 十进制与可选+，返回精确 BigInt 或原分类 |
| :903-908 ParseIntError | 配置路径保留 `Invalid Content-Length value: <ParseIntError Display>`，不再输出旧原value代替解析原因；空字段若整行trim后不匹配prefix，仍走原 missing/invalid header |
| :913-929 零值→100*1024*1024 | 零值保持 Missing or invalid；合法值与104857600n精确比较，超限直接以原精确十进制输出，不读body |
| :600-609 JSONL首帧先 parse 且>0 | 统一整数语法，但仍保留该分支的 `Invalid Content-Length in fallback first line: <Debug raw>`，不挪到剩余header之后 |
| :614-640 读取剩余header、Vec/read/body UTF8 | 不加配置路径的100MiB cap；大合法值+坏后续header必须先得到header错误。完整Node分配等价见下面未决，不伪造已验证 |

- std ParseIntError 规则依据：rust-lang/rust library/core/src/num/mod.rs unsigned FromStr checked loop 与 num/error.rs Display；当前数字先校验后报告本步乘加溢出，已溢出的前缀先于更后面的坏字符失败。未运行/修改参考Rust。
- readExact 保留精确目标计数，64KiB只是IO粒度，不是帧准入限额；Node仍延迟聚合Buffer，Rust先分配Vec，两者的大值容量/分配失败等价独立未决。未做OOM/巨大body验证，不签全usize。
- 测试：新 stdio-length-text.test.ts 经真实 mcp_stdio_start批准门/Node子进程；配置大值均无body即超限拒绝，fallback大值停在坏剩余header前，不触及分配。未改RPC超时/关闭/重试预算，没有重排旧17/30替代新证据。

## 命令 `network_probe`

<!-- BEGIN GENERATED:cmd:network_probe -->
- Rust：`src-tauri/src/cmd/network.rs:38` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：url: string, method?: string | null, timeoutMs?: integer(u64) | null
  - 结果：NetworkProbeResult · 错误：string
<!-- END GENERATED:cmd:network_probe -->

- [x] 输入：`url` 必须以 `http://`/`https://` 开头；`method` 仅大小写不敏感 `GET` 时用 GET，否则 HEAD；`timeout_ms` 缺省 5000，clamp [100,30000]；network.rs:38-84。
- [x] 输出：`{ok,statusCode,rttMs,error}`（camelCase）；收到任意 HTTP 响应即 `ok:true` 且 statusCode 存在；network.rs:22-33、63-77。
- [x] 错误：非 http(s) → `Err("仅支持 http/https URL: {url}")`；客户端构建失败 → `构建 HTTP 客户端失败: ...`；network.rs:44-59。
- [x] 事件：无；network.rs:38-84。
- [x] DB 读写：无；network.rs:38-84。
- [x] 取消/并发：每次请求独立 reqwest Client 与 timeout；无共享取消令牌；network.rs:55-62。
- [x] 时间/ID：`rttMs` 从发起请求到收到响应头的毫秒数；不生成 ID；network.rs:61-77。

## 命令 `preheat_mcp_tools`

<!-- BEGIN GENERATED:cmd:preheat_mcp_tools -->
- Rust：`src-tauri/src/cmd/mcp.rs:822` · async
- 前端：app（3 处，例 `src/features/settings/components/mcp-editor/mcpServerOps.tsx:43`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:preheat_mcp_tools -->

- [x] 输入：无参数；注入 window/state；cmd/mcp.rs:822-829。
- [x] 输出：固定 `{ok:true,count}`，count 为 `llm_manager.preheat_mcp_tools_public(window)` 返回的前端 MCP 工具数；cmd/mcp.rs:827-828。
- [x] 错误：命令自身无错误分支；缓存读取失败在 LLM manager 内吞掉；cmd/mcp.rs:827。
- [x] 事件：`preheat_mcp_tools_public` 通过 `mcp-bridge-tools-response:<id>` 请求前端工具列表；本 lane 无对应 window 事件；llm_manager/mod.rs:8199-8260。
- [x] DB 读写：读 `mcp.performance.cache_ttl_ms`（默认 300000）作为缓存 TTL；llm_manager/mod.rs:8200-8208。
- [x] 取消/并发：请求前端工具带超时；本 lane 依赖 LLM manager 串行；llm_manager/mod.rs:8213-8260。
- [x] 时间/ID：每次请求生成 UUID correlation id；llm_manager/mod.rs:8220。
- [x] 接线：`preheat_mcp_tools` 每次调用经 `ctx.reflect.get('llmMcpTools')` 取 L02 服务，await `preheat(call.source)`（调用窗口交给前端工具清单请求）并返回真实 `count`；服务缺失抛 `AppError.internal`，预热失败同样抛 `AppError.internal`，不再返回 `count:0` 占位；index.ts、tests/tool-cache-commands.test.ts（装载真实 llm 插件）。

## 命令 `reload_mcp_client`

<!-- BEGIN GENERATED:cmd:reload_mcp_client -->
- Rust：`src-tauri/src/cmd/mcp.rs:784` · async
- 前端：app（1 处，例 `src/utils/settingsApi.ts:174`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:reload_mcp_client -->

- [x] 输入：无参数；注入 state；cmd/mcp.rs:784-789。
- [x] 输出：固定 `{success:true,message:"Backend MCP disabled; frontend SDK in use"}`；cmd/mcp.rs:787-788。
- [x] 错误：`clear_mcp_tool_cache` 无错误返回；命令恒成功；cmd/mcp.rs:787。
- [x] 事件：无；cmd/mcp.rs:785-789。
- [x] DB 读写：无；cmd/mcp.rs:785-789。
- [x] 取消/并发：无取消点；清缓存为写锁内同步清空；llm_manager/mod.rs:8263-8267。
- [x] 时间/ID：不生成；cmd/mcp.rs:785-789。
- [x] 接线：`reload_mcp_client` 每次调用经 `ctx.reflect.get('llmMcpTools')` 取 L02 服务，调 `clear()` 后再返回 Rust 固定载荷；服务缺失抛 `AppError.internal`，清理失败同样抛 `AppError.internal`，不再返回“兼容 success”占位；index.ts、tests/tool-cache-commands.test.ts（装载真实 llm 插件）。

## 命令 `revoke_mcp_oauth`

<!-- BEGIN GENERATED:cmd:revoke_mcp_oauth -->
- Rust：`src-tauri/crates/dstu-mcp/src/mcp/commands.rs:49` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-editor/McpOAuthControls.tsx:80`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：serverId: string
  - 结果：null · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:revoke_mcp_oauth -->

- [x] 输入：`serverId: string`；无显式校验；commands.rs:49-59。
- [x] 输出：`null`；commands.rs:49-59。
- [x] 错误：`revoke_token` 失败 → `Err(e.to_string())`；commands.rs:55-58。
- [x] 事件：无；commands.rs:49-59。
- [x] DB 读写：不直接读库；attach 后由 manager 删除 secure store 中的 token；commands.rs:51-58。
- [x] 取消/并发：吊销该 server 的 token 并清会话；与其他 server 无关；auth.rs:revoke_token。
- [x] 时间/ID：不生成时间；使用 serverId 定位；commands.rs:49-58。

## 命令 `save_mcp_config`

<!-- BEGIN GENERATED:cmd:save_mcp_config -->
- Rust：`src-tauri/src/cmd/mcp.rs:688` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：config: Value
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_mcp_config -->

- [x] 输入：任意 JSON，仅处理 transport/tools/performance 中类型匹配字段，不存 enabled/cwd/env；数组只取字符串并逗号连接、不 trim；cmd/mcp.rs:698-777。
- [x] 输出：true；cmd/mcp.rs:781。
- [x] 错误：F4 save anyhow 错误转 Unknown，details=null；cmd/mcp.rs:700 等 ? 与 models.rs From<anyhow>。
- [x] 事件：无；cmd/mcp.rs:689-782。
- [x] DB 读写：按源码顺序非事务逐 key 保存，前面成功后后面失败不回滚；cmd/mcp.rs:700-777。
- [x] 取消/并发：无取消点，同步写序列；cmd/mcp.rs:689-782。
- [x] 时间/ID：F4 save 生成 updated_at；cmd/mcp.rs:700-777。

## 命令 `set_mcp_stdio_allow_unapproved`

<!-- BEGIN GENERATED:cmd:set_mcp_stdio_allow_unapproved -->
- Rust：`src-tauri/src/cmd/mcp.rs:801` · async
- 前端：app（1 处，例 `src/features/settings/components/McpDangerZoneSection.tsx:49`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：enabled: boolean
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:set_mcp_stdio_allow_unapproved -->

- [x] 输入：`enabled: boolean`；无其他校验；cmd/mcp.rs:801-821。
- [x] 输出：`null`（Ok(())）；cmd/mcp.rs:801-821。
- [x] 错误：写 secret 失败 → `AppError::internal`；cmd/mcp.rs:805-807。
- [x] 事件：无；开启记 warn（含键名与绕过批准门的说明），关闭记 info；cmd/mcp.rs:808-821。
- [x] DB 读写：写 secret 键 `mcp.stdio.allowUnapproved` 为 `true`/`false`；mcp_settings_store.rs:75-78。
- [x] 取消/并发：无取消点；写入由 F3 store 串行；cmd/mcp.rs:805-823。
- [x] 时间/ID：不生成时间/ID；cmd/mcp.rs:801-821。

## 命令 `start_mcp_oauth`

<!-- BEGIN GENERATED:cmd:start_mcp_oauth -->
- Rust：`src-tauri/crates/dstu-mcp/src/mcp/commands.rs:15` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-editor/McpOAuthControls.tsx:59`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：serverId: string, resourceUrl: string, clientId?: string | null, clientSecret?: string | null, scopes?: string[] | null
  - 结果：StartOAuthOutcome · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:start_mcp_oauth -->

- [x] 输入：`serverId`、`resourceUrl`、可选 `clientId`/`clientSecret`/`scopes`；scopes 缺省空数组；`openBrowser:true`、`timeout:None`；commands.rs:15-41。
- [x] 输出：`StartOAuthOutcome`（server_id/token_type/expires_at/authorization_url/redirect_uri；access_token 被 skip_serializing）；commands.rs:27-40。
- [x] 错误：manager 错误 → `Err(e.to_string())`；commands.rs:38-40。
- [x] 事件：无后端事件；通过系统浏览器打开授权页；commands.rs:33-37。
- [x] DB 读写：不直接读库；attach secure store 后在完成时持久化 token；commands.rs:22-25、auth.rs:persist。
- [x] 取消/并发：同 serverId 的并发 start 由 manager 串行并复用待决流；`cancel_mcp_oauth` 可取消；auth.rs:start_oauth。
- [x] 时间/ID：`expires_at` 为 RFC3339；state/PKCE 与授权 URL 由 manager 生成；auth.rs:authorization_url/PKCE。

## 命令 `test_mcp_connection`

<!-- BEGIN GENERATED:cmd:test_mcp_connection -->
- Rust：`src-tauri/src/cmd/mcp.rs:65` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/cmd/mcp.rs:103` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：app（1 处，例 `src/utils/settingsApi.ts:107`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：command: string, args: string[], env?: object | null, cwd?: string | null, framing?: string | null
  - 结果：Value · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:test_mcp_connection -->

- [x] 输入：`command`、`args`、可选 `env`/`cwd`/`framing`；与已启用 stdio 条目严格匹配（同 mcp_stdio_start）；cmd/mcp.rs:65-100。
- [x] 输出：`test_stdio` 的 Value（success/tools/protocol 等），失败也以 Value 返回；cmd/mcp.rs:95-100。
- [x] 错误：读取/校验失败 → `AppError::internal`；底层连接失败在 Value 的 `success:false/error` 中；cmd/mcp.rs:84-94。
- [x] 事件：每步发 `mcp-test-progress`，载荷 `{step}`；cmd/mcp.rs:76-79。
- [x] DB 读写：读 `mcp.tools.list`；cmd/mcp.rs:80-83。
- [x] 取消/并发：测试过程在独立子进程，结束后清理；同一命令并发由前端/注册表串行；test_helpers.rs:test_stdio。
- [x] 时间/ID：不生成时间；底层连接有 timeout；test_helpers.rs:test_stdio。

### WP-118 probe 阶段错误与断连（test_helpers.rs:175-205/270-376）

- [x] 阶段：`connecting`（connect_with_retry：transport 未连接时每 250ms 重试，30s 后 `连接失败: Connection error: 连接超时: <last>`）→ `initializing`（`初始化失败: <McpError>`）→ `listing_tools`（`tools/list 调用失败: <McpError>`）；三处失败都先 `let _ = disconnect()` 再返回；成功后发 `done`。prompts/resources 失败仅入 warnings，文案 `Protocol error: Failed to list prompts|resources`。
- [x] 前缀归属：`无法启动进程:` / `HTTP 初始化失败:` / `SSE 初始化失败:` 只包 transport 创建（SSE 含等待 endpoint 事件的就绪，对应 `SSETransport::new` 等连接）；阶段错误原样作为 `error`。
- [x] 等待者终止：stdio 子进程退出或发垃圾行后 receive loop 停止，挂起的 `tools/list` 经固定 30s `send_request` 超时返回 `tools/list 调用失败: Timeout error: Request timeout`，随后断连。证据：`equivalence/mcp-service.test.ts`、`tests/probe-stages.test.ts`。
- 未改（范围外，记录差异）：probe `listTools` 不分页、对非数组 `tools` 返回空列表（Rust serde 报 SerializationError）；`ServerInfo.name` 缺省 `''`（Rust `unknown`）；`handleMcpMessage` 非 JSON 不记 warn（client.rs:1047）；`testWebSocket`/`testStreamableHttpRmcp` 失败文案保持原状。initialized 通知名由 WP-184 单独修复，见下节。

### WP-184 / D079：initialize 后的原名 initialized wire

- Rust `client.rs:1263-1274`：先写 session.server_info / initialized，再发 ServerInfoReceived，随后
  `send_notification("initialized", None).await?`，成功才返回 server_info；通知发送失败直接传播。
  TS `probe.ts:207-217` 保持 store → event → await notify → return，只改通知方法名。
- `client.rs:104-109,1736-1746` 的 JsonRpcNotification 无 id，None params 被省略；发送文本为
  `{"jsonrpc":"2.0","method":"initialized"}`。不是 params:null / params:{}，也不分配请求 id。
- 生产入口为 `index.ts` 的 test_mcp_connection / test_mcp_http / test_mcp_sse，以及 provide 的
  `mcp.initializeGlobalClient` → connectMcpClient → JsonRpcProbe.initialize；真实 stdio/HTTP 记录
  initialize → initialized → tools/list（probe 另有 prompts/list、resources/list），保持完整序列断言。
- 原 Rust `jsonrpc_notification_omits_params_when_none`（:2370-2382）只测试 serializer 任意 method
  字符串的 None 规则，其 `notifications/initialized` 输入仍保留；另加 :1272 的实际通知字节断言。
- 本步骤无 SQL/文件持久化、无新增日志或时钟。沿用 WP-118 阶段错误/断连/30s 等待者 settle；
  HTTP 非2xx/断连的既有底层错误文本不是本包全错误等价签收。
- 证据：`equivalence/mcp-service.test.ts` 保留五处完整 probe 序列期待，新增注册 mcp service 的
  stdio/HTTP connect→list，以及真实 HTTP 延迟 notification 响应的成功/503/断连矩阵。
  后者在 ServerInfoReceived 回调读取已存 server，在服务端收到通知但未响应时断言 initialize 未
  settle，响应/断连后断言成功或原错误；失败另经注册 test_mcp_http / initializeGlobalClient 验证
  初始化阶段前缀、全局 client 仍 null、原 error 日志和没有后续 tools/list。

## 命令 `test_mcp_http`

<!-- BEGIN GENERATED:cmd:test_mcp_http -->
- Rust：`src-tauri/src/cmd/mcp.rs:172` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/cmd/mcp.rs:189` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：app（1 处，例 `src/utils/settingsApi.ts:154`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：endpoint: string, apiKey: string, env?: object | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_mcp_http -->

- [x] 输入：`endpoint`、`apiKey`（trim 后空串→None）、可选 `env`；cmd/mcp.rs:172-187。
- [x] 输出：`test_http` 的 Value；cmd/mcp.rs:185-187。
- [x] 错误：命令签名 `AppError`，但 helper 以 Value 返回连接失败；cmd/mcp.rs:185-187。
- [x] 事件：无；cmd/mcp.rs:172-187。
- [x] DB 读写：无（env 为旧参数，未落库）；cmd/mcp.rs:172-187。
- [x] 取消/并发：单次 HTTP 探测，带 helper 内部 timeout；无取消令牌；test_helpers.rs:test_http；HTTP `text/event-stream` 响应经 `SseEventBuffer` + `extractStreamDataPayload` 解析（共享 10 MiB/UTF-8 flush）。
- [x] 时间/ID：不生成时间/ID；cmd/mcp.rs:172-187。

### v2 header 分支 / 日志映射（X6-LP-0172，候选待复核）

| Rust | TS / 证据 |
|---|---|
| test_helpers.rs:151-160：Rust trim 后 HeaderName 无效，warn 原始 key 并继续 | probe.ts mapEnvToHeaders，token 字符校验；`忽略无法解析的头部键: <key>`，target `dstu_mcp::mcp::test_helpers` |
| :162-167：trim 后 HeaderValue 无效，warn 原始 key/value 并继续 | 同 helper 拒绝非 HTAB 控制字符/DEL；`忽略无法解析的头部值 <key> = <value>` |
| :169：有效 header 插入 HeaderMap | 名字 ASCII 小写，Rust White_Space trim；值按 UTF-8 字节转 fetch ByteString，保留非 ASCII/FEFF；不新增任意长度上限 |
| http_transport.rs:64-101,153：自定义 header 先入，api_key 覆盖 authorization，强制 Accept，json 请求 Content-Type | probe.ts headerRecord；不再把不同大小写 Authorization 合并或覆盖显式 API key |

- 两种无效条目各 warn 一次，均在建立传输/发送请求之前；独立条目顺序不作保证（Rust HashMap）。有效条目不产生这些 warn。
- 无数据库写入；HTTP/SSE 流和取消预算未在本项重写。证据：probe-headers.test.ts 经 kernel 命令与真实 node:http 服务器验证坏头不妨碍完成 MCP 握手/工具列表读取；原 transport-auth 测试保留。

## 命令 `test_mcp_sse`

<!-- BEGIN GENERATED:cmd:test_mcp_sse -->
- Rust：`src-tauri/src/cmd/mcp.rs:142` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/cmd/mcp.rs:159` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：app（1 处，例 `src/utils/settingsApi.ts:144`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：endpoint: string, apiKey: string, env?: object | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_mcp_sse -->

- [x] 输入：`endpoint`、`apiKey`（trim 后空串→None）、可选 `env`；cmd/mcp.rs:142-157。
- [x] 输出：`test_sse` 的 Value；cmd/mcp.rs:155-157。
- [x] 错误：命令签名 `AppError`，但 helper 以 Value 返回连接失败；cmd/mcp.rs:155-157。
- [x] 事件：无；cmd/mcp.rs:142-157。
- [x] DB 读写：无；cmd/mcp.rs:142-157。
- [x] 取消/并发：单次 SSE 探测；空 endpoint、连接失败、非 2xx 或流在 endpoint 事件前结束会立即以真实错误终止；已连接但尚未收到 endpoint 事件的慢服务器仍使用完整 60s 预算，收到后 POST 到其广告的 postUrl；无取消令牌；test_helpers.rs:test_sse、probe.ts:sseTransport（`SseEventBuffer` + `extractStreamDataPayload`，10 MiB/UTF-8 flush 由 F4 共享实现提供）。
- [x] 时间/ID：不生成时间/ID；cmd/mcp.rs:142-157。

- X6-LP-0172 同根修复：testSse 原先丢弃所有 env，现按 test_helpers.rs:98-104 验证并传给真实 SSE GET/POST；共用上述 warn 分支。sse_transport.rs:265 GET 显式 Accept=text/event-stream，:191 POST 仅设置 JSON Content-Type，保留配置中的 Accept，不强制 application/json。API key 覆盖自定义 authorization。
- 证据：probe-headers.test.ts 的 test_mcp_sse 用真实 endpoint 事件和 POST 响应流，校验 GET/POST 均携带合法 env 值、坏条目各 warn 一次。未改变 SSE 重连/退避等其他待审分支。

## 命令 `test_mcp_websocket`

<!-- BEGIN GENERATED:cmd:test_mcp_websocket -->
- Rust：`src-tauri/src/cmd/mcp.rs:119` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/cmd/mcp.rs:130` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：app（1 处，例 `src/utils/settingsApi.ts:134`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：url: string, env?: object | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_mcp_websocket -->

- [x] 输入：`url`；`env` 参数被显式忽略（兼容旧前端）；cmd/mcp.rs:119-138。
- [x] 输出：`test_websocket` 的 Value；cmd/mcp.rs:126-128。
- [x] 错误：命令签名 `AppError`，但 helper 以 Value 返回连接失败；cmd/mcp.rs:126-128。
- [x] 事件：无；cmd/mcp.rs:119-138。
- [x] DB 读写：无；cmd/mcp.rs:119-138。
- [x] 取消/并发：单次 WebSocket 探测，带 helper 内部 timeout；无取消令牌；test_helpers.rs:test_websocket。
- [x] 时间/ID：不生成时间/ID；cmd/mcp.rs:119-138。

## 命令 `test_rmcp_streamable_http`

<!-- BEGIN GENERATED:cmd:test_rmcp_streamable_http -->
- Rust：`src-tauri/src/cmd/mcp.rs:671` · async · `#[cfg(feature = "mcp")]`
- Rust：`src-tauri/src/cmd/mcp.rs:680` · async · `#[cfg(not(feature = "mcp"))]`
- 同名命令有 2 个定义（按 cfg 条件编译二选一）；桌面构建启用的 feature 决定实际行为，须在下方注明。
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：url: string, apiKey?: string | null
  - 结果：Value · 错误：AppError
<!-- END GENERATED:cmd:test_rmcp_streamable_http -->

- [x] 输入：`url`、可选 `apiKey`（不 trim，原样传递，None 保持 None）；cmd/mcp.rs:671-686。
- [x] 输出：`test_streamable_http_rmcp` 的 Value；cmd/mcp.rs:678-680。
- [x] 错误：命令签名 `AppError`，但 helper 以 Value 返回连接失败；cmd/mcp.rs:678-680。
- [x] 事件：无；cmd/mcp.rs:671-686。
- [x] DB 读写：无；cmd/mcp.rs:671-686。
- [x] 取消/并发：单次 Streamable HTTP 探测，带 helper 内部 timeout；无取消令牌；test_helpers.rs:test_streamable_http_rmcp。
- [x] 时间/ID：不生成时间/ID；cmd/mcp.rs:671-686。

## 事件 `mcp-bridge-request`

<!-- BEGIN GENERATED:event:mcp-bridge-request -->
- 事件名 `mcp-bridge-request`
- 发送点：`src-tauri/crates/dstu-mcp/src/tools/mod.rs:472`（emit）
<!-- END GENERATED:event:mcp-bridge-request -->

- [x] 载荷：`{ correlationId: string, tool: string, serverId: string | null, args: object, timeoutMs: number }`。
  `correlationId` 为 UUID v4；`tool` 是去掉 `mcp_` / namespace 前缀后的前端工具名；
  `args` 会先移除控制字段 `_serverId` 与 `_timeoutMs`（或 `__bridgeTimeoutMs`）；
  `timeoutMs` 默认 180000，调用方覆盖值按 1000..=300000 clamp
  （`src-tauri/crates/dstu-mcp/src/tools/mod.rs:414-473`）。
- [x] 触发时机与顺序：本地工具未命中且 `ToolContext.window` 存在时，先在目标窗口注册
  `mcp-bridge-response:<correlationId>` 监听，再发送本事件；收到首个可解析响应或超时后
  立即注销监听（`tools/mod.rs:426-459,472`；TS `service.ts::callFrontendMcpTool`）。
- [x] 节流/合并：无节流、不合并；每次调用生成独立 correlation 与一次性监听，首个响应生效
  （`tools/mod.rs:426-447`）。
- [x] 是否在事务提交后：不涉及数据库事务；纯窗口事件往返
  （`tools/mod.rs:397-535`）。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `window.emit` 从调用窗口广播该事件
  （`tools/mod.rs:472`）。TS 侧用 `ctx.backendEvents.emitTo({ kind: 'Window', label })`
  定向调用窗口；F1 已按 Tauri target 语义路由（实现 `902d86ee3`，说明 `a86321fec`）：
  `listenWindow` 注册 `EventTarget::Window`，广播 target `Any` 与目标 `Window` 都投递，
  source 不参与接收范围。响应经 F1 `listenWindow` 接收，监听 disposer 在 `finally`
  与超时路径均执行；`tests/bridge.test.ts` 覆盖广播、定向与错误窗口不投递。
  真实 Electron 窗口消费仍未验证。
- [x] 响应契约：`{ ok: boolean, data?: JsonValue, error?: string, usage?: object }`；
  `ok` 缺失或非布尔时返回“MCP 响应格式无效：缺少 ok 字段”，`usage` 对象补
  `bridge:"frontend"`、`trace_id`、`tool_name`、`source:"mcp-frontend"`
  （`tools/mod.rs:484-535`；`tests/bridge.test.ts`）。

## 事件 `mcp-test-progress`

<!-- BEGIN GENERATED:event:mcp-test-progress -->
- 事件名 `mcp-test-progress`
- 发送点：`src-tauri/src/cmd/mcp.rs:76`（emit）
<!-- END GENERATED:event:mcp-test-progress -->

- [x] 载荷：`{ step: string }`；`step` 为连接测试的阶段名，原样透传（`src/cmd/mcp.rs:75-77`）。
- [x] 触发时机与顺序：`test_mcp_connection` 调用 `test_stdio` 时传入 progress 回调，测试助手在每个阶段开始时调用；命令返回前可能发送多条，顺序即阶段推进顺序（`src/cmd/mcp.rs:75-77`、`test_helpers.rs`）。
- [x] 节流/合并：无；每个阶段发一条。
- [x] 是否在事务提交后：不涉及数据库事务；测试进程独立，不写业务库。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app_handle.emit` 广播到所有窗口（`src/cmd/mcp.rs:76`）；TS 用 `ctx.backendEvents.emit('mcp-test-progress', { step })`（`host/plugins/mcp/index.ts:143`），F2 按 target 扇出。

## 事件 `{}_web_search`

<!-- BEGIN GENERATED:event:fmt:{}_web_search -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-mcp/src/tools/mod.rs:1141`（emit）
<!-- END GENERATED:event:fmt:{}_web_search -->

- [x] 载荷：`{ sources: RagSourceInfo[], stage: string, tool_name: "web_search" }`；每个 source 含 `document_id`、`file_name`、`chunk_text`、`score`、`chunk_index`、`source_type="search"`、`origin="web_search"`、`stage`（`dstu-mcp/src/tools/mod.rs:1124-1150`）；TS 在 `host/plugins/mcp/src/service.ts:111-130` 生成同一形状，`score` 按 Rust f32 的 serde_json 最短十进制输出（`f32ScoreJson`）。
- [x] 触发时机与顺序：`web_search` 本地工具成功返回且 citations 非空时，在工具结果返回前发送；`ctx.window` 或 `ctx.stream_event` 任一缺失、或 citations 为空则不发（`tools/mod.rs:1123` 的 `if let (Some(window), Some(stream_event))`，`:1119-1150`）。TS 在 `McpToolRegistry.callTool` / `callToolWithDetails` 的 web_search 分支调用 `emitWebSearchSources`，无 window 直接返回。
- [x] 节流/合并：无；每次成功搜索发一条。
- [x] 是否在事务提交后：不涉及数据库事务；只做 UI 来源预览。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust 向调用方 `window.emit` 动态事件名（`tools/mod.rs:1141`）；TS 通过 `ctx.backendEvents.emit`（`host/plugins/mcp/index.ts` 注入的 `emitEvent`），由 F2 按 target 扇出。

## 事件 `{}-closed`

<!-- BEGIN GENERATED:event:fmt:{}-closed -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/stdio_proxy.rs:107`（emit）
<!-- END GENERATED:event:fmt:{}-closed -->

- [x] 载荷：`{}`（空对象，`stdio_proxy.rs:103-115`）。
- [x] 触发时机与顺序：stdio 读取任务退出并自动清理会话后发送；无论正常 EOF、读取错误还是 `mcp_stdio_close` 中止读取，都只发一次（`stdio_proxy.rs:88-115`）。
- [x] 节流/合并：无；每个 `mcp-stdio-<uuid>` 会话一次。
- [x] 是否在事务提交后：不涉及数据库事务；会话只在内存表 `STDIO_SESSIONS` 中。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust 向创建会话的 `window` emit；TS 用 `ctx.backendEvents.emit('<prefix>-closed', {})`（`host/plugins/mcp/src/stdio-proxy.ts:424`），F2 按 target 扇出。

## 事件 `{}-error`

<!-- BEGIN GENERATED:event:fmt:{}-error -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/stdio_proxy.rs:91`（emit）
<!-- END GENERATED:event:fmt:{}-error -->

- [x] 载荷：`{ error: string }`，`error` 为 transport 读取错误的 `Display` 文本；TS 在读取循环自然结束时复刻 Rust 的 `Transport error: Channel closed`（`stdio_proxy.rs:90-95`、`host/plugins/mcp/src/stdio-proxy.ts:420`）。
- [x] 触发时机与顺序：stdout 读取任务遇到 transport 错误时发送，随后自动清理会话并发 `{}-closed`；正常 EOF 走同一收尾路径（`stdio_proxy.rs:88-115`）。
- [x] 节流/合并：无；每个会话最多一条。
- [x] 是否在事务提交后：不涉及数据库事务；会话只在内存表。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust 向创建会话的 `window` emit；TS 用 `ctx.backendEvents.emit('<prefix>-error', { error })`，F2 按 target 扇出。

## 事件 `{}-message`

<!-- BEGIN GENERATED:event:fmt:{}-message -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/stdio_proxy.rs:85`（emit）
<!-- END GENERATED:event:fmt:{}-message -->

- [x] 载荷：`{ message: string }`，`message` 为子进程 stdout 的一帧原始 JSON-RPC 文本（JSONL 一行或 Content-Length 帧体，`stdio_proxy.rs:83-87`）。
- [x] 触发时机与顺序：读取到每一帧就发送；同一会话内保持 stdout 顺序；先于该会话的 `{}-error`/`{}-closed`（`stdio_proxy.rs:80-115`）。
- [x] 节流/合并：无；逐帧发送。
- [x] 是否在事务提交后：不涉及数据库事务；不解析、不改写消息。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust 向创建会话的 `window` emit；TS 用 `ctx.backendEvents.emit('<prefix>-message', { message })`（`host/plugins/mcp/src/stdio-proxy.ts:401,406`），F2 按 target 扇出。

## 事件 `McpEvent::Connected`

<!-- BEGIN GENERATED:event:expr:McpEvent::Connected -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/client.rs:966`（emit）
<!-- END GENERATED:event:expr:McpEvent::Connected -->

- [x] 载荷：无载荷（`McpEvent::Connected` 单元变体，`client.rs:832-841`）；TS 为 `{ type: 'Connected' }`（`host/plugins/mcp/src/probe.ts:104`）。
- [x] 触发时机与顺序：`McpClient::connect` 启动消息接收循环后立即 emit（`client.rs:966`）；TS `JsonRpcProbe.start()` 启动 `receiveLoop` 后 emit（`probe.ts:101-104`）。每个连接一次，先于 `ServerInfoReceived`。
- [x] 节流/合并：无；每次 `connect` 发一次。
- [x] 是否在事务提交后：不涉及数据库事务；不写库。
- [x] 目标窗口（emit / emit_to / emit_filter）：无 Tauri window emit；仅进程内 `EventEmitter` 订阅者（Rust `McpClient::on_event` / TS `JsonRpcProbe.onEvent`）。

## 事件 `McpEvent::Disconnected`

<!-- BEGIN GENERATED:event:expr:McpEvent::Disconnected -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/client.rs:976`（emit）
<!-- END GENERATED:event:expr:McpEvent::Disconnected -->

- [x] 载荷：无载荷（`McpEvent::Disconnected` 单元变体）；TS 为 `{ type: 'Disconnected' }`（`probe.ts:272`）。
- [x] 触发时机与顺序：`McpClient::disconnect` 先关闭消息循环与 transport，再 emit（`client.rs:976`）；TS `JsonRpcProbe.close()` 在 `transport.close()` 与 receiveTask 结束后 emit（`probe.ts:266-272`）。
- [x] 节流/合并：无；每次成功 `disconnect` 发一次。
- [x] 是否在事务提交后：不涉及数据库事务；不写库。
- [x] 目标窗口（emit / emit_to / emit_filter）：无 Tauri window emit；仅进程内 `EventEmitter` 订阅者。

## 事件 `McpEvent::PromptsChanged`

<!-- BEGIN GENERATED:event:expr:McpEvent::PromptsChanged -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/client.rs:1169`（emit）
<!-- END GENERATED:event:expr:McpEvent::PromptsChanged -->

- [x] 载荷：无载荷（单元变体）；TS 为 `{ type: 'PromptsChanged' }`（`client-dispatch.ts:174`）。
- [x] 触发时机与顺序：收到 `notifications/prompts/list_changed` 或兼容旧名 `prompts/list_changed` 时 emit（`client.rs:1169-1171`）；TS 在同一通知分支 emit（`client-dispatch.ts:172-175`）。
- [x] 节流/合并：无；每收到一条通知发一次。
- [x] 是否在事务提交后：不涉及数据库事务；不写库。
- [x] 目标窗口（emit / emit_to / emit_filter）：无 Tauri window emit；仅进程内 `EventEmitter` 订阅者。

## 事件 `McpEvent::ResourcesChanged`

<!-- BEGIN GENERATED:event:expr:McpEvent::ResourcesChanged -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/client.rs:1166`（emit）
<!-- END GENERATED:event:expr:McpEvent::ResourcesChanged -->

- [x] 载荷：无载荷（单元变体）；TS 为 `{ type: 'ResourcesChanged' }`（`client-dispatch.ts:170`）。
- [x] 触发时机与顺序：收到 `notifications/resources/list_changed` 或兼容旧名 `resources/list_changed` 时 emit（`client.rs:1165-1167`）；TS 在同一通知分支 emit（`client-dispatch.ts:166-171`）。
- [x] 节流/合并：无；每收到一条通知发一次。
- [x] 是否在事务提交后：不涉及数据库事务；不写库。
- [x] 目标窗口（emit / emit_to / emit_filter）：无 Tauri window emit；仅进程内 `EventEmitter` 订阅者。

## 事件 `McpEvent::RootsChanged`

<!-- BEGIN GENERATED:event:expr:McpEvent::RootsChanged -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/client.rs:1172`（emit）
<!-- END GENERATED:event:expr:McpEvent::RootsChanged -->

- [x] 载荷：无载荷（单元变体）；TS 为 `{ type: 'RootsChanged' }`（`client-dispatch.ts:178`）。
- [x] 触发时机与顺序：收到 `notifications/roots/list_changed` 或兼容旧名 `roots/list_changed` 时 emit（`client.rs:1172-1174`）；TS 在同一通知分支 emit（`client-dispatch.ts:176-179`）。
- [x] 节流/合并：无；每收到一条通知发一次。
- [x] 是否在事务提交后：不涉及数据库事务；不写库。
- [x] 目标窗口（emit / emit_to / emit_filter）：无 Tauri window emit；仅进程内 `EventEmitter` 订阅者。

## 事件 `McpEvent::ServerInfoReceived(server_info.clone())`

<!-- BEGIN GENERATED:event:expr:McpEvent::ServerInfoReceived(server_info.clone()) -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/client.rs:1267`（emit）
<!-- END GENERATED:event:expr:McpEvent::ServerInfoReceived(server_info.clone()) -->

- [x] 载荷：`ServerInfo { name, version, protocol_version, capabilities }`（`client.rs:115-120`）；`name`/`version` 取 `serverInfo`，缺失时分别为 `"unknown"`/`""`，`capabilities` 缺失时为 `{}`（`client.rs:1220-1268`）；TS 为 `{ type: 'ServerInfoReceived', server: ProbeServer }`（`probe.ts:172-176`）。
- [x] 触发时机与顺序：`initialize` 响应解析成功、写入 session 后 emit，随后 await 发送 `initialized`（`client.rs:1263-1274`）；TS 在 `initialize()` 中设置 `serverInfo` 后、`await notify('initialized')` 前 emit（`probe.ts:207-217`）。WP-184 按 D079 更正旧通知名描述。
- [x] 节流/合并：无；每次收到有效 initialize result 发一次，后续 initialized 发送失败也不撤回已发事件。
- [x] 是否在事务提交后：不涉及数据库事务；不写库。
- [x] 目标窗口（emit / emit_to / emit_filter）：无 Tauri window emit；仅进程内 `EventEmitter` 订阅者。

## 事件 `McpEvent::ToolsChanged`

<!-- BEGIN GENERATED:event:expr:McpEvent::ToolsChanged -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-mcp/src/mcp/client.rs:1129`（emit）
<!-- END GENERATED:event:expr:McpEvent::ToolsChanged -->

- [x] 载荷：无载荷（单元变体）；TS 为 `{ type: 'ToolsChanged' }`（`client-dispatch.ts:148`）。
- [x] 触发时机与顺序：收到 `notifications/tools/list_changed` 或兼容旧名 `tools/list_changed` 时 emit（`client.rs:1128-1130`）；TS `handleMcpMessage` 在同一分支 emit（`client-dispatch.ts:144-149`）。
- [x] 节流/合并：无；每收到一条通知发一次；`HostMcpService` 的订阅者据此清理 MCP 工具缓存。
- [x] 是否在事务提交后：不涉及数据库事务；只触发缓存清理。
- [x] 目标窗口（emit / emit_to / emit_filter）：无 Tauri window emit；仅进程内 `EventEmitter` 订阅者。
