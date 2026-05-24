import React, { useCallback } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types/store';
import { QueuedMessageBubble } from './QueuedMessageBubble';
import { QueueErrorBar } from './QueueErrorBar';
import type { QueuedMessage } from '../../core/types/queue';

// Stable empty-array reference. We need this so that older mock stores in
// existing tests (which don't declare `queuedMessages`) don't get a fresh
// `[]` literal on every selector run, which would break `useShallow` equality
// and infinite-loop renders. `Object.freeze` makes accidental mutation throw
// in dev (sloppy mode it's silent, but tests run in strict mode).
const EMPTY_QUEUE: readonly QueuedMessage[] = Object.freeze([]);

interface Props {
  store: StoreApi<ChatStore>;
  allowSteer: boolean;
}

/**
 * 队列堆叠容器。
 * - 队首在顶部（最先发送），队尾紧贴 InputBar（最新加入）。
 * - 失败时在堆叠最顶部显示 QueueErrorBar。
 * - 自身只订阅 queue 相关状态，避免与 InputBar 主体的 selector 冲突。
 */
export const QueuedMessageStack: React.FC<Props> = React.memo(({ store, allowSteer }) => {
  const {
    queuedMessages,
    inputValue,
    attachments,
    sessionStatus,
    removeQueued,
    swapQueueWithDraft,
    recallToDraft,
    promoteQueued,
    markSteered,
    retryFailed,
    clearQueue,
    abortStream,
    maybeDequeue,
  } = useStore(
    store,
    useShallow((s) => ({
      queuedMessages: s.queuedMessages ?? EMPTY_QUEUE,
      inputValue: s.inputValue,
      attachments: s.attachments,
      sessionStatus: s.sessionStatus,
      removeQueued: s.removeQueued,
      swapQueueWithDraft: s.swapQueueWithDraft,
      recallToDraft: s.recallToDraft,
      promoteQueued: s.promoteQueued,
      markSteered: s.markSteered,
      retryFailed: s.retryFailed,
      clearQueue: s.clearQueue,
      abortStream: s.abortStream,
      maybeDequeue: s.maybeDequeue,
    })),
  );

  const handleClick = useCallback((id: string) => {
    const draftEmpty = !inputValue.trim() && attachments.length === 0;
    if (draftEmpty) recallToDraft(id);
    else swapQueueWithDraft(id);
  }, [inputValue, attachments, recallToDraft, swapQueueWithDraft]);

  const handleSteer = useCallback(async (id: string) => {
    // Mark as steered first so the flag survives the promote → dequeue chain
    // and propagates to the resulting user message's _meta.steered.
    markSteered?.(id);
    promoteQueued(id);
    if (sessionStatus === 'streaming') {
      try {
        await abortStream();
        // Idle-transition subscription will fire maybeDequeue.
      } catch (err) {
        console.error('[QueuedMessageStack] abort during steer failed:', err);
      }
    } else {
      // Already idle: no transition will fire, so trigger dequeue explicitly.
      void maybeDequeue?.();
    }
  }, [markSteered, promoteQueued, abortStream, sessionStatus, maybeDequeue]);

  if (queuedMessages.length === 0) return null;

  const failed = queuedMessages.find((q) => q.status === 'failed');

  return (
    <div className="flex flex-col gap-1.5 mb-2" data-testid="queued-message-stack">
      {failed && (
        <QueueErrorBar
          failedItem={failed}
          onRetry={() => retryFailed(failed.id)}
          onSkip={() => removeQueued(failed.id)}
          onClearAll={() => clearQueue()}
        />
      )}
      {queuedMessages.map((item) => (
        <QueuedMessageBubble
          key={item.id}
          item={item}
          allowSteer={allowSteer && item.status === 'pending'}
          onClick={() => handleClick(item.id)}
          onSteer={() => void handleSteer(item.id)}
          onDelete={() => removeQueued(item.id)}
        />
      ))}
    </div>
  );
});

QueuedMessageStack.displayName = 'QueuedMessageStack';
