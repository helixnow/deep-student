/**
 * bulkChunks — 批量操作的 UI 侧分片工具
 *
 * 后端批量命令（todo_batch_*）硬上限 500 条，超限整体报错
 * （见 .parallel-notes/review-todo-logic.md）。store 侧刻意不做隐式分片
 * （会破坏「单事务」的文档语义），由 UI 在超限时按 500 一片【顺序】调用：
 * 每片仍是单事务，各片结果聚合后由调用方统一 toast/撤销。
 *
 * 失败语义：store 的 bulk* action 失败返回 null（已回滚该片并弹错误通知），
 * 此时停止后续分片（已成功的分片保持生效，避免连环错误弹窗），
 * 调用方按已聚合的部分结果提示。
 */

import type { TodoBatchIdsResult, TodoBatchItemsResult } from '../../api';

/** 与后端 todo_batch_* 命令的 Batch size limit 保持一致 */
export const BULK_BATCH_LIMIT = 500;

export interface ChunkedBulkOutcome<R> {
  /** 各成功分片的原始返回（按调用顺序）；失败分片及其后的分片不包含在内 */
  results: R[];
  /** 是否有分片失败（store 已回滚该片并弹错误，无需再弹失败 toast） */
  failed: boolean;
}

/**
 * 把 ids 按 chunkSize 分片后顺序执行 op；op 返回 null 视为该片失败并中止。
 * ids ≤ chunkSize 时等价于单次调用（不改变现有单事务行为）。
 */
export async function runChunkedBulk<R>(
  ids: readonly string[],
  op: (chunk: string[]) => Promise<R | null>,
  chunkSize: number = BULK_BATCH_LIMIT,
): Promise<ChunkedBulkOutcome<R>> {
  const results: R[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const result = await op(ids.slice(i, i + chunkSize));
    if (result === null) return { results, failed: true };
    results.push(result);
  }
  return { results, failed: false };
}

/** 聚合返回实体的批量结果（complete/reschedule/move/restore/setPriority） */
export function mergeBatchItemsResults(results: TodoBatchItemsResult[]): TodoBatchItemsResult {
  return {
    items: results.flatMap((r) => r.items),
    skippedIds: results.flatMap((r) => r.skippedIds),
  };
}

/** 聚合只返回 ID 的批量结果（delete/purge） */
export function mergeBatchIdsResults(results: TodoBatchIdsResult[]): TodoBatchIdsResult {
  return {
    affectedIds: results.flatMap((r) => r.affectedIds),
    skippedIds: results.flatMap((r) => r.skippedIds),
  };
}
