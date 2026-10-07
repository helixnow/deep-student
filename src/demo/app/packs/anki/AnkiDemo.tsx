/**
 * 制卡演示的薄包装：「Anki 制卡」任务看板本体 + 看板里两个跨应用入口在单窗口里的落点。
 *
 * - 「管理模板 / 打开模板库」在学习桌面里会另开「模板管理」窗口：这里切到同一份
 *   TemplatesAppWindow（生产组件），顶部给一个返回看板的条。
 * - 「跳转到聊天 / 去聊天发起制卡」在应用里会打开对话：演示里给一句提示。
 * 两者都经 workbenchBus.launch；学习桌面没启用时它交给 legacy fallback，这里注册的就是它。
 * 只被 ../anki.ts 的 load() 动态加载，可以直接 import app 模块。
 */
import React, { useEffect, useState } from 'react';
import { ArrowLeft } from '@phosphor-icons/react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import TaskDashboardAppWindow from '@/features/workbench/apps/system/TaskDashboardAppWindow';
import TemplatesAppWindow from '@/features/workbench/apps/system/TemplatesAppWindow';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import { NotificationContainer } from '@/components/NotificationContainer';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { tr } from '../../../lang';

const AnkiDemo: React.FC<AppWindowProps> = (props) => {
  const [view, setView] = useState<'tasks' | 'templates'>('tasks');

  useEffect(() => {
    workbenchBus.registerLegacyFallback((req) => {
      if (req.typeId === 'templates') {
        setView('templates');
        return;
      }
      if (req.typeId === 'chat' || req.typeId.startsWith('chat')) {
        showGlobalNotification('info', tr(
          '桌面版会回到发起制卡的对话，可以在「Anki 卡片」块里继续编辑、换模板或让 AI 补卡。',
          'In the desktop app this opens the chat where the cards were made, so you can keep editing them there.',
        ));
      }
    });
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col">
      {view === 'templates' && (
        <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-2">
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => setView('tasks')}
          >
            <ArrowLeft size={14} aria-hidden />
            {tr('制卡任务', 'Card tasks')}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {view === 'tasks' ? (
          <TaskDashboardAppWindow {...props} />
        ) : (
          <TemplatesAppWindow {...props} windowId={`${props.windowId}-templates`} />
        )}
      </div>
      <NotificationContainer />
    </div>
  );
};

export default AnkiDemo;
