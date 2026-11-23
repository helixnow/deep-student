import React, { memo, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  CaretDown,
  File,
  FileCode,
  FileText,
  Image as ImageIcon,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { coarseHitClassFor24 } from '@/components/ui/coarseHit';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { InlineImageViewer } from '../InlineImageViewer';
import { AttachmentInjectModeSelector } from './AttachmentInjectModeSelector';
import { usePdfProcessingStore } from '@/features/pdf/stores/pdfProcessingStore';
import type { AttachmentInjectModes, AttachmentMeta, PdfProcessingStatus } from '../../core/types/common';
import {
  TEXT_FILE_MAX_LENGTH,
  ATTACHMENT_TEXT_INJECT_EXTENSIONS,
} from '../../core/constants';
import {
  type MediaInjectMode,
  getMediaTypeForAttachment,
  getSelectedInjectModes,
  getEffectiveReadyModes,
} from './injectModeUtils';

interface AttachmentPreviewChipsProps {
  attachments: AttachmentMeta[];
  onRemove: (attachmentId: string) => void;
  /** 错误态内联重试（复用附件面板的重试链路） */
  onRetry?: (attachment: AttachmentMeta) => void;
  /** 附件注入模式切换（支持在 PDF / 图片 chip 上一键切换文本 / OCR / 图片） */
  onInjectModesChange?: (attachmentId: string, modes: AttachmentInjectModes) => void;
  /** 是否处于移动端紧凑布局 */
  isMobile?: boolean;
  /** 移动端点击附件胶囊时展开/收起附件详情面板 */
  onToggleDetails?: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * chip 即仪表盘：上传 → 处理 → 可检索 三段状态
 */
type ChipLifecycle = 'uploading' | 'processing' | 'partial' | 'ready' | 'error' | 'plain';

interface ChipStatusInfo {
  lifecycle: ChipLifecycle;
  /** 统一进度（上传 0-50，处理 50-100），无进度时为 null */
  unifiedPercent: number | null;
  /** 附件媒体类型（仅 PDF/图片） */
  mediaType: 'pdf' | 'image' | null;
  /** 选中的注入模式（仅 PDF/图片） */
  selectedModes: MediaInjectMode[];
  /** 已就绪的注入模式（仅 PDF/图片） */
  readyModes: MediaInjectMode[];
  /** 尚未就绪的选中模式 */
  missingModes: MediaInjectMode[];
  /** PDF 总页数（就绪后显示页数徽标） */
  totalPages?: number;
}

function getFileExtension(fileName: string): string {
  const extension = fileName.split('.').pop()?.trim().toLowerCase();
  return extension && extension !== fileName.toLowerCase() ? extension : '';
}

function getAttachmentIcon(attachment: AttachmentMeta): React.ElementType {
  const extension = getFileExtension(attachment.name);
  if (isImageAttachment(attachment)) {
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

function isImageAttachment(attachment: AttachmentMeta): boolean {
  return attachment.type === 'image' || getMediaTypeForAttachment(attachment) === 'image';
}

/**
 * ★ 截断预判：纯文本注入的文件（字节数 ≈ 注入文本长度）超过 100KB 时，
 * 注入将截断到前 100KB。PDF/图片走独立分页/多模态链路，不在此预判范围。
 */
function willLikelyTruncate(attachment: AttachmentMeta): boolean {
  if (getMediaTypeForAttachment(attachment) !== null) return false;
  const ext = getFileExtension(attachment.name);
  if (!ATTACHMENT_TEXT_INJECT_EXTENSIONS.includes(ext)) return false;
  return (attachment.size ?? 0) > TEXT_FILE_MAX_LENGTH;
}

function computeChipStatus(
  attachment: AttachmentMeta,
  storeStatus: PdfProcessingStatus | undefined
): ChipStatusInfo {
  const mediaType = getMediaTypeForAttachment(attachment);
  const status = storeStatus || attachment.processingStatus;

  const selectedModes = mediaType ? getSelectedInjectModes(attachment, mediaType) : [];
  const readyModes = mediaType ? getEffectiveReadyModes(attachment, mediaType, status) : undefined;
  const readySet = new Set(readyModes ?? []);
  const missingModes = selectedModes.filter((mode) => !readySet.has(mode));
  const readyList = readyModes ?? [];
  const totalPages = mediaType === 'pdf'
    ? (status?.totalPages ?? attachment.processingStatus?.totalPages)
    : undefined;

  if (attachment.status === 'error') {
    return { lifecycle: 'error', unifiedPercent: null, mediaType, selectedModes, readyModes: readyList, missingModes, totalPages };
  }

  if (attachment.status === 'uploading' || attachment.status === 'pending') {
    const percent = attachment.uploadProgress != null
      ? Math.min(50, Math.max(0, Math.round(attachment.uploadProgress)))
      : null;
    return { lifecycle: 'uploading', unifiedPercent: percent, mediaType, selectedModes, readyModes: readyList, missingModes, totalPages };
  }

  if (attachment.status === 'processing') {
    const rawPercent = status?.percent ?? 0;
    const percent = 50 + Math.round(Math.min(100, Math.max(0, rawPercent)) * 0.5);
    return { lifecycle: 'processing', unifiedPercent: percent, mediaType, selectedModes, readyModes: readyList, missingModes, totalPages };
  }

  // ready：非媒体附件无模式概念，直接视为可用
  if (!mediaType) {
    return { lifecycle: 'plain', unifiedPercent: null, mediaType: null, selectedModes, readyModes: readyList, missingModes, totalPages };
  }

  return {
    lifecycle: missingModes.length > 0 ? 'partial' : 'ready',
    unifiedPercent: null,
    mediaType,
    selectedModes,
    readyModes: readyList,
    missingModes,
    totalPages,
  };
}

/**
 * 微型进度环（chip 图标位内联，token 配色，motion-reduce 降级为静态环）
 */
const ChipProgressRing: React.FC<{ percent: number | null }> = ({ percent }) => {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const clamped = percent == null ? 25 : Math.min(100, Math.max(0, percent));
  const offset = circumference * (1 - clamped / 100);
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn(
        'h-5 w-5 text-info',
        percent == null && 'animate-spin motion-reduce:animate-none'
      )}
      fill="none"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r={radius} stroke="var(--button-utility-hover)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform="rotate(-90 10 10)"
        className="transition-[stroke-dashoffset] duration-300 motion-reduce:transition-none"
      />
    </svg>
  );
};

export const AttachmentPreviewChips: React.FC<AttachmentPreviewChipsProps> = memo(({
  attachments,
  onRemove,
  onRetry,
  onInjectModesChange,
  isMobile = false,
  onToggleDetails,
  disabled = false,
  className,
}) => {
  const { t } = useTranslation(['analysis', 'chatV2', 'common']);
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // 复用附件面板的处理状态数据源（后端事件 + 兜底轮询写入的同一 store）
  const pdfStatusMap = usePdfProcessingStore(state => state.statusMap);

  const modeLabelMap = useMemo<Record<MediaInjectMode, string>>(() => ({
    text: t('chatV2:injectMode.pdf.text'),
    ocr: t('chatV2:injectMode.image.ocr'),
    image: t('chatV2:injectMode.image.image'),
  }), [t]);

  const formatModeSummary = useCallback((modes: MediaInjectMode[]): string => {
    return modes.map((mode) => modeLabelMap[mode]).join(t('chatV2:injectMode.joiner'));
  }, [modeLabelMap, t]);

  const imageAttachments = useMemo(
    () => attachments.filter((a) => isImageAttachment(a) && a.previewUrl),
    [attachments]
  );

  const imageUrls = useMemo(
    () => imageAttachments.map((a) => a.previewUrl!),
    [imageAttachments]
  );

  const handleChipClick = useCallback((attachment: AttachmentMeta) => {
    const isNarrowMobile = isMobile
      || (typeof window !== 'undefined' && window.innerWidth <= 640);
    if (isNarrowMobile && onToggleDetails) {
      onToggleDetails();
      return;
    }

    if (isImageAttachment(attachment) && attachment.previewUrl) {
      const imgIdx = imageAttachments.findIndex((a) => a.id === attachment.id);
      setCurrentImageIndex(imgIdx >= 0 ? imgIdx : 0);
      setImageViewerOpen(true);
      return;
    }

    const sourceId = attachment.sourceId || attachment.resourceId;
    if (!sourceId) return;

    // 附件预览统一走 file 类型（富文档由预览面板内部再分流）
    window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
      detail: {
        id: sourceId,
        type: 'file',
        title: attachment.name,
      },
    }));
  }, [imageAttachments, isMobile, onToggleDetails]);

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
      <CustomScrollArea
        role="list"
        aria-label={t('analysis:input_bar.attachments.title')}
        orientation="both"
        fullHeight={false}
        className={cn(
          'attachment-preview-chips mb-2 max-h-[76px] max-sm:mb-1.5 max-sm:max-h-[52px]',
          className
        )}
        viewportClassName={cn(
          // ★ M6 修复：换行断点从 sm(640) 对齐到 md(768)——与移动端布局断点一致，
          // 避免 640-767px 区间"移动端布局 + 桌面 wrap 行为"的分裂
          'flex max-h-[76px] max-sm:max-h-[52px] flex-nowrap items-center gap-2 pr-1 md:flex-wrap md:content-start'
        )}
      >
        {attachments.map((attachment) => {
          const Icon = getAttachmentIcon(attachment);
          const showImagePreview = Boolean(
            attachment.previewUrl
            && isImageAttachment(attachment)
          );

          const storeStatus = attachment.sourceId ? pdfStatusMap.get(attachment.sourceId) : undefined;
          const normalizedStoreStatus = storeStatus
            ? ({
              ...storeStatus,
              stage: storeStatus.stage === 'pending' ? undefined : storeStatus.stage,
            } as PdfProcessingStatus)
            : undefined;
          const chipStatus = computeChipStatus(attachment, normalizedStoreStatus);
          const isBusy = chipStatus.lifecycle === 'uploading' || chipStatus.lifecycle === 'processing';
          const isError = chipStatus.lifecycle === 'error';
          // ★ #64：partial（如「未就绪：OCR 文本」）同样提供重试入口。
          // 后端 retry() 本就接受 completed_with_issues，此前只有 error 态
          // 露出重试按钮，OCR 一次失败后用户没有任何恢复途径（重新上传
          // 会被内容去重命中同一条失败记录），只能永远看着「未就绪」。
          const isPartial = chipStatus.lifecycle === 'partial';
          const truncationLikely = !isError && willLikelyTruncate(attachment);
          const modeSummary = chipStatus.selectedModes.length > 0
            ? formatModeSummary(chipStatus.selectedModes)
            : '';

          const statusTitle = isError
            ? (attachment.error || t('chatV2:inputBar.chip.error'))
            : chipStatus.lifecycle === 'uploading'
              ? t('chatV2:inputBar.attachmentsUploading')
              : chipStatus.lifecycle === 'processing'
                ? t('chatV2:inputBar.processingIndicator')
                : chipStatus.lifecycle === 'partial'
                  ? t('chatV2:inputBar.modesNotReady', { modes: formatModeSummary(chipStatus.missingModes) })
                  : chipStatus.lifecycle === 'ready'
                    ? t('chatV2:inputBar.chip.ready')
                    : attachment.name;

          return (
            <div
              key={attachment.id}
              role="listitem"
              aria-label={attachment.name}
              // ui-rise-in：新添加的 chip 挂载入场（150ms fade+rise，reduced-motion 自动降级）
              className="group/attachment-chip ui-rise-in relative inline-flex min-w-0 shrink-0 items-center"
            >
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleChipClick(attachment)}
                className={cn(
                  'attachment-preview-chip h-8 w-max justify-start gap-2 rounded-full border bg-[color:var(--surface-panel-strong)] py-0 pl-1.5 pr-3 text-ui font-semibold text-foreground shadow-sm transition-[background-color,border-color,box-shadow] duration-150 hover:bg-[color:var(--button-plain-hover-bg)] cursor-pointer motion-reduce:transition-none [@media(pointer:coarse)]:min-h-[var(--touch-target-size)] max-sm:min-h-11',
                  !disabled && '[@media(pointer:coarse)]:gap-1 [@media(pointer:coarse)]:pl-0 max-sm:gap-1 max-sm:pl-0',
                  isError
                    ? 'border-destructive/40 hover:border-destructive/60'
                    : 'border-[color:var(--input-shell-border)] hover:border-[color:var(--button-plain-border)]',
                  disabled && 'pointer-events-none opacity-60'
                )}
                title={
                  truncationLikely
                    ? t('chatV2:inputBar.chip.titleTruncated', {
                        name: attachment.name,
                        status: statusTitle,
                        truncation: t('chatV2:inputBar.chip.truncatedTitle'),
                      })
                    : t('chatV2:inputBar.chip.title', {
                        name: attachment.name,
                        status: statusTitle,
                      })
                }
              >
                {/* 图标区域：上传/处理中显示进度环；hover 时变为 X 删除按钮 */}
                <span
                  data-testid={`attachment-chip-icon-${attachment.id}`}
                  className={cn(
                    'relative inline-flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-[color:var(--surface-elevated)] text-muted-foreground',
                    !disabled && '[@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:overflow-visible [@media(pointer:coarse)]:border-0 [@media(pointer:coarse)]:bg-transparent max-sm:h-11 max-sm:w-11 max-sm:min-h-11 max-sm:min-w-11 max-sm:overflow-visible max-sm:border-0 max-sm:bg-transparent'
                  )}
                >
                  {/* 默认：进度环 / 文件图标 / 图片预览 */}
                  <span
                    className={cn(
                      'absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/attachment-chip:opacity-0 motion-reduce:transition-none',
                      !disabled && '[@media(pointer:coarse)]:opacity-0 max-sm:opacity-0'
                    )}
                  >
                    {isBusy ? (
                      <ChipProgressRing percent={chipStatus.unifiedPercent} />
                    ) : showImagePreview ? (
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
                  {/* Hover：X 图标覆盖。触屏 / 窄屏（<= 640px）没有 hover，
                      删除按钮常显且实体 <button> 盒尺寸扩大到 44×44px，内部居中绘制 × 圆点 */}
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove(attachment.id);
                      }}
                      aria-label={t('chatV2:common.removeNamed', { name: attachment.name })}
                      title={t('chatV2:common.removeNamed', { name: attachment.name })}
                      className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity duration-150 group-hover/attachment-chip:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:bg-transparent [@media(pointer:coarse)]:opacity-100 max-sm:min-h-11 max-sm:min-w-11 max-sm:bg-transparent max-sm:opacity-100"
                    >
                      <span className="inline-flex items-center justify-center rounded-full [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6 [@media(pointer:coarse)]:bg-black/60 max-sm:h-6 max-sm:w-6 max-sm:bg-black/60">
                        <X size={10} weight="bold" aria-hidden="true" />
                      </span>
                    </button>
                  )}
                </span>
                {/* ★ M6：超长文件名截断（完整名在 chip title 中） */}
                <span className="max-w-[10rem] truncate">{attachment.name}</span>
                {/* PDF 页数徽标（页数已知时显示） */}
                {typeof chipStatus.totalPages === 'number' && chipStatus.totalPages > 0 && (
                  <span className="rounded-full border border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-muted)] px-1.5 py-px text-2xs font-medium leading-none tabular-nums text-muted-foreground">
                    {t('chatV2:inputBar.chip.pages', { count: chipStatus.totalPages })}
                  </span>
                )}
                {/* ★ 截断预警角标：纯文本注入超过 100KB 时提示将截断（详情见 tooltip） */}
                {truncationLikely && (
                  <span
                    className="whitespace-nowrap rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-2xs font-medium leading-none text-warning"
                    title={t('chatV2:inputBar.chip.truncatedTitle')}
                  >
                    {t('chatV2:inputBar.chip.truncated')}
                  </span>
                )}
                {/* 注入模式微型摘要：无回调或禁用时静态展示；支持切换时移至 chip 右侧可点击弹出胶囊 */}
                {modeSummary && !isError && (!onInjectModesChange || disabled) && (
                  <span
                    className={cn(
                      'whitespace-nowrap text-2xs font-medium leading-none',
                      chipStatus.lifecycle === 'partial' ? 'text-warning' : 'text-muted-foreground'
                    )}
                    title={statusTitle}
                  >
                    {modeSummary}
                  </span>
                )}
                {/* 错误态：内联标签 + 重试入口 */}
                {isError && (
                  <span className="whitespace-nowrap text-2xs font-medium leading-none text-destructive">
                    {t('chatV2:inputBar.chip.error')}
                  </span>
                )}
                {/* 状态点：可检索(成功)/部分就绪(警示)/处理中(信息脉冲) */}
                {!isError && chipStatus.selectedModes.length > 0 && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      chipStatus.lifecycle === 'ready' && 'bg-success',
                      chipStatus.lifecycle === 'partial' && 'bg-warning',
                      isBusy && 'bg-info animate-pulse motion-reduce:animate-none'
                    )}
                  />
                )}
              </DsButton>
              {/* PDF / 图片附件注入模式快捷切换入口（点击展开 文本 / OCR / 图片 选择器） */}
              {modeSummary && !isError && onInjectModesChange && !disabled && (
                <Popover>
                  <PopoverTrigger asChild>
                    <DsButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid={`attachment-chip-mode-${attachment.id}`}
                      aria-label={`${attachment.name} · ${t('chatV2:injectMode.label')}: ${modeSummary}`}
                      title={
                        isPartial || isBusy
                          ? `${t('chatV2:injectMode.label')}: ${modeSummary} · ${statusTitle}`
                          : `${t('chatV2:injectMode.label')}: ${modeSummary}`
                      }
                      className={cn(
                        'ml-1 !h-7 !gap-1 !rounded-full border !px-2 text-2xs font-medium shadow-sm [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]',
                        chipStatus.lifecycle === 'partial'
                          ? 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/15'
                          : 'border-[color:var(--input-shell-border)] bg-[color:var(--surface-panel-strong)] text-muted-foreground hover:border-[color:var(--button-plain-border)] hover:text-foreground',
                      )}
                    >
                      <span className="whitespace-nowrap leading-none">{modeSummary}</span>
                      <CaretDown size={10} weight="bold" aria-hidden="true" />
                    </DsButton>
                  </PopoverTrigger>
                  <PopoverContent side="top" align="start" className="w-auto p-2.5">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-2xs font-medium text-muted-foreground">
                        {t('chatV2:injectMode.label')}
                      </span>
                      <AttachmentInjectModeSelector
                        attachment={attachment}
                        onInjectModesChange={onInjectModesChange}
                        disabled={attachment.status !== 'ready' && chipStatus.lifecycle !== 'processing'}
                        processingStatus={normalizedStoreStatus}
                      />
                      {(isPartial || isBusy) && (
                        <div className="flex flex-col items-start gap-1">
                          <p
                            role="status"
                            data-testid={`attachment-chip-mode-status-${attachment.id}`}
                            className={cn(
                              'max-w-[16rem] text-2xs leading-snug',
                              isPartial ? 'text-warning' : 'text-info',
                            )}
                          >
                            {statusTitle}
                          </p>
                          {isPartial && chipStatus.mediaType && chipStatus.readyModes.length > 0 && (
                            <DsButton
                              type="button"
                              variant="ghost"
                              size="sm"
                              data-testid={`attachment-chip-use-ready-${attachment.id}`}
                              onClick={() => {
                                const mediaKey = chipStatus.mediaType;
                                if (!mediaKey) return;
                                onInjectModesChange(attachment.id, {
                                  ...(attachment.injectModes ?? {}),
                                  [mediaKey]: [...chipStatus.readyModes],
                                });
                              }}
                              className="!h-6 !px-1.5 text-2xs font-medium text-primary hover:bg-primary/10"
                            >
                              {t('chatV2:inputBar.useReadyModes', {
                                modes: formatModeSummary(chipStatus.readyModes),
                              })}
                            </DsButton>
                          )}
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              {/* 错误态/部分未就绪态内联重试（chip 外侧尾随，44px 触控命中区） */}
              {(isError || isPartial) && onRetry && attachment.sourceId && !disabled && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRetry(attachment);
                  }}
                  aria-label={t('chatV2:common.retryNamed', { name: attachment.name })}
                  title={t('common:retry')}
                  className={cn(
                    'ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors motion-reduce:transition-none',
                    coarseHitClassFor24,
                    isError
                      ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                      : 'border-warning/40 text-warning hover:bg-warning/10'
                  )}
                >
                  <ArrowClockwise size={12} weight="bold" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </CustomScrollArea>

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
