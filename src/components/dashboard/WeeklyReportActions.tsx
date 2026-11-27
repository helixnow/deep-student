/**
 * 首页「本周周报」入口：确定性周报（本地统计，不经 LLM）。
 * 点「本周周报」先打开预览（此前直接弹「选择保存目录」，看不到周报内容就要先选存哪），
 * 预览里可存为笔记，也可带进对话让 AI 基于真实数据做复盘。
 */
import React, { Suspense, lazy, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChartLineUp, ChatCircleText, ListChecks, NotePencil, X } from '@phosphor-icons/react';
import { SaveAsNoteFolderPicker, useSaveAsNoteFlow } from '@/shared/notes';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/shad/Dialog';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassFor28 } from '@/components/ui/coarseHit';
import { cn } from '@/utils/cn';
import type { WeeklyReportData } from '@/features/learning-today/weeklyReport';

type WeeklyReportTodoPriority = 'high' | 'medium' | 'low';

function formatLocalTomorrow(now: Date = new Date()): string {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, '0');
  const d = String(next.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MarkdownRenderer = lazy(() =>
  import('@/features/chat/components/renderers/MarkdownRenderer').then((m) => ({ default: m.MarkdownRenderer })),
);

interface WeeklyReport {
  title: string;
  markdown: string;
  data: WeeklyReportData;
}

export interface TomorrowTodoPlanItem {
  title: string;
  priority: WeeklyReportTodoPriority;
  dueDate: string;
  tags: string[];
}

/** 根据周报薄弱知识点与待复习/未完成项生成明日可执行待办清单（最多 5 条） */
export function buildTomorrowTodosFromReport(
  data: WeeklyReportData,
  tomorrowDate: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): TomorrowTodoPlanItem[] {
  const items: TomorrowTodoPlanItem[] = [];
  const reportTag = t('weekly_report.tag', { defaultValue: '周报' });

  for (const weak of data.weakest.slice(0, 3)) {
    const scorePct = Math.round(weak.score * 100);
    items.push({
      title: t('weekly_report.todo_weak_concept', {
        concept: weak.concept,
        score: scorePct,
        defaultValue: '攻克薄弱知识点：{{concept}}（当前掌握度 {{score}}%）',
      }),
      priority: scorePct < 50 ? 'high' : 'medium',
      dueDate: tomorrowDate,
      tags: [reportTag, weak.concept],
    });
  }

  if (data.due.mistakes > 0) {
    items.push({
      title: t('weekly_report.todo_due_mistakes', {
        count: data.due.mistakes,
        defaultValue: '复盘 {{count}} 道待复习错题',
      }),
      priority: 'high',
      dueDate: tomorrowDate,
      tags: [reportTag],
    });
  }

  if (data.due.cards > 0) {
    items.push({
      title: t('weekly_report.todo_due_cards', {
        count: data.due.cards,
        defaultValue: '完成 {{count}} 张到期闪卡复习',
      }),
      priority: 'medium',
      dueDate: tomorrowDate,
      tags: [reportTag],
    });
  }

  if (data.due.notes > 0 && items.length < 5) {
    items.push({
      title: t('weekly_report.todo_due_notes', {
        count: data.due.notes,
        defaultValue: '回顾 {{count}} 篇待复习笔记',
      }),
      priority: 'low',
      dueDate: tomorrowDate,
      tags: [reportTag],
    });
  }

  if (items.length === 0) {
    items.push({
      title: t('weekly_report.todo_fallback', {
        defaultValue: '保持学习节奏：完成 1 个番茄专注或复习今日笔记',
      }),
      priority: 'medium',
      dueDate: tomorrowDate,
      tags: [reportTag],
    });
  }

  return items.slice(0, 5);
}

async function buildReport(t: (key: string, options?: Record<string, unknown>) => string): Promise<WeeklyReport> {
  const { loadWeeklyReportData, buildWeeklyReportMarkdown, weeklyReportTitle } = await import('@/features/learning-today/weeklyReport');
  const data = await loadWeeklyReportData();
  return { title: weeklyReportTitle(data, t), markdown: buildWeeklyReportMarkdown(data, t), data };
}

const linkClass = cn(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground disabled:opacity-50 max-md:min-h-9 max-md:px-2',
  coarseHitClassFor28,
);

/** compact：只留「本周周报」一个入口（预览里仍可与 AI 复盘 / 存为笔记 / 一键生成明日待办），给对话首页用 */
export const WeeklyReportActions: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useTranslation('data');
  const tr = useCallback((key: string, options?: Record<string, unknown>) => t(key, options) as string, [t]);
  const saveAsNoteFlow = useSaveAsNoteFlow({ openSource: 'weekly-report' });
  const [busy, setBusy] = useState(false);
  const [creatingTodos, setCreatingTodos] = useState(false);

  const [preview, setPreview] = useState<WeeklyReport | null>(null);

  const saveReport = useCallback(({ title, markdown }: WeeklyReport) => {
    saveAsNoteFlow.start({ title, content: markdown, tags: [tr('weekly_report.tag', { defaultValue: '周报' })] });
  }, [saveAsNoteFlow, tr]);

  const generateTomorrowTodos = useCallback(async ({ data }: WeeklyReport) => {
    if (creatingTodos) return;
    setCreatingTodos(true);
    try {
      const tomorrowDate = formatLocalTomorrow();
      const plan = buildTomorrowTodosFromReport(data, tomorrowDate, tr);
      const { createTodoItem, listTodoLists } = await import('@/features/todo/api');
      const lists = await listTodoLists().catch(() => []);
      const defaultListId = (lists.find((l) => l.isDefault) ?? lists[0])?.id ?? 'default';

      let created = 0;
      for (const item of plan) {
        await createTodoItem({
          todoListId: defaultListId,
          title: item.title,
          priority: item.priority,
          dueDate: item.dueDate,
          tags: item.tags,
        });
        created += 1;
      }

      setPreview(null);
      showGlobalNotification(
        'success',
        tr('weekly_report.tomorrow_todos_created', {
          count: created,
          defaultValue: '已为你生成 {{count}} 条明日待办',
        }),
      );
    } catch (error: unknown) {
      console.error('[WeeklyReport] generate tomorrow todos failed:', error);
      showGlobalNotification(
        'error',
        tr('weekly_report.tomorrow_todos_failed', { defaultValue: '生成明日待办失败，请重试' }),
      );
    } finally {
      setCreatingTodos(false);
    }
  }, [creatingTodos, tr]);

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
    <span className={compact ? 'inline-flex items-center' : 'ml-auto flex items-center gap-1'}>
      <button
        type="button"
        className={linkClass}
        disabled={busy}
        onClick={() => void run(setPreview)}
      >
        <ChartLineUp size={13} aria-hidden="true" />
        {tr('weekly_report.save_note', { defaultValue: '本周周报' })}
      </button>
      {!compact && (
        <button
          type="button"
          className={linkClass}
          disabled={busy}
          onClick={() => void run(reviewWithAi)}
        >
          <ChatCircleText size={13} aria-hidden="true" />
          {tr('weekly_report.chat', { defaultValue: '与 AI 复盘' })}
        </button>
      )}
      <Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        {preview ? (
          <DialogContent
            className="flex max-h-[min(80vh,760px)] w-[min(720px,calc(100vw-32px))] max-w-none flex-col p-0"
            aria-labelledby="weekly-report-preview-title"
          >
            <DialogHeader className="flex flex-row items-center justify-between gap-2 space-y-0 border-b border-border/40 px-5 py-3.5">
              <DialogTitle id="weekly-report-preview-title" className="min-w-0 truncate">{preview.title}</DialogTitle>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => setPreview(null)}
                aria-label={tr('common:close', { defaultValue: '关闭' })}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X size={16} aria-hidden="true" />
              </DsButton>
            </DialogHeader>
            {/* 聊天同款 Markdown 排版（段距 / 列表 / 表格）挂在 .chat-v2 作用域下 */}
            <div
              className="chat-v2 min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-6"
              style={{ '--chat-body-font-size': '1rem', '--chat-md-line-height': '1.65' } as React.CSSProperties}
            >
              <Suspense fallback={<pre className="whitespace-pre-wrap text-sm text-muted-foreground">{preview.markdown}</pre>}>
                <MarkdownRenderer content={preview.markdown} className="text-ui text-foreground" />
              </Suspense>
            </div>
            <DialogFooter className="mt-0 flex-row flex-wrap justify-end gap-2 border-t border-border/40 px-5 py-3">
              <DsButton
                variant="outline"
                disabled={creatingTodos}
                data-testid="weekly-report-generate-tomorrow-todos"
                onClick={() => void generateTomorrowTodos(preview)}
                className="rounded-xl border-border/70 bg-background/60 px-3.5 text-foreground hover:bg-muted/50"
              >
                <ListChecks size={15} aria-hidden="true" />
                {tr('weekly_report.generate_tomorrow_todos', { defaultValue: '一键生成明日待办' })}
              </DsButton>
              <DsButton
                variant="outline"
                onClick={() => { const report = preview; setPreview(null); reviewWithAi(report); }}
                className="rounded-xl border-border/70 bg-background/60 px-3.5 text-foreground hover:bg-muted/50"
              >
                <ChatCircleText size={15} aria-hidden="true" />
                {tr('weekly_report.chat', { defaultValue: '与 AI 复盘' })}
              </DsButton>
              <DsButton
                variant="primary"
                onClick={() => { const report = preview; setPreview(null); saveReport(report); }}
                className="rounded-xl border-primary/40 bg-primary/15 px-3.5 font-medium text-primary hover:bg-primary/25"
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
