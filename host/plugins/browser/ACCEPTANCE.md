# L19-mcp-browser 验收记录（浏览器与搜索）

本文件记录 `host/plugins/browser/` 的验收范围、证据与仍然存在的真实缺口。
验收以实时账本（`node scripts/electron-migration/ledger.mjs --vitest latest` 或监控面板，见 `migration/LEDGER.md`）的计算结果为准，本文件只列出可复核的证据；
同 lane 的 MCP 目录见 `host/plugins/mcp/ACCEPTANCE.md`。

## 范围

- Rust 范围：`dstu-browser`（`bridge`、`database`、`error`、`events`、`hooks`、`policy`、
  `repository`、`service`、`session`、`types`、`window`、`cmd/browser.rs`）、
  `chat_v2/tools/browser_executor.rs`、`chat_v2/tools/index_webpage_executor.rs`、
  `cmd/web_search.rs`、`tests/bing_rss_search.rs`、`tests/browser_capability_contract.rs`。
- Host 目录：`host/plugins/browser/`（`index.ts`、`api.ts`、`src/`、`repository/`、`tests/`）。
- 命令：38 个唯一命令，全部按 `contracts/ipc/L19-mcp-browser.json` 声明并注册。
- 服务：`browser@1`（`BrowserService`）、`browserToolPolicy@1`、`webpageToolPolicy@1`
  （`BrowserToolExecutor` / `IndexWebpageToolExecutor` 的共享策略面）、`webSearch@1`
  （搜索命令与 MCP `web_search` 工具共用）。

## 工具执行器（真实生产入口）

- [x] `BrowserToolExecutor`（`src/browser-tool-executor.ts`）实现真实 `execute`：
  `browser_open` / `navigate` / `snapshot` / `screenshot` / `click` / `type` /
  `file_upload` / `downloads` / `scroll` / `back` / `close`。执行路径直接调用
  `BrowserRuntimeService`（gates、URL 策略、SSRF、session/history、surface snapshot/click/type/scroll）。
- [x] Agent 双闸门：`desktop.workbenchBrowserAgentControl` + `tools.browser_agent`
  在每次 `execute` 前校验；用户接管返回结构化 `BROWSER_USER_TAKEOVER`，
  变更类工具按 Rust 语义 claim agent 控制权并回执 `claimed_from_user` /
  `reclaimed_after_user_takeover`。
- [x] 功能开关接线：`BrowserRuntimeService` 与 `BrowserToolExecutor` 不再构造本地
  `FeatureFlagManager`，统一经注入的 F3 `featureFlags` 端口读取 `ui.workbench_browser` /
  `tools.browser_agent`；`get_feature_flags`、`update_feature_flag`、`is_feature_enabled`
  走 `ctx.featureFlags.load/save`，本地文件只保留结果整形辅助；
  `tests/browser-service.test.ts`、`tests/feature-flag-commands.test.ts` 覆盖真实服务接线。
- [x] `browser_file_upload` 消费 L05 `ctx.runtimeRoots` 正式服务：`rootById(rootId,{session_id})`
  解析 root，`revalidate(root)` 校验未撤销；只接受 `workspace` / `authorized` / `artifact`，
  用 `normalizeRuntimeRelativePath` 拒绝绝对路径与 `..`，canonicalize 后检查仍位于 root 内且为普通文件，
  16 MiB 总量上限，生成 SHA-256 与真实 `TaskObjectHandle` 后经 bridge 上传。
  服务缺失时 fail closed 返回 `BROWSER_FILE_UNAVAILABLE`；`tests/tool-executor-execute.test.ts`
  用真实 L05 Host 服务覆盖 artifacts 授权、temp/逃逸/目录/缺失/超限/撤销/快照失败与缺服务路径。
  Windows 原生 runtime root 校验未在目标平台验证。
- [x] `browser_screenshot` 按 Rust 平台分支返回
  `{ available: false, reasonCode: "PLATFORM_API_UNAVAILABLE" }`，不伪造截图。
- [x] `IndexWebpageToolExecutor`（`src/index-webpage-executor.ts`）实现真实 `execute`：
  `webpage_save` 通过 L11 仓储写 blob/file/resource/metadata 并由 L12
  `vfsUnitBuilder.syncResourceUnits` 同步 unit；`index_rebuild` 走 L12
  `vfsIndex.indexing.reindexResource` 并发送 `vfs-index-progress` 的
  started/progress/completed/failed 四种载荷；资源级 `index_status` 读取真实
  resource/index state/OCR/units 状态。
- [x] `webpage_save` 支持 created / restored / deduplicated 三种结果，按内容 SHA-256
  去重，并发送 `dstu:change:<path>` 与 `dstu:change`。
- [x] 两个执行器在 `index.ts` 中通过 `ctx.inject(['agentTools'])` 调用
  `agentTools.registerToolExecutors([browserExecutor, indexExecutor])` 注册；
  测试 `tests/tool-registration.test.ts` 断言注册顺序、`execute` 存在与策略委派。
- [x] 全局 `index_status`（无 `resource_id`）在 L12 `VfsIndexService.get_status_summary`
  发布前返回结构化 `DEPENDENCY_UNAVAILABLE`，不另造第二套 summary。

## 命令验收

- [x] 38/38 命令 A 级：21 个 `browser_*`、`network_probe`、16 个搜索 / 设置 / feature flag 命令
  均在 `meta.commands` 声明并逐一 `ctx.commands.register`，契约齐全、无重复声明、无边界违规。
- [x] 每个命令的输入、输出、错误前缀、事件、DB 读写、取消/并发、时间/ID 按 Rust 逐条核对，
  结论写在 `SPEC.md` 对应命令的 7 项清单中，并全部勾选；命令 B 级依赖的全局语义 9 项同样全部勾选。
- [x] `browser_*` 命令的 `map_err` 前缀与 Rust 一致：`NOT_FOUND`、`NAVIGATION_BLOCKED`、
  `GATES_CLOSED`、`BRIDGE_UNSUPPORTED`、`BRIDGE_NOT_READY`、`BRIDGE_TIMEOUT`、
  `USER_TAKEOVER`、`DB_NOT_OPEN`；桥错误码 `BRIDGE_PASSWORD_FIELD` 等原样透传。
- [x] `browser_release_surface_focus`、`browser_set_surface_bounds`、
  `browser_set_surface_visibility`、`browser_take_over` 与 Rust 一样先 `assertGatesOpen()`，
  闸门关闭时返回 `GATES_CLOSED` 而非静默执行。
- [x] `browser_open_session` / `navigate` / `back` / `forward` / `reload` 走真实
  `BrowserService`（gates、URL 策略、SSRF、pending navigation、history、DB 持久化）；
  `browser_content_user_input` 校验 `browser-content` 标签、16 字节 nonce 与输入类型。
- [x] `browser:navigated` / `closed` / `title-changed` / `navigation-blocked` /
  `control-mode-changed` / `content-user-input` 由 `BrowserService` 直接发送；
  载荷字段与 Rust 事件结构一致。
- [x] 搜索结果形状、引擎顺序、`elapsed_ms`、`not_configured` 分支、CN 白名单解析、
  feature flag 读改写、内部 OAuth 设置键的 IPC 边界均按 Rust 覆盖；错误统一为
  `CommandError(string | AppError)`，无裸异常泄漏。
- [x] `webSearch` 服务同时实现 L13 `CancellableWebSearchPort`：
  `loadConfig(settings|null)` 支持调用方在 start 事件前加载配置（null 仅环境配置），
  `doSearch(config,input,signal)` 将同一 signal 贯穿到 fetch，取消以 AbortError 终止；
  `tests/search-commands.test.ts` 用本地 HTTP server 断言在途请求被 signal 中止。

## 测试验收

- [x] `TESTMAP.md` 共 106 条真实 Rust 测试：104 条 `ported`，2 条 `pending`；
  `pending` 全部为跨 lane 接口缺失，逐条证据见 `BLOCKERS.md` 与下方“已知缺口”。
- [x] `npx vitest run -c vitest.host.config.ts host/plugins/browser` 通过：
  21 个测试文件、178 条用例全部通过；无 `.skip` / `.todo` / `.only`，无 mock/stub 生产实现。
- [x] `tests/tool-executor-execute.test.ts`（10 条）使用真实 `BrowserRuntimeService` +
  fake surface，覆盖 open/snapshot/click/close、硬闸关闭、URL/ref 预校验，以及
  `browser_file_upload` 的真实 L05 runtimeRoots 授权、temp/逃逸/符号链接/目录/缺失/
  16 MiB 超限/撤销/快照失败与缺服务 fail-closed。
- [x] `tests/index-webpage-execute.test.ts`（5 条）使用真实迁移 VFS DB、L11 仓储与
  L12 unit builder，覆盖真实持久化/去重/恢复、`INCOMPLETE_WEB_FETCH`、rebuild preflight
  边界（Rust 测试名
  `rebuild_unit_test_boundary_stops_before_llm_lance_and_window_dependencies`）与
  status summary 缺失时的结构化失败。
- [x] `browser_executor` 的 10 个策略用例与 `index_webpage_executor` 的 7 个纯 helper 用例
  已接到 `browserToolPolicy` / `webpageToolPolicy` 服务（`api.ts` 导出、`index.ts` provide），
  测试调用的是生产函数而非本地副本。
- [x] `tests/browser_capability_contract.rs::embedded_browser_permissions_are_scoped_per_webview`
  直接读取 `src-tauri/capabilities/{default,browser-content}.json` 断言 per-WebView 权限范围。
- [x] `tests/bing_rss_search.rs::bing_rss_returns_search_citations_without_api_key`
  使用本地 RSS fixture 服务器，不访问外网。
- [x] `npm run migration:wiring -- --lane browser`：ported 104，所测模块未从 `index.ts`
  接入 0（0.0%）。

## 门禁证据

- [x] `npx tsc -p tsconfig.host.json` 通过（作业 `20261104091902-29926c`，退出码 0）。
- [x] 最近一次 browser+mcp 全量：38 个测试文件、318 条用例（本目录 178 条）
  （作业 `20261104080117-d83eed`，退出码 0）；本轮仅 mcp SSE/桥变更，按 C1 未复跑全量。
- [x] `npm run migration:wiring -- --lane browser`：ported 104，所测模块未从 `index.ts`
  接入 0（0.0%）。（作业 `20261104080227-9482f5`，退出码 0）
- [x] `npm run migration:boundaries:strict` 全局退出码 1，原因是其他 lane 的 4 条未抑制
  `empty-catch` / `console-log`（`vfs`）；本 lane 14 条记录全部为 `(allowed)`：
  `browser-bridge.js` 2 条、`browser-service.ts` 1 条、`mcp/oauth-manager.ts` 1 条、
  `mcp/probe.ts` 1 条 empty-catch，以及 `index-webpage-execute.test.ts` 9 条测试宿主使用
  L11/L12 真实仓储的 `cross-plugin-impl` 抑制；无未抑制违规。（作业 `20261104080508-04ab66`）
- [x] `node scripts/electron-migration/importable.mjs host/plugins/browser/index.ts`
  输出 `importable: ok`（退出码 0）；`host/plugins/mcp/index.ts` 同样 ok。
  （作业 `20261104080508-0d171c` / `20261104080508-2bf05d`）
- [x] `npm run migration:ledger -- --check --no-write` 退出码 0（作业
  `20261104080227-9ce452`）；本 lane commands 62，A 级 62/62、B 级 62/62；
  tests 206，A 级 204/206（99.0%），pending 2，本 lane problems 0。

## 已知缺口（2 条 pending + 2 条能力缺口，均为跨 lane 阻塞）

- [x] `index_webpage_executor.rs::tests::webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state`：
  L12 仍缺跨 lane 的 `VfsIndexService.get_status_summary`（Rust
  `index_service.rs:192`，调用点 `index_webpage_executor.rs:80,734,1328-1390`）；
  资源级 status 已真实实现，只缺全局 summary。需求已交 C2。
- [x] `browser_capability_contract.rs::embedded_browser_capabilities_match_tauri_schema`：
  `src-tauri/gen/schemas/desktop-schema.json` 是 Tauri 构建产物，仓库与 `HEAD` 中均不存在；
  Electron 侧没有等价 capability schema，F2 未提供。
- [x] 工具派发：L07 注册面已发布、本 lane 已注册，但 L04 的 `ToolExecutorRegistry`
  尚未合入当前 main；`agentTools.toolExecutors()` 已有内容，聊天运行时派发需等 L04 合并。
- [x] 原生截图：F2 的 `BrowserSurfaceHost` 没有截图 API，`browser_screenshot` 返回
  `PLATFORM_API_UNAVAILABLE` 能力载荷；原生截图能力待 F2。
- [x] `vfs-index-progress` 四种载荷已按 Rust 填写 SPEC 并在 `index_rebuild` 真实发送；
  `webpage_save` 的向量索引用 L12 既有异步队列，事件发送点与 Rust 一致。
