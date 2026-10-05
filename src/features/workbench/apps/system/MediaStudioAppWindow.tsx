/**
 * 音视频应用窗口（学习桌面）：薄包装经典壳同一个 MediaStudioApp（库页 / 学习页）。
 * 播放与引用跳转跟随窗口可见性（isVisible）而非焦点：边看视频边在别的窗口记笔记是常态。
 */
import React, { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';
import { MediaStudioApp } from '@/features/media-studio/MediaStudioApp';

const MediaStudioAppWindow: React.FC<AppWindowProps> = ({
  launchPayload,
  isVisible,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const { ref } = useWbSysSize();
  const appName = t('workbench:apps.media');

  useEffect(() => {
    onTitleChange(appName);
  }, [appName, onTitleChange]);

  const handleTitleChange = useCallback((title: string | null) => {
    onTitleChange(title ? `${appName} · ${title}` : appName);
  }, [appName, onTitleChange]);

  return (
    <div
      ref={ref}
      className="relative h-full w-full min-w-0 overflow-hidden bg-background"
      data-wb-sys-app="media"
    >
      <WbSysFade>
        <MediaStudioApp
          embedded
          isActive={isVisible}
          launchPayload={launchPayload}
          onTitleChange={handleTitleChange}
        />
      </WbSysFade>
    </div>
  );
};

export default MediaStudioAppWindow;
