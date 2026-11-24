import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '../ui/shad/Textarea';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
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
  CaretUp,
  ClipboardText,
  UploadSimple,
  Sparkle,
} from '@phosphor-icons/react';
import UnifiedDragDropZone, { FILE_TYPES } from '../shared/UnifiedDragDropZone';
import { UnifiedModelSelector } from '../shared/UnifiedModelSelector';
import type { GradingMode, ModelInfo } from '@/essay-grading/essayGradingApi';
import { GRADING_PHASE_ORDER, type GradingPhase } from '@/essay-grading/gradingPhase';
import { getModeDisplayName } from '@/essay-grading/modeI18n';
import type { EssayTextStats } from '@/essay-grading/textStats';
import type { UploadedImage } from '../EssayGradingWorkbench';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '../UnifiedNotification';
import { useInlineConfirm } from './useInlineConfirm';

/** ★ F-2: 作文最大字符数限制（约 5 万字符） */
export const ESSAY_MAX_CHARS = 50000;

export type GradingPhaseId = GradingPhase;

/** 触屏命中区扩展：28px 图标钮扩到 ≥44px，视觉不变（与 InputBarUI.coarseHitAreaClass 同款范式） */
const COARSE_HIT =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2 [@media(pointer:coarse)]:after:content-['']";

/** 同上，但适配 24px（h-6）图标钮：-inset-2.5 扩到 ≥44px（平板等 sm+ coarse 设备可见的小钮） */
const COARSE_HIT_SM =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']";

/** 缩略图角标删除钮（16px、absolute 定位）：命中区扩到 ≥44px */
const COARSE_HIT_BADGE =
  "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-3.5 [@media(pointer:coarse)]:after:content-['']";

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
  /** OCR 失败图片的单图重试（点按失败缩略图触发） */
  onRetryImageOcr?: (imageId: string) => void;
  // ★ 题目元数据
  topicText?: string;
  setTopicText?: (text: string) => void;
  topicImages?: UploadedImage[];
  onTopicFilesDropped?: (files: File[]) => void;
  onRemoveTopicImage?: (imageId: string) => void;
  /** 结果优先布局下展开的原文：提供时工具栏显示「收起原文」 */
  onCollapse?: () => void;
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
        <span className="text-2xs text-amber-300 mt-0.5 leading-none">{t('essay_grading:ocr_status.retrying')}</span>
      </div>
    );
  }
  if (img.ocrStatus === 'timeout') {
    return (
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-amber-500/85 text-2xs text-white text-center leading-tight rounded-b-md px-0.5">
        {t('essay_grading:ocr_status.timeout')}
      </div>
    );
  }
  if (img.ocrStatus === 'error') {
    return (
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-destructive/85 text-destructive-foreground text-2xs text-center leading-tight rounded-b-md px-0.5">
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
  onRetryImageOcr,
  topicText,
  setTopicText,
  topicImages,
  onTopicFilesDropped,
  onRemoveTopicImage,
  onCollapse,
}, ref) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const topicFileInputRef = React.useRef<HTMLInputElement>(null);
  const [showTopicSection, setShowTopicSection] = useState(false);
  /** 标记当前 topicText 是否由「填入示例」自动填入且未经用户手改，防止替换正文后残留隐形示例题目 */
  const sampleTopicAppliedRef = useRef(false);

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
    // 若用户曾点击「填入示例」，随后清空或完全替换为自己的作文，同步清掉自动填入的示例题目，避免隐形跑题
    if (sampleTopicAppliedRef.current && setTopicText) {
      const sampleTopic = t('essay_grading:workbench.sample.topic');
      const sampleContent = t('essay_grading:workbench.sample.content');
      const sampleHead = sampleContent.slice(0, 12);
      const isClearingOrReplacingSample =
        newValue.trim().length === 0
        || (topicText === sampleTopic && !newValue.includes(sampleHead));
      if (isClearingOrReplacingSample) {
        sampleTopicAppliedRef.current = false;
        setTopicText('');
      }
    }
    if (getUnicodeCharCount(newValue) <= ESSAY_MAX_CHARS) {
      setInputText(newValue);
      return;
    }
    // 超限：按 Unicode 字符截断到上限，并提示（无论此前是否已满）
    const truncated = Array.from(newValue).slice(0, ESSAY_MAX_CHARS).join('');
    setInputText(truncated);
    notifyCharLimit(truncated !== (inputText ?? ''));
  }, [setInputText, notifyCharLimit, inputText, setTopicText, t, topicText]);

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

  // ── OCR 失败缩略图点按：toast 展示错误详情（title 悬浮在触屏不可用）+ 触发单图重试 ──
  const handleFailedThumbClick = useCallback((img: UploadedImage) => {
    showGlobalNotification(
      'error',
      t('essay_grading:images.ocr_error_detail', {
        fileName: img.fileName,
        error: img.ocrError || t('essay_grading:ocr_status.error'),
      })
    );
    onRetryImageOcr?.(img.id);
  }, [t, onRetryImageOcr]);

  // ── 空状态引导：示例作文一键填入（题目 + 正文），展开题目区使示例题目可见，绝不隐形绑定 ──
  const handleFillSample = useCallback(() => {
    if (isGrading) return;
    setInputText(t('essay_grading:workbench.sample.content'));
    if (setTopicText) {
      sampleTopicAppliedRef.current = true;
      setTopicText(t('essay_grading:workbench.sample.topic'));
      setShowTopicSection(true);
    }
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
      ? 'text-warning'
      : 'text-muted-foreground/50';

  return (
    <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 transition-all duration-200 border-b lg:border-b-0 lg:border-r border-border/35 bg-background relative group/source">
      {/* Toolbar - 简洁风格简洁布局 */}
      {/* min-h 而非固定高：DsButton 移动端默认 44px，固定 41px 会被撑破溢出 */}
      <div className="flex min-h-[41px] items-center gap-1 border-b border-border/35 px-2 py-0.5 sm:gap-1.5 sm:px-4">
        {/* 左侧：模式选择 - 轻量胶囊选择器 */}
        {modes.length > 0 && (
          <div className="min-w-0 max-w-[50%] sm:max-w-none sm:shrink-0">
            <AppSelect
              value={modeId}
              onValueChange={setModeId}
              width={248}
              variant="ghost"
              size="sm"
              disabled={isGrading}
              triggerIcon={<GraduationCap size={14} className="shrink-0 text-muted-foreground" />}
              className="max-w-full rounded-full bg-foreground/[0.03] px-2.5 text-sm text-foreground/85 hover:text-foreground hover:bg-foreground/[0.06] transition-colors duration-150"
              placeholder={t('essay_grading:mode.select')}
              options={modes.map((mode) => ({
                value: mode.id,
                label: getModeDisplayName(mode, t),
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
            <DsButton variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isGrading} aria-label={t('common:aria.upload_image')} className={cn(COARSE_HIT, "flex shrink-0 h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-40 transition-colors duration-150")}>
              <Image size={14} />
              <span className="text-xs hidden xl:inline">{t('essay_grading:import_images.button')}</span>
            </DsButton>
          </CommonTooltip>

          {/* 设置按钮（始终显示图标，大屏显示文字） */}
          {onOpenSettings && (
            <CommonTooltip content={t('essay_grading:settings.title')}>
              <DsButton variant="ghost" size="sm" onClick={onOpenSettings} className={cn(COARSE_HIT, "shrink-0 h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150")}>
                <PenNib size={14} />
                <span className="text-xs hidden xl:inline">{t('essay_grading:settings.title')}</span>
              </DsButton>
            </CommonTooltip>
          )}

          {/* 非移动端：轮次显示 */}
          {currentRound > 0 && (
            <span className="hidden md:inline text-xs text-muted-foreground/60 whitespace-nowrap tabular-nums">
              {t('essay_grading:round.label', { number: currentRound })}
            </span>
          )}

          {roundNavigation && roundNavigation.total > 1 && (
            <div className="hidden md:flex items-center gap-1">
              <DsButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onPrev} disabled={roundNavigation.currentIndex <= 0} aria-label={t('common:aria.previous_round')} className={cn(COARSE_HIT_SM, "!h-6 !w-6 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30 transition-colors duration-150")}>
                <CaretLeft size={14} />
              </DsButton>
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
                    /* coarse：相邻圆点的伪元素横向扩展会被后一个兄弟盖住，改为实际尺寸放大到 44×44（视觉圆点不变） */
                    className="group/dot flex items-center justify-center w-3.5 h-6 [@media(pointer:coarse)]:w-11 [@media(pointer:coarse)]:h-11 disabled:cursor-not-allowed"
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
              <DsButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onNext} disabled={roundNavigation.currentIndex >= roundNavigation.total - 1} aria-label={t('common:aria.next_round')} className={cn(COARSE_HIT_SM, "!h-6 !w-6 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30 transition-colors duration-150")}>
                <CaretRight size={14} />
              </DsButton>
            </div>
          )}

          {onCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={onCollapse}
                  aria-label={t('essay_grading:input_summary.collapse')}
                  className={cn(COARSE_HIT, "shrink-0 h-7 px-2 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150")}
                >
                  <CaretUp size={14} />
                  <span className="text-xs hidden lg:inline">{t('essay_grading:input_summary.collapse')}</span>
                </DsButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('essay_grading:input_summary.collapse')}</TooltipContent>
            </Tooltip>
          )}

          {/* 移动端：清空 + 批改按钮（字数统计移到输入区右下角悬浮条，避免顶栏拥挤截断） */}
          <div className="md:hidden flex min-w-0 items-center gap-1">
            {hasClearableContent && !isGrading && (
              mobileClearConfirm.armed ? (
                <DsButton variant="destructive" size="sm" onClick={mobileClearConfirm.handleClick} aria-label={t('essay_grading:confirm.clear')} className={cn(COARSE_HIT, "!h-7 shrink-0 px-2 text-xs transition-colors duration-150")}>
                  <Trash size={13} />
                  {t('essay_grading:confirm.clear')}
                </DsButton>
              ) : (
                <DsButton variant="ghost" size="icon" iconOnly onClick={mobileClearConfirm.handleClick} aria-label={t('common:aria.clear_content')} className={cn(COARSE_HIT, "!h-7 !w-7 shrink-0 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150")}>
                  <Trash size={14} />
                </DsButton>
              )
            )}
            {isGrading ? (
              mobileCancelConfirm.armed ? (
                <DsButton variant="destructive" size="sm" onClick={mobileCancelConfirm.handleClick} aria-label={t('essay_grading:confirm.cancel')} className={cn(COARSE_HIT, "!h-7 shrink-0 px-2 text-xs transition-colors duration-150")}>
                  {t('essay_grading:confirm.cancel')}
                </DsButton>
              ) : (
                <DsButton variant="ghost" size="sm" onClick={mobileCancelConfirm.handleClick} aria-label={t('common:aria.cancel_grading')} className={cn(COARSE_HIT, "h-7 px-2 shrink-0 text-sm text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150")}>
                  <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
                </DsButton>
              )
            ) : (
              <DsButton
                variant="primary"
                size="sm"
                data-testid="essay-grade-submit-mobile"
                onClick={onGrade}
                disabled={!canGrade}
                className={cn(COARSE_HIT, "shrink-0")}
              >
                {t('essay_grading:actions.grade')}
              </DsButton>
            )}
          </div>
        </div>
      </div>

      {/* ★ 图片缩略图预览条 */}
      {uploadedImages && uploadedImages.length > 0 && (
        <div className="scrollbar-none flex items-center gap-2 overflow-x-auto border-b border-border/30 px-4 py-2">
          <span className="text-xs text-muted-foreground/60 shrink-0">
            {t('essay_grading:images.essay_images', { count: uploadedImages.length })}
          </span>
          <div className="flex items-center gap-1.5">
            {uploadedImages.map((img) => {
              const isFailed = img.ocrStatus === 'error' || img.ocrStatus === 'timeout';
              const thumbnail = (
                <img
                  src={img.dataUrl}
                  alt={img.fileName}
                  className={cn(
                    "w-11 h-11 object-cover rounded-md border transition-colors duration-150",
                    isFailed
                      ? "border-destructive/60 opacity-75"
                      : img.ocrStatus === 'done'
                        ? "border-primary/40"
                        : "border-border/40"
                  )}
                  title={img.ocrError ? `${img.fileName} — ${img.ocrError}` : img.fileName}
                />
              );
              return (
                <div key={img.id} className="relative group/thumb shrink-0">
                  {/* 失败图可点按：toast 展示错误详情 + 单图重试（title 悬浮触屏不可用） */}
                  {isFailed && !isGrading ? (
                    <button
                      type="button"
                      onClick={() => handleFailedThumbClick(img)}
                      className="block rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-destructive/60"
                      aria-label={t('essay_grading:images.tap_to_retry')}
                      title={t('essay_grading:images.tap_to_retry')}
                    >
                      {thumbnail}
                    </button>
                  ) : (
                    thumbnail
                  )}
                  <OcrStatusBadge img={img} />
                  {!isGrading && onRemoveImage && (
                    <button
                      type="button"
                      onClick={() => onRemoveImage(img.id)}
                      className={cn(COARSE_HIT_BADGE, "w-4 h-4 absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-100 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover/thumb:opacity-100 focus-visible:!opacity-100 transition-opacity duration-150 motion-reduce:transition-none")}
                      aria-label={t('common:delete')}
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ★ 题目元数据折叠区：有激活题目时在折叠头展示摘要与一键清除，防止隐形题干误绑定 */}
      {setTopicText && (
        <div className="border-b border-border/30">
          <div className="flex items-center w-full">
            <button
              type="button"
              onClick={() => setShowTopicSection(!showTopicSection)}
              aria-expanded={showTopicSection}
              className={cn(
                'flex items-center gap-2 flex-1 min-w-0 px-4 py-2 text-xs [@media(pointer:coarse)]:min-h-11 transition-colors duration-150',
                showTopicSection
                  ? 'text-foreground bg-muted/25'
                  : 'text-muted-foreground/70 hover:text-foreground hover:bg-[var(--interactive-hover)]'
              )}
            >
              <span className="w-4 h-4 shrink-0 inline-flex items-center justify-center rounded bg-muted/60">
                <FileText size={12} />
              </span>
              <span className="font-medium shrink-0">{t('essay_grading:topic.toggle_label')}</span>
              {hasTopicContent && (
                <span className="inline-flex shrink-0 items-center rounded-md border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-2xs text-primary">
                  {topicImageCount > 0
                    ? t('essay_grading:topic.image_count', { count: topicImageCount })
                    : t('essay_grading:topic.filled')}
                </span>
              )}
              {!showTopicSection && topicText?.trim() && (
                <span
                  data-testid="essay-topic-preview"
                  className="min-w-0 truncate text-2xs text-foreground/70"
                  title={topicText.trim()}
                >
                  {topicText.trim()}
                </span>
              )}
              <CaretDown className={cn('w-3.5 h-3.5 shrink-0 ml-auto transition-transform duration-200 motion-reduce:transition-none', showTopicSection && 'rotate-180')} />
            </button>
            {Boolean(topicText?.trim()) && !isGrading && (
              <button
                type="button"
                data-testid="essay-topic-clear-btn"
                onClick={() => {
                  sampleTopicAppliedRef.current = false;
                  setTopicText('');
                }}
                aria-label={t('essay_grading:topic.clear')}
                title={t('essay_grading:topic.clear')}
                className="shrink-0 mr-2 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <X size={12} />
              </button>
            )}
          </div>
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
                    onChange={(e) => {
                      sampleTopicAppliedRef.current = false;
                      setTopicText(e.target.value);
                    }}
                    placeholder={t('essay_grading:topic.placeholder')}
                    className="w-full min-h-[72px] max-h-[144px] resize-y text-sm leading-relaxed !border-border/35 !bg-background/80 focus:!ring-1 focus:!ring-primary/20 [@media(pointer:coarse)]:text-base"
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
                            className={cn(COARSE_HIT_BADGE, "w-4 h-4 absolute -top-1 -right-1 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-100 [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover/thumb:opacity-100 focus-visible:!opacity-100 transition-opacity duration-150 motion-reduce:transition-none")}
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

      {/* ★ UX#10：仅在真实批改进行中渲染锁定状态条，避免空闲态 DOM 残留误导提示 */}
      {isGrading && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-border/30 bg-primary/5 px-4 py-1.5 text-xs text-muted-foreground"
          role="status"
          data-testid="essay-grading-lock-banner"
        >
          <CircleNotch size={12} className="shrink-0 animate-spin text-primary motion-reduce:animate-none" />
          <span className="min-w-0 flex-1 truncate">{t('essay_grading:grading_lock.hint')}</span>
          {/* 阶段进度：当前阶段文案 + 五阶段进度点（分析 → 批注 → 评分 → 润色 → 范文） */}
          {gradingPhase && (
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="tabular-nums whitespace-nowrap text-primary/80">
                {t(`essay_grading:progress.phase_${gradingPhase}`)}
              </span>
              <span className="hidden sm:flex items-center gap-1" aria-hidden="true">
                {GRADING_PHASE_ORDER.map((phase, idx) => {
                  const currentIdx = GRADING_PHASE_ORDER.indexOf(gradingPhase);
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
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="essay-cancel-grading-inline"
            onClick={onCancelGrading}
            className="h-6 shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            {t('essay_grading:actions.cancel_grading')}
          </DsButton>
        </div>
      )}

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
            <div className="ui-rise-in motion-reduce:animate-none absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none px-6">
              <div className="text-center space-y-3 max-w-sm">
                <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-border/45 bg-muted/25 text-muted-foreground/75">
                  <PenNib size={18} aria-hidden="true" />
                </div>
                <div>
                  <h3 className="text-sm font-medium text-foreground/85 leading-normal">{t('essay_grading:empty_state.title')}</h3>
                  <p className="text-xs text-muted-foreground/80 mt-1 max-w-[280px] mx-auto leading-relaxed">{t('essay_grading:empty_state.description')}</p>
                </div>
                {/* 交付物预期：告知学生将获得逐句批注、评分与范文 */}
                <div className="inline-flex items-center rounded-pill border border-border/35 bg-muted/25 px-3 py-1 text-2xs text-muted-foreground/80">
                  {t('essay_grading:empty_state.deliverables_hint')}
                </div>
                {/* 三途径提示：输入/粘贴 · 拖拽 · 上传 */}
                <div className="flex items-center justify-center gap-2 text-2xs text-muted-foreground/65 flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <ClipboardText size={12} aria-hidden="true" />
                    {t('essay_grading:empty_state.paste_hint')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    <UploadSimple size={12} aria-hidden="true" />
                    {/* 移动端无拖拽交互，改用"导入/粘贴"文案 */}
                    <span className="sm:hidden">{t('essay_grading:empty_state.drop_hint_mobile')}</span>
                    <span className="hidden sm:inline">{t('essay_grading:empty_state.drop_hint')}</span>
                  </span>
                </div>
                <div className="flex items-center justify-center gap-2 flex-wrap pt-0.5">
                  <DsButton variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="pointer-events-auto text-xs text-foreground/80 hover:text-foreground">
                    <Image size={14} />
                    {t('essay_grading:empty_state.ocr_hint')}
                  </DsButton>
                  <DsButton variant="ghost" size="sm" onClick={handleFillSample} className="pointer-events-auto text-xs text-primary hover:text-primary hover:bg-primary/10 border border-primary/30 transition-colors duration-150 motion-reduce:transition-none">
                    <Sparkle size={14} />
                    {t('essay_grading:workbench.sample.fill_button')}
                  </DsButton>
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
              "flex-1 !min-h-0 w-full resize-none overflow-y-auto px-[max(1.25rem,calc((100%-52rem)/2))] pt-5 pb-2 text-[15px] [@media(pointer:coarse)]:text-base leading-[1.8] !border-0 !shadow-none !rounded-none !bg-transparent focus:!ring-0 focus:!ring-offset-0 focus-visible:!ring-0 focus-visible:!ring-offset-0 focus:!outline-none focus-visible:!outline-none selection:bg-primary/15 placeholder:text-muted-foreground/40 [scrollbar-color:var(--scrollbar-thumb)_var(--scrollbar-track)] transition-opacity duration-200 motion-reduce:transition-none",
              isGrading && "opacity-80 cursor-default"
            )}
          />
        </UnifiedDragDropZone>

        {/* 统一底部状态与操作区：合并字数统计、模型选择与批改操作，消除多层底栏夹击 */}
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-t border-border/25 bg-background/80">
          {/* 左侧：桌面端模型选择 + 字数统计 */}
          <div className="flex min-w-0 items-center gap-2.5">
            {models.length > 0 && (
              <div className="hidden md:block min-w-0 shrink-0">
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
            <div
              className={cn(
                'flex min-w-0 items-center gap-2 transition-opacity duration-200 motion-reduce:transition-none',
                charCount > 0 || hasClearableContent ? 'opacity-100' : 'opacity-55 group-hover/source:opacity-100',
              )}
              data-essay-word-stats
            >
              <div className="flex min-w-0 items-center gap-x-2.5 gap-y-0.5 truncate text-xs text-muted-foreground tabular-nums">
                <span className="inline-flex items-baseline gap-1 shrink-0">
                  <span>{t('essay_grading:stats.han_chars')}</span>
                  <span className="font-mono font-medium text-foreground/85">{textStats.hanChars.toLocaleString()}</span>
                </span>
                <span className="text-border" aria-hidden="true">·</span>
                <span className="inline-flex items-baseline gap-1 shrink-0">
                  <span>{t('essay_grading:stats.english_words')}</span>
                  <span className="font-mono font-medium text-foreground/85">{textStats.englishWords.toLocaleString()}</span>
                </span>
                <span className="hidden lg:inline-flex items-baseline gap-1 shrink-0">
                  <span className="text-border mr-1" aria-hidden="true">·</span>
                  <span>{t('essay_grading:workbench.stats.paragraphs')}</span>
                  <span className="font-mono font-medium text-foreground/80">{textStats.paragraphCount.toLocaleString()}</span>
                </span>
                <span className="hidden xl:inline-flex items-baseline gap-1 shrink-0">
                  <span className="text-border mr-1" aria-hidden="true">·</span>
                  <span>{t('essay_grading:stats.punctuation_total')}</span>
                  <span className="font-mono text-foreground/75">{textStats.punctuationTotal.toLocaleString()}</span>
                </span>
                <span className={cn('hidden sm:inline-flex items-baseline gap-1 shrink-0 font-mono transition-colors duration-150 motion-reduce:transition-none', limitTone)}>
                  <span className="text-border mr-1" aria-hidden="true">·</span>
                  <span>{charCount.toLocaleString()} / {ESSAY_MAX_CHARS.toLocaleString()}</span>
                  <span className="hidden xl:inline font-sans">{t('essay_grading:stats.characters')}</span>
                </span>
              </div>
              {hasClearableContent && !isGrading && (
                <div className="hidden md:flex items-center">
                  {desktopClearConfirm.armed ? (
                    <DsButton variant="destructive" size="sm" onClick={desktopClearConfirm.handleClick} className={cn(COARSE_HIT_SM, "!h-6 px-2 text-xs transition-colors duration-150 motion-reduce:transition-none")}>
                      <Trash size={12} />
                      {t('essay_grading:confirm.clear')}
                    </DsButton>
                  ) : (
                    <CommonTooltip content={t('essay_grading:actions.clear')}>
                      <DsButton variant="ghost" size="icon" iconOnly onClick={desktopClearConfirm.handleClick} aria-label={t('common:aria.clear_content')} className={cn(COARSE_HIT_SM, "!h-6 !w-6 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition-colors duration-150 motion-reduce:transition-none")}>
                        <Trash size={14} />
                      </DsButton>
                    </CommonTooltip>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 右侧：桌面端批改/取消主动作 */}
          <div className="hidden md:flex items-center gap-2 shrink-0">
            {isGrading ? (
              desktopCancelConfirm.armed ? (
                <DsButton variant="destructive" size="sm" onClick={desktopCancelConfirm.handleClick} className="transition-colors duration-150 motion-reduce:transition-none">
                  {t('essay_grading:confirm.cancel')}
                </DsButton>
              ) : (
                <DsButton variant="ghost" size="sm" onClick={desktopCancelConfirm.handleClick} className="text-sm text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150 motion-reduce:transition-none">
                  <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
                  {t('common:cancel')}
                </DsButton>
              )
            ) : (
              <CommonTooltip content={t('essay_grading:actions.grade_shortcut_hint')}>
                <DsButton
                  variant="primary"
                  size="sm"
                  data-testid="essay-grade-submit-desktop"
                  onClick={onGrade}
                  disabled={!canGrade}
                >
                  {t('essay_grading:actions.grade')}
                </DsButton>
              </CommonTooltip>
            )}
          </div>
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
