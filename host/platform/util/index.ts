/**
 * 平台通用工具（F4 发布）。语义参照：
 * - `src-tauri/crates/dstu-util/src/utils/unicode.rs` / `text.rs`；
 * - `src-tauri/crates/dstu-util/src/utils/model_special_tokens.rs`（GLM/Qwen 包装 token 清理）；
 * - Rust 标准库 `str::trim*`、`String::truncate`、`FromUtf8Error`；
 * - `http 1.5.0/src/status.rs::canonical_reason`。
 *
 * 与 `portable.ts` 导出完全相同的值，运行时不加载 Node 模块。依赖 Node 的 ZIP（`zip 0.6.6`）、QR PNG
 * 与返回 `Buffer` 的 `decodeBase64Standard` 只从桌面入口 `node.ts` 导出（`tests/entries.test.ts`）。
 */
export * from './portable.ts';
