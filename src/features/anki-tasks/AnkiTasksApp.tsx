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
import { NotionButton } from '@/components/ui/NotionButton';
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
  MagnifyingGlass, X, ArrowsDownUp, ChatCircleDots, Coffee,
} from '@phosphor-icons/react';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import {
  registerTaskDashboardAgentSurface,
  type TaskDashboardAgentSnapshot,
} from '@/features/workbench/apps/system/agentSurfaceRegistry';
import {
  classify,
  POLL_ACTIVE, POLL_IDLE, DASHBOARD_SESSION_LIMIT,
  type DocumentSession, type AnkiStats, type FilterTab, type SortKey,
} from './types';
import { DonutChart, HBarChart } from './components/charts';
import { PropRow } from './components/bits';
import { SessionRow } from './components/SessionRow';
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
  const [recovering, setRecovering] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const agentSessionsRef = useRef<DocumentSession[]>([]);
  const agentSnapshotRef = useRef<TaskDashboardAgentSnapshot>({
    filter: 'all',
    searchQuery: '',
    focusedSessionId: null,
    loading: true,
    sessions: [],
    totalSessions: 0,
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
    })),
    totalSessions: sessions.length,
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

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    let nextHasActive = hasActiveRef.current;
    try {
      const [s, st] = await Promise.all([
        invoke<DocumentSession[]>('list_document_sessions', { limit: DASHBOARD_SESSION_LIMIT }),
        invoke<AnkiStats>('get_anki_stats'),
      ]);
      if (generation !== loadGenerationRef.current) return;

      nextHasActive = s.some(session => classify(session) === 'active');
      hasActiveRef.current = nextHasActive;
      setSessions(s);
      setStats(st);
    } catch (err: unknown) {
      debugLog.error('[AnkiTasks] load failed:', err);
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
        onLatestLoadSettledRef.current?.(nextHasActive);
      }
    }
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

    // 使用 createdAt（任务创建时间）而非 lastUpdated
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
    onMenuClick: sidebarOpen
      ? () => setSidebarOpen(false)
      : () => setSidebarOpen(true),
  }, [t, isSmallScreen, sidebarOpen]);

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
    <CustomScrollArea className="h-full">
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
              <NotionButton size="sm" variant="utility" onClick={cycleSort} className="h-7">
                <ArrowsDownUp size={14} />
                <span className="text-[11px]">{sortLabel}</span>
              </NotionButton>
              <CommonTooltip content={t('taskDashboard.refresh')}>
                <NotionButton size="sm" variant="utility" onClick={load} className="h-7 w-7 p-0" aria-label={t('taskDashboard.refresh')}>
                  <ArrowsClockwise size={14} />
                </NotionButton>
              </CommonTooltip>
              <CommonTooltip content={t('taskDashboard.recoverStuckHint')}>
                <NotionButton size="sm" variant="utility" onClick={handleRecover} disabled={recovering} className="h-7" aria-label={t('taskDashboard.recoverStuck')}>
                  {recovering
                    ? <CircleNotch size={14} className="animate-spin" />
                    : <ArrowCounterClockwise size={14} />}
                  <span className="hidden sm:inline">{t('taskDashboard.recoverStuck')}</span>
                </NotionButton>
              </CommonTooltip>
            </div>
          </header>
        )}

        {/* ======== 概览面板 ======== */}
        <div className="wb-at-panel grid grid-cols-1 gap-6 md:grid-cols-[1fr_1.6fr]">
          {/* 左：属性区 */}
          <div className="space-y-0">
            <PropRow icon={<Hash size={14} />} label={t('taskDashboard.propTotalCards')}>
              <span className="font-semibold tabular-nums">{metrics.totalCards}</span>
              {metrics.avgCards > 0 && (
                <span className="text-muted-foreground/50 ml-1 text-[12px]">
                  ({t('taskDashboard.avgCardsPerDoc')} {metrics.avgCards})
                </span>
              )}
            </PropRow>
            <PropRow icon={<FileText size={14} />} label={t('taskDashboard.propDocuments')}>
              <span className="font-semibold tabular-nums">{metrics.totalDocs}</span>
            </PropRow>
            <PropRow icon={<TrendUp size={14} />} label={t('taskDashboard.propActiveJobs')}>
              {groups.active.length > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  <CircleNotch size={12} className="text-[color:hsl(var(--info))] animate-spin" />
                  <span className="text-[color:hsl(var(--info))] font-medium">{groups.active.length}</span>
                  <CommonTooltip content={preventSleep ? t('taskDashboard.preventSleepOn') : t('taskDashboard.preventSleepOff')}>
                    <NotionButton
                      size="sm"
                      variant={preventSleep ? 'secondary' : 'ghost'}
                      onClick={togglePreventSleep}
                      className="ml-1 h-6 text-[12px]"
                    >
                      <Coffee size={12} className={preventSleep ? 'text-[color:hsl(var(--warning))]' : ''} />
                      {t('taskDashboard.preventSleep')}
                    </NotionButton>
                  </CommonTooltip>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle size={12} className="text-[color:hsl(var(--success))]" />
                  <span className="text-[color:hsl(var(--success))]">{t('taskDashboard.allDone')}</span>
                </span>
              )}
            </PropRow>
            <PropRow icon={<Warning size={14} />} label={t('taskDashboard.propErrorRate')}>
              <span className={`tabular-nums ${Number(metrics.errorRate) > 0 ? 'text-[color:hsl(var(--warning))]' : ''}`}>
                {metrics.errorRate}%
              </span>
              {metrics.failedTasks > 0 && (
                <span className="text-muted-foreground/40 ml-1">
                  ({metrics.failedTasks} {t('taskDashboard.segments')})
                </span>
              )}
            </PropRow>
            <PropRow icon={<FileText size={14} />} label={t('taskDashboard.propTemplates')}>
              <span className="tabular-nums">{stats?.templateCount ?? 0}</span>
              {/* 移动端已有整行"打开模板库"入口，避免重复渲染小号链接 */}
              {!isSmallScreen && (
                <NotionButton size="sm" variant="ghost" onClick={onOpenTemplateManagement} className="ml-2 h-6 text-[12px]">
                  {t('taskDashboard.openTemplateLib')}
                </NotionButton>
              )}
            </PropRow>
            <PropRow icon={<ChartBar size={14} />} label={t('taskDashboard.todayCards')}>
              <span className="tabular-nums font-medium">{metrics.todayCards}</span>
              <span className="text-muted-foreground/40 mx-1.5">·</span>
              <span className="text-muted-foreground/60 text-xs">{t('taskDashboard.weekCards')}</span>
              <span className="tabular-nums ml-1">{metrics.weekCards}</span>
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
                        <span className="text-[12px] text-muted-foreground">{d.label}</span>
                        <span className="text-[12px] text-foreground/70 tabular-nums ml-auto">{d.value}</span>
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
          <NotionButton
            variant="outline"
            onClick={onOpenTemplateManagement}
            className="w-full justify-center h-9"
          >
            {t('taskDashboard.openTemplateLib')}
          </NotionButton>
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
                // 移动端加大纵向点击区，接近触控目标标准
                ? '!h-auto !px-3 !py-2 text-[12px] whitespace-nowrap'
                : '!h-auto !px-2.5 !py-1 text-[12px] whitespace-nowrap'}
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
                        <span className="ml-1 text-[10px] text-muted-foreground/40 tabular-nums">
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
                className="h-7 border-transparent bg-transparent pl-7 pr-7 text-[12px]"
              />
              {search && (
                <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 !h-auto !w-auto !p-0 text-muted-foreground/40 hover:text-muted-foreground" aria-label="clear">
                  <X size={12} />
                </NotionButton>
              )}
            </div>

            {/* 移动端：排序 / 刷新 / 恢复卡住任务（桌面在页头工具条） */}
            {isSmallScreen && (
              <div className="flex items-center gap-1">
                <NotionButton size="sm" variant="utility" onClick={cycleSort}>
                  <ArrowsDownUp size={14} />
                </NotionButton>
                <NotionButton size="sm" variant="utility" onClick={load} className="w-11 p-0" aria-label={t('taskDashboard.refresh')}>
                  <ArrowsClockwise size={14} />
                </NotionButton>
                <NotionButton size="sm" variant="utility" onClick={handleRecover} disabled={recovering} aria-label={t('taskDashboard.recoverStuck')}>
                  {recovering
                    ? <CircleNotch size={14} className="animate-spin" />
                    : <ArrowCounterClockwise size={14} />}
                </NotionButton>
              </div>
            )}
          </div>

          {sessions.length === 0 ? (
            /* 空状态 + CTA */
            <div className="wb-at-empty">
              <FileText size={28} className="text-muted-foreground/30" />
              <p className="font-medium text-foreground text-[13px]">
                {t('taskDashboard.empty')}
              </p>
              <p className="text-xs text-muted-foreground/70">
                {t('taskDashboard.emptyHint')}
              </p>
              <NotionButton
                size="sm"
                variant="primary"
                className="mt-2"
                onClick={() => {
                  // onNavigateToChat 在 legacy 壳中会 setCurrentView('chat-v2')
                  // 并 dispatch navigate-to-session。传特殊标记表示仅切换视图
                  onNavigateToChat?.('__new__');
                }}
                disabled={!onNavigateToChat}
              >
                <ChatCircleDots size={14} />
                {t('taskDashboard.goToChat')}
              </NotionButton>
            </div>
          ) : sortedAndFiltered.length === 0 ? (
            <div className="wb-at-empty">
              <p className="text-[13px] text-muted-foreground/50">
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
                {!isSmallScreen && <span className="w-[96px] flex-shrink-0" />}
              </div>

              {/* 行 */}
              <div>
                {sortedAndFiltered.map(s => (
                  <SessionRow
                    key={s.documentId}
                    session={s}
                    isSmallScreen={isSmallScreen}
                    expanded={expandedId === s.documentId}
                    onToggle={() => setExpandedId(p => (p === s.documentId ? null : s.documentId))}
                    onJump={() => s.sourceSessionId && onNavigateToChat?.(s.sourceSessionId)}
                    onRefresh={load}
                  />
                ))}
              </div>

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
