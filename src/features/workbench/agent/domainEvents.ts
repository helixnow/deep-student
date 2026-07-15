/**
 * ACR 域事件订阅基建 — R1-18
 *
 * 经 eventHub.hubListen 统一订阅（同事件名全局一个 Tauri listener，多 handler 扇出由本模块 + hub 保证）。
 * 载荷契约见 types.ts DomainChangePayload / docs/dev/acr/DESIGN.md §5.6。
 *
 * API（供 drivers / DevPanel；types.ts 只读，接口注释落本文件）：
 *   registerDomainListener(eventName, handler): () => void
 *   recordAcrReceiptSummary(summary) — StageManager 终态回执写入（R1-06 接线）
 *   useRecentDomainEvents / useRecentReceiptSummaries — DevPanel 只读
 *
 * `dstu:change`：registerDomainListener 走 hubListen 广播；同时 setHubKeyExtractor
 * 兼容 resourceId / entityIds[0] / id，供 hubListenKeyed 精准路由。
 */
import { useSyncExternalStore } from 'react';
import { hubListen, setHubKeyExtractor } from '../core/eventHub';
import type { AcrReceiptStatus, DomainChangePayload } from './types';

/** 已知域事件名（供 DevPanel / 文档展示；注册不限于此列表） */
export const KNOWN_DOMAIN_EVENTS = [
  'todo://changed',
  'qbank://changed',
  'review://changed',
  'fsrs://changed',
  'memory://changed',
  'dstu:change',
] as const;

export type KnownDomainEvent = (typeof KNOWN_DOMAIN_EVENTS)[number];

export type DomainEventHandler = (payload: DomainChangePayload) => void;

/** DevPanel 环形缓冲条目 */
export interface DomainEventRecord {
  eventName: string;
  payload: DomainChangePayload;
  at: number;
}

/** DevPanel「最近回执」摘要（非完整 AcrReceipt，只读展示用） */
export interface AcrReceiptSummary {
  runId: string;
  status: AcrReceiptStatus;
  mode?: 'frontend' | 'backend' | 'suggestion';
  applied?: number;
  totalOps?: number;
  message?: string;
  at: number;
}

const RING_CAPACITY = 5;
const RECEIPT_CAPACITY = 5;

/** 可变缓冲；对外快照每次更新换新引用，满足 useSyncExternalStore 身份比较 */
const ringBuf: DomainEventRecord[] = [];
let ringSnapshot: readonly DomainEventRecord[] = [];
const ringListeners = new Set<() => void>();

const receiptBuf: AcrReceiptSummary[] = [];
let receiptSnapshot: readonly AcrReceiptSummary[] = [];
const receiptListeners = new Set<() => void>();

/** 每事件名一组 handler；仅在首个订阅者时挂 hubListen */
const domainHandlers = new Map<string, Set<DomainEventHandler>>();
const hubUnsubs = new Map<string, () => void>();

let dstuKeyExtractorInstalled = false;
let dstuKeyExtractorRestore: (() => void) | null = null;

/**
 * 从 DSTU path（如 `/高考复习/note_abc`）取末段 resourceId。
 * R2-04：与 DOM `data-agent-entity="files:{id}"` / Finder 行 id 对齐。
 */
export function resourceIdFromDstuPath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1]!;
  // 虚拟根（@trash 等）本身不是资源 id
  if (last.startsWith('@')) return null;
  return last;
}

/**
 * 统一收集域事件实体 id（camelCase entityIds 优先，兼容 snake_case / dstu 字段）。
 * R2-04：Rust→FE→agentFlash 全链命名一致入口。
 */
export function collectDomainEntityIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  const out: string[] = [];
  const push = (id: unknown) => {
    if (typeof id === 'string' && id.length > 0 && !out.includes(id))
      out.push(id);
  };

  for (const key of ['entityIds', 'entity_ids'] as const) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const id of arr) push(id);
    }
  }
  if (out.length > 0) return out;

  for (const key of [
    'resourceId',
    'resource_id',
    'documentId',
    'document_id',
    'nodeId',
    'id',
  ] as const) {
    push(obj[key]);
  }
  if (out.length > 0) return out;

  const node = obj.node;
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    push(n.id);
    push(n.resourceId);
  }
  if (out.length > 0) return out;

  push(resourceIdFromDstuPath(obj.path));
  return out;
}

/**
 * dstu:change 键提取：兼容 resourceId / entityIds[0] / path 末段 / node.id。
 * 仅影响 hubListenKeyed；broadcast（registerDomainListener）仍收全部事件。
 */
export function dstuChangeKeyExtractor(payload: unknown): string | null {
  const ids = collectDomainEntityIds(payload);
  return ids[0] ?? null;
}

function ensureDstuKeyExtractor(): void {
  if (dstuKeyExtractorInstalled) return;
  dstuKeyExtractorInstalled = true;
  dstuKeyExtractorRestore = setHubKeyExtractor(
    'dstu:change',
    dstuChangeKeyExtractor,
  );
}

/** 模块加载即安装 dstu:change key extractor（幂等） */
ensureDstuKeyExtractor();

function publishRing(): void {
  ringSnapshot = ringBuf.slice();
  for (const fn of Array.from(ringListeners)) {
    try {
      fn();
    } catch (err) {
      console.error('[acr:domainEvents] ring listener threw', err);
    }
  }
}

function publishReceipts(): void {
  receiptSnapshot = receiptBuf.slice();
  for (const fn of Array.from(receiptListeners)) {
    try {
      fn();
    } catch (err) {
      console.error('[acr:domainEvents] receipt listener threw', err);
    }
  }
}

/**
 * 记录一条域事件到环形缓冲（最近 RING_CAPACITY 条）。
 * 供 registerDomainListener 内部调用；测试可直接调用。
 */
export function recordDomainEvent(
  eventName: string,
  payload: DomainChangePayload,
): void {
  ringBuf.push({ eventName, payload, at: Date.now() });
  if (ringBuf.length > RING_CAPACITY) {
    ringBuf.splice(0, ringBuf.length - RING_CAPACITY);
  }
  publishRing();
}

/**
 * 记录一条回执摘要（最近 RECEIPT_CAPACITY 条）。
 * 供 StageManager apply 终态调用（R1-06 / R2 接线）；DevPanel 只读展示。
 */
export function recordAcrReceiptSummary(
  summary: Omit<AcrReceiptSummary, 'at'> & { at?: number },
): void {
  const previousIndex = receiptBuf.findIndex(
    (item) => item.runId === summary.runId,
  );
  if (previousIndex >= 0) receiptBuf.splice(previousIndex, 1);
  receiptBuf.push({
    runId: summary.runId,
    status: summary.status,
    mode: summary.mode,
    applied: summary.applied,
    totalOps: summary.totalOps,
    message: summary.message,
    at: summary.at ?? Date.now(),
  });
  if (receiptBuf.length > RECEIPT_CAPACITY) {
    receiptBuf.splice(0, receiptBuf.length - RECEIPT_CAPACITY);
  }
  publishReceipts();
}

function subscribeRing(listener: () => void): () => void {
  ringListeners.add(listener);
  return () => {
    ringListeners.delete(listener);
  };
}

function getRingSnapshot(): readonly DomainEventRecord[] {
  return ringSnapshot;
}

function subscribeReceipts(listener: () => void): () => void {
  receiptListeners.add(listener);
  return () => {
    receiptListeners.delete(listener);
  };
}

function getReceiptSnapshot(): readonly AcrReceiptSummary[] {
  return receiptSnapshot;
}

/** React：订阅最近域事件环形缓冲（只读快照） */
export function useRecentDomainEvents(): readonly DomainEventRecord[] {
  return useSyncExternalStore(subscribeRing, getRingSnapshot, getRingSnapshot);
}

/** React：订阅最近回执摘要（只读快照） */
export function useRecentReceiptSummaries(): readonly AcrReceiptSummary[] {
  return useSyncExternalStore(
    subscribeReceipts,
    getReceiptSnapshot,
    getReceiptSnapshot,
  );
}

/** 仅供测试：清空环形缓冲与订阅表 */
export function resetDomainEventRingForTests(): void {
  ringBuf.length = 0;
  publishRing();
  receiptBuf.length = 0;
  publishReceipts();
}

/** 仅供测试：拆除全部域监听（含 hubListen）并清空环形缓冲 */
export function resetDomainListenersForTests(): void {
  for (const unsub of hubUnsubs.values()) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  hubUnsubs.clear();
  domainHandlers.clear();
  ringBuf.length = 0;
  publishRing();
  receiptBuf.length = 0;
  publishReceipts();
}

/** 仅供测试：同步读取环形缓冲（不经 React） */
export function getRecentDomainEventsForTests(): readonly DomainEventRecord[] {
  return ringSnapshot;
}

/** 仅供测试：同步读取回执缓冲 */
export function getRecentReceiptSummariesForTests(): readonly AcrReceiptSummary[] {
  return receiptSnapshot;
}

/**
 * 宽松校验：非对象包装成兜底载荷；对象则透传并补齐缺省字段。
 * source 仅接受 'agent'|'user'（兼容 R1-04 可能发出的 'ai' → agent），其余归一为 'user'。
 * R2-04：entity_ids → entityIds；dstu path/node 回填 entityIds，保证 flash 键一致。
 */
export function normalizeDomainPayload(raw: unknown): DomainChangePayload {
  if (!raw || typeof raw !== 'object') {
    return { source: 'user', action: 'unknown' };
  }
  const obj = raw as Record<string, unknown>;
  let source: DomainChangePayload['source'] = 'user';
  if (obj.source === 'agent' || obj.source === 'ai') source = 'agent';
  else if (obj.source === 'user') source = 'user';
  const action =
    typeof obj.action === 'string' && obj.action ? obj.action : 'unknown';
  const out: DomainChangePayload = { ...obj, source, action };
  const entityIds = collectDomainEntityIds(obj);
  if (entityIds.length > 0) {
    out.entityIds = entityIds;
  }
  if (typeof obj.runId === 'string') {
    out.runId = obj.runId;
  } else if (typeof obj.run_id === 'string') {
    out.runId = obj.run_id;
  }
  return out;
}

function ensureHubSubscription(
  eventName: string,
  handlers: Set<DomainEventHandler>,
): void {
  if (hubUnsubs.has(eventName)) return;
  if (eventName === 'dstu:change') ensureDstuKeyExtractor();
  const unsub = hubListen(eventName, (raw: unknown) => {
    const payload = normalizeDomainPayload(raw);
    recordDomainEvent(eventName, payload);
    for (const fn of Array.from(handlers)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(
          `[acr:domainEvents] handler for "${eventName}" threw`,
          err,
        );
      }
    }
  });
  hubUnsubs.set(eventName, unsub);
}

/**
 * 注册域事件监听。内部经 hubListen（同事件名全局一个 Tauri listener）。
 * 多 handler 由本模块扇出；环形缓冲每事件只记一条。
 * 返回同步退订函数。
 */
export function registerDomainListener(
  eventName: string,
  handler: DomainEventHandler,
): () => void {
  let handlers = domainHandlers.get(eventName);
  if (!handlers) {
    handlers = new Set();
    domainHandlers.set(eventName, handlers);
  }
  handlers.add(handler);
  ensureHubSubscription(eventName, handlers);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const set = domainHandlers.get(eventName);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      domainHandlers.delete(eventName);
      const unsub = hubUnsubs.get(eventName);
      hubUnsubs.delete(eventName);
      if (unsub) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      }
    }
  };
}

/** 仅供测试：暴露 dstu key extractor 是否已安装（不拆除，避免跨测污染） */
export function isDstuKeyExtractorInstalledForTests(): boolean {
  return dstuKeyExtractorInstalled && dstuKeyExtractorRestore != null;
}
