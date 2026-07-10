/**
 * 闪卡应用窗口（M3 薄包装）
 *
 * 对标 TaskDashboardAppWindow：WbSys 骨架 + 淡入 + launchPayload 透传。
 */
import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';
import '@/features/flashcards/flashcards.css';

const FlashcardsApp = React.lazy(() =>
  import('@/features/flashcards/FlashcardsApp').then((m) => ({ default: m.FlashcardsApp })),
);

const FlashcardsAppWindow: React.FC<AppWindowProps> = ({ launchPayload, onTitleChange }) => {
  const { t } = useTranslation('workbench');
  const { ref } = useWbSysSize();

  useEffect(() => {
    onTitleChange(t('workbench:apps.flashcards', '闪卡'));
  }, [onTitleChange, t]);

  return (
    <div
      ref={ref}
      className="wb-fc-host relative h-full w-full min-w-0 overflow-hidden"
      data-wb-sys-app="flashcards"
    >
      <Suspense fallback={<WbSysSkeleton variant="list" />}>
        <WbSysFade>
          <FlashcardsApp launchPayload={launchPayload} />
        </WbSysFade>
      </Suspense>
    </div>
  );
};

export default FlashcardsAppWindow;
