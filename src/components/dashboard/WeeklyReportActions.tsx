/**
 * 首页「本周周报」入口：确定性周报（本地统计，不经 LLM）可存为笔记，
 * 也可带进对话让 AI 基于真实数据做复盘。
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartLineUp, ChatCircleText } from '@phosphor-icons/react';
import { SaveAsNoteFolderPicker, useSaveAsNoteFlow } from '@/shared/notes';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { showGlobalNotification } from '@/components/UnifiedNotification';

async function buildReport(t: (key: string, options?: Record<string, unknown>) => string) {
  const { loadWeeklyReportData, buildWeeklyReportMarkdown, weeklyReportTitle } = await import('@/features/learning-today/weeklyReport');
  const data = await loadWeeklyReportData();
  return { title: weeklyReportTitle(data, t), markdown: buildWeeklyReportMarkdown(data, t) };
}

const linkClass =
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:min-h-11';

export const WeeklyReportActions: React.FC = () => {
  const { t } = useTranslation('data');
  const tr = useCallback((key: string, options?: Record<string, unknown>) => t(key, options) as string, [t]);
  const saveAsNoteFlow = useSaveAsNoteFlow({ openSource: 'weekly-report' });
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (use: (report: { title: string; markdown: string }) => void) => {
    if (busy) return;
    setBusy(true);
    try {
      use(await buildReport(tr));
    } catch (error: unknown) {
      console.error('[WeeklyReport] build failed:', error);
      showGlobalNotification('error', tr('weekly_report.failed', { defaultValue: '周报生成失败' }));
    } finally {
      setBusy(false);
    }
  }, [busy, tr]);

  return (
    <span className="ml-auto flex items-center gap-1">
      <button
        type="button"
        className={linkClass}
        disabled={busy}
        onClick={() => void run(({ title, markdown }) => saveAsNoteFlow.start({ title, content: markdown, tags: [tr('weekly_report.tag', { defaultValue: '周报' })] }))}
      >
        <ChartLineUp size={13} aria-hidden="true" />
        {tr('weekly_report.save_note', { defaultValue: '本周周报' })}
      </button>
      <button
        type="button"
        className={linkClass}
        disabled={busy}
        onClick={() => void run(({ title, markdown }) => {
          // 复盘是独立话题：新开对话再填入，不混进当前会话
          dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
            content: tr('weekly_report.chat_prompt', {
              title,
              report: markdown,
              defaultValue: '这是我的{{title}}（来自本地学习记录）：\n\n{{report}}\n\n请帮我复盘：指出最值得关注的 2–3 个问题，并给出下周可执行的学习安排。',
            }),
            autoSend: false,
            newSession: true,
          });
        })}
      >
        <ChatCircleText size={13} aria-hidden="true" />
        {tr('weekly_report.chat', { defaultValue: '与 AI 复盘' })}
      </button>
      <SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />
    </span>
  );
};
