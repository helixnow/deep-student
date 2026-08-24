# R2-WI-6：mobile-slim feature 编译门控修复（WI-6 前置）

> 子代理：SA-R2-08  
> 模型：`claude-fable-5-thinking-xhigh`  
> 分支：`cursor/optimization0824-5575`  
> Work Item：WI-6（Android mobile-slim，本轮为前置编译收口，Android workflow 不动）

## 任务范围

`Cargo.toml` 中 `mobile-slim = ["sqlite", "builtin_free_models", "data_governance"]`
（相对 default 裁掉 `lance` / `mcp` / `tokenizer_tiktoken` / `cloud_storage_s3`）此前只是
骨架定义，从未真正编译过。本轮目标：让
`cargo check --no-default-features --features mobile-slim` 通过，只加 `#[cfg(feature)]`
门控或 stub，不改 Android workflow、不改 feature 定义本身。

## 基线错误盘点（rustc 1.98.0，Linux x86_64）

首次可编译环境下共 **50 个编译错误**，按根因分组：

| 根因 | 错误数 | 位置 |
| --- | --- | --- |
| `vfs/lance_store.rs` 整文件无任何 lance 门控（`use lancedb/arrow_*` + 12 处 `lancedb::` 路径） | 25 | `src/vfs/lance_store.rs` |
| `lance_vector_store.rs` 顶部 `compile_error!` 硬禁止非 lance 构建 + `Result<T>` 别名被 lance 门控导致未门控方法签名 E0107 | 15 | `src/lance_vector_store.rs` |
| `crate::mcp` 引用未门控（OAuth 命令注册、mcp_test_helpers、tool_adapter 导入） | 8 | `src/lib.rs`、`src/cmd/mcp.rs`、`src/chat_v2/adapters/tool_adapter.rs` |
| `EstimateTokensRequest` 结构体被误挂 `#[cfg(feature = "mcp")]`，而使用它的 `estimate_tokens` 命令无门控 | 1 | `src/commands.rs:285` |
| `canvas_executor` not(lance) 分支只门控了 early-return，后续代码仍引用 lance 分支的 `results` | 1 | `src/chat_v2/tools/canvas_executor.rs:924` |

修复过程中暴露的二阶错误（首轮被解析错误掩盖）：
`chat_v2/tools/mcp_propose_executor.rs` 5 处调用 `mcp_test_helpers`；
`lance_vector_store.rs` 的 `ensure_base_rag_schema`（纯 SQLite）被误挂 lance 门控但被无门控的 `new()` 调用。

## 修复清单（11 个 Rust 文件）

### mcp 裁剪路径

- `src/lib.rs`：5 个 MCP OAuth 命令注册由 `#[cfg(not(target_os = "android"))]`
  收紧为 `#[cfg(all(feature = "mcp", not(target_os = "android")))]`；`tracing::debug`
  导入随 mcp 门控拆分。
- `src/cmd/mcp.rs`：`pub mod mcp_test_helpers` 补 `#[cfg(feature = "mcp")]`
  （该文件其余命令本就有成对的 not(mcp) 回退实现，只有这个 helpers 模块漏了）；
  `tauri::Emitter` 导入随之拆分。
- `src/chat_v2/adapters/tool_adapter.rs`：`call_mcp_tool` / `convert_mcp_tool_result`
  及其专属导入挂 mcp 门控；新增 not(mcp) 版 `call_mcp_tool` stub——发射 start +
  error 事件后返回 `ChatV2Error::Tool`，保持公开 API 与事件契约不变。
- `src/chat_v2/tools/mcp_propose_executor.rs`：`run_connection_test` 拆成 mcp 真实现 /
  not(mcp) 直接返回 `{"success": false, "error": "MCP 功能未启用…"}` 两个 cfg 变体。
- `src/commands.rs`：移除 `EstimateTokensRequest` 上误挂的 mcp 门控（`estimate_tokens`
  只依赖 token_budget 启发式，与 mcp 无关，default 构建行为不变）。

### lance 裁剪路径

- `src/vfs/mod.rs` + 新增 `src/vfs/lance_store_stub.rs`：`vfs::lance_store`（3300 行、
  约 30 个消费方文件）整体挂 `#[cfg(feature = "lance")]`，not(lance) 时经
  `#[path = "lance_store_stub.rs"]` 提供同名同 API stub，消费方零改动。stub 语义：
  - 读路径（vector/fts/hybrid 检索、stats、diagnose）→ 空结果（与 canvas_executor
    既有 not(lance) 空结果先例一致，SQLite/FTS 检索不受影响）；
  - 删除/清理/优化 → `Ok(0)`/`Ok(())`（无向量数据，空成立）；
  - 写入与 profile 管理（`write_chunks` / `ensure_model_profile*` /
    `next_unit_generation`）→ `VfsError::InvalidState`，索引流水线显式进入
    INDEX_STATE_FAILED，不静默丢 embedding。
- `src/lance_vector_store.rs`：移除 `compile_error!` 硬门槛（commands.rs 既有的
  `#[cfg(not(feature = "lance"))]` 孤儿清理回退证明该文件本就预期支持非 lance 构建）；
  `Result<T>` 别名去门控（修复全部 14 个 E0107）；`impl VectorStore for LanceVectorStore`
  整块挂 lance 门控（该 trait 无任何多态调用方，见 vector_store.rs 退役说明）；
  为外部调用面补 not(lance) stub：`optimize_chat_tables` / `optimize_kb_tables` →
  `Ok(0)`，`delete_chat_embeddings_by_ids` → `Ok(())`；`ensure_base_rag_schema`
  （纯 SQLite，被 `new()` 无条件调用）去掉误挂的 lance 门控；头部导入按 lance 拆分。
- `src/chat_v2/tools/canvas_executor.rs`：`execute_search` 闭包重构为两个 cfg 块，
  not(lance) 分支消费全部捕获变量后返回空结果 + warning（行为不变，原实现只门控了
  return 语句，后续 `results` 引用悬空）。
- `src/notes_manager.rs`：`extract_clean_text_from_note_content` 与
  `LANCE_FTS_SCORE_COL` 补 lance 门控（仅被 lance 路径调用）。
- `src/commands.rs`：`cleanup_orphan_embeddings` 的 not(lance) 分支消费
  `store` / `all_message_ids` 消除未用变量警告。

### tokenizer_tiktoken 裁剪路径

- `src/utils/token_budget.rs`：启发式回退分支显式 `let _ = model_hint`（该分支不区分
  模型编码）。

## 验证

| 检查 | 结果 |
| --- | --- |
| `cargo check --no-default-features --features mobile-slim` | ✅ 0 error，21 warning |
| `cargo check`（default features，回归验证） | ✅ 0 error，24 warning |

两组 warning 均为**存量债务**（`document_parser` irrefutable if-let ×8、suppaftp
deprecated、ilink_bot/providers 死代码等），mobile-slim 的 21 条是 default 24 条的
子集，本次门控未新增任何 warning（首轮曾引入 9 条 unused import/variable，均已用
cfg 拆分导入清零）。

环境前置（非仓库改动，CI 落地 WI-6 时需注意）：Linux 下 check 需要
`lld`（`src-tauri/.cargo/config.toml` 指定 `-fuse-ld=lld`）、webkit2gtk-4.1 系 dev 包、
`scripts/download-pdfium.sh`（build.rs 校验 `resources/pdfium/libpdfium.so` 存在）、
`protobuf-compiler`（lance-encoding 构建脚本，仅 default/lance 构建需要）。

## 后续（R3+，本轮明确不做）

1. Android workflow 接入：`cargo tauri android build --no-default-features --features mobile-slim`
   真机/CI 验证（本轮仅 host-target cargo check，Android target 还需 NDK 环境）。
2. 运行时语义细化：mobile-slim 下建议直接禁用 embedding 生成入口（当前索引流水线
   会运行到 `ensure_model_profile` 才显式失败）；前端对"语义搜索未启用" warning 的
   展示。
3. `android-release` feature（含 lance/mcp）不受本轮影响；若未来 Android 切换到
   mobile-slim，可对比两者体积/编译时间收益。

## 提交

- commit：`feat(android): fix mobile-slim feature compilation gates`
- 变更：11 个 Rust 文件 + 本报告（不含 Android workflow、不含 Cargo.toml）
