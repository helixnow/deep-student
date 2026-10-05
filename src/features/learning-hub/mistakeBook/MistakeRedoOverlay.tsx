/**
 * 错题批量重做浮层：错题本里选中的一批错题当一套题做，复用题目集的做题界面。
 * Portal 到 body，经典壳 / 学习桌面 / 手机端共用；作答即时写回原题，关掉不丢已交的答案。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle, CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { QuestionBankEditor } from '@/components/QuestionBankEditor';
import { Z_INDEX } from '@/config/zIndex';
import { BACK_PRIORITY, registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { refreshTodayLearning } from '@/features/learning-today/todayLearningStore';
import { MISTAKE_REDO_SESSION_KEY, useMistakeRedoSession } from './useMistakeRedoSession';

export interface MistakeRedoOverlayProps {
  questionIds: string[];
  /** 题目集 id → 名称：题头标出当前题出自哪个题目集 */
  examNames: Record<string, string | null>;
  onClose: () => void;
}

export const MistakeRedoOverlay: React.FC<MistakeRedoOverlayProps> = ({ questionIds, examNames, onClose }) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const session = useMistakeRedoSession(questionIds);
  const { phase } = session;

  const close = useCallback(() => {
    onClose();
    void refreshTodayLearning();
  }, [onClose]);

  // 自绘浮层不在 Radix 的 Escape 兜底里：Android 返回键要显式接住，否则会切走浮层下面的页面
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => registerBackHandler(() => {
    closeRef.current();
    return true;
  }, BACK_PRIORITY.overlay), []);

  // 打开即把焦点移进浮层：做题快捷键只在浮层里生效，背后的做题页让行
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus({ preventScroll: true });
  }, []);

  // 做题时 Esc 不关（没提交的作答会丢），只用来关掉加载 / 空 / 失败态
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

  const title = t('learningHub:mistakeBook.redoSet.title');
  const examName = session.currentExamId ? examNames[session.currentExamId] : undefined;
  const source = phase.kind === 'ready'
    ? t('learningHub:mistakeBook.redoSet.from', {
        exam: examName || t('learningHub:mistakeBook.untitledExam'),
      })
    : null;

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/40 p-0 sm:p-6"
      style={{ zIndex: Z_INDEX.modal }}
      data-testid="mistake-redo"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden bg-background pt-[var(--mobile-safe-area-top)] outline-none sm:h-[min(860px,calc(100dvh-6rem))] sm:w-[min(920px,calc(100vw-3rem))] sm:rounded-xl sm:border sm:border-border sm:pt-0 sm:shadow-xl"
      >
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/50 py-1.5 pl-4 pr-2">
          <h2 className="flex-shrink-0 text-sm font-semibold text-foreground">{title}</h2>
          {source ? <span className="min-w-0 truncate text-xs text-muted-foreground">{source}</span> : null}
          {phase.kind === 'ready' && session.missing > 0 ? (
            <span className="hidden flex-shrink-0 text-xs text-muted-foreground sm:inline">
              {t('learningHub:mistakeBook.redoSet.skipped', { count: session.missing })}
            </span>
          ) : null}
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            className="ml-auto flex-shrink-0"
            aria-label={t('common:close')}
            title={t('common:close')}
            onClick={close}
          >
            <X size={16} />
          </DsButton>
        </div>
        {phase.kind === 'ready' ? (
          <QuestionBankEditor
            sessionId={session.currentExamId ?? MISTAKE_REDO_SESSION_KEY}
            practiceSessionOwner={session.owner}
            questions={session.questions}
            currentIndex={session.currentIndex}
            practiceMode="sequential"
            showTimer={false}
            isActive
            onSubmitAnswer={session.submitAnswer}
            onNavigate={session.navigate}
            onMarkCorrect={session.markCorrect}
            onRefreshQuestion={session.refreshQuestion}
            onToggleFavorite={session.toggleFavorite}
            className="min-h-0 flex-1"
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            {phase.kind === 'loading' && (
              <>
                <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground">{t('learningHub:mistakeBook.redoSet.loading')}</p>
              </>
            )}
            {phase.kind === 'empty' && (
              <>
                <CheckCircle size={28} weight="duotone" className="text-success" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">{t('learningHub:mistakeBook.redoSet.empty')}</p>
                <p className="max-w-sm text-xs text-muted-foreground">{t('learningHub:mistakeBook.redoSet.emptyHint')}</p>
              </>
            )}
            {phase.kind === 'error' && (
              <>
                <WarningCircle size={28} className="text-warning" aria-hidden="true" />
                <p className="text-sm font-medium text-foreground">{t('learningHub:mistakeBook.loadFailed')}</p>
                <p className="max-w-sm break-words text-xs text-muted-foreground">{phase.message}</p>
              </>
            )}
            {phase.kind !== 'loading' && (
              <DsButton variant="ghost" size="sm" onClick={close}>
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

export default MistakeRedoOverlay;
