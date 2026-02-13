/**
 * PreviewPanel - 统一学习资源预览面板
 *
 * 根据文档８《统一学习资源管理器架构设计》和文档１９ Prompt 8 实现
 *
 * 改造说明（Prompt D）：
 * - 原使用 `learning_hub_fetch_content` 命令已废弃
 * - 现改用 DSTU 访达协议层 API（dstu.getContent, dstu.get）
 *
 * 功能：
 * - 根据 previewType 切换不同的预览渲染器
 * - 支持 Markdown、PDF、Card（错题）、Image 四种预览类型
 * - 处理加载状态（骨架屏）和错误状态（友好提示）
 * - 支持亮色/暗色模式
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { Skeleton } from '../ui/shad/Skeleton';

// DSTU API 导入
import { dstu } from '@/dstu';
import i18next from 'i18next';
import { reportError } from '@/shared/result';
import { getErrorMessage } from '@/utils/errorUtils';
import type { DstuNode, DstuNodeType } from '@/dstu/types';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { LARGE_FILE_THRESHOLD } from '@/utils/base64FileUtils';

// 预览子组件
import { MarkdownPreview } from './preview/MarkdownPreview';
import { PDFPreview } from './preview/PDFPreview';
import { ImagePreview } from './preview/ImagePreview';

// 类型
import type { ReferenceNode, PreviewType } from './types/reference';
import type { PreviewPanelProps, PreviewStatus } from './preview/types';

// 图标
import {
  FileText,
  Folder,
  AlertCircle,
  MousePointerClick,
  FileQuestion,
} from 'lucide-react';

// ============================================================================
// DSTU API 调用
// ============================================================================

/**
 * SourceDatabase 到 DSTU NodeType 的映射
 */
const SOURCE_DB_TO_NODE_TYPE: Record<string, DstuNodeType> = {
  notes: 'note',
  textbooks: 'textbook',
};

/**
 * 内容获取结果
 */
interface FetchContentResult {
  success: boolean;
  error?: string;
  data?: {
    type: PreviewType;
    markdown?: string;
    pdfPath?: string;
    pdfBase64?: string;
    fileSize?: number;
    imageUrl?: string;
  };
}

function getMetadataString(node: DstuNode, key: string): string | undefined {
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const value = metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

function isProbablyBase64(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:')) return true;
  const cleaned = trimmed.replace(/\s+/g, '');
  if (cleaned.length % 4 === 1) return false;
  return /^[A-Za-z0-9+/=]+$/.test(cleaned);
}

function looksLikeFilePath(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed.startsWith('file://')) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  return false;
}

function looksLikePdfBase64(input: string): boolean {
  const cleaned = input.trim().replace(/\s+/g, '');
  return cleaned.startsWith('JVBERi0');
}

function guessImageMimeType(base64: string, fileName?: string, mimeType?: string): string {
  if (mimeType && mimeType.startsWith('image/')) return mimeType;
  const lowerName = (fileName || '').toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.gif')) return 'image/gif';
  if (lowerName.endsWith('.bmp')) return 'image/bmp';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';

  const head = base64.trim().slice(0, 12);
  if (head.startsWith('/9j/')) return 'image/jpeg';
  if (head.startsWith('iVBORw')) return 'image/png';
  if (head.startsWith('R0lGOD')) return 'image/gif';
  if (head.startsWith('UklGR')) return 'image/webp';
  if (head.startsWith('Qk')) return 'image/bmp';
  if (head.startsWith('PHN2Zy')) return 'image/svg+xml';
  return 'image/png';
}

/**
 * 获取引用内容
 * 使用 DSTU API (dstu.getContent, dstu.get) 获取
 */
async function fetchReferenceContent(
  referenceNode: ReferenceNode
): Promise<FetchContentResult> {
  // 构建 DSTU 路径
  const nodeType: DstuNodeType = SOURCE_DB_TO_NODE_TYPE[referenceNode.sourceDb] ?? 'file';
  const dstuPath = `/${referenceNode.sourceId}`;

  console.log('[PreviewPanel] Fetching content via DSTU:', dstuPath);

  // 先获取节点元数据（避免教材调用内容接口）
  const nodeResult = await dstu.get(dstuPath);

  if (!nodeResult.ok) {
    console.error('[PreviewPanel] Failed to fetch node via DSTU:', nodeResult.error);
    reportError(nodeResult.error, '获取引用节点');
    return {
      success: false,
      error: nodeResult.error.toUserMessage(),
    };
  }

  const node = nodeResult.value;
  if (!node) {
    return {
      success: false,
      error: i18next.t('notes:previewPanel.error.resourceNotFound'),
    };
  }

  const fileSize = typeof node.size === 'number' ? node.size : undefined;
  const metadataMimeType =
    getMetadataString(node, 'mimeType') ?? getMetadataString(node, 'mime_type');

  let content: string | Blob = '';
  let pdfBase64: string | undefined;
  if (referenceNode.sourceDb === 'textbooks') {
    const filePath =
      getMetadataString(node, 'filePath') ?? getMetadataString(node, 'file_path');
    content = typeof filePath === 'string' ? filePath : '';

    if (!content && referenceNode.previewType === 'pdf') {
      if (fileSize && fileSize > LARGE_FILE_THRESHOLD) {
        // 大文件不拉取 Base64，避免内存压力
      } else {
        try {
          const fileResult = await invoke<{ content: string | null; found: boolean }>('vfs_get_file_content', {
            fileId: referenceNode.sourceId,
          });
          if (fileResult?.found && fileResult?.content) {
            pdfBase64 = fileResult.content;
          }
        } catch (err: unknown) {
          console.error('[PreviewPanel] Failed to load PDF base64:', err);
        }
      }
    }
  } else {
    const contentResult = await dstu.getContent(dstuPath);
    if (!contentResult.ok) {
      console.error('[PreviewPanel] Failed to fetch content via DSTU:', contentResult.error);
      reportError(contentResult.error, '获取引用内容');
      return {
        success: false,
        error: contentResult.error.toUserMessage(),
      };
    }
    content = contentResult.value;
  }

  // 根据预览类型转换为前端期望格式
  switch (referenceNode.previewType) {
    case 'markdown':
      return {
        success: true,
        data: {
          type: 'markdown',
          markdown: typeof content === 'string' ? content : '',
        },
      };

    case 'pdf':
      // PDF 内容可能是文件路径或 base64
      let pdfPath = '';
      if (typeof content === 'string') {
        if (
          content.startsWith('data:') ||
          content.startsWith('http') ||
          content.startsWith('asset://') ||
          looksLikeFilePath(content)
        ) {
          pdfPath = content;
        } else if (!pdfBase64 && isProbablyBase64(content) && looksLikePdfBase64(content)) {
          pdfBase64 = content;
        }
      }
      return {
        success: true,
        data: {
          type: 'pdf',
          pdfPath,
          pdfBase64,
          fileSize,
        },
      };

    case 'image':
      // 图片内容：如果是 Blob 转为 data URL，否则假设是路径或 base64
      let imageUrl = '';
      if (content instanceof Blob) {
        imageUrl = URL.createObjectURL(content);
      } else if (typeof content === 'string') {
        // 如果已经是 data URL 或路径，直接使用
        if (content.startsWith('data:') || content.startsWith('http') || content.startsWith('asset://')) {
          imageUrl = content;
        } else if (isProbablyBase64(content)) {
          const mimeType = guessImageMimeType(content, referenceNode.title, metadataMimeType);
          imageUrl = `data:${mimeType};base64,${content}`;
        } else if (looksLikeFilePath(content)) {
          const filePath = content.startsWith('file://') ? content.replace(/^file:\/\//, '') : content;
          imageUrl = convertFileSrc(filePath);
        } else {
          imageUrl = content;
        }
      }
      return {
        success: true,
        data: {
          type: 'image',
          imageUrl,
        },
      };

    default:
      return {
        success: true,
        data: {
          type: 'none',
        },
      };
  }
}

// ============================================================================
// 空状态组件
// ============================================================================

/**
 * 未选中状态
 */
const EmptyState: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['notes']);

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 p-6 text-center',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <MousePointerClick className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('notes:previewPanel.empty.title')}
        </h3>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t('notes:previewPanel.empty.description')}
        </p>
      </div>
    </div>
  );
};

/**
 * 文件夹状态
 */
const FolderState: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['notes']);

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 p-6 text-center',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-50 dark:bg-blue-950/30">
        <Folder className="h-8 w-8 text-blue-500 dark:text-blue-400" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('notes:previewPanel.folder.title')}
        </h3>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t('notes:previewPanel.folder.description')}
        </p>
      </div>
    </div>
  );
};

/**
 * 不支持预览状态
 */
const UnsupportedState: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['notes']);

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 p-6 text-center',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('notes:previewPanel.unsupported.title')}
        </h3>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t('notes:previewPanel.unsupported.description')}
        </p>
      </div>
    </div>
  );
};

/**
 * 加载骨架屏
 */
const LoadingSkeleton: React.FC = () => (
  <div className="space-y-4 p-4">
    <div className="flex items-center gap-3">
      <Skeleton className="h-10 w-10 rounded-lg" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <Skeleton className="h-4 w-4/5" />
    <Skeleton className="h-32 w-full rounded-lg" />
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-2/3" />
  </div>
);

/**
 * 错误状态
 */
const ErrorState: React.FC<{ error: string; className?: string }> = ({
  error,
  className,
}) => {
  const { t } = useTranslation(['notes']);

  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 p-6 text-center',
        className
      )}
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="h-8 w-8 text-destructive" />
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">
          {t('notes:previewPanel.error.title')}
        </h3>
        <p className="max-w-xs text-xs text-muted-foreground">{error}</p>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * PreviewPanel 主组件
 *
 * 根据选中节点的类型和预览类型，渲染对应的预览内容
 */
export const PreviewPanel: React.FC<PreviewPanelProps> = ({
  nodeId,
  nodeType,
  referenceNode,
  className,
}) => {
  const { t } = useTranslation(['notes']);

  // 状态
  const [status, setStatus] = useState<PreviewStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<FetchContentResult['data'] | null>(null);

  /**
   * 加载引用内容
   */
  const loadContent = useCallback(async () => {
    if (!referenceNode) {
      setContent(null);
      setStatus('idle');
      return;
    }

    setStatus('loading');
    setError(null);

    try {
      const result = await fetchReferenceContent(referenceNode);

      if (result.success && result.data) {
        setContent(result.data);
        setStatus('success');
      } else {
        setError(result.error || t('notes:previewPanel.error.unknownError'));
        setStatus('error');
      }
    } catch (err: unknown) {
      console.error('[PreviewPanel] Failed to load content:', err);
      setError(getErrorMessage(err));
      setStatus('error');
    }
  }, [referenceNode, t]);

  // 当引用节点变化时重新加载
  useEffect(() => {
    if (nodeType === 'reference' && referenceNode) {
      loadContent();
    } else {
      setContent(null);
      setStatus('idle');
    }
  }, [nodeId, nodeType, referenceNode, loadContent]);

  // 清理图片 Blob URL，避免内存泄漏
  useEffect(() => {
    if (content?.type === 'image' && content.imageUrl?.startsWith('blob:')) {
      const url = content.imageUrl;
      return () => {
        URL.revokeObjectURL(url);
      };
    }
    return;
  }, [content?.type, content?.imageUrl]);

  // ========== 渲染逻辑 ==========

  // 1. 未选中任何节点
  if (!nodeId || !nodeType) {
    return <EmptyState className={className} />;
  }

  // 2. 选中的是文件夹
  if (nodeType === 'folder') {
    return <FolderState className={className} />;
  }

  // 3. 选中的是笔记（笔记不通过 PreviewPanel 预览，而是在编辑器中打开）
  if (nodeType === 'note') {
    return (
      <div
        className={cn(
          'flex h-full flex-col items-center justify-center gap-4 p-6 text-center',
          className
        )}
      >
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-50 dark:bg-green-950/30">
          <FileText className="h-8 w-8 text-green-500 dark:text-green-400" />
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">
            {t('notes:previewPanel.note.title')}
          </h3>
          <p className="max-w-xs text-xs text-muted-foreground">
            {t('notes:previewPanel.note.description')}
          </p>
        </div>
      </div>
    );
  }

  // 4. 选中的是引用节点
  if (nodeType === 'reference') {
    // 4.1 没有引用数据
    if (!referenceNode) {
      return <ErrorState error={t('notes:previewPanel.error.noReferenceData')} className={className} />;
    }

    // 4.2 加载中
    if (status === 'loading') {
      return (
        <div className={cn('h-full', className)}>
          <LoadingSkeleton />
        </div>
      );
    }

    // 4.3 加载错误
    if (status === 'error' && error) {
      return <ErrorState error={error} className={className} />;
    }

    // 4.4 根据 previewType 渲染对应的预览组件
    const previewType = content?.type || referenceNode.previewType;

    switch (previewType) {
      case 'markdown':
        return (
          <MarkdownPreview
            content={content?.markdown || ''}
            className={className}
          />
        );

      case 'pdf':
        return (
          <PDFPreview
            filePath={content?.pdfPath || ''}
            base64Content={content?.pdfBase64}
            fileSize={content?.fileSize}
            fileName={referenceNode.title}
            className={className}
          />
        );

      case 'image':
        return (
          <ImagePreview
            imageUrl={content?.imageUrl || ''}
            title={referenceNode.title}
            className={className}
          />
        );

      case 'none':
      default:
        return <UnsupportedState className={className} />;
    }
  }

  // 5. 未知类型
  return <UnsupportedState className={className} />;
};

export default PreviewPanel;
