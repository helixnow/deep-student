/**
 * ACR flashcards(FSRS) Driver — R1-15
 *
 * - probe：session 中返回 hot（提示 Rust/StageManager 走克制路径），否则 clean
 * - apply：`fsrs_enqueue` → appendToQueue + toast；其余 op 记 undone
 * - 域事件 `fsrs://changed`：today→loadDue；library→CustomEvent；session→append-only
 *
 * 见 docs/dev/acr/DESIGN.md §5.4 / ROUND1.md R1-15。
 */
import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  useFsrsReviewStore,
  type ReviewCard,
} from '@/features/flashcards/store/fsrsReviewStore';
import { collectDomainEntityIds, registerDomainListener } from '../domainEvents';
import { listTickCost } from '../pacing';
import { withUserPatch } from '../userPatch';
import { agentFlashMany } from '../visuals/agentFlash';
import type {
  AcrProbeState,
  AcrReceipt,
  AcrRunContext,
  AcrTarget,
  AgentOp,
  CollabDriver,
  DomainChangePayload,
  StageManagerApi,
} from '../types';

/** LibraryScreen 监听此事件重查库表（本地 state，非 zustand） */
import { FSRS_LIBRARY_REFRESH_EVENT } from '@/features/flashcards/events';

export { FSRS_LIBRARY_REFRESH_EVENT };

const TYPE_ID = 'flashcards';

interface FsrsEnqueuePayload {
  cardIds?: unknown;
  cards?: unknown;
}

function asReviewCards(raw: unknown): ReviewCard[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) continue;
    out.push({
      id: row.id,
      ankiCardId: typeof row.ankiCardId === 'string' ? row.ankiCardId : undefined,
      front: typeof row.front === 'string' ? row.front : '',
      back: typeof row.back === 'string' ? row.back : '',
      tags: Array.isArray(row.tags)
        ? row.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
    });
  }
  return out;
}

function cardsFromEnqueuePayload(payload: unknown): ReviewCard[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as FsrsEnqueuePayload;
  const fromCards = asReviewCards(p.cards);
  if (fromCards.length > 0) return fromCards;

  // 仅有 cardIds：构造最小 stub（内容可空，评分侧仍可用 id）
  if (!Array.isArray(p.cardIds)) return [];
  return p.cardIds
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map((id) => ({
      id,
      ankiCardId: id,
      front: '',
      back: '',
    }));
}

function cardIdsFromPayload(payload: DomainChangePayload | unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as DomainChangePayload & { cardIds?: unknown; cards?: unknown };
  // R2-04：优先统一 entityIds（含 entity_ids 归一）
  const fromEntities = collectDomainEntityIds(p);
  if (fromEntities.length > 0) return fromEntities;
  if (Array.isArray(p.cardIds)) {
    return p.cardIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  const cards = asReviewCards(p.cards);
  return cards.map((c) => c.id);
}

function notifyAppended(count: number): void {
  if (count <= 0) return;
  const message = i18n.t('workbench:agent.apps.flashcards.appended', {
    count,
    defaultValue: 'AI 添加了 {{count}} 张卡片',
  });
  showGlobalNotification('info', message);
}

function flashEntityIds(entityIds: string[] | undefined): void {
  if (!entityIds?.length) return;
  agentFlashMany(TYPE_ID, entityIds.filter((id): id is string => typeof id === 'string' && !!id));
}

function emptyReceipt(
  status: AcrReceipt['status'],
  totalOps: number,
  partial?: Partial<AcrReceipt>,
): AcrReceipt {
  return {
    status,
    mode: 'frontend',
    applied: 0,
    totalOps,
    entityIds: [],
    done: [],
    undone: [],
    ...partial,
  };
}

export const fsrsDriver: CollabDriver = {
  typeId: TYPE_ID,

  probe(_target: AcrTarget): AcrProbeState {
    const { screen, queue, queueIndex, ratingBusy } = useFsrsReviewStore.getState();
    // 只有真正处于答题/评分的 session 才 hot；队列耗尽的完成页可安全追加。
    if (screen === 'session' && (ratingBusy || queueIndex < queue.length)) return 'hot';
    return 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const done: string[] = [];
    const undone: string[] = [];
    const entityIds: string[] = [];
    let applied = 0;
    const totalOps = ops.length;

    for (let i = 0; i < ops.length; i++) {
      const pause = await run.checkPaused();
      if (pause === 'abort') {
        return withUserPatch(
          emptyReceipt('cancelled', totalOps, {
            applied,
            entityIds,
            done,
            undone: [...undone, ...ops.slice(i).map((op) => op.label || op.kind)],
            message: '用户中断，复习队列未重置',
          }),
          TYPE_ID,
        );
      }

      const op = ops[i]!;
      run.reportProgress(i + 1, totalOps, op.label || op.kind);

      if (op.kind === 'fsrs_enqueue') {
        const { screen } = useFsrsReviewStore.getState();
        if (screen !== 'session') {
          undone.push(op.label || op.kind);
        } else {
          const cards = cardsFromEnqueuePayload(op.payload);
          if (cards.length === 0) {
            undone.push(op.label || op.kind);
          } else {
            const beforeIds = new Set(
              useFsrsReviewStore.getState().queue.map((card) => card.id),
            );
            const added = useFsrsReviewStore.getState().appendToQueue(cards);
            const addedCards = useFsrsReviewStore
              .getState()
              .queue.filter((card) => !beforeIds.has(card.id));
            if (added > 0 && addedCards.length === added) {
              applied += 1;
              done.push(op.label || `入队 ${added} 张卡片`);
              for (const card of addedCards) {
                if (!entityIds.includes(card.id)) entityIds.push(card.id);
              }
              notifyAppended(added);
              flashEntityIds(addedCards.map((card) => card.id));
            } else {
              undone.push(op.label || `${op.kind}（全部已在队列）`);
            }
          }
        }
      } else {
        undone.push(op.label || op.kind);
      }

      await run.pacing.tick(listTickCost(run.pacing.profile));
    }

    const status: AcrReceipt['status'] =
      applied === totalOps && undone.length === 0
        ? 'completed'
        : applied > 0
          ? 'partial'
          : totalOps === 0
            ? 'completed'
            : 'failed';

    return {
      status,
      mode: 'frontend',
      applied,
      totalOps,
      entityIds,
      done,
      undone,
      message:
        status === 'failed'
          ? '无可应用的 fsrs_enqueue（需处于复习 session）'
          : undefined,
    };
  },

  abort(runId: string): AcrReceipt {
    return withUserPatch(
      emptyReceipt('cancelled', 0, {
        message: `run ${runId} aborted（flashcards 队列未重置）`,
      }),
      TYPE_ID,
    );
  },
};

/**
 * 处理 `fsrs://changed`：按当前 screen 刷新或 append-only 入队。
 * 导出供单测直接调用。
 */
export function handleFsrsDomainChange(payload: DomainChangePayload): void {
  const { screen } = useFsrsReviewStore.getState();

  if (screen === 'today') {
    void useFsrsReviewStore.getState().loadDue();
    flashEntityIds(collectDomainEntityIds(payload));
    return;
  }

  if (screen === 'library') {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(FSRS_LIBRARY_REFRESH_EVENT));
    }
    flashEntityIds(collectDomainEntityIds(payload));
    return;
  }

  if (screen === 'session') {
    const cards = asReviewCards(
      (payload as DomainChangePayload & { cards?: unknown }).cards,
    );
    let toAppend = cards;
    if (toAppend.length === 0) {
      const ids = cardIdsFromPayload(payload);
      if (ids.length === 0) return;
      toAppend = ids.map((id) => ({
        id,
        ankiCardId: id,
        front: '',
        back: '',
      }));
    }
    const added = useFsrsReviewStore.getState().appendToQueue(toAppend);
    if (added > 0) {
      notifyAppended(added);
      flashEntityIds(toAppend.map((c) => c.id));
    }
  }
}

let domainUnlisten: (() => void) | null = null;

export function registerFsrsDriver(stage: StageManagerApi): () => void {
  stage.registerDriver(fsrsDriver);
  domainUnlisten?.();
  const unlisten = registerDomainListener('fsrs://changed', handleFsrsDomainChange);
  domainUnlisten = unlisten;

  return () => {
    if (domainUnlisten !== unlisten) return;
    domainUnlisten = null;
    unlisten();
  };
}
