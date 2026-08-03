/**
 * ACR Run Ledger — R1-06
 * 栈式 invert + sealRun + LRU 20 runs；revert 幂等（二次调用返回 false）。
 * 契约见 ./types.ts 与 docs/dev/acr/DESIGN.md §2.4。
 */
import type { AgentCapabilityRisk } from '../core/types';
import type { RunLedger } from './types';

interface LedgerEntry {
  invert: () => Promise<void> | void;
  label: string;
}

interface RunBucket {
  entries: LedgerEntry[];
  sealed: boolean;
  /** 同一 run 的并发撤销共享一个 promise，避免 inverse 被重复执行。 */
  reverting: Promise<boolean> | null;
  metadata?: RunLedgerMetadata;
}

export interface RunLedgerMetadata {
  sessionId: string;
  externalRunId: string;
  windowId: string | null;
  requiredRisk: AgentCapabilityRisk;
}

const MAX_SEALED_RUNS_PER_SESSION = 20;

const runs = new Map<string, RunBucket>();
/** 已 seal 的 runId 插入序（尾 = 最近）；用于 LRU 淘汰 */
const sealedOrder: string[] = [];
/** 已成功撤销的 key 保留有界 tombstone，拒绝迟到 record 复活旧 run。 */
const revertedTombstones = new Set<string>();
const revertedOrder: string[] = [];
const MAX_REVERTED_TOMBSTONES = 100;

function addRevertedTombstone(runId: string): void {
  if (revertedTombstones.has(runId)) return;
  revertedTombstones.add(runId);
  revertedOrder.push(runId);
  while (revertedOrder.length > MAX_REVERTED_TOMBSTONES) {
    const oldest = revertedOrder.shift();
    if (oldest) revertedTombstones.delete(oldest);
  }
}

function touchSealedOrder(runId: string): void {
  const idx = sealedOrder.indexOf(runId);
  if (idx >= 0) sealedOrder.splice(idx, 1);
  sealedOrder.push(runId);
}

function ledgerSessionId(runId: string): string {
  return runs.get(runId)?.metadata?.sessionId ?? '__legacy__';
}

function evictIfNeeded(runId: string): void {
  const sessionId = ledgerSessionId(runId);
  const sessionOrder = sealedOrder.filter(
    (candidate) => ledgerSessionId(candidate) === sessionId,
  );
  while (sessionOrder.length > MAX_SEALED_RUNS_PER_SESSION) {
    const oldest = sessionOrder.shift();
    if (!oldest) break;
    const orderIndex = sealedOrder.indexOf(oldest);
    if (orderIndex >= 0) sealedOrder.splice(orderIndex, 1);
    runs.delete(oldest);
  }
}

function ensureBucket(runId: string): RunBucket {
  let bucket = runs.get(runId);
  if (!bucket) {
    bucket = { entries: [], sealed: false, reverting: null };
    runs.set(runId, bucket);
  }
  return bucket;
}

function resolveExistingRunKey(runId: string): string | null {
  if (runs.has(runId)) return runId;
  const matches = [...runs.entries()].filter(
    ([, bucket]) => bucket.metadata?.externalRunId === runId,
  );
  return matches.length === 1 ? matches[0][0] : null;
}

/** Bind session/window identity before the first inverse is recorded. */
export function bindRunLedgerMetadata(
  runId: string,
  metadata: RunLedgerMetadata,
): void {
  if (revertedTombstones.has(runId)) return;
  const bucket = ensureBucket(runId);
  if (bucket.sealed || bucket.reverting) return;
  bucket.metadata = { ...metadata };
}

export function getRunLedgerMetadata(runId: string): RunLedgerMetadata | null {
  const metadata = runs.get(runId)?.metadata;
  return metadata ? { ...metadata } : null;
}

export function elevateRunLedgerRisk(
  runId: string,
  risk: AgentCapabilityRisk,
): void {
  const bucket = runs.get(runId);
  if (!bucket?.metadata || bucket.sealed || bucket.reverting) return;
  const rank: Record<AgentCapabilityRisk, number> = {
    read: 0,
    low: 1,
    medium: 2,
    high: 3,
  };
  if (rank[risk] > rank[bucket.metadata.requiredRisk]) {
    bucket.metadata.requiredRisk = risk;
  }
}

export function discardEmptyRunLedger(runId: string): void {
  const bucket = runs.get(runId);
  if (bucket && bucket.entries.length === 0 && !bucket.reverting) {
    runs.delete(runId);
  }
}

/** UI-only compatibility lookup. Bridge requests should always derive the exact session key. */
export function findRunLedgerKeyByExternalId(externalRunId: string): string | null {
  const matches = [...runs.entries()].filter(
    ([, bucket]) => bucket.metadata?.externalRunId === externalRunId,
  );
  return matches.length === 1 ? matches[0][0] : null;
}

export const runLedger: RunLedger = {
  record(runId, invert, label) {
    if (revertedTombstones.has(runId)) return;
    const bucket = ensureBucket(runId);
    if (bucket.sealed || bucket.reverting) return;
    bucket.entries.push({ invert, label });
  },

  async revertRun(runId) {
    const resolvedRunId = resolveExistingRunKey(runId);
    if (!resolvedRunId) return false;
    runId = resolvedRunId;
    const bucket = runs.get(runId);
    if (!bucket || revertedTombstones.has(runId)) return false;
    if (bucket.reverting) return bucket.reverting;
    if (bucket.entries.length === 0) return false;

    const task = (async () => {
      while (bucket.entries.length > 0) {
        const entry = bucket.entries.at(-1)!;
        try {
          await entry.invert();
          // Pop only the exact entry that completed. A failed inverse remains retryable.
          if (bucket.entries.at(-1) === entry) bucket.entries.pop();
        } catch {
          return false;
        }
      }
      const orderIdx = sealedOrder.indexOf(runId);
      if (orderIdx >= 0) sealedOrder.splice(orderIdx, 1);
      runs.delete(runId);
      addRevertedTombstone(runId);
      return true;
    })();
    bucket.reverting = task;
    try {
      return await task;
    } finally {
      if (runs.get(runId) === bucket && bucket.reverting === task) {
        bucket.reverting = null;
      }
    }
  },

  hasRun(runId) {
    const resolvedRunId = resolveExistingRunKey(runId);
    const bucket = resolvedRunId ? runs.get(resolvedRunId) : undefined;
    return Boolean(bucket && bucket.entries.length > 0);
  },

  sealRun(runId) {
    const bucket = runs.get(runId);
    if (!bucket) return;
    bucket.sealed = true;
    touchSealedOrder(runId);
    evictIfNeeded(runId);
  },
};

/** 仅供测试：清空账本 */
export function resetRunLedgerForTests(): void {
  runs.clear();
  sealedOrder.length = 0;
  revertedTombstones.clear();
  revertedOrder.length = 0;
}
