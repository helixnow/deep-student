/**
 * 制卡任务管理页面 — Notion 风格 v2
 *
 * 修复清单：
 * [P0] 所有用户可见文本 i18n 化（timeAgo / donut 中心 / 卡片表头）
 * [P0] 删除确认改用内联确认模式，移除 window.confirm
 * [P0] 今日/本周统计使用 createdAt 而非 lastUpdated
 * [P1] 空状态增加「去聊天」CTA
 * [P1] 展开区展示错误卡片详情（error_content）
 * [P1] 导出按钮移至行操作，免展开即可导出（自动加载卡片）
 * [P1] 触屏兼容：操作按钮常驻低透明度，hover 加强
 * [P2] 排序功能（时间 / 卡片数 / 名称循环切换）
 * [P2] 智能轮询（无活跃任务时降至 30s）
 * [P2] 搜索框可发现性改善（focus 底色 + 底线）
 * [P2] PropRow 使用 grid 响应式宽度
 * [P2] 卡片列表 show-more 分页（首次 20 张）
 * [P2] 恢复/重试按钮文案区分 tooltip
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { useMobileHeader } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  RefreshCw, ChevronDown, ChevronRight, Play, Pause, RotateCcw,
  Trash2, Download, ExternalLink, AlertTriangle, CheckCircle2,
  Loader2, FileText, Hash, TrendingUp,
  BarChart3, Circle, Search, X, ArrowUpDown, MessageSquarePlus,
} from 'lucide-react';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { exportCardsAsApkg } from '@/chat-v2/anki';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import {
  normalizeTaskCardsForExport,
  selectTaskExportCards,
} from '@/components/anki/utils/normalizeTaskCardsForExport';

// ============================================================================
// 类型 & 常量
// ============================================================================

interface DocumentSession {
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

interface AnkiStats {
  totalCards: number;
  totalDocuments: number;
  errorCards: number;
  templateCount: number;
}

type SessionGroup = 'active' | 'attention' | 'completed';
type FilterTab = 'all' | SessionGroup;
type SortKey = 'time' | 'cards' | 'name';

/** 有活跃任务时的轮询间隔 */
const POLL_ACTIVE = 5_000;
/** 无活跃任务时的轮询间隔 */
const POLL_IDLE = 30_000;
/** 卡片列表首次显示条数 */
const CARDS_PAGE_SIZE = 20;

// ============================================================================
// 工具函数
// ============================================================================

function classify(s: DocumentSession): SessionGroup {
  if (s.activeTasks > 0 || s.pausedTasks > 0) return 'active';
  if (s.failedTasks > 0) return 'attention';
  return 'completed';
}

/** i18n 化的相对时间 */
function timeAgo(
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

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

// ============================================================================
// SVG 环形图（接受 i18n 中心标签）
// ============================================================================

const DonutChart: React.FC<{
  data: { label: string; value: number; color: string }[];
  size?: number;
  centerLabel?: string;
}> = ({ data, size = 110, centerLabel = '' }) => {
  const total = data.reduce((s, d) => s + d.value, 0);

  if (total === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 120 120">
        <circle
          cx="60" cy="60" r="48" fill="none" stroke="currentColor" strokeWidth="12"
          className="text-muted-foreground/10"
        />
        <text x="60" y="55" textAnchor="middle" dominantBaseline="central"
          className="fill-muted-foreground/40" fontSize="16">0</text>
        <text x="60" y="75" textAnchor="middle" dominantBaseline="central"
          className="fill-muted-foreground/30" fontSize="11">{centerLabel}</text>
      </svg>
    );
  }

  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  let accumulated = 0;
  const segments = data.filter(d => d.value > 0).map(d => {
    const pct = d.value / total;
    const offset = accumulated;
    accumulated += pct;
    return { ...d, pct, offset };
  });

  return (
    <svg width={size} height={size} viewBox="0 0 120 120">
      {segments.map((seg, i) => (
        <circle
          key={i}
          cx="60" cy="60" r={radius}
          fill="none"
          stroke={seg.color}
          strokeWidth="12"
          strokeDasharray={`${seg.pct * circumference} ${circumference}`}
          strokeDashoffset={-seg.offset * circumference}
          strokeLinecap="butt"
          transform="rotate(-90 60 60)"
          className="transition-all duration-700"
        />
      ))}
      <text x="60" y="55" textAnchor="middle" dominantBaseline="central"
        className="fill-foreground font-semibold" fontSize="22">{total}</text>
      <text x="60" y="75" textAnchor="middle" dominantBaseline="central"
        className="fill-muted-foreground" fontSize="11">{centerLabel}</text>
    </svg>
  );
};

// ============================================================================
// 横向柱状图
// ============================================================================

const HBarChart: React.FC<{
  items: { label: string; value: number }[];
  maxItems?: number;
}> = ({ items, maxItems = 5 }) => {
  const sorted = [...items].sort((a, b) => b.value - a.value).slice(0, maxItems);
  const max = sorted.length > 0 ? sorted[0].value : 1;

  return (
    <div className="space-y-2.5">
      {sorted.map((item, i) => (
        <div key={i} className="group">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[13px] text-foreground/80 truncate max-w-[200px]">
              {item.label}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums ml-2 flex-shrink-0">
              {item.value}
            </span>
          </div>
          <div className="h-1.5 bg-muted/40 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700 bg-foreground/20 group-hover:bg-foreground/30"
              style={{ width: `${Math.max((item.value / max) * 100, 2)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// Notion 式 property 行（grid 响应式宽度）
// ============================================================================

const PropRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, label, children }) => (
  <div className="grid grid-cols-[120px_1fr] sm:grid-cols-[150px_1fr] items-center py-[5px] group">
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors flex-shrink-0">
        {icon}
      </span>
      <span className="text-[13px] text-muted-foreground truncate">
        {label}
      </span>
    </div>
    <div className="flex items-center gap-1 text-[13px] text-foreground min-w-0 flex-wrap">
      {children}
    </div>
  </div>
);

// ============================================================================
// 状态标签
// ============================================================================

const StatusTag: React.FC<{ group: SessionGroup }> = ({ group }) => {
  const { t } = useTranslation('anki');
  const config = {
    active: { text: t('taskDashboard.statusActive'), cls: 'text-blue-600 dark:text-blue-400 bg-blue-500/8' },
    attention: { text: t('taskDashboard.statusFailed'), cls: 'text-amber-600 dark:text-amber-400 bg-amber-500/8' },
    completed: { text: t('taskDashboard.statusDone'), cls: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/8' },
  }[group];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-sm ${config.cls}`}>
      {config.text}
    </span>
  );
};

// ============================================================================
// 内联进度条
// ============================================================================

const InlineProgress: React.FC<{
  completed: number;
  total: number;
  failed: number;
}> = ({ completed, total, failed }) => {
  if (total === 0) return <span className="text-xs text-muted-foreground/50">—</span>;
  const pctDone = (completed / total) * 100;
  const pctFail = (failed / total) * 100;

  return (
    <div className="flex items-center gap-2.5">
      <div className="w-[80px] h-1.5 bg-muted/30 rounded-full overflow-hidden flex flex-shrink-0">
        <div className="h-full bg-emerald-500/60 transition-all duration-500" style={{ width: `${pctDone}%` }} />
        {pctFail > 0 && (
          <div className="h-full bg-amber-500/60 transition-all duration-500" style={{ width: `${pctFail}%` }} />
        )}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
        {completed}/{total}
      </span>
    </div>
  );
};

// ============================================================================
// 字段值获取辅助函数
// ============================================================================

/** 根据模板字段名获取卡片对应的值
 *  注意：后端 streaming_anki_service 将 extra_fields 的 key 统一转为小写存储，
 *  但模板 fields 数组保留原始大小写，因此需要同时尝试两种 key。
 */
function getCardFieldValue(card: AnkiCard, fieldName: string): string {
  const lower = fieldName.toLowerCase();

  // 优先从 extra_fields 获取（后端以小写 key 存储）
  if (card.extra_fields) {
    const val = card.extra_fields[lower] ?? card.extra_fields[fieldName];
    if (val) return val;
  }
  // 再尝试 fields
  if (card.fields) {
    const val = card.fields[lower] ?? card.fields[fieldName];
    if (val) return val;
  }
  // 标准字段回退（front/back 不一定在 extra_fields 中）
  if (lower === 'front' || lower === '正面') return card.front || '—';
  if (lower === 'back' || lower === '背面') return card.back || '—';
  if (lower === 'text') return card.text || '—';
  return '—';
}

// ============================================================================
// 会话行组件
// ============================================================================

const SessionRow: React.FC<{
  session: DocumentSession;
  expanded: boolean;
  onToggle: () => void;
  onJump: () => void;
  onRefresh: () => void;
}> = ({ session, expanded, onToggle, onJump, onRefresh }) => {
  const { t } = useTranslation('anki');
  const [cards, setCards] = useState<AnkiCard[]>([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllCards, setShowAllCards] = useState(false);
  // 模板信息映射 template_id -> template
  const [templateMap, setTemplateMap] = useState<Record<string, CustomAnkiTemplate>>({});
  // P0: 内联删除确认
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const group = classify(session);

  // [M2] 加载卡片 — 错误时通知用户而非静默吞没；同时并行加载关联模板，避免列名闪烁
  const loadCards = useCallback(async () => {
    setLoadingCards(true);
    try {
      // 并行加载卡片和模板，一次性设置状态避免两阶段渲染闪烁
      const [loadedCards, allTemplates] = await Promise.all([
        invoke<AnkiCard[]>('get_document_cards', { documentId: session.documentId }),
        invoke<CustomAnkiTemplate[]>('get_all_custom_templates').catch(err => {
          debugLog.error('[TaskDashboard] loadTemplates failed:', err);
          return [] as CustomAnkiTemplate[];
        }),
      ]);
      setCards(loadedCards);
      // 构建关联模板映射
      const uniqueTemplateIds = new Set(
        loadedCards
          .map(c => c.template_id)
          .filter((id): id is string => !!id && id.trim() !== '')
      );
      if (uniqueTemplateIds.size > 0 && allTemplates.length > 0) {
        const map: Record<string, CustomAnkiTemplate> = {};
        for (const t of allTemplates) {
          if (uniqueTemplateIds.has(t.id)) {
            map[t.id] = t;
          }
        }
        setTemplateMap(map);
      }
    } catch (err: unknown) {
      debugLog.error('[TaskDashboard] loadCards failed:', err);
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setLoadingCards(false);
    }
  }, [session.documentId]);

  // 首次展开 或 卡片数增长 或 模板信息缺失 时加载
  useEffect(() => {
    if (!expanded || loadingCards) return;
    const needLoadCards = session.totalCards > 0 && session.totalCards > cards.length;
    const needLoadTemplates = cards.length > 0 && Object.keys(templateMap).length === 0
      && cards.some(c => c.template_id);
    if (needLoadCards || needLoadTemplates) {
      loadCards();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, session.totalCards]);

  // 清理 deleteTimer
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    };
  }, []);

  // 后端操作（pause/resume/delete/retryFailed）
  const act = useCallback(async (action: string) => {
    setBusy(action);
    try {
      if (action === 'pause') {
        await invoke('pause_document_processing', { documentId: session.documentId });
        showGlobalNotification('success', t('taskDashboard.paused'));
      } else if (action === 'resume') {
        await invoke('resume_document_processing', { documentId: session.documentId });
        showGlobalNotification('success', t('taskDashboard.resumed'));
      } else if (action === 'retryFailed') {
        // [S2] 真正重试失败任务：获取文档所有 task → 筛选失败的 → 并行 trigger
        const tasks = await invoke<{ id: string; status: string }[]>(
          'get_document_tasks',
          { documentId: session.documentId },
        );
        const failedTasks = tasks.filter(
          t2 => t2.status === 'Failed' || t2.status === 'Truncated',
        );
        if (failedTasks.length === 0) {
          showGlobalNotification('info', t('taskDashboard.noStuckTasks'));
        } else {
          // [M1] 使用 allSettled 避免部分失败中断其余任务
          const results = await Promise.allSettled(
            failedTasks.map(ft => invoke('trigger_task_processing', { taskId: ft.id })),
          );
          const succeeded = results.filter(r => r.status === 'fulfilled').length;
          const failed = results.length - succeeded;
          if (failed === 0) {
            showGlobalNotification('success', t('taskDashboard.retryStarted', { count: succeeded }));
          } else {
            showGlobalNotification('warning', t('taskDashboard.retryPartial', { succeeded, failed }));
          }
        }
      } else if (action === 'delete') {
        await invoke('delete_document_session', { documentId: session.documentId });
        showGlobalNotification('success', t('taskDashboard.deleted'));
      }
      onRefresh();
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }, [session.documentId, onRefresh, t]);

  // P0: 内联确认删除（点击一次显示确认态，3s 后回退；再次点击真删）
  const handleDelete = useCallback(() => {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      deleteTimerRef.current = setTimeout(() => setDeleteConfirm(false), 3000);
      return;
    }
    if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    setDeleteConfirm(false);
    act('delete');
  }, [deleteConfirm, act]);

  // [S1] 行内一键导出 — 始终获取最新卡片，过滤错误卡，使用 extra_fields
  const exportLockRef = useRef(false);
  const handleQuickExport = useCallback(async () => {
    // [M4] 同步锁防止快速双击
    if (exportLockRef.current) return;
    exportLockRef.current = true;
    setBusy('export');
    try {
      // 优先读取聊天块中持久化的编辑后卡片；若无则回退任务库卡片
      const [editedCards, freshCards] = await Promise.all([
        invoke<AnkiCard[]>(
          'chat_v2_get_anki_cards_from_block_by_document_id',
          { documentId: session.documentId },
        ).catch(() => []),
        invoke<AnkiCard[]>(
          'get_document_cards',
          { documentId: session.documentId },
        ),
      ]);
      const sourceCards = selectTaskExportCards(editedCards, freshCards);
      setCards(sourceCards);
      // 过滤掉错误卡片
      const exportable = sourceCards.filter(c => !c.is_error_card);
      if (exportable.length === 0) {
        showGlobalNotification('info', t('taskDashboard.noExportableCards'));
        return;
      }
      const normalizedCards = normalizeTaskCardsForExport(exportable);
      const result = await exportCardsAsApkg({
        cards: normalizedCards,
        deckName: session.documentName || 'Export',
      });
      if (result.success) showGlobalNotification('success', t('taskDashboard.exported'));
      else throw new Error(t('chatV2.exportFailed'));
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setBusy(null);
      exportLockRef.current = false;
    }
  }, [session.documentId, session.documentName, t]);

  // 错误卡片
  const errorCards = useMemo(() => cards.filter(c => c.is_error_card), [cards]);
  // 正常卡片（分页）
  const normalCards = useMemo(() => cards.filter(c => !c.is_error_card), [cards]);
  const visibleCards = showAllCards ? normalCards : normalCards.slice(0, CARDS_PAGE_SIZE);
  const hasMoreCards = normalCards.length > CARDS_PAGE_SIZE;

  // 动态计算列和模板信息
  const { templateName, columns, isFallback } = useMemo(() => {
    if (normalCards.length === 0) {
      return { templateName: null, columns: [] as string[], isFallback: true };
    }

    // 1. 提取所有模板 ID
    const templateIds = [...new Set(
      normalCards
        .map(c => c.template_id)
        .filter((id): id is string => !!id && id.trim() !== '')
    )];

    // 2. 单模板场景：直接使用模板声明的字段列表
    if (templateIds.length === 1 && templateMap[templateIds[0]]) {
      const tmpl = templateMap[templateIds[0]];
      if (tmpl.fields.length > 0) {
        return { templateName: tmpl.name, columns: tmpl.fields, isFallback: false };
      }
    }

    // 3. 从卡片 extra_fields 推导列（保持首次出现顺序）
    const fieldKeys: string[] = [];
    const seen = new Set<string>();
    for (const c of normalCards) {
      const ef = c.extra_fields ?? c.fields;
      if (ef) {
        for (const k of Object.keys(ef)) {
          if (!seen.has(k)) { seen.add(k); fieldKeys.push(k); }
        }
      }
    }

    if (fieldKeys.length > 0) {
      // 尝试获取模板名称
      const name = templateIds.length === 1 && templateMap[templateIds[0]]
        ? templateMap[templateIds[0]].name
        : templateIds.length > 1
          ? t('taskDashboard.multipleTemplates', { count: templateIds.length })
          : null;
      return { templateName: name, columns: fieldKeys, isFallback: false };
    }

    // 4. 完全回退到 Front/Back
    return { templateName: null, columns: [], isFallback: true };
  }, [normalCards, templateMap, t]);

  return (
    <div className="group/row">
      {/* ---- 主行 ---- */}
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer
          hover:bg-muted/5
          transition-colors duration-100"
        onClick={onToggle}
      >
        {/* 展开箭头 */}
        <span className="text-muted-foreground/30 w-4 flex-shrink-0">
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5" />
            : <ChevronRight className="h-3.5 w-3.5" />}
        </span>

        {/* 文档名 */}
        <FileText className="h-[15px] w-[15px] text-muted-foreground/50 flex-shrink-0" />
        <span className="text-[13px] text-foreground truncate min-w-0 flex-1">
          {session.documentName || session.documentId.slice(0, 12)}
        </span>

        {/* 状态 */}
        <div className="w-[72px] flex-shrink-0">
          <StatusTag group={group} />
        </div>

        {/* 卡片数 */}
        <div className="w-[48px] flex-shrink-0 text-right">
          <span className="text-xs text-muted-foreground tabular-nums">
            {session.totalCards}
          </span>
        </div>

        {/* 进度 */}
        <div className="w-[140px] flex-shrink-0 hidden md:block">
          <InlineProgress completed={session.completedTasks} total={session.totalTasks} failed={session.failedTasks} />
        </div>

        {/* 时间 */}
        <span className="text-xs text-muted-foreground/60 w-[80px] text-right flex-shrink-0 tabular-nums hidden sm:block">
          {timeAgo(session.lastUpdated, t)}
        </span>

        {/* P1+P7: 操作按钮（触屏常驻低透明度，桌面 hover 加强） */}
        <div
          className="flex items-center justify-end gap-0 flex-shrink-0 w-[96px]
            opacity-40 group-hover/row:opacity-100
            transition-opacity duration-150"
          onClick={e => e.stopPropagation()}
        >
          {group === 'active' && session.activeTasks > 0 && (
            <CommonTooltip content={t('pause')}>
              <NotionButton size="sm" variant="ghost" onClick={() => act('pause')} disabled={!!busy} className="h-6 w-6 p-0">
                <Pause className="h-3 w-3" />
              </NotionButton>
            </CommonTooltip>
          )}
          {session.pausedTasks > 0 && (
            <CommonTooltip content={t('resume')}>
              <NotionButton size="sm" variant="ghost" onClick={() => act('resume')} disabled={!!busy} className="h-6 w-6 p-0">
                <Play className="h-3 w-3" />
              </NotionButton>
            </CommonTooltip>
          )}
          {group === 'attention' && session.pausedTasks === 0 && (
            <CommonTooltip content={t('taskDashboard.retryFailed')}>
              <NotionButton size="sm" variant="ghost" onClick={() => act('retryFailed')} disabled={!!busy} className="h-6 w-6 p-0">
                <RotateCcw className="h-3 w-3" />
              </NotionButton>
            </CommonTooltip>
          )}
          {/* 行内导出 [M5] 增加 loadingCards 禁用 */}
          {session.totalCards > 0 && (
            <CommonTooltip content={t('taskDashboard.quickExport')}>
              <NotionButton size="sm" variant="ghost" onClick={handleQuickExport} disabled={!!busy || loadingCards} className="h-6 w-6 p-0">
                <Download className="h-3 w-3" />
              </NotionButton>
            </CommonTooltip>
          )}
          {session.sourceSessionId && (
            <CommonTooltip content={t('taskDashboard.jumpToChat')}>
              <NotionButton size="sm" variant="ghost" onClick={onJump} className="h-6 w-6 p-0">
                <ExternalLink className="h-3 w-3" />
              </NotionButton>
            </CommonTooltip>
          )}
          {/* P0: 内联删除确认 */}
          <CommonTooltip content={deleteConfirm ? t('taskDashboard.confirmDeleteHint') : t('taskDashboard.deleteSession')}>
            <NotionButton
              size="sm"
              variant={deleteConfirm ? 'danger' : 'ghost'}
              onClick={handleDelete}
              disabled={!!busy}
              className={`h-6 p-0 ${deleteConfirm ? 'px-2 gap-1' : 'w-6'}`}
            >
              <Trash2 className="h-3 w-3" />
              {deleteConfirm && (
                <span className="text-[10px]">{t('taskDashboard.confirmDeleteHint')}</span>
              )}
            </NotionButton>
          </CommonTooltip>
        </div>
      </div>

      {/* ---- 展开区域 ---- */}
      {expanded && (
        <div className="pl-[44px] pr-3 pb-4 pt-1 space-y-3">
          {/* 属性行 */}
          <div className="space-y-0.5">
            <PropRow icon={<Hash className="h-3.5 w-3.5" />} label={t('taskDashboard.colStatus')}>
              <StatusTag group={group} />
              {group === 'active' && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {session.activeTasks} {t('taskDashboard.statusActive')} / {session.pausedTasks} {t('taskDashboard.statusPaused')}
                </span>
              )}
            </PropRow>
            <PropRow icon={<BarChart3 className="h-3.5 w-3.5" />} label={t('taskDashboard.progressLabel')}>
              <InlineProgress completed={session.completedTasks} total={session.totalTasks} failed={session.failedTasks} />
            </PropRow>
            <PropRow icon={<TrendingUp className="h-3.5 w-3.5" />} label={t('taskDashboard.propTotalCards')}>
              <span className="tabular-nums">{session.totalCards}</span>
            </PropRow>
            <PropRow icon={<Circle className="h-3.5 w-3.5" />} label={t('taskDashboard.timeCreated')}>
              {formatDate(session.createdAt)}
            </PropRow>
            <PropRow icon={<Circle className="h-3.5 w-3.5" />} label={t('taskDashboard.timeUpdated')}>
              {formatDate(session.lastUpdated)}
            </PropRow>
          </div>

          {/* 操作按钮 */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {session.totalCards > 0 && (
              <NotionButton size="sm" variant="default" onClick={handleQuickExport} disabled={!!busy || loadingCards}>
                <Download className="h-3.5 w-3.5" />{t('taskDashboard.exportApkg')}
              </NotionButton>
            )}
            {group === 'attention' && (
              <NotionButton size="sm" variant="primary" onClick={() => act('retryFailed')} disabled={!!busy}>
                <RotateCcw className="h-3.5 w-3.5" />{t('taskDashboard.retryFailed')}
              </NotionButton>
            )}
            <NotionButton
              size="sm"
              variant={deleteConfirm ? 'danger' : 'default'}
              onClick={handleDelete}
              disabled={!!busy}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteConfirm ? t('taskDashboard.confirmDeleteHint') : t('taskDashboard.deleteSession')}
            </NotionButton>
          </div>

          {/* P1: 失败警告 + 错误卡片详情 */}
          {session.failedTasks > 0 && (
            <div className="text-xs text-amber-600 dark:text-amber-400 py-1.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                {t('taskDashboard.failedSegments', { count: session.failedTasks })}
              </div>
            </div>
          )}

          {/* P1: 错误卡片详情（从已加载卡片中提取） */}
          {errorCards.length > 0 && (
            <div className="py-1 space-y-1">
              <div className="text-xs font-medium text-amber-600 dark:text-amber-400">
                {t('taskDashboard.errorCardsFound', { count: errorCards.length })}
              </div>
              {errorCards.slice(0, 3).map((c, i) => (
                <div key={c.id || i} className="text-xs text-muted-foreground pl-4 py-0.5">
                  <span className="text-foreground/60 truncate inline-block max-w-[200px] align-middle">
                    {c.front || '—'}
                  </span>
                  {c.error_content && (
                    <span className="text-amber-600/60 dark:text-amber-400/60 ml-2">
                      {t('taskDashboard.errorReason')}: {c.error_content}
                    </span>
                  )}
                </div>
              ))}
              {errorCards.length > 3 && (
                <div className="text-[11px] text-muted-foreground/30 pl-4">
                  +{errorCards.length - 3} ...
                </div>
              )}
            </div>
          )}

          {/* 卡片列表 */}
          {loadingCards ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />{t('taskDashboard.loadingCards')}
            </div>
          ) : normalCards.length > 0 ? (
            <div>
              {/* 模板标签 */}
              {templateName && (
                <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px]">
                  <span className="text-muted-foreground/50">{t('taskDashboard.templateLabel')}</span>
                  <span className="text-foreground/70 font-medium">{templateName}</span>
                </div>
              )}
              {/* 表头 — 根据模板字段动态生成列 */}
              <div className="flex items-center gap-3 px-2 py-1.5 text-[11px] font-medium text-muted-foreground/50 uppercase tracking-wider">
                <span className="w-6 text-right">#</span>
                {isFallback ? (
                  <>
                    <span className="flex-1">{t('taskDashboard.cardFront')}</span>
                    <span className="flex-1">{t('taskDashboard.cardBack')}</span>
                  </>
                ) : (
                  columns.map(col => (
                    <span key={col} className="flex-1 truncate">{col}</span>
                  ))
                )}
              </div>
              {/* P2: show-more 分页 — 展开后解除高度限制 */}
              <CustomScrollArea className={showAllCards ? 'max-h-[600px]' : 'max-h-[280px]'}>
                {visibleCards.map((c, i) => (
                  <div key={c.id || i} className="flex items-start gap-3 px-2 py-2 hover:bg-muted/10 transition-colors">
                    <span className="text-[10px] text-muted-foreground/30 mt-0.5 w-6 text-right flex-shrink-0 tabular-nums">
                      {i + 1}
                    </span>
                    {isFallback ? (
                      <>
                        <div className="flex-1 min-w-0 text-[13px] text-foreground/90 truncate">
                          {c.front || '—'}
                        </div>
                        <div className="flex-1 min-w-0 text-[13px] text-muted-foreground truncate">
                          {c.back || '—'}
                        </div>
                      </>
                    ) : (
                      columns.map((col, ci) => (
                        <div
                          key={col}
                          className={`flex-1 min-w-0 text-[13px] truncate ${ci === 0 ? 'text-foreground/90' : 'text-muted-foreground'}`}
                        >
                          {getCardFieldValue(c, col)}
                        </div>
                      ))
                    )}
                  </div>
                ))}
              </CustomScrollArea>
              {hasMoreCards && (
                <button
                  type="button"
                  onClick={() => setShowAllCards(v => !v)}
                  className="w-full py-1.5 text-[12px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                >
                  {showAllCards
                    ? t('taskDashboard.showLessCards')
                    : t('taskDashboard.showMoreCards', { remaining: normalCards.length - CARDS_PAGE_SIZE })}
                </button>
              )}
            </div>
          ) : session.totalCards === 0 ? (
            <p className="text-[13px] text-muted-foreground/40 py-3">{t('taskDashboard.noCards')}</p>
          ) : null}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

interface TaskDashboardPageProps {
  onNavigateToChat?: (sessionId: string) => void;
  onOpenTemplateManagement?: () => void;
}

export const TaskDashboardPage: React.FC<TaskDashboardPageProps> = ({
  onNavigateToChat,
  onOpenTemplateManagement,
}) => {
  const { t } = useTranslation('anki');
  const { isSmallScreen } = useBreakpoint();
  const [sessions, setSessions] = useState<DocumentSession[]>([]);
  const [stats, setStats] = useState<AnkiStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time');

  // P2: 智能轮询 —— 通过 ref 跟踪是否有活跃任务
  const hasActiveRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([
        invoke<DocumentSession[]>('list_document_sessions', { limit: 100 }),
        invoke<AnkiStats>('get_anki_stats'),
      ]);
      setSessions(s);
      setStats(st);
    } catch (err: unknown) {
      debugLog.error('[TaskDashboard] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // P2: 智能轮询 —— 有活跃任务 5s，无则 30s
  useEffect(() => {
    let isActive = true;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    load(); // 首次加载

    const schedulePoll = () => {
      if (!isActive) return;
      const delay = hasActiveRef.current ? POLL_ACTIVE : POLL_IDLE;
      timerId = setTimeout(() => {
        if (!isActive) return;
        if (!document.hidden) {
          load().finally(() => {
            if (isActive) schedulePoll();
          });
        } else {
          schedulePoll();
        }
      }, delay);
    };

    schedulePoll();

    const handleVisibility = () => {
      if (!document.hidden && isActive) load();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      isActive = false;
      if (timerId) clearTimeout(timerId);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [load]);

  const handleRecover = useCallback(async () => {
    setRecovering(true);
    try {
      const count = await invoke<number>('recover_stuck_document_tasks');
      if (count > 0) {
        showGlobalNotification('success', t('taskDashboard.recoveredCount', { count }));
        load();
      } else {
        showGlobalNotification('info', t('taskDashboard.noStuckTasks'));
      }
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setRecovering(false);
    }
  }, [load, t]);

  // 分组
  const groups = useMemo(() => {
    const a: DocumentSession[] = [];
    const at: DocumentSession[] = [];
    const c: DocumentSession[] = [];
    for (const s of sessions) {
      const g = classify(s);
      (g === 'active' ? a : g === 'attention' ? at : c).push(s);
    }
    return { active: a, attention: at, completed: c };
  }, [sessions]);

  // 同步 hasActiveRef
  useEffect(() => {
    hasActiveRef.current = groups.active.length > 0;
  }, [groups.active.length]);

  // 聚合指标
  const metrics = useMemo(() => {
    const totalCards = stats?.totalCards ?? 0;
    const totalDocs = stats?.totalDocuments ?? 0;
    const totalTasks = sessions.reduce((s, d) => s + d.totalTasks, 0);
    const failedTasks = sessions.reduce((s, d) => s + d.failedTasks, 0);
    const errorRate = totalTasks > 0 ? ((failedTasks / totalTasks) * 100).toFixed(1) : '0.0';
    const avgCards = totalDocs > 0 ? Math.round(totalCards / totalDocs) : 0;

    // P0: 使用 createdAt（任务创建时间）而非 lastUpdated
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = todayStart - 6 * 86_400_000; // 最近 7 天
    let todayCards = 0;
    let weekCards = 0;
    for (const s of sessions) {
      try {
        const created = new Date(s.createdAt).getTime();
        if (created >= todayStart) todayCards += s.totalCards;
        if (created >= weekStart) weekCards += s.totalCards;
      } catch {
        /* skip */
      }
    }

    return { totalCards, totalDocs, totalTasks, failedTasks, errorRate, avgCards, todayCards, weekCards };
  }, [sessions, stats]);

  // 环形图（使用主题安全的颜色 —— Tailwind 默认色在明暗模式下均可）
  const donutData = useMemo(
    () => [
      { label: t('taskDashboard.statusDone'), value: groups.completed.length, color: '#10b981' },
      { label: t('taskDashboard.statusActive'), value: groups.active.length, color: '#3b82f6' },
      { label: t('taskDashboard.statusFailed'), value: groups.attention.length, color: '#f59e0b' },
    ],
    [groups, t],
  );

  // 柱状图
  const barData = useMemo(
    () =>
      sessions
        .filter(s => s.totalCards > 0)
        .map(s => ({
          label: s.documentName || s.documentId.slice(0, 12),
          value: s.totalCards,
        })),
    [sessions],
  );

  // P2: 排序
  const sortedAndFiltered = useMemo(() => {
    let list = sessions;
    // 筛选
    if (filter !== 'all') {
      list = list.filter(s => classify(s) === filter);
    }
    // 搜索
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        s =>
          (s.documentName || '').toLowerCase().includes(q) ||
          s.documentId.toLowerCase().includes(q),
      );
    }
    // 排序
    const sorted = [...list];
    switch (sortKey) {
      case 'time':
        sorted.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
        break;
      case 'cards':
        sorted.sort((a, b) => b.totalCards - a.totalCards);
        break;
      case 'name':
        sorted.sort((a, b) => (a.documentName || '').localeCompare(b.documentName || ''));
        break;
    }
    return sorted;
  }, [sessions, filter, search, sortKey]);

  // Tab 计数
  const tabCounts = useMemo(
    () => ({
      all: sessions.length,
      active: groups.active.length,
      attention: groups.attention.length,
      completed: groups.completed.length,
    }),
    [sessions, groups],
  );

  // P2: 排序循环
  const cycleSort = useCallback(() => {
    const order: SortKey[] = ['time', 'cards', 'name'];
    setSortKey(k => order[(order.indexOf(k) + 1) % order.length]);
  }, []);

  // 排序 key → i18n label
  const sortLabel = useMemo(() => {
    const map: Record<SortKey, string> = {
      time: t('taskDashboard.sortByTime'),
      cards: t('taskDashboard.sortByCards'),
      name: t('taskDashboard.sortByName'),
    };
    return map[sortKey];
  }, [sortKey, t]);

  useMobileHeader('task-dashboard', {
    title: t('taskDashboard.title'),
    subtitle: t('taskDashboard.subtitle'),
    suppressGlobalBackButton: true,
  }, [t]);

  // ======== 渲染 ========

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">{t('taskDashboard.loading')}</span>
      </div>
    );
  }

  return (
    <CustomScrollArea className="h-full bg-background">
      <div className="max-w-[860px] mx-auto px-4 sm:px-6 py-6 sm:py-10">
        {/* ======== 页面标题 ======== */}
        {!isSmallScreen && (
          <div className="mb-8">
          <h1 className="text-[28px] font-bold text-foreground leading-tight tracking-tight">
            {t('taskDashboard.title')}
          </h1>
          <p className="text-[14px] text-muted-foreground/60 mt-1">
            {t('taskDashboard.subtitle')}
          </p>
          </div>
        )}

        {/* ======== 属性 + 可视化横向排列 ======== */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-8 mb-10">
          {/* 左：属性区 */}
          <div className="space-y-0">
            <PropRow icon={<Hash className="h-3.5 w-3.5" />} label={t('taskDashboard.propTotalCards')}>
              <span className="font-semibold tabular-nums">{metrics.totalCards}</span>
              {metrics.avgCards > 0 && (
                <span className="text-muted-foreground/50 ml-1 text-[12px]">
                  ({t('taskDashboard.avgCardsPerDoc')} {metrics.avgCards})
                </span>
              )}
            </PropRow>
            <PropRow icon={<FileText className="h-3.5 w-3.5" />} label={t('taskDashboard.propDocuments')}>
              <span className="font-semibold tabular-nums">{metrics.totalDocs}</span>
            </PropRow>
            <PropRow icon={<TrendingUp className="h-3.5 w-3.5" />} label={t('taskDashboard.propActiveJobs')}>
              {groups.active.length > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />
                  <span className="text-blue-600 dark:text-blue-400 font-medium">{groups.active.length}</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                  <span className="text-emerald-600 dark:text-emerald-400">{t('taskDashboard.allDone')}</span>
                </span>
              )}
            </PropRow>
            <PropRow icon={<AlertTriangle className="h-3.5 w-3.5" />} label={t('taskDashboard.propErrorRate')}>
              <span className={`tabular-nums ${Number(metrics.errorRate) > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                {metrics.errorRate}%
              </span>
              {metrics.failedTasks > 0 && (
                <span className="text-muted-foreground/40 ml-1">
                  ({metrics.failedTasks} {t('taskDashboard.segments')})
                </span>
              )}
            </PropRow>
            <PropRow icon={<FileText className="h-3.5 w-3.5" />} label={t('taskDashboard.propTemplates')}>
              <span className="tabular-nums">{stats?.templateCount ?? 0}</span>
              <NotionButton size="sm" variant="ghost" onClick={onOpenTemplateManagement} className="ml-2 h-6 text-[12px]">
                {t('taskDashboard.openTemplateLib')}
              </NotionButton>
            </PropRow>
            <PropRow icon={<BarChart3 className="h-3.5 w-3.5" />} label={t('taskDashboard.todayCards')}>
              <span className="tabular-nums font-medium">{metrics.todayCards}</span>
              <span className="text-muted-foreground/40 mx-1.5">·</span>
              <span className="text-muted-foreground/60 text-xs">{t('taskDashboard.weekCards')}</span>
              <span className="tabular-nums ml-1">{metrics.weekCards}</span>
            </PropRow>
          </div>

          {/* 右：可视化（占 2/3）—— 环形图 & 柱状图横向排列 */}
          {sessions.length > 0 && (
            <div className="flex flex-col md:flex-row gap-6 md:gap-8">
              {/* 环形图 + 图例 */}
              <div className="flex-shrink-0">
                <div className="text-[13px] text-muted-foreground mb-3">
                  {t('taskDashboard.chartStatusDistribution')}
                </div>
                <div className="flex items-center gap-6">
                  <DonutChart
                    data={donutData}
                    size={110}
                    centerLabel={t('taskDashboard.donutCenterLabel')}
                  />
                  <div className="space-y-2">
                    {donutData.map((d, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
                        <span className="text-[12px] text-muted-foreground">{d.label}</span>
                        <span className="text-[12px] text-foreground/70 tabular-nums ml-auto">{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* 柱状图 */}
              {barData.length > 0 && (
                <div className="flex-1 min-w-0 w-full">
                  <div className="text-[13px] text-muted-foreground mb-3">
                    {t('taskDashboard.docsRanking')}
                  </div>
                  <HBarChart items={barData} maxItems={5} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* ======== 移动端模板库入口 ======== */}
        {isSmallScreen && onOpenTemplateManagement && (
          <div className="mb-6">
            <NotionButton
              variant="outline"
              onClick={onOpenTemplateManagement}
              className="w-full justify-center h-9"
            >
              {t('taskDashboard.openTemplateLib')}
            </NotionButton>
          </div>
        )}

        {/* ======== 数据库视图 ======== */}
        <div>
          {/* 标题 + 操作 */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <h2 className="text-[15px] font-semibold text-foreground">
                {t('taskDashboard.title')}
              </h2>
              <span className="text-xs text-muted-foreground/40 tabular-nums">
                {t('taskDashboard.totalSessions', { count: sessions.length })}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {/* P2: 排序 */}
              <NotionButton size="sm" variant="ghost" onClick={cycleSort} className="h-7">
                <ArrowUpDown className="h-3.5 w-3.5" />
                <span className="hidden sm:inline text-[11px]">{sortLabel}</span>
              </NotionButton>
              <CommonTooltip content={t('taskDashboard.refresh')}>
                <NotionButton size="sm" variant="ghost" onClick={load} className="h-7 w-7 p-0">
                  <RefreshCw className="h-3.5 w-3.5" />
                </NotionButton>
              </CommonTooltip>
              <CommonTooltip content={t('taskDashboard.recoverStuckHint')}>
                <NotionButton size="sm" variant="ghost" onClick={handleRecover} disabled={recovering} className="h-7">
                  {recovering
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RotateCcw className="h-3.5 w-3.5" />}
                  <span className="hidden sm:inline">{t('taskDashboard.recoverStuck')}</span>
                </NotionButton>
              </CommonTooltip>
            </div>
          </div>

          {/* 筛选 tabs + 搜索 */}
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {(['all', 'active', 'attention', 'completed'] as FilterTab[]).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setFilter(tab)}
                  className={`
                    px-2.5 py-1 text-[12px] rounded-sm transition-colors duration-100 whitespace-nowrap
                    ${filter === tab
                      ? 'text-foreground font-medium bg-muted/60'
                      : 'text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30'}
                  `}
                >
                  {tab === 'all'
                    ? t('taskDashboard.filterAll')
                    : tab === 'active'
                      ? t('taskDashboard.statusActive')
                      : tab === 'attention'
                        ? t('taskDashboard.statusFailed')
                        : t('taskDashboard.statusDone')}
                  {tabCounts[tab] > 0 && (
                    <span className="ml-1 text-[10px] text-muted-foreground/40 tabular-nums">
                      {tabCounts[tab]}
                    </span>
                  )}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            {/* P2: 搜索框改善可发现性 */}
            <div className="relative max-w-[200px] flex-shrink-0">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('taskDashboard.searchPlaceholder')}
                className="w-full h-7 pl-7 pr-7 text-[12px] rounded-sm bg-transparent
                  text-foreground placeholder:text-muted-foreground/30
                  border border-transparent outline-none
                  focus:bg-muted/20 focus:border-border/40
                  transition-all duration-150"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-muted-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* 分隔线 */}
          <div className="h-px bg-border/30 mb-0" />

          {sessions.length === 0 ? (
            /* P1: 空状态 + CTA */
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-12 h-12 rounded-full bg-muted/30 flex items-center justify-center mb-4">
                <FileText className="h-5 w-5 text-muted-foreground/30" />
              </div>
              <h3 className="text-[15px] font-medium text-foreground/80 mb-1">
                {t('taskDashboard.empty')}
              </h3>
              <p className="text-[13px] text-muted-foreground/50 max-w-[280px] mb-4">
                {t('taskDashboard.emptyHint')}
              </p>
              <NotionButton
                size="sm"
                variant="primary"
                onClick={() => {
                  // [M6] onNavigateToChat 在 App.tsx 中会 setCurrentView('chat-v2')
                  // 并 dispatch navigate-to-session。传特殊标记让 App.tsx 仅切换视图
                  onNavigateToChat?.('__new__');
                }}
                disabled={!onNavigateToChat}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                {t('taskDashboard.goToChat')}
              </NotionButton>
            </div>
          ) : sortedAndFiltered.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-[13px] text-muted-foreground/40">
                {t('taskDashboard.noMatchFilter')}
              </p>
            </div>
          ) : (
            <>
              {/* 表头 */}
              <div className={isSmallScreen ? '' : 'overflow-x-auto'}>
                <div>
                  <div className="flex items-center gap-3 px-3 py-2 text-[11px] font-medium text-muted-foreground/40 uppercase tracking-wider select-none">
                    <span className="w-4 flex-shrink-0" />
                    <span className="w-[15px] flex-shrink-0" />
                    <span className="flex-1 min-w-0">{t('taskDashboard.colName')}</span>
                    <span className="w-[60px] sm:w-[72px] flex-shrink-0">{t('taskDashboard.colStatus')}</span>
                    <span className="w-[40px] sm:w-[48px] flex-shrink-0 text-right">{t('taskDashboard.chartCards')}</span>
                    <span className="w-[140px] flex-shrink-0 hidden md:block">{t('taskDashboard.progressLabel')}</span>
                    <span className="w-[80px] flex-shrink-0 text-right hidden sm:block">{t('taskDashboard.colTime')}</span>
                    <span className="w-[48px] sm:w-[96px] flex-shrink-0" />
                  </div>

                  <div className="h-px bg-border/20" />

                  {/* 行 */}
                  <div className="divide-y divide-border/[0.08]">
                    {sortedAndFiltered.map(s => (
                      <SessionRow
                        key={s.documentId}
                        session={s}
                        expanded={expandedId === s.documentId}
                        onToggle={() => setExpandedId(p => (p === s.documentId ? null : s.documentId))}
                        onJump={() => s.sourceSessionId && onNavigateToChat?.(s.sourceSessionId)}
                        onRefresh={load}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="h-px bg-border/20" />

              {/* 页脚 */}
              <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground/30">
                <span>{t('taskDashboard.totalSessions', { count: sortedAndFiltered.length })}</span>
                <span>{t('taskDashboard.footer')}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </CustomScrollArea>
  );
};

export default TaskDashboardPage;
