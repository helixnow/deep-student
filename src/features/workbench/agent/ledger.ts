/**
 * ACR Run Ledger — R1-06
 * 栈式 invert + sealRun + LRU 20 runs；revert 幂等（二次调用返回 false）。
 * 契约见 ./types.ts 与 docs/dev/acr/DESIGN.md §2.4。
 */
import type { RunLedger } from './types';

interface LedgerEntry {
  invert: () => Promise<void> | void;
  label: string;
}

interface RunBucket {
  entries: LedgerEntry[];
  sealed: boolean;
  /** 已成功 revert，二次调用直接 false */
  reverted: boolean;
}

const MAX_SEALED_RUNS = 20;

const runs = new Map<string, RunBucket>();
/** 已 seal 的 runId 插入序（尾 = 最近）；用于 LRU 淘汰 */
const sealedOrder: string[] = [];

function touchSealedOrder(runId: string): void {
  const idx = sealedOrder.indexOf(runId);
  if (idx >= 0) sealedOrder.splice(idx, 1);
  sealedOrder.push(runId);
}

function evictIfNeeded(): void {
  while (sealedOrder.length > MAX_SEALED_RUNS) {
    const oldest = sealedOrder.shift();
    if (oldest) runs.delete(oldest);
  }
}

function ensureBucket(runId: string): RunBucket {
  let bucket = runs.get(runId);
  if (!bucket) {
    bucket = { entries: [], sealed: false, reverted: false };
    runs.set(runId, bucket);
  }
  return bucket;
}

export const runLedger: RunLedger = {
  record(runId, invert, label) {
    const bucket = ensureBucket(runId);
    if (bucket.sealed || bucket.reverted) return;
    bucket.entries.push({ invert, label });
  },

  async revertRun(runId) {
    const bucket = runs.get(runId);
    if (!bucket || bucket.reverted) return false;
    if (bucket.entries.length === 0) return false;
    for (let i = bucket.entries.length - 1; i >= 0; i--) {
      try {
        await bucket.entries[i].invert();
        bucket.entries.pop();
      } catch {
        return false;
      }
    }
    bucket.reverted = true;
    const orderIdx = sealedOrder.indexOf(runId);
    if (orderIdx >= 0) sealedOrder.splice(orderIdx, 1);
    return true;
  },

  hasRun(runId) {
    const bucket = runs.get(runId);
    return Boolean(bucket && !bucket.reverted && bucket.entries.length > 0);
  },

  sealRun(runId) {
    const bucket = runs.get(runId);
    if (!bucket || bucket.reverted) return;
    bucket.sealed = true;
    touchSealedOrder(runId);
    evictIfNeeded();
  },
};

/** 仅供测试：清空账本 */
export function resetRunLedgerForTests(): void {
  runs.clear();
  sealedOrder.length = 0;
}
