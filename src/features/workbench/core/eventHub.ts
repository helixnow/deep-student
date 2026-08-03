/**
 * eventHub — workbench 模式下的 Tauri 事件单一订阅中枢（主责 P9）
 *
 * 设计文档 §5.5 事件纪律：Tauri 后端事件由 workbench 外层的单一中枢订阅，
 * 按 payload 中的 sessionId / resourceId 路由到目标窗口/应用回调；
 * 禁止每个窗口自行 `listen` 全局事件。
 *
 * 保证：
 * - 同一事件名无论多少订阅者，全局只存在一个 Tauri `listen`；
 * - 最后一个订阅者取消后自动 unlisten（含 listen Promise 尚未 resolve 的竞态）；
 * - `hubListenKeyed` 按业务键精准路由；键提取默认覆盖
 *   sessionId / session_id / resourceId / resource_id / documentId / document_id / id，
 *   可用 `setHubKeyExtractor` 按事件名定制（供 P7 chat / P8 资源应用接入）。
 */
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type HubHandler<T = unknown> = (payload: T) => void;
/** 从 payload 中提取路由键；返回 null 表示无法路由（keyed 订阅者收不到） */
export type HubKeyExtractor = (payload: unknown) => string | null;

interface HubEntry {
  eventName: string;
  /** 广播订阅者：收到该事件的全部 payload */
  broadcast: Set<HubHandler>;
  /** 按路由键分组的订阅者 */
  keyed: Map<string, Set<HubHandler>>;
  unlisten: UnlistenFn | null;
  /** listen() 尚未 resolve 时的挂起 Promise（防止重复 listen） */
  starting: Promise<void> | null;
}

const entries = new Map<string, HubEntry>();
/** 自定义键提取器独立存放，entry 被回收后仍保留配置 */
const keyExtractors = new Map<string, HubKeyExtractor>();

const DEFAULT_KEY_FIELDS = [
  'sessionId',
  'session_id',
  'resourceId',
  'resource_id',
  'documentId',
  'document_id',
  'id',
] as const;

export function defaultHubKeyExtractor(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  for (const field of DEFAULT_KEY_FIELDS) {
    const value = obj[field];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** 为某事件名定制路由键提取（覆盖默认字段探测）。返回恢复默认的函数。 */
export function setHubKeyExtractor(eventName: string, extractor: HubKeyExtractor): () => void {
  keyExtractors.set(eventName, extractor);
  return () => {
    if (keyExtractors.get(eventName) === extractor) keyExtractors.delete(eventName);
  };
}

function extractKey(eventName: string, payload: unknown): string | null {
  const custom = keyExtractors.get(eventName);
  try {
    return custom ? custom(payload) : defaultHubKeyExtractor(payload);
  } catch (err) {
    console.warn(`[workbench:eventHub] key extractor for "${eventName}" threw`, err);
    return null;
  }
}

function handlerCount(entry: HubEntry): number {
  let n = entry.broadcast.size;
  for (const set of entry.keyed.values()) n += set.size;
  return n;
}

function dispatch(entry: HubEntry, payload: unknown): void {
  // 快照后遍历：允许 handler 内部再订阅/取消而不影响本次分发
  for (const fn of Array.from(entry.broadcast)) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[workbench:eventHub] broadcast handler for "${entry.eventName}" threw`, err);
    }
  }
  if (entry.keyed.size === 0) return;
  const key = extractKey(entry.eventName, payload);
  if (key == null) return;
  const set = entry.keyed.get(key);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try {
      fn(payload);
    } catch (err) {
      console.error(
        `[workbench:eventHub] keyed handler for "${entry.eventName}"[${key}] threw`,
        err,
      );
    }
  }
}

function ensureEntry(eventName: string): HubEntry {
  let entry = entries.get(eventName);
  if (!entry) {
    entry = { eventName, broadcast: new Set(), keyed: new Map(), unlisten: null, starting: null };
    entries.set(eventName, entry);
  }
  return entry;
}

function ensureListening(entry: HubEntry): void {
  if (entry.unlisten || entry.starting) return;
  entry.starting = listen(entry.eventName, (event) => dispatch(entry, event.payload))
    .then((fn) => {
      entry.starting = null;
      // listen 建立期间订阅者已全部离开 → 立即拆除
      if (handlerCount(entry) === 0) {
        fn();
        entries.delete(entry.eventName);
        return;
      }
      entry.unlisten = fn;
    })
    .catch((err) => {
      entry.starting = null;
      console.warn(`[workbench:eventHub] listen("${entry.eventName}") failed`, err);
    });
}

function maybeTeardown(entry: HubEntry): void {
  if (handlerCount(entry) > 0) return;
  if (entry.unlisten) {
    const fn = entry.unlisten;
    entry.unlisten = null;
    try {
      fn();
    } catch (err) {
      console.warn(`[workbench:eventHub] unlisten("${entry.eventName}") failed`, err);
    }
  }
  // starting 挂起时由 ensureListening 的 then 回调兜底拆除
  if (!entry.starting) entries.delete(entry.eventName);
}

/**
 * 订阅某 Tauri 事件（广播：收到全部 payload）。
 * 返回同步取消函数；同一事件名多次订阅只产生一个 Tauri listener。
 */
export function hubListen<T = unknown>(eventName: string, handler: HubHandler<T>): () => void {
  const entry = ensureEntry(eventName);
  const fn = handler as HubHandler;
  entry.broadcast.add(fn);
  ensureListening(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    entry.broadcast.delete(fn);
    maybeTeardown(entry);
  };
}

/**
 * 按路由键订阅某 Tauri 事件：只有 payload 中提取的键 === key 时才回调。
 * 典型用法：窗口按自己的 sessionId / resourceId 订阅流式事件。
 */
export function hubListenKeyed<T = unknown>(
  eventName: string,
  key: string,
  handler: HubHandler<T>,
): () => void {
  const entry = ensureEntry(eventName);
  const fn = handler as HubHandler;
  let set = entry.keyed.get(key);
  if (!set) {
    set = new Set();
    entry.keyed.set(key, set);
  }
  set.add(fn);
  ensureListening(entry);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = entry.keyed.get(key);
    if (current) {
      current.delete(fn);
      if (current.size === 0) entry.keyed.delete(key);
    }
    maybeTeardown(entry);
  };
}

export interface EventHubDiagnostics {
  eventName: string;
  /** Tauri listener 是否已建立（或正在建立） */
  active: boolean;
  broadcastCount: number;
  keyedCounts: Record<string, number>;
}

/** 诊断/测试用：当前中枢的订阅拓扑 */
export function getEventHubDiagnostics(): EventHubDiagnostics[] {
  return Array.from(entries.values()).map((entry) => ({
    eventName: entry.eventName,
    active: entry.unlisten != null || entry.starting != null,
    broadcastCount: entry.broadcast.size,
    keyedCounts: Object.fromEntries(
      Array.from(entry.keyed.entries()).map(([k, set]) => [k, set.size]),
    ),
  }));
}

/** 卸载 workbench / 测试重置：拆除全部 Tauri listener 与订阅 */
export function resetEventHub(): void {
  for (const entry of entries.values()) {
    entry.broadcast.clear();
    entry.keyed.clear();
    if (entry.unlisten) {
      try {
        entry.unlisten();
      } catch {
        /* 已失效的 listener 忽略 */
      }
      entry.unlisten = null;
    }
  }
  entries.clear();
  keyExtractors.clear();
}
