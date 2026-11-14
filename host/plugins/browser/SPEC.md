# L19-mcp-browser 行为规格（`host/plugins/browser/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 38 个 · 发出事件 7 种 · 契约：`contracts/ipc/L19-mcp-browser.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：命令参数 `Option<T>` 接受 `null` 并按 Rust `None` 处理；`browser_get_state` 的 `Option<BrowserStateResult>` 无活跃会话时返回 `null`；`BrowserStateResult` 的 state 字段 flatten 后始终输出。cmd/browser.rs:193-210。
- [x] u64/i64 超过 2^53 的表示：surface bounds 的 `sequence` 与 RTT 用 u64；TS 以 `number` 承载并保持单调比较（`src/browser-service.ts:480-518`）；浏览器会话不产生超过 2^53 的 id/时间值。
- [x] 字段顺序（serde_json preserve_order）：`src-tauri/Cargo.toml:101` 启用 `preserve_order`；`BrowserStateResult` 先 flatten state、再 history、最后 agentAutomationSupported；TS `stateResult` 用同一插入顺序（`src/command-result.ts`）。
- [x] f32 精度：浏览器边界坐标是 `f64`，TS `number` 同为 IEEE-754 双精度；功能开关 `set_gradual` 在 Rust 侧转 f32，TS 保留双精度但落库值按同一 0..1 clamp（`src/feature-flags.ts:setGradualRollout`）。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：命令 `Err(String)` 经 `CommandError(string)`；`map_err` 前缀 NOT_FOUND/NAVIGATION_BLOCKED/GATES_CLOSED/BRIDGE_UNSUPPORTED/USER_TAKEOVER/DB_NOT_OPEN；Rust 无 panic 分支，TS 不抛裸错。cmd/browser.rs:25-71。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：导航用 pending attempt id 取消旧请求；网络探测用 `AbortSignal.timeout`；浏览器命令本身无 CancellationToken。service.rs:1200-1260、cmd/network.rs:55-62。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：浏览器是单一活跃 session + 串行 surface 操作；surface bounds 用单调 sequence 丢弃过期更新；DB 写走同一 F3 连接。service.rs:846-931、browser-service.ts:480-518。
- [x] 时间与 ID：生成方式、格式、时区：session id 为 `bs_<uuid>`；时间戳用 chrono AutoSi RFC3339（`+00:00`），事件 `at`、history visitedAt 同一格式；RTT 为毫秒整数。session.rs、time.ts。
- [x] 不对含 HashMap 的结构做序列化后比对：`get_feature_flags` 的 `flags_by_category` 在 Rust 是 HashMap（顺序不稳定），TS 用普通对象；测试只按 key 取值，不比较整个序列化字符串。

## 命令 `browser_back`

<!-- BEGIN GENERATED:cmd:browser_back -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:158` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string
  - 结果：BrowserStateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_back -->

- [x] 输入：`sessionId: string`；service 先 `assert_gates_open`，取消 pending 导航，要求 surface 存在且 `canGoBack`，否则 Validation；browser.rs:160-168、service.rs:back。
- [x] 输出：`BrowserStateResult`（state 字段 flatten + history + agentAutomationSupported）；browser.rs:88-99。
- [x] 错误：`map_err` 的 NOT_FOUND/NAVIGATION_BLOCKED/GATES_CLOSED 等前缀；`cannot go back` 走默认 Display `Validation error: cannot go back`；browser.rs:21-40。
- [x] 事件：成功后发 `browser:navigated`（sessionId/label/url/title/canGoBack/canGoForward/loading/at）；service.rs:persistHistoryNavigation。
- [x] DB 读写：upsert session 行，historyIndex 随后退更新；browser-service.ts:persistHistoryNavigation。
- [x] 取消/并发：取消该 session 的 pending navigation；surface 操作按单一 session 串行；service.rs:back。
- [x] 时间/ID：沿用既有 session id；事件 `at` 用当前 RFC3339；history visitedAt 由 service 的 now 生成。

## 命令 `browser_click`

<!-- BEGIN GENERATED:cmd:browser_click -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:390` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, ref: string
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_click -->

- [x] 输入：`sessionId`、`ref`；先 gates，再要求 bridge 支持与 session 存在；`ref` 原样交给桥（不在此命令校验格式）；browser.rs:392-406。
- [x] 输出：桥返回的原始 `Value`；browser.rs:402-405。
- [x] 错误：`map_bridge_err` 的 BRIDGE_UNSUPPORTED/BRIDGE_NOT_READY/BRIDGE_<code>/BRIDGE_TIMEOUT；browser.rs:42-71。
- [x] 事件：无；browser.rs:392-406。
- [x] DB 读写：无；只读内存 session 后调用桥。
- [x] 取消/并发：无取消点；桥调用有 10s 默认超时（bridge.rs:default_eval_timeout）；同一 session 串行。
- [x] 时间/ID：不生成时间/ID；browser.rs:392-406。

## 命令 `browser_close`

<!-- BEGIN GENERATED:cmd:browser_close -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:210` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_close -->

- [x] 输入：`sessionId?: string | null`；提供时必须等于当前活跃 session，否则 NOT_FOUND（无活跃也 NOT_FOUND）；省略则幂等关闭；browser.rs:212-232。
- [x] 输出：`null`；browser.rs:212-232。
- [x] 错误：`map_err`；销毁 content window 失败为 Validation `destroy content window failed`；browser.rs:21-40。
- [x] 事件：`browser:closed`（sessionId/label/reason/at）；service.rs:closeSessionInner。
- [x] DB 读写：`closeSessionRow` 标记会话关闭；失败仅 warn 不阻断关闭；browser-service.ts:closeSessionInner。
- [x] 取消/并发：清空 pending navigation/trusted input/surface sequence；单 session 串行；browser-service.ts:307-335。
- [x] 时间/ID：`closedAt`/事件 `at` 用当前 RFC3339；沿用既有 session id。

## 命令 `browser_content_user_input`

<!-- BEGIN GENERATED:cmd:browser_content_user_input -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:317` · sync
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, nonce: string, kind: string
  - 结果：null · 错误：string · 注入：webview, state
<!-- END GENERATED:cmd:browser_content_user_input -->

- [x] 输入：`sessionId`、`nonce`、`kind`；`webview.label()` 必须等于 `browser-content`；kind 仅 pointerdown/keydown/compositionstart/wheel；nonce 必须是当前 session 的 128-bit capability；browser.rs:319-334、service.rs:1009-1050。
- [x] 输出：`null`；browser.rs:319-334。
- [x] 错误：非 browser-content → `FORBIDDEN: trusted browser input requires browser-content Webview`；kind/nonce/session 不匹配 → `Validation error: trusted_content_input: ...`；browser.rs:325-332。
- [x] 事件：合法输入发 `browser:content-user-input`（sessionId/label/kind/at）；若原为 agent 态并转 user，还发 `browser:control-mode-changed`（reason=trusted_content_input）；service.rs:content_user_input。
- [x] DB 读写：无；只改内存控制态。
- [x] 取消/并发：capability 与 session 锁在状态转换期间保持，旧文档的延迟命令不能影响替换后的 Webview；service.rs:1005-1050。
- [x] 时间/ID：事件 `at` 用当前 RFC3339；nonce 为 16 字节 hex（32 字符）。

## 命令 `browser_focus`

<!-- BEGIN GENERATED:cmd:browser_focus -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:232` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_focus -->

- [x] 输入：`sessionId?: string | null`；先 gates；省略时取活跃 session，无活跃 → `NOT_FOUND: no active browser session`；browser.rs:234-250。
- [x] 输出：`null`；browser.rs:234-250。
- [x] 错误：`map_err`；detached 模式聚焦原生窗失败为 Validation，embedded 为 no-op，其他平台 `browser content focus unsupported on this platform`；service.rs:804-820。
- [x] 事件：无；service.rs:804-820。
- [x] DB 读写：无；service.rs:804-820。
- [x] 取消/并发：surface sequence 锁内执行；单 session 串行；service.rs:804-820。
- [x] 时间/ID：不生成时间/ID；browser.rs:234-250。

## 命令 `browser_forward`

<!-- BEGIN GENERATED:cmd:browser_forward -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:168` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string
  - 结果：BrowserStateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_forward -->

- [x] 输入：`sessionId`；gates + 取消 pending + 要求 surface 与 `canGoForward`；browser.rs:170-178、service.rs:forward。
- [x] 输出：`BrowserStateResult`；browser.rs:88-99。
- [x] 错误：`map_err`；`cannot go forward` 为 `Validation error: cannot go forward`；browser.rs:21-40。
- [x] 事件：`browser:navigated`；service.rs:persistHistoryNavigation。
- [x] DB 读写：upsert session 行，historyIndex 随前进更新；browser-service.ts:persistHistoryNavigation。
- [x] 取消/并发：取消 pending navigation；单 session 串行；service.rs:forward。
- [x] 时间/ID：事件 `at` 当前 RFC3339；history visitedAt 由 service now 生成。

## 命令 `browser_get_state`

<!-- BEGIN GENERATED:cmd:browser_get_state -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:191` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId?: string | null
  - 结果：BrowserStateResult | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_get_state -->

- [x] 输入：`sessionId?: string | null`；先 gates；提供 id 时 `get_state` 必须存在，否则 NOT_FOUND；省略时返回活跃 session；browser.rs:193-210。
- [x] 输出：`BrowserStateResult | null`；无活跃 session 且未提供 id 时为 null；browser.rs:200-207。
- [x] 错误：`map_err`；not found 为 `NOT_FOUND: ...`；gates 关闭为 `GATES_CLOSED: ...`；browser.rs:21-40。
- [x] 事件：无；只读内存状态。
- [x] DB 读写：无；`get_state` 只查内存 session。
- [x] 取消/并发：无取消点；单次读；browser.rs:193-210。
- [x] 时间/ID：不生成时间/ID；返回既有 createdAt/updatedAt。

## 命令 `browser_get_surface_host_mode`

<!-- BEGIN GENERATED:cmd:browser_get_surface_host_mode -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:310` · sync
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：string · 错误：string
<!-- END GENERATED:cmd:browser_get_surface_host_mode -->

- [x] 输入：无；browser.rs:311-313。
- [x] 输出：`surface_host_mode()` 字符串（embedded/detached/unsupported）；browser.rs:311-313、window.rs。
- [x] 错误：无；browser.rs:311-313。
- [x] 事件：无；browser.rs:311-313。
- [x] DB 读写：无；编译期平台常量。
- [x] 取消/并发：无；纯常量读取。
- [x] 时间/ID：不生成；browser.rs:311-313。

## 命令 `browser_list_downloads`

<!-- BEGIN GENERATED:cmd:browser_list_downloads -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:443` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string
  - 结果：BrowserDownloadObservation[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_list_downloads -->

- [x] 输入：`sessionId: string`；先 `assert_gates_open`，再 `get_state` 校验会话存在；browser.rs:443-451。
- [x] 输出：按插入顺序返回 `browserSessionId` 匹配的观察对象克隆；无匹配返回空数组；service.rs:1548-1557。
- [x] 错误：gates 未开或会话不存在时沿用 `map_err` 的 AppError 字符串；browser.rs:447-450。
- [x] 事件：无；browser.rs:443-451。
- [x] DB 读写：无，读内存 `downloads.observations`；service.rs:1548-1557。
- [x] 取消/并发：无取消点；同步锁内过滤，返回克隆；service.rs:1549-1556。
- [x] 时间/ID：不生成；直接返回既有 `startedAt/finishedAt`；service.rs:1548-1557。

## 命令 `browser_list_task_downloads`

<!-- BEGIN GENERATED:cmd:browser_list_task_downloads -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:454` · async
- 前端：app（1 处，例 `src/features/chat/api/taskWorkspaceApi.ts:46`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：chatSessionId: string
  - 结果：BrowserDownloadObservation[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_list_task_downloads -->

- [x] 输入：`chatSessionId: string`；只 `assert_gates_open`，不校验 browser session；browser.rs:454-461。
- [x] 输出：按插入顺序返回 `chatSessionId` 匹配的观察对象克隆；无匹配返回空数组；service.rs:1559-1568。
- [x] 错误：gates 未开时沿用 `map_err` 的 AppError 字符串；browser.rs:459。
- [x] 事件：无；browser.rs:454-461。
- [x] DB 读写：无，读内存 `downloads.observations`；service.rs:1559-1568。
- [x] 取消/并发：无取消点；同步锁内过滤，返回克隆；service.rs:1560-1567。
- [x] 时间/ID：不生成；直接返回既有 `startedAt/finishedAt`；service.rs:1559-1568。

## 内部模块：下载对象与文件落盘（`src/browser-service.ts`）

- [x] 输入：native `on_download_requested(url, originalName)`；会话归属由 `download_owner_for_session` 判定，`Err` 拒绝、`None` 放行给平台默认下载；service.rs:1316-1333、1914-1930。
- [x] 输出：`{allow,path}`；受控路径为 `<artifactRoot>/browser-downloads/<id[3..11]>-<sanitized name>`；观察对象含 `id/browserSessionId/chatSessionId/url/filename/state=started/rootId=artifacts/relativePath/locator/runtime://artifacts/.../startedAt/objectHandle`；service.rs:1341-1404。
- [x] 错误：artifact root 解析失败、目录创建失败、object handle 构建失败均 warn 后返回 false；任务预算耗尽 warn 后返回 false；hash 超过 64 MiB 时删除文件、状态 failed、error 原样保留；service.rs:1334-1345、1381-1387、1405-1427、1523-1545。
- [x] 日志：`[browser] failed to resolve download artifact root: <e>`、`[browser] failed to create download artifact directory: <e>`、`[browser] failed to build download object handle: <e>`、`[browser] rejecting download because task budget is exhausted: <chatSessionId>`；service.rs:1337/1343/1384/1412。
- [x] 事件：无新增事件；下载完成只更新观察对象，由既有命令读取；service.rs:1437-1545。
- [x] DB 读写：无；观察对象保存在内存 `downloads`，`by_path` 仅用于 native 回调匹配；service.rs:1405-1435。
- [x] 取消/并发：native 回调同步进入；hash 在独立 worker（Rust）对应同步有界读取，完成前状态 `processing`；预算按 `MAX_BROWSER_DOWNLOAD_BYTES` 预占、完成/失败释放；service.rs:1494-1545、1931-1942。
- [x] 时间/ID：`id=bd_<uuid>`；`startedAt/finishedAt` 为 chrono AutoSi `+00:00`；object handle `observedAt` 同格式；service.rs:1353、1379、1401、1460、1542。

## 内部服务：`llmWebSearchFallback`（`src/web-search-fallback.ts`，V01-05）

llm 的 `supports_tools=false` 降级注入（model2_pipeline.rs:6038-6073）读取此服务；对应 Rust `install_web_search_fallback` / `call_web_search_fallback`（dstu-mcp tools/mod.rs:630-700）。

- 输入：`{window, streamEvent, memoryEnabled, args:{query, top_k:3}}`；经 mcp `createWebSearchToolRegistry` 调 `web_search`，ToolContext 为 `supports_tools=false`、`stage="fallback"`、无 mcp client、无重排器。参数解析、空查询、15 s `tool timeout` 与 `!ok` 文案映射沿用 mcp 注册表。
- 引擎门禁（mod.rs:826-845）：`session.selected_search_engines` 缺失、读取失败或空白 → `{ok:false, error:'请在输入栏选择搜索引擎以启用外部搜索功能'}`，不发请求、不注入。
- 引擎路由（mod.rs:865-932）：选中多个引擎时只保留有有效 key 的；可用多于一个 → 聚合搜索；恰好一个 → 用它；一个都没有 → 默认引擎。只选一个 → 用它。
- 聚合搜索（mod.rs:1166-1383）：各引擎并发 `doSearch`；由 citation 重建条目（snippet 为 chunk_text 前两行以空格拼接）；全部失败或零结果 → `error` 为字符串，映射成 `web_search error`；CN 白名单开启时丢弃无 host 的 URL；按 URL 去重（先到者保留）、按 f32 分数稳定降序、截到 `reranker.top_k ?? top_k`、按 `normalize_score(i+1, top_k)`（f32）重打分；注入文本按 `build_inject_text` 的 aggregated 分支生成。
- 事件：成功、citation 非空且有调用窗口时发 `<streamEvent>_web_search`，`stage/sources[].stage='fallback'`，`score` 按 Rust f32 序列化（如 0.6666667）；无窗口不发（mod.rs:1122-1150）。
- 测试：`tests/web-search-fallback.test.ts`（8 条）；端到端请求体注入见 `host/plugins/llm/tests/web_search_fallback_injection.test.ts`。

## 命令 `browser_navigate`

<!-- BEGIN GENERATED:cmd:browser_navigate -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:134` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, url: string, replace?: boolean | null, fromAgent?: boolean | null
  - 结果：BrowserStateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_navigate -->

- [x] 输入：`sessionId`、`url`、`replace?`（默认 false）、`fromAgent?`（默认 false）；fromAgent=true 走 `navigate_from_agent`（私网/SSRF 硬拦 + agent 控制），否则用户导航；browser.rs:136-158。
- [x] 输出：`BrowserStateResult`；browser.rs:88-99。
- [x] 错误：`map_err`；URL 策略拒绝为 `NAVIGATION_BLOCKED: navigation_blocked: ...`；browser.rs:21-40、service.rs:checkNavigationUrl。
- [x] 事件：`browser:navigated`（成功后）；agent 首次导航还会发 `browser:control-mode-changed`；service.rs:navigate。
- [x] DB 读写：upsert session 行 + push history；失败仅 warn；browser-service.ts:navigateInner。
- [x] 取消/并发：取消同 session 的 pending navigation；surface navigate 以 attempt id 校验，过期结果丢弃；service.rs:navigate/applyPendingNavigation。
- [x] 时间/ID：session id 沿用；导航 attempt 用递增 id；事件 `at`/history visitedAt 当前 RFC3339。

## 命令 `browser_open_session`

<!-- BEGIN GENERATED:cmd:browser_open_session -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:109` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：url: string, displayName?: string | null, chatSessionId?: string | null, reuseExisting?: boolean | null, fromAgent?: boolean | null
  - 结果：BrowserStateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_open_session -->

- [x] 输入：`url`、`displayName?`、`chatSessionId?`、`reuseExisting?`（默认 true）、`fromAgent?`（默认 false）；service 先 gates + URL 策略 + agent automation 支持；browser.rs:111-134。
- [x] 输出：`BrowserStateResult`；browser.rs:88-99。
- [x] 错误：`map_err`；gates/URL/agent 不支持分别映射 GATES_CLOSED/NAVIGATION_BLOCKED/BRIDGE_UNSUPPORTED；browser.rs:21-40。
- [x] 事件：`browser:navigated`；fromAgent 时 set_agent_control 发 `browser:control-mode-changed`；service.rs:open_session。
- [x] DB 读写：upsert session 行 + push 首条 history；旧 session 先关闭；失败 warn；browser-service.ts:openSession。
- [x] 取消/并发：单一活跃 session；reuseExisting 复用并导航，否则关闭旧窗重建；waitForReady 后 attach；service.rs:open_session。
- [x] 时间/ID：session id `bs_<uuid>`；createdAt/updatedAt 当前 RFC3339；history visitedAt 当前时间。

## 命令 `browser_release_surface_focus`

<!-- BEGIN GENERATED:cmd:browser_release_surface_focus -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:250` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_release_surface_focus -->

- [x] 输入：`sessionId`；先 gates（cmd/browser.rs:252-262），再要求 live surface；browser.rs:252-262、service.rs:824-836。
- [x] 输出：`null`；browser.rs:252-262。
- [x] 错误：`map_err`；unsupported 平台/无 live session 为 Validation；browser.rs:21-40。
- [x] 事件：无；service.rs:824-836。
- [x] DB 读写：无；只把 native first responder 还给主 WebView。
- [x] 取消/并发：surface sequence 锁内执行；单 session 串行；service.rs:824-836。
- [x] 时间/ID：不生成；browser.rs:252-262。

## 命令 `browser_reload`

<!-- BEGIN GENERATED:cmd:browser_reload -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:178` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, hard?: boolean | null
  - 结果：BrowserStateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_reload -->

- [x] 输入：`sessionId`、`hard?`（Rust 显式忽略，平台统一 reload）；gates + URL 策略校验；browser.rs:180-191。
- [x] 输出：`BrowserStateResult`；browser.rs:88-99。
- [x] 错误：`map_err`；`cannot reload` 类 Validation 原样加前缀；browser.rs:21-40。
- [x] 事件：`browser:navigated`（loading=true）；service.rs:reload。
- [x] DB 读写：无（只改内存 loading/updatedAt）；service.rs:reload。
- [x] 取消/并发：取消 pending navigation；单 session 串行；service.rs:reload。
- [x] 时间/ID：`updatedAt`/事件 `at` 当前 RFC3339；沿用 session id。

## 命令 `browser_scroll`

<!-- BEGIN GENERATED:cmd:browser_scroll -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:464` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, direction?: string | null, amount?: integer(i32) | null, ref?: string | null
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_scroll -->

- [x] 输入：`sessionId`、`direction?`、`amount?`、`ref?`；gates + bridge 支持 + session 存在；opts 原样携带 null；browser.rs:466-490。
- [x] 输出：桥返回的原始 `Value`；browser.rs:483-486。
- [x] 错误：`map_bridge_err` 的 BRIDGE_* 前缀；browser.rs:42-71。
- [x] 事件：无；browser.rs:466-490。
- [x] DB 读写：无；只读 session。
- [x] 取消/并发：无取消点；桥调用 10s 超时；单 session 串行。
- [x] 时间/ID：不生成；browser.rs:466-490。

## 命令 `browser_set_input_files`

<!-- BEGIN GENERATED:cmd:browser_set_input_files -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:426` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, ref: string, files: Value
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_set_input_files -->

- [x] 输入：`sessionId`、`ref`、`files: Value`；gates + bridge 支持 + session 存在；files 形状由桥/执行器校验；browser.rs:428-443。
- [x] 输出：桥返回的原始 `Value`；browser.rs:440-442。
- [x] 错误：`map_bridge_err` 的 BRIDGE_* 前缀；browser.rs:42-71。
- [x] 事件：无；browser.rs:428-443。
- [x] DB 读写：无；只读 session。
- [x] 取消/并发：无取消点；桥调用 10s 超时；单 session 串行。
- [x] 时间/ID：不生成；browser.rs:428-443。

## 命令 `browser_set_surface_bounds`

<!-- BEGIN GENERATED:cmd:browser_set_surface_bounds -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:262` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number, occlusions?: SurfaceCssOcclusion[] | null, inputOcclusions?: SurfaceCssOcclusion[] | null, sequence: integer(u64)
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_set_surface_bounds -->

- [x] 输入：`sessionId`、x/y/width/height、viewportWidth/Height、occlusions?、inputOcclusions?、`sequence: u64`；先 gates；browser.rs:264-295。
- [x] 输出：`String`（`embedded`/`detached`）；browser.rs:279-287。
- [x] 错误：`map_err`；非有限/空/越界 frame 由 `physical_surface_bounds` 返回 Validation；browser.rs:21-40、service.rs:846-931。
- [x] 事件：无；service.rs:846-931。
- [x] DB 读写：无；只更新 native surface 几何。
- [x] 取消/并发：每 session 单调 `sequence`，`sequence <= last` 的过期更新直接返回 `embedded`；surface sequence 锁内执行；service.rs:858-931。
- [x] 时间/ID：不生成时间；sequence 由调用方单调递增。

## 命令 `browser_set_surface_visibility`

<!-- BEGIN GENERATED:cmd:browser_set_surface_visibility -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:295` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, visible: boolean, focus?: boolean | null
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_set_surface_visibility -->

- [x] 输入：`sessionId`、`visible`、`focus?`（默认 false）；先 gates；browser.rs:297-309。
- [x] 输出：`String` host mode（embedded/detached/unsupported）；browser.rs:303-307。
- [x] 错误：`map_err`；无 live session 为 Validation；browser.rs:21-40、service.rs:set_surface_visibility。
- [x] 事件：无；service.rs:set_surface_visibility。
- [x] DB 读写：无；只切 native surface 可见性。
- [x] 取消/并发：surface 操作串行；无取消点。
- [x] 时间/ID：不生成；browser.rs:297-309。

## 命令 `browser_snapshot`

<!-- BEGIN GENERATED:cmd:browser_snapshot -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:357` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, maxChars?: integer(u32) | null
  - 结果：BrowserSnapshotResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_snapshot -->

- [x] 输入：`sessionId`、`maxChars?`；先 gates + bridge 支持 + session 存在；opts `{interactiveOnly:true}`，有 maxChars 时附加；browser.rs:359-390。
- [x] 输出：`BrowserSnapshotResult`（sessionId/url/title/snapshot）；snapshot 优先取桥 `text`，再 `snapshot`，否则 JSON 字符串；browser.rs:368-372。
- [x] 错误：`map_err`/`map_bridge_err`；BRIDGE_UNSUPPORTED/BRIDGE_NOT_READY/BRIDGE_TIMEOUT；browser.rs:25-71。
- [x] 事件：无；browser.rs:359-390。
- [x] DB 读写：无；只读 session。
- [x] 取消/并发：无取消点；桥调用 10s 超时；单 session 串行。
- [x] 时间/ID：不生成时间/ID；沿用 session id。

## 命令 `browser_take_over`

<!-- BEGIN GENERATED:cmd:browser_take_over -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:335` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：BrowserStateResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_take_over -->

- [x] 输入：无参数；先 gates；要求活跃 session；browser.rs:336-357。
- [x] 输出：`BrowserStateResult`；browser.rs:88-99。
- [x] 错误：`map_err`；无活跃 session → `NOT_FOUND: no active browser session`（service 的 NotFound）；browser.rs:21-40。
- [x] 事件：`browser:control-mode-changed`（controlMode=user，reason=user_takeover）；service.rs:emit_take_over。
- [x] DB 读写：无；只改内存 controlMode 并清 agent 私网 guard；service.rs:take_over_with_reason_locked。
- [x] 取消/并发：session 锁内切换；单 session 串行。
- [x] 时间/ID：updatedAt/事件 `at` 当前 RFC3339；沿用 session id。

## 命令 `browser_type`

<!-- BEGIN GENERATED:cmd:browser_type -->
- Rust：`src-tauri/crates/dstu-browser/src/cmd/browser.rs:406` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：sessionId: string, ref: string, text: string, submit?: boolean | null
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:browser_type -->

- [x] 输入：`sessionId`、`ref`、`text`、`submit?`（Rust 显式忽略，桥默认 clear）；gates + bridge 支持 + session 存在；browser.rs:408-426。
- [x] 输出：桥返回的原始 `Value`；browser.rs:420-424。
- [x] 错误：`map_bridge_err`；密码框返回 `BRIDGE_PASSWORD_FIELD: ...`；browser.rs:42-71。
- [x] 事件：无；browser.rs:408-426。
- [x] DB 读写：无；只读 session。
- [x] 取消/并发：无取消点；桥调用 10s 超时；单 session 串行。
- [x] 时间/ID：不生成；browser.rs:408-426。

## 命令 `delete_setting`

<!-- BEGIN GENERATED:cmd:delete_setting -->
- Rust：`src-tauri/src/cmd/web_search.rs:572` · async
- 前端：app（2 处，例 `src/features/chat/skills/builtinStorage.ts:177`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：key: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:delete_setting -->

- [x] 输入：key 原样、大小写敏感禁止 internal.oauth. 前缀；web_search.rs:15,573。
- [x] 输出：delete_secret 的 bool（实际是否删除）；web_search.rs:576。
- [x] 错误：Configuration 拒绝内部键；Database + 删除设置失败前缀；details=null；web_search.rs:20,577。
- [x] 事件：无；web_search.rs:573-578。
- [x] DB 读写：F4 deleteSecret，敏感键路由同 Rust；web_search.rs:576。
- [x] 取消/并发：无取消点，不因窗口离开取消；web_search.rs:573-578。
- [x] 时间/ID：不生成；web_search.rs:573-578。

## 命令 `delete_settings_by_prefix`

<!-- BEGIN GENERATED:cmd:delete_settings_by_prefix -->
- Rust：`src-tauri/src/cmd/web_search.rs:593` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：prefix: string
  - 结果：integer(usize) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:delete_settings_by_prefix -->

- [x] 输入：prefix 与 internal.oauth. 双向前缀检查，空串亦拒绝；web_search.rs:27,594。
- [x] 输出：删除行数 usize；web_search.rs:600。
- [x] 错误：Configuration 或 Database + 按前缀批量删除设置失败；details=null；web_search.rs:32,601。
- [x] 事件：无；web_search.rs:594-602。
- [x] DB 读写：F4 deleteByPrefix，LIKE prefix%，不走 secret；web_search.rs:600。
- [x] 取消/并发：无取消点，单次同步删除；web_search.rs:594-602。
- [x] 时间/ID：不生成；web_search.rs:594-602。

## 命令 `detect_tool_conflicts`

<!-- BEGIN GENERATED:cmd:detect_tool_conflicts -->
- Rust：`src-tauri/src/cmd/web_search.rs:284` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：ToolConflict[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:detect_tool_conflicts -->

- [x] 输入：无；web_search.rs:285。
- [x] 输出：Rust 明确返回空列表，后端 MCP 禁用、前端 SDK 负责冲突；web_search.rs:286-287。
- [x] 错误：无 Err 分支；web_search.rs:285-288。
- [x] 事件：无；web_search.rs:285-288。
- [x] DB 读写：无；web_search.rs:285-288。
- [x] 取消/并发：无；web_search.rs:285-288。
- [x] 时间/ID：无；web_search.rs:285-288。

## 命令 `get_cn_whitelist_config`

<!-- BEGIN GENERATED:cmd:get_cn_whitelist_config -->
- Rust：`src-tauri/src/cmd/web_search.rs:235` · async
- 前端：app（1 处，例 `src/components/WebSearchAdvancedConfig.tsx:119`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_cn_whitelist_config -->

- [x] 输入：无；web_search.rs:236-284。
- [x] 输出：`{default_sites, user_config:{enabled,use_default_list,custom_sites}}`；enabled 默认 false、use_default 默认 true；custom_sites 先尝试 JSON 数组，失败按逗号分隔；web_search.rs:241-278。
- [x] 错误：读库错误被 `unwrap_or(None)` 吞掉，命令无 Err 分支；web_search.rs:241-260。
- [x] 事件：无；web_search.rs:236-284。
- [x] DB 读写：读 3 个 settings 键；无写；web_search.rs:241-253。
- [x] 取消/并发：无取消点；单次读；web_search.rs:236-284。
- [x] 时间/ID：不生成；web_search.rs:236-284。

## 命令 `get_feature_flags`

<!-- BEGIN GENERATED:cmd:get_feature_flags -->
- Rust：`src-tauri/src/cmd/web_search.rs:363` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_feature_flags -->

- [x] 输入：无；web_search.rs:364-396。
- [x] 输出：`{flags, flags_by_category, total_count}`；分类用 HashMap 聚合，顺序不稳定；web_search.rs:380-394。
- [x] 错误：加载失败 → `AppError` 文案 `加载功能开关失败: ...`；web_search.rs:370-376。
- [x] 事件：无；web_search.rs:364-396。
- [x] DB 读写：经 F3 `ctx.featureFlags.load` 读 `feature_flags.config`（缺失则初始化默认 flags，不写库）；host/plugins/browser/index.ts、browser/src/feature-flags.ts:featureFlagsResult。
- [x] 取消/并发：无取消点；单次加载；web_search.rs:364-396。
- [x] 时间/ID：flag 的 created_at/updated_at 由 F3 规则维护；本命令不生成。

## 命令 `get_provider_strategies_config`

<!-- BEGIN GENERATED:cmd:get_provider_strategies_config -->
- Rust：`src-tauri/src/cmd/web_search.rs:318` · async
- 前端：app（1 处，例 `src/features/settings/components/EngineSettingsSection.tsx:105`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_provider_strategies_config -->

- [x] 输入：无；web_search.rs:319-343。
- [x] 输出：`{provider_strategies, config_keys:{provider_strategies}}`；JSON 解析失败回默认策略；web_search.rs:325-343。
- [x] 错误：读库/解析错误被 `unwrap_or(None)`/`unwrap_or_default` 吞掉，无 Err；web_search.rs:325-334。
- [x] 事件：无；web_search.rs:319-343。
- [x] DB 读写：读 `web_search.provider_strategies`；无写；web_search.rs:325-329。
- [x] 取消/并发：无取消点；web_search.rs:319-343。
- [x] 时间/ID：不生成；web_search.rs:319-343。

## 命令 `get_security_status`

<!-- BEGIN GENERATED:cmd:get_security_status -->
- Rust：`src-tauri/src/cmd/web_search.rs:210` · async
- 前端：app（1 处，例 `src/components/SecurityStatusIndicator.tsx:44`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_security_status -->

- [x] 输入：无；web_search.rs:211。
- [x] 输出：固定 disabled keychain/迁移完成、0/null 及原文 warnings/patterns；web_search.rs:212-231。这是 Rust 现有业务返回值。
- [x] 错误：无 Err 分支；web_search.rs:211-233。
- [x] 事件：无；web_search.rs:211-233。
- [x] DB 读写：无；web_search.rs:211-233。
- [x] 取消/并发：无；web_search.rs:211-233。
- [x] 时间/ID：UTC RFC3339 +00:00，毫秒精度同平台已裁定限制；web_search.rs:231。

## 命令 `get_setting`

<!-- BEGIN GENERATED:cmd:get_setting -->
- Rust：`src-tauri/src/cmd/web_search.rs:562` · async
- 前端：app（50 处，例 `src/app/hooks/usePlatformSettingsSync.ts:50`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：key: string
  - 结果：string | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_setting -->

- [x] 输入：key 原样，internal.oauth. 大小写敏感拒绝；web_search.rs:15,563。
- [x] 输出：string 或 null（无值）；web_search.rs:563,567。
- [x] 错误：Configuration 或 Database + 读取设置失败前缀，details=null；web_search.rs:20,568。
- [x] 事件：无；web_search.rs:563-569。
- [x] DB 读写：F4 getSecret，敏感键读取/迁移语义委托 F4；web_search.rs:567。
- [x] 取消/并发：无取消点，F4 secret 操作串行；web_search.rs:563-569。
- [x] 时间/ID：不生成；web_search.rs:563-569。

## 命令 `get_settings_by_prefix`

<!-- BEGIN GENERATED:cmd:get_settings_by_prefix -->
- Rust：`src-tauri/src/cmd/web_search.rs:581` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-tools/useToolPermissions.tsx:123`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：prefix: string
  - 结果：?[][] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_settings_by_prefix -->

- [x] 输入：prefix 与 internal.oauth. 双向前缀检查；web_search.rs:27,582。
- [x] 输出：三元组 [key,value,updated_at][]，保持仓储倒序；web_search.rs:585。
- [x] 错误：Configuration 或 Database + 按前缀查询设置失败，details=null；web_search.rs:32,589。
- [x] 事件：无；web_search.rs:582-590。
- [x] DB 读写：F4 listByPrefix，LIKE prefix%，不解密 secret；web_search.rs:588。
- [x] 取消/并发：无取消点；web_search.rs:582-590。
- [x] 时间/ID：原样返回 F4 存储时间；web_search.rs:585。

## 命令 `get_tools_namespace_config`

<!-- BEGIN GENERATED:cmd:get_tools_namespace_config -->
- Rust：`src-tauri/src/cmd/web_search.rs:291` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_tools_namespace_config -->

- [x] 输入：无；web_search.rs:292。
- [x] 输出：namespace_prefix=null、conflict_resolution=use_local 默认；原值不 trim；3 个原文选项与 config_keys；web_search.rs:295-314。
- [x] 错误：读取错误吞为 None；web_search.rs:295-300。
- [x] 事件：无；web_search.rs:292-315。
- [x] DB 读写：F4 get 两个非敏感 key；web_search.rs:295-298。
- [x] 取消/并发：无取消点；web_search.rs:292-315。
- [x] 时间/ID：无；web_search.rs:292-315。

## 命令 `is_feature_enabled`

<!-- BEGIN GENERATED:cmd:is_feature_enabled -->
- Rust：`src-tauri/src/cmd/web_search.rs:454` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：featureName: string, userId?: string | null
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:is_feature_enabled -->

- [x] 输入：`featureName`、`userId?`；userId 存在时注入 manager；web_search.rs:455-477。
- [x] 输出：`boolean`；未知 flag 为 false；web_search.rs:476。
- [x] 错误：加载失败 → `AppError` 文案 `加载功能开关失败: ...`；web_search.rs:468-474。
- [x] 事件：无；web_search.rs:455-477。
- [x] DB 读写：经 F3 `ctx.featureFlags.load` 读 `feature_flags.config`；无写；host/plugins/browser/index.ts、browser/src/feature-flags.ts。
- [x] 取消/并发：无取消点；单次读。
- [x] 时间/ID：不生成；web_search.rs:455-477。

## 命令 `save_provider_strategies_config`

### v2 自查 L19-V2-02

- Rust入口 `src/cmd/web_search.rs:345-359` → TS `index.ts` 注册处理器。
- 分支：kernel先按ProviderStrategies契约解码；归一化后序列化保存；保存错误返回
  `AppError.from("保存Provider策略失败: …")`；成功保存**之后**记录info `Provider策略配置已保存`再返回true。
- 数据边界：default必填/Option省略与null/SpecialHandling两个必填bool/未知字段忽略，见mcp SPEC同finding。
- 所有权：F4 `ctx.settings.save`；无跨表SQL/额外事务。无时钟/取消/平台路径。
- 生产入口测试：`tests/search-commands.test.ts` 经kernel invoke断言完整保存形状及成功info；
  失败分支应保持原AppError且不记录成功日志。证据等级：生产入口测试+Rust审读；待独立v2复验。

<!-- BEGIN GENERATED:cmd:save_provider_strategies_config -->
- Rust：`src-tauri/src/cmd/web_search.rs:344` · async
- 前端：app（1 处，例 `src/features/settings/components/EngineSettingsSection.tsx:182`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：strategies: ProviderStrategies
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_provider_strategies_config -->

- [x] 输入：`strategies: ProviderStrategies`；web_search.rs:345-362。
- [x] 输出：`true`；web_search.rs:361-362。
- [x] 错误：序列化失败 → `序列化Provider策略失败: ...`；保存失败 → `保存Provider策略失败: ...`（AppError::from）；web_search.rs:349-359。
- [x] 事件：无；成功记 info `Provider策略配置已保存`；web_search.rs:360。
- [x] DB 读写：写 `web_search.provider_strategies`；web_search.rs:352-358。
- [x] 取消/并发：无取消点；单次写；web_search.rs:345-362。
- [x] 时间/ID：不生成；web_search.rs:345-362。

## 命令 `save_setting`

<!-- BEGIN GENERATED:cmd:save_setting -->
- Rust：`src-tauri/src/cmd/web_search.rs:541` · async
- 前端：app（17 处，例 `src/components/WebSearchAdvancedConfig.tsx:239`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：key: string, value: string
  - 结果：boolean · 错误：AppError · 注入：state, app-handle
<!-- END GENERATED:cmd:save_setting -->

- [x] 输入：key/value 原样；internal.oauth. 拒绝；web_search.rs:542-548。
- [x] 输出：true；web_search.rs:558。
- [x] 错误：Configuration 或 Database + 保存设置失败，details=null；web_search.rs:20,552。
- [x] 事件：无；浏览器服务存在且 key 为网络模式时同步 live policy；web_search.rs:553-556。
- [x] DB 读写：F4 saveSecret，敏感键自动安全存储；web_search.rs:551。
- [x] 取消/并发：无取消点，F4 secret 操作串行；web_search.rs:542-559。
- [x] 时间/ID：由 F4 保存 updated_at；web_search.rs:551。

## 命令 `test_all_search_engines`

<!-- BEGIN GENERATED:cmd:test_all_search_engines -->
- Rust：`src-tauri/src/cmd/web_search.rs:87` · async
- 前端：app（1 处，例 `src/utils/settingsApi.ts:229`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_all_search_engines -->

- [x] 输入：无；web_search.rs:88-209。
- [x] 输出：`{results, summary:{total,configured,success,failed}, timestamp}`；9 个引擎固定顺序，未配置记 `not_configured`、elapsed_ms=0；web_search.rs:110-202。
- [x] 错误：配置加载失败 → `AppError::internal("配置加载失败: ...")`；单个引擎失败记入 results 的 failed；web_search.rs:95-101、160-171。
- [x] 事件：无；web_search.rs:88-209。
- [x] DB 读写：读 search 配置/密钥（apply_db_overrides）；无写；web_search.rs:95-101。
- [x] 取消/并发：按引擎顺序串行执行，无取消点；web_search.rs:110-190。
- [x] 时间/ID：每个引擎 elapsed_ms 为毫秒；timestamp 为 `Utc::now().to_rfc3339()`（+00:00）；web_search.rs:199。

## 命令 `test_search_engine`

<!-- BEGIN GENERATED:cmd:test_search_engine -->
- Rust：`src-tauri/src/cmd/web_search.rs:478` · async
- 前端：app（2 处，例 `src/components/SearchEngineStatus.tsx:58`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：engine: string
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_search_engine -->

- [x] 输入：`engine: string`；web_search.rs:479-540。
- [x] 输出：成功 `{ok:true,message,response_time,test_query}`；失败 `{ok:false,message,response_time,test_query,error_details}`；web_search.rs:518-539。
- [x] 错误：工具调用结果以 Value 返回，命令本身不抛 Err；error_details 为 `未知错误` 兜底；web_search.rs:528-538。
- [x] 事件：无；web_search.rs:479-540。
- [x] DB 读写：工具上下文带 db，仅读搜索配置；无写；web_search.rs:495-505。
- [x] 本地 registry 路径：`createWebSearchToolRegistry(...).callTool('web_search', ...)`，共享 MCP registry 的本地分支；tools/mod.rs:338-360。
- [x] 取消/并发：registry 15 秒超时返回 `tool timeout`，并通过 AbortSignal 取消 HTTP、重试、semaphore/rate 等待（对应 Rust timeout 丢弃 future）；不是直接等待 doSearch 的 provider 超时。
- [x] 时间/ID：response_time 为毫秒；test_query 固定 `AI artificial intelligence`；web_search.rs:487、513。

### v2 分支核验（L19-V2-09，候选，未独立签收）

| Rust 分支 | TS 落点 / 证据 |
|---|---|
| cmd/web_search.rs:485-512：固定 query、num_results=3、force_engine；stage=test | browser/index.ts test_search_engine；MCP registry 仅识别 top_k，因此 num_results 不覆盖默认 5；生产请求 body 断言 max_results=5 |
| tools/mod.rs:338-360：本地工具超时/正常返回/缺 usage | mcp/src/service.ts McpToolRegistry.callTool → callLocalWebSearchTool；15 秒超时取消同一个请求；缺 usage 填 elapsed_ms |
| tools/mod.rs:1083-1102：失败取 error.message，缺失用 web_search error；无 citations/inject | invokeWebSearch；不再 JSON.stringify 整个 error 对象；client.test.ts 走真实 doSearch 的未知引擎错误 |
| cmd/web_search.rs:516-538：成功/失败响应 | browser/index.ts 按 tuple ok/error 生成原形状，error 为 null 时用 未知错误 |
| tools/mod.rs:931-1079：配置启用 reranker 且 llm_manager/model_id 可用 | **pending**：L02 还没有正式 rerank API；见 mcp/BLOCKERS.md。此单元只修 registry/超时/错误映射，不宣称完整 WebSearchTool 等价 |

- 所有权：仅读 F4 settings/secrets；不写任何表。命令本身无日志；WebSearchTool 的完整日志映射仍在 LP 清单。
- 证据：search-commands.test.ts 的 kernel 命令入口测试覆盖超时、底层 abort、随后重新请求成功（并发名额释放）；既有成功和 provider 错误断言保留。

### 工具 `index_status`：L19-V2-10 摘要消费（候选，未独立签收）

| Rust 入口/分支 | TS 生产路径 |
|---|---|
| index_webpage_executor.rs:70-81：校验参数后读取全局 summary，失败 `INDEX_STATUS_FAILED` | browser/index.ts 注册 IndexWebpageToolExecutor；executeStatus → L12 公开 `vfsIndex.getStatusSummary()`；错误在资源查找之前映射 |
| :83-100：未指定资源时返回 scope=all、summary、空 units、总页内 totalUnits=0 | executeStatus 的 resourceId===null 分支；summary.totalUnits 与页内 totalUnits 不混淆 |
| :103-183：指定资源时继续读取资源状态与分页，仍包含 summary | executeStatus 资源分支，同一 L12 摘要，camelCase typed projection，无复制实现 |

- 边界/所有权：只消费 L12 `VfsIndexStatusSummary`，包括 totalUnits、textStats/mmStats 的 5 个状态、dimensions 的 dimension/modality/count；查询及数据库错误由 owner 提供，无自写统计 SQL。大数 D3 属原开放项，不在此签完整整数等价。
- 测试：`index-status-wiring.test.ts` 经真实插件安装和 agentTools 生产注册入口；Rust 原 VFS 用例的 9 条 assert 均有对应。preflight 在真实资源校验通过后取消，明确不触发 LLM/Lance/窗口重建。
- 生命周期：无本 lane 新增锁/事务/后台任务；服务缺失仅报启动期不可用。真实连接关闭的错误映射与优先顺序已测。

### 工具 `browser_screenshot`：L19-V2-12 原始能力契约（候选待复核）

- Rust browser_executor.rs:997-1019 → BrowserToolExecutor.executeScreenshot：无会话返回 `[BROWSER_NO_SESSION] 浏览器未打开`；有会话返回原固定 capability payload。
- `available:false`、`reasonCode:PLATFORM_API_UNAVAILABLE`、`object_handle:null`，reason 必须为 `当前 Tauri/Wry 平台未提供嵌入式 WebView 可见区域截图接口`，带原 session_id/url；不是“原生接口缺失时的临时 stub”。
- 不调用原生截图/DOM snapshot，不生成图片或 object handle，无新数据库/事务/后台任务。测试经生产 execute 验证完整形状和不发生额外 snapshot 调用；实机像素能力不在本次迁移等价声明内。

### 工具 `browser_file_upload`：L19-V2-05 上传哈希调度补正（候选待复核）

- Rust browser_executor.rs:771-786 → BrowserToolExecutor.executeFileUpload：先读取已授权文件，累计 bytes，超出 16 MiB 则报原 BROWSER_FILE_TOO_LARGE；通过后计算 SHA-256，再构建对象句柄/桥 payload。
- Host 文件读取和文件 SHA-256 均异步：`fs/promises.readFile` + Node WebCrypto `subtle.digest`，返回同样小写 hex。不引入新的业务限额、不伪造结果、不改文件读取错误和错误顺序。
- 证据：tool-executor-execute.test.ts 通过真实 L05 runtimeRoots 进行授权和上传，保留 name/mime/base64/sha256/object_handle/权限边界原断言，观察未替换的原生 digest 两次调用及原始字节。
- 此项不是整个文件 IO/下载 worker/取消审计的完成声明，剩余范围见 LANE 的 L19-V2-05。

### 下载哈希：L19-V2-05 专用 worker 分支（候选待复核）

| Rust service.rs | Host |
|---|---|
| :1499-1505 dedicated browser-download-hash thread | service.ts 启动 download-hash-worker.ts；worker 调同一 download-hash.ts 核心，parent 结果解码并等待 exit |
| :1496/1503 Weak service | browser-service.ts 仅在 weak.deref() 成功时 warn/finish，不由异步 hash 回调强持服务 |
| :1508-1510 spawn 失败 warn + inline hash + finish | constructor catch 记录原 `[browser] download hash worker unavailable; hashing inline: ...`，同步核心结果同步 finish；Node error/exit 失败也日志化 settle |
| :1945-1964 文件 open/read 错误、64 KiB 缓冲、字节上限、hex digest | download-hash.ts；所有读取结果/超限返回均经过 finally 关闭文件；丢弃 close 错误对应 File::drop |

- 无新业务上限、timeout 或 worker pool；每次下载一线程对应原实现。正常结果字段和 processing→completed/failed、任务预算回收、超限文件清理保持原路径。
- 测试：service.test.ts 观察真实原生 worker 且 warn 为空，下载错误与 hash/size 原断言保留；browser-service.test.ts / download-wiring.test.ts 验证生产回写及插件接线。启动资源耗尽、Electron 打包与 Windows 实机情况未验证，明确不以本地测试签收这些路径。

## 命令 `test_web_search_connectivity`

<!-- BEGIN GENERATED:cmd:test_web_search_connectivity -->
- Rust：`src-tauri/src/cmd/web_search.rs:43` · async
- 前端：app（1 处，例 `src/utils/settingsApi.ts:185`）
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：engine?: string | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_web_search_connectivity -->

### WP-154：桌面生产入口订正

- 定义层：`src-tauri/src/cmd/web_search.rs:43-85` 定义该函数，无函数级 cfg；
  `cmd/mod.rs:25` 无条件声明模块，`commands.rs:54` 通配重导出。函数体的配置加载、搜索和
  `{success, usage/detail}` 只描述内部函数，不代表 WebView 能调用它。
- 注册层：完整审读 `src-tauri/src/lib.rs:1908-3182` 的唯一 `generate_handler!`，未列该函数。
  宏内 cfg 仅涉及 :2267 的 devtools 和 :2293-2302 的 MCP OAuth；无桌面/feature 分支注册本命令。
  已注册搜索命令为 :2041 `test_search_engine`、:2303 `test_all_search_engines`。
  `permissions/application-commands.toml:859,868` 允许这两个搜索命令，没有 connectivity 名称。
  `build.rs:53-58,217-246` 启用 app ACL 并要求 allow 与注册集合相等。
- 前端层：`src/utils/settingsApi.ts:183-191` 仍有 `testWebSearchConnectivity` 包装，:185 发送
  `{engine: engine || null}`，:187-189 捕获/包装拒绝；全 src 检索未发现其他直接调用或该包装的消费者。
  此包装存在不能作为 Rust 已注册的证据。
- 线上行为：Tauri 2.11.5 `src/webview/mod.rs:1819-1851` 在入参解码前拒绝；
  `src/ipc/authority.rs:403-405,431-432` 生成 debug 字符串
  `test_web_search_connectivity not allowed. Command not found`；release 字符串为
  `Command test_web_search_connectivity not allowed by ACL`。两者均不是 AppError 对象。
- TS：只移除 `index.ts` 的 meta 命令名和 register 闭包，复用已在 main 的 kernel not-found/ACL 路径。
  `webSearch` 服务、doSearch 实现和其他搜索消费者保留；此入口不读取设置、不发请求、不发日志/事件。
- 回归：`tests/search-commands.test.ts` 保留测试先行提交的 debug/release/真实 ACL、零 fetch、
  test_all_search_engines 可用断言；新增真实 node:http provider，经官方 browser 插件和 Host invoke
  验证未注册/错误参数均先拒绝、零请求，以及 test_search_engine 正常发请求并返回成功。
- 原 Rust 没有本命令的专属测试；本包属于生产注册纠偏和新增入口回归，不增改 TESTMAP 去向，
  不申请 obsolete/dead-proven，也不更改契约或统计分母。未执行 Rust/Electron 实机差分。

## 命令 `update_feature_flag`

<!-- BEGIN GENERATED:cmd:update_feature_flag -->
- Rust：`src-tauri/src/cmd/web_search.rs:397` · async
- 前端：none
- 契约：`contracts/ipc/L19-mcp-browser.json`
  - 参数：featureName: string, action: string, value?: Value | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:update_feature_flag -->

- [x] 输入：`featureName`、`action`（enable/disable/set_gradual）、`value?`；set_gradual 要求 number（Rust as_f64 后转 f32）；web_search.rs:398-453。
- [x] 输出：`{success:true, message}`，message 按 action 用启用/禁用/设置渐进发布；web_search.rs:444-452。
- [x] 错误：加载/启用/禁用/保存失败 → `AppError`，文案分别为 `加载功能开关失败: ...`、`启用功能失败: ...` 等；未知 action → `不支持的操作: ...`；web_search.rs:412-443。
- [x] 事件：无；web_search.rs:398-453。
- [x] DB 读写：经 F3 `ctx.featureFlags.load/save` 读后写 `feature_flags.config`；web_search.rs:409-441。
- [x] 取消/并发：无取消点；单次读改写；web_search.rs:398-453。
- [x] 时间/ID：flag updated_at 由 manager 的 timestamp 更新（本地时间 `YYYY-MM-DD HH:MM:SS`）；web_search.rs:408-441、feature-flags.ts:timestamp。

## 事件 `browser:closed`

<!-- BEGIN GENERATED:event:browser:closed -->
- 事件名 `browser:closed`，常量 `EVT_CLOSED`
- 发送点：`src-tauri/crates/dstu-browser/src/browser/events.rs:108`（emit）
<!-- END GENERATED:event:browser:closed -->

- [x] 载荷：`{ sessionId, label, reason, at }`（camelCase，`events.rs:48-56`）；TS 在 `closeSessionInner` 发送同一形状（`browser-service.ts:330-332`）。
- [x] 触发时机与顺序：关闭会话并销毁 content window 后发送；`browser_close`、gates 关闭清理、reuse 替换旧 session 都会触发；销毁失败时仍先发事件再抛 Validation（`browser-service.ts:311-334`）。
- [x] 节流/合并：无；每次会话关闭发一次。
- [x] 是否在事务提交后：不涉及事务；先尝试 `closeSessionRow` 标记关闭，失败只 warn，事件照发。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app.emit` 广播（`events.rs:107-111`）；TS 通过 `ctx.backendEvents.emit`（`index.ts` 注入），F2 按 target 扇出。

## 事件 `browser:content-user-input`

<!-- BEGIN GENERATED:event:browser:content-user-input -->
- 事件名 `browser:content-user-input`，常量 `EVT_CONTENT_USER_INPUT`
- 发送点：`src-tauri/crates/dstu-browser/src/browser/events.rs:126`（emit）
<!-- END GENERATED:event:browser:content-user-input -->

- [x] 载荷：`{ sessionId, label, kind, at }`（camelCase，`events.rs:78-84`）；`kind` 仅 pointerdown/keydown/compositionstart/wheel（`browser-service.ts:558-567`）。
- [x] 触发时机与顺序：nonce 与 session capability 校验通过后发送；若原控制态为 agent，先发 `browser:control-mode-changed`（reason=trusted_content_input），再发本事件（`browser-service.ts:576-582`）。
- [x] 节流/合并：无；每次可信输入发一条。
- [x] 是否在事务提交后：不涉及事务；只切换内存控制态。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app.emit` 广播（`events.rs:126-130`）；TS 通过 `ctx.backendEvents.emit`，F2 按 target 扇出。

## 事件 `browser:control-mode-changed`

<!-- BEGIN GENERATED:event:browser:control-mode-changed -->
- 事件名 `browser:control-mode-changed`，常量 `EVT_CONTROL_MODE_CHANGED`
- 发送点：`src-tauri/crates/dstu-browser/src/browser/events.rs:120`（emit）
<!-- END GENERATED:event:browser:control-mode-changed -->

- [x] 载荷：`{ sessionId, label, controlMode, reason, at }`，`controlMode` 为 `user`/`agent`，`reason` 为 `agent_claim`/`user_takeover`/`trusted_content_input`（`events.rs:67-76`）；TS `emitControlMode` 发送同一形状（`browser-service.ts:944-950`）。
- [x] 触发时机与顺序：`setAgentControl` 发 agent_claim；`takeOver` 发 user_takeover；可信输入从 agent 转 user 时发 trusted_content_input；均在内存控制态切换后立即发送（`browser-service.ts:553,580,595`）。
- [x] 节流/合并：无；每次控制态切换发一条。
- [x] 是否在事务提交后：不涉及事务；不写库。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app.emit` 广播（`events.rs:120-124`）；TS 通过 `ctx.backendEvents.emit`，F2 按 target 扇出。

## 事件 `browser:navigated`

<!-- BEGIN GENERATED:event:browser:navigated -->
- 事件名 `browser:navigated`，常量 `EVT_NAVIGATED`
- 发送点：`src-tauri/crates/dstu-browser/src/browser/events.rs:96`（emit）
<!-- END GENERATED:event:browser:navigated -->

- [x] 载荷：`{ sessionId, label, url, title, canGoBack, canGoForward, loading, at }`（camelCase，`events.rs:22-32`）；TS 在 open/navigate/back/forward/reload/title 变更路径发送同一形状（`browser-service.ts:299-303,379,432,453,849,877`）。
- [x] 触发时机与顺序：open_session 创建 content window 后；navigate/back/forward/reload 完成并持久化 history 后；页面 title 变化且 URL 变化时也会补发；顺序为状态提交后、DB 写入尝试之后。
- [x] 节流/合并：无；每次导航/标题引起的 URL 变化发一条。
- [x] 是否在事务提交后：history/DB 写入先执行，失败只 warn，事件仍发送（`browser-service.ts:836-850`）。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app.emit` 广播（`events.rs:96-100`）；TS 通过 `ctx.backendEvents.emit`，F2 按 target 扇出。

## 事件 `browser:navigation-blocked`

<!-- BEGIN GENERATED:event:browser:navigation-blocked -->
- 事件名 `browser:navigation-blocked`，常量 `EVT_NAVIGATION_BLOCKED`
- 发送点：`src-tauri/crates/dstu-browser/src/browser/events.rs:102`（emit）
<!-- END GENERATED:event:browser:navigation-blocked -->

- [x] 载荷：`{ sessionId, label, url, reason, currentUrl, title, canGoBack, canGoForward, historyIndex, at }`（camelCase，`events.rs:34-46`）；TS `onNavigationBlocked` 从当前 state 填充可选字段（`browser-service.ts:903-908`）。
- [x] 触发时机与顺序：content 窗口报告导航被策略拒绝时，先取消/回滚 pending navigation，再发送；无活跃 session 时不发送（`browser-service.ts:890-909`）。
- [x] 节流/合并：无；每次被拒绝的导航发一条。
- [x] 是否在事务提交后：不涉及事务；只回滚内存 pending 与 session 历史状态。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app.emit` 广播（`events.rs:102-106`）；TS 通过 `ctx.backendEvents.emit`，F2 按 target 扇出。

## 事件 `browser:title-changed`

<!-- BEGIN GENERATED:event:browser:title-changed -->
- 事件名 `browser:title-changed`，常量 `EVT_TITLE_CHANGED`
- 发送点：`src-tauri/crates/dstu-browser/src/browser/events.rs:114`（emit）
<!-- END GENERATED:event:browser:title-changed -->

- [x] 载荷：`{ sessionId, label, title, url, at }`（camelCase，`events.rs:58-65`）；TS 在 `onTitleChanged` 发送（`browser-service.ts:883-886`）。
- [x] 触发时机与顺序：页面 title 变化时更新 session title 与 DB 后发送；若 URL 同时变化，先发 `browser:navigated`，再发本事件（`browser-service.ts:862-887`）。
- [x] 节流/合并：无；每次 title 变化发一条。
- [x] 是否在事务提交后：title 的 DB 更新先执行，失败只 warn，事件仍发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app.emit` 广播（`events.rs:114-118`）；TS 通过 `ctx.backendEvents.emit`，F2 按 target 扇出。

## 事件 `vfs-index-progress`

<!-- BEGIN GENERATED:event:vfs-index-progress -->
- 事件名 `vfs-index-progress`
- 发送点：`src-tauri/src/chat_v2/tools/index_webpage_executor.rs:252`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/index_webpage_executor.rs:274`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/index_webpage_executor.rs:294`（emit）
- 发送点：`src-tauri/src/chat_v2/tools/index_webpage_executor.rs:325`（emit）
<!-- END GENERATED:event:vfs-index-progress -->

- [x] 载荷：四种 `type`（`agent_rebuild_started` / `agent_rebuild_progress` / `agent_rebuild_completed` / `agent_rebuild_failed`），公共字段 `resourceId`、`blockId`；progress 额外 `current`、`total`、`progress`（0-100 四舍五入），completed 额外 `chunks`、`embeddingDim`，failed 额外 `error`（`index_webpage_executor.rs:244-335`）。
- [x] 触发时机与顺序：preflight 与取消检查通过后先发 started；`reindex_resource` 的 embedding 回调按批次发 progress；成功发 completed，失败发 failed；同一 block 内顺序固定（`index_webpage_executor.rs:252-335`）。
- [x] 节流/合并：无显式节流；progress 由 embedding 回调频率决定。
- [x] 是否在事务提交后：事件不包裹 DB 事务；reindex 管线的写入由 VFS 索引服务自行提交，事件只报告进度/结果。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app_handle.emit` 广播（`index_webpage_executor.rs:252`）；Host 侧 `IndexWebpageToolExecutor` 已在 `index.ts` 通过 `agentTools.registerToolExecutors` 注册，`index_rebuild` 通过 `ctx.host.emit` 广播四种 `vfs-index-progress` 载荷（`src/index-webpage-executor.ts`）。
