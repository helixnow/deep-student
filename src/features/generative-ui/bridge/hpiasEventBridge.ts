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
const RESEARCH_SURFACE_ACTION_IDS = new Set([
  'copy-report',
  'export-plan',
  'export-intent',
  'copy-intent',
  'copy-block',
]);

function isResearchOnlyActionBar(block: { type: string; props?: unknown }): boolean {
  if (block.type !== 'action-bar' || !block.props || typeof block.props !== 'object') {
    return false;
  }

  const actions = (block.props as { actions?: unknown }).actions;
  return (
    Array.isArray(actions) &&
    actions.length > 0 &&
    actions.every(
      (action) =>
        action &&
        typeof action === 'object' &&
        typeof (action as { id?: unknown }).id === 'string' &&
        RESEARCH_SURFACE_ACTION_IDS.has((action as { id: string }).id),
    )
  );
}

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

/** 活跃 HPIAS 会话时移除 Research 块及其孤立操作栏，避免与实时面板重复 */
export function omitResearchBlocksFromIntent<
  T extends { blocks: Array<{ type: string; props?: unknown }> },
>(
  intent: T,
): T {
  const removesResearchBlocks = intent.blocks.some((block) =>
    RESEARCH_BLOCK_TYPES.has(block.type),
  );

  return {
    ...intent,
    blocks: intent.blocks.filter(
      (block) =>
        !RESEARCH_BLOCK_TYPES.has(block.type) &&
        !(removesResearchBlocks && isResearchOnlyActionBar(block)),
    ),
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

    if (options.sessionId) {
      // A scoped bridge must fail closed. Previously an event with no
      // session_id (or a malformed non-string id) bypassed the mismatch check
      // and contaminated the requested session's research state.
      if (
        !('session_id' in event) ||
        typeof event.session_id !== 'string' ||
        event.session_id !== options.sessionId
      ) {
        return;
      }
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

let sharedListen: Promise<() => void | Promise<void>> | null = null;
let sharedRefs = 0;

/**
 * 进程内共享一条 `hpias_event` 订阅。
 * 多个 Chat 研究块只 listen 一次，避免 synthesis 等事件被重复折叠。
 * 不按 session 过滤：路由交给 HpiasStore 切片。
 */
export async function retainSharedHpiasEventBridge(): Promise<() => void | Promise<void>> {
  sharedRefs += 1;
  if (!sharedListen) {
    sharedListen = startHpiasEventBridge({});
  }
  const listenPromise = sharedListen;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    sharedRefs = Math.max(0, sharedRefs - 1);
    if (sharedRefs === 0 && sharedListen === listenPromise) {
      sharedListen = null;
      const unlisten = await listenPromise;
      await unlisten();
    }
  };
}

/** 单测重置共享订阅，避免跨用例泄漏 listen。 */
export function resetSharedHpiasEventBridgeForTests(): void {
  sharedRefs = 0;
  sharedListen = null;
}
