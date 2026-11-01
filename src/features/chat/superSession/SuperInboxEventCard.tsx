/**
 * Super 收件箱事件卡片
 *
 * Super 会话中由「投递」产生的 user 消息（_meta.inboundOrigin 存在）不渲染为用户气泡，
 * 而是渲染为系统事件卡片：逐条列出 Worker 完成 / 失败 / 外部事件，可展开查看投递原文，
 * Worker 条目可「查看」完整子会话（与 subagent_embed 卡片同一套只读完整视图）。
 *
 * 视觉与 subagent_embed 卡片一致：rounded-lg + border-border/50 + bg-card，DsButton 交互，
 * 触屏下按钮由 DsButton 体系保证 44px 命中区。
 */

import React, { Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type StoreApi } from 'zustand';
import {
  Broadcast,
  CaretDown,
  CaretRight,
  CheckCircle,
  ChatCircleDots,
  CircleNotch,
  MinusCircle,
  Robot,
  Tray,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog, DsDialogHeader, DsDialogTitle } from '@/components/ui/DsDialog';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/utils/cn';
import { formatMessageTime } from '@/utils/formatUtils';
import type { ChatStore } from '../core/types';
import { parseInboundOrigin, type InboundItem, type InboundWorkerStatus } from './inboundOrigin';

// 完整子会话视图按需加载：ChatContainer → MessageList → MessageItem → 本组件 存在环依赖
const LazyChatContainer = React.lazy(() =>
  import('../components/ChatContainer').then((module) => ({ default: module.ChatContainer })),
);

// ============================================================================
// 单条事件
// ============================================================================

function WorkerStatusIcon({ status }: { status: InboundWorkerStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle size={14} weight="fill" className="text-success flex-shrink-0" aria-hidden />;
    case 'failed':
      return <WarningCircle size={14} weight="fill" className="text-destructive flex-shrink-0" aria-hidden />;
    case 'cancelled':
      return <MinusCircle size={14} className="text-muted-foreground flex-shrink-0" aria-hidden />;
    case 'interrupted':
    case 'timeout':
      return <XCircle size={14} className="text-warning flex-shrink-0" aria-hidden />;
    default:
      return <ChatCircleDots size={14} className="text-primary flex-shrink-0" aria-hidden />;
  }
}

function useItemLabel() {
  const { t } = useTranslation('chatV2');
  return (item: InboundItem): string => {
    if (item.kind === 'external') {
      return item.source
        ? t('superSession.event.external', { source: item.source })
        : t('superSession.event.externalNoSource');
    }
    if (item.kind === 'worker') {
      const title = item.title ?? t('superSession.event.untitledWorker');
      return t(`superSession.event.worker.${item.status}`, { title });
    }
    return item.summary ?? t('superSession.event.generic');
  };
}

interface EventRowProps {
  item: InboundItem;
  onViewWorker: (item: InboundItem) => void;
}

const EventRow: React.FC<EventRowProps> = ({ item, onViewWorker }) => {
  const { t } = useTranslation('chatV2');
  const labelFor = useItemLabel();
  const label = labelFor(item);
  const showSummary = item.kind !== 'other' && item.summary;

  return (
    <li className="flex items-start gap-2 px-3 py-1.5" data-testid="super-inbox-event-row">
      <span className="mt-0.5 flex-shrink-0">
        {item.kind === 'external' ? (
          <Broadcast size={14} className="text-primary flex-shrink-0" aria-hidden />
        ) : item.kind === 'worker' ? (
          <WorkerStatusIcon status={item.status} />
        ) : (
          <Tray size={14} className="text-muted-foreground flex-shrink-0" aria-hidden />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground break-words">{label}</div>
        {showSummary && (
          <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2 break-words">{item.summary}</div>
        )}
      </div>
      {item.kind === 'worker' && item.workerSessionId && (
        <DsButton
          variant="ghost"
          size="sm"
          className="flex-shrink-0 !h-6 !px-2 !text-xs text-primary"
          onClick={() => onViewWorker(item)}
          aria-label={t('superSession.event.viewWorkerAria', { title: item.title ?? item.workerSessionId })}
        >
          {t('superSession.event.view')}
        </DsButton>
      )}
    </li>
  );
};

// ============================================================================
// 卡片
// ============================================================================

export interface SuperInboxEventCardProps {
  /** MessageMeta.inboundOrigin */
  origin: unknown;
  /** 投递消息原文（<super_agent_inbox> 包裹的正文） */
  content: string;
  timestamp?: number;
  className?: string;
}

export const SuperInboxEventCard: React.FC<SuperInboxEventCardProps> = ({
  origin,
  content,
  timestamp,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const items = useMemo(() => parseInboundOrigin(origin), [origin]);
  const [rawExpanded, setRawExpanded] = useState(false);
  const [viewingWorker, setViewingWorker] = useState<InboundItem | null>(null);
  const timeText = formatMessageTime(timestamp);
  const hasRaw = content.trim().length > 0;

  return (
    <div
      className={cn('rounded-lg border border-border/50 bg-card overflow-hidden', className)}
      role="group"
      aria-label={t('superSession.event.ariaLabel')}
      data-testid="super-inbox-event-card"
    >
      {/* 头部：事件来源说明 */}
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 text-xs text-muted-foreground select-none">
        <Tray size={14} className="text-primary flex-shrink-0" aria-hidden />
        <span className="font-medium text-foreground/80">{t('superSession.event.title')}</span>
        {items.length > 1 && (
          <span className="px-1.5 py-0.5 rounded border border-border/60 text-2xs tabular-nums">
            {t('superSession.event.count', { count: items.length })}
          </span>
        )}
        {timeText && <span className="ml-auto tabular-nums text-2xs">{timeText}</span>}
      </div>

      {/* 事件列表 */}
      <ul className="pb-1.5">
        {items.length > 0 ? (
          items.map((item, index) => (
            <EventRow
              key={`${item.kind}-${item.workerSessionId ?? item.source ?? ''}-${index}`}
              item={item}
              onViewWorker={setViewingWorker}
            />
          ))
        ) : (
          <li className="px-3 py-1.5 text-sm text-foreground">{t('superSession.event.generic')}</li>
        )}
      </ul>

      {/* 原文：可展开 */}
      {hasRaw && (
        <>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => setRawExpanded((value) => !value)}
            aria-expanded={rawExpanded}
            className="w-full !justify-start gap-1.5 !rounded-none !px-3 border-t border-border/30 !text-xs !font-normal text-muted-foreground"
          >
            {rawExpanded ? (
              <CaretDown size={12} className="flex-shrink-0" aria-hidden />
            ) : (
              <CaretRight size={12} className="flex-shrink-0" aria-hidden />
            )}
            {rawExpanded ? t('superSession.event.hideRaw') : t('superSession.event.showRaw')}
          </DsButton>
          {rawExpanded && (
            <div className="border-t border-border/30 bg-muted/20 px-3 py-2">
              <CustomScrollArea fullHeight={false} className="max-h-60" viewportClassName="max-h-60">
                <pre
                  className="m-0 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground"
                  data-testid="super-inbox-event-raw"
                >
                  {content}
                </pre>
              </CustomScrollArea>
            </div>
          )}
        </>
      )}

      {/* Worker 完整会话（只读） */}
      <DsDialog
        open={viewingWorker !== null}
        onOpenChange={(open) => {
          if (!open) setViewingWorker(null);
        }}
        maxWidth="max-w-[min(960px,92vw)]"
        className="h-[min(85vh,720px)]"
      >
        <DsDialogHeader>
          <DsDialogTitle className="flex items-center gap-2 pr-8">
            <Robot size={16} className="text-primary flex-shrink-0" aria-hidden />
            <span className="truncate">
              {viewingWorker?.title ?? t('superSession.event.untitledWorker')}
            </span>
          </DsDialogTitle>
        </DsDialogHeader>
        <div className="flex-1 min-h-0">
          {viewingWorker?.workerSessionId && (
            <Suspense
              fallback={(
                <div className="flex h-full items-center justify-center">
                  <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden />
                </div>
              )}
            >
              <LazyChatContainer
                key={`super-worker-${viewingWorker.workerSessionId}`}
                sessionId={viewingWorker.workerSessionId}
                showInputBar={false}
                className="h-full"
              />
            </Suspense>
          )}
        </div>
      </DsDialog>
    </div>
  );
};

// ============================================================================
// MessageItem 接入：按 messageId 订阅 store
// ============================================================================

function selectMessageText(state: ChatStore, messageId: string): string {
  const message = state.messageMap.get(messageId);
  if (!message) return '';
  const parts: string[] = [];
  for (const blockId of message.blockIds) {
    const block = state.blocks.get(blockId);
    if (block?.type === 'content' && typeof block.content === 'string') parts.push(block.content);
  }
  return parts.join('\n\n');
}

export interface SuperInboxEventMessageProps {
  store: StoreApi<ChatStore>;
  messageId: string;
}

/** MessageItem 中替代用户气泡的事件卡片（订阅原文与 inboundOrigin） */
export const SuperInboxEventMessage: React.FC<SuperInboxEventMessageProps> = ({ store, messageId }) => {
  const origin = useStore(store, (state) => state.messageMap.get(messageId)?._meta?.inboundOrigin);
  const timestamp = useStore(store, (state) => state.messageMap.get(messageId)?.timestamp);
  const content = useStore(store, (state) => selectMessageText(state, messageId));
  return <SuperInboxEventCard origin={origin} content={content} timestamp={timestamp} />;
};
