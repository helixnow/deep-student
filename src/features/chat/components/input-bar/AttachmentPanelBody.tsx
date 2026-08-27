/**
 * 附件面板内容（从 InputBarUI.tsx 拆出）
 *
 * 桌面端 ComposerPanelOverlay 与移动端 ComposerInlinePanel 共用同一份面板体。
 * 纯展示组件：附件列表、逐行状态/进度/注入模式选择器，以及头部操作
 * （添加 / 资源库 / 拍照 / 全部清除 / 关闭）。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Paperclip,
  CheckCircle,
  Warning,
  Clock,
  XCircle,
  Camera,
  CircleNotch,
  FolderOpen,
  DotsThree,
  Trash,
  X,
} from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
} from '@/components/ui/app-menu/AppMenu';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import type { PdfProcessingStatus as StorePdfProcessingStatus } from '@/features/pdf/stores/pdfProcessingStore';
import type { AttachmentMeta } from '../../core/types/common';
import type { AttachmentInjectModes } from '../../core/types/common';
import { AttachmentInjectModeSelector } from './AttachmentInjectModeSelector';
import {
  type MediaInjectMode,
  getMediaTypeForAttachment,
} from './injectModeUtils';
import {
  getSelectedModes,
  getEffectiveReadyModes,
  getMissingModes,
  getDisplayPercent,
  getStageLabel,
} from './attachmentModeHelpers';

/**
 * 行目标体系化：菜单行/列表行在 pointer:coarse 下实体高度 ≥44px，
 * 统一走 --touch-target-size token（与 AppMenu.css 的 coarse 基线一致），
 * 不再散写 min-h-[44px] 魔法数。
 */
const coarseRowClass = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';

export interface AttachmentPanelBodyProps {
  attachments: AttachmentMeta[];
  isMobile: boolean;
  /**
   * 相机捕获能力（拍照入口）。上游传入 inputBarCapabilities.canCapturePhoto()
   * （平台/capture 特性判定），早已不是 pointer: coarse。prop 名为历史遗留，
   * 待改名为 canCapturePhoto。
   */
  isMobileEnv: boolean;
  /** PDF/图片处理进度 Store 快照（key = sourceId/file_id） */
  pdfStatusMap: Map<string, StorePdfProcessingStatus>;
  /** 模式列表 → 本地化字符串（父级持有 modeLabelMap） */
  formatModeList: (modes: MediaInjectMode[]) => string;
  /** 打开系统文件选择器 */
  onPickFiles: () => void;
  onOpenResourceLibrary: () => void;
  onOpenCamera: () => void;
  /** 关闭附件面板 */
  onClose: () => void;
  /** 错误态重试（父级共享给预览 chips 的同一处理器） */
  onRetryAttachment: (attachment: AttachmentMeta) => void;
  onInjectModesChange: (attachmentId: string, modes: AttachmentInjectModes) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  onClearAttachments: () => void;
}

export const AttachmentPanelBody: React.FC<AttachmentPanelBodyProps> = ({
  attachments,
  isMobile,
  isMobileEnv,
  pdfStatusMap,
  formatModeList,
  onPickFiles,
  onOpenResourceLibrary,
  onOpenCamera,
  onClose,
  onRetryAttachment,
  onInjectModesChange,
  onRemoveAttachment,
  onClearAttachments,
}) => {
  const { t } = useTranslation(['analysis', 'common', 'chatV2']);

  // remove/clear 语义已收敛进 store（sessionActions）：取消 PDF 处理、
  // 释放 Blob URL、清理 pdfProcessingStore 均由 store 单点执行，面板只传 id。

  return (
    <>
      {/* 面板头部：桌面横排全部操作；移动端折叠为 标题 + ⋯更多 + 关闭（P1-4） */}
      {isMobile ? (
        <div className="mb-2 flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
            <Paperclip size={16} weight="bold" className="shrink-0" />
            <span className="truncate">
              {t('chatV2:inputBar.plusMenu.attachmentsCount', { count: attachments.length })}
            </span>
          </div>
          <div className="flex shrink-0 items-center">
            <DsButton
              variant="outline"
              size="sm"
              className="!h-11 !min-w-11"
              onClick={onPickFiles}
            >
              + {t('analysis:input_bar.attachments.add')}
            </DsButton>
            <AppMenu>
              <AppMenuTrigger asChild>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  className="!h-11 !w-11"
                  aria-label={t('common:more', { defaultValue: 'More' })}
                  data-testid="attachment-panel-more"
                >
                  <DotsThree size={20} weight="bold" />
                </DsButton>
              </AppMenuTrigger>
              <AppMenuContent align="end" width={200}>
                <AppMenuItem
                  className={coarseRowClass}
                  icon={<FolderOpen className="w-4 h-4" weight="bold" />}
                  onClick={onOpenResourceLibrary}
                >
                  {t('chatV2:inputBar.resourceLibrary')}
                </AppMenuItem>
                {isMobileEnv && (
                  <AppMenuItem
                    className={coarseRowClass}
                    icon={<Camera className="w-4 h-4" weight="bold" />}
                    onClick={onOpenCamera}
                  >
                    {t('chatV2:inputBar.camera')}
                  </AppMenuItem>
                )}
                {attachments.length > 0 && (
                  <AppMenuItem
                    className={coarseRowClass}
                    icon={<Trash className="w-4 h-4" weight="bold" />}
                    destructive
                    onClick={onClearAttachments}
                  >
                    {t('analysis:input_bar.attachments.clear_all')}
                  </AppMenuItem>
                )}
              </AppMenuContent>
            </AppMenu>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="!h-11 !w-11"
              onClick={onClose}
              aria-label={t('common:actions.close')}
            >
              <X size={16} />
            </DsButton>
          </div>
        </div>
      ) : (
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Paperclip size={16} weight="bold" />
            <span>{t('chatV2:inputBar.plusMenu.attachmentsCount', { count: attachments.length })}</span>
          </div>
          <div className="flex items-center gap-2">
            <DsButton variant="outline" size="sm" className="[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]" onClick={onPickFiles}>
              + {t('analysis:input_bar.attachments.add')}
            </DsButton>
            {/* 资源库按钮 - 桌面端在右侧打开 Learning Hub 面板，移动端打开右侧滑屏 */}
            <DsButton
              variant="outline"
              size="sm"
              className="[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
              onClick={onOpenResourceLibrary}
            >
              <FolderOpen size={12} weight="bold" />
              {t('chatV2:inputBar.resourceLibrary')}
            </DsButton>
            {isMobileEnv && (
              <DsButton variant="outline" size="sm" className="[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]" onClick={onOpenCamera}>
                <Camera size={12} weight="bold" />
                {t('chatV2:inputBar.camera')}
              </DsButton>
            )}
            {attachments.length > 0 && (
              <DsButton variant="danger" size="sm" className="[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]" onClick={onClearAttachments}>
                {t('analysis:input_bar.attachments.clear_all')}
              </DsButton>
            )}
            <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]" onClick={onClose}>
              {t('common:actions.close')}
            </DsButton>
          </div>
        </div>
      )}

      {/* 附件列表 */}
      <CustomScrollArea
        fullHeight={false}
        className="max-h-56"
        viewportClassName="max-h-56 flex flex-col gap-2"
      >
        {attachments.length === 0 ? (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-[color:var(--composer-panel-control-border)] bg-[color:var(--composer-panel-muted-surface)] px-3 py-6 text-sm text-[color:var(--composer-panel-muted-foreground)]">
            {t('analysis:input_bar.attachments.empty')}
          </div>
        ) : (
          attachments.map((attachment) => {
            const isVfsRef = attachment.id.startsWith('vfs-');
            const sizeLabel = isVfsRef ? t('analysis:input_bar.attachments.reference') : `${(attachment.size / 1024).toFixed(1)} KB`;

            // 判断媒体类型（SSOT：MIME OR 扩展名；type === 'image' 作为兜底）
            const rowMediaType = getMediaTypeForAttachment(attachment)
              ?? (attachment.type === 'image' ? 'image' : null);
            const isPdf = rowMediaType === 'pdf';
            const isImage = rowMediaType === 'image';

            // 🆕 媒体处理中状态显示（PDF + 图片）
            const isPdfProcessing = isPdf && attachment.status === 'processing';
            const isImageProcessing = isImage && attachment.status === 'processing';
            const isMediaProcessing = isPdfProcessing || isImageProcessing;
            // 🔧 优化：优先使用 Store 中的最新状态
            // ★ P0 修复：使用 sourceId (file_id) 作为 key，与后端事件保持一致
            const storeStatus = isMediaProcessing && attachment.sourceId
              ? pdfStatusMap.get(attachment.sourceId)
              : undefined;
            // 类型兼容处理：Store 的 stage 包含 'pending'，需要转换为 common.ts 的类型
            const mediaProgress = storeStatus
              ? {
                ...storeStatus,
                stage: storeStatus.stage === 'pending' ? undefined : storeStatus.stage,
              } as typeof attachment.processingStatus
              : (isMediaProcessing ? attachment.processingStatus : undefined);
            const selectedModes = getSelectedModes(attachment, isPdf, isImage);
            const mediaType = isPdf ? 'pdf' : 'image';
            const statusForModes = attachment.status === 'ready'
              ? attachment.processingStatus
              : mediaProgress;
            const readyModes = getEffectiveReadyModes(statusForModes, mediaType, attachment);
            const missingModes = getMissingModes(selectedModes, readyModes);
            const missingModesLabel = missingModes.length > 0 ? formatModeList(missingModes) : '';
            const displayPercent = getDisplayPercent(mediaProgress, isPdf);
            let stageLabel = getStageLabel(t, mediaProgress, isPdf, isImage);
            if ((mediaProgress?.stage === 'completed' || mediaProgress?.stage === 'completed_with_issues') && missingModesLabel) {
              stageLabel = t('chatV2:inputBar.completedMissingModes', {
                modes: missingModesLabel,
              });
            }
            const isUploading = attachment.status === 'uploading' || attachment.status === 'pending';
            // ★ 视觉统一：状态色改走语义 token（success/warning/destructive/info），
            // 亮暗色由 token 自适应，不再散落 Tailwind 调色板 + dark: 补丁
            const statusIcon =
              attachment.status === 'ready' && missingModes.length > 0
                ? <Warning size={12} weight="bold" className="text-warning" />
                : attachment.status === 'ready' ? <CheckCircle size={12} weight="fill" className="text-success" />
                  : attachment.status === 'error' ? <XCircle size={12} weight="fill" className="text-destructive" />
                    : (isMediaProcessing || isUploading) ? <CircleNotch size={12} weight="bold" className="text-info animate-spin motion-reduce:animate-none" />
                      : <Clock size={12} weight="bold" className="text-muted-foreground" />;
            const toneClass = isVfsRef
              ? 'border-info/25 bg-info/10'
              : attachment.status === 'error' ? 'border-destructive/25 bg-destructive/10'
                : attachment.status === 'ready' && missingModes.length > 0
                  ? 'border-warning/25 bg-warning/10'
                  : attachment.status === 'ready' ? 'border-success/25 bg-success/10'
                    : (isMediaProcessing || isUploading) ? 'border-info/25 bg-info/10'
                      : 'border-[color:var(--composer-panel-control-border)] bg-[color:var(--composer-panel-control-surface)]';

            // 判断是否为图片或 PDF（需要显示注入模式选择器）
            const showInjectModeSelector = isImage || isPdf;

            return (
              <div key={attachment.id} data-wb-blur-surface className={cn('attachment-row flex flex-col gap-1.5 rounded-lg border backdrop-blur p-2 transition-colors duration-200 ease-out hover:bg-[color:var(--composer-panel-control-hover)] focus-within:border-[color:var(--composer-panel-focus-border)] motion-reduce:transition-none', coarseRowClass, toneClass)}>
                {/* 第一行：文件名、大小、状态、移除按钮 */}
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-ui text-foreground truncate block">{attachment.name}</span>
                    {attachment.status === 'error' && attachment.error && <span className="text-[11px] text-destructive truncate block">{attachment.error}</span>}
                    {/* 🆕 统一进度条：上传(0-50%) + 处理(50-100%) */}
                    {(() => {
                      // 计算统一进度百分比和阶段标签
                      let unifiedPercent: number | null = null;
                      let unifiedLabel = '';

                      if (isUploading && attachment.uploadProgress != null) {
                        // 上传阶段：直接使用 uploadProgress (0-50%)
                        unifiedPercent = attachment.uploadProgress;
                        unifiedLabel = t(`chatV2:inputBar.uploadStage.${attachment.uploadStage || 'reading'}`);
                      } else if (isMediaProcessing && mediaProgress) {
                        // 处理阶段：后端 0-100% 映射到 50-100%
                        unifiedPercent = 50 + Math.round(displayPercent * 0.5);
                        unifiedLabel = stageLabel || '';
                      }

                      if (unifiedPercent == null) return null;

                      return (
                        <div className="flex items-center gap-2 mt-0.5">
                          <div className="flex-1 h-1 rounded-full bg-[color:var(--composer-panel-muted-surface)] overflow-hidden">
                            <div
                              className="h-full bg-info transition-[width] duration-300 motion-reduce:transition-none"
                              style={{ width: `${unifiedPercent}%` }}
                            />
                          </div>
                          <span className="text-2xs text-info whitespace-nowrap">
                            {unifiedLabel}{unifiedPercent > 0 ? ` · ${unifiedPercent}%` : ''}
                          </span>
                        </div>
                      );
                    })()}
                    {missingModesLabel && !isUploading && (
                      <div className="mt-0.5 text-2xs text-warning">
                        {t('chatV2:inputBar.modesNotReady', { modes: missingModesLabel })}
                      </div>
                    )}
                  </div>
                  <span className={cn("text-[12px]", isVfsRef ? "text-info font-medium" : "text-muted-foreground")}>{sizeLabel}</span>
                  <span className="flex items-center gap-1">{statusIcon}</span>
                  {/* ★ P0 修复：错误状态时显示重试按钮（使用正确的 sourceId） */}
                  {attachment.status === 'error' && attachment.sourceId && (
                    <DsButton
                      variant="outline"
                      size="sm"
                      onClick={() => { onRetryAttachment(attachment); }}
                      className="text-info [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]"
                    >
                      {t('common:retry')}
                    </DsButton>
                  )}
                  <DsButton variant="danger" size="sm" className="[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]" onClick={() => onRemoveAttachment(attachment.id)}>
                    {t('analysis:input_bar.attachments.remove')}
                  </DsButton>
                </div>
                {/* 第二行：注入模式选择器（仅图片和 PDF 显示，PDF 在处理中也显示） */}
                {showInjectModeSelector && (attachment.status === 'ready' || isMediaProcessing) && (
                  <div className="flex items-center gap-2 pl-1">
                    <span className="text-[11px] text-muted-foreground">{t('chatV2:injectMode.label')}:</span>
                    <AttachmentInjectModeSelector
                      attachment={attachment}
                      onInjectModesChange={onInjectModesChange}
                      disabled={attachment.status !== 'ready' && !isMediaProcessing}
                      processingStatus={mediaProgress}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </CustomScrollArea>
    </>
  );
};

export default AttachmentPanelBody;
