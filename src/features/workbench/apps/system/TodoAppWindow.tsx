/**
 * 待办应用窗口（P9 薄包装 → O18 窗口化打磨）
 *
 * 复用 `TodoContentView`（桌面端只渲染主面板）+ `TodoShellSidebar`
 * （legacy 模式下该侧栏由 App 壳渲染在导航槽位；窗口内自带一份，
 * 通过局部清零 --shell-titlebar-height/--shell-layout-gap 去掉壳位顶部留白）。
 *
 * O18 打磨：
 * - legacy 页面 lazy 化 + 「侧栏 + 内容」形态骨架屏（不再是通用转圈）；
 * - 窗口尺寸自适应：宽窗侧栏并排，中窗收窄，窄窗（<640px）收纳为
 *   左缘把手 + 玻璃抽屉（legacy 断点看视口，窗口内拿不到紧凑布局）；
 * - 内容就绪淡入。
 */
import React, { Suspense, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { TodoContentView, TodoShellSidebar } from '@/features/todo';
import type { AppWindowProps } from '../../core/types';
import { WbSysFade, WbSysSidebarLayout, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';

const SHELL_VAR_RESET = {
  '--shell-titlebar-height': '0px',
  '--shell-layout-gap': '0px',
} as React.CSSProperties;

const TodoAppWindow: React.FC<AppWindowProps> = ({ launchPayload, onTitleChange }) => {
  const { t } = useTranslation('workbench');
  const { ref, sizeClass } = useWbSysSize();

  useEffect(() => {
    onTitleChange(t('workbench:apps.todo', '待办'));
  }, [onTitleChange, t]);

  const todoListId =
    launchPayload && typeof launchPayload === 'object' &&
    typeof (launchPayload as { todoListId?: unknown }).todoListId === 'string'
      ? (launchPayload as { todoListId: string }).todoListId
      : undefined;

  return (
    <div
      ref={ref}
      className="h-full w-full min-w-0 overflow-hidden bg-background"
      style={SHELL_VAR_RESET}
      data-wb-sys-app="todo"
    >
      <Suspense fallback={<WbSysSkeleton variant="sidebar" />}>
        <WbSysFade>
          <WbSysSidebarLayout
            sizeClass={sizeClass}
            navLabel={t('workbench:apps.system.todoNav', '待办导航')}
            sidebar={<TodoShellSidebar isSmallScreen={false} globalLeftPanelCollapsed={false} />}
          >
            <TodoContentView todoListId={todoListId} className="h-full" />
          </WbSysSidebarLayout>
        </WbSysFade>
      </Suspense>
    </div>
  );
};

export default TodoAppWindow;
