/**
 * 翻译弹窗共享类型定义
 */

export interface AlignedSegment {
  src: string;
  tgt: string;
}

export type TranslationDisplayMode = 'aligned' | 'streaming';

/**
 * 与 src-tauri/src/translation/chat_popover.rs 的 `ChatTranslationEvent` 对应。
 *
 * 协议演进（向后兼容，只增不改名）：
 * - 新后端 chunk 只发 `delta`（前端自行拼接，避免 O(n²) IPC）；
 * - `accumulated` 为旧协议的全量累积字段，可能缺失；
 *   前端应优先用 `delta` 拼接，仅在 `delta` 缺失时退回 `accumulated`。
 */
export type ChatTranslationEventPayload =
  | { type: 'chunk'; delta?: string; accumulated?: string }
  | { type: 'complete' }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

/** 与 chat_popover.rs 的 `ChatTranslationRequest` 字段一一对应 */
export interface ChatTranslationRequestPayload {
  request_id: string;
  source: string;
  src_lang: string;
  tgt_lang: string;
  context_before: string | null;
  context_after: string | null;
}
