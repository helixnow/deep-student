/**
 * 题目集演示的薄包装：题目集窗口本体 + 本章另外两处入口在单窗口里的落点。
 *
 * - 「所有题目集的错题」在应用里会打开资源库 › 错题本；这里在窗口上叠一层同一份
 *   MistakeBookView（生产组件），关掉回到题目集。
 * - 错题本 / 复习计划里的「复习到期错题」走生产的 DueMistakesReviewHost。
 * - 「去题目集重做」在应用里经 NAVIGATE_TO_VIEW 开题目集：这里切到对应题目集。
 * - 「问 AI 讲解 / 生成同类题」在应用里会新开对话预填输入框：演示里给一句提示。
 * 只被 ../question-bank.ts 的 load() 动态加载，可以直接 import app 模块。
 */
import React, { Suspense, useEffect, useState } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import type { AppWindowProps } from '@/features/workbench/core/types';
import { createContentWindowComponent } from '@/features/workbench/apps/content/ContentAppWindow';
import { requestResourceWorkspace } from '@/features/workbench/apps/content/resourceWorkspaceRegistry';
import { DueMistakesReviewHost } from '@/features/learning-today/DueMistakesReviewHost';
import { EXAMS_VIEW_EVENT } from '@/features/learning-hub/mistakeBook/mistakeBookNavigation';
import { NotificationContainer } from '@/components/NotificationContainer';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { APP_EVENTS } from '@/events';
import { tr } from '../../../lang';

const ExamWindow = createContentWindowComponent('exam');
const MistakeBookView = React.lazy(() =>
  import('@/features/learning-hub/mistakeBook/MistakeBookView').then((m) => ({ default: m.MistakeBookView })),
);

const QuestionBankDemo: React.FC<AppWindowProps> = (props) => {
  const [mistakesOpen, setMistakesOpen] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const onExamsView = (event: Event) => {
      if ((event as CustomEvent<{ view?: string }>).detail?.view === 'mistakes') setMistakesOpen(true);
    };
    const onNavigate = (event: Event) => {
      const target = (event as CustomEvent<{ openResource?: string }>).detail?.openResource;
      if (!target) return;
      setMistakesOpen(false);
      requestResourceWorkspace('exam', target.replace(/^\//, ''));
    };
    const onPrefill = () => {
      showGlobalNotification('info', tr(
        '桌面版会新开一个对话，把题目和你的答案填进输入框，补充后再发送。',
        'In the desktop app this opens a new chat with the question and your answer filled in.',
      ));
    };
    window.addEventListener(EXAMS_VIEW_EVENT, onExamsView);
    window.addEventListener('NAVIGATE_TO_VIEW', onNavigate);
    window.addEventListener(APP_EVENTS.PREFILL_CHAT_INPUT, onPrefill);
    return () => {
      window.removeEventListener(EXAMS_VIEW_EVENT, onExamsView);
      window.removeEventListener('NAVIGATE_TO_VIEW', onNavigate);
      window.removeEventListener(APP_EVENTS.PREFILL_CHAT_INPUT, onPrefill);
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <ExamWindow {...props} />
      {mistakesOpen && (
        <div className="absolute inset-0 z-30 flex flex-col bg-background">
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/60 px-4">
            <span className="text-sm font-semibold">{tr('错题本', 'Mistake book')}</span>
            <label className="ml-auto flex h-8 w-56 max-w-[45vw] items-center gap-1.5 rounded-md bg-muted/60 px-2 text-sm text-muted-foreground">
              <MagnifyingGlass size={14} aria-hidden />
              <input
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
                placeholder={tr('搜索错题', 'Search mistakes')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button
              type="button"
              aria-label={tr('关闭错题本', 'Close')}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setMistakesOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <Suspense fallback={null}>
              <MistakeBookView search={search} />
            </Suspense>
          </div>
        </div>
      )}
      <DueMistakesReviewHost />
      <NotificationContainer />
    </div>
  );
};

export default QuestionBankDemo;
