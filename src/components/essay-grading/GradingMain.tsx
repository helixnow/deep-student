import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Pen } from '@phosphor-icons/react';
import { InputPanel } from './InputPanel';
import { ResultPanel } from './ResultPanel';
import { InlineSettingsPanel } from './InlineSettingsPanel';
import { useWbSysSize } from '@/features/workbench/apps/system/useWbSysSize';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { HorizontalResizable, VerticalResizable } from '../shared/Resizable';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { GradingMode, ModelInfo } from '@/essay-grading/essayGradingApi';
import type { EssayTextStats } from '@/essay-grading/textStats';
import type { SuggestionChange } from '@/essay-grading/suggestionAnchors';
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
  /** OCR 失败图片的单图重试（点按失败缩略图触发） */
  onRetryImageOcr?: (imageId: string) => void;
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
  /** 采纳批改建议：应用一处修改到原文（前后文锚定） */
  onApplySuggestion?: (change: SuggestionChange) => void;
  /** 撤销已采纳的建议（反向锚定替换） */
  onUndoSuggestion?: (change: SuggestionChange) => void;
  /** 已采纳建议的稳定 key 集合（详情卡据此渲染已采纳态） */
  appliedSuggestionKeys?: ReadonlySet<string>;
  /** 把当前轮批改结果存为笔记 */
  onSaveAsNote?: () => void;
  /** 把批改结果送进制卡链路 */
  onGenerateCards?: () => void;
  isGeneratingCards?: boolean;

  // Round Props
  currentRound: number;

  // 模式管理
  onModesChange?: () => void;
  /** OS 宿主提供外部设置标签时，设置在所有窗口宽度下都替换完整主区 */
  settingsAsPage?: boolean;
  /** ★ 标签页保活：当前是否为活跃标签页；非活跃（display:none 驻留）实例不注册返回键。未传视为活跃 */
  isActive?: boolean;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    onSelect?: (index: number) => void;
  };
}

/** 主区窄于该宽度时退回上下分栏（与翻译工作台同阈值） */
const NARROW_LAYOUT_THRESHOLD = 500;

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
  onRetryImageOcr,
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
  onUndoSuggestion,
  appliedSuggestionKeys,
  onSaveAsNote,
  onGenerateCards,
  isGeneratingCards,
  currentRound,
  onModesChange,
  settingsAsPage = false,
  isActive,
  roundNavigation,
}) => {
  // 容器级断点：工作台可能运行在 workbench 窗口里（窗口远窄于视口），
  // viewport media query 在那里恒等于"桌面大屏"会把三栏挤成一条（O18 同款问题），
  // 故以工作台自身宽度分级：compact(<640) 走移动布局。
  // 同时兼顾视口断点（与 TranslationMain 同口径）：移动壳视口 <768，
  // 而 compact 阈值是 640——640~767 的视口若只看容器分级会误走桌面
  // 分栏 + 设置整页替换且不注册返回键，故两者取并集。
  // 桌面视口（≥768）下 viewport 分支恒为 false，行为不变。
  const { t } = useTranslation(['essay_grading']);
  const { ref: layoutRef, sizeClass } = useWbSysSize();
  const { isSmallScreen: viewportIsSmallScreen } = useBreakpoint();
  const isSmallScreen = sizeClass === 'compact' || viewportIsSmallScreen;
  const useSettingsPage = settingsAsPage || !isSmallScreen;

  // 左右 / 上下分栏：与翻译工作台同一口径——非小屏默认左右，仅当主区
  // 实测窄于阈值时退回上下。此前要求容器 ≥880(wide) 才左右，
  // 浮窗扣掉资源侧栏后常年落在 medium，被迫上下分栏。
  const mainAreaRef = React.useRef<HTMLDivElement>(null);
  const [mainAreaWidth, setMainAreaWidth] = React.useState(0);

  useEffect(() => {
    const el = mainAreaRef.current;
    if (!el || isSmallScreen || typeof ResizeObserver === 'undefined') return;

    const updateWidth = () => setMainAreaWidth(el.clientWidth);
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isSmallScreen]);

  // 未测得宽度前（首帧）以容器分级兜底，避免闪一帧上下布局
  const isSplit = !isSmallScreen
    && (mainAreaWidth > 0 ? mainAreaWidth >= NARROW_LAYOUT_THRESHOLD : true);
  // 小屏下批改结果区是否"有内容可看"：无内容时折叠为占位条，把高度让给输入区
  const resultActive = isGrading || Boolean(gradingResult) || Boolean(error) || currentRound > 0;
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);

  // 批改中阶段推断（供 InputPanel 锁定提示条显示阶段进度）
  const gradingPhase = React.useMemo<GradingPhase | undefined>(
    () => (isGrading ? inferGradingPhase(gradingResult) : undefined),
    [isGrading, gradingResult]
  );

  // 移动端设置区展开时注册 Android 返回键（返回 = 收起内联设置区块）。
  // 桌面端设置是独立整页视图（标签页语义），不属于 overlay，不劫持返回键。
  // ★ 标签页保活：TabPanelContainer 用 display:none 驻留非活跃实例，
  //   其设置区若曾展开会持续注册返回键并吞掉活跃标签页的返回操作，故 isActive gate。
  useEffect(() => {
    if (isActive === false || useSettingsPage || !showPromptEditor) return;
    return registerBackHandler(() => {
      setShowPromptEditor(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isActive, useSettingsPage, showPromptEditor, setShowPromptEditor]);

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
      // 📱 移动壳视口（<768）不给页内设置入口：宿主移动顶栏（learning-hub
      // rightActions 更多菜单 → 设置，经 essay:openSettings 事件）已提供，页内
      // 保留会形成重复次级入口。仅看视口不看容器 compact——桌面窄容器
      // （分屏/浮窗）没有移动顶栏，页内按钮仍是唯一入口
      onOpenSettings={settingsAsPage || viewportIsSmallScreen ? undefined : () => setShowPromptEditor(!showPromptEditor)}
      uploadedImages={uploadedImages}
      onRemoveImage={onRemoveImage}
      onRetryImageOcr={onRetryImageOcr}
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
      onUndoSuggestion={onUndoSuggestion}
      appliedSuggestionKeys={appliedSuggestionKeys}
      onSaveAsNote={onSaveAsNote}
      onGenerateCards={onGenerateCards}
      isGeneratingCards={isGeneratingCards}
      currentRound={currentRound}
      roundNavigation={roundNavigation}
    />
  );

  const settingsPanel = (
    <InlineSettingsPanel
      isOpen={showPromptEditor}
      onClose={() => setShowPromptEditor(false)}
      // 📱 仅移动壳视口隐藏自绘标题行（宿主顶栏提供 chrome 与设置开关）；
      // 桌面窄容器（分屏/浮窗）没有移动顶栏，标题行 X 仍是可见退出路径
      mobileFullscreen={!useSettingsPage && viewportIsSmallScreen}
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

  // ========== 设置区 ==========
  // 移动端：主分栏上方高度过渡展开的内联区块，推挤内容而非遮挡。
  // 关闭态经 visibility 过渡转为 hidden，退出焦点链与无障碍树。
  const mobileSettingsSection = (
    <div
      className={cn(
        'shrink-0 overflow-hidden bg-background',
        'transition-[height,visibility] duration-[var(--panel-open-dur,250ms)] ease-[var(--panel-ease,ease-out)] motion-reduce:transition-none',
        showPromptEditor ? 'visible h-[min(60dvh,420px)] border-b border-border/40' : 'invisible h-0',
      )}
      aria-hidden={!showPromptEditor}
    >
      {/* 内层固定高度：高度过渡期间内容不回流 */}
      <div className="h-[min(60dvh,420px)]">{settingsPanel}</div>
    </div>
  );

  // 桌面端：设置以独立整页视图占满主区（由侧边栏"批改设置"标签或设置按钮进入），
  // 不再使用右侧滑入列；批改主界面保持挂载（display:none），保留分栏比例与滚动位置。
  const desktopSettingsPage = (
    <div
      className={cn(
        'flex-1 min-h-0 overflow-hidden bg-background',
        showPromptEditor ? 'ui-rise-in' : 'hidden',
      )}
      aria-hidden={!showPromptEditor}
    >
      <div className="mx-auto h-full min-h-0 w-full max-w-3xl">
        {settingsPanel}
      </div>
    </div>
  );

  // ========== 统一布局：所有断点共用一个结构 ==========
  // 小屏：设置区块在上（高度过渡）+ 上下分栏；
  // 非小屏：设置打开时整页视图替换主分栏（主分栏保持挂载）。
  return (
    <div ref={layoutRef} className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {!useSettingsPage && mobileSettingsSection}
      {useSettingsPage && desktopSettingsPage}

      <div className={cn('flex flex-1 min-h-0', useSettingsPage && showPromptEditor && 'hidden')}>
        <div ref={mainAreaRef} className="flex-1 min-w-0 h-full">
          {isSplit ? (
            <HorizontalResizable
              initial={0.5}
              minLeft={0.3}
              minRight={0.3}
              className="bg-background"
              left={inputPanel}
              right={resultPanel}
            />
          ) : isSmallScreen && !resultActive ? (
            /* 小屏且尚无批改内容：输入区占满，结果区折叠为占位条（开始批改后自动展开为上下分栏） */
            <div className="flex h-full min-h-0 flex-col bg-background">
              <div className="flex-1 min-h-0 [&>*]:!h-full [&>*]:!min-h-0 [&>*]:!basis-auto [&>*]:!flex-none">
                {inputPanel}
              </div>
              <div className="flex shrink-0 items-center gap-2 border-t border-border/40 px-4 py-2.5 text-xs text-muted-foreground/60 select-none">
                <Pen size={13} className="shrink-0" />
                <span>{t('essay_grading:result_section.title')}</span>
                <span className="ml-auto text-muted-foreground/40">{t('essay_grading:result_empty.title')}</span>
              </div>
            </div>
          ) : (
            /* 小屏固定 40/60 上下堆叠不可拖（fixed 模式无手柄）；桌面窄容器仍可拖 */
            <VerticalResizable
              fixed={isSmallScreen}
              initial={isSmallScreen ? 0.4 : 0.45}
              minTop={isSmallScreen ? 0.2 : 0.25}
              minBottom={isSmallScreen ? 0.3 : 0.35}
              className="bg-background"
              top={inputPanel}
              bottom={resultPanel}
            />
          )}
        </div>
      </div>
    </div>
  );
};
