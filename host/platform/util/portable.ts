/**
 * 平台通用工具的可移植入口：只含纯函数与 Web 标准 API（`TextEncoder`/`TextDecoder`），
 * 运行时不加载任何 Node 模块，桌面与移动端共用。
 *
 * 与 `index.ts` 的差异：
 * - 不含 ZIP（`zip.ts`，依赖 `node:zlib`/`Buffer`/`process`）与 QR PNG（`qr.ts`，依赖 `node:zlib`）；
 * - `decodeBase64Standard` 返回普通 `Uint8Array`（`index.ts` / `api.ts` 版本返回 `Buffer`）。
 * 其余导出与 `index.ts` 是同一个值。
 */
export type { TruncateOptions } from './api.ts';

export {
  MODEL_SPECIAL_TOKENS,
  ModelWrapTokenPolicy,
  ModelWrapTokenStreamFilter,
  create_model_wrap_token_filter,
  for_provider_model,
} from './model-special-tokens.ts';

export {
  isRustWhitespace,
  rustTrimStart,
  rustTrimEnd,
  rustTrim,
  trim,
  trimStart,
  trimEnd,
  charCount,
  takeChars,
} from './text.ts';

export {
  Utf8DecodeError,
  compareUtf8,
  decodeUtf8Lossy,
  decodeUtf8Strict,
  encodeUtf8,
  isCharBoundary,
  truncateUtf8,
  truncateUtf8Exact,
  utf8ByteLength,
  utf8ErrorMessage,
  validUtf8Prefix,
} from './utf8.ts';
export type { Utf8ValidPrefix } from './utf8.ts';
export { decodeBase64Standard, type Base64DecodeResult } from './base64-core.ts';
export { JsonReader, JsonSyntaxError, classifyJsonNumber, jsonUnexpected, objectLastWins, parseJsonDocument, parseJsonDocumentBytes, ryuFormat } from './json-exact.ts';
export type { JsonNode, JsonNumber, JsonValueNumber, JsonTokenKind } from './json-exact.ts';
export { jsonNumberToRawJSON, stringifyJsonValue } from './json-value.ts';
export type { JsonRawNumber } from './json-value.ts';
export { f32ToJsonNumber } from './f32-json.ts';
export { formatRustFixed } from './rust-fixed.ts';
export { DIFFICULTY_RUBRIC } from './prompt-contracts.ts';
export { canonicalReason, statusLine } from './http-status.ts';
export { Crc32, crc32 } from './crc32.ts';

export {
  DEFAULT_SSE_MAX_BUFFER_SIZE,
  SseEventBuffer,
  SseLineBuffer,
  Utf8StreamDecoder,
  extractStreamDataPayload,
  setSseBufferLogger,
} from './sse-buffer.ts';
export type { SseBufferLogLevel, SseBufferLogger } from './sse-buffer.ts';
