/**
 * 统一「今日学习」：一处汇总三条复习线的到期量，所有「今日」入口共用同一口径。
 * 此前首页 / 待办卡只算 SM-2 错题复习，工作台 AI 仪表盘只算 FSRS 卡片，数字互相对不上，
 * 笔记的复习日期则只是装饰。
 *
 * - cards：FSRS 到期卡片（fsrs_get_stats.due）
 * - mistakes：SM-2 错题复习（review_plan_get_stats：今日到期 + 已逾期）
 * - notes：study_review_date ≤ 今天 的笔记
 */
import { invoke } from '@tauri-apps/api/core';
import { dstu, type DstuNode } from '@/dstu';
import { learningPropsFromMetadata, localCalendarDate, readNoteLearningProps } from '@/features/notes/noteLearningProps';

export interface TodayLearning {
  cards: number;
  mistakes: number;
  notes: number;
  dueNotes: Array<{ id: string; name: string; reviewDate: string }>;
}

async function countDueNotes(now: Date): Promise<TodayLearning['dueNotes']> {
  const today = localCalendarDate(now);
  const due: TodayLearning['dueNotes'] = [];
  for (let offset = 0; offset < 10_000; offset += 500) {
    const page = await dstu.list('/', { typeFilter: 'note', offset, limit: 500 });
    if (!page.ok) break;
    for (const node of page.value as DstuNode[]) {
      const { reviewDate } = readNoteLearningProps(learningPropsFromMetadata(node.metadata));
      if (reviewDate && reviewDate <= today) due.push({ id: node.id, name: node.name, reviewDate });
    }
    if (page.value.length < 500) break;
  }
  return due.sort((a, b) => a.reviewDate.localeCompare(b.reviewDate));
}

export async function loadTodayLearning(now = new Date()): Promise<TodayLearning> {
  const [cards, mistakes, dueNotes] = await Promise.all([
    invoke<{ due?: number }>('fsrs_get_stats').then((s) => s?.due ?? 0).catch(() => 0),
    invoke<{ due_today?: number; overdue_count?: number }>('review_plan_get_stats', { examId: null })
      .then((s) => (s?.due_today ?? 0) + (s?.overdue_count ?? 0)).catch(() => 0),
    countDueNotes(now).catch(() => []),
  ]);
  return { cards, mistakes, notes: dueNotes.length, dueNotes };
}

/** 打开「待复习笔记」：学习中心 › 笔记 › 近期复习视图 */
export function openDueNotesReview(): void {
  try { localStorage.setItem('learningHub.notesLearningView', 'review'); } catch { /* 偏好写入失败不影响跳转 */ }
  window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: 'learning-hub' } }));
  void import('@/features/learning-hub/stores/finderStore').then(({ useFinderStore }) => {
    window.setTimeout(() => {
      useFinderStore.getState().quickAccessNavigate('notes');
      // 学习中心已挂载时视图标签不会重读偏好：显式通知切到「近期复习」
      window.dispatchEvent(new CustomEvent('learningHub:notes-learning-view', { detail: { view: 'review' } }));
    }, 150);
  });
}
