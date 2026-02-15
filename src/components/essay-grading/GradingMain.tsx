import React, { useState, useCallback, useEffect, useRef } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { InputPanel } from './InputPanel';
import { ResultPanel } from './ResultPanel';
import { GradingModeManager } from './GradingModeManager';
import { SettingsDrawer } from './SettingsDrawer';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { Textarea } from '../ui/shad/Textarea';
import { RotateCcw, Save, Settings2 } from 'lucide-react';
import { UnifiedModelSelector } from '../shared/UnifiedModelSelector';
import { HorizontalResizable, VerticalResizable } from '../shared/Resizable';
import { CustomScrollArea } from '../custom-scroll-area';
import type { GradingMode, ModelInfo } from '@/essay-grading/essayGradingApi';
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

  // Round Props
  currentRound: number;
  hasResult: boolean;
  onNextRound: () => void;

  // 模式管理
  onModesChange?: () => void;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
  };
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
  gradingResult,
  resultCharCount,
  onCopyResult,
  onExportResult,
  error,
  canRetry,
  onRetry,
  isPartialResult,
  currentRound,
  hasResult,
  onNextRound,
  onModesChange,
  roundNavigation,
}) => {
  const { t } = useTranslation(['essay_grading', 'common']);
  const { isSmallScreen, isLg } = useBreakpoint();
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const resultRef = React.useRef<HTMLDivElement>(null);

  // 模式管理器状态
  const [showModeManager, setShowModeManager] = useState(false);
  
  // 桌面端设置抽屉状态
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  
  // 判断屏幕类型
  const isDesktop = isLg; // ≥1024px
  const isMediumScreen = !isSmallScreen && !isLg; // 768px - 1024px

  // ========== 移动端滑动布局状态 ==========
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);

  const stateRef = useRef({
    isDragging: false,
    startX: 0,
    startY: 0,
    currentTranslate: 0,
    axisLocked: null as 'horizontal' | 'vertical' | null,
  });

  // 监听容器宽度
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    const updateWidth = () => setContainerWidth(container.clientWidth);
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(container);
    return () => ro.disconnect();
  }, [isSmallScreen]);

  // 设置面板宽度
  const settingsPanelWidth = Math.max(containerWidth - 60, 280);

  // 计算基础偏移
  const getBaseTranslate = useCallback(() => {
    return showPromptEditor ? -settingsPanelWidth : 0;
  }, [showPromptEditor, settingsPanelWidth]);

  // 拖拽处理
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    stateRef.current = {
      isDragging: true,
      startX: clientX,
      startY: clientY,
      currentTranslate: getBaseTranslate(),
      axisLocked: null,
    };
    setIsDragging(true);
    setDragOffset(0);
  }, [getBaseTranslate]);

  const handleDragMove = useCallback((clientX: number, clientY: number, preventDefault: () => void) => {
    if (!stateRef.current.isDragging) return;

    const deltaX = clientX - stateRef.current.startX;
    const deltaY = clientY - stateRef.current.startY;

    if (stateRef.current.axisLocked === null && (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10)) {
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2) {
        stateRef.current.axisLocked = 'horizontal';
      } else {
        stateRef.current.axisLocked = 'vertical';
        stateRef.current.isDragging = false;
        setIsDragging(false);
        return;
      }
    }

    if (stateRef.current.axisLocked === 'vertical') return;
    if (stateRef.current.axisLocked === 'horizontal') preventDefault();

    const minTranslate = -settingsPanelWidth;
    const maxTranslate = 0;
    let newTranslate = stateRef.current.currentTranslate + deltaX;
    newTranslate = Math.max(minTranslate, Math.min(maxTranslate, newTranslate));

    setDragOffset(newTranslate - getBaseTranslate());
  }, [settingsPanelWidth, getBaseTranslate]);

  const handleDragEnd = useCallback(() => {
    if (!stateRef.current.isDragging) {
      stateRef.current.axisLocked = null;
      return;
    }

    const threshold = settingsPanelWidth * 0.3;
    const offset = dragOffset;

    if (Math.abs(offset) > threshold) {
      if (offset > 0 && showPromptEditor) {
        setShowPromptEditor(false);
      } else if (offset < 0 && !showPromptEditor) {
        setShowPromptEditor(true);
      }
    }

    stateRef.current.isDragging = false;
    stateRef.current.axisLocked = null;
    setIsDragging(false);
    setDragOffset(0);
  }, [dragOffset, showPromptEditor, settingsPanelWidth, setShowPromptEditor]);

  // 绑定触摸事件
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isSmallScreen) return;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleDragStart(touch.clientX, touch.clientY);
    };

    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY, () => e.preventDefault());
    };

    const onTouchEnd = () => handleDragEnd();

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd);
    container.addEventListener('touchcancel', onTouchEnd);

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isSmallScreen, handleDragStart, handleDragMove, handleDragEnd]);

  // 获取默认模型
  const defaultModel = models.find(m => m.is_default);

  // 获取当前选中的批阅模式
  const currentMode = modes.find(m => m.id === modeId);

  // ========== 移动端：滑动布局 ==========
  if (isSmallScreen) {
    const translateX = getBaseTranslate() + dragOffset;

    return (
      <div
        ref={containerRef}
        className="relative h-full overflow-hidden bg-background select-none"
        style={{ touchAction: 'pan-y pinch-zoom' }}
      >
        {/* 滑动内容容器：主界面(100%) + 设置面板(settingsPanelWidth) */}
        <div
          className="flex h-full"
          style={{
            width: `calc(100% + ${settingsPanelWidth}px)`,
            transform: `translateX(${translateX}px)`,
            transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {/* 主界面：批改内容 */}
          <div
            className="h-full flex-shrink-0 flex flex-col"
            style={{ width: containerWidth || '100vw' }}
          >
            <VerticalResizable
              initial={0.4}
              minTop={0.2}
              minBottom={0.3}
              className="bg-background"
              top={
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
                  currentRound={currentRound}
                  hasResult={hasResult}
                  onNextRound={onNextRound}
                  roundNavigation={roundNavigation}
                />
              }
              bottom={
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
                  currentRound={currentRound}
                />
              }
            />
          </div>

          {/* 右侧：设置面板 */}
          <div
            className="h-full flex-shrink-0 bg-background border-l"
            style={{ width: settingsPanelWidth }}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
          >
            {/* 模式管理器 */}
            {showModeManager ? (
              <GradingModeManager
                modes={modes}
                currentModeId={modeId}
                onModeSelect={setModeId}
                onModesChange={() => onModesChange?.()}
                onClose={() => setShowModeManager(false)}
              />
            ) : (
              <div className="h-full flex flex-col bg-background">
                {/* 内容区 - Notion 风格 */}
                <CustomScrollArea className="flex-1" viewportClassName="p-4">
                  {/* 当前批阅模式信息 */}
                  {currentMode && (
                    <div className="mb-6 pb-4 border-b border-border/30">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
                          {t('essay_grading:mode.current')}
                        </h3>
                        <NotionButton variant="ghost" size="sm" onClick={() => setShowModeManager(true)} className="h-7 px-2 text-xs text-muted-foreground/70 hover:text-foreground hover:bg-muted/50">
                          <Settings2 className="w-3 h-3" />
                          {t('essay_grading:mode.manage')}
                        </NotionButton>
                      </div>
                      <div className="space-y-3">
                        <div>
                          <div className="font-medium text-sm text-foreground/90">{currentMode.name}</div>
                          <div className="text-xs text-muted-foreground/70 mt-1 leading-relaxed">{currentMode.description}</div>
                        </div>
                        <div className="text-xs">
                          <span className="text-muted-foreground/60">{t('essay_grading:mode.total_score')}：</span>
                          <span className="font-medium text-foreground/80">{currentMode.total_max_score}</span>
                        </div>
                        {currentMode.score_dimensions && currentMode.score_dimensions.length > 0 && (
                          <div className="space-y-1.5">
                            <div className="text-xs text-muted-foreground/60">{t('essay_grading:mode.dimensions')}：</div>
                            <div className="flex flex-wrap gap-1.5">
                              {currentMode.score_dimensions.map((dim, idx) => (
                                <span
                                  key={idx}
                                  className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-muted/50 text-foreground/70"
                                >
                                  {dim.name}
                                  <span className="ml-1 text-muted-foreground/50">({dim.max_score})</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* 模型选择 */}
                  {models.length > 0 && (
                    <div className="mb-6 pb-4 border-b border-border/30">
                      <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mb-3">
                        {t('essay_grading:model.title')}
                      </h3>
                      <UnifiedModelSelector
                        models={models}
                        value={modelId || defaultModel?.id || ''}
                        onChange={setModelId}
                        disabled={isGrading}
                        placeholder={t('essay_grading:model.select')}
                      />
                    </div>
                  )}

                  {/* 提示词编辑器 */}
                  <div className="mb-4">
                    <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mb-3">
                      {t('essay_grading:prompt_editor.title')}
                    </h3>
                  </div>
                  <div className="space-y-4 flex flex-col">
                    <Textarea
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      placeholder={t('essay_grading:prompt_editor.placeholder')}
                      className="flex-1 min-h-[320px] resize-none w-full text-sm border-border/40 focus:border-border/60"
                    />
                    <div className="flex gap-2 justify-end">
                      <NotionButton variant="ghost" size="sm" onClick={onRestoreDefaultPrompt} className="text-sm text-muted-foreground/70 hover:text-foreground hover:bg-muted/50">
                        <RotateCcw className="w-3.5 h-3.5" />
                        {t('essay_grading:prompt_editor.restore_default')}
                      </NotionButton>
                      <NotionButton variant="primary" size="sm" onClick={() => { onSavePrompt(); setShowPromptEditor(false); }} className="text-sm bg-primary/10 text-primary hover:bg-primary/20">
                        <Save className="w-3.5 h-3.5" />
                        {t('essay_grading:prompt_editor.save')}
                      </NotionButton>
                    </div>
                  </div>
                </CustomScrollArea>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ========== 中等屏幕（768px-1024px）：上下布局 + 设置抽屉 ==========
  if (isMediumScreen) {
    return (
      <div className="relative h-full overflow-hidden bg-background">
        {/* 主内容区 */}
        <div 
          className={cn(
            "h-full transition-all duration-300 ease-out",
            showSettingsDrawer ? "mr-[320px]" : "mr-0"
          )}
        >
          <VerticalResizable
            initial={0.45}
            minTop={0.25}
            minBottom={0.35}
            className="bg-background"
            top={
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
                onFilesDropped={onFilesDropped}
                ocrMaxFiles={ocrMaxFiles}
                customPrompt={customPrompt}
                setCustomPrompt={setCustomPrompt}
                showPromptEditor={false}
                setShowPromptEditor={() => setShowSettingsDrawer(true)}
                onSavePrompt={onSavePrompt}
                onRestoreDefaultPrompt={onRestoreDefaultPrompt}
                onClear={onClear}
                onGrade={onGrade}
                onCancelGrading={onCancelGrading}
                charCount={inputCharCount}
                currentRound={currentRound}
                hasResult={hasResult}
                onNextRound={onNextRound}
                roundNavigation={roundNavigation}
                onOpenSettings={() => setShowSettingsDrawer(true)}
              />
            }
            bottom={
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
                currentRound={currentRound}
              />
            }
          />
        </div>

        {/* 设置抽屉遮罩 */}
        {showSettingsDrawer && (
          <div 
            className="absolute inset-0 bg-black/20 z-10"
            onClick={() => setShowSettingsDrawer(false)}
          />
        )}

        {/* 设置抽屉 */}
        <div 
          className={cn(
            "absolute top-0 right-0 h-full w-[320px] z-20 transition-transform duration-300 ease-out",
            showSettingsDrawer ? "translate-x-0" : "translate-x-full"
          )}
        >
          <SettingsDrawer
            isOpen={showSettingsDrawer}
            onClose={() => setShowSettingsDrawer(false)}
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
            variant="drawer"
          />
        </div>
      </div>
    );
  }

  // ========== 桌面大屏（≥1024px）：左右分栏 + 可折叠设置抽屉 ==========
  // 计算设置抽屉宽度
  const settingsDrawerWidth = 320;
  
  return (
    <div className="relative h-full overflow-hidden bg-background flex">
      {/* 主内容区：左右分栏 */}
      <div 
        className={cn(
          "flex-1 min-w-0 h-full transition-all duration-300 ease-out"
        )}
        style={{
          marginRight: showSettingsDrawer ? settingsDrawerWidth : 0
        }}
      >
        {showModeManager ? (
          <GradingModeManager
            modes={modes}
            currentModeId={modeId}
            onModeSelect={setModeId}
            onModesChange={() => onModesChange?.()}
            onClose={() => setShowModeManager(false)}
          />
        ) : (
          <HorizontalResizable
            initial={0.5}
            minLeft={0.35}
            minRight={0.35}
            className="bg-background"
            left={
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
                onFilesDropped={onFilesDropped}
                ocrMaxFiles={ocrMaxFiles}
                customPrompt={customPrompt}
                setCustomPrompt={setCustomPrompt}
                showPromptEditor={false}
                setShowPromptEditor={() => setShowSettingsDrawer(true)}
                onSavePrompt={onSavePrompt}
                onRestoreDefaultPrompt={onRestoreDefaultPrompt}
                onClear={onClear}
                onGrade={onGrade}
                onCancelGrading={onCancelGrading}
                charCount={inputCharCount}
                currentRound={currentRound}
                hasResult={hasResult}
                onNextRound={onNextRound}
                roundNavigation={roundNavigation}
                onOpenSettings={() => setShowSettingsDrawer(true)}
              />
            }
            right={
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
                currentRound={currentRound}
              />
            }
          />
        )}
      </div>

      {/* 设置抽屉 */}
      <div 
        className={cn(
          "absolute top-0 right-0 h-full transition-transform duration-300 ease-out shadow-lg",
          showSettingsDrawer ? "translate-x-0" : "translate-x-full"
        )}
        style={{ width: settingsDrawerWidth }}
      >
        <SettingsDrawer
          isOpen={showSettingsDrawer}
          onClose={() => setShowSettingsDrawer(false)}
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
          variant="drawer"
        />
      </div>
    </div>
  );
};
