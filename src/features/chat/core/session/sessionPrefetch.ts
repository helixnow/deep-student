/**
 * 会话 hover 预取
 *
 * 用户悬停侧边栏会话行 ≥120ms（hover intent）时，提前完成
 * Store 创建 + TauriAdapter setup + chat_v2_load_session 全量加载。
 * 点击时 useConnectedSession 命中已就绪的 adapter/store，首帧几乎即时。
 *
 * 安全边界：
 * - 预取后立即 adapterManager.release()，净引用计数为 0，
 *   不改变适配器生命周期语义（cleanup 仍由会话销毁触发）。
 * - 已加载的会话（LRU 命中）直接跳过，不产生任何 IPC。
 * - 并发预取上限 2，防止鼠标快速扫过列表引发请求风暴
 *   （hover intent 延迟本身已过滤大部分扫过场景）。
 * - 预取失败静默：点击时会走正常加载路径重试并报错。
 */

import { sessionManager } from './sessionManager';
import { adapterManager } from '../../adapters/AdapterManager';

const MAX_CONCURRENT_PREFETCH = 2;
const HOVER_INTENT_DELAY_MS = 120;

const inflight = new Set<string>();
const hoverTimers = new Map<string, number>();

async function prefetchSessionNow(sessionId: string): Promise<void> {
  if (inflight.size >= MAX_CONCURRENT_PREFETCH) return;
  if (inflight.has(sessionId)) return;

  // LRU 命中且数据已加载：无需预取
  const cached = sessionManager.get(sessionId);
  if (cached?.getState().isDataLoaded) return;

  inflight.add(sessionId);
  try {
    const store = cached ?? sessionManager.getOrCreate(sessionId);
    await adapterManager.getOrCreate(sessionId, store);
    adapterManager.release(sessionId);
  } catch {
    // 静默：正常点击路径会重试并向用户报错
  } finally {
    inflight.delete(sessionId);
  }
}

/** 会话行 onMouseEnter 时调用；与 cancelSessionHoverPrefetch 配对 */
export function beginSessionHoverPrefetch(sessionId: string): void {
  if (!sessionId || !sessionId.startsWith('sess_')) return;
  if (hoverTimers.has(sessionId)) return;
  const timer = window.setTimeout(() => {
    hoverTimers.delete(sessionId);
    void prefetchSessionNow(sessionId);
  }, HOVER_INTENT_DELAY_MS);
  hoverTimers.set(sessionId, timer);
}

/** 会话行 onMouseLeave 时调用，取消未触发的 hover intent */
export function cancelSessionHoverPrefetch(sessionId: string): void {
  const timer = hoverTimers.get(sessionId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    hoverTimers.delete(sessionId);
  }
}
