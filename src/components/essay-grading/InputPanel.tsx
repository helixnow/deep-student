import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '../ui/shad/Textarea';
import { NotionButton } from '@/components/ui/NotionButton';
import { AppSelect } from '../ui/app-menu';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  Trash,
  Robot,
  GraduationCap,
  CircleNotch,
  PenNib,
  Image,
  CaretLeft,
  CaretRight,
  X,
  FileText,
  CaretDown,
  ClipboardText,
  UploadSimple,
  Sparkle,
} from '@phosphor-icons/react';
import UnifiedDragDropZone, { FILE_TYPES } from '../shared/UnifiedDragDropZone';
import { UnifiedModelSelector } from '../shared/UnifiedModelSelector';
import type { GradingMode, ModelInfo } from '@/essay-grading/essayGradingApi';
import type { EssayTextStats } from '@/essay-grading/textStats';
import type { UploadedImage } from '../EssayGradingWorkbench';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '../UnifiedNotification';

/** ★ F-2: 作文最大字符数限制（约 5 万字符） */
export const ESSAY_MAX_CHARS = 50000;

/** 批改阶段顺序（与 GradingMain 推断口径一致），用于锁定提示条的阶段进度点 */
const GRADING_PHASES = ['preparing', 'annotating', 'scoring', 'polishing', 'model_essay'] as const;
export type GradingPhaseId = (typeof GRADING_PHASES)[number];

/** 内联二段确认的自动复位时间 */
const INLINE_CONFIRM_TIMEOUT_MS = 3000;

/** 触屏命中区扩展：28px 图标钮扩到 ≥44px，视觉不变（与 InputBarUI.coarseHitAreaClass 同款范式） */
const COARSE_HIT =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']";

/** 缩略图角标删除钮（16px、absolute 定位）：命中区扩到 ~40px */
const COARSE_HIT_BADGE =
  "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3 [@media(pointer:coarse)]:after:content-['']";

/** Unicode 字符计数（避免 UTF-16 length 偏差，与父级统计口径一致） */
const getUnicodeCharCount = (text: string): number => Array.from(text).length;

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
  /** 批改中的阶段（仅 isGrading 时提供），驱动锁定提示条的阶段进度显示 */
  gradingPhase?: GradingPhaseId;
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
  textStats: EssayTextStats;
  // 多轮相关
  currentRound: number;
  onOpenSettings?: () => void;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    /** 直接跳转到指定轮次；提供时圆点点击优先走此回调 */
    onSelect?: (index: number) => void;
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
 * 内联二段确认：第一次点击进入"确认？"态，3 秒无操作自动复位，再次点击才执行。
 * 替代模态确认框（NotionAlertDialog），桌面与移动统一交互。
 */
function useInlineConfirm(onConfirm: () => void) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const handleClick = useCallback(() => {
    if (armed) {
      clearTimer();
      setArmed(false);
      onConfirm();
      return;
    }
    setArmed(true);
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      setArmed(false);
      timerRef.current = null;
    }, INLINE_CONFIRM_TIMEOUT_MS);
  }, [armed, clearTimer, onConfirm]);

  const reset = useCallback(() => {
    clearTimer();
    setArmed(false);
  }, [clearTimer]);

  return { armed, handleClick, reset };
}

/** OCR 状态角标（语义色 + i18n），叠加在缩略图上 */
const OcrStatusBadge: React.FC<{ img: UploadedImage }> = ({ img }) => {
  const { t } = useTranslation(['essay_grading']);

  if (img.ocrStatus === 'pending' || img.ocrStatus === 'processing') {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-black/35 rounded-md"
        role="status"
        aria-label={t('essay_grading:ocr_status.processing')}
      >
        <CircleNotch size={16} className="text-white animate-spin motion-reduce:animate-none" />
      </div>
    );
  }
  if (img.ocrStatus === 'retrying') {
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 rounded-md"
        role="status"
        aria-label={t('essay_grading:ocr_status.retrying')}
      >
        <CircleNotch size={13} className="text-amber-300 animate-spin motion-reduce:animate-none" />
        <span className="text-[8px] text-amber-300 mt-0.5 leading-none">{t('essay_grading:ocr_status.retrying')}</span>
      </div>
    );
  }
  if (img.ocrStatus === 'timeout') {
    return (
      <div className="absolute bottom-0 left-0 right-0 bg-amber-500/85 text-[8px] text-white text-center leading-tight rounded-b-md px-0.5">
        {t('essay_grading:ocr_status.timeout')}
      </div>
    );
  }
  if (img.ocrStatus === 'error') {
    return (
      <div className="absolute bottom-0 left-0 right-0 bg-destructive/85 text-destructive-foreground text-[8px] text-center leading-tight rounded-b-md px-0.5">
        {t('essay_grading:ocr_status.error')}
      </div>
    );
  }
  return null;
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
  gradingPhase,
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
  textStats,
  currentRound,
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

  // 获取默认模型
  const defaultModel = models.find(m => m.is_default);
  const topicImageCount = topicImages?.length ?? 0;
  const hasTopicContent = Boolean(topicText?.trim()) || topicImageCount > 0;

  const uploadedImageCount = uploadedImages?.length ?? 0;
  // ★ Bug#1 修复：有文字或有图片即可批改（与父级"有图即可批"逻辑对齐）
  const canGrade = safeInputText.trim().length > 0 || uploadedImageCount > 0;
  // 清空按钮的可见条件：有文字或有图片（onClear 会一并清空图片）
  const hasClearableContent = safeInputText.length > 0 || uploadedImageCount > 0;
  // ★ Bug#4 修复：有图片时不再显示空态覆盖层
  const showEmptyState = !safeInputText && !isGrading && uploadedImageCount === 0;

  // ── 内联二段确认（替代模态框） ──
  const desktopClearConfirm = useInlineConfirm(onClear);
  const mobileClearConfirm = useInlineConfirm(onClear);
  const desktopCancelConfirm = useInlineConfirm(onCancelGrading);
  const mobileCancelConfirm = useInlineConfirm(onCancelGrading);

  // 批改状态切换时复位确认态，避免残留的"确认？"按钮指向已失效的操作
  const resetDesktopClear = desktopClearConfirm.reset;
  const resetMobileClear = mobileClearConfirm.reset;
  const resetDesktopCancel = desktopCancelConfirm.reset;
  const resetMobileCancel = mobileCancelConfirm.reset;
  useEffect(() => {
    resetDesktopClear();
    resetMobileClear();
    resetDesktopCancel();
    resetMobileCancel();
  }, [isGrading, resetDesktopClear, resetMobileClear, resetDesktopCancel, resetMobileCancel]);

  // ── Bug#3 修复：超限输入统一截断 + 提示（含"已满时再粘贴"场景），通知节流防刷屏 ──
  const lastLimitNotifyRef = useRef(0);
  const notifyCharLimit = useCallback((truncated: boolean) => {
    const now = Date.now();
    if (now - lastLimitNotifyRef.current < 1500) return;
    lastLimitNotifyRef.current = now;
    showGlobalNotification(
      'warning',
      truncated
        ? t('essay_grading:char_limit.truncated', { max: ESSAY_MAX_CHARS.toLocaleString() })
        : t('essay_grading:char_limit.reached', { max: ESSAY_MAX_CHARS.toLocaleString() })
    );
  }, [t]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    if (getUnicodeCharCount(newValue) <= ESSAY_MAX_CHARS) {
      setInputText(newValue);
      return;
    }
    // 超限：按 Unicode 字符截断到上限，并提示（无论此前是否已满）
    const truncated = Array.from(newValue).slice(0, ESSAY_MAX_CHARS).join('');
    setInputText(truncated);
    notifyCharLimit(truncated !== (inputText ?? ''));
  }, [setInputText, notifyCharLimit, inputText]);

  // ── UX#5：剪贴板图片粘贴（与拖拽同路径 onFilesDropped） ──
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isGrading) return;
    const clipboard = e.clipboardData;
    if (!clipboard) return;
    // 剪贴板同时含纯文本时优先文本粘贴，不拦截
    if (clipboard.getData('text/plain').trim().length > 0) return;
    const imageFiles = Array.from(clipboard.items)
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (imageFiles.length === 0) return;
    e.preventDefault();
    const stamp = Date.now();
    const named = imageFiles.map((file, i) => {
      const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = file.name && file.name !== 'image.png'
        ? file.name
        : `pasted-${stamp}-${i + 1}.${ext}`;
      return new File([file], name, { type: file.type });
    });
    onFilesDropped(named);
  }, [isGrading, onFilesDropped]);

  // ── 空状态引导：示例作文一键填入（题目 + 正文），便于新用户零门槛体验批改 ──
  const handleFillSample = useCallback(() => {
    if (isGrading) return;
    setInputText(t('essay_grading:workbench.sample.content'));
    if (setTopicText) setTopicText(t('essay_grading:workbench.sample.topic'));
    showGlobalNotification('success', t('essay_grading:workbench.sample.filled_toast'));
  }, [isGrading, setInputText, setTopicText, t]);

  // ── UX#6：轮次圆点点击跳转。父级提供 onSelect 时直接跳转；
  // 否则回退为按差值经 prev/next 逐步推进（每次父级重渲染推进一步直至到达）。 ──
  const [pendingRoundTarget, setPendingRoundTarget] = useState<number | null>(null);
  const lastSteppedIndexRef = useRef<number | null>(null);
  useEffect(() => {
    if (pendingRoundTarget === null) return;
    if (!roundNavigation) {
      setPendingRoundTarget(null);
      lastSteppedIndexRef.current = null;
      return;
    }
    const { currentIndex, total, onPrev, onNext } = roundNavigation;
    if (pendingRoundTarget < 0 || pendingRoundTarget >= total || pendingRoundTarget === currentIndex) {
      setPendingRoundTarget(null);
      lastSteppedIndexRef.current = null;
      return;
    }
    // 上一步未生效（如批改中父级拦截切换），立即终止，避免死循环
    if (lastSteppedIndexRef.current === currentIndex) {
      setPendingRoundTarget(null);
      lastSteppedIndexRef.current = null;
      return;
    }
    lastSteppedIndexRef.current = currentIndex;
    if (pendingRoundTarget > currentIndex) {
      onNext();
    } else {
      onPrev();
    }
  }, [pendingRoundTarget, roundNavigation]);

  // ── UX#7：字数上限渐进警示（90% 橙 / 100% 红） ──
  const limitTone = charCount >= ESSAY_MAX_CHARS
    ? 'text-destructive font-medium'
    : charCount >= ESSAY_MAX_CHARS * 0.9
      ? 'text-orange-500 dark:text-orange-400'
      : 'text-muted-foreground/50';

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
              disabled={isGrading}
              triggerIcon={<GraduationCap size={14} className="shrink-0 text-muted-foreground" />}
              className="max-w-full text-sm text-foreground/80 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150"
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

        {/* 右侧：操作按钮组 - 桌面端不收缩；移动端允许收缩以防溢出（统计文本可截断） */}
        <div className="flex min-w-0 items-center gap-1 sm:shrink-0">
          <CommonTooltip content={t('essay_grading:import_images.hint', { max: ocrMaxFiles })}>
            <NotionButton variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isGrading} aria-label={t('common:aria.upload_image')} className={cn(COARSE_HIT, "flex shrink-0 h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-40 transition-colors duration-150")}>
              <Image size={14} />
              <span className="text-xs hidden xl:inline">{t('essay_grading:import_images.button')}</span>
            </NotionButton>
          </CommonTooltip>

          {/* 设置按钮（始终显示图标，大屏显示文字） */}
          {onOpenSettings && (
            <CommonTooltip content={t('essay_grading:settings.title')}>
              <NotionButton variant="ghost" size="sm" onClick={onOpenSettings} className={cn(COARSE_HIT, "shrink-0 h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150")}>
                <PenNib size={14} />
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
              <NotionButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onPrev} disabled={roundNavigation.currentIndex <= 0} aria-label={t('common:aria.previous_round')} className="!h-6 !w-6 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30 transition-colors duration-150">
                <CaretLeft size={14} />
              </NotionButton>
              <div className="flex items-center">
                {Array.from({ length: roundNavigation.total }, (_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      if (roundNavigation.onSelect) {
                        roundNavigation.onSelect(i);
                      } else {
                        setPendingRoundTarget(i);
                      }
                    }}
                    disabled={isGrading}
                    aria-label={t('essay_grading:round_navigation.go_to_round', { number: i + 1 })}
                    aria-current={i === roundNavigation.currentIndex ? 'true' : undefined}
                    className="group/dot flex items-center justify-center w-3.5 h-6 disabled:cursor-not-allowed"
                  >
                    <span
                      className={cn(
                        'w-1.5 h-1.5 rounded-full transition-all duration-150 motion-reduce:transition-none',
                        i === roundNavigation.currentIndex
                          ? 'bg-primary scale-110'
                          : 'bg-muted-foreground/20 group-hover/dot:bg-muted-foreground/50 group-hover/dot:scale-125'
                      )}
                    />
                  </button>
                ))}
              </div>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onNext} disabled={roundNavigation.currentIndex >= roundNavigation.total - 1} aria-label={t('common:aria.next_round')} className="!h-6 !w-6 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30 transition-colors duration-150">
                <CaretRight size={14} />
              </NotionButton>
            </div>
          )}

          {/* 移动端：字符统计 + 清空 + 批改按钮 */}
          <div className="sm:hidden flex min-w-0 items-center gap-1">
            <span className="text-xs text-muted-foreground/60 tabular-nums truncate min-w-0">
              {t('essay_grading:stats.han_chars')}: {textStats.hanChars.toLocaleString()}
              {' · '}
              {t('essay_grading:stats.english_words')}: {textStats.englishWords.toLocaleString()}
              {' · '}
              <span className={limitTone}>
                {charCount.toLocaleString()}/{ESSAY_MAX_CHARS.toLocaleString()}
              </span>
            </span>
            {hasClearableContent && !isGrading && (
              mobileClearConfirm.armed ? (
                <NotionButton variant="destructive" size="sm" onClick={mobileClearConfirm.handleClick} aria-label={t('essay_grading:confirm.clear')} className="!h-7 shrink-0 px-2 text-xs transition-colors duration-150">
                  <Trash size={13} />
                  {t('essay_grading:confirm.clear')}
                </NotionButton>
              ) : (
                <NotionButton variant="ghost" size="icon" iconOnly onClick={mobileClearConfirm.handleClick} aria-label={t('common:aria.clear_content')} className={cn(COARSE_HIT, "!h-7 !w-7 shrink-0 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150")}>
                  <Trash size={14} />
                </NotionButton>
              )
            )}
            {isGrading ? (
              mobileCancelConfirm.armed ? (
                <NotionButton variant="destructive" size="sm" onClick={mobileCancelConfirm.handleClick} aria-label={t('essay_grading:confirm.cancel')} className="!h-7 shrink-0 px-2 text-xs transition-colors duration-150">
                  {t('essay_grading:confirm.cancel')}
                </NotionButton>
              ) : (
                <NotionButton variant="ghost" size="sm" onClick={mobileCancelConfirm.handleClick} aria-label={t('common:aria.cancel_grading')} className={cn(COARSE_HIT, "h-7 px-2 shrink-0 text-sm text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150")}>
                  <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
                </NotionButton>
              )
            ) : (
              <NotionButton
                variant="primary"
                size="sm"
                onClick={onGrade}
                disabled={!canGrade}
                className="shrink-0"
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
                    "w-11 h-11 object-cover rounded-md border transition-colors duration-150",
                    img.ocrStatus === 'error' || img.ocrStatus === 'timeout'
                      ? "border-destructive/60 opacity-75"
                      : img.ocrStatus === 'done'
                        ? "border-primary/40"
                        : "border-border/40"
                  )}
                  title={img.ocrError ? `${img.fileName} — ${img.ocrError}` : img.fileName}
                />
                <OcrStatusBadge img={img} />
                {!isGrading && onRemoveImage && (
                  <button
                    type="button"
                    onClick={() => onRemoveImage(img.id)}
                    className={cn(COARSE_HIT_BADGE, "w-4 h-4 absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover/thumb:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 motion-reduce:transition-none")}
                    aria-label={t('common:delete')}
                  >
                    <X size={10} />
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
            type="button"
            onClick={() => setShowTopicSection(!showTopicSection)}
            aria-expanded={showTopicSection}
            className={cn(
              'flex items-center gap-2 w-full px-4 py-2 text-xs transition-colors duration-150',
              showTopicSection
                ? 'text-foreground bg-muted/25'
                : 'text-muted-foreground/70 hover:text-foreground hover:bg-[var(--interactive-hover)]'
            )}
          >
            <span className="w-4 h-4 inline-flex items-center justify-center rounded bg-muted/60">
              <FileText size={12} />
            </span>
            <span className="font-medium">{t('essay_grading:topic.toggle_label')}</span>
            {hasTopicContent && (
              <span className="inline-flex items-center rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                {topicImageCount > 0
                  ? t('essay_grading:topic.image_count', { count: topicImageCount })
                  : t('essay_grading:topic.filled')}
              </span>
            )}
            <CaretDown className={cn('w-3.5 h-3.5 ml-auto transition-transform duration-200 motion-reduce:transition-none', showTopicSection && 'rotate-180')} />
          </button>
          {/* grid-template-rows 展开动画（motion-reduce 降级为直接切换） */}
          <div
            className={cn(
              'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
              showTopicSection ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            )}
            aria-hidden={!showTopicSection}
          >
            {/* 折叠后延迟置为 invisible：既保留收起动画，又让隐藏内容不可聚焦 */}
            <div className={cn(
              'overflow-hidden min-h-0 transition-[visibility] motion-reduce:transition-none',
              showTopicSection ? 'visible' : 'invisible [transition-delay:200ms]'
            )}>
              <div className="px-3 pb-3 pt-0.5">
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
                            type="button"
                            onClick={() => onRemoveTopicImage(img.id)}
                            className={cn(COARSE_HIT_BADGE, "w-4 h-4 absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover/thumb:opacity-100 focus-visible:opacity-100 transition-opacity duration-150 motion-reduce:transition-none")}
                            aria-label={t('common:delete')}
                          >
                            <X size={10} />
                          </button>
                        )}
                      </div>
                    ))}
                    {onTopicFilesDropped && !isGrading && (
                      <button
                        type="button"
                        onClick={() => topicFileInputRef.current?.click()}
                        className="w-11 h-11 rounded-md border border-dashed border-border/60 bg-background/60 flex items-center justify-center text-muted-foreground/55 hover:text-foreground hover:border-foreground/35 hover:bg-[var(--interactive-hover)] transition-colors duration-150"
                        aria-label={t('essay_grading:topic.add_image')}
                      >
                        <Image size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ★ UX#10：批改中输入锁定提示条（grid 动画展开/收起） */}
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          isGrading ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
        aria-hidden={!isGrading}
      >
        <div className="overflow-hidden min-h-0">
          <div className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground bg-primary/5 border-b border-border/30" role="status">
            <CircleNotch size={12} className="text-primary animate-spin motion-reduce:animate-none shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('essay_grading:grading_lock.hint')}</span>
            {/* 阶段进度：当前阶段文案 + 五阶段进度点（分析 → 批注 → 评分 → 润色 → 范文） */}
            {gradingPhase && (
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <span className="text-primary/80 tabular-nums whitespace-nowrap">
                  {t(`essay_grading:progress.phase_${gradingPhase}`)}
                </span>
                <span className="hidden sm:flex items-center gap-1" aria-hidden="true">
                  {GRADING_PHASES.map((phase, idx) => {
                    const currentIdx = GRADING_PHASES.indexOf(gradingPhase);
                    return (
                      <span
                        key={phase}
                        className={cn(
                          'h-1 w-1 rounded-full transition-colors duration-300 motion-reduce:transition-none',
                          idx < currentIdx
                            ? 'bg-primary/50'
                            : idx === currentIdx
                              ? 'bg-primary scale-125'
                              : 'bg-muted-foreground/25'
                        )}
                      />
                    );
                  })}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Content - 与翻译面板一致：flex-1 撑满剩余高度，避免空态在 0 高度容器内重叠压缩 */}
      <div className="flex-1 min-h-0 flex flex-col relative overflow-hidden">
        <UnifiedDragDropZone
          zoneId="essay-grading-upload"
          onFilesDropped={onFilesDropped}
          acceptedFileTypes={[FILE_TYPES.IMAGE]}
          maxFiles={ocrMaxFiles}
          maxFileSize={50 * 1024 * 1024}
          className="flex-1 min-h-0 flex flex-col relative"
        >
          {showEmptyState && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none px-6">
              <div className="text-center space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-foreground/70 leading-normal">{t('essay_grading:empty_state.title')}</h3>
                  <p className="text-xs text-muted-foreground/50 mt-1 max-w-[260px] leading-relaxed">{t('essay_grading:empty_state.description')}</p>
                </div>
                {/* 三途径提示：输入/粘贴 · 拖拽 · 上传 */}
                <div className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground/45 flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <ClipboardText size={12} />
                    {t('essay_grading:empty_state.paste_hint')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    <UploadSimple size={12} />
                    {t('essay_grading:empty_state.drop_hint')}
                  </span>
                </div>
                <div className="flex items-center justify-center gap-2 flex-wrap">
                  <NotionButton variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} className="pointer-events-auto text-xs text-muted-foreground/70 hover:text-foreground hover:bg-[var(--interactive-hover)] border border-border/30 transition-colors duration-150">
                    <Image size={14} />
                    {t('essay_grading:empty_state.ocr_hint')}
                  </NotionButton>
                  <NotionButton variant="ghost" size="sm" onClick={handleFillSample} className="pointer-events-auto text-xs text-primary/80 hover:text-primary hover:bg-primary/10 border border-primary/25 transition-colors duration-150">
                    <Sparkle size={14} />
                    {t('essay_grading:workbench.sample.fill_button')}
                  </NotionButton>
                </div>
              </div>
            </div>
          )}
          <Textarea
            ref={ref}
            value={safeInputText}
            readOnly={isGrading}
            onChange={handleInputChange}
            onPaste={handlePaste}
            placeholder={showEmptyState ? '' : t('essay_grading:input_section.placeholder')}
            className={cn(
              "flex-1 !min-h-0 w-full resize-none overflow-y-auto px-5 py-5 text-[15px] leading-[1.8] !border-0 !shadow-none !rounded-none !bg-transparent focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!outline-none focus-visible:!outline-none selection:bg-primary/15 placeholder:text-muted-foreground/40 [scrollbar-width:thin] transition-opacity duration-200 motion-reduce:transition-none",
              isGrading && "opacity-80 cursor-default"
            )}
          />
        </UnifiedDragDropZone>

        {/* Floating Bottom Controls - Notion 风格悬浮工具 */}
        <div className="absolute bottom-3 left-4 right-4 hidden sm:flex items-center justify-end pointer-events-none">
          {/* ★ UX#7：字数统计不再依赖 hover（有内容即常显），渐进警示色 */}
          <div className={cn(
            "pointer-events-auto flex items-center gap-2 shrink-0 transition-opacity duration-200 motion-reduce:transition-none",
            charCount > 0 || hasClearableContent ? "opacity-100" : "opacity-0 group-hover/source:opacity-100"
          )}>
            <span className={cn("text-xs tabular-nums transition-colors duration-150", limitTone)}>
              {t('essay_grading:stats.han_chars')}: {textStats.hanChars.toLocaleString()}
              {' · '}
              {t('essay_grading:stats.english_words')}: {textStats.englishWords.toLocaleString()}
              {' · '}
              {t('essay_grading:workbench.stats.paragraphs')}: {textStats.paragraphCount.toLocaleString()}
              {' · '}
              {t('essay_grading:stats.punctuation_total')}: {textStats.punctuationTotal.toLocaleString()}
              {' · '}
              {charCount.toLocaleString()} / {ESSAY_MAX_CHARS.toLocaleString()} {t('essay_grading:stats.characters')}
            </span>
            {hasClearableContent && !isGrading && (
              desktopClearConfirm.armed ? (
                <NotionButton variant="destructive" size="sm" onClick={desktopClearConfirm.handleClick} className="!h-6 px-2 text-xs transition-colors duration-150">
                  <Trash size={12} />
                  {t('essay_grading:confirm.clear')}
                </NotionButton>
              ) : (
                <CommonTooltip content={t('essay_grading:actions.clear')}>
                  <NotionButton variant="ghost" size="icon" iconOnly onClick={desktopClearConfirm.handleClick} aria-label={t('common:aria.clear_content')} className="!h-6 !w-6 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors duration-150">
                    <Trash size={14} />
                  </NotionButton>
                </CommonTooltip>
              )
            )}
          </div>
        </div>
      </div>

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
              triggerIcon={<Robot size={14} className="shrink-0 text-muted-foreground" />}
              placeholder={t('essay_grading:model.select')}
              side="top"
            />
          </div>
        )}

        {/* 填充空间 */}
        <div className="flex-1" />

        {/* 右侧：操作按钮（取消批改为内联二段确认，无模态框） */}
        <div className="flex items-center gap-2 shrink-0">
          {isGrading ? (
            desktopCancelConfirm.armed ? (
              <NotionButton variant="destructive" size="sm" onClick={desktopCancelConfirm.handleClick} className="transition-colors duration-150">
                {t('essay_grading:confirm.cancel')}
              </NotionButton>
            ) : (
              <NotionButton variant="ghost" size="sm" onClick={desktopCancelConfirm.handleClick} className="text-sm text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150">
                <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
                {t('common:cancel')}
              </NotionButton>
            )
          ) : (
            <NotionButton
              variant="primary"
              size="lg"
              onClick={onGrade}
              disabled={!canGrade}
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
