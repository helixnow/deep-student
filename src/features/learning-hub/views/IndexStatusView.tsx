import { NotionButton } from '@/components/ui/NotionButton';
import { pLimit } from '@/utils/concurrency';
import { Input } from '@/components/ui/shad/Input';
import IndexDiagnosticPanel from './IndexDiagnosticPanel';
/**
 * 向量化状态视图
 *
 * 展示所有资源的向量化状态，支持筛选、重新索引等操作。
 * 
 * ## 优化设计（2026-01）
 * - 环形进度图：直观展示整体索引完成度
 * - 紧凑统计：状态分布一目了然
 * - 分组列表：按状态智能分组
 * 
 * ## 架构状态说明（2026-01 更新）
 * 
 * ### 后端已完成统一架构迁移
 * - vfs_get_all_index_status 已使用新表 vfs_index_units/vfs_index_segments
 * - vfs_batch_index_pending 使用 VfsFullIndexingService（统一索引流程）
 * - lance_row_id 与 LanceDB embedding_id 已同步一致
 * - lance_table_name 统一使用 vfs_emb_ 前缀
 * 
 * ### 前端 API 选择
 * - 当前使用 vfsRagApi：面向资源的索引状态查询（适合列表展示）
 * - 备选 vfsUnifiedIndexApi：面向 Unit 的索引状态查询（适合细粒度管理）
 * - 两套 API 后端均已适配新表，可根据 UI 需求选择使用
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useTranslation } from 'react-i18next';
import {
  Database,
  ArrowsClockwise,
  CheckCircle,
  Clock,
  WarningCircle,
  XCircle,
  Prohibit,
  FileText,
  BookOpen,
  ClipboardText,
  Translate,
  PenNib,
  CircleNotch,
  Warning,
  CaretDown,
  CaretRight,
  Lightning,
  Image,
  MagnifyingGlass,
  X,
  TestTube,
  ShareNetwork,
  ArrowCounterClockwise,
  FlowArrow,
  DotsThree,
  Eye,
  Eraser,
  Stack,
} from '@phosphor-icons/react';
// Button 组件已替换为原生 button + Tailwind（Notion 风格）
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  getAllIndexStatus,
  reindexResource,
  batchIndexPendingLegacy as batchIndexPending,
  listDimensions,
  getResourceOcrInfo,
  clearResourceOcr,
  getResourceTextChunks,
  type ResourceIndexStatusSummary as IndexStatusSummary,
  type ResourceIndexStatus,
  type ResourceOcrInfo,
  type TextChunkInfo,
  type VfsEmbeddingDimension,
} from '@/api/vfsUnifiedIndexApi';
import {
  vfsRagSearch,
  resetAllIndexState,
  type VfsSearchResult,
} from '@/api/vfsRagApi';
import multimodalRagService, { type SourceType as MMSourceType, MULTIMODAL_INDEX_SUPPORTED } from '@/services/multimodalRagService';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { Progress } from '@/components/ui/shad/Progress';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
// ★ 2026-02 修复：统一使用共享类型定义，避免重复定义不一致风险
import type { IndexState } from '@/types/vfs-unified-index';

// ============================================================================
// 类型和常量
// ============================================================================

/** 状态配置 */
const STATE_CONFIG: Record<IndexState, { labelKey: string; icon: React.ElementType; color: string; bgColor: string; ringColor: string }> = {
  indexed: { labelKey: 'indexStatus.state.indexed', icon: CheckCircle, color: 'text-success', bgColor: 'bg-success/10', ringColor: 'stroke-success' },
  pending: { labelKey: 'indexStatus.state.pending', icon: Clock, color: 'text-warning', bgColor: 'bg-warning/10', ringColor: 'stroke-warning' },
  indexing: { labelKey: 'indexStatus.state.indexing', icon: ArrowsClockwise, color: 'text-info', bgColor: 'bg-info/10', ringColor: 'stroke-info' },
  failed: { labelKey: 'indexStatus.state.failed', icon: WarningCircle, color: 'text-danger', bgColor: 'bg-danger/10', ringColor: 'stroke-danger' },
  disabled: { labelKey: 'indexStatus.state.disabled', icon: Prohibit, color: 'text-gray-500 dark:text-gray-400', bgColor: 'bg-gray-500/10', ringColor: 'stroke-gray-400' },
};

/** 资源类型配置 */
const RESOURCE_TYPE_CONFIG: Record<string, { icon: React.ElementType; labelKey: string; color: string }> = {
  note: { icon: FileText, labelKey: 'indexStatus.resourceType.note', color: 'text-info bg-info/10' },
  textbook: { icon: BookOpen, labelKey: 'indexStatus.resourceType.textbook', color: 'text-purple-500 bg-purple-500/10' },
  exam: { icon: ClipboardText, labelKey: 'indexStatus.resourceType.exam', color: 'text-warning bg-warning/10' },
  translation: { icon: Translate, labelKey: 'indexStatus.resourceType.translation', color: 'text-cyan-500 bg-cyan-500/10' },
  essay: { icon: PenNib, labelKey: 'indexStatus.resourceType.essay', color: 'text-pink-500 bg-pink-500/10' },
  mindmap: { icon: ShareNetwork, labelKey: 'indexStatus.resourceType.mindmap', color: 'text-indigo-500 bg-indigo-500/10' },
  retrieval: { icon: Database, labelKey: 'indexStatus.resourceType.retrieval', color: 'text-success bg-success/10' },
  file: { icon: FileText, labelKey: 'indexStatus.resourceType.file', color: 'text-gray-500 bg-gray-500/10' },
  image: { icon: Image, labelKey: 'indexStatus.resourceType.image', color: 'text-warning bg-warning/10' },
};

/** 不支持任何索引的资源类型（技能卡等系统资源） */
const UNSUPPORTED_INDEX_TYPES = new Set(['retrieval']);

/**
 * 头部概览区切换紧凑布局的容器宽度阈值（px）。
 * 桌面宽布局需要约 880px：进度环组 ~250 + 按钮簇 ~150 + 间距/内边距 ~80，
 * 剩余给 4 列统计卡每张至少 ~100px；低于该宽度时卡片标签会被截断。
 * 注意按「容器」而非「视口」判断——侧边栏会压缩内容区宽度。
 */
const COMPACT_HEADER_BREAKPOINT = 880;

// ============================================================================
// 环形进度图组件
// ============================================================================

interface ProgressRingProps {
  /** 已索引百分比 0-100 */
  percentage: number;
  /** 尺寸 */
  size?: number;
  /** 描边宽度 */
  strokeWidth?: number;
  /** 总数 */
  total: number;
  /** 已索引数 */
  indexed: number;
}

const ProgressRing: React.FC<ProgressRingProps> = ({
  percentage,
  size = 120,
  strokeWidth = 10,
  total,
  indexed,
}) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        {/* 背景圆环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/30"
        />
        {/* 进度圆环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="url(#progressGradient)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-500 ease-out"
        />
        <defs>
          <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="hsl(var(--primary))" />
            <stop offset="100%" stopColor="hsl(142 76% 36%)" />
          </linearGradient>
        </defs>
      </svg>
      {/* 中心文字 - 小尺寸时不显示 */}
      {size >= 50 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={cn("font-semibold tabular-nums tracking-tight text-foreground", size < 80 ? "text-base" : "text-xl")}>{Math.round(percentage)}%</span>
          <span className="text-2xs text-muted-foreground/80 tabular-nums">{indexed}/{total}</span>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 内联展开容器（grid-rows 折叠动画）
// ============================================================================

/**
 * 挂载后从 0fr 过渡到 1fr 的内联展开容器。
 * 用于内联确认条 / OCR 数据透视等原位展开面板，替代模态浮层。
 */
const InlineExpand: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className
      )}
    >
      <div className="overflow-hidden min-h-0">{children}</div>
    </div>
  );
};

// ============================================================================
// 进行中进度条的 shimmer 高光（对齐 Notion/Cursor 索引进行中的质感）
// ============================================================================

const SHIMMER_KEYFRAMES = '@keyframes idx-status-shimmer { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }';

const ProgressShimmer: React.FC = () => (
  <span
    aria-hidden
    className="pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/50 to-transparent dark:via-white/20 motion-reduce:hidden"
    style={{ animation: 'idx-status-shimmer 1.8s cubic-bezier(0.22,1,0.36,1) infinite' }}
  />
);

/** 每次拉取的资源条数：与"加载更多"分页保持一致 */
const PAGE_SIZE = 200;

/** 一键索引全量拉取待索引资源时的分页上限（PAGE_SIZE * 25 = 5000 条兜底保护） */
const MM_FETCH_MAX_PAGES = 25;

/**
 * 判断资源是否为「待多模态索引」候选。
 * 与后端 mm 统计口径一致：支持 MM 的类型 + 有预览 + 未 indexed/disabled。
 */
const isMmIndexCandidate = (r: ResourceIndexStatus): boolean => {
  const isMmType = r.resourceType === 'textbook' || r.resourceType === 'exam' || r.resourceType === 'image' || r.resourceType === 'file';
  const hasPreview = r.resourceType !== 'file' || r.hasOcr;
  return isMmType && hasPreview && r.mmIndexState !== 'indexed' && r.mmIndexState !== 'disabled';
};

// ============================================================================
// 首屏加载骨架（对齐 Notion：结构先行，内容渐显）
// ============================================================================

const IndexStatusSkeleton: React.FC = () => (
  <div className="flex flex-col flex-1 min-h-0 bg-background" aria-hidden>
    {/* 头部概览骨架 */}
    <div className="flex items-center gap-5 px-4 lg:px-5 py-4 border-b border-black/[0.06] dark:border-white/[0.08]">
      <Skeleton className="h-20 w-20 shrink-0 rounded-full" />
      <div className="flex-1 min-w-0 grid gap-3">
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-24 rounded-full" />
          <Skeleton className="h-7 w-24 rounded-full" />
        </div>
      </div>
      <div className="flex flex-col gap-2 shrink-0 min-w-[148px]">
        <Skeleton className="h-8 rounded-lg" />
        <Skeleton className="h-8 rounded-lg" />
      </div>
    </div>
    {/* 列表骨架 */}
    <div className="flex-1 min-h-0 overflow-hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-black/[0.04] dark:border-white/[0.06]">
          <Skeleton className="h-5 w-16 rounded-md" />
          <Skeleton className="h-4 flex-1 max-w-[40%]" />
          <Skeleton className="ml-auto h-5 w-16 rounded-md" />
        </div>
      ))}
    </div>
  </div>
);

// ============================================================================
// 组件
// ============================================================================

export const IndexStatusView: React.FC = () => {
  const { t } = useTranslation(['learningHub', 'common']);
  const isMobile = useIsMobile();

  // ========== 状态 ==========
  const [summary, setSummary] = useState<IndexStatusSummary | null>(null);
  const [dimensions, setDimensions] = useState<VfsEmbeddingDimension[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedState, setSelectedState] = useState<IndexState | 'all'>('all');
  const [selectedType, setSelectedType] = useState<string | 'all'>('all');
  const [reindexingIds, setReindexingIds] = useState<Set<string>>(new Set());

  // ========== 列表分页（每页 PAGE_SIZE 条，头部计数为全量） ==========
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // ========== 内联确认条 ==========
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [retryFailedConfirmOpen, setRetryFailedConfirmOpen] = useState(false);
  const [retryingFailed, setRetryingFailed] = useState(false);

  // ========== 召回测试状态 ==========
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [testQuery, setTestQuery] = useState('');
  const [testResults, setTestResults] = useState<VfsSearchResult[]>([]);
  const [testLoading, setTestLoading] = useState(false);
  const [testElapsedMs, setTestElapsedMs] = useState<number | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  // 召回测试模式：text 走 vfs_rag_search（纯文本路线），multimodal 走统一检索器（含 MM 路由）
  const [testMode, setTestMode] = useState<'text' | 'multimodal'>('text');
  // 多模态测试时逐路由失败信息（部分路由失败仍可能有结果）
  const [testRouteFailures, setTestRouteFailures] = useState<string[]>([]);

  // ========== 批量索引进度状态 ==========
  const [batchIndexing, setBatchIndexing] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchMessage, setBatchMessage] = useState('');
  const [batchCurrent, setBatchCurrent] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);

  // ========== 数据透视状态 ==========
  const [inspectingResourceId, setInspectingResourceId] = useState<string | null>(null);
  const [inspectMode, setInspectMode] = useState<'ocr' | 'chunks' | null>(null);
  const [ocrInfo, setOcrInfo] = useState<ResourceOcrInfo | null>(null);
  const [textChunks, setTextChunks] = useState<TextChunkInfo[]>([]);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [clearingOcr, setClearingOcr] = useState(false);

  // ========== 原生多模态索引状态 ==========
  const [mmIndexing, setMmIndexing] = useState(false);
  const [mmProgress, setMmProgress] = useState(0);
  const [mmMessage, setMmMessage] = useState('');
  // 单资源 MM 重试进行中的资源 ID 集合
  const [mmRetryingIds, setMmRetryingIds] = useState<Set<string>>(new Set());

  /**
   * 一键索引 MM 批次的聚合进度状态（用 ref 避免事件回调闭包过期）。
   * pLimit 并发下多个资源同时上报 mm_index_progress，聚合口径为：
   * (已完成资源数 + Σ进行中资源百分比/100) / 总数。
   */
  const mmBatchRef = useRef<{
    active: boolean;
    total: number;
    finished: number;
    /** sourceId -> 当前资源进度百分比 */
    current: Map<string, number>;
  } | null>(null);

  const computeMmBatchAggregate = useCallback((): number => {
    const s = mmBatchRef.current;
    if (!s || s.total === 0) return 0;
    let fraction = s.finished;
    for (const percent of s.current.values()) {
      fraction += Math.min(Math.max(percent, 0), 100) / 100;
    }
    return Math.round(Math.min(fraction / s.total, 1) * 100);
  }, []);

  // ========== 加载数据 ==========
  // 使用 ref 跟踪请求版本，避免竞态条件
  const requestIdRef = useRef(0);

  const loadData = useCallback(async () => {
    const currentRequestId = ++requestIdRef.current;
    debugLog.log('[IndexStatusView] loadData 开始', {
      requestId: currentRequestId,
      selectedState,
      selectedType,
    });
    setIsLoading(true);
    setError(null);

    try {
      // ★ 2026-02 修复：移除自动 resetDisabledToPending
      // 之前"刷新"会静默重置用户主动禁用的资源，违反用户意图
      // disabled 资源的重置现在需要用户通过"重置状态"按钮显式操作

      const [data, dims] = await Promise.all([
        getAllIndexStatus({
          stateFilter: selectedState === 'all' ? undefined : selectedState,
          resourceType: selectedType === 'all' ? undefined : selectedType,
          limit: PAGE_SIZE,
        }),
        listDimensions(),
      ]);
      
      debugLog.log('[IndexStatusView] API 返回', {
        requestId: currentRequestId,
        latestRequestId: requestIdRef.current,
        totalResources: data.totalResources,
        indexedCount: data.indexedCount,
        pendingCount: data.pendingCount,
        resourcesLength: data.resources.length,
        dimensionsCount: dims.length,
      });
      
      // 检查是否是最新请求，避免旧请求覆盖新数据
      if (currentRequestId !== requestIdRef.current) {
        debugLog.log('[IndexStatusView] 忽略过时的请求结果', currentRequestId, '!=', requestIdRef.current);
        return;
      }
      
      setSummary(data);
      setDimensions(dims);
      // 满页说明后端可能还有更多条目（头部统计为全量，列表为分页）
      setHasMore(data.resources.length >= PAGE_SIZE);
    } catch (err: unknown) {
      // 检查是否是最新请求
      if (currentRequestId !== requestIdRef.current) {
        return;
      }
      // ★ 2026-02 修复：错误信息增加可操作指引
      const errorMsg = err instanceof Error 
        ? err.message 
        : typeof err === 'string' 
          ? err 
          : JSON.stringify(err);
      debugLog.error('[IndexStatusView] 加载失败:', err);
      setError(errorMsg || t('indexStatus.notification.unknownError'));
    } finally {
      // 只有最新请求才更新 loading 状态
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
    }
  }, [selectedState, selectedType, t]);

  useEffect(() => {
    loadData();
    // 组件卸载时增加请求 ID，使进行中的请求被忽略
    return () => {
      requestIdRef.current++;
    };
  }, [loadData]);

  // ★ 2026-02 修复：组件卸载保护 ref，防止 setTimeout 在卸载后触发 setState
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ★ 修复：事件监听器中读取最新 summary，避免闭包捕获过期数据导致资源名解析失败
  const summaryRef = useRef<IndexStatusSummary | null>(null);
  useEffect(() => {
    summaryRef.current = summary;
  }, [summary]);

  // ★ 通过 ref 调用最新 loadData：事件监听只订阅一次，
  // 不再随筛选条件变化反复注销/重建（消除订阅间隙丢事件的窗口）
  const loadDataRef = useRef(loadData);
  useEffect(() => {
    loadDataRef.current = loadData;
  }, [loadData]);

  // 批量索引期间节流刷新列表，缩小长任务过程中列表数据的过期窗口
  const lastListRefreshRef = useRef(0);
  const throttledListRefresh = useCallback(() => {
    const now = Date.now();
    if (now - lastListRefreshRef.current < 4000) return;
    lastListRefreshRef.current = now;
    loadDataRef.current();
  }, []);

  // ========== 监听后端索引进度事件 ==========
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    // ★ 修复：listen() 是异步的，若 effect 在其 resolve 前被清理，
    // 需在 resolve 后立即注销，避免监听器泄漏（筛选变化会重建此 effect）
    let cancelled = false;

    const setupListener = async () => {
      const fn = await listen<{
        type: string;
        resourceId?: string;
        progress?: number;
        message?: string;
        current?: number;
        total?: number;
        successCount?: number;
        failCount?: number;
        chunksProcessed?: number;
        chunksTotal?: number;
        // ★ 2026-02-19：auto_ocr 事件字段
        fileId?: string;
        totalPages?: number;
        currentPage?: number;
        percent?: number;
        textLength?: number;
        success?: boolean;
      }>('vfs-index-progress', (event) => {
        const payload = event.payload;
        debugLog.log('[IndexStatusView] vfs-index-progress event:', payload);

        // 事件携带 current/total 时同步细粒度计数（Cursor 式「正在索引 N/M」）
        const syncBatchCounter = () => {
          if (typeof payload.current === 'number') setBatchCurrent(payload.current);
          if (typeof payload.total === 'number') setBatchTotal(payload.total);
        };

        switch (payload.type) {
          case 'batch_started':
            setBatchIndexing(true);
            setBatchProgress(0);
            setBatchCurrent(0);
            setBatchTotal(typeof payload.total === 'number' ? payload.total : 0);
            setBatchMessage(payload.message || t('indexStatus.notification.batchStarting'));
            break;
          case 'resource_started':
            setBatchProgress(Math.round(payload.progress || 0));
            setBatchMessage(payload.message || '');
            syncBatchCounter();
            break;
          case 'resource_completed':
          case 'resource_failed':
            setBatchProgress(Math.round(payload.progress || 0));
            setBatchMessage(payload.message || '');
            syncBatchCounter();
            // 长批量任务过程中节流刷新列表，让分组计数/状态徽章跟随进度更新
            throttledListRefresh();
            break;
          // ★ 嵌入批次级细粒度进度（每 16 块回调一次）
          case 'embedding_progress':
            setBatchProgress(Math.round(payload.progress || 0));
            setBatchMessage(payload.message || '');
            break;
          // ★ 2026-02-19：自动 OCR 细粒度进度事件
          case 'auto_ocr_started':
            setBatchMessage(payload.message || t('indexStatus.notification.autoOcrStarting', { pages: payload.totalPages ?? '?' }));
            break;
          case 'auto_ocr_page':
            setBatchMessage(payload.message || t('indexStatus.notification.autoOcrPage', { current: payload.currentPage ?? '?', total: payload.totalPages ?? '?' }));
            break;
          case 'auto_ocr_completed':
            setBatchMessage(payload.message || t('indexStatus.notification.autoOcrCompleted'));
            break;
          case 'batch_completed':
            setBatchIndexing(false);
            setBatchProgress(100);
            setBatchMessage(payload.message || t('indexStatus.notification.batchCompleted'));
            showGlobalNotification('success', t('indexStatus.notification.batchCompleted'), t('indexStatus.notification.batchCompletedDetail', { success: payload.successCount, fail: payload.failCount }));
            lastListRefreshRef.current = Date.now();
            loadDataRef.current(); // 刷新列表
            // ★ 2026-02 修复：setTimeout 添加卸载保护
            setTimeout(() => {
              if (!mountedRef.current) return;
              setBatchProgress(0);
              setBatchMessage('');
              setBatchCurrent(0);
              setBatchTotal(0);
            }, 2000);
            break;
          case 'started':
          case 'completed':
          case 'failed':
            // 单个资源索引事件
            if (payload.type === 'completed') {
              loadDataRef.current();
            }
            break;
        }
      });
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
    // 通过 loadDataRef 调用最新 loadData，订阅只随语言变化重建
  }, [t, throttledListRefresh]);

  // ========== 监听原生多模态索引进度事件 ==========
  // 仅在当前构建包含多模态索引能力时监听进度事件。
  useEffect(() => {
    if (!MULTIMODAL_INDEX_SUPPORTED) return;

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    const setupListener = async () => {
      const resolveResourceLabel = (payload: { sourceId: string }) => {
        // 通过 ref 读取最新 summary，避免闭包捕获过期数据
        const current = summaryRef.current;
        if (!current?.resources?.length) {
          return payload.sourceId;
        }

        const matched = current.resources.find((resource) =>
          resource.resourceId === payload.sourceId || resource.sourceId === payload.sourceId
        );

        return matched?.name || matched?.resourceId || payload.sourceId;
      };

      const fn = await listen<{
        sourceType: string;
        sourceId: string;
        phase: string;
        currentPage: number;
        totalPages: number;
        indexedPages: number;
        skippedPages: number;
        progressPercent: number;
        message: string;
      }>('mm_index_progress', (event) => {
        const payload = event.payload;
        debugLog.log('[IndexStatusView] mm_index_progress event:', payload);

        const resourceLabel = resolveResourceLabel(payload);
        const prefix = resourceLabel ? `${resourceLabel} · ` : '';

        // 根据不同阶段显示不同的进度信息
        let displayMessage = '';
        switch (payload.phase) {
          case 'preparing':
            displayMessage = t('indexStatus.mmProgress.preparing', { prefix, pages: payload.totalPages });
            break;
          case 'summarizing':
            // VL 摘要生成阶段 - 显示详细的每页进度
            displayMessage = t('indexStatus.mmProgress.vlSummary', { prefix, indexed: payload.indexedPages, total: payload.totalPages, current: payload.currentPage });
            break;
          case 'text_embedding':
            // 文本嵌入阶段
            displayMessage = t('indexStatus.mmProgress.textEmbedding', { prefix, indexed: payload.indexedPages, total: payload.totalPages });
            break;
          case 'embedding':
            // 通用嵌入阶段
            displayMessage = t('indexStatus.mmProgress.embedding', { prefix, indexed: payload.indexedPages, total: payload.totalPages });
            break;
          case 'saving':
            displayMessage = t('indexStatus.mmProgress.saving', { prefix, indexed: payload.indexedPages, total: payload.totalPages });
            break;
          case 'completed':
            displayMessage = t('indexStatus.mmProgress.completed', { prefix, indexed: payload.indexedPages, skipped: payload.skippedPages });
            break;
          case 'failed':
            displayMessage = t('indexStatus.mmProgress.failed', { prefix, message: payload.message });
            break;
          default:
            displayMessage = payload.message;
        }

        // 更新原生多模态索引进度
        const batchState = mmBatchRef.current;
        if (batchState?.active) {
          // ★ 一键索引批次：并发资源共享一条进度条，改为聚合口径而非互相覆盖
          if (payload.phase === 'completed' || payload.phase === 'failed') {
            batchState.current.delete(payload.sourceId);
          } else {
            batchState.current.set(payload.sourceId, payload.progressPercent);
          }
          setMmProgress(computeMmBatchAggregate());
          setMmMessage(
            `${t('indexStatus.progress.mmResourceProgress', { finished: batchState.finished, total: batchState.total })} · ${displayMessage}`
          );
        } else {
          setMmProgress(Math.round(payload.progressPercent));
          setMmMessage(displayMessage);
        }

        if (payload.phase === 'completed') {
          // ★ 2026-02 修复：setTimeout 添加卸载保护
          setTimeout(() => {
            if (!mountedRef.current) return;
            loadDataRef.current();
          }, 500);
        } else if (payload.phase === 'failed') {
          showGlobalNotification('error', t('indexStatus.notification.mmIndexFailed'), payload.message);
        }

        // ★ 外部触发（非一键索引批次）的索引结束后清理进度条，
        // 否则 completed/failed 的终态消息会永久残留（对齐 MiniBar 的清理逻辑）
        if (!batchState?.active && (payload.phase === 'completed' || payload.phase === 'failed')) {
          setTimeout(() => {
            if (!mountedRef.current) return;
            // 批次可能在延迟期间启动，避免误清批次进度
            if (mmBatchRef.current?.active) return;
            setMmProgress(0);
            setMmMessage('');
          }, 1600);
        }
      });
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    };

    setupListener();

    return () => {
      cancelled = true;
      if (unlisten) {
        unlisten();
      }
    };
    // 通过 loadDataRef 调用最新 loadData，订阅只随语言变化重建
  }, [t, computeMmBatchAggregate]);

  // ========== 重新索引 ==========
  const handleReindex = useCallback(async (resourceId: string) => {
    setReindexingIds((prev) => new Set(prev).add(resourceId));

    try {
      const chunks = await reindexResource(resourceId);
      showGlobalNotification('success', t('indexStatus.notification.indexSuccess'), t('indexStatus.notification.indexSuccessDetail', { chunks }));
      loadData(); // 刷新列表
    } catch (err: unknown) {
      debugLog.error('[IndexStatusView] reindex failed:', { resourceId, error: err });
      showGlobalNotification('error', t('indexStatus.notification.indexFailed'), err instanceof Error ? err.message : t('indexStatus.notification.unknownError'));
    } finally {
      setReindexingIds((prev) => {
        const next = new Set(prev);
        next.delete(resourceId);
        return next;
      });
    }
  }, [loadData, t]);

  // ========== 单资源多模态索引重试（失败态行内操作） ==========
  const handleRetryMmIndex = useCallback(async (resource: ResourceIndexStatus) => {
    const sourceId = resource.sourceId || resource.resourceId;
    const sourceType: MMSourceType = resource.resourceType === 'image' ? 'image' : resource.resourceType as MMSourceType;
    setMmRetryingIds((prev) => new Set(prev).add(resource.resourceId));
    try {
      const result = await multimodalRagService.vfsIndexResourceBySource(sourceType, sourceId, undefined, false);
      showGlobalNotification('success', t('indexStatus.notification.mmRetrySuccess', { pages: result.indexedPages }));
      loadData();
    } catch (err: unknown) {
      debugLog.error('[IndexStatusView] retry mm index failed:', { resourceId: resource.resourceId, error: err });
      showGlobalNotification('error', t('indexStatus.notification.mmIndexFailed'), err instanceof Error ? err.message : t('indexStatus.notification.unknownError'));
    } finally {
      setMmRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(resource.resourceId);
        return next;
      });
    }
  }, [loadData, t]);

  // ========== 加载更多（分页拉取，头部计数为全量，列表分页展示） ==========
  const handleLoadMore = useCallback(async () => {
    if (!summary || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await getAllIndexStatus({
        stateFilter: selectedState === 'all' ? undefined : selectedState,
        resourceType: selectedType === 'all' ? undefined : selectedType,
        limit: PAGE_SIZE,
        offset: summary.resources.length,
      });
      setHasMore(more.resources.length >= PAGE_SIZE);
      setSummary((prev) => {
        if (!prev) return more;
        // 去重追加：批量索引过程中列表可能被节流刷新，避免重复行
        const seen = new Set(prev.resources.map((r) => r.resourceId));
        const appended = more.resources.filter((r) => !seen.has(r.resourceId));
        return { ...prev, resources: [...prev.resources, ...appended] };
      });
    } catch (err: unknown) {
      showGlobalNotification('error', t('indexStatus.notification.unknownError'), err instanceof Error ? err.message : undefined);
    } finally {
      setLoadingMore(false);
    }
  }, [summary, loadingMore, selectedState, selectedType, t]);

  // ========== 数据透视：查看 OCR（内联 toggle，与文本块查看一致） ==========
  const handleInspectOcr = useCallback(async (resourceId: string) => {
    if (inspectingResourceId === resourceId && inspectMode === 'ocr') {
      setInspectMode(null);
      setInspectingResourceId(null);
      setOcrInfo(null);
      return;
    }
    setInspectingResourceId(resourceId);
    setInspectMode('ocr');
    setOcrInfo(null);
    setInspectLoading(true);
    try {
      const info = await getResourceOcrInfo(resourceId);
      setOcrInfo(info);
    } catch (err: unknown) {
      debugLog.error('[IndexStatusView] getResourceOcrInfo failed:', err);
      showGlobalNotification('error', t('indexStatus.notification.getOcrInfoFailed'), err instanceof Error ? err.message : t('indexStatus.notification.unknownError'));
      setInspectMode(null);
      setInspectingResourceId(null);
    } finally {
      setInspectLoading(false);
    }
  }, [inspectingResourceId, inspectMode, t]);

  // ========== 数据透视：查看文本块（内联 toggle） ==========
  const handleInspectChunks = useCallback(async (resourceId: string) => {
    if (inspectingResourceId === resourceId && inspectMode === 'chunks') {
      setInspectMode(null);
      setInspectingResourceId(null);
      setTextChunks([]);
      return;
    }
    setInspectingResourceId(resourceId);
    setInspectMode('chunks');
    setInspectLoading(true);
    try {
      const chunks = await getResourceTextChunks(resourceId);
      setTextChunks(chunks);
    } catch (err: unknown) {
      debugLog.error('[IndexStatusView] getResourceTextChunks failed:', err);
      showGlobalNotification('error', t('indexStatus.notification.getChunksFailed'), err instanceof Error ? err.message : t('indexStatus.notification.unknownError'));
      setInspectMode(null);
      setInspectingResourceId(null);
    } finally {
      setInspectLoading(false);
    }
  }, [inspectingResourceId, inspectMode, t]);

  // ========== 数据透视：清除 OCR 并重做 ==========
  const handleClearOcrAndReindex = useCallback(async (resourceId: string) => {
    setClearingOcr(true);
    try {
      await clearResourceOcr(resourceId);
      showGlobalNotification('info', t('indexStatus.notification.ocrClearedReindexing'));
      setInspectMode(null);
      setInspectingResourceId(null);
      setOcrInfo(null);
      try {
        await reindexResource(resourceId);
        showGlobalNotification('success', t('indexStatus.notification.ocrReindexComplete'));
      } catch (reindexErr: unknown) {
        debugLog.error('[IndexStatusView] reindex after OCR clear failed:', reindexErr);
        showGlobalNotification('warning', t('indexStatus.notification.ocrClearedButReindexFailed'));
      }
      loadData();
    } catch (err: unknown) {
      debugLog.error('[IndexStatusView] clearResourceOcr failed:', err);
      showGlobalNotification('error', t('indexStatus.notification.clearOcrFailed'), err instanceof Error ? err.message : t('indexStatus.notification.unknownError'));
    } finally {
      setClearingOcr(false);
    }
  }, [loadData, t]);

  const closeInspectPanel = useCallback(() => {
    setInspectMode(null);
    setInspectingResourceId(null);
    setOcrInfo(null);
    setTextChunks([]);
  }, []);

  // ========== 一键索引（执行 OCR 文本索引，多模态索引仅在启用时执行）==========
  const handleUnifiedIndex = useCallback(async () => {
    if (!summary) return;
    if (batchIndexing || mmIndexing) {
      showGlobalNotification('warning', t('indexStatus.notification.pleaseWait'), t('indexStatus.notification.indexInProgress'));
      return;
    }

    // 检查是否有需要索引的资源。
    // ★ 修复：MM 待索引数改用全量统计（mmPendingCount 等），
    // 不再依赖当前分页 summary.resources（第二页以后的待索引资源会被漏掉）
    const pendingTextCount = summary.pendingCount + summary.failedCount;
    const mmPendingTotal = MULTIMODAL_INDEX_SUPPORTED
      ? summary.mmPendingCount + summary.mmFailedCount + summary.mmIndexingCount
      : 0;

    if (pendingTextCount === 0 && mmPendingTotal === 0) {
      showGlobalNotification('info', t('indexStatus.notification.hint'), t('indexStatus.notification.allIndexed'));
      return;
    }

    // 先执行 OCR 文本索引
    if (pendingTextCount > 0) {
      setBatchIndexing(true);
      setBatchProgress(0);
      setBatchMessage(t('indexStatus.notification.preparingOcrBatch'));
      let batchFailed = false;
      try {
        await batchIndexPending(pendingTextCount);
      } catch (err: unknown) {
        debugLog.error('[IndexStatusView] OCR 文本索引失败:', err);
        batchFailed = true;
        // ★ 2026-02 修复：错误信息增加可操作指引
        const errMsg = err instanceof Error ? err.message : t('indexStatus.notification.unknownError');
        const actionHint = errMsg.includes('embedding') || errMsg.includes('嵌入')
          ? t('indexStatus.notification.checkEmbeddingModel')
          : errMsg.includes('network') || errMsg.includes('网络')
            ? t('indexStatus.notification.checkNetwork')
            : '';
        showGlobalNotification('error', t('indexStatus.notification.ocrBatchFailed'), actionHint ? `${errMsg}\n${actionHint}` : errMsg);
      } finally {
        // ★ 修复：成功路径也同步清理 batchIndexing，
        // 不再只依赖 batch_completed 事件（事件丢失会让一键索引按钮永久禁用）
        setBatchIndexing(false);
        if (batchFailed) {
          setBatchProgress(0);
          setBatchMessage('');
        } else {
          setBatchProgress(100);
          setTimeout(() => {
            if (!mountedRef.current) return;
            setBatchProgress(0);
            setBatchMessage('');
            setBatchCurrent(0);
            setBatchTotal(0);
          }, 2000);
        }
      }
    }

    // 然后执行原生多模态索引。
    if (mmPendingTotal > 0) {
      setMmIndexing(true);
      setMmProgress(0);
      setMmMessage(t('indexStatus.notification.mmIndexStarting', { count: mmPendingTotal }));

      // ★ 修复：按全量口径分页循环拉取待索引资源列表
      let mmResources: ResourceIndexStatus[] = [];
      try {
        let offset = 0;
        for (let page = 0; page < MM_FETCH_MAX_PAGES; page++) {
          const data = await getAllIndexStatus({ limit: PAGE_SIZE, offset });
          mmResources = mmResources.concat(data.resources.filter(isMmIndexCandidate));
          if (data.resources.length < PAGE_SIZE) break;
          offset += data.resources.length;
        }
      } catch (err: unknown) {
        setMmIndexing(false);
        setMmProgress(0);
        setMmMessage('');
        showGlobalNotification('error', t('indexStatus.notification.mmIndexFailed'), err instanceof Error ? err.message : String(err));
        return;
      }

      if (mmResources.length === 0) {
        setMmIndexing(false);
        setMmProgress(0);
        setMmMessage('');
        showGlobalNotification('info', t('indexStatus.notification.hint'), t('indexStatus.notification.noMmResources'));
        return;
      }

      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0;
      const total = mmResources.length;
      // ★ 修复：pLimit(3) 并发下的进度改为聚合口径（完成资源数 + 进行中资源百分比）
      mmBatchRef.current = { active: true, total, finished: 0, current: new Map() };
      const limit = pLimit(3);

      const settleOne = () => {
        const s = mmBatchRef.current;
        if (!s) return;
        s.finished += 1;
        setMmProgress(computeMmBatchAggregate());
      };

      await Promise.all(mmResources.map((resource) =>
        limit(async () => {
          const sourceType: MMSourceType = resource.resourceType === 'image' ? 'image' : resource.resourceType as MMSourceType;
          const sourceId = resource.sourceId || resource.resourceId;

          if (!sourceId) {
            debugLog.warn('[IndexStatusView] 资源缺少 sourceId，跳过索引:', resource.resourceId);
            skippedCount++;
            settleOne();
            return;
          }

          try {
            await multimodalRagService.vfsIndexResourceBySource(sourceType, sourceId, undefined, false);
            successCount++;
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            showGlobalNotification('error', t('indexStatus.notification.indexFailed'), `${resource.name || sourceId}: ${errMsg}`);
            failCount++;
          }
          mmBatchRef.current?.current.delete(sourceId);
          settleOne();
        })
      ));

      mmBatchRef.current = null;
      setMmIndexing(false);
      setMmProgress(100);
      const resultMsg = failCount > 0
        ? t('indexStatus.notification.mmIndexCompletedWithFail', { success: successCount, fail: failCount })
        : t('indexStatus.notification.mmIndexCompletedSuccess', { count: successCount });
      setMmMessage(resultMsg);

      if (skippedCount > 0) {
        showGlobalNotification('warning', t('indexStatus.notification.skippedNoSourceId', { count: skippedCount }));
      }

      // ★ 2026-02 修复：setTimeout 添加卸载保护
      setTimeout(() => {
        if (!mountedRef.current) return;
        setMmProgress(0);
        setMmMessage('');
        loadData();
      }, 2000);
    }
  }, [summary, batchIndexing, mmIndexing, computeMmBatchAggregate, loadData, t]);

  // ★ 2026-07：删除死代码 handleReindexAll / handleMultimodalIndex。
  // 两者从未绑定 UI，且 handleMultimodalIndex 不过滤 mmIndexState==='indexed'，
  // 会对已索引资源重复消耗 API。「一键索引」（handleUnifiedIndex）已覆盖
  // 文本批量 + 多模态批量两条链路，并带 indexed/disabled 过滤。

  // ========== 重置所有索引状态 ==========
  const [resetting, setResetting] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const mobileMoreRef = useRef<HTMLDivElement>(null);

  // ========== 窄容器检测（头部紧凑布局） ==========
  // useIsMobile 基于视口宽度，但学习中心侧边栏会压缩内容区，
  // 视口未达移动端断点时容器仍可能很窄（如小窗口），故按容器宽度切换。
  const [isNarrowContainer, setIsNarrowContainer] = useState(false);
  const containerObserverRef = useRef<ResizeObserver | null>(null);
  const rootContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerObserverRef.current?.disconnect();
    containerObserverRef.current = null;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setIsNarrowContainer(width > 0 && width < COMPACT_HEADER_BREAKPOINT);
    });
    observer.observe(node);
    containerObserverRef.current = observer;
  }, []);
  useEffect(() => () => containerObserverRef.current?.disconnect(), []);
  /** 头部概览区是否使用紧凑布局：移动端 或 窄容器桌面窗口 */
  const useCompactHeader = isMobile || isNarrowContainer;

  useEffect(() => {
    if (!mobileMoreOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mobileMoreRef.current && !mobileMoreRef.current.contains(e.target as Node)) {
        setMobileMoreOpen(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMoreOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [mobileMoreOpen]);
  
  // 打开/收起重置内联确认条（替代阻塞式对话框）
  const toggleResetConfirm = useCallback(() => {
    if (resetting) return;
    if (batchIndexing || mmIndexing) {
      showGlobalNotification('warning', t('indexStatus.notification.pleaseWait'), t('indexStatus.notification.waitForCurrent'));
      return;
    }
    setResetConfirmOpen((v) => !v);
  }, [resetting, batchIndexing, mmIndexing, t]);

  const handleResetAllIndexState = useCallback(async () => {
    if (resetting || batchIndexing || mmIndexing) {
      showGlobalNotification('warning', t('indexStatus.notification.pleaseWait'), t('indexStatus.notification.waitForCurrent'));
      return;
    }

    setResetConfirmOpen(false);
    setResetting(true);

    try {
      const count = await resetAllIndexState();
      showGlobalNotification('success', t('indexStatus.notification.resetSuccess'), t('indexStatus.notification.resetSuccessDetail', { count }));
      loadData();
    } catch (err: unknown) {
      showGlobalNotification('error', t('indexStatus.notification.resetFailed'), err instanceof Error ? err.message : t('indexStatus.notification.unknownError'));
    } finally {
      setResetting(false);
    }
  }, [resetting, batchIndexing, mmIndexing, loadData, t]);

  // ========== 重试全部失败项（内联确认条触发） ==========
  const failedResources = useMemo(
    () => summary?.resources.filter((r) => (r.textIndexState as IndexState) === 'failed') ?? [],
    [summary]
  );

  const handleRetryAllFailed = useCallback(async () => {
    if (retryingFailed || batchIndexing || mmIndexing) return;
    const targets = failedResources;
    setRetryFailedConfirmOpen(false);
    if (targets.length === 0) return;

    setRetryingFailed(true);
    setReindexingIds((prev) => {
      const next = new Set(prev);
      targets.forEach((r) => next.add(r.resourceId));
      return next;
    });

    let success = 0;
    let fail = 0;
    const limit = pLimit(2);
    await Promise.all(targets.map((resource) =>
      limit(async () => {
        try {
          await reindexResource(resource.resourceId);
          success++;
        } catch (err: unknown) {
          fail++;
          debugLog.error('[IndexStatusView] retry failed resource error:', { resourceId: resource.resourceId, error: err });
        }
      })
    ));

    setReindexingIds((prev) => {
      const next = new Set(prev);
      targets.forEach((r) => next.delete(r.resourceId));
      return next;
    });
    setRetryingFailed(false);
    showGlobalNotification(
      fail > 0 ? 'warning' : 'success',
      t('indexStatus.list.retrySummary', { success, fail })
    );
    loadData();
  }, [retryingFailed, batchIndexing, mmIndexing, failedResources, loadData, t]);

  // ========== 召回测试 ==========
  const handleTestSearch = useCallback(async () => {
    if (!testQuery.trim()) {
      showGlobalNotification('warning', t('indexStatus.notification.hint'), t('indexStatus.notification.enterTestQuery'));
      return;
    }

    setTestLoading(true);
    setTestError(null);
    setTestResults([]);
    setTestElapsedMs(null);
    setTestRouteFailures([]);

    debugLog.info('[IndexStatusView] 召回测试开始', { queryLength: testQuery.length, mode: testMode });

    try {
      if (testMode === 'multimodal' && MULTIMODAL_INDEX_SUPPORTED) {
        // ★ 多模态模式：走统一检索器（含 MM 路由），否则纯文本 API 测不到 MM 路线
        const startedAt = performance.now();
        const detailed = await multimodalRagService.vfsSearchDetailed({
          queryText: testQuery.trim(),
          topK: 10,
        });
        const elapsed = Math.round(performance.now() - startedAt);

        const mapped: VfsSearchResult[] = detailed.result.hits.map(({ hit, rrfScore }) => ({
          embeddingId: hit.embeddingId,
          resourceId: hit.identity.resourceId,
          chunkIndex: hit.identity.chunkIndex,
          chunkText: hit.text,
          score: rrfScore,
          resourceTitle: hit.title,
          resourceType: hit.resourceType,
          pageIndex: hit.identity.pageIndex,
          sourceId: hit.sourceId,
          blobHash: hit.blobHash,
        }));

        debugLog.info('[IndexStatusView] 多模态召回测试完成', {
          count: mapped.length,
          elapsedMs: elapsed,
          routeFailures: detailed.result.failures.length,
        });

        setTestResults(mapped);
        setTestElapsedMs(elapsed);
        setTestRouteFailures(detailed.result.failures.map((f) => `${f.routeId}: ${f.error}`));

        if (mapped.length === 0) {
          showGlobalNotification('info', t('indexStatus.notification.hint'), t('indexStatus.notification.noResults'));
        }
      } else {
        const result = await vfsRagSearch({
          query: testQuery.trim(),
          topK: 10,
          enableReranking: true,
        });

        debugLog.info('[IndexStatusView] 召回测试完成', {
          count: result.count,
          elapsedMs: result.elapsedMs,
        });

        setTestResults(result.results);
        setTestElapsedMs(result.elapsedMs);

        if (result.count === 0) {
          showGlobalNotification('info', t('indexStatus.notification.hint'), t('indexStatus.notification.noResults'));
        }
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      debugLog.error('[IndexStatusView] 召回测试失败', err);
      setTestError(errorMsg);
      showGlobalNotification('error', t('indexStatus.notification.recallTestFailed'), errorMsg);
    } finally {
      setTestLoading(false);
    }
  }, [testQuery, testMode, t]);

  // ========== 展开状态 ==========
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['pending', 'failed', 'indexing']));
  // 🆕 资源详情展开状态
  const [expandedResources, setExpandedResources] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  }, []);

  // 🆕 切换资源详情展开状态
  const toggleResourceExpand = useCallback((resourceId: string) => {
    setExpandedResources((prev) => {
      const next = new Set(prev);
      if (next.has(resourceId)) {
        next.delete(resourceId);
      } else {
        next.add(resourceId);
      }
      return next;
    });
  }, []);

  // ========== 计算分组数据 ==========
  const groupedResources = useMemo(() => {
    if (!summary) return {};
    
    const groups: Record<string, ResourceIndexStatus[]> = {
      pending: [],
      indexing: [],
      failed: [],
      indexed: [],
      disabled: [],
    };

    for (const resource of summary.resources) {
      const state = resource.textIndexState as IndexState;
      const effectiveState = resource.isStale && state === 'indexed' ? 'pending' : state;
      if (groups[effectiveState]) {
        groups[effectiveState].push(resource);
      } else {
        // ★ 2026-01 修复：未知状态放入 pending 组，避免资源丢失
        debugLog.warn(`[IndexStatusView] Unknown textIndexState: ${state}, resource: ${resource.resourceId}`);
        groups.pending.push(resource);
      }
    }

    return groups;
  }, [summary]);

  // ========== 计算进度百分比 ==========
  const progressPercentage = useMemo(() => {
    if (!summary || summary.totalResources === 0) return 0;
    return (summary.indexedCount / summary.totalResources) * 100;
  }, [summary]);

  /** 综合进度：当前构建支持时同时考虑文本和多模态索引。 */
  const overallProgressPercentage = useMemo(() => {
    if (!summary) return 0;
    if (!MULTIMODAL_INDEX_SUPPORTED) {
      if (summary.totalResources === 0) return 0;
      return (summary.indexedCount / summary.totalResources) * 100;
    }
    // 文本索引部分
    const textTotal = summary.totalResources;
    const textDone = summary.indexedCount;
    // 多模态索引部分（仅计算支持多模态的资源）
    const mmTotal = summary.mmTotalResources;
    const mmDone = summary.mmIndexedCount;
    // 综合进度 = (文本已完成 + 多模态已完成) / (文本总数 + 多模态总数)
    const totalTasks = textTotal + mmTotal;
    if (totalTasks === 0) return 0;
    return ((textDone + mmDone) / totalTasks) * 100;
  }, [summary]);

  // ========== 渲染状态徽章 ==========
  const renderStatBadge = (
    state: IndexState,
    count: number,
    isActive: boolean,
    onClick: () => void
  ) => {
    const config = STATE_CONFIG[state];
    const Icon = config.icon;
    
    return (
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={onClick}
        className={cn(
          '!h-7 !rounded-full !px-2.5 !py-0 text-[11px] font-medium gap-1.5 border border-transparent',
          'transition-[background-color,box-shadow,border-color] duration-150',
          config.bgColor,
          config.color,
          isActive
            ? 'ring-1 ring-black/5 dark:ring-white/10 shadow-sm border-black/5 dark:border-white/10'
            : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.06]'
        )}
      >
        <Icon className="h-3.5 w-3.5" weight={isActive ? 'fill' : 'regular'} />
        <span>{t(config.labelKey)}</span>
        <span className="tabular-nums opacity-80">{count}</span>
      </NotionButton>
    );
  };

  // ========== 渲染资源行 ==========
  const renderResourceRow = (resource: ResourceIndexStatus) => {
    const state = resource.textIndexState as IndexState;
    const stateConfig = STATE_CONFIG[state] || STATE_CONFIG.pending;
    const StateIcon = stateConfig.icon;
    const typeConfig = RESOURCE_TYPE_CONFIG[resource.resourceType] || RESOURCE_TYPE_CONFIG.file;
    const TypeIcon = typeConfig.icon;
    const isReindexing = reindexingIds.has(resource.resourceId);
    const isStale = resource.isStale;
    const isUnsupportedType = UNSUPPORTED_INDEX_TYPES.has(resource.resourceType);
    // 有 indexError 的资源也应该可以重新索引
    const hasIndexError = !!resource.textIndexError;
    // ★ 2026-02 修复：空内容判断使用结构化条件替代字符串硬编码匹配
    // indexed + 0 chunks + 有 error 信息 = 空内容已索引（后端标记为 indexed 但 error 记录原因）
    const isEmptyContent = hasIndexError && state === 'indexed' && resource.textChunkCount === 0;
    const needsReindex = !isUnsupportedType && (state === 'pending' || state === 'failed' || isStale || hasIndexError);
    // 教材/图片/文件显示文本提取或 OCR 状态
    const showOcrStatus = resource.resourceType === 'textbook' || resource.resourceType === 'image' || resource.resourceType === 'file';
    // 🆕 是否展开详情
    const isExpanded = expandedResources.has(resource.resourceId);

    // 智能显示名称：如果是资源ID则截短显示
    const displayName = resource.name.startsWith('res_') 
      ? resource.name.slice(0, 16) + '...' 
      : resource.name;

    return (
      <div key={resource.resourceId} className="group border-b border-black/[0.04] dark:border-white/[0.06] hover:bg-[var(--interactive-hover)] transition-colors">
        {/* 主行 - 可点击展开 */}
        <div
          className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-2.5 cursor-default select-none"
          onClick={() => toggleResourceExpand(resource.resourceId)}
        >
          {/* 🆕 展开/折叠指示器 */}
          <div className="w-4 flex-shrink-0 flex items-center justify-center text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
            {isExpanded ? (
              <CaretDown className="h-3.5 w-3.5" />
            ) : (
              <CaretRight className="h-3.5 w-3.5" />
            )}
          </div>

          {/* 资源类型标签 — macOS 标签风格 */}
          <div className={cn(
            'flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium flex-shrink-0',
            typeConfig.color
          )}>
            <TypeIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{t(typeConfig.labelKey)}</span>
          </div>

          {/* 资源名称 */}
          <div className="flex-1 min-w-0 grid gap-0.5">
            <div className="font-medium truncate text-ui leading-tight text-foreground/90" title={resource.name}>
              {displayName}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
              {resource.textChunkCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-muted/60">
                  {t('indexStatus.detail.chunks', { count: resource.textChunkCount })}
                </span>
              )}
              {resource.embeddingDim && (
                <span className="font-mono opacity-70">
                  d={resource.embeddingDim}
                </span>
              )}
              {resource.modality && MULTIMODAL_INDEX_SUPPORTED && (
                <span className={cn(
                  'px-1.5 rounded text-2xs border',
                  resource.modality === 'text' 
                    ? 'border-primary/20 text-primary bg-primary/5'
                    : resource.modality === 'multimodal'
                      ? 'border-violet-500/20 text-violet-600 bg-violet-500/5'
                      : 'border-success/20 text-success bg-success/5'
                )}>
                  {resource.modality === 'text' ? t('indexStatus.detail.modalityText') : resource.modality === 'multimodal' ? t('indexStatus.detail.modalityMultimodal') : t('indexStatus.detail.modalityTextAndMm')}
                </span>
              )}
            </div>
          </div>

          {/* 状态标签 - 有 indexError 的显示错误状态 */}
          <div 
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium border shrink-0 whitespace-nowrap',
              isUnsupportedType && state === 'pending' && 'bg-muted/50 text-muted-foreground border-transparent',
              !isUnsupportedType && hasIndexError && !isEmptyContent && 'bg-warning/10 text-warning border-warning/30',
              !isUnsupportedType && isEmptyContent && 'bg-warning/10 text-warning border-warning/30',
              !isUnsupportedType && !hasIndexError && isStale && 'bg-warning/10 text-warning border-warning/30',
              !isUnsupportedType && !hasIndexError && !isStale && state === 'indexed' && 'bg-success/10 text-success border-success/30',
              !isUnsupportedType && !hasIndexError && state === 'pending' && 'bg-warning/10 text-warning border-warning/30',
              state === 'indexing' && 'bg-info/10 text-info border-info/30',
              state === 'failed' && 'bg-danger/10 text-danger border-danger/30',
              state === 'disabled' && 'bg-muted/50 text-muted-foreground border-transparent'
            )}
            title={resource.textIndexError || undefined}
          >
            {isUnsupportedType && state === 'pending' ? (
              <>
                <Prohibit className="h-3.5 w-3.5" />
                <span>{t('indexStatus.detail.unsupported')}</span>
              </>
            ) : isEmptyContent ? (
              <>
                <Warning className="h-3.5 w-3.5" />
                <span>{t('indexStatus.detail.emptyContent')}</span>
              </>
            ) : hasIndexError ? (
              <>
                <WarningCircle className="h-3.5 w-3.5" />
                <span>{t('indexStatus.detail.indexError')}</span>
              </>
            ) : isStale ? (
              <>
                <Warning className="h-3.5 w-3.5" />
                <span>{t('indexStatus.detail.stale')}</span>
              </>
            ) : (
              <>
                <StateIcon className={cn('h-3.5 w-3.5', state === 'indexing' && 'animate-spin')} />
                <span>{t(stateConfig.labelKey)}</span>
              </>
            )}
          </div>

          {/* 操作按钮 - Notion 风格 */}
          <div className="flex-shrink-0 w-8 flex justify-end" onClick={(e) => e.stopPropagation()}>
            {needsReindex && (
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleReindex(resource.resourceId)} disabled={isReindexing} className="opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 hover:text-primary hover:bg-primary/10" title={isStale ? t('indexStatus.action.update') : t('indexStatus.action.reindex')} aria-label={isStale ? t('indexStatus.action.update') : t('indexStatus.action.reindex')}>
                {isReindexing ? (
                  <CircleNotch className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowsClockwise className="h-4 w-4" />
                )}
              </NotionButton>
            )}
          </div>
        </div>

        {/* 🆕 展开的详情区域 */}
        {isExpanded && (
          <div className="px-3 md:px-4 pb-3 md:pb-4 ml-6 md:ml-9 border-l border-black/[0.06] dark:border-white/[0.08] space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-6 text-xs">
              {/* OCR 状态 - 只对教材和图片显示 */}
              {showOcrStatus && (
                <div>
                  <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">
                    {resource.resourceType === 'file' ? t('indexStatus.detail.textStatus') : t('indexStatus.detail.ocrStatus')}
                  </div>
                  <div className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border',
                    resource.hasOcr
                      ? 'bg-success/5 text-success border-success/20'
                      : 'bg-muted/50 text-muted-foreground border-transparent'
                  )}>
                    {resource.hasOcr ? (
                      <>
                        <CheckCircle className="h-3 w-3" />
                        {resource.resourceType === 'textbook' 
                          ? t('indexStatus.detail.pages', { count: resource.ocrCount })
                          : t('indexStatus.detail.chars', { count: resource.ocrCount })}
                      </>
                    ) : (resource.resourceType === 'file' ? t('indexStatus.detail.noText') : t('indexStatus.detail.noOcr'))}
                  </div>
                </div>
              )}
              
              {/* 文本索引 - 双来源时分别显示 */}
              {resource.nativeTextChunkCount > 0 && resource.ocrTextChunkCount > 0 ? (
                <>
                  <div>
                    <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.extractedTextIndex')}</div>
                    <div className="font-semibold tabular-nums text-foreground/90">
                      <span className="text-primary">
                        {t('indexStatus.detail.chunks', { count: resource.nativeTextChunkCount })}
                        {resource.textEmbeddingDim && ` (${resource.textEmbeddingDim}D)`}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.ocrTextIndex')}</div>
                    <div className="font-semibold tabular-nums text-foreground/90">
                      <span className="text-teal-600 dark:text-teal-400">
                        {t('indexStatus.detail.chunks', { count: resource.ocrTextChunkCount })}
                        {resource.textEmbeddingDim && ` (${resource.textEmbeddingDim}D)`}
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <div>
                  <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">
                    {resource.ocrTextChunkCount > 0 || ['textbook', 'image'].includes(resource.resourceType)
                      ? t('indexStatus.detail.ocrTextIndex')
                      : t('indexStatus.detail.extractedTextIndex')}
                  </div>
                  <div className="font-semibold tabular-nums text-foreground/90">
                    {resource.textChunkCount > 0 ? (
                      <span className="text-primary">
                        {t('indexStatus.detail.chunks', { count: resource.textChunkCount })}
                        {resource.textEmbeddingDim && ` (${resource.textEmbeddingDim}D)`}
                      </span>
                    ) : '-'}
                  </div>
                </div>
              )}
              
              {/* 原生多模态索引状态 */}
              {MULTIMODAL_INDEX_SUPPORTED && (
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.nativeMmIndex')}</div>
                <div className="flex flex-col gap-1.5">
                  {/* 状态标签 */}
                  <div className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium w-fit border',
                    resource.mmIndexState === 'indexed' && 'bg-success/5 text-success border-success/20',
                    resource.mmIndexState === 'pending' && 'bg-warning/5 text-warning border-warning/20',
                    resource.mmIndexState === 'indexing' && 'bg-info/5 text-info border-info/20',
                    resource.mmIndexState === 'failed' && 'bg-danger/5 text-danger border-danger/20',
                    resource.mmIndexState === 'disabled' && 'bg-muted/50 text-muted-foreground border-transparent'
                  )}>
                    {resource.mmIndexState === 'indexed' && <CheckCircle className="h-3 w-3" />}
                    {resource.mmIndexState === 'pending' && <Clock className="h-3 w-3" />}
                    {resource.mmIndexState === 'indexing' && <ArrowsClockwise className="h-3 w-3 animate-spin" />}
                    {resource.mmIndexState === 'failed' && <WarningCircle className="h-3 w-3" />}
                    {resource.mmIndexState === 'disabled' && <Prohibit className="h-3 w-3" />}
                    {t(STATE_CONFIG[resource.mmIndexState as IndexState]?.labelKey || '') || resource.mmIndexState}
                  </div>
                  {/* 页数和维度 */}
                  {resource.mmIndexedPages > 0 && (
                    <span className="text-violet-600 dark:text-violet-400 font-semibold tabular-nums text-xs">
                      {t('indexStatus.detail.pages', { count: resource.mmIndexedPages })}
                      {resource.mmEmbeddingDim && ` (${resource.mmEmbeddingDim}D)`}
                    </span>
                  )}
                </div>
              </div>
              )}

              {/* 索引模式 */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.indexMode')}</div>
                <div className={cn(
                  'inline-flex px-2 py-1 rounded text-xs font-medium border',
                  MULTIMODAL_INDEX_SUPPORTED && resource.mmIndexingMode
                    ? 'bg-violet-500/5 text-violet-600 border-violet-500/20'
                    : resource.textChunkCount > 0
                      ? 'bg-primary/5 text-primary border-primary/20'
                      : 'text-muted-foreground bg-muted/50 border-transparent'
                )}>
                  {MULTIMODAL_INDEX_SUPPORTED && resource.mmIndexingMode
                    ? (resource.mmIndexingMode === 'vl_embedding' ? t('indexStatus.detail.modeVlEmbed') : t('indexStatus.detail.modeVlText'))
                    : resource.textChunkCount > 0
                      ? t('indexStatus.detail.pureText')
                      : t('indexStatus.detail.notIndexed')}
                </div>
              </div>
              
              {/* 资源 ID */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.resourceId')}</div>
                <div className="font-mono text-2xs text-muted-foreground bg-muted/50 px-2 py-1 rounded border border-border/30 truncate select-all" title={resource.resourceId}>
                  {resource.resourceId}
                </div>
              </div>
              
              {/* 索引时间 */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.indexTime')}</div>
                <div className="font-medium text-foreground/90">
                  {resource.textIndexedAt 
                    ? new Date(resource.textIndexedAt).toLocaleString(undefined, {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '-'
                  }
                </div>
              </div>
              
              {/* 更新时间 */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.updateTime')}</div>
                <div className="font-medium text-foreground/90">
                  {resource.updatedAt 
                    ? new Date(resource.updatedAt).toLocaleString(undefined, {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '-'
                  }
                </div>
              </div>
              
              {/* 过时状态 */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.status')}</div>
                <div className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border',
                  resource.isStale 
                    ? 'bg-warning/5 text-warning border-warning/20'
                    : state === 'indexed'
                      ? 'bg-success/5 text-success border-success/20'
                      : 'bg-muted/50 text-muted-foreground border-transparent'
                )}>
                  {resource.isStale ? (
                    <>
                      <Warning className="h-3 w-3" />
                      {t('indexStatus.detail.contentUpdated')}
                    </>
                  ) : state === 'indexed' ? (
                    <>
                      <CheckCircle className="h-3 w-3" />
                      {t('indexStatus.detail.upToDate')}
                    </>
                  ) : (
                    t(stateConfig.labelKey)
                  )}
                </div>
              </div>
              
              {/* OCR文本索引错误/不可索引原因（如果有） */}
              {resource.textIndexError && (
                <div className="col-span-2 md:col-span-4">
                  <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">
                    {state === 'disabled' ? t('indexStatus.detail.disabledReason') : isEmptyContent ? t('indexStatus.detail.contentNote') : t('indexStatus.detail.ocrTextIndexError')}
                  </div>
                  <div className={cn(
                    'px-3 py-2 rounded-md text-xs border',
                    state === 'disabled' 
                      ? 'bg-warning/5 text-warning border-warning/20'
                      : 'bg-danger/5 text-danger border-danger/20'
                  )}>
                    {resource.textIndexError}
                  </div>
                </div>
              )}
              
              {/* 原生多模态索引错误信息（如果有） */}
              {MULTIMODAL_INDEX_SUPPORTED && resource.mmIndexError && (
                <div className="col-span-2 md:col-span-4">
                  <div className="text-muted-foreground/70 font-medium mb-1 text-2xs">{t('indexStatus.detail.nativeMmIndexError')}</div>
                  <div className="bg-danger/5 text-danger border border-danger/20 px-3 py-2 rounded-md text-xs">
                    {resource.mmIndexError}
                  </div>
                </div>
              )}

              {/* 数据透视操作按钮 */}
              <div className="col-span-2 md:col-span-4 flex flex-wrap gap-2 pt-2 border-t border-border/30">
                {showOcrStatus && (
                  <NotionButton
                    variant="outline"
                    size="sm"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleInspectOcr(resource.resourceId); }}
                    className={cn(
                      'text-xs gap-1.5',
                      inspectingResourceId === resource.resourceId && inspectMode === 'ocr' && 'bg-primary/10 text-primary border-primary/20'
                    )}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {t('indexStatus.detail.viewOcrText')}
                  </NotionButton>
                )}
                {resource.textChunkCount > 0 && (
                  <NotionButton
                    variant="outline"
                    size="sm"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleInspectChunks(resource.resourceId); }}
                    className="text-xs gap-1.5"
                  >
                    <Stack className="h-3.5 w-3.5" />
                    {t('indexStatus.detail.viewTextChunks', { count: resource.textChunkCount })}
                  </NotionButton>
                )}
                {showOcrStatus && resource.hasOcr && (
                  <NotionButton
                    variant="outline"
                    size="sm"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleClearOcrAndReindex(resource.resourceId); }}
                    disabled={clearingOcr}
                    className="text-xs gap-1.5 text-destructive hover:text-destructive"
                  >
                    {clearingOcr ? <CircleNotch className="h-3.5 w-3.5 animate-spin" /> : <Eraser className="h-3.5 w-3.5" />}
                    {t('indexStatus.action.clearOcrAndReindex')}
                  </NotionButton>
                )}
              </div>

              {/* 文本块详情（内联） */}
              {inspectingResourceId === resource.resourceId && inspectMode === 'chunks' && (
                <div className="col-span-2 md:col-span-4 pt-2 border-t border-border/30">
                  {inspectLoading ? (
                    <div className="flex items-center justify-center py-6">
                      <CircleNotch className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : textChunks.length > 0 ? (
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground">
                        {t('indexStatus.detail.indexUnitCount', { count: textChunks.length })}
                      </div>
                      {textChunks.map((chunk) => (
                        <div key={chunk.unitId} className="border rounded-lg border-border/50">
                          <div className="flex items-center justify-between px-3 py-1.5 text-xs border-b border-border/30 bg-muted/20">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{t('indexStatus.detail.unitLabel', { n: chunk.unitIndex })}</span>
                              {chunk.textSource && (
                                <span className={cn(
                                  'px-1.5 py-0.5 rounded text-2xs font-medium',
                                  chunk.textSource === 'ocr' ? 'bg-teal-500/10 text-teal-600' : 'bg-primary/10 text-primary'
                                )}>
                                  {chunk.textSource === 'ocr' ? 'OCR' : t('indexStatus.detail.extractedText')}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <span className="tabular-nums">{t('indexStatus.detail.chars', { count: chunk.charCount })}</span>
                              <span className={cn(
                                'px-1.5 py-0.5 rounded text-2xs',
                                chunk.textState === 'indexed' ? 'bg-success/10 text-success' :
                                chunk.textState === 'pending' ? 'bg-warning/10 text-warning' :
                                'bg-muted text-muted-foreground'
                              )}>
                                {STATE_CONFIG[chunk.textState as IndexState] ? t(STATE_CONFIG[chunk.textState as IndexState].labelKey) : chunk.textState}
                              </span>
                            </div>
                          </div>
                          {chunk.textContent ? (
                            <pre className="px-3 py-2 text-xs whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-sans leading-relaxed text-foreground/80">
                              {chunk.textContent}
                            </pre>
                          ) : (
                            <div className="px-3 py-2 text-xs text-muted-foreground italic">{t('indexStatus.detail.noTextContent')}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-4 text-muted-foreground text-xs">{t('indexStatus.detail.noDataFound')}</div>
                  )}
                </div>
              )}

              {/* OCR / 提取文本详情（内联展开面板，替代原 fixed 模态浮层） */}
              {inspectingResourceId === resource.resourceId && inspectMode === 'ocr' && (
                <div className="col-span-2 md:col-span-4 pt-2 border-t border-border/30">
                  <InlineExpand>
                    <div className="rounded-lg border border-border/50 bg-muted/10">
                      {/* 面板头部 */}
                      <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
                        <div className="flex items-center gap-2 min-w-0">
                          <Eye className="h-3.5 w-3.5 text-primary shrink-0" />
                          <span className="font-medium text-xs truncate">{t('indexStatus.detail.ocrAndExtractedTitle')}</span>
                        </div>
                        <NotionButton variant="ghost" size="icon" iconOnly onClick={(e: React.MouseEvent) => { e.stopPropagation(); closeInspectPanel(); }} className="h-6 w-6" aria-label={t('common:close')}>
                          <X className="h-3.5 w-3.5" />
                        </NotionButton>
                      </div>

                      <div className="p-3">
                        {inspectLoading ? (
                          <div className="flex items-center justify-center py-8">
                            <CircleNotch className="h-5 w-5 animate-spin text-muted-foreground" />
                          </div>
                        ) : ocrInfo ? (
                          <div className="space-y-4">
                            {/* 来源对比概览 */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                              <div className={cn('p-3 rounded-lg border', ocrInfo.activeSource === 'ocr' ? 'border-primary bg-primary/5' : 'border-border/50')}>
                                <div className="text-muted-foreground mb-1">{t('indexStatus.detail.ocrText')}</div>
                                <div className="font-semibold tabular-nums">{t('indexStatus.detail.chars', { count: ocrInfo.ocrTextLength })}</div>
                                {ocrInfo.activeSource === 'ocr' && (
                                  <div className="inline-flex items-center gap-1 text-primary text-2xs mt-1">
                                    <CheckCircle className="h-3 w-3" weight="fill" />
                                    {t('indexStatus.detail.currentInUse')}
                                  </div>
                                )}
                              </div>
                              <div className={cn('p-3 rounded-lg border', ocrInfo.activeSource === 'extracted' ? 'border-primary bg-primary/5' : 'border-border/50')}>
                                <div className="text-muted-foreground mb-1">{t('indexStatus.detail.extractedText')}</div>
                                <div className="font-semibold tabular-nums">{t('indexStatus.detail.chars', { count: ocrInfo.extractedTextLength })}</div>
                                {ocrInfo.activeSource === 'extracted' && (
                                  <div className="inline-flex items-center gap-1 text-primary text-2xs mt-1">
                                    <CheckCircle className="h-3 w-3" weight="fill" />
                                    {t('indexStatus.detail.currentInUse')}
                                  </div>
                                )}
                              </div>
                              <div className="p-3 rounded-lg border border-border/50">
                                <div className="text-muted-foreground mb-1">{t('indexStatus.detail.selectionLogic')}</div>
                                <div className="font-medium text-[11px]">
                                  {ocrInfo.activeSource === 'none' ? t('indexStatus.detail.noContent') : ocrInfo.activeSource === 'ocr' ? t('indexStatus.detail.ocrPreferred') : t('indexStatus.detail.fallbackToExtracted')}
                                </div>
                              </div>
                            </div>

                            {/* 逐页 OCR 结果（PDF） */}
                            {ocrInfo.ocrPages && ocrInfo.ocrPages.length > 0 && (
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-2">
                                  {t('indexStatus.detail.pageOcrResultsWithCount', { count: ocrInfo.ocrPages.length })}
                                </div>
                                <div className="space-y-2 max-h-80 overflow-y-auto">
                                  {ocrInfo.ocrPages.map((page) => (
                                    <div key={page.pageIndex} className={cn('border rounded-lg', page.isFailed ? 'border-danger/40 bg-danger/10' : 'border-border/50')}>
                                      <div className={cn('flex items-center justify-between px-3 py-1.5 text-xs border-b', page.isFailed ? 'border-danger/30' : 'border-border/30')}>
                                        <span className="font-medium">{t('indexStatus.detail.pageLabel', { n: page.pageIndex + 1 })}</span>
                                        <span className={cn('tabular-nums', page.isFailed ? 'text-danger' : 'text-muted-foreground')}>
                                          {page.isFailed ? t('indexStatus.detail.ocrFailed') : t('indexStatus.detail.chars', { count: page.charCount })}
                                        </span>
                                      </div>
                                      {!page.isFailed && page.text && (
                                        <pre className="px-3 py-2 text-xs text-foreground/80 whitespace-pre-wrap break-words max-h-32 overflow-y-auto font-sans leading-relaxed">
                                          {page.text}
                                        </pre>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* 图片/单文件 OCR 文本 */}
                            {!ocrInfo.ocrPages && ocrInfo.ocrText && (
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-2">{t('indexStatus.detail.ocrTextContent')}</div>
                                <pre className="border rounded-lg px-3 py-2 text-xs whitespace-pre-wrap break-words max-h-80 overflow-y-auto font-sans leading-relaxed bg-muted/30">
                                  {ocrInfo.ocrText}
                                </pre>
                              </div>
                            )}

                            {/* 提取文本 */}
                            {ocrInfo.extractedText && (
                              <div>
                                <div className="text-xs font-medium text-muted-foreground mb-2">{t('indexStatus.detail.extractedTextContent')}</div>
                                <pre className="border rounded-lg px-3 py-2 text-xs whitespace-pre-wrap break-words max-h-80 overflow-y-auto font-sans leading-relaxed bg-muted/30">
                                  {ocrInfo.extractedText}
                                </pre>
                              </div>
                            )}

                            {!ocrInfo.ocrText && !ocrInfo.extractedText && !ocrInfo.ocrPages && (
                              <div className="text-center py-6 text-muted-foreground text-sm">
                                {t('indexStatus.detail.noOcrOrExtracted')}
                              </div>
                            )}

                            {/* 操作区 */}
                            {ocrInfo.hasOcr && (
                              <div className="flex justify-end pt-2 border-t border-border/30">
                                <NotionButton
                                  variant="outline"
                                  size="sm"
                                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleClearOcrAndReindex(resource.resourceId); }}
                                  disabled={clearingOcr}
                                  className="text-xs gap-1.5 text-destructive hover:text-destructive"
                                >
                                  {clearingOcr ? <CircleNotch className="h-3.5 w-3.5 animate-spin" /> : <Eraser className="h-3.5 w-3.5" />}
                                  {t('indexStatus.action.clearOcrAndReindex')}
                                </NotionButton>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-center py-6 text-muted-foreground text-sm">
                            {t('indexStatus.detail.noDataFound')}
                          </div>
                        )}
                      </div>
                    </div>
                  </InlineExpand>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ========== 渲染内容 ==========
  if (isLoading && !summary) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-0">
        <CircleNotch className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    // ★ 2026-02 修复：错误界面增加可操作指引
    const isEmbeddingError = error.includes('embedding') || error.includes('嵌入') || error.includes('模型');
    const isNetworkError = error.includes('network') || error.includes('网络') || error.includes('timeout') || error.includes('超时');
    const isDbError = error.includes('database') || error.includes('数据库') || error.includes('locked');
    return (
      <div className="flex-1 flex flex-col items-center justify-center min-h-0 gap-4">
        <XCircle className="h-10 w-10 text-destructive/60" />
        <p className="text-sm text-muted-foreground text-center max-w-md">{error}</p>
        {isEmbeddingError && (
          <p className="text-xs text-warning">{t('indexStatus.notification.checkEmbeddingModel')}</p>
        )}
        {isNetworkError && (
          <p className="text-xs text-warning">{t('indexStatus.notification.checkNetwork')}</p>
        )}
        {isDbError && (
          <p className="text-xs text-warning">{t('indexStatus.notification.checkDb')}</p>
        )}
        <NotionButton variant="ghost" size="sm" onClick={() => { loadData(); }} className="text-primary hover:bg-primary/10">
          {t('indexStatus.action.retry')}
        </NotionButton>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div ref={rootContainerRef} className="flex flex-col flex-1 min-h-0 bg-background">
      <style>{SHIMMER_KEYFRAMES}</style>
      {/* 顶部概览区 */}
      {useCompactHeader ? (
        /* ============ 紧凑布局（移动端 / 窄容器桌面窗口） ============ */
        <div data-wb-blur-surface className="relative z-20 flex flex-col gap-2 px-3 py-2.5 border-b border-black/[0.06] dark:border-white/[0.08] bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
          {/* 第一行：进度环 + 关键数字 + 操作按钮 */}
          <div className="flex items-center gap-3">
            {/* 进度环 - 紧凑 */}
            <ProgressRing
              percentage={MULTIMODAL_INDEX_SUPPORTED && summary.mmTotalResources > 0 ? overallProgressPercentage : progressPercentage}
              total={MULTIMODAL_INDEX_SUPPORTED && summary.mmTotalResources > 0 ? summary.totalResources + summary.mmTotalResources : summary.totalResources}
              indexed={MULTIMODAL_INDEX_SUPPORTED && summary.mmTotalResources > 0 ? summary.indexedCount + summary.mmIndexedCount : summary.indexedCount}
              size={56}
              strokeWidth={6}
            />
            {/* 关键数字 - 紧凑两行 */}
            <div className="flex-1 min-w-0 grid grid-cols-2 gap-x-3 gap-y-0.5">
              <div className="flex items-center gap-1.5 text-xs">
                <Database className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.totalVectors')}</span>
                <span className="font-semibold tabular-nums">{dimensions.reduce((acc, d) => acc + d.recordCount, 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <FlowArrow className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.dimensions')}</span>
                <span className="font-mono font-semibold">{dimensions.length > 0 ? dimensions[0].dimension : '-'}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <WarningCircle className={cn('h-3 w-3 shrink-0', summary.failedCount > 0 ? 'text-danger' : 'text-muted-foreground')} />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.errors')}</span>
                <span className={cn('font-semibold tabular-nums', summary.failedCount > 0 && 'text-danger')}>{summary.failedCount + summary.mmFailedCount}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <Clock className={cn('h-3 w-3 shrink-0', summary.staleCount > 0 ? 'text-warning' : 'text-muted-foreground')} />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.stale')}</span>
                <span className={cn('font-semibold tabular-nums', summary.staleCount > 0 && 'text-warning')}>{summary.staleCount}</span>
              </div>
            </div>
          </div>

          {/* 第二行：状态徽章独占一行 */}
          <div className="flex flex-wrap gap-1.5">
            {renderStatBadge('indexed', summary.indexedCount, selectedState === 'indexed', () => setSelectedState(s => s === 'indexed' ? 'all' : 'indexed'))}
            {summary.pendingCount > 0 && renderStatBadge('pending', summary.pendingCount, selectedState === 'pending', () => setSelectedState(s => s === 'pending' ? 'all' : 'pending'))}
            {summary.failedCount > 0 && renderStatBadge('failed', summary.failedCount, selectedState === 'failed', () => setSelectedState(s => s === 'failed' ? 'all' : 'failed'))}
            {summary.disabledCount > 0 && renderStatBadge('disabled', summary.disabledCount, selectedState === 'disabled', () => setSelectedState(s => s === 'disabled' ? 'all' : 'disabled'))}
          </div>

          {/* 第三行：操作按钮独占一行 */}
          <div className="flex items-center gap-1.5">
            <NotionButton variant="primary" size="sm" onClick={handleUnifiedIndex} disabled={batchIndexing || mmIndexing} className={cn('!px-3', batchIndexing || mmIndexing ? 'bg-muted text-muted-foreground' : 'bg-neutral-500 dark:bg-foreground text-white dark:text-background hover:bg-[var(--interactive-hover)] dark:hover:bg-foreground/90')}>
              {(batchIndexing || mmIndexing) ? <CircleNotch className="h-3.5 w-3.5 animate-spin" /> : <Lightning className="h-3.5 w-3.5 fill-current" />}
              {batchIndexing ? t('indexStatus.action.ocrIndexing') : mmIndexing ? t('indexStatus.action.mmIndexing') : t('indexStatus.action.oneClickIndex')}
            </NotionButton>
            <NotionButton variant="default" size="sm" onClick={() => { loadData(); }} disabled={isLoading || batchIndexing}>
              <ArrowsClockwise className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              {t('indexStatus.action.refresh')}
            </NotionButton>
            {/* 更多操作下拉 */}
            <div className="relative" ref={mobileMoreRef}>
              <NotionButton variant="default" size="sm" onClick={() => setMobileMoreOpen(v => !v)} className={cn(mobileMoreOpen && 'bg-accent text-accent-foreground')}>
                <DotsThree className="h-3.5 w-3.5" />
              </NotionButton>
              {/* z-dropdown：走全局浮层阶梯，替换裸 z-50 */}
              {mobileMoreOpen && (
                <div className="absolute right-0 top-full mt-1 z-dropdown min-w-[160px] rounded-md border bg-popover shadow-md py-1 ui-zoom-fade-in">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--interactive-hover)] transition-colors"
                    onClick={() => { setShowTestPanel(v => !v); setMobileMoreOpen(false); }}
                  >
                    <TestTube className="h-3.5 w-3.5" />
                    {t('indexStatus.action.recallTest')}
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                    disabled={resetting || batchIndexing || mmIndexing}
                    onClick={() => { toggleResetConfirm(); setMobileMoreOpen(false); }}
                  >
                    {resetting ? <CircleNotch className="h-3.5 w-3.5 animate-spin" /> : <ArrowCounterClockwise className="h-3.5 w-3.5" />}
                    {t('indexStatus.action.resetState')}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 进度条（如果有） */}
          {(batchIndexing || batchProgress > 0) && (
            <div className="space-y-1 bg-muted/30 p-2 rounded-md">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium truncate">
                  {batchTotal > 0 && (
                    <span className="text-info tabular-nums mr-1.5">
                      {t('indexStatus.progress.indexingCount', { current: batchCurrent, total: batchTotal })}
                    </span>
                  )}
                  {batchMessage}
                </span>
                <span className="font-mono tabular-nums shrink-0 ml-2">{batchProgress}%</span>
              </div>
              <div className="relative overflow-hidden rounded-full">
                <Progress value={batchProgress} className="h-1.5" />
                {batchIndexing && <ProgressShimmer />}
              </div>
            </div>
          )}
          {MULTIMODAL_INDEX_SUPPORTED && (mmIndexing || mmProgress > 0) && (
            <div className="space-y-1 bg-purple-500/5 p-2 rounded-md">
              <div className="flex items-center justify-between text-xs text-purple-600 dark:text-purple-400">
                <span className="font-medium truncate">{mmMessage}</span>
                <span className="font-mono tabular-nums shrink-0 ml-2">{mmProgress}%</span>
              </div>
              <div className="relative overflow-hidden rounded-full">
                <Progress value={mmProgress} className="h-1.5 [&>div]:bg-purple-600" />
                {mmIndexing && <ProgressShimmer />}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* ==================== 桌面端布局（macOS 风格概览） ==================== */
        <div data-wb-blur-surface className="flex flex-row items-center gap-5 lg:gap-6 px-4 lg:px-5 py-3.5 lg:py-4 border-b border-black/[0.06] dark:border-white/[0.08] bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
          {/* 环形进度图 */}
          <div className="flex items-center gap-4 lg:gap-6 shrink-0">
            {/* 综合进度环（当有多模态资源时显示，且多模态已启用） */}
            {MULTIMODAL_INDEX_SUPPORTED && summary.mmTotalResources > 0 ? (
              <>
                <div className="flex flex-col items-center gap-2">
                  <ProgressRing
                    percentage={overallProgressPercentage}
                    total={summary.totalResources + summary.mmTotalResources}
                    indexed={summary.indexedCount + summary.mmIndexedCount}
                    size={80}
                    strokeWidth={8}
                  />
                  <span className="text-xs font-medium text-muted-foreground">{t('indexStatus.progress.overallProgress')}</span>
                </div>
                <div className="h-16 w-px bg-border/50" />
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <ProgressRing
                      percentage={progressPercentage}
                      total={summary.totalResources}
                      indexed={summary.indexedCount}
                      size={32}
                      strokeWidth={3}
                    />
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">{t('indexStatus.progress.text')}</span>
                      <span className="text-2xs text-muted-foreground">{summary.indexedCount}/{summary.totalResources}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <ProgressRing
                      percentage={summary.mmTotalResources > 0 ? (summary.mmIndexedCount / summary.mmTotalResources) * 100 : 0}
                      total={summary.mmTotalResources}
                      indexed={summary.mmIndexedCount}
                      size={32}
                      strokeWidth={3}
                    />
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">{t('indexStatus.progress.multimodal')}</span>
                      <span className="text-2xs text-muted-foreground">{summary.mmIndexedCount}/{summary.mmTotalResources}</span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-4">
                <ProgressRing
                  percentage={progressPercentage}
                  total={summary.totalResources}
                  indexed={summary.indexedCount}
                  size={80}
                  strokeWidth={8}
                />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{t('indexStatus.progress.textIndexProgress')}</span>
                  <span className="text-xs text-muted-foreground">{summary.indexedCount} / {summary.totalResources} {t('indexStatus.progress.items')}</span>
                </div>
              </div>
            )}
          </div>

          {/* 中间信息区 */}
          <div className="flex-1 min-w-0 grid gap-3 lg:gap-4 content-center">
            {/* 关键指标卡片 */}
            <div className="grid grid-cols-4 gap-2">
              <div className="bg-muted/40 dark:bg-muted/25 p-2.5 rounded-xl border border-black/[0.03] dark:border-white/[0.05] flex flex-col justify-between gap-1 transition-colors hover:bg-muted/55">
                <span className="text-2xs text-muted-foreground font-medium flex items-center gap-1.5">
                  <Database className="h-3 w-3 opacity-70" />
                  <span className="truncate">{t('indexStatus.stats.totalVectors')}</span>
                </span>
                <span className="text-md lg:text-base font-semibold tabular-nums tracking-tight text-foreground/90">
                  {dimensions.reduce((acc, d) => acc + d.recordCount, 0).toLocaleString()}
                </span>
              </div>
              
              <div className="bg-muted/40 dark:bg-muted/25 p-2.5 rounded-xl border border-black/[0.03] dark:border-white/[0.05] flex flex-col justify-between gap-1 transition-colors hover:bg-muted/55">
                <span className="text-2xs text-muted-foreground font-medium flex items-center gap-1.5">
                  <FlowArrow className="h-3 w-3 opacity-70" />
                  <span className="truncate">{t('indexStatus.stats.dimensions')}</span>
                </span>
                <div className="flex items-center gap-1.5 overflow-hidden">
                  {dimensions.length > 0 ? (
                    dimensions.slice(0, 2).map(d => (
                      <span key={d.dimension} className="text-xs font-mono bg-background px-1.5 py-0.5 rounded border border-border/50">
                        {d.dimension}
                      </span>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">-</span>
                  )}
                  {dimensions.length > 2 && (
                    <span className="text-2xs text-muted-foreground">+{dimensions.length - 2}</span>
                  )}
                </div>
              </div>

              <div className={cn(
                "p-2 lg:p-3 rounded-md flex flex-col justify-between gap-0.5 lg:gap-1 group transition-colors",
                summary.failedCount + summary.mmFailedCount > 0 
                  ? "bg-danger/5" 
                  : "bg-muted/30"
              )}>
                <span className={cn(
                  "text-2xs uppercase tracking-wider font-medium flex items-center gap-1.5",
                  summary.failedCount + summary.mmFailedCount > 0 ? "text-danger/80" : "text-muted-foreground"
                )}>
                  <WarningCircle className="h-3 w-3" />
                  <span className="truncate">{t('indexStatus.stats.errors')}</span>
                </span>
                <span className={cn(
                  "text-base lg:text-lg font-semibold tabular-nums",
                  summary.failedCount + summary.mmFailedCount > 0 ? "text-danger" : "text-foreground/90"
                )}>
                  {summary.failedCount + summary.mmFailedCount}
                </span>
              </div>

              <div className={cn(
                "p-2 lg:p-3 rounded-md flex flex-col justify-between gap-0.5 lg:gap-1 group transition-colors",
                summary.staleCount > 0 
                  ? "bg-warning/5" 
                  : "bg-muted/30"
              )}>
                <span className={cn(
                  "text-2xs uppercase tracking-wider font-medium flex items-center gap-1.5",
                  summary.staleCount > 0 ? "text-warning" : "text-muted-foreground"
                )}>
                  <Clock className="h-3 w-3" />
                  <span className="truncate">{t('indexStatus.stats.stale')}</span>
                </span>
                <span className={cn(
                  "text-base lg:text-lg font-semibold tabular-nums",
                  summary.staleCount > 0 ? "text-warning" : "text-foreground/90"
                )}>
                  {summary.staleCount}
                </span>
              </div>
            </div>

            {/* 状态过滤徽章 - 紧凑排列 */}
            <div className="flex flex-wrap gap-2">
              {renderStatBadge('indexed', summary.indexedCount, selectedState === 'indexed', () => setSelectedState(s => s === 'indexed' ? 'all' : 'indexed'))}
              {summary.pendingCount > 0 && renderStatBadge('pending', summary.pendingCount, selectedState === 'pending', () => setSelectedState(s => s === 'pending' ? 'all' : 'pending'))}
              {summary.indexingCount > 0 && renderStatBadge('indexing', summary.indexingCount, selectedState === 'indexing', () => setSelectedState(s => s === 'indexing' ? 'all' : 'indexing'))}
              {summary.failedCount > 0 && renderStatBadge('failed', summary.failedCount, selectedState === 'failed', () => setSelectedState(s => s === 'failed' ? 'all' : 'failed'))}
              {summary.disabledCount > 0 && renderStatBadge('disabled', summary.disabledCount, selectedState === 'disabled', () => setSelectedState(s => s === 'disabled' ? 'all' : 'disabled'))}
            </div>

            {/* 动态提示与进度 */}
            <div className="space-y-2">
              {/* 批量索引进度条 */}
              {(batchIndexing || batchProgress > 0) && (
                <div className="space-y-1.5 bg-muted/30 p-2 rounded-md">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium truncate">
                      {batchTotal > 0 && (
                        <span className="text-info tabular-nums mr-1.5">
                          {t('indexStatus.progress.indexingCount', { current: batchCurrent, total: batchTotal })}
                        </span>
                      )}
                      {batchMessage}
                    </span>
                    <span className="font-mono tabular-nums shrink-0 ml-2">{batchProgress}%</span>
                  </div>
                  <div className="relative overflow-hidden rounded-full">
                    <Progress value={batchProgress} className="h-1.5 rounded-full" />
                    {batchIndexing && <ProgressShimmer />}
                  </div>
                </div>
              )}

              {/* 原生多模态索引进度条 */}
              {MULTIMODAL_INDEX_SUPPORTED && (mmIndexing || mmProgress > 0) && (
                <div className="space-y-1.5 bg-purple-500/5 p-2.5 rounded-xl border border-purple-500/10">
                  <div className="flex items-center justify-between text-xs text-purple-600 dark:text-purple-400">
                    <span className="font-medium truncate">{mmMessage}</span>
                    <span className="font-mono tabular-nums shrink-0 ml-2">{mmProgress}%</span>
                  </div>
                  <div className="relative overflow-hidden rounded-full">
                    <Progress value={mmProgress} className="h-1.5 rounded-full [&>div]:bg-purple-600" />
                    {mmIndexing && <ProgressShimmer />}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 右侧操作按钮 — macOS 工具簇 */}
          <div className="flex flex-col gap-2 shrink-0 min-w-[148px]">
            <NotionButton
              variant="primary"
              size="sm"
              onClick={handleUnifiedIndex}
              disabled={batchIndexing || mmIndexing}
              className={cn(
                '!h-8 !rounded-lg !px-3 text-[12px] font-medium shadow-sm',
                batchIndexing || mmIndexing
                  ? 'bg-muted text-muted-foreground shadow-none'
                  : 'bg-foreground text-background hover:bg-foreground/90 dark:bg-foreground dark:text-background'
              )}
            >
              {(batchIndexing || mmIndexing) ? (
                <CircleNotch className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Lightning className="h-3.5 w-3.5" weight="fill" />
              )}
              {batchIndexing ? t('indexStatus.action.ocrIndexing') : mmIndexing ? t('indexStatus.action.mmIndexing') : t('indexStatus.action.oneClickIndex')}
            </NotionButton>
            
            <div className="grid grid-cols-2 gap-1.5">
              <NotionButton
                variant="default"
                size="sm"
                onClick={() => { loadData(); }}
                disabled={isLoading || batchIndexing}
                title={t('indexStatus.action.refreshTitle')}
                className="!h-8 !rounded-lg !px-2 text-[11px] bg-muted/60 hover:bg-muted border border-black/[0.04] dark:border-white/[0.06]"
              >
                <ArrowsClockwise className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
                {t('indexStatus.action.refresh')}
              </NotionButton>
              <NotionButton
                variant="default"
                size="sm"
                onClick={() => setShowTestPanel(!showTestPanel)}
                className={cn(
                  '!h-8 !rounded-lg !px-2 text-[11px] border border-black/[0.04] dark:border-white/[0.06]',
                  showTestPanel
                    ? 'bg-primary/10 text-primary border-primary/20'
                    : 'bg-muted/60 hover:bg-muted'
                )}
              >
                <TestTube className="h-3.5 w-3.5" />
                {t('indexStatus.action.recallTest')}
              </NotionButton>
            </div>
            
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={toggleResetConfirm}
              disabled={resetting || batchIndexing || mmIndexing}
              title={t('indexStatus.action.resetStateTitle')}
              className={cn(
                '!h-8 !rounded-lg text-[11px] text-muted-foreground hover:text-destructive hover:bg-destructive/5',
                resetConfirmOpen && 'text-destructive bg-destructive/5'
              )}
            >
              {resetting ? (
                <CircleNotch className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowCounterClockwise className="h-3.5 w-3.5" />
              )}
              {t('indexStatus.action.resetState')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* 重置全部：内联确认条（危险操作原位展开，替代阻塞式对话框） */}
      {resetConfirmOpen && (
        <InlineExpand>
          <div className="flex flex-wrap items-center gap-3 px-3 md:px-4 py-2.5 border-b border-destructive/20 bg-destructive/5">
            <Warning className="h-4 w-4 text-destructive shrink-0" weight="fill" />
            <div className="flex-1 min-w-[200px]">
              <div className="text-xs font-medium text-destructive">{t('indexStatus.confirm.resetTitle')}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{t('indexStatus.confirm.resetDescription')}</div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <NotionButton
                variant="danger"
                size="sm"
                onClick={handleResetAllIndexState}
                disabled={resetting}
                className="!h-7 text-[11px]"
              >
                {resetting ? <CircleNotch className="h-3.5 w-3.5 animate-spin" /> : <ArrowCounterClockwise className="h-3.5 w-3.5" />}
                {t('indexStatus.confirm.confirmReset')}
              </NotionButton>
              <NotionButton variant="ghost" size="sm" onClick={() => setResetConfirmOpen(false)} className="!h-7 text-[11px]">
                {t('indexStatus.confirm.cancel')}
              </NotionButton>
            </div>
          </div>
        </InlineExpand>
      )}

      {/* 召回测试面板 */}
      {showTestPanel && (
        <div data-wb-blur-surface className="border-b border-black/[0.06] dark:border-white/[0.08] bg-muted/20 backdrop-blur-xl p-3 md:p-4 ui-drop-in">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-md bg-primary/10 text-primary">
                <TestTube className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-medium">{t('indexStatus.test.title')}</h3>
                <p className="text-xs text-muted-foreground">
                  {testMode === 'multimodal' ? t('indexStatus.test.mmDescription') : t('indexStatus.test.description')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* 检索路线切换：文本 / 多模态（仅当前构建支持 MM 时显示） */}
              {MULTIMODAL_INDEX_SUPPORTED && (
                <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-muted/50 border border-black/[0.04] dark:border-white/[0.06]" role="group" aria-label={t('indexStatus.test.modeGroupLabel')}>
                  {(['text', 'multimodal'] as const).map((mode) => (
                    <NotionButton
                      key={mode}
                      variant="ghost"
                      size="sm"
                      onClick={() => setTestMode(mode)}
                      aria-pressed={testMode === mode}
                      className={cn(
                        '!h-7 !rounded-md !px-2.5 !py-0 text-[11px] font-medium border border-transparent',
                        testMode === mode
                          ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10'
                          : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                      )}
                    >
                      {mode === 'text' ? t('indexStatus.test.modeText') : t('indexStatus.test.modeMultimodal')}
                    </NotionButton>
                  ))}
                </div>
              )}
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setShowTestPanel(false)} aria-label={t('common:close')}>
                <X className="h-4 w-4" />
              </NotionButton>
            </div>
          </div>
          
          {/* 搜索输入 - Notion 风格 */}
          <div className="flex gap-2 max-w-3xl">
            <div className="relative flex-1">
              <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="text"
                value={testQuery}
                onChange={(e) => setTestQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleTestSearch()}
                placeholder={t('indexStatus.test.placeholder')}
                className="w-full h-9 pl-9 pr-4 text-ui bg-muted/50 border border-black/[0.04] dark:border-white/[0.06] rounded-lg focus:bg-background focus:ring-2 focus:ring-primary/15 transition-all placeholder:text-muted-foreground/60"
                autoFocus
              />
            </div>
            <NotionButton variant="primary" size="sm" onClick={handleTestSearch} disabled={testLoading || !testQuery.trim()} className="!h-10 !px-6">
              {testLoading ? (
                <CircleNotch className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <MagnifyingGlass className="h-4 w-4" />
                  {t('indexStatus.action.search')}
                </>
              )}
            </NotionButton>
          </div>

          {/* 测试结果 */}
          {(testError || testResults.length > 0 || testElapsedMs !== null) && (
            <div className="mt-4 space-y-3">
              {testError && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                  <WarningCircle className="h-4 w-4" />
                  {testError}
                </div>
              )}

              {/* 多模态模式：部分检索路由失败（结果可能不完整） */}
              {testRouteFailures.length > 0 && (
                <div className="p-3 rounded-md bg-warning/10 text-warning text-xs space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <Warning className="h-3.5 w-3.5" />
                    {t('indexStatus.test.routeFailures', { count: testRouteFailures.length })}
                  </div>
                  {testRouteFailures.map((failure, i) => (
                    <div key={i} className="pl-5 font-mono break-all opacity-90">{failure}</div>
                  ))}
                </div>
              )}

              {testElapsedMs !== null && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                  <div className={cn("w-2 h-2 rounded-full", testResults.length > 0 ? "bg-success" : "bg-warning")} />
                  {t('indexStatus.test.resultCount', { count: testResults.length, elapsed: testElapsedMs })}
                </div>
              )}

              {testResults.length > 0 && (
                <div className="rounded-lg border bg-background/50 overflow-hidden">
                  <CustomScrollArea className="max-h-[400px]">
                    <div className="divide-y divide-border/50">
                      {testResults.map((result, idx) => (
                        <div key={result.embeddingId} className="p-4 hover:bg-[var(--interactive-hover)] transition-colors">
                          <div className="flex items-start gap-3 mb-2">
                            <span className="flex items-center justify-center w-5 h-5 rounded bg-primary/10 text-primary text-2xs font-mono font-medium shrink-0 mt-0.5">
                              {idx + 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 mb-1">
                                <h4 className="text-sm font-medium truncate text-foreground/90">
                                  {result.resourceTitle || result.resourceId}
                                </h4>
                                <span className="text-xs font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded shrink-0">
                                  {result.score.toFixed(4)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span className="bg-muted/50 px-1.5 py-0.5 rounded">{result.resourceType}</span>
                                <span>•</span>
                                <span>{t('indexStatus.test.chunkIndex')} {result.chunkIndex}</span>
                              </div>
                            </div>
                          </div>
                          <div className="ml-8 text-xs text-muted-foreground leading-relaxed bg-muted/30 p-3 rounded border border-border/30 font-mono">
                            {result.chunkText}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CustomScrollArea>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 筛选栏 — macOS segmented / capsule 风格 */}
      <div data-wb-blur-surface className="flex items-center gap-3 px-3 md:px-4 py-2 border-b border-black/[0.06] dark:border-white/[0.08] bg-background/70 backdrop-blur-xl sticky top-0 z-10">
        <div className="flex-1 min-w-0 flex items-center gap-2 overflow-x-auto">
          <span className="text-[11px] font-medium text-muted-foreground/80 shrink-0">{t('indexStatus.filter.typeFilter')}</span>
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-muted/50 border border-black/[0.04] dark:border-white/[0.06]">
            {['all', 'note', 'textbook', 'exam', 'translation', 'essay', 'mindmap', 'file', 'image'].map((type) => {
              const isActive = selectedType === type;
              const label = type === 'all' ? t('indexStatus.filter.all') : (RESOURCE_TYPE_CONFIG[type]?.labelKey ? t(RESOURCE_TYPE_CONFIG[type].labelKey) : type);
              return (
                <NotionButton
                  key={type}
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedType(type)}
                  className={cn(
                    '!h-7 !rounded-md !px-2.5 !py-0 text-[11px] font-medium border border-transparent',
                    isActive
                      ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5 dark:ring-white/10'
                      : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
                  )}
                >
                  {label}
                </NotionButton>
              );
            })}
          </div>
        </div>
        {!useCompactHeader && (
          <div className="text-[11px] tabular-nums text-muted-foreground shrink-0 pl-3 border-l border-black/[0.06] dark:border-white/[0.08] whitespace-nowrap">
            <span className="font-semibold text-foreground/90">{summary.resources.length}</span>
            <span className="mx-1 text-muted-foreground/40">/</span>
            <span>{summary.totalResources}</span>
          </div>
        )}
      </div>

      
{/* 分组资源列表 */}
      <CustomScrollArea className="flex-1">
        {summary.resources.length === 0 ? (
          selectedState === 'all' && selectedType === 'all' ? (
            /* 真空态：没有任何可索引资源，给引导文案 */
            <div className="flex flex-col items-center justify-center py-16 px-6 text-muted-foreground">
              <Database className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium text-foreground/80">{t('indexStatus.empty.noResourcesTitle')}</p>
              <p className="text-xs mt-1.5 opacity-70 text-center max-w-sm leading-relaxed">{t('indexStatus.empty.noResourcesDesc')}</p>
              {dimensions.length === 0 && (
                <p className="text-xs mt-3 px-3 py-2 rounded-md bg-warning/10 text-warning text-center max-w-sm leading-relaxed">
                  {t('indexStatus.empty.configureEmbeddingHint')}
                </p>
              )}
            </div>
          ) : (
            /* 筛选后无结果 */
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <Database className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm">{t('indexStatus.empty.noMatchingResources')}</p>
              <p className="text-xs mt-1 opacity-60">{t('indexStatus.empty.adjustFilters')}</p>
            </div>
          )
        ) : selectedState === 'all' ? (
          // 分组显示模式
          <div className="divide-y divide-black/[0.04] dark:divide-white/[0.06]">
            {(['pending', 'indexing', 'failed', 'indexed', 'disabled'] as IndexState[]).map((state) => {
              const resources = groupedResources[state] || [];
              if (resources.length === 0) return null;
              
              const config = STATE_CONFIG[state];
              const Icon = config.icon;
              const isExpanded = expandedGroups.has(state);
              
              return (
                <div key={state}>
                  {/* 分组标题 — Finder 分组条 */}
                  <div className={cn(
                    'flex items-center border-b border-black/[0.03] dark:border-white/[0.05]',
                    config.bgColor
                  )}>
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleGroup(state)}
                      className={cn(
                        'flex-1 !h-8 !justify-start !gap-2 !rounded-none !px-3 md:!px-4 !py-0 text-[12px] font-medium !bg-transparent',
                        'hover:brightness-[0.98] dark:hover:brightness-110'
                      )}
                    >
                      {isExpanded ? (
                        <CaretDown className="h-3.5 w-3.5 text-muted-foreground/70" />
                      ) : (
                        <CaretRight className="h-3.5 w-3.5 text-muted-foreground/70" />
                      )}
                      <Icon className={cn('h-3.5 w-3.5', config.color)} weight="fill" />
                      <span className={cn(config.color, 'tracking-tight')}>{t(config.labelKey)}</span>
                      <span className="text-muted-foreground/70 font-normal tabular-nums">({resources.length})</span>
                    </NotionButton>
                    {/* 失败组：重试全部失败项（内联确认条，不用对话框） */}
                    {state === 'failed' && failedResources.length > 0 && (
                      <NotionButton
                        variant="ghost"
                        size="sm"
                        onClick={() => setRetryFailedConfirmOpen((v) => !v)}
                        disabled={retryingFailed || batchIndexing || mmIndexing}
                        className={cn(
                          '!h-6 !rounded-md !px-2 mr-2 md:mr-3 text-[11px] shrink-0 text-danger hover:bg-danger/10',
                          retryFailedConfirmOpen && 'bg-danger/10'
                        )}
                      >
                        {retryingFailed ? <CircleNotch className="h-3 w-3 animate-spin" /> : <ArrowsClockwise className="h-3 w-3" />}
                        {t('indexStatus.action.retryAllFailed')}
                      </NotionButton>
                    )}
                  </div>

                  {/* 失败组：内联确认条 */}
                  {state === 'failed' && retryFailedConfirmOpen && (
                    <InlineExpand>
                      <div className="flex flex-wrap items-center gap-3 px-3 md:px-4 py-2 border-b border-danger/20 bg-danger/5">
                        <WarningCircle className="h-4 w-4 text-danger shrink-0" weight="fill" />
                        <div className="flex-1 min-w-[180px]">
                          <div className="text-xs font-medium text-danger">{t('indexStatus.confirm.retryFailedTitle')}</div>
                          <div className="text-[11px] text-muted-foreground mt-0.5">{t('indexStatus.confirm.retryFailedDescription', { count: failedResources.length })}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <NotionButton variant="primary" size="sm" onClick={handleRetryAllFailed} disabled={retryingFailed} className="!h-7 text-[11px]">
                            {retryingFailed ? <CircleNotch className="h-3.5 w-3.5 animate-spin" /> : <ArrowsClockwise className="h-3.5 w-3.5" />}
                            {t('indexStatus.confirm.confirmRetry')}
                          </NotionButton>
                          <NotionButton variant="ghost" size="sm" onClick={() => setRetryFailedConfirmOpen(false)} className="!h-7 text-[11px]">
                            {t('indexStatus.confirm.cancel')}
                          </NotionButton>
                        </div>
                      </div>
                    </InlineExpand>
                  )}

                  {/* 分组内容 */}
                  {isExpanded && (
                    <div className="bg-background">
                      {resources.map(renderResourceRow)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // 单状态筛选模式
          <>
            {/* 失败筛选视图：顶部提供「重试全部失败项」入口（内联确认条） */}
            {selectedState === 'failed' && failedResources.length > 0 && (
              <div className="border-b border-black/[0.04] dark:border-white/[0.06]">
                <div className="flex items-center justify-end px-3 md:px-4 py-1.5 bg-danger/5">
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => setRetryFailedConfirmOpen((v) => !v)}
                    disabled={retryingFailed || batchIndexing || mmIndexing}
                    className={cn(
                      '!h-6 !rounded-md !px-2 text-[11px] text-danger hover:bg-danger/10',
                      retryFailedConfirmOpen && 'bg-danger/10'
                    )}
                  >
                    {retryingFailed ? <CircleNotch className="h-3 w-3 animate-spin" /> : <ArrowsClockwise className="h-3 w-3" />}
                    {t('indexStatus.action.retryAllFailed')}
                  </NotionButton>
                </div>
                {retryFailedConfirmOpen && (
                  <InlineExpand>
                    <div className="flex flex-wrap items-center gap-3 px-3 md:px-4 py-2 border-t border-danger/20 bg-danger/5">
                      <WarningCircle className="h-4 w-4 text-danger shrink-0" weight="fill" />
                      <div className="flex-1 min-w-[180px]">
                        <div className="text-xs font-medium text-danger">{t('indexStatus.confirm.retryFailedTitle')}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">{t('indexStatus.confirm.retryFailedDescription', { count: failedResources.length })}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <NotionButton variant="primary" size="sm" onClick={handleRetryAllFailed} disabled={retryingFailed} className="!h-7 text-[11px]">
                          {retryingFailed ? <CircleNotch className="h-3.5 w-3.5 animate-spin" /> : <ArrowsClockwise className="h-3.5 w-3.5" />}
                          {t('indexStatus.confirm.confirmRetry')}
                        </NotionButton>
                        <NotionButton variant="ghost" size="sm" onClick={() => setRetryFailedConfirmOpen(false)} className="!h-7 text-[11px]">
                          {t('indexStatus.confirm.cancel')}
                        </NotionButton>
                      </div>
                    </div>
                  </InlineExpand>
                )}
              </div>
            )}
            <div className="divide-y divide-black/[0.04] dark:divide-white/[0.06]">
              {summary.resources.map(renderResourceRow)}
            </div>
          </>
        )}

        {/* 分页提示 + 加载更多（列表为分页拉取，头部计数为全量） */}
        {summary.resources.length > 0 && hasMore && (
          <div className="flex flex-col items-center gap-2 py-4 border-t border-black/[0.04] dark:border-white/[0.06]">
            {/* 头部计数为全量，仅在无筛选时展示「已加载 X / 全量」 */}
            {selectedState === 'all' && selectedType === 'all' && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t('indexStatus.list.showingPartial', { shown: summary.resources.length, total: summary.totalResources })}
              </span>
            )}
            <NotionButton
              variant="outline"
              size="sm"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="!h-7 text-[11px]"
            >
              {loadingMore ? (
                <>
                  <CircleNotch className="h-3.5 w-3.5 animate-spin" />
                  {t('indexStatus.list.loadingMore')}
                </>
              ) : (
                t('indexStatus.action.loadMore')
              )}
            </NotionButton>
          </div>
        )}
      </CustomScrollArea>

      {/* DEV：折叠诊断面板（危险操作不宜默认进正式用户面） */}
      {import.meta.env.DEV && (
        <IndexDiagnosticPanel onRefresh={loadData} />
      )}
    </div>
  );
};

export default IndexStatusView;
