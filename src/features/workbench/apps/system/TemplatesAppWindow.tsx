/**
 * 模板管理应用窗口（P9 薄包装 → O18 窗口化打磨）
 *
 * `TemplateManagementApp` 依赖 `useDesktopShellSidebarPortal('template-management')`：
 * workbench 窗口内没有壳侧栏 portal 目标 → 组件切换为顶部标签导航布局（wb-tm-nav）。
 * O18 打磨：lazy 化 + 列表形态骨架屏 + 内容淡入 + 尺寸分级 data 属性。
 */
import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';

const TemplateManagementApp = React.lazy(() => import('@/features/template-management/TemplateManagementApp'));

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
          <TemplateManagementApp workbenchWindowId={windowId} />
        </WbSysFade>
      </Suspense>
    </div>
  );
};

export default TemplatesAppWindow;
