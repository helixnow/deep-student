import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '../ui/shad/Textarea';
import { NotionButton } from '@/components/ui/NotionButton';
import { AppSelect } from '../ui/app-menu';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { NotionAlertDialog } from '../ui/NotionDialog';
import {
  Trash2,
  Bot,
  GraduationCap,
  Loader2,
  PenTool,
  ImagePlus,
  ChevronLeft,
  ChevronRight,
  X,
  FileText,
  ChevronDown,
} from 'lucide-react';
import UnifiedDragDropZone, { FILE_TYPES } from '../shared/UnifiedDragDropZone';
import { UnifiedModelSelector } from '../shared/UnifiedModelSelector';
import type { GradingMode, ModelInfo } from '@/essay-grading/essayGradingApi';
import type { UploadedImage } from '../EssayGradingWorkbench';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '../UnifiedNotification';
import { CustomScrollArea } from '../custom-scroll-area';

/** ★ F-2: 作文最大字符数限制（约 5 万字符） */
const ESSAY_MAX_CHARS = 50000;

interface InputPanelProps {
  inputText: string;
  setInputText: (text: string) => void;
  // 批阅模式
  modeId: string;
  setModeId: (id: string) => void;
  modes: GradingMode[];
  // 模型选择
  modelId: string;
  setModelId: (id: string) => void;
  models: ModelInfo[];
  // 旧版兼容（可选）
  essayType: string;
  setEssayType: (type: string) => void;
  gradeLevel: string;
  setGradeLevel: (level: string) => void;
  isGrading: boolean;
  onFilesDropped: (files: File[]) => void;
  ocrMaxFiles: number;
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
  showPromptEditor: boolean;
  setShowPromptEditor: (show: boolean) => void;
  onSavePrompt: () => void;
  onRestoreDefaultPrompt: () => void;
  onClear: () => void;
  onGrade: () => void;
  onCancelGrading: () => void;
  charCount: number;
  // 多轮相关
  currentRound: number;
  hasResult: boolean;
  onNextRound: () => void;
  onOpenSettings?: () => void;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
  };
  // ★ 图片预览
  uploadedImages?: UploadedImage[];
  onRemoveImage?: (imageId: string) => void;
  // ★ 题目元数据
  topicText?: string;
  setTopicText?: (text: string) => void;
  topicImages?: UploadedImage[];
  onTopicFilesDropped?: (files: File[]) => void;
  onRemoveTopicImage?: (imageId: string) => void;
}

/**
 * 取消确认按钮组件 - Notion 风格
 */
const CancelConfirmButton: React.FC<{ onCancel: () => void }> = ({ onCancel }) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <>
      <NotionButton variant="ghost" size="sm" onClick={() => setShowConfirm(true)} className="text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {t('common:cancel')}
      </NotionButton>
      <NotionAlertDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title={t('essay_grading:actions.cancel_confirm_title')}
        description={t('essay_grading:actions.cancel_confirm_message')}
        confirmText={t('common:confirm')}
        cancelText={t('common:cancel')}
        confirmVariant="primary"
        onConfirm={() => { setShowConfirm(false); onCancel(); }}
      />
    </>
  );
};

export const InputPanel = React.forwardRef<HTMLTextAreaElement, InputPanelProps>(({
  inputText,
  setInputText,
  modeId,
  setModeId,
  modes,
  modelId,
  setModelId,
  models,
  essayType,
  setEssayType,
  gradeLevel,
  setGradeLevel,
  isGrading,
  onFilesDropped,
  ocrMaxFiles,
  customPrompt,
  setCustomPrompt,
  showPromptEditor,
  setShowPromptEditor,
  onSavePrompt,
  onRestoreDefaultPrompt,
  onClear,
  onGrade,
  onCancelGrading,
  charCount,
  currentRound,
  hasResult,
  onNextRound,
  onOpenSettings,
  roundNavigation,
  uploadedImages,
  onRemoveImage,
  topicText,
  setTopicText,
  topicImages,
  onTopicFilesDropped,
  onRemoveTopicImage,
}, ref) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const topicFileInputRef = React.useRef<HTMLInputElement>(null);
  const [showTopicSection, setShowTopicSection] = useState(false);

  // 确保 inputText 有默认值，防止 undefined
  const safeInputText = inputText ?? '';

  // 获取当前选中的模式
  const currentMode = modes.find(m => m.id === modeId);
  
  // 获取默认模型
  const defaultModel = models.find(m => m.is_default);
  const topicImageCount = topicImages?.length ?? 0;
  const hasTopicContent = Boolean(topicText?.trim()) || topicImageCount > 0;

  // ---- 自研滚动条：合并转发 ref + textarea 自动调高 ----
  const internalRef = React.useRef<HTMLTextAreaElement>(null);
  const mergedRef = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      internalRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
    },
    [ref],
  );

  // 文本变化时自动调高（让 CustomScrollArea 接管溢出滚动）
  React.useLayoutEffect(() => {
    const el = internalRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [safeInputText]);

  // 宽度变化时重新计算（面板拖拽缩放等场景）
  React.useEffect(() => {
    const el = internalRef.current;
    if (!el) return;
    let prevW = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w !== prevW) {
        prevW = w;
        requestAnimationFrame(() => {
          el.style.height = 'auto';
          el.style.height = `${el.scrollHeight}px`;
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 transition-all duration-200 border-b lg:border-b-0 lg:border-r border-border/40 relative group/source">
      {/* Toolbar - Notion 风格简洁布局 */}
      <div className="flex h-[41px] items-center px-4 border-b border-border/30 gap-1.5">
        {/* 左侧：模式选择 - 保持固定宽度 */}
        {modes.length > 0 && (
          <div className="min-w-0 max-w-[50%] sm:max-w-none sm:shrink-0">
            <AppSelect
              value={modeId}
              onValueChange={setModeId}
              variant="ghost"
              size="sm"
              triggerIcon={<GraduationCap className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
              className="max-w-full text-sm text-foreground/80 hover:text-foreground hover:bg-muted/50 transition-colors"
              placeholder={t('essay_grading:mode.select')}
              options={modes.map((mode) => ({
                value: mode.id,
                label: mode.name,
                description: t('essay_grading:mode.max_score', { score: mode.total_max_score }),
              }))}
            />
          </div>
        )}
        
        {/* 填充空间 */}
        <div className="flex-1 min-w-0" />
        
        {/* 右侧：操作按钮组 - 不收缩 */}
        <div className="flex items-center gap-1 shrink-0">
          <CommonTooltip content={t('essay_grading:import_images.hint', { max: ocrMaxFiles })}>
            <NotionButton variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isGrading} aria-label={t('common:aria.upload_image')} className="hidden sm:flex h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 disabled:opacity-40">
              <ImagePlus className="w-3.5 h-3.5" />
              <span className="text-xs hidden xl:inline">{t('essay_grading:import_images.button')}</span>
            </NotionButton>
          </CommonTooltip>
          
          {/* 非移动端：设置按钮（始终显示图标，大屏显示文字） */}
          {onOpenSettings && (
            <CommonTooltip content={t('essay_grading:settings.title')}>
              <NotionButton variant="ghost" size="sm" onClick={onOpenSettings} className="h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50">
                <PenTool className="w-3.5 h-3.5" />
                <span className="text-xs hidden xl:inline">{t('essay_grading:settings.title')}</span>
              </NotionButton>
            </CommonTooltip>
          )}
          
          {/* 非移动端：轮次显示 */}
          {currentRound > 0 && (
            <span className="hidden sm:inline text-xs text-muted-foreground/60 whitespace-nowrap tabular-nums">
              {t('essay_grading:round.label', { number: currentRound })}
            </span>
          )}

          {roundNavigation && roundNavigation.total > 1 && (
            <div className="hidden sm:flex items-center gap-1">
              <NotionButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onPrev} disabled={roundNavigation.currentIndex <= 0} aria-label={t('common:aria.previous_round')} className="!h-6 !w-6 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 disabled:opacity-30">
                <ChevronLeft className="w-3.5 h-3.5" />
              </NotionButton>
              <div className="flex items-center gap-0.5">
                {Array.from({ length: roundNavigation.total }, (_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "w-1.5 h-1.5 rounded-full transition-colors",
                      i === roundNavigation.currentIndex
                        ? "bg-primary"
                        : "bg-muted-foreground/20"
                    )}
                  />
                ))}
              </div>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onNext} disabled={roundNavigation.currentIndex >= roundNavigation.total - 1} aria-label={t('common:aria.next_round')} className="!h-6 !w-6 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50 disabled:opacity-30">
                <ChevronRight className="w-3.5 h-3.5" />
              </NotionButton>
            </div>
          )}
          
          {/* 移动端：字符统计 + 清空 + 批改按钮 */}
          <div className="sm:hidden flex items-center gap-1">
            <span className="text-xs text-muted-foreground/60 tabular-nums">
              {charCount}
            </span>
            {safeInputText && !isGrading && (
              <NotionButton variant="ghost" size="icon" iconOnly onClick={onClear} aria-label={t('common:aria.clear_content')} className="!h-7 !w-7 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50">
                <Trash2 className="w-3.5 h-3.5" />
              </NotionButton>
            )}
            {isGrading ? (
              <NotionButton variant="ghost" size="sm" onClick={onCancelGrading} aria-label={t('common:aria.cancel_grading')} className="h-7 px-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              </NotionButton>
            ) : (
              <NotionButton
                variant="primary"
                size="sm"
                onClick={onGrade}
                disabled={!safeInputText.trim()}
              >
                {t('essay_grading:actions.grade')}
              </NotionButton>
            )}
          </div>
        </div>
      </div>

      {/* ★ 图片缩略图预览条 */}
      {uploadedImages && uploadedImages.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border/30 overflow-x-auto">
          <span className="text-xs text-muted-foreground/60 shrink-0">
            {t('essay_grading:images.essay_images', { count: uploadedImages.length })}
          </span>
          <div className="flex items-center gap-1.5">
            {uploadedImages.map((img) => (
              <div key={img.id} className="relative group/thumb shrink-0">
                <img
                  src={img.dataUrl}
                  alt={img.fileName}
                  className={cn(
                    "w-10 h-10 object-cover rounded border",
                    img.ocrStatus === 'error' || img.ocrStatus === 'timeout'
                      ? "border-destructive/60 opacity-75"
                      : img.ocrStatus === 'done'
                        ? "border-primary/40"
                        : "border-border/40"
                  )}
                  title={img.fileName}
                />
                {/* OCR 状态指示器 */}
                {(img.ocrStatus === 'pending' || img.ocrStatus === 'processing') && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded">
                    <Loader2 className="w-4 h-4 text-white animate-spin" />
                  </div>
                )}
                {img.ocrStatus === 'retrying' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/30 rounded">
                    <Loader2 className="w-3.5 h-3.5 text-yellow-300 animate-spin" />
                    <span className="text-[7px] text-yellow-300 mt-0.5">Retry</span>
                  </div>
                )}
                {img.ocrStatus === 'timeout' && (
                  <div className="absolute bottom-0 left-0 right-0 bg-yellow-500/80 text-[8px] text-white text-center leading-tight rounded-b">
                    Timeout
                  </div>
                )}
                {img.ocrStatus === 'error' && (
                  <div className="absolute bottom-0 left-0 right-0 bg-destructive/80 text-[8px] text-white text-center leading-tight rounded-b">
                    Error
                  </div>
                )}
                {!isGrading && onRemoveImage && (
                  <button
                    onClick={() => onRemoveImage(img.id)}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                    aria-label={t('common:delete')}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ★ 题目元数据折叠区 */}
      {setTopicText && (
        <div className="border-b border-border/30">
          <button
            onClick={() => setShowTopicSection(!showTopicSection)}
            className={cn(
              'flex items-center gap-2 w-full px-4 py-2 text-xs transition-colors',
              showTopicSection
                ? 'text-foreground bg-muted/25'
                : 'text-muted-foreground/70 hover:text-foreground hover:bg-muted/20'
            )}
          >
            <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-muted/60">
              <FileText className="w-3 h-3" />
            </span>
            <span className="font-medium">{t('essay_grading:topic.toggle_label')}</span>
            {hasTopicContent && (
              <span className="inline-flex items-center rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                {topicImageCount > 0 ? `${topicImageCount} 图` : '已填写'}
              </span>
            )}
            <ChevronDown className={cn('w-3.5 h-3.5 ml-auto transition-transform', showTopicSection && 'rotate-180')} />
          </button>
          {showTopicSection && (
            <div className="px-3 pb-3">
              <div className="rounded-lg border border-border/40 bg-muted/[0.18] p-3 space-y-2.5">
              <Textarea
                value={topicText ?? ''}
                onChange={(e) => setTopicText(e.target.value)}
                placeholder={t('essay_grading:topic.placeholder')}
                className="w-full min-h-[72px] max-h-[144px] resize-y text-sm leading-relaxed !border-border/35 !bg-background/80 focus:!ring-1 focus:!ring-primary/20"
                disabled={isGrading}
              />
              {/* 题目参考图片 */}
              <div className="flex items-center gap-2 flex-wrap">
                {topicImages && topicImages.map((img) => (
                  <div key={img.id} className="relative group/thumb shrink-0">
                    <img
                      src={img.dataUrl}
                      alt={img.fileName}
                      className="w-11 h-11 object-cover rounded-md border border-border/40 bg-background"
                      title={img.fileName}
                    />
                    {!isGrading && onRemoveTopicImage && (
                      <button
                        onClick={() => onRemoveTopicImage(img.id)}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity"
                        aria-label={t('common:delete')}
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                ))}
                {onTopicFilesDropped && !isGrading && (
                  <button
                    onClick={() => topicFileInputRef.current?.click()}
                    className="w-11 h-11 rounded-md border border-dashed border-border/60 bg-background/60 flex items-center justify-center text-muted-foreground/55 hover:text-foreground hover:border-foreground/35 hover:bg-muted/20 transition-colors"
                    aria-label={t('essay_grading:topic.add_image')}
                  >
                    <ImagePlus className="w-4 h-4" />
                  </button>
                )}
              </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Content - Notion 风格编辑区 */}
      <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
        <UnifiedDragDropZone
          zoneId="essay-grading-upload"
          onFilesDropped={onFilesDropped}
          acceptedFileTypes={[FILE_TYPES.IMAGE]}
          maxFiles={ocrMaxFiles}
          maxFileSize={50 * 1024 * 1024}
          className="flex-1 min-h-0 flex flex-col relative"
        >
          {!safeInputText && !isGrading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10 pointer-events-none">
              <div className="text-center space-y-3 pointer-events-auto">
                <div>
                  <h3 className="text-sm font-medium text-foreground/70">{t('essay_grading:empty_state.title')}</h3>
                  <p className="text-xs text-muted-foreground/50 mt-1 max-w-[240px]">{t('essay_grading:empty_state.description')}</p>
                </div>
                <NotionButton variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} className="text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/50 border border-border/30">
                  <ImagePlus className="w-3.5 h-3.5" />
                  {t('essay_grading:empty_state.ocr_hint')}
                </NotionButton>
              </div>
            </div>
          )}
          <CustomScrollArea className="flex-1 min-h-0">
            <Textarea
              ref={mergedRef}
              value={safeInputText}
              readOnly={isGrading}
              onChange={(e) => {
                const newValue = e.target.value;
                if (newValue.length <= ESSAY_MAX_CHARS) {
                  setInputText(newValue);
                } else if ((inputText ?? '').length < ESSAY_MAX_CHARS) {
                  showGlobalNotification('warning', t('essay_grading:char_limit.reached', { max: ESSAY_MAX_CHARS.toLocaleString() }));
                }
              }}
              maxLength={ESSAY_MAX_CHARS}
              placeholder={t('essay_grading:input_section.placeholder')}
              className="w-full min-h-full resize-none overflow-hidden px-5 py-5 text-[15px] leading-[1.8] !border-0 !shadow-none !rounded-none !bg-transparent focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!outline-none focus-visible:!outline-none selection:bg-primary/15 placeholder:text-muted-foreground/40"
            />
          </CustomScrollArea>
        </UnifiedDragDropZone>

        {/* Floating Bottom Controls - Notion 风格悬浮工具 */}
        <div className="absolute bottom-3 left-4 right-4 hidden sm:flex items-center justify-end pointer-events-none">
          {/* 字符统计和清空 - Notion 风格 */}
          {/* ★ F-2: 添加字符限制显示 */}
          <div className={cn(
            "pointer-events-auto flex items-center gap-2 shrink-0 transition-opacity duration-200",
            charCount > 0 ? "opacity-100" : "opacity-0 group-hover/source:opacity-100"
          )}>
            <span className={cn(
              "text-xs tabular-nums",
              charCount >= ESSAY_MAX_CHARS * 0.9
                ? "text-orange-500 dark:text-orange-400"
                : "text-muted-foreground/50"
            )}>
              {charCount.toLocaleString()} / {ESSAY_MAX_CHARS.toLocaleString()} {t('essay_grading:stats.characters')}
            </span>
            {safeInputText && (
              <CommonTooltip content={t('essay_grading:actions.clear')}>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={onClear} aria-label={t('common:aria.clear_content')} className="!h-6 !w-6 text-muted-foreground/50 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30">
                  <Trash2 className="w-3.5 h-3.5" />
                </NotionButton>
              </CommonTooltip>
            )}
          </div>
        </div>
      </div>

      {/* Action Bar - 移动端显示提交修改稿按钮 */}
      {hasResult && !isGrading && (
        <div className="sm:hidden px-4 py-2.5 border-t border-border/30 flex items-center justify-center">
          <NotionButton
            variant="default"
            size="lg"
            onClick={onNextRound}
            disabled={!safeInputText.trim()}
            className="w-full"
          >
            {t('essay_grading:actions.next_round')}
          </NotionButton>
        </div>
      )}

      {/* Action Bar - 桌面端 Notion 风格 */}
      <div className="hidden sm:flex px-4 py-2.5 border-t border-border/30 items-center gap-2">
        {/* 左侧：模型选择 - 向上展开 */}
        {models.length > 0 && (
          <div className="min-w-0">
            <UnifiedModelSelector
              models={models}
              value={modelId || defaultModel?.id || ''}
              onChange={setModelId}
              disabled={isGrading}
              triggerIcon={<Bot className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
              placeholder={t('essay_grading:model.select')}
              side="top"
            />
          </div>
        )}
        
        {/* 填充空间 */}
        <div className="flex-1" />
        
        {/* 右侧：操作按钮 */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 如果已有批改结果，显示"提交修改稿"按钮 */}
          {hasResult && !isGrading && (
            <NotionButton
              variant="default"
              size="lg"
              onClick={onNextRound}
              disabled={!safeInputText.trim()}
            >
              {t('essay_grading:actions.next_round')}
            </NotionButton>
          )}

          {isGrading ? (
            <CancelConfirmButton
              onCancel={onCancelGrading}
            />
          ) : (
            <NotionButton
              variant="primary"
              size="lg"
              onClick={onGrade}
              disabled={!safeInputText.trim()}
            >
              {t('essay_grading:actions.grade')}
            </NotionButton>
          )}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length > 0) {
            onFilesDropped(files);
          }
          e.target.value = '';
        }}
      />
      {/* 题目参考材料图片上传输入 */}
      {onTopicFilesDropped && (
        <input
          ref={topicFileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            if (files.length > 0) {
              onTopicFilesDropped(files);
            }
            e.target.value = '';
          }}
        />
      )}
    </div>
  );
});

InputPanel.displayName = 'InputPanel';
