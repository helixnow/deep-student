/**
 * 制卡任务面板应用窗口（P9 薄包装 → O18 窗口化打磨）
 *
 * 复用 `TaskDashboardPage`；页面内两个导航回调改走 workbenchBus：
 * - 「去聊天」→ launch chat 窗口（instanceKey = sessionId，与 P7 约定一致）；
 * - 「模板管理」→ launch templates 窗口。
 *
 * O18 打磨（任务进行中的窗口呈现，设计文档 §4.4 投射）：
 * - 窗口标题实时携带进行中任务数（「制卡任务 · 3」），Dock 弹层 /
 *   窗口切换器 / 俯瞰里一眼可见后台任务负载；
 * - 任务进行中时窗口顶缘 2px 活动条（跑马光带），与 Dock count 角标呼应；
 * - lazy 化 + 仪表盘形态骨架屏 + 内容淡入。
 *
 * 计数源：ankiTaskSource 的共享 watcher（轮询 + anki_generation_event 触发），
 * useSyncExternalStore 订阅，与投射源/Dock 角标同一数据事实。
 */
import React, { Suspense, useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { workbenchBus } from '../../core/workbenchBus';
import { openChatSession } from '../chat/newSession';
import type { AppWindowProps } from '../../core/types';
import { getActiveAnkiTaskCount, subscribeAnkiTaskCount } from './ankiTaskSource';
import { WbSysActivityStrip, WbSysFade, WbSysSkeleton } from './SystemWindowShared';
import { useWbSysSize } from './useWbSysSize';

const TaskDashboardPage = React.lazy(() =>
  import('@/components/anki/TaskDashboardPage').then((m) => ({ default: m.TaskDashboardPage })),
);

const getServerAnkiCount = () => 0;

const TaskDashboardAppWindow: React.FC<AppWindowProps> = ({ windowId, onTitleChange, isVisible }) => {
  const { t } = useTranslation('workbench');
  const { ref } = useWbSysSize();
  const activeCount = useSyncExternalStore(
    subscribeAnkiTaskCount,
    getActiveAnkiTaskCount,
    getServerAnkiCount,
  );

  useEffect(() => {
    const base = t('workbench:apps.taskDashboard');
    onTitleChange(activeCount > 0 ? `${base} · ${activeCount}` : base);
  }, [onTitleChange, t, activeCount]);

  return (
    <div
      ref={ref}
      className="relative h-full w-full min-w-0 overflow-hidden bg-background"
      data-wb-sys-app="taskDashboard"
    >
      <WbSysActivityStrip
        active={activeCount > 0}
        label={t('workbench:apps.system.tasksRunning', {
          count: activeCount,
        })}
      />
      <Suspense fallback={<WbSysSkeleton variant="dashboard" />}>
        <WbSysFade>
          <TaskDashboardPage
            workbenchWindowId={windowId}
            isVisible={isVisible}
            onNavigateToChat={(sessionId) => openChatSession(sessionId, 'api')}
            onOpenTemplateManagement={() =>
              workbenchBus.launch({ typeId: 'templates', reason: 'api' })
            }
          />
        </WbSysFade>
      </Suspense>
    </div>
  );
};

export default TaskDashboardAppWindow;
