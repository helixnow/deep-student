import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { ReviewSession } from '@/components/ReviewSession';
import { Z_INDEX } from '@/config/zIndex';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { BACK_PRIORITY, registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import { getErrorMessage } from '@/utils/errorUtils';
import { DUE_MISTAKES_SESSION_KEY, closeDueMistakesReview, loadDueMistakeItems } from './dueMistakesReview';
import { refreshTodayLearning } from './todayLearningStore';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; missing: number }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

/** 跨题目集的到期错题复习：挂在应用根部，经典壳 / 学习桌面 / 手机端共用。 */
export const DueMistakesReviewOverlay: React.FC = () => {
  const { t } = useTranslation(['review', 'common']);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const startSession = useReviewPlanStore((state) => state.startSession);
  const endSession = useReviewPlanStore((state) => state.endSession);

  useEffect(() => {
    let cancelled = false;
    loadDueMistakeItems()
      .then(({ items, missing }) => {
        if (cancelled) return;
        if (items.length === 0) {
          setPhase({ kind: 'empty' });
          return;
        }
        startSession(items, DUE_MISTAKES_SESSION_KEY);
        setPhase({ kind: 'ready', missing });
      })
      .catch((error: unknown) => {
        if (!cancelled) setPhase({ kind: 'error', message: getErrorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [startSession]);

  const close = useCallback(() => {
    if (useReviewPlanStore.getState().session.examId === DUE_MISTAKES_SESSION_KEY) endSession();
    closeDueMistakesReview();
    void refreshTodayLearning();
  }, [endSession]);

  // 自绘浮层不在 Radix 的 Escape 兜底里：Android 返回键要显式接住，否则会切走浮层下面的页面。
  // 已提交的评分都已落库，返回只丢本地剩余队列（与「退出」同语义）。
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => registerBackHandler(() => {
    closeRef.current();
    return true;
  }, BACK_PRIORITY.overlay), []);

  // 打开即把焦点移进浮层，键盘 / 读屏不留在背后的触发按钮上
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  // 复习中由 ReviewSession 自己的「退出」二次确认负责，Esc 只用来关掉加载 / 空 / 失败态
  useEventRegistry(
    phase.kind === 'ready'
      ? []
      : [{
          target: 'window',
          type: 'keydown',
          listener: (event) => {
            if ((event as KeyboardEvent).key === 'Escape') close();
          },
        }],
    [close, phase.kind],
  );

  const title = t('review:dueAll.title', { defaultValue: '错题复习' });

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40 p-0 sm:p-6"
      style={{ zIndex: Z_INDEX.modal }}
      data-testid="due-mistakes-review"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden bg-background pt-[var(--mobile-safe-area-top)] outline-none sm:h-[min(860px,calc(100dvh-6rem))] sm:w-[min(920px,calc(100vw-3rem))] sm:rounded-xl sm:border sm:border-border sm:pt-0 sm:shadow-xl"
      >
        <div className="flex flex-shrink-0 items-baseline gap-2 border-b border-border/50 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <span className="truncate text-xs text-muted-foreground">
            {t('review:dueAll.subtitle', { defaultValue: '所有题目集里今天到期的错题' })}
          </span>
          {phase.kind === 'ready' && phase.missing > 0 && (
            <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">
              {t('review:dueAll.skipped', { count: phase.missing, defaultValue: '已跳过 {{count}} 道已删除的题' })}
            </span>
          )}
        </div>
        {phase.kind === 'ready' ? (
          <ReviewSession examId={DUE_MISTAKES_SESSION_KEY} isActive onClose={close} className="min-h-0 flex-1" />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            {phase.kind === 'loading' && (
              <>
                <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">
                  {t('review:dueAll.loading', { defaultValue: '正在准备到期错题…' })}
                </p>
              </>
            )}
            {phase.kind === 'empty' && (
              <>
                <CheckCircle size={28} weight="duotone" className="text-success" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">
                  {t('review:dueAll.empty', { defaultValue: '今天没有到期的错题' })}
                </p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {t('review:dueAll.emptyHint', { defaultValue: '做题答错的题会自动加入复习计划，到期后出现在这里。' })}
                </p>
              </>
            )}
            {phase.kind === 'error' && (
              <>
                <WarningCircle size={28} className="text-warning" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">
                  {t('review:dueAll.loadFailed', { defaultValue: '加载到期错题失败' })}
                </p>
                <p className="max-w-sm break-words text-xs text-muted-foreground">{phase.message}</p>
              </>
            )}
            {phase.kind !== 'loading' && (
              <DsButton variant="ghost" size="sm" onClick={close} className="mt-1">
                {t('common:close')}
              </DsButton>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default DueMistakesReviewOverlay;
