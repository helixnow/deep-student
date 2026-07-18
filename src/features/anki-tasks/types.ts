/**
 * 制卡任务应用 — 共享类型与纯工具函数
 */
import type { AnkiCard } from '@/types';

export interface DocumentSession {
  documentId: string;
  documentName: string;
  sourceSessionId: string | null;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  pausedTasks: number;
  lastUpdated: string;
  createdAt: string;
  totalCards: number;
}

export interface AnkiStats {
  totalCards: number;
  totalDocuments: number;
  errorCards: number;
  templateCount: number;
}

export type SessionGroup = 'active' | 'attention' | 'completed';
export type FilterTab = 'all' | SessionGroup;
export type SortKey = 'time' | 'cards' | 'name';

/** 有活跃任务时的轮询间隔 */
export const POLL_ACTIVE = 5_000;
/** 无活跃任务时的轮询间隔 */
export const POLL_IDLE = 30_000;
/** 卡片列表首次显示条数 */
export const CARDS_PAGE_SIZE = 20;
/** 任务列表单次拉取上限（避免旧任务被分页截断） */
export const DASHBOARD_SESSION_LIMIT = 500;

export function classify(s: DocumentSession): SessionGroup {
  if (s.failedTasks > 0) return 'attention';
  if (s.activeTasks > 0 || s.pausedTasks > 0) return 'active';
  return 'completed';
}

/** i18n 化的相对时间 */
export function timeAgo(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60_000);
    if (m < 1) return t('taskDashboard.timeJustNow');
    if (m < 60) return t('taskDashboard.timeMinutesAgo', { count: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('taskDashboard.timeHoursAgo', { count: h });
    const d = Math.floor(h / 24);
    if (d < 30) return t('taskDashboard.timeDaysAgo', { count: d });
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
}

export function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

/** 根据模板字段名获取卡片对应的值
 *  注意：后端 streaming_anki_service 将 extra_fields 的 key 统一转为小写存储，
 *  但模板 fields 数组保留原始大小写，因此需要同时尝试两种 key。
 */
export function getCardFieldValue(card: AnkiCard, fieldName: string): string {
  const lower = fieldName.toLowerCase();

  if (card.extra_fields) {
    const val = card.extra_fields[lower] ?? card.extra_fields[fieldName];
    if (val) return val;
  }
  if (card.fields) {
    const val = card.fields[lower] ?? card.fields[fieldName];
    if (val) return val;
  }
  if (lower === 'front' || lower === '正面') return card.front || '—';
  if (lower === 'back' || lower === '背面') return card.back || '—';
  if (lower === 'text') return card.text || '—';
  return '—';
}
