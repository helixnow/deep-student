/**
 * 闪卡应用窗口（M3 薄包装）
 *
 * 对标 TaskDashboardAppWindow：WbSys 骨架 + 淡入 + launchPayload 透传。
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';
import { FlashcardsApp } from '@/features/flashcards/FlashcardsApp';
import '@/features/flashcards/flashcards.css';
import '@/features/flashcards/flashcards-dashboard.css';

const FlashcardsAppWindow: React.FC<AppWindowProps> = ({
  launchPayload,
  isActive,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const { ref } = useWbSysSize();

  useEffect(() => {
    onTitleChange(t('workbench:apps.flashcards'));
  }, [onTitleChange, t]);

  return (
    <div
      ref={ref}
      className="wb-fc-host relative h-full w-full min-w-0 overflow-hidden"
      data-wb-sys-app="flashcards"
    >
      <WbSysFade>
        <FlashcardsApp launchPayload={launchPayload} isActive={isActive} />
      </WbSysFade>
    </div>
  );
};

export default FlashcardsAppWindow;
