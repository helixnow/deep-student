/**
 * 服务端检索/推理回放（model2_pipeline.rs attach_web_search_replay_items /
 * attach_response_reasoning_replay_item / numbered_web_search_sources）。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';

type JsonObject = { [key: string]: JsonValue };

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : null;
}

/** 把持久化的 web_search_call item 附着到出站 assistant 消息。 */
export function attachWebSearchReplayItems(
  metadata: unknown,
  assistantMsg: Record<string, unknown>,
): void {
  const items = asObject(metadata)?.openai_responses_web_search_items;
  if (!Array.isArray(items)) return;
  const replayable = items
    .filter((item) => asObject(item)?.type === 'web_search_call')
    .map((item) => structuredClone(item));
  if (replayable.length > 0) assistantMsg.response_web_search_items = replayable;
}

/** 无工具纯文本轮：仅 type=reasoning 的 item 作为消息级回放。 */
export function attachResponseReasoningReplayItem(
  metadata: unknown,
  assistantMsg: Record<string, unknown>,
): void {
  const item = asObject(metadata)?.openai_responses_reasoning_item;
  if (item !== undefined && asObject(item)?.type === 'reasoning') {
    assistantMsg.response_reasoning_item = structuredClone(item);
  }
}

/** 服务端 web_search 载荷 → 前端检索块格式编号来源列表。 */
export function numberedWebSearchSources(payload: unknown): JsonValue[] {
  const sources = asObject(payload)?.sources;
  if (!Array.isArray(sources)) return [];
  return sources.map((source, index) => {
    const object = asObject(source);
    return {
      index: index + 1,
      citationTag: `[搜索-${index + 1}]`,
      typeIndex: index + 1,
      title: object?.title ?? null,
      url: object?.url ?? null,
      snippet: object?.snippet ?? null,
      source_type: 'web_search',
    };
  });
}
