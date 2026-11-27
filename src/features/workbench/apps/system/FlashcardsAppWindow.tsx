/**
 * 闪卡应用窗口（M3 薄包装）
 *
 * 对标 TaskDashboardAppWindow：WbSys 骨架 + 淡入 + launchPayload 透传。
 */
import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MobileHeaderActiveViewSync,
  MobileHeaderNavProvider,
  MobileHeaderProvider,
} from '@/components/layout/MobileHeaderContext';
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
  const appTitle = t('workbench:apps.flashcards');
  const mobileHeaderNav = useMemo(
    () => ({ fallbackTitle: appTitle }),
    [appTitle],
  );

  useEffect(() => {
    onTitleChange(appTitle);
  }, [onTitleChange, appTitle]);

  return (
    <div
      ref={ref}
      className="wb-fc-host relative h-full w-full min-w-0 overflow-hidden"
      data-wb-sys-app="flashcards"
    >
      <WbSysFade>
        {/* 窗口内隔离 MobileHeaderContext：避免 360px 工作台模式下继承外层 chat-v2 顶栏标题与按钮 */}
        <MobileHeaderProvider>
          <MobileHeaderActiveViewSync activeView="flashcards" />
          <MobileHeaderNavProvider value={mobileHeaderNav}>
            <FlashcardsApp launchPayload={launchPayload} isActive={isActive} embedded />
          </MobileHeaderNavProvider>
        </MobileHeaderProvider>
      </WbSysFade>
    </div>
  );
};

export default FlashcardsAppWindow;
