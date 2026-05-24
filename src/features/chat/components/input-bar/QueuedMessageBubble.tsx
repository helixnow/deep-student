import React from 'react';
import { ArrowBendDownRight, ArrowCircleRight, Trash } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { QueuedMessage } from '../../core/types/queue';

interface Props {
  item: QueuedMessage;
  allowSteer: boolean;
  onClick: () => void;
  onSteer: () => void;
  onDelete: () => void;
}

/**
 * 单条排队消息气泡。
 * - 点击气泡正文 → 召回为草稿（由父级处理）。
 * - 「引导」按钮 → 立即打断当前回复并优先发送（仅 allowSteer 时显示）。
 * - 垃圾桶 → 删除此条。
 * - 失败态：红色边框 + 红点指示，hover tooltip 显示错误。
 */
export const QueuedMessageBubble: React.FC<Props> = React.memo(({
  item, allowSteer, onClick, onSteer, onDelete,
}) => {
  const { t } = useTranslation();
  const failed = item.status === 'failed';
  const tooltip = failed ? `${t('chatV2:queue.error.tooltipPrefix')}${item.error ?? ''}` : undefined;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group flex items-center gap-2 px-3 py-2 rounded-xl cursor-pointer',
        'bg-neutral-100 dark:bg-neutral-800/80 border border-transparent',
        'transition-colors duration-200',
        'animate-in slide-in-from-bottom-2 fade-in duration-200',
        'hover:bg-neutral-200/60 dark:hover:bg-neutral-700/80',
        failed && 'border-red-500/40',
      )}
      title={tooltip}
      aria-label={t('chatV2:queue.bubble.iconLabel')}
    >
      <ArrowBendDownRight size={14} className="shrink-0 text-muted-foreground" weight="regular" />
      <div className="flex-1 min-w-0 line-clamp-2 text-sm text-foreground/90 break-words">
        {failed && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5 align-middle"
            aria-hidden="true"
          />
        )}
        {item.content || (
          <span className="text-muted-foreground italic">
            {/* No body text — only attachments / context refs */}
            ({item.attachments.length > 0 || item.contextRefs.length > 0 ? 'attachments only' : 'empty'})
          </span>
        )}
      </div>
      {allowSteer && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onSteer(); }}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-foreground/5 shrink-0"
          aria-label={t('chatV2:queue.bubble.steer')}
        >
          <ArrowCircleRight size={14} weight="regular" />
          <span>{t('chatV2:queue.bubble.steer')}</span>
        </button>
      )}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="p-1 rounded hover:bg-foreground/5 shrink-0"
        aria-label={t('chatV2:queue.bubble.delete')}
      >
        <Trash size={14} className="text-muted-foreground" weight="regular" />
      </button>
    </div>
  );
});

QueuedMessageBubble.displayName = 'QueuedMessageBubble';
