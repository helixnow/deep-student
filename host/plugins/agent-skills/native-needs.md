# PTC 原生接口（F7，已满足）

F7 已合入 `host/platform/native/starlark/`：真实 `starlark 0.14.2` WASI 引擎
（`host/platform/native/wasm/` 预编译产物）提供 `evaluate(script, {limits, signal, deadlineMs, call, objectRead, objectWrite})`，
并在宿主回调处采用 replay 模式等待异步结果；dialect、禁用 `load`、callstack 256、
heap peak 32 MiB、tick 10,000,000 与 Rust 使用同一 crate/常量。

因此 `ptc_runtime.rs` 的 33 条测试与 `ptc_executor.rs` 的 15 条测试已有 TS 实现并通过
（`tests/ptc-runtime.test.ts`、`tests/ptc-executor.test.ts`）；v2 去向仍为 pending，
原因是 L04 生产消费未接入（`BLOCKERS.md` B1），不是缺少 F7 引擎。策略、预算账本、
trace、`object_read`/`object_write` 的分页与受管路径、结果物化仍在 L07
（`src/tools/ptc-runtime.ts`、`src/tools/ptc-executor.ts`、`src/tools/object-pages.ts`）。

## L06 工具描述符注册表（已接线）

Rust 的 `is_ptc_allowed_tool` 委托 `chat_v2::tool_descriptors::is_ptc_allowed`
（descriptor 的 `ptc_allowed` 标志位）。L06 已在
`host/plugins/agent-orchestration/api.ts` 发布：

- `BUILTIN_DESCRIPTORS: readonly ToolDescriptor[]`
- `isPtcAllowed(toolName: string): boolean`
- 类型 `ToolDescriptor` / `ToolSensitivity` / `SideEffectClass` / `GrantsScopeHint`

本 lane 的 `src/tools/ptc-runtime.ts` 已将该导出作为默认 `PtcDescriptorPolicy`
（`DESCRIPTOR_POLICY`）；`PTC_ALLOWED_TOOLS` 仅保留为与 Rust 同一份的测试 oracle，
生产路径不再回退到本地常量。对应两条同步测试
（`ptc_whitelist_delegates_to_descriptor_registry`、
`controlled_write_policy_is_registered_non_destructive_and_disjoint`）已在
`tests/ptc-runtime.test.ts` 移植，`PtcDescriptorPolicy` 注入点保留给宿主替换策略。

# 平台模块（F4，已合入 main）

`host/platform/time`、`host/platform/util`、`host/platform/net-policy` 已在 main，
本 lane 的本地副本已删除并改为引用平台实现：

- `now()`/`toRfc3339`/`parseRfc3339`：skill-usage、skill-replay、skill-taps、
  skill-updates、connector、skill-workshop、llm-usage、task-objects 全部改用
  `host/platform/time`；`utcRfc3339Now` 仅作为 `now as utcRfc3339Now` 重导出保留。
- `isInternalIp`/`isLoopbackIp`/`isLoopbackHost`/`isBlockedInternalIp`：
  删除 `src/net-policy.ts`，`src/http.ts` 与 `mcp-propose-executor.ts` 直接引用
  `host/platform/net-policy`；`fetch-executor.test.ts` 的原 `net_policy.rs` 用例
  同样改为测平台实现。
- HTTP 状态短语：`src/http.ts` 改用 `host/platform/util` 的 `statusLine`
  （`canonical_reason` 兼容），不再使用 `node:http` 的 `STATUS_CODES`。

# 虚拟文件 URI 读取（Android）

`skill_import_zip`/`skill_tap_install` 的 `content://`、`asset://`、`ph://`、`image://`、`camera://` 与 SAF 前缀在 Rust 走 `tauri-plugin-fs` 的 ContentResolver（`unified_file_manager.rs:116–138,206–248`）。Electron host 是桌面端，没有该插件；当前以 `IO error: Failed to read zip: virtual file URI is not readable on this platform: …` 失败，与桌面 Rust 构建调用 `window.fs()` 的结果同形。若未来支持移动端，需要 main 进程提供等价的有界 `content://` 读取 op（≤ 传入的 maxBytes）。
