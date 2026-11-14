/**
 * 平台通用工具（F4 发布）：Rust/chrono/crate 语义的纯函数集合。可移植：运行时只用纯函数与
 * `TextEncoder`/`TextDecoder`，每个值都与 `portable.ts` 中的同名值相同（`tests/entries.test.ts`）。
 *
 * 本文件导出：
 * - `TruncateOptions`（trim、UTF-8 截断等函数本身从 `index.ts` / `portable.ts` 导入）；
 * - 模型包装 token 清理（GLM/Qwen 策略与流式过滤器）；
 * - SSE/UTF-8 流式解码（`Utf8StreamDecoder`、`SseLineBuffer`、`SseEventBuffer`）；
 * - serde_json 1.0.149 流式读取（`JsonReader`）与 base64 0.22 STANDARD 解码（返回 `Uint8Array`）。
 *
 * ZIP 读写、QR PNG 与返回 `Buffer` 的 `decodeBase64Standard` 依赖 Node，只从桌面入口 `node.ts` 导出。
 */

// ------------------------------------------------------------------ UTF-8

/** Rust `str::truncate` 的精确语义：越界或落在字符中间时抛错。 */
export interface TruncateOptions {
  /** 超出长度时是抛错（Rust `truncate`）还是截到字符串末尾。默认抛错。 */
  allowShorter?: boolean;
}

// ------------------------------------------------------- 模型包装 token 清理

export {
  MODEL_SPECIAL_TOKENS,
  ModelWrapTokenPolicy,
  ModelWrapTokenStreamFilter,
  create_model_wrap_token_filter,
  for_provider_model,
} from './model-special-tokens.ts';

// ------------------------------------------------------- SSE / UTF-8 流

export {
  DEFAULT_SSE_MAX_BUFFER_SIZE,
  SseEventBuffer,
  SseLineBuffer,
  Utf8StreamDecoder,
  extractStreamDataPayload,
  setSseBufferLogger,
} from './sse-buffer.ts';
export type { SseBufferLogLevel, SseBufferLogger } from './sse-buffer.ts';

// ------------------------------------------------------- serde_json / base64 解码原语

export {
  JsonReader,
  JsonSyntaxError,
  classifyJsonNumber,
  jsonUnexpected,
  objectLastWins,
  parseJsonDocument,
  parseJsonDocumentBytes,
  ryuFormat,
} from './json-exact.ts';
export type { JsonNode, JsonNumber, JsonValueNumber, JsonTokenKind } from './json-exact.ts';
export { jsonNumberToRawJSON, stringifyJsonValue } from './json-value.ts';
export type { JsonRawNumber } from './json-value.ts';
export { decodeBase64Standard } from './base64-core.ts';
export type { Base64DecodeResult } from './base64-core.ts';
/** serde_json arbitrary_precision 的 f32 出站投影；不适用于 f64 或内部运算。 */
export { f32ToJsonNumber } from './f32-json.ts';
/** Rust `format!("{:.N}", f64)`：中点五成双、负零保留符号、不用指数形式（`toFixed` 都不是）。 */
export { formatRustFixed } from './rust-fixed.ts';
export { DIFFICULTY_RUBRIC } from './prompt-contracts.ts';
