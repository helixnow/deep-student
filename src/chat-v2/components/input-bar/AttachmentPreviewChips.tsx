import React, { memo } from 'react';
import {
  AlertCircle,
  File,
  FileCode2,
  FileText,
  Image as ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { AttachmentMeta } from '../../core/types/common';

interface AttachmentPreviewChipsProps {
  attachments: AttachmentMeta[];
  onRemove: (attachmentId: string) => void;
  onOpenPanel?: () => void;
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
    return FileCode2;
  }
  if (['txt', 'md', 'pdf', 'doc', 'docx'].includes(extension) || attachment.mimeType.startsWith('text/')) {
    return FileText;
  }
  return File;
}

function getStatusIndicator(attachment: AttachmentMeta): React.ReactNode | null {
  if (attachment.status === 'error') {
    return <AlertCircle className="h-2.5 w-2.5 text-red-500" aria-hidden="true" />;
  }
  if (attachment.status === 'uploading' || attachment.status === 'processing' || attachment.status === 'pending') {
    return <Loader2 className="h-2.5 w-2.5 animate-spin text-blue-500" aria-hidden="true" />;
  }
  return null;
}

export const AttachmentPreviewChips: React.FC<AttachmentPreviewChipsProps> = memo(({
  attachments,
  onRemove,
  onOpenPanel,
  disabled = false,
  className,
}) => {
  if (attachments.length === 0) {
    return null;
  }

  return (
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
        const statusIndicator = getStatusIndicator(attachment);
        const showImagePreview = Boolean(
          attachment.previewUrl
          && (attachment.type === 'image' || attachment.mimeType.startsWith('image/'))
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
              onClick={onOpenPanel}
              className={cn(
                'attachment-preview-chip h-8 w-max justify-start gap-2 rounded-full border border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-strong)] py-0 pl-1.5 pr-7 text-[13px] font-semibold text-foreground shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:border-[color:var(--button-plain-border)] hover:bg-[color:var(--button-plain-hover-bg)]',
                disabled && 'pointer-events-none opacity-60'
              )}
              title={attachment.name}
            >
              <span
                data-testid={`attachment-chip-icon-${attachment.id}`}
                className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[color:var(--surface-elevated)] text-muted-foreground"
              >
                {showImagePreview ? (
                  <img
                    src={attachment.previewUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <Icon className="h-3 w-3" aria-hidden="true" />
                )}
                {statusIndicator ? (
                  <span className="absolute -bottom-px -right-px rounded-full bg-[color:var(--surface-panel-strong)]">
                    {statusIndicator}
                  </span>
                ) : null}
              </span>
              <span className="whitespace-nowrap">{attachment.name}</span>
            </NotionButton>
            <NotionButton
              type="button"
              variant="ghost"
              size="icon"
              iconOnly
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(attachment.id);
              }}
              aria-label={`移除附件 ${attachment.name}`}
              title={`移除附件 ${attachment.name}`}
              className="pointer-events-none absolute right-1.5 top-1/2 !h-5 !w-5 -translate-y-1/2 rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-black/10 hover:text-foreground group-hover/attachment-chip:pointer-events-auto group-hover/attachment-chip:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 dark:hover:bg-white/10"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </NotionButton>
          </div>
        );
      })}
    </div>
  );
});

AttachmentPreviewChips.displayName = 'AttachmentPreviewChips';

export default AttachmentPreviewChips;
