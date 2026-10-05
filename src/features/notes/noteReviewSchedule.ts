/**
 * 笔记「复习完成」：把 study_review_date 推到下一次（或清除），不必再打开属性面板手改日期。
 * 读最新元数据、合并现有 props、带版本基线写回（与学习属性面板同一套 CAS 规则）。
 */
import { dstu, updatedAtToVersionToken } from '@/dstu';
import i18n from '@/i18n';
import { learningPropsFromMetadata, localCalendarDate, updateNoteLearningProps } from './noteLearningProps';

/** 可选的下次复习间隔（天）；null = 已掌握，清除复习日期 */
export const NOTE_REVIEW_INTERVALS = [1, 3, 7, 30] as const;

export function addCalendarDays(date: Date, days: number): string {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return localCalendarDate(next);
}

/** 返回新的复习日期；days 为 null 时标记已掌握并清除日期，返回 null。 */
export async function rescheduleNoteReview(noteId: string, days: number | null, now = new Date()): Promise<string | null> {
  const fresh = await dstu.get(`/${noteId}`);
  if (!fresh.ok) throw new Error(fresh.error.toUserMessage());
  const nextDate = days == null ? null : addCalendarDays(now, days);
  const props = updateNoteLearningProps(
    learningPropsFromMetadata(fresh.value.metadata),
    nextDate ? { reviewDate: nextDate } : { reviewDate: '', mastery: 'mastered' },
  );
  const version = updatedAtToVersionToken(fresh.value.updatedAt);
  if (!version) throw new Error(i18n.t('notes:learning.errors.version_unavailable'));
  const saved = await dstu.setMetadata(fresh.value.path, { props }, version);
  if (!saved.ok) throw new Error(saved.error.toUserMessage());
  return nextDate;
}
