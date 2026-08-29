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
  /**
   * 「带警告完成」前向兼容字段（optional，后端 list_document_sessions 当前
   * 不下发）：将来后端补充 warning 计数 / completed_with_warnings 口径时，
   * 前端无需改类型即可点亮非阻断徽章（见 hasWarnings）。缺省按无警告处理。
   */
  warningTasks?: number;
  /** 同上：任务收尾状态为 completed_with_warnings 时的布尔标记。 */
  completedWithWarnings?: boolean;
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

/**
 * 会话分组。互斥分类已修（Wave2-E r3）：旧实现 `failedTasks > 0` 无条件
 * 短路进 attention，failed+running 混合态会丢掉「仍在运行」的事实——
 * 轮询从 5s 降到 30s、防休眠被提前解除、active tab 看不到、行内
 * 暂停/取消入口被藏（详见 docs/dev/wave2-E-r1-09-tasks-block.md §1）。
 *
 * 修复后的优先级（互斥组只回答「现在处于什么阶段」）：
 * 1. activeTasks > 0 或 pausedTasks > 0 → 'active'
 *    —— 只要还有分段在跑或可恢复，就归运行组：5s 轮询、防休眠、
 *    行内暂停/取消保持可见；失败分段的事实不丢，由 hasWarnings
 *    以非阻断徽章叠加提示，不改变分组。
 * 2. 否则 failedTasks > 0 → 'attention'（全部停止且有失败，需要处理）。
 * 3. 否则 → 'completed'。
 */
export function classify(s: DocumentSession): SessionGroup {
  if (s.activeTasks > 0 || s.pausedTasks > 0) return 'active';
  if (s.failedTasks > 0) return 'attention';
  return 'completed';
}

/**
 * 非阻断警告标记：与 classify 正交，只做 UI 叠加（徽章/提示），
 * 绝不改变会话所属分组。点亮条件：
 * - 混合态：会话仍在 active 组（运行/暂停中）但已有失败分段；
 * - 「带警告完成」：后端将来下发 warningTasks / completedWithWarnings
 *   （DocumentSession 的 optional 前向兼容字段）时同样点亮。
 * 纯 attention 会话不点亮——状态标签本身已表达失败，避免双重告警。
 */
export function hasWarnings(s: DocumentSession): boolean {
  if ((s.warningTasks ?? 0) > 0 || s.completedWithWarnings === true) return true;
  return s.failedTasks > 0 && (s.activeTasks > 0 || s.pausedTasks > 0);
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

export interface WindowCardStats {
  /** 可确定归属该时间窗口的卡片数 + 跨窗口会话的卡片数（估算部分） */
  count: number;
  /** 是否包含跨窗口会话（其卡片无法精确归期，count 为估算值） */
  approximate: boolean;
}

/**
 * 按时间窗口聚合卡片数。
 *
 * 会话只暴露 createdAt(MIN)/lastUpdated(MAX)，没有逐卡时间戳：
 * - createdAt >= windowStart：所有卡片都在窗口内（精确）；
 * - lastUpdated < windowStart：没有卡片在窗口内（精确）；
 * - 跨越窗口边界（createdAt < windowStart <= lastUpdated）：卡片可能分布在
 *   边界两侧，计入 count 并标记 approximate，UI 以 ≈ 提示口径。
 */
export function computeWindowCardStats(
  sessions: DocumentSession[],
  windowStartMs: number,
): WindowCardStats {
  let count = 0;
  let approximate = false;
  for (const s of sessions) {
    if (s.totalCards <= 0) continue;
    const created = new Date(s.createdAt).getTime();
    const updated = new Date(s.lastUpdated).getTime();
    if (Number.isNaN(created) || Number.isNaN(updated)) continue;
    if (created >= windowStartMs) {
      count += s.totalCards;
    } else if (updated >= windowStartMs) {
      count += s.totalCards;
      approximate = true;
    }
  }
  return { count, approximate };
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
