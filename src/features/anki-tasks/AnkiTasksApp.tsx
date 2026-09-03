/**
 * 制卡任务应用（wb-at-*）— Workbench 原生范式重构
 *
 * 自 `components/anki/TaskDashboardPage`（legacy 大页面）迁移而来：
 * - 表面体系对齐 SystemWindowShared / flashcards（窗口平铺背景 + 扁平面板）；
 * - 拆分 SessionRow / charts / bits 子模块；
 * - 保留：智能轮询（活跃 5s / 空闲 30s / 隐藏暂停）、Agent Surface、
 *   防休眠开关、筛选 / 搜索 / 排序、移动端抽屉壳。
 */
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { useMobileHeader, MobileSlidingLayout } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ArrowsClockwise, ArrowCounterClockwise, Warning, CheckCircle,
  CircleNotch, FileText, Hash, TrendUp, ChartBar,
  MagnifyingGlass, X, ArrowsDownUp, ChatCircleDots, Coffee, Palette,
} from '@phosphor-icons/react';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import { registerTaskDashboardAgentSurface } from '@/features/workbench/apps/system/agentSurfaceRegistry';
// A45-2：Agent 表面扩展（状态令牌 + 焦点会话失败分段），见 docs/dev/acr/ACR-4.5.md
import { listFailedDocumentTasks } from '@/features/anki/taskControl';
import type {
  TaskDashboardAgentSnapshotDetailed,
  TaskDashboardFocusedFailedTasks,
} from './agentSurface';
import {
  classify, computeWindowCardStats,
  POLL_ACTIVE, POLL_IDLE, DASHBOARD_SESSION_LIMIT,
  type DocumentSession, type AnkiStats, type FilterTab, type SortKey,
} from './types';
import { DonutChart, HBarChart } from './components/charts';
import { PropRow } from './components/bits';
import { AnimatedNumber } from './components/AnimatedNumber';
import { SessionRow } from './components/SessionRow';
import {
  SettingsVirtualList,
  type SettingsVirtualItem,
} from '@/features/settings/components/SettingsVirtualList';
import './anki-tasks.css';

export interface AnkiTasksAppProps {
  onNavigateToChat?: (sessionId: string) => void;
  onOpenTemplateManagement?: () => void;
  /** Workbench visibility overrides the legacy route visibility when provided. */
  isVisible?: boolean;
  workbenchWindowId?: string;
}

export const AnkiTasksApp: React.FC<AnkiTasksAppProps> = ({
  onNavigateToChat,
  onOpenTemplateManagement,
  isVisible,
  workbenchWindowId,
}) => {
  const { t } = useTranslation('anki');
  const { isSmallScreen } = useBreakpoint();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessions, setSessions] = useState<DocumentSession[]>([]);
  const [stats, setStats] = useState<AnkiStats | null>(null);
  const [loading, setLoading] = useState(true);
  // 主加载失败必须与「暂无任务」区分开：空列表是事实，加载失败是未知
  const [loadError, setLoadError] = useState<string | null>(null);
  // stats-only failure：列表可用时统计区单独降级，不拖垮整页（见 load）
  const [statsError, setStatsError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 会话列表滚动视口：长列表（上限可到数百行）虚拟化，压低常驻 DOM 规模
  // （窗口拖拽的每帧税 ∝ 挂载节点数，见 wb-interaction-trace）
  const [listScrollElement, setListScrollElement] = useState<HTMLDivElement | null>(null);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  // A45-2：焦点会话失败分段（供 Agent 按 ref 重试单个分段；仅 Workbench 表面挂载时加载）
  const [agentFailedTasks, setAgentFailedTasks] = useState<TaskDashboardFocusedFailedTasks | null>(null);
  const agentSessionsRef = useRef<DocumentSession[]>([]);
  const agentSnapshotRef = useRef<TaskDashboardAgentSnapshotDetailed>({
    filter: 'all',
    searchQuery: '',
    focusedSessionId: null,
    loading: true,
    sessions: [],
    totalSessions: 0,
    focusedFailedTasks: null,
  });

  agentSessionsRef.current = sessions;
  agentSnapshotRef.current = {
    filter,
    searchQuery: search,
    focusedSessionId: expandedId,
    loading,
    sessions: sessions.slice(0, 80).map((session) => ({
      id: session.documentId,
      name: session.documentName || session.documentId,
      status: classify(session),
      sourceSessionId: session.sourceSessionId,
      updatedAt: session.lastUpdated,
      // A45-2 状态令牌：口径与 list_document_sessions 一致（见 agentSurface.ts）
      totalTasks: session.totalTasks,
      completedTasks: session.completedTasks,
      failedTasks: session.failedTasks,
      activeTasks: session.activeTasks,
      pausedTasks: session.pausedTasks,
      totalCards: session.totalCards,
    })),
    totalSessions: sessions.length,
    focusedFailedTasks:
      agentFailedTasks && agentFailedTasks.sessionId === expandedId ? agentFailedTasks : null,
  };

  useEffect(() => {
    if (!workbenchWindowId) return undefined;
    return registerTaskDashboardAgentSurface(workbenchWindowId, {
      snapshot: () => agentSnapshotRef.current,
      focusSession: (sessionId) => {
        if (!agentSessionsRef.current.some((session) => session.documentId === sessionId)) {
          return false;
        }
        agentSnapshotRef.current = {
          ...agentSnapshotRef.current,
          focusedSessionId: sessionId,
        };
        setExpandedId(sessionId);
        return true;
      },
      filter: (nextFilter) => {
        agentSnapshotRef.current = { ...agentSnapshotRef.current, filter: nextFilter };
        setFilter(nextFilter);
        return true;
      },
    });
  }, [workbenchWindowId]);

  /**
   * A45-2：焦点会话存在失败口径任务时，为 Agent 观察面加载失败分段清单。
   * 走 UI 同一条链路（listFailedDocumentTasks，与 FailedTasksPanel 一致）；
   * key 编码「会话 id + 失败数 + 最后更新时间」，轮询导致的 sessions 数组换引用
   * 不会重复拉取，失败数/更新时间变化才刷新。仅 Workbench 表面挂载时启用。
   */
  const agentFailedKey = useMemo(() => {
    if (!workbenchWindowId || !expandedId) return null;
    const session = sessions.find(s => s.documentId === expandedId);
    if (!session || session.failedTasks <= 0) return null;
    return JSON.stringify([session.documentId, session.failedTasks, session.lastUpdated]);
  }, [workbenchWindowId, expandedId, sessions]);

  useEffect(() => {
    if (!agentFailedKey) {
      setAgentFailedTasks(null);
      return undefined;
    }
    const [sessionId] = JSON.parse(agentFailedKey) as [string, number, string];
    let alive = true;
    setAgentFailedTasks({ sessionId, loading: true, loadError: null, tasks: [] });
    listFailedDocumentTasks(sessionId)
      .then((failed) => {
        if (!alive) return;
        setAgentFailedTasks({
          sessionId,
          loading: false,
          loadError: null,
          tasks: failed.map(task => ({
            id: task.id,
            status: task.status,
            segmentIndex: task.segment_index,
            errorMessage: task.error_message ?? null,
          })),
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        // 观察面诚实报告加载失败，不静默装作「没有失败任务」
        setAgentFailedTasks({ sessionId, loading: false, loadError: getErrorMessage(err), tasks: [] });
      });
    return () => { alive = false; };
  }, [agentFailedKey]);

  // 智能轮询 —— 通过 ref 跟踪是否有活跃任务
  const hasActiveRef = useRef(false);
  const previousActiveForSleepRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const onLatestLoadSettledRef = useRef<((hasActive: boolean) => void) | null>(null);
  // Hook 必须始终调用；Workbench 窗口通过 isVisible 覆盖 legacy currentView。
  const { isActive: isLegacyViewActive } = useViewVisibility('task-dashboard');
  const isViewActive = isVisible ?? isLegacyViewActive;

  // 防休眠开关（长任务时阻止系统休眠）
  const [preventSleep, setPreventSleep] = useState(false);
  useEffect(() => {
    invoke<boolean>('get_prevent_sleep')
      .then(setPreventSleep)
      .catch(() => { /* 平台不支持时保持 false */ });
  }, []);
  const togglePreventSleep = useCallback(async () => {
    try {
      const next = await invoke<boolean>('set_prevent_sleep', { enabled: !preventSleep });
      setPreventSleep(next);
      if (next !== !preventSleep && !preventSleep) {
        // 请求开启但实际未开启 → 平台不支持
        showGlobalNotification('info', t('taskDashboard.preventSleepUnsupported'));
      }
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    }
  }, [preventSleep, t]);

  /**
   * list 与 stats 拆分加载（Wave2-E r3）：此前 Promise.all 快速失败绑死，
   * get_anki_stats 单独挂掉会把已成功返回的会话列表一并丢进整页错误态。
   * 现改为 allSettled，两个请求各自结算：
   * - list 成功 → 列表照常渲染/刷新，loadError 清空；
   * - stats-only failure → 保留列表，仅点亮 statsError 错误条，统计区
   *   沿用上一次数据（metrics 对 stats 为 null 也有 ?? 0 兜底）；
   * - list-only failure → 维持原有 stale banner / 整页错误态语义。
   */
  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    let nextHasActive = hasActiveRef.current;
    // allSettled 永不 reject，无需 try/catch；generation 守卫语义不变
    const [listResult, statsResult] = await Promise.allSettled([
      invoke<DocumentSession[]>('list_document_sessions', { limit: DASHBOARD_SESSION_LIMIT }),
      invoke<AnkiStats>('get_anki_stats'),
    ]);
    if (generation !== loadGenerationRef.current) return;

    if (listResult.status === 'fulfilled') {
      const s = listResult.value;
      nextHasActive = s.some(session => classify(session) === 'active');
      hasActiveRef.current = nextHasActive;
      setSessions(s);
      setLoadError(null);
    } else {
      debugLog.error('[AnkiTasks] list load failed:', listResult.reason);
      // 不吞错：列表保持上一次已知数据，同时暴露错误态 + 重试
      setLoadError(getErrorMessage(listResult.reason));
    }

    if (statsResult.status === 'fulfilled') {
      setStats(statsResult.value);
      setStatsError(null);
    } else {
      debugLog.error('[AnkiTasks] stats load failed:', statsResult.reason);
      setStatsError(getErrorMessage(statsResult.reason));
    }

    setLoading(false);
    onLatestLoadSettledRef.current?.(nextHasActive);
  }, []);

  // 智能轮询 —— 有活跃任务 5s，无则 30s；视图不可见时暂停
  useEffect(() => {
    if (!isViewActive) {
      // 失活时使在途请求失效，避免隐藏页面被旧响应覆盖。
      loadGenerationRef.current += 1;
      onLatestLoadSettledRef.current = null;
      return;
    }

    let effectActive = true;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const schedulePoll = (hasActive: boolean) => {
      if (!effectActive) return;
      if (timerId) clearTimeout(timerId);
      const delay = hasActive ? POLL_ACTIVE : POLL_IDLE;
      timerId = setTimeout(() => {
        timerId = null;
        if (!effectActive) return;
        if (!document.hidden) {
          void load();
        } else {
          schedulePoll(hasActiveRef.current);
        }
      }, delay);
    };

    // 所有加载入口（首次、轮询、visibility、手动刷新）完成后均重置唯一 timer。
    // 只有最新 generation 能触发该回调，因此旧响应不会改变状态或轮询节奏。
    onLatestLoadSettledRef.current = schedulePoll;
    void load(); // 首次加载完成后，再按实际任务状态安排 5s/30s timer。

    const handleVisibility = () => {
      if (!document.hidden && effectActive) {
        if (timerId) clearTimeout(timerId);
        timerId = null;
        void load();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      effectActive = false;
      if (onLatestLoadSettledRef.current === schedulePoll) {
        onLatestLoadSettledRef.current = null;
      }
      loadGenerationRef.current += 1;
      if (timerId) clearTimeout(timerId);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [load, isViewActive]);

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

  // 同步 hasActiveRef；任务全部结束时自动解除防休眠
  useEffect(() => {
    const hasActive = groups.active.length > 0;
    const hadActive = previousActiveForSleepRef.current;
    previousActiveForSleepRef.current = hasActive;
    hasActiveRef.current = hasActive;
    if (hadActive && !hasActive) {
      invoke<boolean>('set_prevent_sleep', { enabled: false })
        .then(setPreventSleep)
        .catch(() => { /* ignore */ });
    }
  }, [groups.active.length]);

  // 聚合指标
  const metrics = useMemo(() => {
    const totalCards = stats?.totalCards ?? 0;
    const totalDocs = stats?.totalDocuments ?? 0;
    const totalTasks = sessions.reduce((s, d) => s + d.totalTasks, 0);
    const failedTasks = sessions.reduce((s, d) => s + d.failedTasks, 0);
    const errorRate = totalTasks > 0 ? ((failedTasks / totalTasks) * 100).toFixed(1) : '0.0';
    const avgCards = totalDocs > 0 ? Math.round(totalCards / totalDocs) : 0;

    // 今日/本周口径：会话只有 createdAt(MIN)/lastUpdated(MAX) 两个端点，
    // 无逐卡时间戳。窗口内创建的会话计入全部卡片（精确）；跨窗口边界的
    // 会话（创建早于窗口、更新晚于窗口起点）也计入并标记为估算（UI 显示 ≈）
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const weekStart = todayStart - 6 * 86_400_000; // 最近 7 天
    const today = computeWindowCardStats(sessions, todayStart);
    const week = computeWindowCardStats(sessions, weekStart);

    return {
      totalCards, totalDocs, totalTasks, failedTasks, errorRate, avgCards,
      todayCards: today.count,
      todayApprox: today.approximate,
      weekCards: week.count,
      weekApprox: week.approximate,
    };
  }, [sessions, stats]);

  // 环形图（语义状态色，明暗模式均可）
  const donutData = useMemo(
    () => [
      { label: t('taskDashboard.statusDone'), value: groups.completed.length, color: 'hsl(var(--success))' },
      { label: t('taskDashboard.statusActive'), value: groups.active.length, color: 'hsl(var(--info))' },
      { label: t('taskDashboard.statusFailed'), value: groups.attention.length, color: 'hsl(var(--warning))' },
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

  // 筛选 + 搜索 + 排序
  const sortedAndFiltered = useMemo(() => {
    let list = sessions;
    if (filter !== 'all') {
      list = list.filter(s => classify(s) === filter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        s =>
          (s.documentName || '').toLowerCase().includes(q) ||
          s.documentId.toLowerCase().includes(q),
      );
    }
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
    // 运行中会话置顶（stable partition，组内保持排序维度的相对顺序），
    // 仅混合列表（全部 tab）需要，单状态 tab 不改动顺序
    if (filter === 'all') {
      const running = sorted.filter(s => s.activeTasks > 0);
      if (running.length > 0 && running.length < sorted.length) {
        return [...running, ...sorted.filter(s => s.activeTasks === 0)];
      }
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

  // 排序循环
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
    subtitle: isSmallScreen ? undefined : t('taskDashboard.subtitle'),
    showMenu: true,
    onMenuClick: () => setSidebarOpen(true),
  }, [t, isSmallScreen, workbenchWindowId],
  // Workbench 窗口内嵌入时不接管全局移动端顶栏（对照 TodoContentView）
  !workbenchWindowId);

  const renderMobileShell = (body: React.ReactNode) => {
    if (!isSmallScreen) {
      return <div className="wb-at-root">{body}</div>;
    }
    return (
      <div className="wb-at-root absolute inset-0 overflow-hidden">
        <MobileSlidingLayout
          sidebar={
            // 本页无页内工具，抽屉只承载统一应用导航；
            // 不再渲染与顶栏标题重复的孤立分区标签
            <div aria-hidden className="h-0" />
          }
          sidebarOpen={sidebarOpen}
          onSidebarOpenChange={setSidebarOpen}
          sidebarWidth="auto"
          showSidebarAppNavigation
          showContentOverlay
          className="flex-1"
        >
          {body}
        </MobileSlidingLayout>
      </div>
    );
  };

  // ======== 渲染 ========

  if (loading) {
    return renderMobileShell(
      <div className="wb-at-loading h-full">
        <CircleNotch size={20} className="animate-spin" />
        <span>{t('taskDashboard.loading')}</span>
      </div>,
    );
  }

  const body = (
    <CustomScrollArea className="h-full" viewportRef={setListScrollElement}>
      <div
        className={`wb-at-screen max-w-[960px] mx-auto w-full${
          // 移动端：列表底部预留手势导航安全区
          isSmallScreen ? ' pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))]' : ''
        }`}
      >
        {/* ======== 头部（移动端顶栏已展示标题） ======== */}
        {!isSmallScreen && (
          <header className="wb-at-header">
            <div className="min-w-0">
              <h2 className="wb-at-title">{t('taskDashboard.title')}</h2>
              <p className="wb-at-subtitle">{t('taskDashboard.subtitle')}</p>
            </div>
            <div className="wb-at-toolbar">
              <DsButton size="sm" variant="utility" onClick={cycleSort} className="h-7">
                <ArrowsDownUp size={14} />
                <span className="text-xs">{sortLabel}</span>
              </DsButton>
              <CommonTooltip content={t('taskDashboard.refresh')}>
                <DsButton size="sm" variant="utility" onClick={load} className="h-7 w-7 p-0" aria-label={t('taskDashboard.refresh')}>
                  <ArrowsClockwise size={14} />
                </DsButton>
              </CommonTooltip>
              <CommonTooltip content={t('taskDashboard.recoverStuckHint')}>
                <DsButton size="sm" variant="utility" onClick={handleRecover} disabled={recovering} className="h-7" aria-label={t('taskDashboard.recoverStuck')}>
                  {recovering
                    ? <CircleNotch size={14} className="animate-spin" />
                    : <ArrowCounterClockwise size={14} />}
                  <span className="hidden sm:inline">{t('taskDashboard.recoverStuck')}</span>
                </DsButton>
              </CommonTooltip>
            </div>
          </header>
        )}

        {/* ======== 概览面板 ======== */}
        <div className="wb-at-panel grid grid-cols-1 gap-6 md:grid-cols-[1fr_1.6fr]">
          {/* 左：属性区 */}
          <div className="space-y-0">
            <PropRow icon={<Hash size={14} />} label={t('taskDashboard.propTotalCards')}>
              <AnimatedNumber value={metrics.totalCards} className="font-semibold" />
              {metrics.avgCards > 0 && (
                <span className="text-muted-foreground/50 ml-1 text-sm">
                  ({t('taskDashboard.avgCardsPerDoc')} {metrics.avgCards})
                </span>
              )}
            </PropRow>
            <PropRow icon={<FileText size={14} />} label={t('taskDashboard.propDocuments')}>
              <AnimatedNumber value={metrics.totalDocs} className="font-semibold" />
            </PropRow>
            <PropRow icon={<TrendUp size={14} />} label={t('taskDashboard.propActiveJobs')}>
              {groups.active.length > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <CircleNotch size={12} className="text-info animate-spin" />
                  <span className="text-info font-medium">{groups.active.length}</span>
                  <CommonTooltip content={preventSleep ? t('taskDashboard.preventSleepOn') : t('taskDashboard.preventSleepOff')}>
                    <DsButton
                      size="sm"
                      variant={preventSleep ? 'secondary' : 'ghost'}
                      onClick={togglePreventSleep}
                      className="ml-1 h-6 text-sm"
                    >
                      <Coffee size={12} className={preventSleep ? 'text-warning' : ''} />
                      {t('taskDashboard.preventSleep')}
                    </DsButton>
                  </CommonTooltip>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle size={12} className="text-success" />
                  <span className="text-success">{t('taskDashboard.allDone')}</span>
                </span>
              )}
            </PropRow>
            <PropRow icon={<Warning size={14} />} label={t('taskDashboard.propErrorRate')}>
              <span className={`tabular-nums ${Number(metrics.errorRate) > 0 ? 'text-warning' : ''}`}>
                {metrics.errorRate}%
              </span>
              {metrics.failedTasks > 0 && (
                <span className="text-muted-foreground/40 ml-1">
                  ({metrics.failedTasks} {t('taskDashboard.segments')})
                </span>
              )}
            </PropRow>
            {/* templateCount 实为「卡片引用过的 distinct template_id」数，
                非模板库总量，文案按此口径诚实标注 */}
            <PropRow icon={<FileText size={14} />} label={t('tasks.templatesUsed')}>
              <CommonTooltip content={t('tasks.templatesUsedHint')}>
                <span className="tabular-nums cursor-default">
                  <AnimatedNumber value={stats?.templateCount ?? 0} />
                </span>
              </CommonTooltip>
              {/* 移动端已有整行"打开模板库"入口，避免重复渲染小号链接 */}
              {!isSmallScreen && (
                <DsButton size="sm" variant="ghost" onClick={onOpenTemplateManagement} className="ml-2 h-6 text-sm">
                  {t('taskDashboard.openTemplateLib')}
                </DsButton>
              )}
            </PropRow>
            <PropRow icon={<ChartBar size={14} />} label={t('taskDashboard.todayCards')}>
              <span
                className="inline-flex items-baseline font-medium"
                title={metrics.todayApprox ? t('tasks.windowApproxHint') : undefined}
              >
                {metrics.todayApprox && <span className="text-muted-foreground/50 mr-0.5">≈</span>}
                <AnimatedNumber value={metrics.todayCards} />
              </span>
              <span className="text-muted-foreground/40 mx-1.5">·</span>
              <span className="text-muted-foreground/60 text-xs">{t('taskDashboard.weekCards')}</span>
              <span
                className="inline-flex items-baseline ml-1"
                title={metrics.weekApprox ? t('tasks.windowApproxHint') : undefined}
              >
                {metrics.weekApprox && <span className="text-muted-foreground/50 mr-0.5">≈</span>}
                <AnimatedNumber value={metrics.weekCards} />
              </span>
            </PropRow>
          </div>

          {/* 右：可视化 —— 环形图 & 柱状图 */}
          {sessions.length > 0 && (
            <div className="flex flex-col md:flex-row gap-6">
              <div className="flex-shrink-0">
                <div className="wb-at-panel-title">
                  {t('taskDashboard.chartStatusDistribution')}
                </div>
                <div className="flex items-center gap-5">
                  <DonutChart
                    data={donutData}
                    size={100}
                    centerLabel={t('taskDashboard.donutCenterLabel')}
                  />
                  <div className="space-y-2">
                    {donutData.map((d, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} />
                        <span className="text-sm text-muted-foreground">{d.label}</span>
                        <span className="text-sm text-foreground/70 tabular-nums ml-auto">{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {barData.length > 0 && (
                <div className="flex-1 min-w-0 w-full">
                  <div className="wb-at-panel-title">
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
          <DsButton
            variant="outline"
            onClick={onOpenTemplateManagement}
            className="w-full justify-center h-11"
          >
            {t('taskDashboard.openTemplateLib')}
          </DsButton>
        )}

        {/* stats-only failure：列表不受影响，统计区降级并显式提示（与列表错误不互斥） */}
        {statsError && (
          <div
            role="status"
            data-testid="anki-tasks-stats-error"
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs"
          >
            <Warning size={14} className="text-warning" />
            <span className="min-w-0 break-words text-muted-foreground">
              {t('taskDashboard.statsLoadFailed', {
                defaultValue: '统计数据加载失败，任务列表不受影响',
              })}
            </span>
            <span className="min-w-0 break-words text-muted-foreground/60">{statsError}</span>
            <DsButton size="sm" variant="utility" className="ml-auto" onClick={load}>
              <ArrowsClockwise size={13} />
              {t('taskDashboard.retry')}
            </DsButton>
          </div>
        )}

        {/* 刷新失败但仍有上一次数据：标明数据可能已过时，而不是静默沿用 */}
        {loadError && sessions.length > 0 && (
          <div
            role="status"
            data-testid="anki-tasks-stale-banner"
            className="flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs"
          >
            <Warning size={14} className="text-warning" />
            <span className="min-w-0 break-words text-muted-foreground">
              {t('taskDashboard.refreshFailedStale')}
            </span>
            <DsButton size="sm" variant="utility" className="ml-auto" onClick={load}>
              <ArrowsClockwise size={13} />
              {t('taskDashboard.retry')}
            </DsButton>
          </div>
        )}

        {/* ======== 任务列表 ======== */}
        <div className="wb-at-list">
          {/* 筛选 tabs + 搜索 + 计数（移动端补充操作按钮） */}
          <div className="wb-at-list-toolbar">
            <SegmentedControl<FilterTab>
              ariaLabel={t('taskDashboard.filterAll')}
              value={filter}
              onValueChange={setFilter}
              size="compact"
              className="flex-shrink-0"
              itemClassName={isSmallScreen
                // 移动端加大纵向点击区，接近触控目标标准；
                // 触控闸门必须用 pointer:coarse（iPad 横屏视口 ≥768 走桌面分支，
                // 不能只靠 isSmallScreen）。!min-h-11 带 important：app.css 的
                // .study-shell-segmented-button { min-height: 0 } 会盖掉基元里
                // 非 important 的 coarse min-h-11
                ? '!h-auto !px-3 !py-2 text-sm whitespace-nowrap'
                : '!h-auto !px-2.5 !py-1 text-sm whitespace-nowrap [@media(pointer:coarse)]:!px-3'}
              options={(['all', 'active', 'attention', 'completed'] as FilterTab[]).map((tab) => {
                const labelText =
                  tab === 'all'
                    ? t('taskDashboard.filterAll')
                    : tab === 'active'
                      ? t('taskDashboard.statusActive')
                      : tab === 'attention'
                        ? t('taskDashboard.statusFailed')
                        : t('taskDashboard.statusDone');
                return {
                  value: tab,
                  label: (
                    <>
                      <span>{labelText}</span>
                      {tabCounts[tab] > 0 && (
                        <span className="ml-1 text-2xs text-muted-foreground/40 tabular-nums">
                          {tabCounts[tab]}
                        </span>
                      )}
                    </>
                  ),
                };
              })}
            />

            <div className="flex-1" />

            {/* 搜索框 */}
            <div className="relative max-w-[200px] flex-shrink-0">
              <MagnifyingGlass size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/30" />
              <Input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('taskDashboard.searchPlaceholder')}
                className="h-7 border-transparent bg-transparent pl-7 pr-7 text-sm [@media(pointer:coarse)]:h-[var(--touch-target-size)]"
              />
              {search && (
                <DsButton variant="ghost" size="icon" iconOnly onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 !h-auto !w-auto !p-0 text-muted-foreground/40 hover:text-muted-foreground" aria-label={t('common:clear', { defaultValue: 'Clear' })}>
                  <X size={12} />
                </DsButton>
              )}
            </div>

            {/* 移动端：排序 / 刷新 / 恢复卡住任务（桌面在页头工具条） */}
            {isSmallScreen && (
              <div className="flex items-center gap-1">
                <DsButton size="sm" variant="utility" onClick={cycleSort} aria-label={sortLabel} title={sortLabel}>
                  <ArrowsDownUp size={14} />
                  <span className="text-xs">{sortLabel}</span>
                </DsButton>
                <DsButton size="sm" variant="utility" onClick={load} className="w-11 p-0" aria-label={t('taskDashboard.refresh')}>
                  <ArrowsClockwise size={14} />
                </DsButton>
                {/* 触屏无 hover tooltip，纯图标无从得知含义——补文案（工具条 flex-wrap 可换行不溢出） */}
                <DsButton size="sm" variant="utility" onClick={handleRecover} disabled={recovering} aria-label={t('taskDashboard.recoverStuck')} title={t('taskDashboard.recoverStuckHint')}>
                  {recovering
                    ? <CircleNotch size={14} className="animate-spin" />
                    : <ArrowCounterClockwise size={14} />}
                  <span className="text-xs">{t('taskDashboard.recoverStuck')}</span>
                </DsButton>
              </div>
            )}
          </div>

          {loadError && sessions.length === 0 ? (
            /* 加载失败 ≠ 没有任务：显式错误态 + 重试 */
            <div className="wb-at-empty" role="alert" data-testid="anki-tasks-load-error">
              <Warning size={28} className="text-warning" />
              <p className="font-medium text-foreground text-ui">
                {t('taskDashboard.loadFailed')}
              </p>
              <p className="max-w-md break-words text-xs text-muted-foreground/70">
                {loadError}
              </p>
              <DsButton size="sm" variant="primary" className="mt-2" onClick={load}>
                <ArrowsClockwise size={14} />
                {t('taskDashboard.retry')}
              </DsButton>
            </div>
          ) : sessions.length === 0 ? (
            /* 空状态 + 双引导：去聊天发起制卡（主）/ 打开模板库先备好模板（次） */
            <div className="wb-at-empty">
              <FileText size={28} className="text-muted-foreground/30" />
              <p className="font-medium text-foreground text-ui">
                {t('taskDashboard.empty')}
              </p>
              <p className="text-xs text-muted-foreground/70">
                {t('taskDashboard.emptyHint')}
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                <DsButton
                  size="sm"
                  variant="primary"
                 
                  onClick={() => {
                    // onNavigateToChat 在 legacy 壳中会 setCurrentView('chat-v2')
                    // 并 dispatch navigate-to-session。传特殊标记表示仅切换视图
                    onNavigateToChat?.('__new__');
                  }}
                  disabled={!onNavigateToChat}
                >
                  <ChatCircleDots size={14} />
                  {t('taskDashboard.goToChat')}
                </DsButton>
                {onOpenTemplateManagement && (
                  <DsButton
                    size="sm"
                    variant="default"
                   
                    onClick={onOpenTemplateManagement}
                  >
                    <Palette size={14} />
                    {t('taskDashboard.openTemplateLib')}
                  </DsButton>
                )}
              </div>
            </div>
          ) : sortedAndFiltered.length === 0 ? (
            <div className="wb-at-empty">
              <p className="text-ui text-muted-foreground/50">
                {t('taskDashboard.noMatchFilter')}
              </p>
            </div>
          ) : (
            <>
              {/* 表头 */}
              <div className="wb-at-list-head">
                <span className="w-4 flex-shrink-0" />
                <span className="w-[15px] flex-shrink-0" />
                <span className="flex-1 min-w-0">{t('taskDashboard.colName')}</span>
                <span className="w-[60px] sm:w-[72px] flex-shrink-0">{t('taskDashboard.colStatus')}</span>
                <span className="w-[40px] sm:w-[48px] flex-shrink-0 text-right">{t('taskDashboard.chartCards')}</span>
                <span className="w-[140px] flex-shrink-0 wb-at-col-progress">{t('taskDashboard.progressLabel')}</span>
                <span className="w-[80px] flex-shrink-0 text-right hidden sm:block">{t('taskDashboard.colTime')}</span>
                {/* 操作列占位：移动端行内操作簇已隐藏（操作收入展开区），无需占位 */}
                {!isSmallScreen && <span className="w-[120px] flex-shrink-0" />}
              </div>

              {/* 行：超过阈值走窗口虚拟化（复用外层滚动视口，动态量高兼容展开区） */}
              <SettingsVirtualList
                items={sortedAndFiltered.map((s): SettingsVirtualItem => ({
                  key: s.documentId,
                  estimateSize: expandedId === s.documentId ? 320 : 48,
                  render: () => (
                    <SessionRow
                      key={s.documentId}
                      session={s}
                      isSmallScreen={isSmallScreen}
                      expanded={expandedId === s.documentId}
                      onToggle={() => setExpandedId(p => (p === s.documentId ? null : s.documentId))}
                      onJump={() => s.sourceSessionId && onNavigateToChat?.(s.sourceSessionId)}
                      onRefresh={load}
                    />
                  ),
                }))}
                scrollElement={listScrollElement}
                threshold={25}
                overscan={3}
              />

              {/* 页脚 */}
              <div className="wb-at-footer">
                <span>{t('taskDashboard.totalSessions', { count: sortedAndFiltered.length })}</span>
                <span>{t('taskDashboard.footer')}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </CustomScrollArea>
  );

  return renderMobileShell(body);
};

export default AnkiTasksApp;
