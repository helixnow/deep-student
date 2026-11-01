/**
 * Super 会话自动投递暂停提示条
 *
 * 挂在 Super 会话输入栏上方（ChatContainer 中与 AgentTaskPanel 同一位置），
 * 两种暂停共用一条提示：
 * - 用户主动停止 → 不再自动处理后台事件，直到用户下一条消息或点击「继续处理」；
 * - 后端连续自动回合达到上限（Paused）。
 * 点击「继续处理 N 条待处理事件」以 force=true 立即投递一次。
 *
 * 视觉与 AgentTaskPanel 收起态 / composer 面板一致：composer-panel token + DsButton。
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PauseCircle, Play, CircleNotch } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import { shouldShowPausedBanner, useSuperResidentState } from './residentState';
import { resumeSuperInboxDelivery } from './residentController';

export interface SuperInboxPausedBannerProps {
  /** 当前展示的会话 ID；只有它是常驻 Super 会话时才渲染 */
  sessionId: string | null;
  className?: string;
  /** 测试注入 */
  onResume?: () => Promise<unknown>;
}

export const SuperInboxPausedBanner: React.FC<SuperInboxPausedBannerProps> = ({
  sessionId,
  className,
  onResume,
}) => {
  const { t } = useTranslation('chatV2');
  const visible = useSuperResidentState((state) => shouldShowPausedBanner(state, sessionId));
  const pausedReason = useSuperResidentState((state) => state.pausedReason);
  const pendingInbox = useSuperResidentState((state) => state.pendingInbox);
  const autoTurns = useSuperResidentState((state) => state.autoTurns);
  const resuming = useSuperResidentState((state) => state.resuming);

  const handleResume = useCallback(() => {
    void (onResume ?? resumeSuperInboxDelivery)();
  }, [onResume]);

  if (!visible) return null;

  const message = pausedReason === 'auto_limit'
    ? t('superSession.paused.autoLimit', { count: autoTurns })
    : t('superSession.paused.userStopped');
  const actionLabel = pendingInbox > 0
    ? t('superSession.paused.resume', { count: pendingInbox })
    : t('superSession.paused.resumeNoCount');

  return (
    <div
      className={cn('w-full px-4 md:px-8 flex-shrink-0 pb-1.5', className)}
      data-testid="super-inbox-paused-banner"
    >
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'mx-auto max-w-[var(--chat-thread-max-w)]',
          'flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5',
          'rounded-[var(--radius-shell-control)]',
          'border border-[color:var(--composer-panel-border)]',
          'bg-[color:var(--composer-panel-surface)]',
          'shadow-[var(--composer-panel-shadow)]',
        )}
      >
        <PauseCircle size={14} className="flex-shrink-0 text-warning" weight="fill" aria-hidden />
        <span className="min-w-0 flex-1 text-xs text-[color:var(--text-secondary)]">{message}</span>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={handleResume}
          disabled={resuming}
          className="flex-shrink-0 !h-7 !px-2.5 !gap-1.5 !text-xs !font-medium text-primary"
        >
          {resuming ? (
            <CircleNotch size={12} className="animate-spin" aria-hidden />
          ) : (
            <Play size={12} weight="fill" aria-hidden />
          )}
          {actionLabel}
        </DsButton>
      </div>
    </div>
  );
};

export default SuperInboxPausedBanner;
