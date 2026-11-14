# L19-mcp-browser 阻塞清单（browser）

## WP-154 交付门禁（2026-11-05 恢复）

- 最窄生产注销及原入口回归已完成，三层 Rust/前端证据见 SPEC 对应节；无新增 owner API 需求。
- 官方 lane-gate 在正式提交并合并 main 后直接执行，原 exit2：既有 foreign
  `migration/LEDGER.md`、`migration/ledger.json` dirty 触发前置条件，未进入门禁 jobs。
  按恢复 brief 不提交/还原这些账本；需 C2 在正常完整候选集成时运行门禁。
  最终 tip、直接 gate 原输出及 jobs 回执在 WP-154 交付报告，不将单项 exit0 冒作 gate 通过。

## L11 资源元数据写入所有者 API（L19-V2-01 / X6-SW-0003，仍开放）

- 接手发现 `repository/vfs-metadata.ts:11` 直接 UPDATE L11 `resources`，违反 D1/D4；
  旧注释声称是“owning plugin”不属实，不能保留为完成证据。
- X6 单 SW 快照 `1c8239f67`（固定 main `4525e11ac`、规则 `6002c7fbd`）对应原冻结报告
  `0119143715c0` 的稳定 ID `X6-SW-0003`，与 L19-V2-01 是同一问题，不新增编号。
- 本轮已核 main `1e893eb61` 的 `vfs-repos/types/files.ts` / `api.ts`，以及 L11 候选
  `6525dc938` 的同一公开面：均未发布 metadata 更新方法。不能把已有 `updateResourceData`
  或 PDF/media 专用接口当作同语义替代，也不私导入 owner 仓储。
- 精确请求：L11 发布 `resources.updateResourceMetadataWithConn(conn: SqlExecutor,
  resourceId: string, metadataJson: string, updatedAtMs: number): void`（更正原请求的 typed-metadata 参数：
  应接调用方已序列化 JSON，以保持 Rust 的序列化错误顺序）。必须只在调用方同一 conn 执行
  `UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3`，绑定顺序为
  `[metadataJson, updatedAtMs, resourceId]`；不改 data/hash/refcount，不额外开启事务、查存在性或发通知。
- Rust `src/chat_v2/tools/index_webpage_executor.rs:720-743` 的顺序为 serialize → timestamp → UPDATE →
  unit sync；0 行更新不是错误。owner 方法返回 void，SQL 错误原样抛出，调用方保留 `WEBPAGE_SAVE_FAILED`
  包装；不能把元数据序列化或额外查询塞进 owner 方法改变错误时序。
- 受影响：`builtin-webpage_save` 的 metadata 保存阶段；等待所有者发布期间不得把该路径签为v2完成。
- L12 summary 已有 main 正式出口并经真实插件消费验证（见下方第 2 节）；L02 W20、F2真实窗口/Windows不因此自动解阻。

本文件只记录**其他 lane 尚未发布的接口**，不是本 lane 的待办。每项都给出缺失符号、提供方和受影响的 TESTMAP 行；
接口发布后可直接接线，无需改写已移植的生产逻辑。

## 1. L04 派发注册表未合入（L04）

- 已发布：L07 `agentTools.registerToolExecutors` / `toolExecutors()`
  （`host/plugins/agent-skills/api.ts:316-322`），本 lane 在 `host/plugins/browser/index.ts`
  的 `ctx.inject(['agentTools'])` 中注册 `BrowserToolExecutor` 与 `IndexWebpageToolExecutor`，
  两者的 `execute` 已走真实 `BrowserRuntimeService` / VFS 仓储（测试见 `tests/tool-registration.test.ts`、
  `tests/tool-executor-execute.test.ts`、`tests/index-webpage-execute.test.ts`）。
- 缺什么：L04 `chat_v2/tools/executor_registry.rs` 的 Host 派发实现尚未合入当前 main
  （`host/plugins/chat/src/executor-registry.ts` 只存在于 `ds-mig/L04-chat-session`）。
  当前 `agentTools.toolExecutors()` 有注册内容，但没有 L04 侧按序路由、超时、审批与取消的消费方。
- 由谁提供：L04（chat session / tool executor registry）。
- 影响：`execute` 已是真实生产实现并完成注册，但要成为聊天运行时的实际派发路径仍需 L04 合并；
  本 lane 不自行实现第二套注册表。

## 2. VFS 全局索引状态摘要（L12，接口缺口已解除，候选待复核）

- 当前 main 的 `host/plugins/vfs-index/api.ts:313-318,359` 已公开 `VfsIndexStatusSummary` /
  `getStatusSummary()`；`index.ts:104` 提供真实实现，内部经 L11 仓储读取统计，不复制查询。
- browser/index.ts 现在直接使用该公开类型/方法，去除私有交叉类型补丁；摘要读失败按
  Rust index_webpage_executor.rs:78-81 返回 `INDEX_STATUS_FAILED`，不再误标 `WEBPAGE_SAVE_FAILED`。
- 证据：`tests/index-status-wiring.test.ts` 安装真实 paths/VFS/repos/index/agent-skills/browser 插件，
  从 `agentTools.toolExecutors()` 取得生产注册执行器，验证网页持久化、全局/资源摘要和 rebuild preflight；
  关闭真实 F3 连接后验证摘要错误优先于资源查询。作业 `20261104152324-d8eca2`，2 passed / exit0。
- 原 TESTMAP 行 `webpage_persistence_status_and_rebuild_preflight_use_real_vfs_state` 已有同名测试和
  全部 Rust 断言对应；去向列（允许填写的状态列）已改为 `ported:host/plugins/browser/tests/index-status-wiring.test.ts`。
- 本项不解除 L19-V2-01 metadata 所有者 API、F2 schema 或 D3 等其他问题，也不是独立验收签收。

## 3. 原生浏览器截图（撤销错误阻塞判断，L19-V2-12）

- 原记录“Rust browser_screenshot 走原生 surface 截图”不实。Rust browser_executor.rs:997-1019
  本身固定返回 `available:false`，并要求不得用 DOM snapshot/合成图片冒充截图。
- 本 lane 应保持该迁移行为，不以 F2 新增像素截图能力作为等价前提，也不擅自扩展工具功能。
  已把 reason 对齐原文 `当前 Tauri/Wry 平台未提供嵌入式 WebView 可见区域截图接口`。
- 证据：tool-executor-execute.test.ts 经生产 execute 验证完整 unavailable payload 和会话字段，
  并断言没有额外调用 DOM snapshot。本项不解除下方 capability schema 或真实窗口验证。

## 4. Electron capability schema（F2）

- 缺什么：
  - `src-tauri/gen/schemas/desktop-schema.json` 在仓库中不存在（Tauri 构建时生成，已被 gitignore），
    Electron 侧没有等价 capability schema。
  - `tests/browser_capability_contract.rs::embedded_browser_capabilities_match_tauri_schema` 依赖该 schema
    做 `jsonschema` 校验；同文件的 `embedded_browser_permissions_are_scoped_per_webview` 不依赖 schema，
    已按真实 capability 文件移植到 `tests/capability-contract.test.ts`。
- 由谁提供：F2-shell。
- 影响：
  - `tests/browser_capability_contract.rs::embedded_browser_capabilities_match_tauri_schema`

## 5. 密码 BLOCKED 的结构化错误接缝（X6-LP-0089，交 C1/C2 集中）

- Rust browser_executor.rs:191-202,604,658,845 对密码 BLOCKED 先调用
  `take_over_with_reason("password_blocked")`，失败 warn、成功 info，然后保留原密码禁止错误。
- 本 lane 目前只有纯错误码映射，尚未执行该控制权移交；这是自有待修行为，不以日志计数掩盖。（已更新：见本节末条）
- 前置接缝也缺失：F2 `electron/shell/browser-protocol.ts:145-152` 把桥错误丢弃 details 后转成
  `Error("bridge error <code>: <message>")`，现有 shell 错误又只传字符串，L19 的 typed BridgeError
  读不到 `details.reason=password_field`。不能从任意错误字符串猜权限/控制权状态。
- 请 C1/C2 协调 F2/F1 的正式错误面，针对 browser.click/typeText/setInputFiles 保留 code/message/details
  （尤其 BLOCKED/password_field）到 Host；失败不能冒作成功 result。由 owner 决定既有 shell 面的传输形式，
  不要求另起框架，本 lane 不修改 electron 或 kernel 文件、不自行唤醒停放 owner。
- 本 lane 自有部分已完成：`BrowserToolExecutor.bridgeMaybeTakeover` 在 click/typeText/setInputFiles 处对
  Bridge 形状的密码 BLOCKED 调用 takeOverWithReason("password_blocked")，失败 warn、成功 info，再传播原错误码；
  测试见 `tests/tool-executor-execute.test.ts`（`map_bridge_err_maybe_takeover` 一组与 setInputFiles 用例）。
  仍缺 F2 壳桥把 code/message/details 带回 Host；当前 `ShellBrowserSurface` 收到的是字符串 Error，
  在 Electron 真实路径上不会触发移交。

## 6. 工具块持久化上下文（X6-LP-0089 / X6-LP-0090，与既有 L04 派发缺口关联）

- browser_executor.rs:1182-1198 / index_webpage_executor.rs:547-551 的 warn 是 save_tool_block 失败分支；
  L19 当前执行器未调用同语义保存，因此不能只补空 warn。
- F1 `ExecutionContext.blockStore.upsertToolBlock(call, blockType, payload)` 已有通用出口；但 Rust
  dstu-agent/chat_v2/tools/executor.rs:490 起还负责消息占位、结果状态/时间/字段映射与 UPSERT。
  需 L04/F1 明确该正式适配由谁提供，以及 payload 是否为 ToolResultInfo 或已构造 MessageBlock；
  与上方 L04 生产派发/上下文装配缺口同根，不在 L19 自写 chat_v2 表或复制占位消息仓储。
- 本 lane 后续负责调用已明确的保存适配，保持 best-effort（保存失败不改变工具结果）并在两条原位置记录 warn。

## 7. 原生下载回调未转发（L19-V2-05，同根剩余接线，交 C1/C2 集中）

- 当前 `electron/` 未找到 will-download / DownloadItem / download-requested / download-finished 的转发实现；
  L19 `BrowserSurfaceHost.subscribe` 的 SurfaceEventCallbacks 也只有 page/title/navigation-blocked。
  `onDownloadRequested` / `onDownloadFinished` 服务核心存在，但尚无 native → Host 调用方。
- Rust 对应 `dstu-browser/browser/service.rs:1274-1312` 的 ContentWindowHooks，以及 window.rs 原生下载回调。
  请 C1/C2 协调 F2 公布/接通：
  1. 下载请求带创建时绑定的 browserSessionId、url、建议文件名；等待 L19 的
     `{allow:boolean,path:string|null}` 决定。allow=false 必须取消，path 非空必须使用该受控路径，
     不能由 F2 另造任务归属/预算/文件名规则。
  2. 完成回调带 url、最终受控 path|null、success；调用同一个 L19 服务的 onDownloadFinished，
     保留旧会话完成回调的路径关联，不把 native finished 直接当作已通过 hash 的 completed。
- 本 lane 自有后续：在已明确的原生回调面上发布/消费对应服务入口，绑定 sessionId、订阅/卸载生命周期，
  仍由 L19 负责授权/任务预算、artifact root、处理状态及 hash 回写。
- `download-wiring.test.ts` 目前通过生产插件构造服务后直接调用下载核心，只证明该范围；
  不能冒充未存在的 Electron 原生下载闭环。新增 worker 测试也不解除这条接线缺口。
