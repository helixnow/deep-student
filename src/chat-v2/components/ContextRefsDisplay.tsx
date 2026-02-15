/**
 * Chat V2 - ContextRefsDisplay 上下文引用显示组件
 *
 * 在用户消息中显示上下文引用卡片，支持点击预览
 *
 * ★ 统一改造说明（2026-02-02）：
 * 将 ContextRefsDisplay 和 MessageAttachments 两个组件合并为一个组件
 * - 普通类型引用（note、textbook、exam 等）：显示图标 + 标签
 * - image 类型：显示 64x64 缩略图，点击全屏查看（InlineImageViewer）
 * - file 类型：显示文件图标 + 文件名，点击预览
 *   - 富文档（PDF/DOCX 等）：发送 CHAT_OPEN_ATTACHMENT_PREVIEW 事件
 *   - 纯文本：使用 InlineDocumentViewer 内联预览
 *
 * 功能：
 * 1. 遍历 refs，使用 contextTypeRegistry.getLabel() 获取标签
 * 2. 根据 typeId 映射图标（内置映射 + 扩展支持）
 * 3. 点击时调用 onPreview，打开预览
 * 4. 显示真实文件夹路径（文档28改造）
 * 5. 图片/文件的特殊渲染和预览集成
 */

import React, { useCallback, useMemo, useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';  // 用于 ContextRefItem 获取 locale
import {
  FileText,
  ClipboardList,
  Image,
  Paperclip,
  Search,
  FileSpreadsheet,
  BookOpen,
  File,
  PenTool,
  Languages,
  type LucideIcon,
  Maximize2,
} from 'lucide-react';
import { cn } from '@/utils/cn';
import { contextTypeRegistry } from '../context';
import type { ContextRef, ContextSnapshot } from '../context/types';
import { InlineImageViewer } from './InlineImageViewer';
import { InlineDocumentViewer } from './InlineDocumentViewer';
import { 
  getFileTypeIconByMime,
  NoteIcon,
  TextbookIcon,
  ExamIcon,
  EssayIcon,
  TranslationIcon,
  MindmapIcon,
  GenericFileIcon,
  type ResourceIconProps
} from '@/components/learning-hub/icons/ResourceIcons';
import type { ImagePreview } from '../hooks/useImagePreviewsFromRefs';
import type { FilePreview } from '../hooks/useFilePreviewsFromRefs';

// ============================================================================
// 类型定义
// ============================================================================

export interface ContextRefsDisplayProps {
  /** 上下文快照 */
  contextSnapshot?: ContextSnapshot;
  /** 点击引用时的回调（可选，用于打开预览，适用于非 file/image 类型） */
  onPreview?: (ref: ContextRef) => void;
  /** 自定义类名 */
  className?: string;
  /** 是否紧凑模式（默认 false） */
  compact?: boolean;
  /** 图片预览列表（从 useImagePreviewsFromRefs 获取） */
  imagePreviews?: ImagePreview[];
  /** 文件预览列表（从 useFilePreviewsFromRefs 获取） */
  filePreviews?: FilePreview[];
  /** 图片是否正在加载 */
  isLoadingImages?: boolean;
  /** 文件是否正在加载 */
  isLoadingFiles?: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 判断文件是否为富文档（需要在学习资源管理器中打开）
 * PDF、Word、Excel、PowerPoint 等需要专门的预览器
 */
function isRichDocument(mimeType: string, fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  // 扩展名优先判断
  const richExtensions = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp'];
  if (richExtensions.includes(ext)) {
    return true;
  }
  
  // MIME 类型兜底
  return (
    mimeType.includes('pdf') ||
    mimeType.includes('word') ||
    mimeType.includes('msword') ||
    mimeType.includes('wordprocessingml') ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    mimeType.includes('presentationml') ||
    mimeType.includes('powerpoint')
  );
}

/**
 * 在聊天页面右侧面板打开文件预览
 * 通过 CHAT_OPEN_ATTACHMENT_PREVIEW 事件触发
 */
function openInChatPanel(file: FilePreview): void {
  // 推断资源类型
  const resourceType = 'file'; // 附件统一使用 file 类型
  
  console.log('[ContextRefsDisplay] openInChatPanel:', {
    sourceId: file.sourceId,
    fileName: file.name,
    mimeType: file.mimeType,
    resourceType,
  });
  
  // 发送事件让 ChatV2Page 在右侧面板打开附件
  window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
    detail: {
      id: file.sourceId,
      type: resourceType,
      title: file.name,
    }
  }));
}

// ============================================================================
// 图标映射
// ============================================================================

/**
 * 获取类型对应的 ResourceIcon 组件
 */
function getResourceIconComponent(typeId: string): React.FC<ResourceIconProps> {
  switch (typeId) {
    case 'note': return NoteIcon;
    case 'textbook': return TextbookIcon;
    case 'exam': return ExamIcon;
    case 'essay': return EssayIcon;
    case 'translation': return TranslationIcon;
    case 'mindmap': return MindmapIcon;
    case 'file': return GenericFileIcon;
    default: return GenericFileIcon;
  }
}

// ============================================================================
// 单个引用项组件
// ============================================================================

/** 默认显示的最大引用数量（折叠时） */
const DEFAULT_VISIBLE_COUNT = 8; // 增加显示数量，因为网格布局能容纳更多

interface ContextRefItemProps {
  ref_: ContextRef;
  onClick?: () => void;
  compact?: boolean;
  /** 资源的真实路径（用于 tooltip 显示） */
  path?: string;
}

const ContextRefItem: React.FC<ContextRefItemProps> = ({
  ref_,
  onClick,
  compact = false,
  path,
}) => {
  const { i18n } = useTranslation('chatV2');
  const locale = i18n.language.startsWith('zh') ? 'zh' : 'en';

  const typeLabel = useMemo(() => {
    return contextTypeRegistry.getLabel(ref_.typeId, locale as 'zh' | 'en');
  }, [ref_.typeId, locale]);

  // 使用 ResourceIcons 获取统一的方形图标
  const IconComponent = getResourceIconComponent(ref_.typeId);

  const displayText = ref_.displayName || typeLabel;

  const tooltipText = useMemo(() => {
    if (path) {
      return `${typeLabel}: ${path}`;
    }
    if (ref_.displayName) {
      return `${typeLabel}: ${ref_.displayName}`;
    }
    return `${typeLabel}: ${ref_.resourceId}`;
  }, [typeLabel, path, ref_.displayName, ref_.resourceId]);

  return (
    <div
      className={cn(
        "relative w-16 h-16 rounded-xl overflow-hidden border border-border/40",
        "bg-background hover:bg-muted/30 transition-colors shadow-sm",
        "flex flex-col items-center justify-center cursor-pointer",
        "group shrink-0"
      )}
      title={tooltipText}
      onClick={onClick}
    >
      <div className="shrink-0 drop-shadow-sm mt-1 transform group-hover:scale-110 transition-transform duration-200">
        <IconComponent size={32} />
      </div>
      <span className="text-[9px] text-foreground/80 font-medium truncate w-full text-center px-1 mt-0.5">
        {displayText}
      </span>
    </div>
  );
};

// ============================================================================
// 图片引用项组件（显示缩略图）
// ============================================================================

interface ImageRefItemProps {
  preview: ImagePreview;
  onClick?: () => void;
}

const ImageRefItem: React.FC<ImageRefItemProps> = ({ preview, onClick }) => {
  return (
    <div
      className={cn(
        "relative w-16 h-16 rounded-xl overflow-hidden border border-border/40",
        "bg-background hover:bg-muted/30 transition-colors shadow-sm",
        "group cursor-pointer shrink-0"
      )}
      title={preview.name}
      onClick={onClick}
    >
      <img
        src={preview.previewUrl}
        alt={preview.name}
        className="w-full h-full object-cover"
      />
      {/* Hover 遮罩 */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity">
        <Maximize2 className="w-5 h-5 text-white drop-shadow-md" />
      </div>
    </div>
  );
};

// ============================================================================
// 文件引用项组件（显示图标 + 文件名）
// ============================================================================

interface FileRefItemProps {
  preview: FilePreview;
  onClick?: () => void;
}

const FileRefItem: React.FC<FileRefItemProps> = ({ preview, onClick }) => {
  const FileIcon = getFileTypeIconByMime(preview.mimeType);

  return (
    <div
      className={cn(
        "relative w-16 h-16 rounded-xl overflow-hidden border border-border/40",
        "bg-background hover:bg-muted/30 transition-colors shadow-sm",
        "flex flex-col items-center justify-center cursor-pointer",
        "group shrink-0"
      )}
      title={preview.name}
      onClick={onClick}
    >
      <div className="shrink-0 drop-shadow-sm mt-1 transform group-hover:scale-110 transition-transform duration-200">
        <FileIcon size={32} />
      </div>
      <span className="text-[9px] text-foreground/80 font-medium truncate w-full text-center px-1 mt-0.5">
        {preview.name}
      </span>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ContextRefsDisplay 上下文引用显示组件
 *
 * 显示用户消息中的上下文引用卡片
 * ★ 统一组件：合并了原 ContextRefsDisplay 和 MessageAttachments 的功能
 * 
 * 视觉重构：
 * 统一采用方形卡片 (16x16, 64px) 布局，无论是文件、图片还是普通引用。
 */
export const ContextRefsDisplay: React.FC<ContextRefsDisplayProps> = ({
  contextSnapshot,
  onPreview,
  className,
  compact = false,
  imagePreviews = [],
  filePreviews = [],
  isLoadingImages = false,
  isLoadingFiles = false,
}) => {
  const { t } = useTranslation('chatV2');

  // 展开/折叠状态
  const [isExpanded, setIsExpanded] = useState(false);

  // ★ 图片预览器状态
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // ★ 文档预览器状态
  const [docViewerOpen, setDocViewerOpen] = useState(false);
  const [docViewerFile, setDocViewerFile] = useState<FilePreview | null>(null);

  // 合并用户引用和检索引用
  const allRefs = useMemo(() => {
    if (!contextSnapshot) return [];
    const refs: ContextRef[] = [];
    if (contextSnapshot.userRefs?.length) {
      refs.push(...contextSnapshot.userRefs);
    }
    if (contextSnapshot.retrievalRefs?.length) {
      refs.push(...contextSnapshot.retrievalRefs);
    }
    return refs;
  }, [contextSnapshot]);

  // ★ 分离 image 和 file 类型引用（这些使用特殊渲染，通过 imagePreviews/filePreviews props 控制）
  const normalRefs = useMemo(() => {
    return allRefs.filter(ref => ref.typeId !== 'image' && ref.typeId !== 'file');
  }, [allRefs]);

  // 处理点击事件（普通引用）
  const handleClick = useCallback(
    (ref: ContextRef) => {
      if (onPreview) {
        onPreview(ref);
      }
    },
    [onPreview]
  );

  // ★ 处理图片点击
  const imageUrls = useMemo(() => imagePreviews.map((p) => p.previewUrl), [imagePreviews]);
  
  const handleOpenImageViewer = useCallback((imageId: string) => {
    const index = imagePreviews.findIndex((p) => p.id === imageId);
    if (index !== -1) {
      setCurrentImageIndex(index);
      setImageViewerOpen(true);
    }
  }, [imagePreviews]);

  // ★ 处理文件点击
  const handleFileClick = useCallback((file: FilePreview) => {
    if (isRichDocument(file.mimeType, file.name)) {
      // 富文档：在聊天页面右侧面板打开
      openInChatPanel(file);
    } else {
      // 简单文本：使用内联文档查看器
      setDocViewerFile(file);
      setDocViewerOpen(true);
    }
  }, []);

  // 没有引用、图片、文件时不渲染
  const hasContent = normalRefs.length > 0 || imagePreviews.length > 0 || filePreviews.length > 0;
  if (!hasContent && !isLoadingImages && !isLoadingFiles) {
    return null;
  }

  // 计算显示项
  // 顺序：图片 -> 文件 -> 普通引用
  // 合并为一个渲染列表，以便控制展开/折叠
  
  // 图片项
  const renderImages = () => imagePreviews.map((preview) => ({
    type: 'image' as const,
    key: `img-${preview.id}`,
    render: () => (
      <ImageRefItem
        key={`img-${preview.id}`}
        preview={preview}
        onClick={() => handleOpenImageViewer(preview.id)}
      />
    )
  }));

  // 文件项
  const renderFiles = () => filePreviews.map((preview) => ({
    type: 'file' as const,
    key: `file-${preview.id}`,
    render: () => (
      <FileRefItem
        key={`file-${preview.id}`}
        preview={preview}
        onClick={() => handleFileClick(preview)}
      />
    )
  }));

  // 普通引用项
  const renderNormals = () => normalRefs.map((ref) => ({
    type: 'normal' as const,
    key: `ref-${ref.resourceId}-${ref.hash}`,
    render: () => (
      <ContextRefItem
        key={`ref-${ref.resourceId}-${ref.hash}`}
        ref_={ref}
        onClick={onPreview ? () => handleClick(ref) : undefined}
        compact={compact}
        path={contextSnapshot?.pathMap?.[ref.resourceId]}
      />
    )
  }));

  // 所有渲染项
  const allItems = [
    ...renderImages(),
    ...renderFiles(),
    ...renderNormals(),
  ];

  // 折叠逻辑
  const needsCollapse = allItems.length > DEFAULT_VISIBLE_COUNT;
  const visibleItems = (needsCollapse && !isExpanded) ? allItems.slice(0, DEFAULT_VISIBLE_COUNT) : allItems;
  const hiddenCount = allItems.length - visibleItems.length;

  return (
    <div className={cn('flex flex-col items-end gap-2', className)}>
      {/* 网格布局容器，自动换行，右对齐 */}
      <div className="flex flex-wrap gap-2 justify-end">
        
        {/* Loading 占位符 */}
        {isLoadingImages && (
          <div className="w-16 h-16 rounded-xl border border-border/40 flex items-center justify-center bg-muted/30 shrink-0">
             <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        )}
        
        {/* 渲染可见项 */}
        {visibleItems.map(item => item.render())}
        
      </div>
      
      {/* 展开/折叠按钮 */}
      {needsCollapse && (
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={() => setIsExpanded(!isExpanded)}
          className="!h-auto !px-2 !py-0.5 border border-border/50 hover:border-border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          {isExpanded ? (
            <span>{t('contextRefs.collapse')}</span>
          ) : (
            <span>{t('contextRefs.showMore', { count: hiddenCount })}</span>
          )}
        </NotionButton>
      )}

      {/* ★ 图片预览器 */}
      {imageUrls.length > 0 && (
        <InlineImageViewer
          images={imageUrls}
          currentIndex={currentImageIndex}
          isOpen={imageViewerOpen}
          onClose={() => setImageViewerOpen(false)}
          onNext={() => setCurrentImageIndex((prev) => (prev + 1) % imageUrls.length)}
          onPrev={() => setCurrentImageIndex((prev) => (prev - 1 + imageUrls.length) % imageUrls.length)}
        />
      )}

      {/* ★ 文档预览器 */}
      <InlineDocumentViewer
        isOpen={docViewerOpen}
        title={docViewerFile?.name || t('messageItem.documentPreview')}
        textContent={docViewerFile?.content || null}
        onClose={() => {
          setDocViewerOpen(false);
          setDocViewerFile(null);
        }}
        fileName={docViewerFile?.name}
      />
    </div>
  );
};

// 引入 Loader2
import { Loader2 } from 'lucide-react';

// ============================================================================
// 辅助函数：检查是否有上下文引用
// ============================================================================

/**
 * 检查消息是否有上下文引用
 */
export function hasContextRefs(contextSnapshot?: ContextSnapshot): boolean {
  if (!contextSnapshot) return false;
  const userCount = contextSnapshot.userRefs?.length || 0;
  const retrievalCount = contextSnapshot.retrievalRefs?.length || 0;
  return userCount + retrievalCount > 0;
}

export default ContextRefsDisplay;
