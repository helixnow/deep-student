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

import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle } from 'lucide-react';
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
const MindMapContentView = lazy(() => import('@/components/mindmap/MindMapContentView').then(module => ({ default: module.MindMapContentView })));

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
  /** 自定义类名 */
  className?: string;
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
  className,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);

  // 状态
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [node, setNode] = useState<DstuNode | null>(null);

  // ★ 标签页修复：用 ref 持有 onTitleChange，避免其引用变化导致 useEffect 重新触发 dstu.get()
  //   TabPanelContainer 在 tab 增删时会重建闭包，如果 onTitleChange 在 deps 中会导致所有已有 tab 重新加载
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;

  // 加载资源数据
  useEffect(() => {
    const loadResource = async () => {
      setIsLoading(true);
      setError(null);

      // ★ FIX: 始终使用 resourceId 获取资源（resourceId 总是包含合法的 DSTU ID 如 note_xxx）
      // dstuPath 可能是人类可读路径（如 "高考复习/笔记标题"），不包含 resource ID，
      // 传给 dstu.get() 会导致 "Invalid DSTU path: Path must contain a resource ID" 错误
      const path = resourceId.startsWith('/') ? resourceId : `/${resourceId}`;
      const result = await dstu.get(path);

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
  }, [dstuPath, resourceId, t, type]);

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full', className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
        </span>
      </div>
    );
  }

  // 错误状态
  if (error || !node) {
    return (
      <div className={cn('flex flex-col items-center justify-center h-full gap-4', className)}>
        <AlertCircle className="w-12 h-12 text-destructive" />
        <p className="text-destructive text-center">{error || t('error.resourceNotFound')}</p>
        {onClose && (
          <NotionButton variant="ghost" size="sm" onClick={onClose}>
            {t('common:close', '关闭')}
          </NotionButton>
        )}
      </div>
    );
  }

  const supportedTypes: ResourceType[] = [
    'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'mindmap',
  ];
  const shouldPreferExplicitType = type === 'image' || type === 'file';
  const resolvedType: ResourceType = shouldPreferExplicitType
    ? type
    : (node && supportedTypes.includes(node.type as ResourceType)
      ? (node.type as ResourceType)
      : type);
  const commonProps: ContentViewProps = {
    node,
    onClose,
    onTitleChange: (newTitle: string) => {
      onTitleChange?.(newTitle);
    },
    readOnly,
    isActive,
  };

  // 根据资源类型渲染对应的内容视图
  const renderContentView = () => {
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
        return <MindMapContentView resourceId={node.id} onTitleChange={onTitleChange} isActive={isActive} className="h-full" />;
      default:
        return (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            {t('error.unsupportedType', '不支持的资源类型: {{type}}', { type })}
          </div>
        );
    }
  };

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">
              {t('common:loading', '加载中...')}
            </span>
          </div>
        }
      >
        <AppContentErrorBoundary resourceType={resolvedType}>
          {renderContentView()}
        </AppContentErrorBoundary>
      </Suspense>
    </div>
  );
};

export default UnifiedAppPanel;
