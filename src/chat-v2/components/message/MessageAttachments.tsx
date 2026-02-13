/**
 * MessageAttachments - 消息附件预览组件
 * 
 * 预览策略：
 * - 富文档（PDF/DOCX/XLSX/PPTX）→ 在学习资源管理器应用面板中打开
 * - 简单文本文件 → 使用 InlineDocumentViewer 内联预览
 * - 图片 → 使用 InlineImageViewer 全屏预览
 */
import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { InlineImageViewer } from '../InlineImageViewer';
import { InlineDocumentViewer } from '../InlineDocumentViewer';
import type { FilePreview } from '../../hooks/useFilePreviewsFromRefs';
import { getFileTypeIconByMime } from '@/components/learning-hub/icons/ResourceIcons';

interface ImagePreview {
  id: string;
  name: string;
  previewUrl: string;
}

export interface MessageAttachmentsProps {
  imagePreviews: ImagePreview[];
  filePreviews: FilePreview[];
  isLoadingImages?: boolean;
  isLoadingFiles?: boolean;
  className?: string;
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
  
  console.log('[MessageAttachments] openInChatPanel:', {
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

export const MessageAttachments: React.FC<MessageAttachmentsProps> = ({
  imagePreviews,
  filePreviews,
  isLoadingImages,
  isLoadingFiles,
  className,
}) => {
  const { t } = useTranslation('chatV2');

  // 图片预览器状态
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // 文档预览器状态
  const [docViewerOpen, setDocViewerOpen] = useState(false);
  const [docViewerFile, setDocViewerFile] = useState<FilePreview | null>(null);

  const imageUrls = imagePreviews.map((p) => p.previewUrl);

  const handleOpenImageViewer = useCallback((imageId: string) => {
    const index = imagePreviews.findIndex((p) => p.id === imageId);
    if (index !== -1) {
      setCurrentImageIndex(index);
      setImageViewerOpen(true);
    }
  }, [imagePreviews]);

  /**
   * 处理文件点击
   * - 富文档 → 在聊天页面右侧面板打开
   * - 简单文本 → 使用内联文档查看器
   */
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

  if (imagePreviews.length === 0 && filePreviews.length === 0 && !isLoadingImages && !isLoadingFiles) {
    return null;
  }

  return (
    <div className={cn('space-y-2', className)}>
      {/* 图片预览 */}
      {imagePreviews.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-end">
          {isLoadingImages && (
            <div className="w-16 h-16 rounded-md border border-border flex items-center justify-center bg-muted">
              <span className="text-xs text-muted-foreground animate-pulse">{t('messageItem.loadingFiles')}</span>
            </div>
          )}
          {imagePreviews.map((preview) => (
            <div
              key={preview.id}
              className="relative w-16 h-16 rounded-md overflow-hidden border border-border flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all"
              title={preview.name}
              onClick={() => handleOpenImageViewer(preview.id)}
            >
              <img
                src={preview.previewUrl}
                alt={preview.name}
                className="w-full h-full object-cover pointer-events-none"
              />
            </div>
          ))}
        </div>
      )}

      {/* 文件预览 */}
      {filePreviews.length > 0 && (
        <div className="flex flex-wrap gap-2 justify-end">
          {filePreviews.map((file) => (
            <div
              key={file.id}
              className="relative w-16 h-16 rounded-md overflow-hidden border border-border flex-shrink-0 cursor-pointer hover:ring-2 hover:ring-primary/30 transition-all"
              title={file.name}
              onClick={() => handleFileClick(file)}
            >
              <div className="w-full h-full bg-muted flex flex-col items-center justify-center gap-0.5 p-1">
                {(() => {
                  const FileIcon = getFileTypeIconByMime(file.mimeType);
                  return <FileIcon size={28} />;
                })()}
                <span className="text-[10px] text-muted-foreground truncate w-full text-center leading-tight">
                  {file.name.length > 8 ? `${file.name.slice(0, 6)}...` : file.name}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 文件加载中 */}
      {isLoadingFiles && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground justify-end">
          <div className="animate-pulse">
            {(() => {
              const LoadingIcon = getFileTypeIconByMime('');
              return <LoadingIcon size={16} />;
            })()}
          </div>
          <span>{t('messageItem.loadingFiles')}</span>
        </div>
      )}

      {/* 图片预览器 */}
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

      {/* 文档预览器 */}
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

export default MessageAttachments;
