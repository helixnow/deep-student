/**
 * UnifiedAppPanel - 统一应用面板
 *
 * Learning Hub 的唯一原生应用面板，所有资源类型共用同一个底层容器。
 * 通过 DSTU 协议获取资源上下文，根据资源类型动态渲染对应的内容视图。
 *
 * 支持的资源类型：
 * - note: 笔记
 * - textbook: 教材
 * - exam: 题目集识别
 * - translation: 翻译
 * - essay: 作文批改
 */

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, CircleNotch, WarningCircle } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { dstu } from '@/dstu';
import { reportError } from '@/shared/result';
import type { DstuNode } from '@/dstu/types';
import type { ResourceType } from '../types';
import { NotionButton } from '@/components/ui/NotionButton';
import { AppContentErrorBoundary } from './AppContentErrorBoundary';

// 🔧 修复：NoteContentView 不使用懒加载（避免 Suspense 导致 Crepe 初始化卡住）
import NoteContentView from './views/NoteContentView';

// 懒加载其他资源类型的内容视图
const TextbookContentView = lazy(() => import('./views/TextbookContentView'));
const ExamContentView = lazy(() => import('./views/ExamContentView'));
const TranslationContentView = lazy(() => import('./views/TranslationContentView'));
const EssayContentView = lazy(() => import('./views/EssayContentView'));
const ImageContentView = lazy(() => import('./views/ImageContentView'));
const FileContentView = lazy(() => import('./views/FileContentView'));
// 🔧 MindMapContentView
const MindMapContentView = lazy(() => import('@/features/mindmap/MindMapContentView').then(module => ({ default: module.MindMapContentView })));

// ============================================================================
// 类型定义
// ============================================================================

export interface UnifiedAppPanelProps {
  /** 资源类型 */
  type: ResourceType;
  /** 资源 ID */
  resourceId: string;
  /** DSTU 真实路径（用户在 Learning Hub 中看到的文件夹路径，如 /1111/abc.pdf） */
  dstuPath: string;
  /** 关闭回调 */
  onClose?: () => void;
  /** 标题变更回调（资源加载后更新标题） */
  onTitleChange?: (title: string) => void;
  /** 是否只读（透传给各 ContentView） */
  readOnly?: boolean;
  /** ★ 标签页：当前面板是否为活跃面板 */
  isActive?: boolean;
  /** 递增时强制重新加载资源（移动端「重载标签页」） */
  reloadNonce?: number;
  /** 自定义类名 */
  className?: string;
  /** Workbench resource windows must not render a different app behind their shell. */
  strictType?: boolean;
}

export interface ContentViewProps {
  /** DSTU 节点数据 */
  node: DstuNode;
  /** 关闭回调 */
  onClose?: () => void;
  /** 标题变更回调（子视图标题更新后通知父级同步） */
  onTitleChange?: (title: string) => void;
  /** 是否只读 */
  readOnly?: boolean;
  /** ★ 标签页：当前视图是否为活跃标签页 */
  isActive?: boolean;
}

// ============================================================================
// 组件实现
// ============================================================================

/** 可由 node.type 自动纠正路由的资源类型集合 */
const SUPPORTED_TYPES: readonly ResourceType[] = [
  'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap',
];

/**
 * 加载指示延迟：快速加载（< 该阈值）不闪现 spinner，切换资源时视觉更平滑。
 * 延迟期间面板保持空白背景（布局尺寸不变），超时后才显示加载 UI。
 */
const LOADING_INDICATOR_DELAY_MS = 150;

/** 统一加载占位（初始加载与懒加载 Suspense 共用，避免两种加载态样式不一致） */
const PanelLoading: React.FC<{ label: string; delayMs?: number }> = ({
  label,
  delayMs = LOADING_INDICATOR_DELAY_MS,
}) => {
  const [visible, setVisible] = useState(delayMs <= 0);

  useEffect(() => {
    if (delayMs <= 0) return;
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);

  // 占位容器始终撑满面板（h-full），避免 spinner 出现/消失引起滚动条或布局跳动
  return (
    <div className="flex items-center justify-center h-full" role="status" aria-live="polite">
      {visible && (
        <>
          <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="ml-2 text-muted-foreground">{label}</span>
        </>
      )}
    </div>
  );
};

/**
 * 统一应用面板
 */
export const UnifiedAppPanel: React.FC<UnifiedAppPanelProps> = ({
  type,
  resourceId,
  dstuPath,
  onClose,
  onTitleChange,
  readOnly,
  isActive,
  reloadNonce = 0,
  className,
  strictType = false,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);

  // 状态
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [localReloadNonce, setLocalReloadNonce] = useState(0);

  // ★ 标签页修复：用 ref 持有 onTitleChange，避免其引用变化导致 useEffect 重新触发 dstu.get()
  //   TabPanelContainer 在 tab 增删时会重建闭包，如果 onTitleChange 在 deps 中会导致所有已有 tab 重新加载
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  // ★ onClose 同理走 ref，保证传给子视图的 commonProps 引用稳定（避免父级重建闭包导致子视图无谓重渲染）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // ★ 资源标识变化时在 render 阶段同步进入加载态（React 官方「根据 props 调整 state」模式），
  //   消除 effect 生效前旧资源内容在新标识下多渲染一帧的问题
  const loadKey = `${resourceId}:${dstuPath}:${reloadNonce}:${localReloadNonce}`;
  const [prevLoadKey, setPrevLoadKey] = useState(loadKey);
  if (prevLoadKey !== loadKey) {
    setPrevLoadKey(loadKey);
    setIsLoading(true);
    setError(null);
  }

  // 加载资源数据
  useEffect(() => {
    // ★ 竞态防护：resourceId 快速切换时，丢弃已过期请求的结果，避免旧资源覆盖新资源
    let cancelled = false;

    const loadResource = async () => {
      setIsLoading(true);
      setError(null);

      // ★ FIX: 始终使用 resourceId 获取资源（resourceId 总是包含合法的 DSTU ID 如 note_xxx）
      // dstuPath 可能是人类可读路径（如 "高考复习/笔记标题"），不包含 resource ID，
      // 传给 dstu.get() 会导致 "Invalid DSTU path: Path must contain a resource ID" 错误
      const path = resourceId.startsWith('/') ? resourceId : `/${resourceId}`;
      const result = await dstu.get(path);
      if (cancelled) return;

      if (!result.ok) {
        reportError(result.error, '加载资源');
        setError(result.error.toUserMessage());
        setIsLoading(false);
        return;
      }

      if (!result.value) {
        setError(t('error.resourceNotFound', '资源未找到'));
        setIsLoading(false);
        return;
      }

      setNode(result.value);
      onTitleChangeRef.current?.(result.value.name || t('common:untitled', '未命名'));
      setIsLoading(false);
    };

    void loadResource();
    return () => {
      cancelled = true;
    };
    // ★ 资源标识、真实路径或重载计数变化时重新加载；t 变化不触发资源重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId, dstuPath, reloadNonce, localReloadNonce]);

  // 稳定的标题回调：引用不随父级重渲染变化，避免破坏 commonProps 的 memo
  const handleTitleChange = useCallback((newTitle: string) => {
    onTitleChangeRef.current?.(newTitle);
  }, []);

  // 稳定的关闭回调；保持「未传 onClose 时子视图收到 undefined」的语义（子视图据此决定是否渲染关闭按钮）
  const hasOnClose = Boolean(onClose);
  const handleClose = useCallback(() => {
    onCloseRef.current?.();
  }, []);

  const shouldPreferExplicitType = type === 'image' || type === 'file';
  const rawNodeType = node?.type;
  const nodeType = node && SUPPORTED_TYPES.includes(node.type as ResourceType)
    ? (node.type as ResourceType)
    : null;
  const fileTypesAreCompatible =
    nodeType != null &&
    (type === 'image' || type === 'file') &&
    (nodeType === 'image' || nodeType === 'file');
  const typeMismatch =
    strictType && node != null && (nodeType == null || (nodeType !== type && !fileTypesAreCompatible))
      ? t('error.resourceTypeMismatch', '资源类型不匹配：窗口需要 {{expected}}，实际为 {{actual}}', {
          expected: type,
          actual: rawNodeType || 'unknown',
        })
      : null;
  const resolvedType: ResourceType = shouldPreferExplicitType
    ? type
    : (nodeType
      ? nodeType
      : type);

  // ★ 性能：memo 化 commonProps，避免每次渲染都传新对象给内容视图（导致其内部 effect/memo 失效）
  const commonProps = useMemo<ContentViewProps | null>(() => {
    if (!node) return null;
    return {
      node,
      onClose: hasOnClose ? handleClose : undefined,
      onTitleChange: handleTitleChange,
      readOnly,
      isActive,
    };
  }, [node, hasOnClose, handleClose, handleTitleChange, readOnly, isActive]);

  // ★ 性能：memo 化视图元素。元素引用不变时 React 会直接跳过该子树的重渲染
  //（即使子组件未包 React.memo），使父级因 className/闭包变化引起的重渲染不再波及内容视图
  const contentView = useMemo(() => {
    if (!node || !commonProps) return null;
    switch (resolvedType) {
      case 'note':
        return <NoteContentView {...commonProps} />;
      case 'textbook':
        return <TextbookContentView {...commonProps} />;
      case 'exam':
        return <ExamContentView {...commonProps} />;
      case 'translation':
        return <TranslationContentView {...commonProps} />;
      case 'essay':
        return <EssayContentView {...commonProps} />;
      case 'image':
        return <ImageContentView {...commonProps} />;
      case 'file':
        return <FileContentView {...commonProps} />;
      case 'mindmap':
        return <MindMapContentView resourceId={node.id} onTitleChange={handleTitleChange} isActive={isActive} className="h-full" />;
      default:
        return (
          <div className="flex items-center justify-center h-full text-muted-foreground" role="alert">
            {t('error.unsupportedType', '不支持的资源类型: {{type}}', { type: resolvedType })}
          </div>
        );
    }
  }, [node, commonProps, resolvedType, isActive, handleTitleChange, t]);

  // 加载状态（spinner 延迟显示，快速加载不闪烁）
  if (isLoading) {
    return (
      <div className={cn('flex flex-col h-full bg-background', className)}>
        <PanelLoading label={t('common:loading', '加载中...')} />
      </div>
    );
  }

  // 错误状态
  if (error || typeMismatch || !node || !commonProps) {
    return (
      <div
        className={cn('flex flex-col items-center justify-center h-full gap-4 bg-background', className)}
        role="alert"
      >
        <WarningCircle size={48} className="text-destructive" aria-hidden="true" />
        <p className="text-destructive text-center">
          {error || typeMismatch || t('error.resourceNotFound', '资源未找到')}
        </p>
        <div className="flex items-center gap-2">
          <NotionButton
            variant="outline"
            size="sm"
            onClick={() => setLocalReloadNonce((n) => n + 1)}
            className="gap-1.5"
          >
            <ArrowClockwise size={14} aria-hidden="true" />
            {t('common:reload', '重新加载')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="ghost" size="sm" onClick={onClose}>
              {t('common:close', '关闭')}
            </NotionButton>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      <Suspense fallback={<PanelLoading label={t('common:loading', '加载中...')} />}>
        {/* resetKey：切换到其他资源/类型时自动清除上一个视图的崩溃状态；
            onClose：移动端崩溃兜底页的返回出路（关闭当前标签页） */}
        <AppContentErrorBoundary
          resourceType={resolvedType}
          resetKey={`${node.id}:${resolvedType}`}
          onClose={hasOnClose ? handleClose : undefined}
        >
          {contentView}
        </AppContentErrorBoundary>
      </Suspense>
    </div>
  );
};

export default UnifiedAppPanel;
