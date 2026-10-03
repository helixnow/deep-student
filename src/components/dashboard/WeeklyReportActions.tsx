/**
 * 首页「本周周报」入口：确定性周报（本地统计，不经 LLM）。
 * 点「本周周报」先打开预览（此前直接弹「选择保存目录」，看不到周报内容就要先选存哪），
 * 预览里可存为笔记，也可带进对话让 AI 基于真实数据做复盘。
 */
import React, { Suspense, lazy, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartLineUp, ChatCircleText, NotePencil } from '@phosphor-icons/react';
import { SaveAsNoteFolderPicker, useSaveAsNoteFlow } from '@/shared/notes';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/shad/Dialog';
import { DsButton } from '@/components/ui/DsButton';

const MarkdownRenderer = lazy(() =>
  import('@/features/chat/components/renderers/MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer })),
);

interface WeeklyReport {
  title: string;
  markdown: string;
}

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

  const [preview, setPreview] = useState<WeeklyReport | null>(null);

  const saveReport = useCallback(({ title, markdown }: WeeklyReport) => {
    saveAsNoteFlow.start({ title, content: markdown, tags: [tr('weekly_report.tag', { defaultValue: '周报' })] });
  }, [saveAsNoteFlow, tr]);

  const reviewWithAi = useCallback(({ title, markdown }: WeeklyReport) => {
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
  }, [tr]);

  const run = useCallback(async (consume: (report: WeeklyReport) => void) => {
    if (busy) return;
    setBusy(true);
    try {
      consume(await buildReport(tr));
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
        onClick={() => void run(setPreview)}
      >
        <ChartLineUp size={13} aria-hidden="true" />
        {tr('weekly_report.save_note', { defaultValue: '本周周报' })}
      </button>
      <button
        type="button"
        className={linkClass}
        disabled={busy}
        onClick={() => void run(reviewWithAi)}
      >
        <ChatCircleText size={13} aria-hidden="true" />
        {tr('weekly_report.chat', { defaultValue: '与 AI 复盘' })}
      </button>
      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        {preview ? (
          <DialogContent
            className="flex max-h-[min(80vh,760px)] w-[min(720px,calc(100vw-32px))] max-w-none flex-col p-0"
            aria-labelledby="weekly-report-preview-title"
          >
            <DialogHeader className="border-b border-border/40 px-5 py-4">
              <DialogTitle id="weekly-report-preview-title">{preview.title}</DialogTitle>
            </DialogHeader>
            {/* 聊天同款 Markdown 排版（段距 / 列表 / 表格）挂在 .chat-v2 作用域下 */}
            <div
              className="chat-v2 min-h-0 flex-1 overflow-y-auto px-5 py-3"
              style={{ '--chat-body-font-size': '1rem', '--chat-md-line-height': '1.65' } as React.CSSProperties}
            >
              <Suspense fallback={<pre className="whitespace-pre-wrap text-sm text-muted-foreground">{preview.markdown}</pre>}>
                <MarkdownRenderer content={preview.markdown} className="text-ui text-foreground" />
              </Suspense>
            </div>
            <DialogFooter className="mt-0 border-t border-border/40 px-5 py-3">
              <DsButton
                variant="ghost"
                onClick={() => { const report = preview; setPreview(null); reviewWithAi(report); }}
              >
                <ChatCircleText size={15} aria-hidden="true" />
                {tr('weekly_report.chat', { defaultValue: '与 AI 复盘' })}
              </DsButton>
              <DsButton
                variant="primary"
                onClick={() => { const report = preview; setPreview(null); saveReport(report); }}
              >
                <NotePencil size={15} aria-hidden="true" />
                {tr('weekly_report.save_as_note', { defaultValue: '存为笔记…' })}
              </DsButton>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
      <SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />
    </span>
  );
};
