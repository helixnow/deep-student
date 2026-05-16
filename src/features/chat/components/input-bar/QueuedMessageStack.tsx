import React, { useCallback } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { StoreApi } from 'zustand';
import type { ChatStore } from '../../core/types/store';
import { QueuedMessageBubble } from './QueuedMessageBubble';
import { QueueErrorBar } from './QueueErrorBar';

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
    retryFailed,
    clearQueue,
    abortStream,
  } = useStore(
    store,
    useShallow((s) => ({
      queuedMessages: s.queuedMessages,
      inputValue: s.inputValue,
      attachments: s.attachments,
      sessionStatus: s.sessionStatus,
      removeQueued: s.removeQueued,
      swapQueueWithDraft: s.swapQueueWithDraft,
      recallToDraft: s.recallToDraft,
      promoteQueued: s.promoteQueued,
      retryFailed: s.retryFailed,
      clearQueue: s.clearQueue,
      abortStream: s.abortStream,
    })),
  );

  const handleClick = useCallback((id: string) => {
    const draftEmpty = !inputValue.trim() && attachments.length === 0;
    if (draftEmpty) recallToDraft(id);
    else swapQueueWithDraft(id);
  }, [inputValue, attachments, recallToDraft, swapQueueWithDraft]);

  const handleSteer = useCallback(async (id: string) => {
    promoteQueued(id);
    if (sessionStatus === 'streaming') {
      try {
        await abortStream();
      } catch (err) {
        console.error('[QueuedMessageStack] abort during steer failed:', err);
      }
    }
    // The store's idle-transition subscription will fire maybeDequeue automatically.
  }, [promoteQueued, abortStream, sessionStatus]);

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
