import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';
import { NotionButton } from '@/components/ui/NotionButton';
import { pLimit } from '@/utils/concurrency';
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
  RefreshCw,
  CheckCircle,
  Clock,
  AlertCircle,
  XCircle,
  Ban,
  FileText,
  BookOpen,
  ClipboardList,
  Languages,
  PenTool,
  Loader2,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Zap,
  Image,
  Search,
  X,
  TestTube,
  Network,
  RotateCcw,
  Workflow,
  MoreHorizontal,
} from 'lucide-react';
// Button 组件已替换为原生 button + Tailwind（Notion 风格）
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  getAllIndexStatus,
  reindexResource,
  batchIndexPendingLegacy as batchIndexPending,
  listDimensions,
  type ResourceIndexStatusSummary as IndexStatusSummary,
  type ResourceIndexStatus,
  type VfsEmbeddingDimension,
} from '@/api/vfsUnifiedIndexApi';
import {
  vfsRagSearch,
  resetAllIndexState,
  type VfsSearchResult,
} from '@/api/vfsRagApi';
import multimodalRagService, { type SourceType as MMSourceType, MULTIMODAL_INDEX_ENABLED } from '@/services/multimodalRagService';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { Progress } from '@/components/ui/shad/Progress';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
// ★ 2026-02 修复：统一使用共享类型定义，避免重复定义不一致风险
import type { IndexState } from '@/types/vfs-unified-index';

// ============================================================================
// 类型和常量
// ============================================================================

/** 状态配置 */
const STATE_CONFIG: Record<IndexState, { labelKey: string; icon: React.ElementType; color: string; bgColor: string; ringColor: string }> = {
  indexed: { labelKey: 'indexStatus.state.indexed', icon: CheckCircle, color: 'text-emerald-600 dark:text-emerald-400', bgColor: 'bg-emerald-500/10', ringColor: 'stroke-emerald-500' },
  pending: { labelKey: 'indexStatus.state.pending', icon: Clock, color: 'text-warning', bgColor: 'bg-warning/10', ringColor: 'stroke-warning' },
  indexing: { labelKey: 'indexStatus.state.indexing', icon: RefreshCw, color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-500/10', ringColor: 'stroke-blue-500' },
  failed: { labelKey: 'indexStatus.state.failed', icon: AlertCircle, color: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-500/10', ringColor: 'stroke-red-500' },
  disabled: { labelKey: 'indexStatus.state.disabled', icon: Ban, color: 'text-gray-500 dark:text-gray-400', bgColor: 'bg-gray-500/10', ringColor: 'stroke-gray-400' },
};

/** 资源类型配置 */
const RESOURCE_TYPE_CONFIG: Record<string, { icon: React.ElementType; labelKey: string; color: string }> = {
  note: { icon: FileText, labelKey: 'indexStatus.resourceType.note', color: 'text-blue-500 bg-blue-500/10' },
  textbook: { icon: BookOpen, labelKey: 'indexStatus.resourceType.textbook', color: 'text-purple-500 bg-purple-500/10' },
  exam: { icon: ClipboardList, labelKey: 'indexStatus.resourceType.exam', color: 'text-orange-500 bg-orange-500/10' },
  translation: { icon: Languages, labelKey: 'indexStatus.resourceType.translation', color: 'text-cyan-500 bg-cyan-500/10' },
  essay: { icon: PenTool, labelKey: 'indexStatus.resourceType.essay', color: 'text-pink-500 bg-pink-500/10' },
  mindmap: { icon: Network, labelKey: 'indexStatus.resourceType.mindmap', color: 'text-indigo-500 bg-indigo-500/10' },
  retrieval: { icon: Database, labelKey: 'indexStatus.resourceType.retrieval', color: 'text-success bg-success/10' },
  file: { icon: FileText, labelKey: 'indexStatus.resourceType.file', color: 'text-gray-500 bg-gray-500/10' },
  image: { icon: Image, labelKey: 'indexStatus.resourceType.image', color: 'text-warning bg-warning/10' },
};

/** 不支持任何索引的资源类型（技能卡等系统资源） */
const UNSUPPORTED_INDEX_TYPES = new Set(['retrieval']);

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
          <span className={cn("font-bold tabular-nums", size < 80 ? "text-lg" : "text-2xl")}>{Math.round(percentage)}%</span>
          <span className="text-[10px] text-muted-foreground">{indexed}/{total}</span>
        </div>
      )}
    </div>
  );
};

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

  // ========== 召回测试状态 ==========
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [testQuery, setTestQuery] = useState('');
  const [testResults, setTestResults] = useState<VfsSearchResult[]>([]);
  const [testLoading, setTestLoading] = useState(false);
  const [testElapsedMs, setTestElapsedMs] = useState<number | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  // ========== 批量索引进度状态 ==========
  const [batchIndexing, setBatchIndexing] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [batchMessage, setBatchMessage] = useState('');
  const [batchCurrent, setBatchCurrent] = useState(0);
  const [batchTotal, setBatchTotal] = useState(0);

  // ========== 平滑进度动画 ==========
  const smoothProgressRef = useRef(0);
  const [smoothProgress, setSmoothProgress] = useState(0);

  // ========== 原生多模态索引状态 ==========
  const [mmIndexing, setMmIndexing] = useState(false);
  const [mmProgress, setMmProgress] = useState(0);
  const [mmMessage, setMmMessage] = useState('');

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
          limit: 200,
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
  }, [selectedState, selectedType]);

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

  // ========== 监听后端索引进度事件 ==========
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    const setupListener = async () => {
      unlisten = await listen<{
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

        switch (payload.type) {
          case 'batch_started':
            setBatchIndexing(true);
            setBatchProgress(0);
            setBatchMessage(payload.message || t('indexStatus.notification.batchStarting'));
            break;
          case 'resource_started':
          case 'resource_completed':
          case 'resource_failed':
            setBatchProgress(payload.progress || 0);
            setBatchMessage(payload.message || '');
            break;
          // ★ 嵌入批次级细粒度进度（每 16 块回调一次）
          case 'embedding_progress':
            setBatchProgress(payload.progress || 0);
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
            loadData(); // 刷新列表
            // ★ 2026-02 修复：setTimeout 添加卸载保护
            setTimeout(() => {
              if (!mountedRef.current) return;
              setBatchProgress(0);
              setBatchMessage('');
            }, 2000);
            break;
          case 'started':
          case 'completed':
          case 'failed':
            // 单个资源索引事件
            if (payload.type === 'completed') {
              loadData();
            }
            break;
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [loadData]);

  // ========== 监听原生多模态索引进度事件 ==========
  // ★ 多模态索引已禁用时不监听事件，避免无用报错
  useEffect(() => {
    if (!MULTIMODAL_INDEX_ENABLED) return;

    let unlisten: UnlistenFn | null = null;

    const setupListener = async () => {
      const resolveResourceLabel = (payload: { sourceId: string }) => {
        if (!summary?.resources?.length) {
          return payload.sourceId;
        }

        const matched = summary.resources.find((resource) =>
          resource.resourceId === payload.sourceId || resource.sourceId === payload.sourceId
        );

        return matched?.name || matched?.resourceId || payload.sourceId;
      };

      unlisten = await listen<{
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
        setMmProgress(payload.progressPercent);
        setMmMessage(displayMessage);

        if (payload.phase === 'completed') {
          // ★ 2026-02 修复：setTimeout 添加卸载保护
          setTimeout(() => {
            if (!mountedRef.current) return;
            loadData();
          }, 500);
        } else if (payload.phase === 'failed') {
          showGlobalNotification('error', t('indexStatus.notification.mmIndexFailed'), payload.message);
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [loadData]);

  // ========== 按模态分组维度 ==========
  const dimensionsByModality = useMemo(() => {
    const textDims = dimensions.filter(d => d.modality === 'text');
    const vlDims = dimensions.filter(d => d.modality !== 'text');
    return { text: textDims, vl: vlDims };
  }, [dimensions]);

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
  }, [loadData]);

  // ========== 批量重新索引（使用后端批量 API，带进度事件）==========
  const handleReindexAll = useCallback(async () => {
    if (!summary) return;
    if (batchIndexing) {
      showGlobalNotification('warning', t('indexStatus.notification.pleaseWait'), t('indexStatus.notification.batchInProgress'));
      return;
    }

    const pendingCount = summary.pendingCount + summary.failedCount;
    if (pendingCount === 0) {
      showGlobalNotification('info', t('indexStatus.notification.hint'), t('indexStatus.notification.noResourcesToIndex'));
      return;
    }

    setBatchIndexing(true);
    setBatchProgress(0);
    setBatchMessage(t('indexStatus.notification.preparingBatch'));

    try {
      // 使用后端批量索引 API，进度通过事件更新
      await batchIndexPending(pendingCount);
      // 完成事件会在事件监听器中处理
    } catch (err: unknown) {
      setBatchIndexing(false);
      setBatchProgress(0);
      setBatchMessage('');
      showGlobalNotification('error', t('indexStatus.notification.batchFailed'), err instanceof Error ? err.message : t('indexStatus.notification.unknownError'));
    }
  }, [summary, batchIndexing]);

  // ========== 一键索引（执行 OCR 文本索引，多模态索引仅在启用时执行）==========
  const handleUnifiedIndex = useCallback(async () => {
    if (!summary) return;
    if (batchIndexing || mmIndexing) {
      showGlobalNotification('warning', t('indexStatus.notification.pleaseWait'), t('indexStatus.notification.indexInProgress'));
      return;
    }

    // 检查是否有需要索引的资源
    const pendingTextCount = summary.pendingCount + summary.failedCount;
    // ★ 多模态索引已禁用时不检查多模态资源
    const mmResources = MULTIMODAL_INDEX_ENABLED ? summary.resources.filter(r => {
      const isMmType = r.resourceType === 'textbook' || r.resourceType === 'exam' || r.resourceType === 'image' || r.resourceType === 'file';
      const hasPreview = r.resourceType !== 'file' || r.hasOcr;
      return isMmType && hasPreview && r.mmIndexState !== 'indexed' && r.mmIndexState !== 'disabled';
    }) : [];

    if (pendingTextCount === 0 && mmResources.length === 0) {
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
        if (batchFailed) {
          setBatchIndexing(false);
          setBatchProgress(0);
          setBatchMessage('');
        }
      }
    }

    // 然后执行原生多模态索引（仅在 MULTIMODAL_INDEX_ENABLED 时）
    if (mmResources.length > 0) {
      setMmIndexing(true);
      setMmProgress(0);
      setMmMessage(t('indexStatus.notification.mmIndexStarting', { count: mmResources.length }));

      let successCount = 0;
      let failCount = 0;
      let skippedCount = 0;
      const total = mmResources.length;
      const limit = pLimit(3);

      await Promise.all(mmResources.map((resource) =>
        limit(async () => {
          const sourceType: MMSourceType = resource.resourceType === 'image' ? 'image' : resource.resourceType as MMSourceType;
          const sourceId = resource.sourceId || resource.resourceId;

          if (!sourceId) {
            debugLog.warn('[IndexStatusView] 资源缺少 sourceId，跳过索引:', resource.resourceId);
            skippedCount++;
            setMmProgress(Math.round(((successCount + failCount + skippedCount) / total) * 100));
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
          setMmProgress(Math.round(((successCount + failCount + skippedCount) / total) * 100));
        })
      ));

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
  }, [summary, batchIndexing, mmIndexing, loadData]);

  // ========== 原生多模态索引（PDF 按页图片索引）==========
  // ★ 多模态索引已禁用时此函数不会被调用（按钮已隐藏），保留逻辑以便未来恢复
  const handleMultimodalIndex = useCallback(async () => {
    if (!MULTIMODAL_INDEX_ENABLED) return; // ★ 多模态索引已禁用
    if (!summary) return;
    if (mmIndexing) {
      showGlobalNotification('warning', t('indexStatus.notification.pleaseWait'), t('indexStatus.notification.mmIndexInProgress'));
      return;
    }

    // 筛选支持原生多模态索引的资源（教材、题目集、图片、文件）
    const mmResources = summary.resources.filter(r => {
      const isMmType = r.resourceType === 'textbook' || r.resourceType === 'exam' || r.resourceType === 'image' || r.resourceType === 'file';
      const hasPreview = r.resourceType !== 'file' || r.hasOcr;
      return isMmType && hasPreview;
    });

    if (mmResources.length === 0) {
      showGlobalNotification('info', t('indexStatus.notification.hint'), t('indexStatus.notification.noMmResources'));
      return;
    }

    setMmIndexing(true);
    setMmProgress(0);
    setMmMessage(t('indexStatus.notification.mmIndexStarting', { count: mmResources.length }));

    let successCount = 0;
    let failCount = 0;
    let skippedCount = 0;
    const total = mmResources.length;
    const limit = pLimit(3);

    await Promise.all(mmResources.map((resource) =>
      limit(async () => {
        // 图片类型使用 'image' 作为 sourceType，其他类型使用 resourceType
        const sourceType: MMSourceType = resource.resourceType === 'image' ? 'image' : resource.resourceType as MMSourceType;

        // 原生多模态索引优先使用 sourceId（业务ID）
        const sourceId = resource.sourceId || resource.resourceId;
        if (!sourceId) {
          debugLog.warn('[IndexStatusView] 资源缺少 sourceId，跳过索引:', resource.resourceId);
          skippedCount++;
          setMmProgress(Math.round(((successCount + failCount + skippedCount) / total) * 100));
          return;
        }

        try {
          await multimodalRagService.vfsIndexResourceBySource(
            sourceType,
            sourceId,
            undefined,
            false
          );
          successCount++;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          debugLog.error(`[IndexStatusView] 原生多模态索引失败: ${sourceId}`, err);
          // 显示具体错误给用户
          showGlobalNotification('error', t('indexStatus.notification.indexFailed'), `${resource.name || sourceId}: ${errMsg}`);
          failCount++;
        }
        setMmProgress(Math.round(((successCount + failCount + skippedCount) / total) * 100));
      })
    ));

    setMmIndexing(false);
    setMmProgress(100);
    const resultMsg = failCount > 0
      ? t('indexStatus.notification.mmIndexCompletedWithFail', { success: successCount, fail: failCount })
      : t('indexStatus.notification.mmIndexCompletedSuccess', { count: successCount });
    setMmMessage(resultMsg);
    if (failCount > 0) {
      showGlobalNotification('warning', t('indexStatus.notification.mmIndexCompleted'), resultMsg);
    } else {
      showGlobalNotification('success', t('indexStatus.notification.mmIndexCompleted'), resultMsg);
    }

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
  }, [summary, mmIndexing, loadData]);

  // ========== 重置所有索引状态 ==========
  const [resetting, setResetting] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const mobileMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mobileMoreOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mobileMoreRef.current && !mobileMoreRef.current.contains(e.target as Node)) {
        setMobileMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mobileMoreOpen]);
  
  const handleResetAllIndexState = useCallback(async () => {
    if (resetting || batchIndexing || mmIndexing) {
      showGlobalNotification('warning', t('indexStatus.notification.pleaseWait'), t('indexStatus.notification.waitForCurrent'));
      return;
    }
    
    const confirmed = await Promise.resolve(unifiedConfirm(t('indexStatus.notification.confirmResetAll')));
    if (!confirmed) {
      return;
    }
    
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
  }, [resetting, batchIndexing, mmIndexing, loadData]);

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

    debugLog.info('[IndexStatusView] 召回测试开始', { queryLength: testQuery.length });

    try {
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
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      debugLog.error('[IndexStatusView] 召回测试失败', err);
      setTestError(errorMsg);
      showGlobalNotification('error', t('indexStatus.notification.recallTestFailed'), errorMsg);
    } finally {
      setTestLoading(false);
    }
  }, [testQuery]);

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

  /** 综合进度：同时考虑文本和多模态索引（仅在多模态启用时） */
  const overallProgressPercentage = useMemo(() => {
    if (!summary) return 0;
    // ★ 多模态索引已禁用时，综合进度等于纯文本进度
    if (!MULTIMODAL_INDEX_ENABLED) {
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
      <NotionButton variant="ghost" size="sm" onClick={onClick} className={cn('!rounded-full !px-3 !py-1.5 text-xs font-medium', config.bgColor, config.color, isActive && 'ring-1 ring-primary/30', isActive && config.ringColor.replace('stroke-', 'ring-'))}>
        <Icon className="h-3.5 w-3.5" />
        <span>{t(config.labelKey)}</span>
        <span className="ml-0.5 tabular-nums font-bold">{count}</span>
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
      <div key={resource.resourceId} className="group border-b border-border/40 hover:bg-muted/30 transition-all">
        {/* 主行 - 可点击展开 */}
        <div
          className="flex items-center gap-2 md:gap-4 px-3 md:px-6 py-2.5 md:py-3 cursor-pointer"
          onClick={() => toggleResourceExpand(resource.resourceId)}
        >
          {/* 🆕 展开/折叠指示器 */}
          <div className="w-5 flex-shrink-0 flex items-center justify-center text-muted-foreground/70 group-hover:text-foreground transition-colors">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>

          {/* 资源类型标签 */}
          <div className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium uppercase tracking-wide flex-shrink-0 border',
            typeConfig.color.replace('bg-', 'border-').replace('/10', '/20').replace('text-', 'bg-').replace('500', '500/5 text-')
          )}>
            <TypeIcon className="h-3 w-3" />
            <span>{t(typeConfig.labelKey)}</span>
          </div>

          {/* 资源名称 */}
          <div className="flex-1 min-w-0 grid gap-0.5">
            <div className="font-medium truncate text-sm text-foreground/90 group-hover:text-primary transition-colors" title={resource.name}>
              {displayName}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {resource.textChunkCount > 0 && (
                <span className="bg-background/80 px-1.5 rounded border border-border/50">
                  {t('indexStatus.detail.chunks', { count: resource.textChunkCount })}
                </span>
              )}
              {resource.embeddingDim && (
                <span className="font-mono opacity-80">
                  d={resource.embeddingDim}
                </span>
              )}
              {resource.modality && MULTIMODAL_INDEX_ENABLED && (
                <span className={cn(
                  'px-1.5 rounded text-[10px] border',
                  resource.modality === 'text' 
                    ? 'border-primary/20 text-primary bg-primary/5'
                    : resource.modality === 'multimodal'
                      ? 'border-violet-500/20 text-violet-600 bg-violet-500/5'
                      : 'border-emerald-500/20 text-emerald-600 bg-emerald-500/5'
                )}>
                  {resource.modality === 'text' ? t('indexStatus.detail.modalityText') : resource.modality === 'multimodal' ? t('indexStatus.detail.modalityMultimodal') : t('indexStatus.detail.modalityTextAndMm')}
                </span>
              )}
            </div>
          </div>

          {/* 状态标签 - 有 indexError 的显示错误状态 */}
          <div 
            className={cn(
              'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border shadow-sm',
              isUnsupportedType && state === 'pending' && 'bg-muted/50 text-muted-foreground border-transparent',
              !isUnsupportedType && hasIndexError && !isEmptyContent && 'bg-orange-50/50 text-orange-700 border-orange-200 dark:bg-orange-900/10 dark:text-orange-400 dark:border-orange-800/30',
              !isUnsupportedType && isEmptyContent && 'bg-warning/10 text-warning border-warning/30',
              !isUnsupportedType && !hasIndexError && isStale && 'bg-orange-50/50 text-orange-700 border-orange-200 dark:bg-orange-900/10 dark:text-orange-400 dark:border-orange-800/30',
              !isUnsupportedType && !hasIndexError && !isStale && state === 'indexed' && 'bg-emerald-50/50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/10 dark:text-emerald-400 dark:border-emerald-800/30',
              !isUnsupportedType && !hasIndexError && state === 'pending' && 'bg-yellow-50/50 text-yellow-700 border-yellow-200 dark:bg-yellow-900/10 dark:text-yellow-400 dark:border-yellow-800/30',
              state === 'indexing' && 'bg-blue-50/50 text-blue-700 border-blue-200 dark:bg-blue-900/10 dark:text-blue-400 dark:border-blue-800/30',
              state === 'failed' && 'bg-red-50/50 text-red-700 border-red-200 dark:bg-red-900/10 dark:text-red-400 dark:border-red-800/30',
              state === 'disabled' && 'bg-muted/50 text-muted-foreground border-transparent'
            )}
            title={resource.textIndexError || undefined}
          >
            {isUnsupportedType && state === 'pending' ? (
              <>
                <Ban className="h-3.5 w-3.5" />
                <span>{t('indexStatus.detail.unsupported')}</span>
              </>
            ) : isEmptyContent ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5" />
                <span>{t('indexStatus.detail.emptyContent')}</span>
              </>
            ) : hasIndexError ? (
              <>
                <AlertCircle className="h-3.5 w-3.5" />
                <span>{t('indexStatus.detail.indexError')}</span>
              </>
            ) : isStale ? (
              <>
                <AlertTriangle className="h-3.5 w-3.5" />
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
              <NotionButton variant="ghost" size="icon" iconOnly onClick={() => handleReindex(resource.resourceId)} disabled={isReindexing} className="opacity-0 group-hover:opacity-100 hover:text-primary hover:bg-primary/10" title={isStale ? t('indexStatus.action.update') : t('indexStatus.action.reindex')} aria-label="reindex">
                {isReindexing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </NotionButton>
            )}
          </div>
        </div>

        {/* 🆕 展开的详情区域 */}
        {isExpanded && (
          <div className="px-3 md:px-6 pb-4 md:pb-6 ml-7 md:ml-11 border-l border-border/40 space-y-3 md:space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-6 text-xs">
              {/* OCR 状态 - 只对教材和图片显示 */}
              {showOcrStatus && (
                <div>
                  <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">
                    {resource.resourceType === 'file' ? t('indexStatus.detail.textStatus') : t('indexStatus.detail.ocrStatus')}
                  </div>
                  <div className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border',
                    resource.hasOcr
                      ? 'bg-emerald-500/5 text-emerald-600 border-emerald-500/20'
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
                    <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.extractedTextIndex')}</div>
                    <div className="font-semibold tabular-nums text-foreground/90">
                      <span className="text-primary">
                        {t('indexStatus.detail.chunks', { count: resource.nativeTextChunkCount })}
                        {resource.textEmbeddingDim && ` (${resource.textEmbeddingDim}D)`}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.ocrTextIndex')}</div>
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
                  <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">
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
              
              {/* 原生多模态索引状态 - ★ 多模态索引已禁用时隐藏 */}
              {MULTIMODAL_INDEX_ENABLED && (
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.nativeMmIndex')}</div>
                <div className="flex flex-col gap-1.5">
                  {/* 状态标签 */}
                  <div className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium w-fit border',
                    resource.mmIndexState === 'indexed' && 'bg-emerald-500/5 text-emerald-600 border-emerald-500/20',
                    resource.mmIndexState === 'pending' && 'bg-warning/5 text-warning border-warning/20',
                    resource.mmIndexState === 'indexing' && 'bg-blue-500/5 text-blue-600 border-blue-500/20',
                    resource.mmIndexState === 'failed' && 'bg-red-500/5 text-red-600 border-red-500/20',
                    resource.mmIndexState === 'disabled' && 'bg-muted/50 text-muted-foreground border-transparent'
                  )}>
                    {resource.mmIndexState === 'indexed' && <CheckCircle className="h-3 w-3" />}
                    {resource.mmIndexState === 'pending' && <Clock className="h-3 w-3" />}
                    {resource.mmIndexState === 'indexing' && <RefreshCw className="h-3 w-3 animate-spin" />}
                    {resource.mmIndexState === 'failed' && <AlertCircle className="h-3 w-3" />}
                    {resource.mmIndexState === 'disabled' && <Ban className="h-3 w-3" />}
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

              {/* 索引模式 - ★ 多模态索引已禁用时简化显示 */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.indexMode')}</div>
                <div className={cn(
                  'inline-flex px-2 py-1 rounded text-xs font-medium border',
                  MULTIMODAL_INDEX_ENABLED && resource.mmIndexingMode
                    ? 'bg-violet-500/5 text-violet-600 border-violet-500/20'
                    : resource.textChunkCount > 0
                      ? 'bg-primary/5 text-primary border-primary/20'
                      : 'text-muted-foreground bg-muted/50 border-transparent'
                )}>
                  {MULTIMODAL_INDEX_ENABLED && resource.mmIndexingMode
                    ? (resource.mmIndexingMode === 'vl_embedding' ? 'VL-Embed' : 'VL+Text')
                    : resource.textChunkCount > 0
                      ? t('indexStatus.detail.pureText')
                      : t('indexStatus.detail.notIndexed')}
                </div>
              </div>
              
              {/* 资源 ID */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.resourceId')}</div>
                <div className="font-mono text-[10px] text-muted-foreground bg-muted/50 px-2 py-1 rounded border border-border/30 truncate select-all" title={resource.resourceId}>
                  {resource.resourceId}
                </div>
              </div>
              
              {/* 索引时间 */}
              <div>
                <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.indexTime')}</div>
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
                <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.updateTime')}</div>
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
                <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.status')}</div>
                <div className={cn(
                  'inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium border',
                  resource.isStale 
                    ? 'bg-orange-500/5 text-orange-600 border-orange-500/20'
                    : state === 'indexed'
                      ? 'bg-emerald-500/5 text-emerald-600 border-emerald-500/20'
                      : 'bg-muted/50 text-muted-foreground border-transparent'
                )}>
                  {resource.isStale ? (
                    <>
                      <AlertTriangle className="h-3 w-3" />
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
                  <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">
                    {state === 'disabled' ? t('indexStatus.detail.disabledReason') : isEmptyContent ? t('indexStatus.detail.contentNote') : t('indexStatus.detail.ocrTextIndexError')}
                  </div>
                  <div className={cn(
                    'px-3 py-2 rounded-md text-xs border',
                    state === 'disabled' 
                      ? 'bg-warning/5 text-warning border-warning/20'
                      : 'bg-red-500/5 text-red-700 border-red-500/20 dark:text-red-400'
                  )}>
                    {resource.textIndexError}
                  </div>
                </div>
              )}
              
              {/* 原生多模态索引错误信息（如果有）- ★ 多模态索引已禁用时隐藏 */}
              {MULTIMODAL_INDEX_ENABLED && resource.mmIndexError && (
                <div className="col-span-2 md:col-span-4">
                  <div className="text-muted-foreground/70 font-medium mb-1.5 uppercase tracking-wider text-[10px]">{t('indexStatus.detail.nativeMmIndexError')}</div>
                  <div className="bg-red-500/5 text-red-700 border border-red-500/20 dark:text-red-400 px-3 py-2 rounded-md text-xs">
                    {resource.mmIndexError}
                  </div>
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
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    // ★ 2026-02 修复：错误界面增加可操作指引
    const isEmbeddingError = error.includes('embedding') || error.includes('嵌入') || error.includes('模型');
    const isNetworkError = error.includes('network') || error.includes('网络') || error.includes('timeout') || error.includes('超时');
    const isDbError = error.includes('database') || error.includes('数据库') || error.includes('locked');
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <XCircle className="h-10 w-10 text-destructive/60" />
        <p className="text-sm text-muted-foreground text-center max-w-md">{error}</p>
        {isEmbeddingError && (
          <p className="text-xs text-warning">{t('indexStatus.notification.checkEmbeddingModel', { defaultValue: '请检查嵌入模型是否已正确配置（设置 → AI 模型）' })}</p>
        )}
        {isNetworkError && (
          <p className="text-xs text-warning">{t('indexStatus.notification.checkNetwork', { defaultValue: '请检查网络连接后重试' })}</p>
        )}
        {isDbError && (
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('indexStatus.notification.checkDb', { defaultValue: '数据库可能正忙，请稍后重试' })}</p>
        )}
        <NotionButton variant="ghost" size="sm" onClick={() => { loadData(); }} className="text-primary hover:bg-primary/10">
          {t('indexStatus.action.retry')}
        </NotionButton>
      </div>
    );
  }

  if (!summary) return null;

  // 需要处理的资源数量
  const needsActionCount = summary.pendingCount + summary.failedCount + summary.staleCount;

  return (
    <div className="flex flex-col h-full">
      {/* 顶部概览区 */}
      {isMobile ? (
        /* ==================== 移动端紧凑布局 ==================== */
        <div className="relative z-20 flex flex-col gap-2 px-3 py-2.5 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {/* 第一行：进度环 + 关键数字 + 操作按钮 */}
          <div className="flex items-center gap-3">
            {/* 进度环 - 紧凑 */}
            <ProgressRing
              percentage={MULTIMODAL_INDEX_ENABLED && summary.mmTotalResources > 0 ? overallProgressPercentage : progressPercentage}
              total={MULTIMODAL_INDEX_ENABLED && summary.mmTotalResources > 0 ? summary.totalResources + summary.mmTotalResources : summary.totalResources}
              indexed={MULTIMODAL_INDEX_ENABLED && summary.mmTotalResources > 0 ? summary.indexedCount + summary.mmIndexedCount : summary.indexedCount}
              size={56}
              strokeWidth={6}
            />
            {/* 关键数字 - 紧凑两行 */}
            <div className="flex-1 min-w-0 grid grid-cols-2 gap-x-3 gap-y-0.5">
              <div className="flex items-center gap-1.5 text-xs">
                <Database className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.totalVectors', { defaultValue: '总向量数' })}</span>
                <span className="font-semibold tabular-nums">{dimensions.reduce((acc, d) => acc + d.recordCount, 0).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <Workflow className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.dimensions', { defaultValue: '向量维度' })}</span>
                <span className="font-mono font-semibold">{dimensions.length > 0 ? dimensions[0].dimension : '-'}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <AlertCircle className={cn('h-3 w-3 shrink-0', summary.failedCount > 0 ? 'text-red-500' : 'text-muted-foreground')} />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.errors', { defaultValue: '索引错误' })}</span>
                <span className={cn('font-semibold tabular-nums', summary.failedCount > 0 && 'text-red-500')}>{summary.failedCount + summary.mmFailedCount}</span>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <Clock className={cn('h-3 w-3 shrink-0', summary.staleCount > 0 ? 'text-warning' : 'text-muted-foreground')} />
                <span className="text-muted-foreground shrink-0">{t('indexStatus.stats.stale', { defaultValue: '待更新' })}</span>
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
            <NotionButton variant="primary" size="sm" onClick={handleUnifiedIndex} disabled={batchIndexing || mmIndexing} className={cn('!px-3', batchIndexing || mmIndexing ? 'bg-muted text-muted-foreground' : 'bg-neutral-500 dark:bg-foreground text-white dark:text-background hover:bg-neutral-400 dark:hover:bg-foreground/90')}>
              {(batchIndexing || mmIndexing) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 fill-current" />}
              {batchIndexing ? t('indexStatus.action.ocrIndexing') : mmIndexing ? t('indexStatus.action.mmIndexing') : t('indexStatus.action.oneClickIndex')}
            </NotionButton>
            <NotionButton variant="default" size="sm" onClick={() => { loadData(); }} disabled={isLoading || batchIndexing}>
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
              {t('indexStatus.action.refresh')}
            </NotionButton>
            {/* 更多操作下拉 */}
            <div className="relative" ref={mobileMoreRef}>
              <NotionButton variant="default" size="sm" onClick={() => setMobileMoreOpen(v => !v)} className={cn(mobileMoreOpen && 'bg-accent text-accent-foreground')}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </NotionButton>
              {mobileMoreOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border bg-popover shadow-md py-1 animate-in fade-in-0 zoom-in-95">
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                    onClick={() => { setShowTestPanel(v => !v); setMobileMoreOpen(false); }}
                  >
                    <TestTube className="h-3.5 w-3.5" />
                    {t('indexStatus.action.recallTest')}
                  </button>
                  <button
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                    disabled={resetting || batchIndexing || mmIndexing}
                    onClick={() => { handleResetAllIndexState(); setMobileMoreOpen(false); }}
                  >
                    {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
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
                <span className="font-medium truncate">{batchMessage}</span>
                <span className="font-mono tabular-nums shrink-0 ml-2">{batchProgress}%</span>
              </div>
              <Progress value={batchProgress} className="h-1.5" />
            </div>
          )}
          {MULTIMODAL_INDEX_ENABLED && (mmIndexing || mmProgress > 0) && (
            <div className="space-y-1 bg-purple-500/5 p-2 rounded-md">
              <div className="flex items-center justify-between text-xs text-purple-600 dark:text-purple-400">
                <span className="font-medium truncate">{mmMessage}</span>
                <span className="font-mono tabular-nums shrink-0 ml-2">{mmProgress}%</span>
              </div>
              <Progress value={mmProgress} className="h-1.5 [&>div]:bg-purple-600" />
            </div>
          )}
        </div>
      ) : (
        /* ==================== 桌面端布局 ==================== */
        <div className="flex flex-row items-center gap-6 p-4 lg:p-6 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          {/* ★ 2026-02 修复：环形进度图 - 多模态索引已禁用时只显示文本进度 */}
          <div className="flex items-center gap-4 lg:gap-6 shrink-0">
            {/* 综合进度环（当有多模态资源时显示，且多模态已启用） */}
            {MULTIMODAL_INDEX_ENABLED && summary.mmTotalResources > 0 ? (
              <>
                <div className="flex flex-col items-center gap-2">
                  <ProgressRing
                    percentage={overallProgressPercentage}
                    total={summary.totalResources + summary.mmTotalResources}
                    indexed={summary.indexedCount + summary.mmIndexedCount}
                    size={80}
                    strokeWidth={8}
                  />
                  <span className="text-xs font-medium text-muted-foreground">{t('indexStatus.progress.overallProgress', { defaultValue: '综合进度' })}</span>
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
                      <span className="text-xs font-medium">{t('indexStatus.progress.text', { defaultValue: '文本' })}</span>
                      <span className="text-[10px] text-muted-foreground">{summary.indexedCount}/{summary.totalResources}</span>
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
                      <span className="text-xs font-medium">{t('indexStatus.progress.multimodal', { defaultValue: '多模态' })}</span>
                      <span className="text-[10px] text-muted-foreground">{summary.mmIndexedCount}/{summary.mmTotalResources}</span>
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
                  <span className="text-xs text-muted-foreground">{summary.indexedCount} / {summary.totalResources} {t('indexStatus.progress.items', { defaultValue: '项' })}</span>
                </div>
              </div>
            )}
          </div>

          {/* 中间信息区 */}
          <div className="flex-1 min-w-0 grid gap-3 lg:gap-4 content-center">
            {/* 关键指标卡片 */}
            <div className="grid grid-cols-4 gap-2 lg:gap-3">
              <div className="bg-muted/30 p-2 lg:p-3 rounded-md flex flex-col justify-between gap-0.5 lg:gap-1 group transition-colors">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
                  <Database className="h-3 w-3" />
                  <span className="truncate">{t('indexStatus.stats.totalVectors', { defaultValue: '总向量数' })}</span>
                </span>
                <span className="text-base lg:text-lg font-semibold tabular-nums text-foreground/90">
                  {dimensions.reduce((acc, d) => acc + d.recordCount, 0).toLocaleString()}
                </span>
              </div>
              
              <div className="bg-muted/30 p-2 lg:p-3 rounded-md flex flex-col justify-between gap-0.5 lg:gap-1 group transition-colors">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
                  <Workflow className="h-3 w-3" />
                  <span className="truncate">{t('indexStatus.stats.dimensions', { defaultValue: '向量维度' })}</span>
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
                    <span className="text-[10px] text-muted-foreground">+{dimensions.length - 2}</span>
                  )}
                </div>
              </div>

              <div className={cn(
                "p-2 lg:p-3 rounded-md flex flex-col justify-between gap-0.5 lg:gap-1 group transition-colors",
                summary.failedCount + summary.mmFailedCount > 0 
                  ? "bg-red-500/5" 
                  : "bg-muted/30"
              )}>
                <span className={cn(
                  "text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5",
                  summary.failedCount + summary.mmFailedCount > 0 ? "text-red-600/80 dark:text-red-400/80" : "text-muted-foreground"
                )}>
                  <AlertCircle className="h-3 w-3" />
                  <span className="truncate">{t('indexStatus.stats.errors', { defaultValue: '索引错误' })}</span>
                </span>
                <span className={cn(
                  "text-base lg:text-lg font-semibold tabular-nums",
                  summary.failedCount + summary.mmFailedCount > 0 ? "text-red-600 dark:text-red-400" : "text-foreground/90"
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
                  "text-[10px] uppercase tracking-wider font-medium flex items-center gap-1.5",
                  summary.staleCount > 0 ? "text-warning" : "text-muted-foreground"
                )}>
                  <Clock className="h-3 w-3" />
                  <span className="truncate">{t('indexStatus.stats.stale', { defaultValue: '待更新' })}</span>
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
                    <span className="font-medium">{batchMessage}</span>
                    <span className="font-mono tabular-nums">{batchProgress}%</span>
                  </div>
                  <Progress value={batchProgress} className="h-2" />
                </div>
              )}

              {/* 原生多模态索引进度条 - ★ 多模态索引已禁用时隐藏 */}
              {MULTIMODAL_INDEX_ENABLED && (mmIndexing || mmProgress > 0) && (
                <div className="space-y-1.5 bg-purple-500/5 p-2 rounded-md">
                  <div className="flex items-center justify-between text-xs text-purple-600 dark:text-purple-400">
                    <span className="font-medium">{mmMessage}</span>
                    <span className="font-mono tabular-nums">{mmProgress}%</span>
                  </div>
                  <Progress value={mmProgress} className="h-2 [&>div]:bg-purple-600" />
                </div>
              )}
            </div>
          </div>

          {/* 右侧操作按钮 - 纵向排列 */}
          <div className="flex flex-col gap-1.5 lg:gap-2 shrink-0 min-w-[140px]">
            <NotionButton variant="primary" size="sm" onClick={handleUnifiedIndex} disabled={batchIndexing || mmIndexing} className={cn(batchIndexing || mmIndexing ? 'bg-muted text-muted-foreground' : 'bg-neutral-500 dark:bg-foreground text-white dark:text-background hover:bg-neutral-400 dark:hover:bg-foreground/90')}>
              {(batchIndexing || mmIndexing) ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5 fill-current" />
              )}
              {batchIndexing ? t('indexStatus.action.ocrIndexing') : mmIndexing ? t('indexStatus.action.mmIndexing') : t('indexStatus.action.oneClickIndex')}
            </NotionButton>
            
            <div className="grid grid-cols-2 gap-2">
              <NotionButton variant="default" size="sm" onClick={() => { loadData(); }} disabled={isLoading || batchIndexing} title={t('indexStatus.action.refreshTitle', { defaultValue: '刷新向量化状态' })}>
                <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
                {t('indexStatus.action.refresh')}
              </NotionButton>
              <NotionButton variant="default" size="sm" onClick={() => setShowTestPanel(!showTestPanel)} className={cn(showTestPanel && 'bg-accent text-accent-foreground')}>
                <TestTube className="h-3.5 w-3.5" />
                {t('indexStatus.action.recallTest')}
              </NotionButton>
            </div>
            
            <NotionButton variant="ghost" size="sm" onClick={handleResetAllIndexState} disabled={resetting || batchIndexing || mmIndexing} title={t('indexStatus.action.resetStateTitle')} className="text-muted-foreground hover:text-destructive hover:bg-destructive/5">
              {resetting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {t('indexStatus.action.resetState')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* 召回测试面板 */}
      {showTestPanel && (
        <div className="border-b bg-background/50 backdrop-blur p-3 md:p-6 animate-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-md bg-primary/10 text-primary">
                <TestTube className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-medium">{t('indexStatus.test.title')}</h3>
                <p className="text-xs text-muted-foreground">{t('indexStatus.test.description')}</p>
              </div>
            </div>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setShowTestPanel(false)} aria-label="close">
              <X className="h-4 w-4" />
            </NotionButton>
          </div>
          
          {/* 搜索输入 - Notion 风格 */}
          <div className="flex gap-2 max-w-3xl">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={testQuery}
                onChange={(e) => setTestQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleTestSearch()}
                placeholder={t('indexStatus.test.placeholder')}
                className="w-full h-10 pl-9 pr-4 text-sm bg-muted/50 border-transparent rounded-md focus:bg-background focus:ring-2 focus:ring-primary/20 transition-all placeholder:text-muted-foreground/70"
                autoFocus
              />
            </div>
            <NotionButton variant="primary" size="sm" onClick={handleTestSearch} disabled={testLoading || !testQuery.trim()} className="!h-10 !px-6">
              {testLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Search className="h-4 w-4" />
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
                  <AlertCircle className="h-4 w-4" />
                  {testError}
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
                        <div key={result.embeddingId} className="p-4 hover:bg-muted/30 transition-colors">
                          <div className="flex items-start gap-3 mb-2">
                            <span className="flex items-center justify-center w-5 h-5 rounded bg-primary/10 text-primary text-[10px] font-mono font-medium shrink-0 mt-0.5">
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
                                <span>Block #{result.chunkIndex}</span>
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

      {/* 筛选栏 */}
      <div className="flex items-center gap-2 px-3 md:px-6 py-2 md:py-3 border-b bg-background/50 backdrop-blur sticky top-0 z-10">
        <div className="flex-1 min-w-0 flex flex-wrap items-center gap-1.5 md:gap-2">
          <span className="text-xs font-medium text-muted-foreground shrink-0 uppercase tracking-wider">{t('indexStatus.filter.typeFilter')}</span>
          {['all', 'note', 'textbook', 'exam', 'translation', 'essay', 'mindmap', 'file', 'image'].map((type) => {
            const isActive = selectedType === type;
            const label = type === 'all' ? t('indexStatus.filter.all') : (RESOURCE_TYPE_CONFIG[type]?.labelKey ? t(RESOURCE_TYPE_CONFIG[type].labelKey) : type);
            return (
              <NotionButton key={type} variant="ghost" size="sm" onClick={() => setSelectedType(type)} className={cn('!rounded-full !px-2.5 !py-1 text-xs font-medium border', isActive ? 'bg-primary text-primary-foreground border-primary shadow-sm' : 'bg-background text-muted-foreground border-transparent hover:bg-muted hover:text-foreground')}>
                {label}
              </NotionButton>
            );
          })}
        </div>
        {!isMobile && (
          <div className="text-xs font-mono text-muted-foreground shrink-0 pl-2 md:pl-4 border-l border-border/50 whitespace-nowrap">
            <span className="font-semibold text-foreground">{summary.resources.length}</span>
            <span className="mx-1 text-muted-foreground/50">/</span>
            <span>{summary.totalResources}</span>
          </div>
        )}
      </div>

      {/* 分组资源列表 */}
      <CustomScrollArea className="flex-1">
        {summary.resources.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
            <Database className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm">{t('indexStatus.empty.noMatchingResources')}</p>
            <p className="text-xs mt-1 opacity-60">{t('indexStatus.empty.adjustFilters')}</p>
          </div>
        ) : selectedState === 'all' ? (
          // 分组显示模式
          <div className="divide-y divide-border/30">
            {(['pending', 'indexing', 'failed', 'indexed', 'disabled'] as IndexState[]).map((state) => {
              const resources = groupedResources[state] || [];
              if (resources.length === 0) return null;
              
              const config = STATE_CONFIG[state];
              const Icon = config.icon;
              const isExpanded = expandedGroups.has(state);
              
              return (
                <div key={state}>
                  {/* 分组标题 */}
                  <NotionButton variant="ghost" size="sm" onClick={() => toggleGroup(state)} className={cn('w-full !justify-start !px-3 md:!px-4 !py-2 md:!py-2.5', config.bgColor)}>
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                    <Icon className={cn('h-4 w-4', config.color)} />
                    <span className={config.color}>{t(config.labelKey)}</span>
                    <span className="text-muted-foreground font-normal">({resources.length})</span>
                  </NotionButton>
                  
                  {/* 分组内容 */}
                  {isExpanded && (
                    <div className="bg-background/50">
                      {resources.map(renderResourceRow)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          // 单状态筛选模式
          <div className="divide-y divide-border/30">
            {summary.resources.map(renderResourceRow)}
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default IndexStatusView;
