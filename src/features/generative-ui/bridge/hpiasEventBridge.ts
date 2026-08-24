/**
 * Hpias Tauri 事件 → HpiasStore 桥接
 *
 * 后端通过 `hpias_event` 通道推送 HpiasEvent JSON，前端写入 researchStore。
 */

import { guardedListen } from '@/utils/guardedListen';
import { useHpiasStore, type HpiasEvent } from '@/stores/researchStore';

/** Tauri 事件通道名（与后端 emit 约定一致） */
export const HPIAS_EVENT_CHANNEL = 'hpias_event';

const RESEARCH_BLOCK_TYPES = new Set(['research-plan', 'research-report', 'paper-digest']);

/** intent 是否含 Research 类块（触发 HPIAS 实时接线） */
export function intentHasResearchBlocks(intent: unknown): boolean {
  if (!intent || typeof intent !== 'object') return false;
  const blocks = (intent as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (b) =>
      b &&
      typeof b === 'object' &&
      typeof (b as { type?: unknown }).type === 'string' &&
      RESEARCH_BLOCK_TYPES.has((b as { type: string }).type),
  );
}

/** 活跃 HPIAS 会话时从 intent 移除 Research 块，避免与实时面板重复 */
export function omitResearchBlocksFromIntent<T extends { blocks: Array<{ type: string }> }>(
  intent: T,
): T {
  return {
    ...intent,
    blocks: intent.blocks.filter((b) => !RESEARCH_BLOCK_TYPES.has(b.type)),
  };
}

/** 规范化 Tauri payload → HpiasEvent */
export function normalizeHpiasEventPayload(payload: unknown): HpiasEvent | null {
  if (!payload || typeof payload !== 'object') return null;

  const obj = payload as Record<string, unknown>;
  const inner =
    obj.event && typeof obj.event === 'object'
      ? (obj.event as Record<string, unknown>)
      : obj;

  if (typeof inner.type !== 'string') return null;
  return inner as HpiasEvent;
}

export interface HpiasEventBridgeHandlerOptions {
  /** 仅处理匹配 session_id 的事件；省略则接收全部 */
  sessionId?: string;
  /** 测试 / 观测钩子 */
  onEvent?: (event: HpiasEvent) => void;
}

/** 构造单条事件处理器（可脱离 listen 单独用于测试） */
export function createHpiasEventBridgeHandler(
  options: HpiasEventBridgeHandlerOptions = {},
): (payload: unknown) => void {
  const handleEvent = useHpiasStore.getState().actions.handleEvent;

  return (payload: unknown) => {
    const event = normalizeHpiasEventPayload(payload);
    if (!event) return;

    if (
      options.sessionId &&
      'session_id' in event &&
      typeof event.session_id === 'string' &&
      event.session_id !== options.sessionId
    ) {
      return;
    }

    handleEvent(event);
    options.onEvent?.(event);
  };
}

/** 启动 Tauri listen；返回 unlisten */
export async function startHpiasEventBridge(
  options: HpiasEventBridgeHandlerOptions = {},
): Promise<() => void | Promise<void>> {
  const handler = createHpiasEventBridgeHandler(options);
  return guardedListen(HPIAS_EVENT_CHANNEL, (event) => {
    handler(event.payload);
  });
}
