/**
 * 模板管理应用窗口（P9 薄包装 → O18 窗口化打磨）
 *
 * `TemplateManagementApp` 依赖 `useDesktopShellSidebarPortal('template-management')`：
 * workbench 窗口内没有壳侧栏 portal 目标 → 组件切换为顶部标签导航布局（wb-tm-nav）。
 * O18 打磨：lazy 化 + 列表形态骨架屏 + 内容淡入 + 尺寸分级 data 属性。
 * ⌘/Ctrl+F：窗口聚焦时把焦点送进工具栏模板搜索框（与设置窗口同范式），
 * 随后 ↓/Enter 可把焦点交给第一张模板卡进入方向键导航（见 TemplateToolbar）。
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

  // ⌘/Ctrl+F → 聚焦模板搜索。门禁：本窗聚焦（data-focused）且事件发生在窗内；
  // capture 阶段消费，抢在 WebView 原生查找 / 其他全局监听之前。
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'f') return;
      const host = ref.current;
      if (!host) return;
      const windowShell = host.closest<HTMLElement>('[data-wb-window]');
      if (windowShell && !windowShell.hasAttribute('data-focused')) return;
      const scope = windowShell ?? host;
      const target = e.target as HTMLElement | null;
      if (!target || !scope.contains(target)) return;
      const input = host.querySelector<HTMLInputElement>('[data-template-search]');
      if (!input) return;
      e.preventDefault();
      e.stopPropagation();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [ref]);

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
