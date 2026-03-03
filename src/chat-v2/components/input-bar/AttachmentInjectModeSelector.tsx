/**
 * AttachmentInjectModeSelector - 附件注入模式选择器
 *
 * 允许用户为图片和 PDF 附件选择注入模式：
 * - 图片：图片（多模态）/ OCR 文本
 * - PDF：解析文本 / 页面 OCR / 页面图片（多模态）
 *
 * 支持多选，选择的模式会影响发送时如何将内容注入到消息中。
 * 采用直接点选的标签式 UI，无需打开下拉菜单。
 */

import React, { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, FileText, ScanText, Images, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { AttachmentMeta, ImageInjectMode, PdfInjectMode, AttachmentInjectModes, PdfProcessingStatus } from '../../core/types/common';
import { DEFAULT_IMAGE_INJECT_MODES, DEFAULT_PDF_INJECT_MODES } from '../../core/types/common';
import { logAttachment } from '../../debug/chatV2Logger';

// ============================================================================
// 类型定义
// ============================================================================

export interface AttachmentInjectModeSelectorProps {
  /** 附件元数据 */
  attachment: AttachmentMeta;
  /** 注入模式变更回调 */
  onInjectModesChange: (attachmentId: string, modes: AttachmentInjectModes) => void;
  /** 是否禁用（如上传中） */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 🆕 PDF 处理状态（用于显示哪些模式已就绪） */
  processingStatus?: PdfProcessingStatus;
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 判断附件是否为图片类型
 */
function isImageAttachment(attachment: AttachmentMeta): boolean {
  return attachment.type === 'image' || attachment.mimeType.startsWith('image/');
}

/**
 * 判断附件是否为 PDF 类型
 */
function isPdfAttachment(attachment: AttachmentMeta): boolean {
  return attachment.mimeType === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf');
}


// ============================================================================
// 可点选标签组件
// ============================================================================

interface ToggleTagProps {
  /** 是否选中 */
  selected: boolean;
  /** 点击回调 */
  onToggle: () => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 图标 */
  icon: React.ElementType;
  /** 标签文本 */
  label: string;
  /** 提示文本 */
  title?: string;
  /** 自定义类名 */
  className?: string;
  /** 🆕 是否处理中（显示加载动画） */
  isProcessing?: boolean;
  /** 🆕 是否已就绪（用于处理中状态下区分） */
  isReady?: boolean;
}

const ToggleTag: React.FC<ToggleTagProps> = memo(({
  selected,
  onToggle,
  disabled = false,
  icon: Icon,
  label,
  title,
  className,
  isProcessing = false,
  isReady = true,
}) => {
  // 处理中但未就绪时显示特殊样式
  const processingNotReady = isProcessing && !isReady;
  
  return (
    <NotionButton
      variant="ghost"
      size="sm"
      onClick={onToggle}
      disabled={disabled || processingNotReady}
      title={processingNotReady ? `${label}...` : title}
      className={cn(
        '!h-auto !px-1.5 !py-0.5 text-[10px] !rounded',
        'border',
        processingNotReady
          ? 'bg-blue-50/50 text-blue-500/70 border-blue-200/40 dark:bg-blue-900/20 dark:text-blue-400/70 dark:border-blue-700/40 cursor-wait'
          : selected
            ? 'bg-primary/15 text-primary border-primary/40 dark:bg-primary/20 dark:border-primary/50'
            : 'bg-muted/30 text-muted-foreground/70 border-transparent hover:bg-muted/50 hover:text-muted-foreground',
        (disabled && !processingNotReady) && 'opacity-40',
        className
      )}
    >
      {processingNotReady ? (
        <Loader2 size={11} className="animate-spin" />
      ) : (
        <Icon size={11} />
      )}
      <span>{label}</span>
    </NotionButton>
  );
});

ToggleTag.displayName = 'ToggleTag';

// ============================================================================
// 图片模式选择器
// ============================================================================

interface ImageModeSelectorProps {
  selectedModes: ImageInjectMode[];
  onChange: (modes: ImageInjectMode[]) => void;
  disabled?: boolean;
  className?: string;
  /** ★ P1 修复：添加处理状态支持（用于显示哪些模式已就绪） */
  processingStatus?: PdfProcessingStatus;
}

const ImageModeSelector: React.FC<ImageModeSelectorProps> = memo(({
  selectedModes,
  onChange,
  disabled = false,
  className,
  processingStatus,
}) => {
  const { t } = useTranslation(['chatV2']);

  const handleToggle = useCallback((mode: ImageInjectMode) => {
    const isSelected = selectedModes.includes(mode);
    let newModes: ImageInjectMode[];
    
    if (isSelected) {
      // 至少保留一个模式
      if (selectedModes.length > 1) {
        newModes = selectedModes.filter(m => m !== mode);
      } else {
        return; // 无变化
      }
    } else {
      newModes = [...selectedModes, mode];
    }
    
    // ★ 调试日志：记录注入模式选择变化
    console.log('[InjectMode] Image mode changed:', { before: selectedModes, after: newModes, toggledMode: mode });
    logAttachment('ui', 'inject_mode_change', {
      mediaType: 'image',
      before: selectedModes,
      after: newModes,
      toggledMode: mode,
      action: isSelected ? 'remove' : 'add',
    });
    
    onChange(newModes);
  }, [selectedModes, onChange]);

  const isProcessing = !!processingStatus
    && processingStatus.stage !== 'completed'
    && processingStatus.stage !== 'completed_with_issues'
    && processingStatus.stage !== 'error';
  const readyModes = new Set(processingStatus?.readyModes || []);
  
  const isModeReady = (mode: ImageInjectMode) => {
    if (!processingStatus) return true;
    if (mode === 'image') return true;
    return readyModes.has(mode);
  };

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <ToggleTag
        selected={selectedModes.includes('image')}
        onToggle={() => handleToggle('image')}
        disabled={disabled || (selectedModes.includes('image') && selectedModes.length === 1)}
        icon={Image}
        label={t('chatV2:injectMode.image.image')}
        title={t('chatV2:injectMode.image.imageDesc')}
        isProcessing={isProcessing && !isModeReady('image')}
        isReady={isModeReady('image')}
      />
      <ToggleTag
        selected={selectedModes.includes('ocr')}
        onToggle={() => handleToggle('ocr')}
        disabled={disabled || (selectedModes.includes('ocr') && selectedModes.length === 1)}
        icon={ScanText}
        label={t('chatV2:injectMode.image.ocr')}
        title={t('chatV2:injectMode.image.ocrDesc')}
        isProcessing={isProcessing && !isModeReady('ocr')}
        isReady={isModeReady('ocr')}
      />
    </div>
  );
});

ImageModeSelector.displayName = 'ImageModeSelector';

// ============================================================================
// PDF 模式选择器
// ============================================================================

interface PdfModeSelectorProps {
  selectedModes: PdfInjectMode[];
  onChange: (modes: PdfInjectMode[]) => void;
  disabled?: boolean;
  className?: string;
  /** 🆕 处理状态（用于显示哪些模式已就绪） */
  processingStatus?: PdfProcessingStatus;
}

const PdfModeSelector: React.FC<PdfModeSelectorProps> = memo(({
  selectedModes,
  onChange,
  disabled = false,
  className,
  processingStatus,
}) => {
  const { t } = useTranslation(['chatV2']);

  const handleToggle = useCallback((mode: PdfInjectMode) => {
    const isSelected = selectedModes.includes(mode);
    let newModes: PdfInjectMode[];
    
    if (isSelected) {
      // 至少保留一个模式
      if (selectedModes.length > 1) {
        newModes = selectedModes.filter(m => m !== mode);
      } else {
        return; // 无变化
      }
    } else {
      newModes = [...selectedModes, mode];
    }
    
    // ★ 调试日志：记录注入模式选择变化
    console.log('[InjectMode] PDF mode changed:', { before: selectedModes, after: newModes, toggledMode: mode });
    logAttachment('ui', 'inject_mode_change', {
      mediaType: 'pdf',
      before: selectedModes,
      after: newModes,
      toggledMode: mode,
      action: isSelected ? 'remove' : 'add',
    });
    
    onChange(newModes);
  }, [selectedModes, onChange]);

  // 🆕 检查模式是否已就绪
  const isProcessing = !!processingStatus
    && processingStatus.stage !== 'completed'
    && processingStatus.stage !== 'completed_with_issues'
    && processingStatus.stage !== 'error';
  const readyModes = new Set(processingStatus?.readyModes || []);
  
  const isModeReady = (mode: PdfInjectMode) => {
    if (!processingStatus) return mode === 'text';
    return readyModes.has(mode);
  };

  return (
    <div className={cn('inline-flex items-center gap-1', className)}>
      <ToggleTag
        selected={selectedModes.includes('text')}
        onToggle={() => handleToggle('text')}
        disabled={disabled || (selectedModes.includes('text') && selectedModes.length === 1)}
        icon={FileText}
        label={t('chatV2:injectMode.pdf.text')}
        title={t('chatV2:injectMode.pdf.textDesc')}
        isProcessing={isProcessing}
        isReady={isModeReady('text')}
      />
      <ToggleTag
        selected={selectedModes.includes('ocr')}
        onToggle={() => handleToggle('ocr')}
        disabled={disabled || (selectedModes.includes('ocr') && selectedModes.length === 1)}
        icon={ScanText}
        label={t('chatV2:injectMode.pdf.ocr')}
        title={t('chatV2:injectMode.pdf.ocrDesc')}
        isProcessing={isProcessing}
        isReady={isModeReady('ocr')}
      />
      <ToggleTag
        selected={selectedModes.includes('image')}
        onToggle={() => handleToggle('image')}
        disabled={disabled || (selectedModes.includes('image') && selectedModes.length === 1)}
        icon={Images}
        label={t('chatV2:injectMode.pdf.image')}
        title={t('chatV2:injectMode.pdf.imageDesc')}
        isProcessing={isProcessing}
        isReady={isModeReady('image')}
      />
    </div>
  );
});

PdfModeSelector.displayName = 'PdfModeSelector';

// ============================================================================
// 主组件
// ============================================================================

/**
 * AttachmentInjectModeSelector - 附件注入模式选择器
 *
 * 根据附件类型自动显示对应的模式选择器：
 * - 图片：显示图片模式选择器
 * - PDF：显示 PDF 模式选择器
 * - 其他类型：不显示选择器
 */
export const AttachmentInjectModeSelector: React.FC<AttachmentInjectModeSelectorProps> = memo(({
  attachment,
  onInjectModesChange,
  disabled = false,
  className,
  processingStatus,
}) => {
  const isImage = isImageAttachment(attachment);
  const isPdf = isPdfAttachment(attachment);

  // 获取当前选中的模式
  const currentImageModes = useMemo(() => {
    return attachment.injectModes?.image ?? DEFAULT_IMAGE_INJECT_MODES;
  }, [attachment.injectModes?.image]);

  const currentPdfModes = useMemo(() => {
    return attachment.injectModes?.pdf ?? DEFAULT_PDF_INJECT_MODES;
  }, [attachment.injectModes?.pdf]);

  // 处理图片模式变更
  const handleImageModesChange = useCallback((modes: ImageInjectMode[]) => {
    onInjectModesChange(attachment.id, {
      ...attachment.injectModes,
      image: modes,
    });
  }, [attachment.id, attachment.injectModes, onInjectModesChange]);

  // 处理 PDF 模式变更
  const handlePdfModesChange = useCallback((modes: PdfInjectMode[]) => {
    onInjectModesChange(attachment.id, {
      ...attachment.injectModes,
      pdf: modes,
    });
  }, [attachment.id, attachment.injectModes, onInjectModesChange]);

  // 非图片/PDF 类型不显示选择器
  if (!isImage && !isPdf) {
    return null;
  }

  // 上传中或错误状态时禁用（processing 状态允许选择已就绪的模式）
  const isDisabled = disabled || attachment.status === 'uploading' || attachment.status === 'error';
  const fallbackStatus: PdfProcessingStatus | undefined = attachment.status === 'processing'
    ? {
        stage: 'pending',
        percent: 0,
        readyModes: isImage ? ['image'] : [],
        mediaType: isPdf ? 'pdf' : 'image',
      }
    : undefined;
  const effectiveProcessingStatus = processingStatus || attachment.processingStatus || fallbackStatus;

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {isImage && (
        <ImageModeSelector
          selectedModes={currentImageModes}
          onChange={handleImageModesChange}
          disabled={isDisabled}
          processingStatus={effectiveProcessingStatus}
        />
      )}
      {isPdf && (
        <PdfModeSelector
          selectedModes={currentPdfModes}
          onChange={handlePdfModesChange}
          disabled={isDisabled}
          processingStatus={effectiveProcessingStatus}
        />
      )}
    </div>
  );
});

AttachmentInjectModeSelector.displayName = 'AttachmentInjectModeSelector';

export default AttachmentInjectModeSelector;
