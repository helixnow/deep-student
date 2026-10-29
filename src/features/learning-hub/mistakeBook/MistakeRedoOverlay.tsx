import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import BatchPracticeWorkspace from '@/components/practice/BatchPracticeWorkspace';
import { newPracticeId, type CreatePracticeRequest } from '@/api/practiceApi';
import { Z_INDEX } from '@/config/zIndex';
import { BACK_PRIORITY, registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { refreshTodayLearning } from '@/features/learning-today/todayLearningStore';
import { MISTAKE_REDO_SESSION_KEY } from './useMistakeRedoSession';

export interface MistakeRedoOverlayProps {
  questionIds: string[];
  examNames: Record<string, string | null>;
  onClose: () => void;
  practiceId?: string;
  submitted?: boolean;
}

export default function MistakeRedoOverlay({
  questionIds,
  onClose,
  practiceId,
  submitted,
}: MistakeRedoOverlayProps) {
  const { t } = useTranslation(['learningHub', 'common']);
  const flushRef = useRef<(() => Promise<void>) | null>(null);
  // Nested DsDialogs portal outside this node and retain their own focus trap.
  const dialogRef = useFocusTrap<HTMLDivElement>(true, { initialFocus: false });
  useEffect(() => {
    // Start on the answer surface, not on the close button's native Enter action.
    dialogRef.current?.focus({ preventScroll: true });
  }, [dialogRef]);
  const [request] = useState<CreatePracticeRequest>(() => ({
    id: newPracticeId(),
    scope_id: MISTAKE_REDO_SESSION_KEY,
    mode: 'mistake_redo',
    title: t('learningHub:mistakeBook.redoSet.title'),
    question_ids: questionIds,
  }));
  const installFlush = useCallback((flush: (() => Promise<void>) | null) => {
    flushRef.current = flush;
  }, []);
  const close = useCallback(async () => {
    try {
      await flushRef.current?.();
      onClose();
      void refreshTodayLearning();
    } catch {
      // The workspace displays the save failure and retains the answers.
    }
  }, [onClose]);

  useEffect(
    () =>
      registerBackHandler(() => {
        void close();
        return true;
      }, BACK_PRIORITY.overlay),
    [close],
  );

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
        aria-label={t('learningHub:mistakeBook.redoSet.title')}
        tabIndex={-1}
        className="flex h-full w-full flex-col overflow-hidden bg-background pt-[var(--mobile-safe-area-top)] outline-none sm:h-[min(860px,calc(100dvh-6rem))] sm:w-[min(1100px,calc(100vw-3rem))] sm:rounded-lg sm:border sm:pt-0"
      >
        <div className="flex items-center gap-2 border-b px-4 py-1.5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {t('learningHub:mistakeBook.redoSet.title')}
          </h2>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            aria-label={t('common:close')}
            title={t('common:close')}
            onClick={() => void close()}
          >
            <X size={16} />
          </DsButton>
        </div>
        <div className="min-h-0 flex-1">
          <BatchPracticeWorkspace
            request={practiceId ? undefined : request}
            practiceId={practiceId}
            submitted={submitted}
            onFlushReady={installFlush}
            onBack={() => void close()}
            isActive
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export { MistakeRedoOverlay };
