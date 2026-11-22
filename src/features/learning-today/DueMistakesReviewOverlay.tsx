import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { ReviewSession } from '@/components/ReviewSession';
import { UnifiedMobileHeader } from '@/components/layout';
import { Z_INDEX } from '@/config/zIndex';
import { useBreakpoint } from '@/hooks/useBreakpoint';
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
  const { isSmallScreen } = useBreakpoint();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startSession = useReviewPlanStore((state) => state.startSession);
  const endSession = useReviewPlanStore((state) => state.endSession);

  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
  }, []);

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

  const disarmExit = useCallback(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    setExitArmed(false);
  }, []);

  const close = useCallback(() => {
    disarmExit();
    if (useReviewPlanStore.getState().session.examId === DUE_MISTAKES_SESSION_KEY) endSession();
    closeDueMistakesReview();
    void refreshTodayLearning();
  }, [disarmExit, endSession]);

  const hasActiveRemainingSession = useCallback(() => {
    if (phase.kind !== 'ready') return false;
    const session = useReviewPlanStore.getState().session;
    return (
      session.isActive
      && session.examId === DUE_MISTAKES_SESSION_KEY
      && session.currentIndex < session.queue.length
    );
  }, [phase.kind]);

  // 移动端顶栏返回按钮与物理返回键走二次确认，避免单手误触丢弃剩余队列
  const requestExitWithConfirm = useCallback(() => {
    if (!hasActiveRemainingSession()) {
      close();
      return;
    }
    if (!exitArmed) {
      setExitArmed(true);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        setExitArmed(false);
      }, 4000);
      return;
    }
    close();
  }, [close, exitArmed, hasActiveRemainingSession]);

  // 今天没有到期的也可能有没掌握的错题：去跨题目集错题本
  const openAllMistakes = useCallback(() => {
    close();
    void import('@/features/learning-hub/mistakeBook/mistakeBookNavigation').then(({ openMistakeBook }) => openMistakeBook());
  }, [close]);

  // 自绘浮层不在 Radix 的 Escape 兜底里：Android 返回键要显式接住，否则会切走浮层下面的页面。
  const requestExitRef = useRef(requestExitWithConfirm);
  requestExitRef.current = requestExitWithConfirm;
  useEffect(() => registerBackHandler(() => {
    requestExitRef.current();
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
  const baseSubtitle = t('review:dueAll.subtitle', { defaultValue: '所有题目集里今天到期的错题' });
  const mobileSubtitle =
    phase.kind === 'ready' && phase.missing > 0
      ? t('review:dueAll.skipped', { count: phase.missing, defaultValue: '已跳过 {{count}} 道已删除的题' })
      : baseSubtitle;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40 p-0 md:p-6"
      style={{ zIndex: Z_INDEX.modal }}
      data-testid="due-mistakes-review"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden bg-background outline-none md:h-[min(860px,calc(100dvh-6rem))] md:w-[min(920px,calc(100vw-3rem))] md:rounded-xl md:border md:border-border md:shadow-xl"
      >
        {isSmallScreen ? (
          <>
            <UnifiedMobileHeader
              className="relative shrink-0"
              configOverride={{
                title,
                subtitle: mobileSubtitle,
                showBackArrow: true,
                onMenuClick: requestExitWithConfirm,
              }}
            />
            {exitArmed ? (
              <div
                role="status"
                data-testid="due-mistakes-exit-confirm"
                className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground"
              >
                <span className="min-w-0 flex-1">
                  {t('review:dueAll.exitConfirmHint', {
                    defaultValue: '再按一次返回退出复习（已评题目已保存）',
                  })}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={disarmExit}
                    className="min-h-9 px-2.5 text-xs"
                  >
                    {t('review:dueAll.continueReview', { defaultValue: '继续复习' })}
                  </DsButton>
                  <DsButton
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="due-mistakes-confirm-exit"
                    onClick={close}
                    className="min-h-9 border-destructive/40 px-2.5 text-xs text-destructive hover:bg-destructive/10"
                  >
                    {t('review:dueAll.confirmExit', { defaultValue: '确认退出' })}
                  </DsButton>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-shrink-0 items-baseline gap-2 border-b border-border/50 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            <span className="truncate text-xs text-muted-foreground">
              {baseSubtitle}
            </span>
            {phase.kind === 'ready' && phase.missing > 0 && (
              <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">
                {t('review:dueAll.skipped', { count: phase.missing, defaultValue: '已跳过 {{count}} 道已删除的题' })}
              </span>
            )}
          </div>
        )}
        {phase.kind === 'ready' ? (
          <ReviewSession
            examId={DUE_MISTAKES_SESSION_KEY}
            isActive
            onClose={close}
            hideExitButton={isSmallScreen}
            className="min-h-0 flex-1"
          />
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
              <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
                {phase.kind === 'empty' && (
                  <DsButton variant="outline" size="sm" onClick={openAllMistakes}>
                    {t('review:dueAll.openMistakeBook', { defaultValue: '查看全部错题' })}
                  </DsButton>
                )}
                <DsButton variant="ghost" size="sm" onClick={close}>
                  {t('common:close')}
                </DsButton>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default DueMistakesReviewOverlay;
