/**
 * 聊天卡片删除的撤销窗口 / DB 提交管理（F19）。
 *
 * 删除提交与撤销计时**必须脱离 React 组件生命周期**：聊天 block 会随虚拟滚动
 * 卸载，若把定时器放在组件里，卸载时只能被迫"立即提交"并吞掉失败，导致
 * 「聊天投影已移除、DB 仍在、用户还被告知已提交」的漂移。
 *
 * 这里用模块级 Map 持有每个 block 的待提交批次与定时器：
 * - 组件卸载不影响撤销窗口的正常结束与提交；
 * - 提交失败通过 `restore` 回调把卡片投影放回（store 是模块级，卸载后仍有效）；
 * - 只有后端确认的 cardId 才计入 committed，失败进入 failed 交给调用方提示。
 */
import { invoke } from '@tauri-apps/api/core';

export interface PendingDeleteBatch {
  /** 待提交删除的 anki_cards.id（无持久 ID 的卡片由调用方提前过滤） */
  cardIds: string[];
  /** DB 删除失败的卡片 id → 由调用方把投影恢复回去 */
  restore: (failedCardIds: string[]) => void;
  /** 提交结束回调（无论成功/失败），供调用方记录日志或提示 */
  onResult?: (result: { committed: string[]; failed: string[] }) => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const batches = new Map<string, PendingDeleteBatch>();

/** 登记一个待提交批次并启动撤销倒计时（同 key 覆盖旧批次并立即提交旧的）。 */
export function schedulePendingDelete(
  key: string,
  batch: PendingDeleteBatch,
  delayMs: number,
): void {
  commitPendingDeleteNow(key);
  batches.set(key, batch);
  const timer = setTimeout(() => {
    void commitPendingDelete(key);
  }, delayMs);
  timers.set(key, timer);
}

/** 取消撤销窗口（用户点了撤销），不提交。 */
export function cancelPendingDelete(key: string): void {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  batches.delete(key);
}

/** 立即提交（新删除到来需要先结算上一个窗口）。 */
export function commitPendingDeleteNow(key: string): void {
  void commitPendingDelete(key);
}

async function commitPendingDelete(key: string): Promise<void> {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  const batch = batches.get(key);
  if (!batch) return;
  batches.delete(key);

  const committed: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    batch.cardIds.map(async (cardId) => {
      try {
        await invoke('delete_anki_card', { cardId });
        committed.push(cardId);
      } catch (error) {
        console.warn('[pendingCardDeletes] Failed to commit card delete:', cardId, error);
        failed.push(cardId);
      }
    }),
  );

  if (failed.length > 0) {
    try {
      batch.restore(failed);
    } catch (restoreError) {
      console.error('[pendingCardDeletes] restore after delete failure failed:', restoreError);
    }
  }
  batch.onResult?.({ committed, failed });
}
