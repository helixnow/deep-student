/**
 * Super 收件箱投递消息的来源（MessageMeta.inboundOrigin）解析。
 *
 * 后端（super_session::inbox）把收件箱 drain 成一条持久化 user 消息，并在
 * `_meta.inboundOrigin` 上附带结构化来源。UI 只依赖下面的宽松形态，字段缺失时优雅降级：
 *
 *   {
 *     kind?: 'super_inbox',
 *     items: Array<{
 *       kind: 'worker' | 'worker_completion' | 'worker.interrupted' | 'external' | ...,
 *       status?: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timeout' | ...,
 *       workerId? | agentSessionId? | agent_session_id?,   // Worker 会话 ID（「查看」用）
 *       title? | workerTitle?,                             // Worker 标题
 *       source? | sender?,                                 // 外部事件来源
 *       summary? | preview?                                // 单条摘要
 *     }>
 *   }
 *
 * 也接受 items 直接为数组或单条对象。camelCase 与 snake_case 均兼容。
 */

import type { Message } from '../core/types/message';

export type InboundItemKind = 'worker' | 'external' | 'other';

export type InboundWorkerStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timeout'
  | 'message';

export interface InboundItem {
  kind: InboundItemKind;
  /** worker 终态（仅 kind='worker'） */
  status: InboundWorkerStatus;
  workerSessionId: string | null;
  title: string | null;
  source: string | null;
  summary: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function normalizeStatus(raw: string | null, kindRaw: string): InboundWorkerStatus {
  const text = `${raw ?? ''} ${kindRaw}`.toLowerCase();
  if (/(fail|error)/.test(text)) return 'failed';
  if (/(cancel|closed|abort)/.test(text)) return 'cancelled';
  if (/interrupt|unknown/.test(text)) return 'interrupted';
  if (/timeout|timed_out/.test(text)) return 'timeout';
  if (/(complete|success|done|finished|result)/.test(text)) return 'completed';
  return 'message';
}

function normalizeItem(raw: unknown): InboundItem | null {
  const record = asRecord(raw);
  if (!record) return null;
  const kindRaw = (pickString(record, ['kind', 'type', 'origin']) ?? '').toLowerCase();
  const source = pickString(record, ['source', 'sender', 'from']);
  const workerSessionId = pickString(record, [
    'workerId',
    'worker_id',
    'agentSessionId',
    'agent_session_id',
    'workerSessionId',
    'worker_session_id',
  ]);
  const isExternal = kindRaw.includes('external') || (source?.startsWith('external:') ?? false);
  const isWorker = !isExternal && (kindRaw.includes('worker') || kindRaw.includes('agent') || !!workerSessionId);
  const kind: InboundItemKind = isExternal ? 'external' : isWorker ? 'worker' : 'other';
  return {
    kind,
    status: normalizeStatus(pickString(record, ['status', 'state']), kindRaw),
    workerSessionId,
    title: pickString(record, ['title', 'workerTitle', 'worker_title', 'taskTitle', 'task_title']),
    source: source?.replace(/^external:/, '') ?? null,
    summary: pickString(record, ['summary', 'preview', 'excerpt']),
  };
}

/** 解析 inboundOrigin；非法输入返回空数组 */
export function parseInboundOrigin(origin: unknown): InboundItem[] {
  if (origin == null) return [];
  const record = asRecord(origin);
  let list: unknown[];
  if (Array.isArray(origin)) {
    list = origin;
  } else if (record && Array.isArray(record.items)) {
    list = record.items;
  } else if (record && Array.isArray(record.entries)) {
    list = record.entries;
  } else if (record) {
    list = [record];
  } else {
    list = [];
  }
  return list.map(normalizeItem).filter((item): item is InboundItem => item !== null);
}

/** 是否为 Super 收件箱投递产生的事件消息（不可编辑，渲染为事件卡片） */
export function isInboundUserMessage(message: Pick<Message, 'role' | '_meta'> | null | undefined): boolean {
  return message?.role === 'user' && message._meta?.inboundOrigin != null;
}
