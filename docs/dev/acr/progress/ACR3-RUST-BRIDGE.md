# ACR3-RUST-BRIDGE — Rust 桥接、终态与安全边界

- 状态：已完成
- 名下文件：`workbench_bridge.rs`、`workbench_executor.rs`、`canvas_executor.rs`、`builtin_resource_executor.rs`、`executor.rs`、`executor_registry.rs`、`approval_scope.rs`

## checklist

- [x] 取消/超时后 bounded drain 前端权威 terminal receipt
- [x] 无终态回执时返回 `RESULT_UNKNOWN` + `retryable:false`
- [x] session-scoped runId 并保留原 toolCallId
- [x] correlationId + bridgeToken 严格回显校验
- [x] 按命令校验 `ok/data/error` 与 receipt 语义
- [x] undo/open_app/note/mindmap 风险等级与审批记忆收紧
- [x] note read 返回 `updatedAt`/`updated_at`；append/replace/set 后端回落强制 VFS CAS
- [x] probe 未知、畸形、超时或 frozen 不再回落后端写入

## 自验

- `rustfmt --edition 2021 --check <changed Rust files>`: PASS
- `git diff --check` / `git diff --cached --check`: PASS
- Cargo: 未运行（遵守 `docs/dev/acr/STANDARDS.md`）
- Rust 单测：已补充，由协调者统一运行

## 设计决策与偏差

- 当前审批框架只按工具名分级，因此混合 `mindmap_edit_nodes` 整体 fail-closed 为 High。
- Tauri 同一 WebView 内的恶意 JS 能观察 request token；bridgeToken 防止盲猜、陈旧和跨请求响应，不是渲染器隔离边界。

## 跨界申请

- Canvas skill schema 需对 append/replace/set 暴露 `expected_updated_at`；协调者已接手。

## 遗留给 R2 的事项

- 统一运行 Cargo check/test 和真实 Tauri 取消 E2E。
- 若未来增加参数级 sensitivity API，可将非破坏性 mindmap edit 从整体 High 精细降级。

## 新增 i18n keys

- 无
