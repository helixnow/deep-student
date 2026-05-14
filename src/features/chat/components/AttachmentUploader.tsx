/**
 * Chat V2 - AttachmentUploader 附件上传组件
 *
 * 职责：支持拖拽、粘贴、点击三种上传方式
 *
 * 功能：
 * 1. 拖拽上传
 * 2. 粘贴上传（Ctrl/Cmd + V）
 * 3. 点击选择上传
 * 4. 文件类型/大小限制
 * 5. 暗色/亮色主题支持
 * 6. 支持自定义触发器 (children)
 */

import React, {
  useCallback,
  useRef,
  useState,
  useEffect,
  type ClipboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { Upload, WarningCircle, X } from '@phosphor-icons/react';
import type { ChatStore, AttachmentMeta } from '../core/types';
import { useAttachments } from '../hooks/useChatStore';
import { resourceStoreApi, type ContextRef } from '../resources';
import { IMAGE_TYPE_ID } from '../context/definitions/image';
import { FILE_TYPE_ID } from '../context/definitions/file';
import { getErrorMessage } from '@/utils/errorUtils';
import { vfsRefApi } from '../context/vfsRefApi';
import { logAttachment } from '../debug/chatV2Logger';
import { useTauriDragAndDrop } from '@/hooks/useTauriDragAndDrop';
// P1-08: 统一使用核心常量
import {
  ATTACHMENT_MAX_SIZE,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_DOCUMENT_EXTENSIONS,
  formatFileSize,
} from '../core/constants';
import { 
  ImageFileIcon, 
  DocxFileIcon 
} from '@/features/learning-hub/icons/ResourceIcons';

// ============================================================================
// Props 定义
// ============================================================================

export interface AttachmentUploaderProps {
  store: StoreApi<ChatStore>;
  maxCount?: number;
  acceptTypes?: string[];
  maxSize?: number;
  showDropZone?: boolean;
  className?: string;
  targetFolderId?: string;
  onUploadSuccess?: (attachment: AttachmentMeta) => void;
  onUploadError?: (error: string) => void;
  /** 自定义触发按钮/区域。如果提供，将替换默认的 DropZone */
  children?: React.ReactNode;
}

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_ACCEPT_TYPES = Array.from(new Set([
  ...ATTACHMENT_ALLOWED_TYPES,
  ...ATTACHMENT_ALLOWED_EXTENSIONS.map((ext) => `.${ext}`),
]));

// P1-08: 使用统一常量，不再硬编码
// 旧值: DEFAULT_MAX_SIZE = 10MB, DEFAULT_MAX_COUNT = 10
// 新值: ATTACHMENT_MAX_SIZE = 50MB, ATTACHMENT_MAX_COUNT = 20

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取文件扩展名（小写）
 */
function getFileExtension(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}

/**
 * 获取附件类型
 */
function getAttachmentType(
  mimeType: string,
  fileName: string
): 'image' | 'document' | 'audio' | 'video' | 'other' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  const ext = getFileExtension(fileName);
  if (ATTACHMENT_IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (ATTACHMENT_DOCUMENT_EXTENSIONS.includes(ext)) return 'document';
  if (
    mimeType.includes('pdf') ||
    mimeType.includes('document') ||
    mimeType.includes('text') ||
    mimeType.includes('word')
  ) {
    return 'document';
  }
  return 'other';
}

// P1-08: formatFileSize 已从 ../core/constants 导入

/**
 * 检查文件类型是否被接受
 */
function isFileTypeAccepted(file: File, acceptTypes: string[]): boolean {
  const fileNameLower = file.name.toLowerCase();
  return acceptTypes.some((type) => {
    if (type.endsWith('/*')) {
      const category = type.replace('/*', '');
      return file.type.startsWith(category);
    }
    return file.type === type || fileNameLower.endsWith(type.toLowerCase());
  });
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * AttachmentUploader 附件上传组件
 */
export const AttachmentUploader: React.FC<AttachmentUploaderProps> = ({
  store,
  maxCount = ATTACHMENT_MAX_COUNT,
  acceptTypes = DEFAULT_ACCEPT_TYPES,
  maxSize = ATTACHMENT_MAX_SIZE,
  showDropZone = true,
  className,
  targetFolderId,
  onUploadSuccess,
  onUploadError,
  children,
}) => {
  const { t } = useTranslation('chatV2');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 状态
  const [uploadError, setUploadError] = useState<string | null>(null);

  // 订阅附件列表
  const attachments = useAttachments(store);

  // 处理单个文件
  const processFile = useCallback(
    async (file: File): Promise<AttachmentMeta | null> => {
      // 检查数量限制
      if (attachments.length >= maxCount) {
        const error = t('attachmentUploader.errors.maxCount', { max: maxCount });
        setUploadError(error);
        onUploadError?.(error);
        return null;
      }

      // 检查文件类型
      if (!isFileTypeAccepted(file, acceptTypes)) {
        const error = t('attachmentUploader.errors.invalidType');
        setUploadError(error);
        onUploadError?.(error);
        return null;
      }

      // 检查文件大小
      if (file.size > maxSize) {
        const error = t('attachmentUploader.errors.tooLarge', {
          max: formatFileSize(maxSize),
        });
        setUploadError(error);
        onUploadError?.(error);
        return null;
      }

      // 创建附件元数据
      const attachment: AttachmentMeta = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        type: getAttachmentType(file.type, file.name),
        mimeType: file.type,
        size: file.size,
        status: 'pending',
      };

      // 🔧 P0修复：所有文件类型都读取内容到 previewUrl
      // 这确保文档、图片等所有附件都能正确传递给后端
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          attachment.previewUrl = reader.result as string;
          attachment.status = 'ready';
          resolve(attachment);
        };
        reader.onerror = () => {
          attachment.status = 'error';
          attachment.error = t('attachmentUploader.errors.readFailed');
          resolve(attachment);
        };
        reader.readAsDataURL(file);
      });
    },
    [attachments.length, maxCount, acceptTypes, maxSize, t, onUploadError]
  );

  // 处理多个文件
  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      setUploadError(null);
      const fileArray = Array.from(files);

      for (const file of fileArray) {
        const attachment = await processFile(file);
        if (attachment) {
          // ★ VFS 引用模式：上传到 VFS，存储引用
          try {
            // 确定资源类型：图片 vs 文件
            const fileExt = getFileExtension(file.name);
            const isImage = file.type.startsWith('image/') || ATTACHMENT_IMAGE_EXTENSIONS.includes(fileExt);
            const typeId = isImage ? IMAGE_TYPE_ID : FILE_TYPE_ID;

            // 1. 上传附件到 VFS（自动去重）
            logAttachment('ui', 'upload_start', {
              fileName: attachment.name,
              mimeType: attachment.mimeType,
              size: attachment.size,
              isImage,
              typeId,
            });

            const uploadResult = await vfsRefApi.uploadAttachment({
              name: attachment.name,
              mimeType: attachment.mimeType,
              base64Content: attachment.previewUrl || '',
              type: isImage ? 'image' : 'file',
              folderId: targetFolderId,
            });

            logAttachment('ui', 'vfs_upload_done', {
              sourceId: uploadResult.sourceId,
              resourceHash: uploadResult.resourceHash,
              isNew: uploadResult.isNew,
            }, 'success');

            // 2. 创建资源引用（存储 VfsContextRefData 格式）
            // ★ 必须符合 VfsContextRefData 结构，包含 refs 数组
            const refData = JSON.stringify({
              refs: [{
                sourceId: uploadResult.sourceId,
                resourceHash: uploadResult.resourceHash,
                type: isImage ? 'image' : 'file',
                name: attachment.name,
              }],
              totalCount: 1,
              truncated: false,
            });

            logAttachment('ui', 'resource_create_start', {
              refData,
              sourceId: uploadResult.sourceId,
            });

            const result = await resourceStoreApi.createOrReuse({
              type: isImage ? 'image' : 'file',
              data: refData, // ★ 存储引用 JSON，而非完整内容
              sourceId: uploadResult.sourceId,
              metadata: {
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: attachment.size,
              },
            });

            logAttachment('ui', 'resource_created', {
              resourceId: result.resourceId,
              hash: result.hash,
              isNew: result.isNew,
            }, 'success');

            // 3. 构建并添加上下文引用
            const contextRef: ContextRef = {
              resourceId: result.resourceId,
              hash: result.hash,
              typeId,
            };
            logAttachment('store', 'add_context_ref', {
              resourceId: result.resourceId,
              hash: result.hash,
              typeId,
            });
            store.getState().addContextRef(contextRef);

            // 保存 resourceId 到附件元数据，用于删除时移除 ContextRef
            attachment.resourceId = result.resourceId;
            // 保存 sourceId 用于 VFS 引用解析
            (attachment as AttachmentMeta & { sourceId?: string }).sourceId = uploadResult.sourceId;

            // 添加到 UI 状态以显示附件预览
            store.getState().addAttachment(attachment);
            onUploadSuccess?.(attachment);
          } catch (error: unknown) {
            logAttachment('ui', 'upload_error', {
              fileName: attachment.name,
              error: getErrorMessage(error),
            }, 'error');
            onUploadError?.(getErrorMessage(error));
          }
        }
      }
    },
    [processFile, store, onUploadSuccess, onUploadError, targetFolderId]
  );

  // 点击上传
  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 文件选择
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        processFiles(files);
      }
      // 清空 input 以便重复选择同一文件
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [processFiles]
  );

  // ★ 使用统一的 Tauri 拖拽 Hook
  const { isDragging, dropZoneProps } = useTauriDragAndDrop({
    dropZoneRef,
    onDropFiles: (files) => processFiles(files),
    isEnabled: showDropZone && !children, // 只有在显示默认 DropZone 时才启用这里的拖拽监听
    debugZoneId: 'attachment-uploader',
    maxFiles: maxCount,
    maxFileSize: maxSize,
  });

  // 粘贴事件处理
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent | Event) => {
      const clipboardEvent = e as ClipboardEvent;
      const items = clipboardEvent.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        processFiles(files);
      }
    };

    // 监听全局粘贴事件
    document.addEventListener('paste', handlePaste as EventListener);
    return () => {
      document.removeEventListener('paste', handlePaste as EventListener);
    };
  }, [processFiles]);

  // 清除错误
  const clearError = useCallback(() => {
    setUploadError(null);
  }, []);

  return (
    <div className={cn('relative', className)}>
      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={acceptTypes.join(',')}
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* 自定义触发器 OR 默认 DropZone */}
      {children ? (
        <div onClick={handleClick} className="inline-block cursor-pointer">
          {children}
        </div>
      ) : showDropZone && (
        <div
          ref={dropZoneRef}
          onClick={handleClick}
          {...dropZoneProps}
          className={cn(
            'relative flex flex-col items-center justify-center gap-3',
            'p-6 rounded-xl border-2 border-dashed',
            'cursor-pointer transition-all',
            isDragging
              ? 'border-primary bg-primary/5 dark:bg-primary/10'
              : 'border-border/50 hover:border-primary/50 hover:bg-[var(--interactive-hover)]',
            'text-muted-foreground'
          )}
        >
          {/* 图标 */}
          <div className="flex items-center gap-2">
            <Upload
              size={32}
              className={cn(
                isDragging ? 'text-primary' : 'text-muted-foreground/50'
              )}
            />
          </div>

          {/* 文本 */}
          <div className="text-center">
            <p className="text-sm font-medium">
              {isDragging
                ? t('attachmentUploader.dropHere')
                : t('attachmentUploader.dragOrClick')}
            </p>
            <p className="text-xs mt-1 opacity-70">
              {t('attachmentUploader.supportedFormats')}
            </p>
            <p className="text-xs opacity-70">
              {t('attachmentUploader.maxSize', {
                size: formatFileSize(maxSize),
              })}
            </p>
          </div>

          {/* 支持的图标 - 使用 ResourceIcons */}
          <div className="flex items-center gap-4 mt-1 opacity-80">
            <div className="flex items-center gap-1.5 text-xs">
              <ImageFileIcon size={20} />
              <span>{t('attachmentUploader.types.image')}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <DocxFileIcon size={20} />
              <span>{t('attachmentUploader.types.document')}</span>
            </div>
          </div>

          {/* 当前数量 */}
          {attachments.length > 0 && (
            <div className="text-xs font-medium text-primary">
              {t('attachmentUploader.currentCount', {
                current: attachments.length,
                max: maxCount,
              })}
            </div>
          )}
        </div>
      )}

      {/* 错误提示 */}
      {uploadError && (
        <div className="mt-2 flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-sm">
          <WarningCircle size={16} className="flex-shrink-0" />
          <span className="flex-1">{uploadError}</span>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={clearError} className="!h-5 !w-5 !p-0 hover:bg-destructive/20" aria-label="close">
            <X size={16} />
          </NotionButton>
        </div>
      )}
    </div>
  );
};

export default AttachmentUploader;
