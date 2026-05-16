import React from 'react';
import { useTranslation } from 'react-i18next';
import { Warning } from '@phosphor-icons/react';
import type { QueuedMessage } from '../../core/types/queue';

interface Props {
  failedItem: QueuedMessage;
  onRetry: () => void;
  onSkip: () => void;
  onClearAll: () => void;
}

/**
 * 队列错误条：在某条排队项发送失败、队列被 halt 时显示。
 * 提供 Retry / Skip / Clear-All 三个动作，对应 halt-on-failure 决策（Q9）。
 */
export const QueueErrorBar: React.FC<Props> = React.memo(({
  failedItem, onRetry, onSkip, onClearAll,
}) => {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-500/5 border border-red-500/30 text-sm animate-in fade-in duration-200"
    >
      <Warning size={14} weight="fill" className="text-red-500 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate text-red-500/90">
        {t('chatV2:queue.error.tooltipPrefix')}{failedItem.error ?? 'Unknown error'}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="px-2 py-1 rounded hover:bg-foreground/5 shrink-0"
      >
        {t('chatV2:queue.error.retry')}
      </button>
      <button
        type="button"
        onClick={onSkip}
        className="px-2 py-1 rounded hover:bg-foreground/5 shrink-0"
      >
        {t('chatV2:queue.error.skip')}
      </button>
      <button
        type="button"
        onClick={onClearAll}
        className="px-2 py-1 rounded hover:bg-foreground/5 shrink-0"
      >
        {t('chatV2:queue.error.clearAll')}
      </button>
    </div>
  );
});

QueueErrorBar.displayName = 'QueueErrorBar';
