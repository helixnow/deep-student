import React, { memo, useState, useCallback, useMemo } from 'react';
import {
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { InlineImageViewer } from '../InlineImageViewer';
import type { AttachmentMeta } from '../../core/types/common';

interface AttachmentPreviewChipsProps {
  attachments: AttachmentMeta[];
  onRemove: (attachmentId: string) => void;
  disabled?: boolean;
  className?: string;
}

function getFileExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.trim().toLowerCase();
  return extension && extension !== fileName.toLowerCase() ? extension : '';
}

function getAttachmentIcon(attachment: AttachmentMeta): React.ElementType {
  const extension = getFileExtension(attachment.name);
  if (attachment.type === 'image' || attachment.mimeType.startsWith('image/')) {
    return ImageIcon;
  }
  if (['html', 'htm', 'css', 'js', 'ts', 'tsx', 'json', 'xml'].includes(extension)) {
    return FileCode;
  }
  if (['txt', 'md', 'pdf', 'doc', 'docx'].includes(extension) || attachment.mimeType.startsWith('text/')) {
    return FileText;
  }
  return File;
}

function isRichDocument(mimeType: string, fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  const richExtensions = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp'];
  if (richExtensions.includes(ext)) {
    return true;
  }
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

function isImageAttachment(attachment: AttachmentMeta): boolean {
  return attachment.type === 'image' || attachment.mimeType.startsWith('image/');
}

export const AttachmentPreviewChips: React.FC<AttachmentPreviewChipsProps> = memo(({
  attachments,
  onRemove,
  disabled = false,
  className,
}) => {
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  const imageAttachments = useMemo(
    () => attachments.filter((a) => isImageAttachment(a) && a.previewUrl),
    [attachments]
  );

  const imageUrls = useMemo(
    () => imageAttachments.map((a) => a.previewUrl!),
    [imageAttachments]
  );

  const handleChipClick = useCallback((attachment: AttachmentMeta) => {
    if (isImageAttachment(attachment) && attachment.previewUrl) {
      const imgIdx = imageAttachments.findIndex((a) => a.id === attachment.id);
      setCurrentImageIndex(imgIdx >= 0 ? imgIdx : 0);
      setImageViewerOpen(true);
      return;
    }

    const sourceId = attachment.sourceId || attachment.resourceId;
    if (!sourceId) return;

    const resourceType = isRichDocument(attachment.mimeType, attachment.name) ? 'file' : 'file';
    window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
      detail: {
        id: sourceId,
        type: resourceType,
        title: attachment.name,
      },
    }));
  }, [imageAttachments]);

  const handleCloseImageViewer = useCallback(() => {
    setImageViewerOpen(false);
  }, []);

  const handleNextImage = useCallback(() => {
    setCurrentImageIndex((prev) => (prev + 1) % imageUrls.length);
  }, [imageUrls.length]);

  const handlePrevImage = useCallback(() => {
    setCurrentImageIndex((prev) => (prev - 1 + imageUrls.length) % imageUrls.length);
  }, [imageUrls.length]);

  if (attachments.length === 0) {
    return null;
  }

  return (
    <>
      <div
        role="list"
        aria-label="待发送附件"
        className={cn(
          'attachment-preview-chips mb-2 flex max-h-[76px] flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden pr-1 sm:flex-wrap sm:content-start sm:overflow-y-auto',
          className
        )}
      >
        {attachments.map((attachment) => {
          const Icon = getAttachmentIcon(attachment);
          const showImagePreview = Boolean(
            attachment.previewUrl
            && isImageAttachment(attachment)
          );

          return (
            <div
              key={attachment.id}
              role="listitem"
              aria-label={attachment.name}
              className="group/attachment-chip relative inline-flex min-w-0 shrink-0 items-center"
            >
              <NotionButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleChipClick(attachment)}
                className={cn(
                  'attachment-preview-chip h-8 w-max justify-start gap-2 rounded-full border border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-strong)] py-0 pl-1.5 pr-3 text-[13px] font-semibold text-foreground shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:border-[color:var(--button-plain-border)] hover:bg-[color:var(--button-plain-hover-bg)] cursor-pointer',
                  disabled && 'pointer-events-none opacity-60'
                )}
                title={attachment.name}
              >
                {/* 图标区域：hover 时变为 X 删除按钮 */}
                <span
                  data-testid={`attachment-chip-icon-${attachment.id}`}
                  className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[color:var(--surface-elevated)] text-muted-foreground"
                >
                  {/* 默认：文件图标 / 图片预览 */}
                  <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/attachment-chip:opacity-0">
                    {showImagePreview ? (
                      <img
                        src={attachment.previewUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <Icon size={12} aria-hidden="true" />
                    )}
                  </span>
                  {/* Hover：X 图标覆盖 */}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(attachment.id);
                      }}
                      aria-label={`移除附件 ${attachment.name}`}
                      title={`移除附件 ${attachment.name}`}
                      className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity duration-150 group-hover/attachment-chip:opacity-100 focus-visible:opacity-100"
                    >
                      <X size={10} weight="bold" aria-hidden="true" />
                    </button>
                  )}
                </span>
                <span className="whitespace-nowrap">{attachment.name}</span>
              </NotionButton>
            </div>
          );
        })}
      </div>

      {/* 图片预览器 */}
      {imageUrls.length > 0 && (
        <InlineImageViewer
          images={imageUrls}
          currentIndex={currentImageIndex}
          isOpen={imageViewerOpen}
          onClose={handleCloseImageViewer}
          onNext={handleNextImage}
          onPrev={handlePrevImage}
        />
      )}
    </>
  );
});

AttachmentPreviewChips.displayName = 'AttachmentPreviewChips';

export default AttachmentPreviewChips;
