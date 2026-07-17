/**
 * 模板管理应用窗口（P9 薄包装 → O18 窗口化打磨）
 *
 * `TemplateManagementPage` 依赖 `useDesktopShellSidebarPortal('template-management')`：
 * workbench 窗口内没有壳侧栏 portal 目标 → 组件自动回退为内部侧栏布局，无需额外适配。
 * O18 打磨：lazy 化 + 列表形态骨架屏 + 内容淡入 + 尺寸分级 data 属性。
 */
import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';

const TemplateManagementPage = React.lazy(() => import('@/components/TemplateManagementPage'));

const TemplatesAppWindow: React.FC<AppWindowProps> = ({ windowId, onTitleChange }) => {
  const { t } = useTranslation('workbench');
  const { ref } = useWbSysSize();

  useEffect(() => {
    onTitleChange(t('workbench:apps.templates'));
  }, [onTitleChange, t]);

  return (
    <div
      ref={ref}
      className="relative h-full w-full min-w-0 overflow-hidden bg-background"
      data-wb-sys-app="templates"
    >
      <Suspense fallback={<WbSysSkeleton variant="list" />}>
        <WbSysFade>
          <TemplateManagementPage workbenchWindowId={windowId} />
        </WbSysFade>
      </Suspense>
    </div>
  );
};

export default TemplatesAppWindow;
