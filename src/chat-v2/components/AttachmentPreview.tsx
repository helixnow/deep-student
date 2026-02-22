/**
 * Chat V2 - AttachmentPreview 附件预览组件
 *
 * 职责：显示附件列表，支持预览、删除操作
 *
 * 功能：
 * 1. 图片缩略图预览
 * 2. 文档图标显示（使用学习资源管理器风格图标）
 * 3. 文件信息展示
 * 4. 删除操作
 * 5. 状态指示（上传中/错误）
 * 6. 暗色/亮色主题支持
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  X,
  Loader2,
  AlertCircle,
  Maximize2,
} from 'lucide-react';
import type { ChatStore, AttachmentMeta } from '../core/types';
import { useAttachments } from '../hooks/useChatStore';
import { 
  PdfFileIcon, 
  DocxFileIcon, 
  AudioFileIcon, 
  VideoFileIcon, 
  ImageFileIcon, 
  GenericFileIcon,
  type ResourceIconProps
} from '@/components/learning-hub/icons/ResourceIcons';

// ============================================================================
// Props 定义
// ============================================================================

export interface AttachmentPreviewProps {
  /** Store 实例 */
  store: StoreApi<ChatStore>;
  /** 是否只读（不显示删除按钮） */
  readonly?: boolean;
  /** 布局方向 */
  layout?: 'horizontal' | 'vertical' | 'grid';
  /** 预览大小 */
  size?: 'sm' | 'md' | 'lg';
  /** 自定义类名 */
  className?: string;
  /** 点击预览回调（用于全屏预览） */
  onPreviewClick?: (attachment: AttachmentMeta) => void;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 根据文件名后缀和 MIME 获取对应的资源图标
 */
function getResourceIconComponent(fileName: string, mimeType: string): React.FC<ResourceIconProps> {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  
  // 图片
  if (mimeType.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return ImageFileIcon;
  }
  
  // PDF
  if (mimeType === 'application/pdf' || ext === 'pdf') {
    return PdfFileIcon;
  }
  
  // Word
  if (
    mimeType.includes('word') || 
    mimeType.includes('msword') || 
    ['doc', 'docx'].includes(ext)
  ) {
    return DocxFileIcon;
  }
  
  // Excel (暂时用通用文档图标，未来可扩展)
  if (['xls', 'xlsx', 'csv'].includes(ext)) {
    return GenericFileIcon;
  }
  
  // PPT (暂时用通用文档图标，未来可扩展)
  if (['ppt', 'pptx'].includes(ext)) {
    return GenericFileIcon;
  }

  // Audio
  if (mimeType.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
    return AudioFileIcon;
  }
  
  // Video
  if (mimeType.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
    return VideoFileIcon;
  }
  
  // 默认
  return GenericFileIcon;
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================================
// 尺寸配置
// ============================================================================

const SIZE_CONFIG = {
  sm: {
    container: 'w-16 h-16', // 稍微加大以容纳更精致的图标
    iconSize: 32,
    closeBtn: 'w-4 h-4',
    closeBtnPadding: 'p-0.5',
    fontSize: 'text-[10px]',
  },
  md: {
    container: 'w-24 h-24',
    iconSize: 48,
    closeBtn: 'w-4 h-4',
    closeBtnPadding: 'p-1',
    fontSize: 'text-xs',
  },
  lg: {
    container: 'w-32 h-32',
    iconSize: 64,
    closeBtn: 'w-5 h-5',
    closeBtnPadding: 'p-1',
    fontSize: 'text-sm',
  },
};

// ============================================================================
// 子组件：单个附件项
// ============================================================================

interface AttachmentItemProps {
  attachment: AttachmentMeta;
  size: 'sm' | 'md' | 'lg';
  readonly?: boolean;
  onRemove?: () => void;
  onPreviewClick?: () => void;
}

const AttachmentItem: React.FC<AttachmentItemProps> = ({
  attachment,
  size,
  readonly,
  onRemove,
  onPreviewClick,
}) => {
  const { t } = useTranslation('chatV2');
  const config = SIZE_CONFIG[size];
  const IconComponent = getResourceIconComponent(attachment.name, attachment.mimeType);

  // 是否显示图片预览 (仅当有 previewUrl 且是图片类型时)
  // 如果是小尺寸，且有预览图，优先显示预览图
  // 如果是大尺寸，文档类型显示图标，图片类型显示预览图
  const showImagePreview =
    (attachment.type === 'image' || attachment.mimeType.startsWith('image/')) && 
    attachment.previewUrl;

  // 状态指示
  const isPending = attachment.status === 'pending';
  const isUploading = attachment.status === 'uploading';
  const isError = attachment.status === 'error';

  return (
    <div
      className={cn(
        'relative group rounded-xl overflow-hidden',
        'border border-border/40',
        'bg-background hover:bg-muted/30 transition-colors', // 更干净的背景
        'shadow-sm hover:shadow-md transition-shadow duration-200',
        config.container,
        isError && 'border-destructive/50 bg-destructive/5'
      )}
    >
      {/* 内容区域 */}
      <div
        className={cn(
          'w-full h-full flex flex-col items-center justify-center',
          onPreviewClick && 'cursor-pointer'
        )}
        onClick={onPreviewClick}
        title={attachment.name}
      >
        {showImagePreview ? (
          <div className="w-full h-full relative">
            <img
              src={attachment.previewUrl}
              alt={attachment.name}
              className="w-full h-full object-cover"
            />
            {/* 渐变遮罩，为了显示文件名（仅在非sm尺寸） */}
            {size !== 'sm' && (
               <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1 pt-4">
                 <p className="text-white text-[10px] truncate text-center px-1">
                   {attachment.name}
                 </p>
               </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center w-full h-full p-2 gap-1.5">
            {/* 图标 */}
            <div className="shrink-0 drop-shadow-sm">
               <IconComponent size={config.iconSize} />
            </div>
            
            {/* 文件名 */}
            <div className={cn(
              "text-center w-full text-foreground/80 font-medium truncate px-1",
              config.fontSize
            )}>
              {attachment.name}
            </div>
          </div>
        )}
      </div>

      {/* 状态遮罩 */}
      {(isPending || isUploading) && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-[1px] z-10">
          <Loader2 className={cn('w-6 h-6 animate-spin text-primary')} />
        </div>
      )}

      {/* 错误状态 */}
      {isError && (
        <div className="absolute inset-0 flex items-center justify-center bg-destructive/10 z-10">
          <AlertCircle className={cn('w-6 h-6 text-destructive')} />
        </div>
      )}

      {/* Hover 遮罩 (仅图片) */}
      {showImagePreview && onPreviewClick && (
        <div
          className={cn(
            'absolute inset-0 flex items-center justify-center',
            'bg-black/20 opacity-0 group-hover:opacity-100 transition-opacity',
            'cursor-pointer z-10'
          )}
          onClick={onPreviewClick}
        >
          <Maximize2 className="w-6 h-6 text-white drop-shadow-md" />
        </div>
      )}

      {/* 删除按钮 (悬浮在右上角) */}
      {!readonly && onRemove && (
        <NotionButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className={cn(
            'absolute top-0.5 right-0.5 z-20 !rounded-full !p-0.5',
            'bg-black/40 hover:bg-destructive text-white',
            'backdrop-blur-sm',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all duration-200',
            'transform scale-90 group-hover:scale-100',
            config.closeBtnPadding
          )}
          aria-label={t('attachmentPreview.remove')}
          title={t('attachmentPreview.remove')}
        >
          <X className={config.closeBtn} />
        </NotionButton>
      )}

      {/* 文件大小（大尺寸显示，非图片） */}
      {size === 'lg' && !showImagePreview && (
        <div className="absolute bottom-1 left-0 right-0 text-[10px] text-muted-foreground text-center truncate px-2">
          {formatFileSize(attachment.size)}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * AttachmentPreview 附件预览组件
 */
export const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({
  store,
  readonly = false,
  layout = 'horizontal',
  size = 'md',
  className,
  onPreviewClick,
}) => {
  const { t } = useTranslation('chatV2');
  const attachments = useAttachments(store);

  // 移除附件
  const handleRemove = useCallback(
    (attachmentId: string) => {
      store.getState().removeAttachment(attachmentId);
    },
    [store]
  );

  // 如果没有附件，不渲染
  if (attachments.length === 0) {
    return null;
  }

  // 布局类名
  const layoutClass = {
    horizontal: 'flex flex-wrap gap-3',
    vertical: 'flex flex-col gap-3',
    grid: 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3',
  }[layout];

  return (
    <div className={cn(layoutClass, className)}>
      {attachments.map((attachment) => (
        <AttachmentItem
          key={attachment.id}
          attachment={attachment}
          size={size}
          readonly={readonly}
          onRemove={readonly ? undefined : () => handleRemove(attachment.id)}
          onPreviewClick={
            onPreviewClick ? () => onPreviewClick(attachment) : undefined
          }
        />
      ))}
    </div>
  );
};

export default AttachmentPreview;
