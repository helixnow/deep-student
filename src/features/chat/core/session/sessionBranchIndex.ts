/**
 * 会话分支索引 —— 「已从此处分支」角标的数据源。
 *
 * 后端 chat_v2_branch_session 会在新会话 metadata 中写入
 * `branchedFrom: { sessionId, messageId, branchedAt }`。本模块把会话列表
 * 反向索引为「源会话 → 源消息 → 分支会话列表」，供 MessageItem 在原会话的
 * 被分支消息下渲染可导航角标：
 * - ChatV2Page 的 sessions 列表变化时全量重建（持久：重启后仍可见）；
 * - 分支创建成功时 recordSessionBranch 立即补记（角标即时出现，不等列表刷新）。
 */
import { useSyncExternalStore } from 'react';

export interface SessionBranchTarget {
  /** 分支出去的新会话 ID */
  sessionId: string;
  title?: string | null;
  branchedAt?: string | null;
}

interface BranchedFromMeta {
  sessionId: string;
  messageId: string;
  branchedAt?: string | null;
}

const EMPTY_TARGETS: SessionBranchTarget[] = [];

// sourceSessionId -> messageId -> targets
let index = new Map<string, Map<string, SessionBranchTarget[]>>();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

function readBranchedFrom(metadata: unknown): BranchedFromMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).branchedFrom;
  if (!raw || typeof raw !== 'object') return null;
  const { sessionId, messageId, branchedAt } = raw as Record<string, unknown>;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (typeof messageId !== 'string' || !messageId) return null;
  return {
    sessionId,
    messageId,
    branchedAt: typeof branchedAt === 'string' ? branchedAt : null,
  };
}

function insertTarget(
  map: Map<string, Map<string, SessionBranchTarget[]>>,
  from: BranchedFromMeta,
  target: SessionBranchTarget,
): boolean {
  const byMessage = map.get(from.sessionId) ?? new Map<string, SessionBranchTarget[]>();
  const targets = byMessage.get(from.messageId) ?? [];
  if (targets.some((existing) => existing.sessionId === target.sessionId)) return false;
  byMessage.set(from.messageId, [...targets, target]);
  map.set(from.sessionId, byMessage);
  return true;
}

export interface BranchIndexSessionLike {
  id: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** 用会话列表全量重建索引（ChatV2Page sessions 变化时调用）。 */
export function rebuildSessionBranchIndex(sessions: readonly BranchIndexSessionLike[]): void {
  const next = new Map<string, Map<string, SessionBranchTarget[]>>();
  for (const session of sessions) {
    const from = readBranchedFrom(session.metadata);
    if (!from) continue;
    insertTarget(next, from, {
      sessionId: session.id,
      title: session.title ?? null,
      branchedAt: from.branchedAt ?? null,
    });
  }
  index = next;
  notify();
}

/** 分支创建成功后立即补记一条（角标即时出现，不等待列表重建）。 */
export function recordSessionBranch(
  sourceSessionId: string,
  messageId: string,
  target: SessionBranchTarget,
): void {
  if (!sourceSessionId || !messageId || !target.sessionId) return;
  if (insertTarget(index, { sessionId: sourceSessionId, messageId }, target)) {
    notify();
  }
}

export function getSessionBranchTargets(
  sourceSessionId: string | null | undefined,
  messageId: string,
): SessionBranchTarget[] {
  if (!sourceSessionId) return EMPTY_TARGETS;
  return index.get(sourceSessionId)?.get(messageId) ?? EMPTY_TARGETS;
}

export function subscribeSessionBranchIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getBranchIndexVersion(): number {
  return version;
}

/** React hook：订阅索引变化并返回该消息的分支目标（无则空数组）。 */
export function useSessionBranchTargets(
  sourceSessionId: string | null | undefined,
  messageId: string,
): SessionBranchTarget[] {
  useSyncExternalStore(subscribeSessionBranchIndex, getBranchIndexVersion, getBranchIndexVersion);
  return getSessionBranchTargets(sourceSessionId, messageId);
}

/** 测试辅助：重置索引。 */
export function resetSessionBranchIndexForTest(): void {
  index = new Map();
  version = 0;
  listeners.clear();
}
