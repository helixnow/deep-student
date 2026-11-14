/**
 * L15 `review` 服务的事务内所有权操作。
 *
 * 卡片/任务/文档表归 L16，`fsrs_card_states` / `fsrs_review_logs` 归 L15。
 * L16 在删除与 APKG 导入时只通过 L15 已发布的 `ReviewService` 方法写 FSRS 表，
 * 并让调用方事务成为唯一提交边界（decisions D1/D4）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ReviewService } from '../../review/api.ts';

/** L15 已发布的导入排期入参与返回形状；L16 不再维护结构副本。 */
export type {
  FsrsImportEnqueueSummary,
  FsrsImportedCard,
} from '../../review/api.ts';

/** L15 `ReviewService` 的事务内方法子集（同一 `SqlExecutor` 事务边界）。 */
export type FsrsTransactionOwner = Pick<
  ReviewService,
  | 'cleanupCardDeletionInTx'
  | 'cleanupTaskDeletionInTx'
  | 'cleanupDocumentDeletionInTx'
  | 'enqueueImportedCardsInTx'
>;

function isTransactionOwner(value: unknown): value is FsrsTransactionOwner {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FsrsTransactionOwner>;
  return typeof candidate.cleanupCardDeletionInTx === 'function'
    && typeof candidate.cleanupTaskDeletionInTx === 'function'
    && typeof candidate.cleanupDocumentDeletionInTx === 'function'
    && typeof candidate.enqueueImportedCardsInTx === 'function';
}

/** 已发布事务面的 L15 服务；未提供时返回 null，由调用方决定显式失败。 */
export function fsrsTransactionOwner(ctx: Context): FsrsTransactionOwner | null {
  const review = ctx.get('review') as unknown;
  return isTransactionOwner(review) ? review : null;
}

/** 需要写 FSRS 表时必须存在所有者；缺失时绝不回退到 L16 本地写表。 */
export function requireFsrsTransactionOwner(ctx: Context): FsrsTransactionOwner {
  const owner = fsrsTransactionOwner(ctx);
  if (owner === null) {
    throw new Error(
      'review service does not publish the FSRS transaction surface '
      + '(cleanup*InTx / enqueueImportedCardsInTx)',
    );
  }
  return owner;
}
