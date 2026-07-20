import React, { useEffect } from 'react';
import { InputPanel } from './InputPanel';
import { ResultPanel } from './ResultPanel';
import { InlineSettingsPanel } from './InlineSettingsPanel';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { HorizontalResizable, VerticalResizable } from '../shared/Resizable';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { GradingMode, ModelInfo } from '@/essay-grading/essayGradingApi';
import type { EssayTextStats } from '@/essay-grading/textStats';
import type { UploadedImage } from '../EssayGradingWorkbench';
import { cn } from '@/lib/utils';

interface GradingMainProps {
  // Input Panel Props
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
  // 旧版兼容
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
  inputCharCount: number;
  inputTextStats: EssayTextStats;

  // Image Props
  uploadedImages: UploadedImage[];
  onRemoveImage: (imageId: string) => void;
  // Topic Metadata Props
  topicText: string;
  setTopicText: (text: string) => void;
  topicImages: UploadedImage[];
  onTopicFilesDropped: (files: File[]) => void;
  onRemoveTopicImage: (imageId: string) => void;

  // Result Panel Props
  gradingResult: string;
  resultCharCount: number;
  onCopyResult: () => void;
  onExportResult: () => void;
  /** 错误信息 */
  error?: string | null;
  /** 是否可以重试 */
  canRetry?: boolean;
  /** 重试回调 */
  onRetry?: () => void;
  isPartialResult?: boolean;
  /** 采纳批改建议：应用一处修改到原文 */
  onApplySuggestion?: (change: { original: string; replacement: string }) => void;

  // Round Props
  currentRound: number;

  // 模式管理
  onModesChange?: () => void;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    onSelect?: (index: number) => void;
  };
}

/** 桌面端内联设置列宽度（≥1024 略宽于 768-1024） */
const SETTINGS_WIDTH_LG = 340;
const SETTINGS_WIDTH_MD = 320;

export type GradingPhase = 'preparing' | 'annotating' | 'scoring' | 'polishing' | 'model_essay';

/** 根据已生成内容推断当前批改阶段（与 ResultPanel 的推断口径一致：批注 → 评分 → 润色 → 范文） */
function inferGradingPhase(content: string): GradingPhase {
  if (!content) return 'preparing';
  if (/<section-model-essay/i.test(content)) return 'model_essay';
  if (/<section-polish/i.test(content)) return 'polishing';
  if (/<score\b/i.test(content)) return 'scoring';
  return 'annotating';
}

export const GradingMain: React.FC<GradingMainProps> = ({
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
  inputCharCount,
  inputTextStats,
  uploadedImages,
  onRemoveImage,
  topicText,
  setTopicText,
  topicImages,
  onTopicFilesDropped,
  onRemoveTopicImage,
  gradingResult,
  resultCharCount,
  onCopyResult,
  onExportResult,
  error,
  canRetry,
  onRetry,
  isPartialResult,
  onApplySuggestion,
  currentRound,
  onModesChange,
  roundNavigation,
}) => {
  const { isSmallScreen, isLg } = useBreakpoint();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);

  // 批改中阶段推断（供 InputPanel 锁定提示条显示阶段进度）
  const gradingPhase = React.useMemo<GradingPhase | undefined>(
    () => (isGrading ? inferGradingPhase(gradingResult) : undefined),
    [isGrading, gradingResult]
  );

  // 移动端设置区展开时注册 Android 返回键（返回 = 收起内联设置区块）。
  // 桌面端设置列是普通文档流列，不属于 overlay，不劫持返回键。
  useEffect(() => {
    if (!isSmallScreen || !showPromptEditor) return;
    return registerBackHandler(() => {
      setShowPromptEditor(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, showPromptEditor, setShowPromptEditor]);

  // ========== 共享面板（各断点复用同一份 props，状态源唯一：showPromptEditor） ==========
  const inputPanel = (
    <InputPanel
      ref={inputRef}
      inputText={inputText}
      setInputText={setInputText}
      modeId={modeId}
      setModeId={setModeId}
      modes={modes}
      modelId={modelId}
      setModelId={setModelId}
      models={models}
      essayType={essayType}
      setEssayType={setEssayType}
      gradeLevel={gradeLevel}
      setGradeLevel={setGradeLevel}
      isGrading={isGrading}
      gradingPhase={gradingPhase}
      onFilesDropped={onFilesDropped}
      ocrMaxFiles={ocrMaxFiles}
      customPrompt={customPrompt}
      setCustomPrompt={setCustomPrompt}
      showPromptEditor={showPromptEditor}
      setShowPromptEditor={setShowPromptEditor}
      onSavePrompt={onSavePrompt}
      onRestoreDefaultPrompt={onRestoreDefaultPrompt}
      onClear={onClear}
      onGrade={onGrade}
      onCancelGrading={onCancelGrading}
      charCount={inputCharCount}
      textStats={inputTextStats}
      currentRound={currentRound}
      roundNavigation={roundNavigation}
      onOpenSettings={() => setShowPromptEditor(!showPromptEditor)}
      uploadedImages={uploadedImages}
      onRemoveImage={onRemoveImage}
      topicText={topicText}
      setTopicText={setTopicText}
      topicImages={topicImages}
      onTopicFilesDropped={onTopicFilesDropped}
      onRemoveTopicImage={onRemoveTopicImage}
    />
  );

  const resultPanel = (
    <ResultPanel
      ref={resultRef}
      gradingResult={gradingResult}
      isGrading={isGrading}
      charCount={resultCharCount}
      onCopyResult={onCopyResult}
      onExportResult={onExportResult}
      error={error}
      canRetry={canRetry}
      onRetry={onRetry}
      isPartialResult={isPartialResult}
      onApplySuggestion={onApplySuggestion}
      currentRound={currentRound}
      roundNavigation={roundNavigation}
    />
  );

  const settingsPanel = (
    <InlineSettingsPanel
      isOpen={showPromptEditor}
      onClose={() => setShowPromptEditor(false)}
      modeId={modeId}
      setModeId={setModeId}
      modes={modes}
      modelId={modelId}
      setModelId={setModelId}
      models={models}
      customPrompt={customPrompt}
      setCustomPrompt={setCustomPrompt}
      onSavePrompt={onSavePrompt}
      onRestoreDefaultPrompt={onRestoreDefaultPrompt}
      isGrading={isGrading}
      onModesChange={onModesChange}
      essayType={essayType}
      setEssayType={setEssayType}
      gradeLevel={gradeLevel}
      setGradeLevel={setGradeLevel}
    />
  );

  // ========== 设置区（内联，无抽屉 / 无遮罩 / 无 absolute 滑板） ==========
  // 移动端：主分栏上方高度过渡展开的内联区块，推挤内容而非遮挡。
  // 关闭态经 visibility 过渡转为 hidden，退出焦点链与无障碍树。
  const mobileSettingsSection = (
    <div
      className={cn(
        'shrink-0 overflow-hidden bg-background',
        'transition-[height,visibility] duration-[var(--panel-open-dur,250ms)] ease-[var(--panel-ease,ease-out)] motion-reduce:transition-none',
        showPromptEditor ? 'visible h-[min(60vh,420px)] border-b border-border/40' : 'invisible h-0',
      )}
      aria-hidden={!showPromptEditor}
    >
      {/* 内层固定高度：高度过渡期间内容不回流 */}
      <div className="h-[min(60vh,420px)]">{settingsPanel}</div>
    </div>
  );

  // 桌面端：右侧文档流内联列，width/visibility 过渡展开收起；
  // 内层固定宽度并右对齐（ml-auto），过渡期间内容不挤压、呈滑入观感；
  // 主分栏 flex-1 自动平滑让位。
  const settingsWidth = isLg ? SETTINGS_WIDTH_LG : SETTINGS_WIDTH_MD;
  const desktopSettingsColumn = (
    <div
      className={cn(
        'h-full min-h-0 shrink-0 overflow-hidden',
        'transition-[width,visibility] duration-[var(--panel-open-dur,250ms)] ease-[var(--panel-ease,ease-out)] motion-reduce:transition-none',
        showPromptEditor ? 'visible' : 'invisible',
      )}
      style={{ width: showPromptEditor ? settingsWidth : 0 }}
      aria-hidden={!showPromptEditor}
    >
      <div
        className="h-full min-h-0 ml-auto border-l border-border/40 bg-background"
        style={{ width: settingsWidth }}
      >
        {settingsPanel}
      </div>
    </div>
  );

  // ========== 统一布局：所有断点共用一个结构 ==========
  // 小屏：设置区块在上（高度过渡）+ 上下分栏；
  // 中屏：上下分栏 + 右侧内联设置列；大屏：左右分栏 + 右侧内联设置列。
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {isSmallScreen && mobileSettingsSection}

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 h-full">
          {isLg ? (
            <HorizontalResizable
              initial={0.5}
              minLeft={0.3}
              minRight={0.3}
              className="bg-background"
              left={inputPanel}
              right={resultPanel}
            />
          ) : (
            <VerticalResizable
              initial={isSmallScreen ? 0.4 : 0.45}
              minTop={isSmallScreen ? 0.2 : 0.25}
              minBottom={isSmallScreen ? 0.3 : 0.35}
              className="bg-background"
              top={inputPanel}
              bottom={resultPanel}
            />
          )}
        </div>

        {!isSmallScreen && desktopSettingsColumn}
      </div>
    </div>
  );
};
