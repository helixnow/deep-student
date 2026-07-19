/**
 * ACR flashcards(FSRS) Driver — R1-15
 *
 * - probe：session 中返回 hot（提示 Rust/StageManager 走克制路径），否则 clean
 * - apply：`fsrs_enqueue` → appendToQueue + toast；其余 op 记 undone
 * - 域事件 `fsrs://changed`：刷新 Today/Library/Stats，并协调活动 session 的 Agent 写入
 *
 * 见 docs/dev/acr/DESIGN.md §5.4 / ROUND1.md R1-15。
 */
import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  useFsrsReviewStore,
  type FsrsAgentReviewAction,
  type FsrsAgentReviewStateChange,
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
import {
  FSRS_LIBRARY_REFRESH_EVENT,
  FSRS_STATS_REFRESH_EVENT,
  requestFlashcardsDueRefresh,
} from '@/features/flashcards/events';

export { FSRS_LIBRARY_REFRESH_EVENT };

const TYPE_ID = 'flashcards';

function asReviewCards(raw: unknown): ReviewCard[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewCard[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) continue;
    const aliased = (camelKey: string, snakeKey: string) => (
      row[camelKey] !== undefined ? row[camelKey] : row[snakeKey]
    );
    const ankiCardId = aliased('ankiCardId', 'anki_card_id');
    const templateId = aliased('templateId', 'template_id');
    const extraFields = aliased('extraFields', 'extra_fields');
    const isErrorCard = aliased('isErrorCard', 'is_error_card');
    const errorContent = aliased('errorContent', 'error_content');
    out.push({
      id: row.id,
      ankiCardId: typeof ankiCardId === 'string' ? ankiCardId : undefined,
      front: typeof row.front === 'string' ? row.front : '',
      back: typeof row.back === 'string' ? row.back : '',
      text: typeof row.text === 'string' ? row.text : undefined,
      tags: Array.isArray(row.tags)
        ? row.tags.filter((t): t is string => typeof t === 'string')
        : undefined,
      images: Array.isArray(row.images)
        ? row.images.filter((image): image is string => typeof image === 'string')
        : undefined,
      templateId: typeof templateId === 'string'
        ? templateId
        : templateId === null
          ? null
          : undefined,
      extraFields: extraFields && typeof extraFields === 'object' && !Array.isArray(extraFields)
        ? Object.fromEntries(
            Object.entries(extraFields as Record<string, unknown>)
              .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          )
        : undefined,
      isErrorCard: typeof isErrorCard === 'boolean' ? isErrorCard : undefined,
      errorContent: typeof errorContent === 'string'
        ? errorContent
        : errorContent === null
          ? null
          : undefined,
      suspended: typeof row.suspended === 'boolean' ? row.suspended : undefined,
    });
  }
  return out;
}

function agentReviewStateChanges(payload: DomainChangePayload): FsrsAgentReviewStateChange[] {
  if (!Array.isArray(payload.cards)) return [];
  const changes: FsrsAgentReviewStateChange[] = [];
  for (const raw of payload.cards) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const rawCardStateId = row.cardStateId ?? row.card_state_id ?? row.id;
    const rawAnkiCardId = row.ankiCardId ?? row.anki_card_id;
    if (
      typeof rawCardStateId !== 'string'
      || !rawCardStateId.trim()
      || typeof rawAnkiCardId !== 'string'
      || !rawAnkiCardId.trim()
      || typeof row.suspended !== 'boolean'
    ) {
      continue;
    }
    const rawDueMs = row.dueMs ?? row.due_ms;
    changes.push({
      cardStateId: rawCardStateId.trim(),
      ankiCardId: rawAnkiCardId.trim(),
      suspended: row.suspended,
      ...(typeof rawDueMs === 'number' && Number.isFinite(rawDueMs)
        ? { dueMs: rawDueMs }
        : {}),
    });
  }
  return changes;
}

function hasReviewCardContent(card: ReviewCard): boolean {
  return (
    card.front.trim().length > 0 ||
    card.back.trim().length > 0 ||
    (typeof card.text === 'string' && card.text.trim().length > 0) ||
    Object.values(card.extraFields ?? {}).some((value) => value.trim().length > 0)
  );
}

function cardsFromEnqueuePayload(payload: unknown): ReviewCard[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as { cards?: unknown };

  // 两个 enqueue 入口共用完整 FSRS state/card 映射；仅有 ID 无法评分或展示。
  return asReviewCards(p.cards)
    .filter(
      (card) =>
        card.id.trim().length > 0 &&
        typeof card.ankiCardId === 'string' &&
        card.ankiCardId.trim().length > 0 &&
        card.isErrorCard !== true &&
        hasReviewCardContent(card),
    )
    .map((card) => ({
      ...card,
      id: card.id.trim(),
      ankiCardId: card.ankiCardId!.trim(),
    }));
}

function cardsFromCardMutationPayload(payload: unknown): ReviewCard[] {
  if (!payload || typeof payload !== 'object') return [];
  const rawCards = (payload as { cards?: unknown }).cards;
  if (!Array.isArray(rawCards)) return [];

  // Card-mutation events carry Anki-card rows, whereas review queues are keyed
  // by FSRS state IDs. Reuse the parser but make the content row's ID explicit
  // as ankiCardId; the store preserves the existing scheduling ID on merge.
  return asReviewCards(rawCards.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    return id ? { ...row, ankiCardId: id } : row;
  }));
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

export const fsrsDriver: CollabDriver & {
  queryState: () => Record<string, unknown>;
} = {
  typeId: TYPE_ID,

  queryState() {
    const state = useFsrsReviewStore.getState();
    const current = state.queue[state.queueIndex];
    return {
      screen: state.screen,
      dueCount: state.dueCards.length,
      queueLength: state.queue.length,
      queueIndex: state.queueIndex,
      currentCardId: current?.id ?? null,
      currentAnkiCardId: current?.ankiCardId ?? null,
      flipped: state.flipped,
      ratingBusy: state.ratingBusy,
      loading: state.loading,
      lastRated: state.lastRated,
      error: state.error,
    };
  },

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
 * 处理 `fsrs://changed`：刷新已挂载的库/统计视图；活动 session 合并 Agent 复习写入。
 * 导出供单测直接调用。
 */
export function handleFsrsDomainChange(payload: DomainChangePayload): void {
  const { screen } = useFsrsReviewStore.getState();
  requestFlashcardsDueRefresh();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FSRS_LIBRARY_REFRESH_EVENT));
    window.dispatchEvent(new CustomEvent(FSRS_STATS_REFRESH_EVENT));
  }

  if (screen === 'today') {
    void useFsrsReviewStore.getState().loadDue();
    flashEntityIds(collectDomainEntityIds(payload));
    return;
  }

  if (screen === 'library') {
    flashEntityIds(collectDomainEntityIds(payload));
    return;
  }

  if (screen === 'settings') {
    flashEntityIds(collectDomainEntityIds(payload));
    return;
  }

  if (screen === 'session') {
    if (
      payload.source === 'agent'
      && (payload.action === 'card_updated' || payload.action === 'cards_retemplated')
    ) {
      const cards = cardsFromCardMutationPayload(payload);
      useFsrsReviewStore.getState().reconcileAgentCardContent(cards);
      flashEntityIds(collectDomainEntityIds(payload));
      return;
    }
    if (
      payload.source === 'agent'
      && (payload.action === 'undo_last_review' || payload.action === 'set_suspended')
    ) {
      useFsrsReviewStore.getState().reconcileAgentReviewChange(
        payload.action as FsrsAgentReviewAction,
        agentReviewStateChanges(payload),
      );
      flashEntityIds(collectDomainEntityIds(payload));
      return;
    }
    // 他窗 / 本窗回声的 user rate：按 cardStateIds 对齐队列，避免双评分。
    if (payload.action === 'rate') {
      const fromPayload = Array.isArray(payload.cardStateIds)
        ? payload.cardStateIds.filter((id): id is string => typeof id === 'string')
        : [];
      const cardLogPairs: Array<{ cardStateId: string; logId: string }> = [];
      const fromCards = Array.isArray(payload.cards)
        ? payload.cards
            .map((raw) => {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
              const row = raw as Record<string, unknown>;
              const id = row.id ?? row.cardStateId ?? row.card_state_id;
              const logId = row.logId ?? row.log_id;
              if (
                typeof id === 'string'
                && id.trim()
                && typeof logId === 'string'
                && logId.trim()
              ) {
                cardLogPairs.push({ cardStateId: id.trim(), logId: logId.trim() });
              }
              return typeof id === 'string' ? id : null;
            })
            .filter((id): id is string => !!id)
        : [];
      useFsrsReviewStore.getState().reconcileExternalRate(
        [...fromPayload, ...fromCards],
        cardLogPairs.length > 0 ? { cardLogPairs } : undefined,
      );
      flashEntityIds(collectDomainEntityIds(payload));
      return;
    }
    if (payload.action !== 'enqueue') {
      flashEntityIds(collectDomainEntityIds(payload));
      return;
    }
    const toAppend = cardsFromEnqueuePayload(payload);
    if (toAppend.length === 0) return;
    const added = useFsrsReviewStore.getState().appendToQueue(toAppend);
    if (added > 0) {
      notifyAppended(added);
      flashEntityIds(toAppend.map((c) => c.ankiCardId ?? c.id));
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
