import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SourcePanel } from './SourcePanel';
import { TargetPanel } from './TargetPanel';
import { PromptPanel } from './PromptPanel';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { HorizontalResizable, VerticalResizable } from '../shared/Resizable';
import { cn } from '@/utils/cn';

interface TranslationMainProps {
  isMaximized: boolean;
  setIsMaximized: (maximized: boolean) => void;
  isSourceCollapsed: boolean;
  setIsSourceCollapsed: (collapsed: boolean) => void;
  srcLang: string;
  setSrcLang: (lang: string) => void;
  tgtLang: string;
  setTgtLang: (lang: string) => void;
  sourceText: string;
  setSourceText: (text: string) => void;
  sourceMaxChars?: number;
  isSourceOverLimit?: boolean;
  translatedText: string;
  setTranslatedText: (text: string) => void;
  isTranslating: boolean;
  translationProgress: number;
  customPrompt: string;
  setCustomPrompt: (prompt: string) => void;
  showPromptEditor: boolean;
  setShowPromptEditor: (show: boolean) => void;
  formality: 'formal' | 'casual' | 'auto';
  setFormality: (formality: 'formal' | 'casual' | 'auto') => void;
  domain: string;
  setDomain: (domain: string) => void;
  glossary: Array<[string, string]>;
  setGlossary: (glossary: Array<[string, string]>) => void;
  isEditingTranslation: boolean;
  editedTranslation: string;
  setEditedTranslation: (text: string) => void;
  translationQuality: number | null;
  isSpeaking: boolean;
  charCount: number;
  wordCount: number;

  // New States
  isAutoTranslate: boolean;
  setIsAutoTranslate: (val: boolean) => void;
  isSyncScroll: boolean;
  setIsSyncScroll: (val: boolean) => void;

  // Actions
  onSwapLanguages: () => void;
  onFilesDropped: (files: File[]) => void;
  onSavePrompt: () => void;
  onRestoreDefaultPrompt: () => void;
  onTranslate: () => void;
  onCancelTranslation: () => void;
  onClear: () => void;
  onEditTranslation: () => void;
  onSaveEditedTranslation: () => void;
  onCancelEdit: () => void;
  onSpeak: () => void;
  onCopyResult: () => void;
  onExportTranslation: () => void;
  onRateTranslation: (rating: number) => void;
}

const LANGUAGES = [
  { code: 'auto', label: 'translation:languages.auto' },
  { code: 'zh-CN', label: 'translation:languages.zh-CN' },
  { code: 'zh-TW', label: 'translation:languages.zh-TW' },
  { code: 'en', label: 'translation:languages.en' },
  { code: 'ja', label: 'translation:languages.ja' },
  { code: 'ko', label: 'translation:languages.ko' },
  { code: 'fr', label: 'translation:languages.fr' },
  { code: 'de', label: 'translation:languages.de' },
  { code: 'es', label: 'translation:languages.es' },
  { code: 'ru', label: 'translation:languages.ru' },
  { code: 'ar', label: 'translation:languages.ar' },
  { code: 'pt', label: 'translation:languages.pt' },
  { code: 'pt-BR', label: 'translation:languages.pt-BR' },
  { code: 'it', label: 'translation:languages.it' },
  { code: 'vi', label: 'translation:languages.vi' },
  { code: 'th', label: 'translation:languages.th' },
  { code: 'hi', label: 'translation:languages.hi' },
  { code: 'tr', label: 'translation:languages.tr' },
  { code: 'pl', label: 'translation:languages.pl' },
  { code: 'nl', label: 'translation:languages.nl' },
  { code: 'sv', label: 'translation:languages.sv' },
  { code: 'la', label: 'translation:languages.la' },
  { code: 'el', label: 'translation:languages.el' },
  { code: 'uk', label: 'translation:languages.uk' },
  { code: 'id', label: 'translation:languages.id' },
  { code: 'ms', label: 'translation:languages.ms' },
];

export const TranslationMain: React.FC<TranslationMainProps> = ({
  isMaximized,
  setIsMaximized,
  isSourceCollapsed,
  setIsSourceCollapsed,
  srcLang,
  setSrcLang,
  tgtLang,
  setTgtLang,
  sourceText,
  setSourceText,
  sourceMaxChars,
  isSourceOverLimit,
  translatedText,
  setTranslatedText,
  isTranslating,
  translationProgress,
  customPrompt,
  setCustomPrompt,
  showPromptEditor,
  setShowPromptEditor,
  formality,
  setFormality,
  domain,
  setDomain,
  glossary,
  setGlossary,
  isEditingTranslation,
  editedTranslation,
  setEditedTranslation,
  translationQuality,
  isSpeaking,
  charCount,
  wordCount,
  isAutoTranslate,
  setIsAutoTranslate,
  isSyncScroll,
  setIsSyncScroll,
  onSwapLanguages,
  onFilesDropped,
  onSavePrompt,
  onRestoreDefaultPrompt,
  onTranslate,
  onCancelTranslation,
  onClear,
  onEditTranslation,
  onSaveEditedTranslation,
  onCancelEdit,
  onSpeak,
  onCopyResult,
  onExportTranslation,
  onRateTranslation,
}) => {
  const { t } = useTranslation(['translation', 'common']);
  const { isSmallScreen } = useBreakpoint();

  const sourceCharCount = sourceText.length;
  const targetCharCount = translatedText.length;

  // ========== 桌面端容器宽度检测（窄屏时切换为上下布局） ==========
  const desktopContainerRef = useRef<HTMLDivElement>(null);
  const [desktopContainerWidth, setDesktopContainerWidth] = useState(0);
  const isDesktopNarrow = !isSmallScreen && desktopContainerWidth > 0 && desktopContainerWidth < 500;

  useEffect(() => {
    const container = desktopContainerRef.current;
    if (!container || isSmallScreen) return;

    const updateWidth = () => setDesktopContainerWidth(container.clientWidth);
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(container);
    return () => ro.disconnect();
  }, [isSmallScreen]);

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

  // 提示词面板宽度（留出 60px 露出主界面）
  const promptPanelWidth = Math.max(containerWidth - 60, 280);

  // 计算基础偏移量：主界面居中，提示词面板在右侧
  const getBaseTranslate = useCallback(() => {
    return showPromptEditor ? -promptPanelWidth : 0;
  }, [showPromptEditor, promptPanelWidth]);

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

    // 确定轴向（轴向锁定，防止与竖直滚动冲突）
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

    // 限制范围
    const minTranslate = -promptPanelWidth;
    const maxTranslate = 0;
    let newTranslate = stateRef.current.currentTranslate + deltaX;
    newTranslate = Math.max(minTranslate, Math.min(maxTranslate, newTranslate));

    setDragOffset(newTranslate - getBaseTranslate());
  }, [promptPanelWidth, getBaseTranslate]);

  const handleDragEnd = useCallback(() => {
    if (!stateRef.current.isDragging) {
      stateRef.current.axisLocked = null;
      return;
    }

    const threshold = promptPanelWidth * 0.3;
    const offset = dragOffset;

    // 根据拖拽方向和距离决定是否显示提示词面板
    if (Math.abs(offset) > threshold) {
      if (offset > 0 && showPromptEditor) {
        // 向右滑动，关闭提示词面板
        setShowPromptEditor(false);
      } else if (offset < 0 && !showPromptEditor) {
        // 向左滑动，打开提示词面板
        setShowPromptEditor(true);
      }
    }

    stateRef.current.isDragging = false;
    stateRef.current.axisLocked = null;
    setIsDragging(false);
    setDragOffset(0);
  }, [dragOffset, showPromptEditor, promptPanelWidth, setShowPromptEditor]);

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
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isSmallScreen, handleDragStart, handleDragMove, handleDragEnd]);

  // Sync Scroll Logic
  const sourceRef = React.useRef<HTMLTextAreaElement>(null);
  const targetRef = React.useRef<HTMLDivElement>(null);
  const isScrolling = React.useRef<'source' | 'target' | null>(null);

  React.useEffect(() => {
    if (!isSyncScroll) return;

    const source = sourceRef.current;
    const targetWrapper = targetRef.current;
    const target = targetWrapper?.querySelector('.translation-content .scroll-area__viewport') as HTMLElement;

    if (!source || !target) return;

    const handleSourceScroll = () => {
      if (isScrolling.current === 'target') return;
      isScrolling.current = 'source';

      // 除零保护：确保分母不为零
      const sourceScrollableHeight = source.scrollHeight - source.clientHeight;
      if (sourceScrollableHeight > 0 && target.scrollHeight > target.clientHeight) {
        const percentage = source.scrollTop / sourceScrollableHeight;
        target.scrollTop = percentage * (target.scrollHeight - target.clientHeight);
      }

      setTimeout(() => { if (isScrolling.current === 'source') isScrolling.current = null; }, 50);
    };

    const handleTargetScroll = () => {
      if (isScrolling.current === 'source') return;
      isScrolling.current = 'target';

      // 除零保护：确保分母不为零
      const targetScrollableHeight = target.scrollHeight - target.clientHeight;
      if (targetScrollableHeight > 0 && source.scrollHeight > source.clientHeight) {
        const percentage = target.scrollTop / targetScrollableHeight;
        source.scrollTop = percentage * (source.scrollHeight - source.clientHeight);
      }

      setTimeout(() => { if (isScrolling.current === 'target') isScrolling.current = null; }, 50);
    };

    source.addEventListener('scroll', handleSourceScroll);
    target.addEventListener('scroll', handleTargetScroll);

    return () => {
      source.removeEventListener('scroll', handleSourceScroll);
      target.removeEventListener('scroll', handleTargetScroll);
    };
  }, [isSyncScroll, translatedText]);

  // ========== 移动端：滑动布局 ==========
  if (isSmallScreen) {
    const translateX = getBaseTranslate() + dragOffset;

    return (
      <div
        ref={containerRef}
        className="relative h-full overflow-hidden bg-background select-none"
        style={{ touchAction: 'pan-y pinch-zoom' }}
      >
        {/* 滑动内容容器：主界面(100%) + 提示词面板(promptPanelWidth) */}
        <div
          className="flex h-full"
          style={{
            width: `calc(100% + ${promptPanelWidth}px)`,
            transform: `translateX(${translateX}px)`,
            transition: isDragging ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {/* 主界面：翻译内容 */}
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
                <SourcePanel
                  ref={sourceRef}
                  isMaximized={isMaximized}
                  isSourceCollapsed={isSourceCollapsed}
                  setIsSourceCollapsed={setIsSourceCollapsed}
                  srcLang={srcLang}
                  setSrcLang={setSrcLang}
                  tgtLang={tgtLang}
                  setTgtLang={setTgtLang}
                  sourceText={sourceText}
                  setSourceText={setSourceText}
                  sourceMaxChars={sourceMaxChars}
                  isSourceOverLimit={isSourceOverLimit}
                  isTranslating={isTranslating}
                  onSwapLanguages={onSwapLanguages}
                  onFilesDropped={onFilesDropped}
                  setShowPromptEditor={setShowPromptEditor}
                  onClear={onClear}
                  onTranslate={onTranslate}
                  onCancelTranslation={onCancelTranslation}
                  sourceCharCount={sourceCharCount}
                  LANGUAGES={LANGUAGES}
                  isSyncScroll={isSyncScroll}
                  setIsSyncScroll={setIsSyncScroll}
                />
              }
              bottom={
                <TargetPanel
                  ref={targetRef}
                  isMaximized={isMaximized}
                  setIsMaximized={setIsMaximized}
                  setIsSourceCollapsed={setIsSourceCollapsed}
                  sourceText={sourceText}
                  srcLang={srcLang}
                  tgtLang={tgtLang}
                  translatedText={translatedText}
                  isTranslating={isTranslating}
                  isSyncScroll={isSyncScroll}
                  setIsSyncScroll={setIsSyncScroll}
                  isEditingTranslation={isEditingTranslation}
                  editedTranslation={editedTranslation}
                  setEditedTranslation={setEditedTranslation}
                  onCancelEdit={onCancelEdit}
                  onSaveEditedTranslation={onSaveEditedTranslation}
                  translationQuality={translationQuality}
                  onRateTranslation={onRateTranslation}
                  targetCharCount={targetCharCount}
                  onEditTranslation={onEditTranslation}
                  onSpeak={onSpeak}
                  isSpeaking={isSpeaking}
                  onCopyResult={onCopyResult}
                  onExportTranslation={onExportTranslation}
                  charCount={charCount}
                  wordCount={wordCount}
                />
              }
            />
          </div>

          {/* 右侧：提示词设置面板 */}
          <div
            className="h-full flex-shrink-0 bg-background border-l"
            style={{ width: promptPanelWidth }}
            onTouchStart={(e) => e.stopPropagation()}
            onTouchMove={(e) => e.stopPropagation()}
            onTouchEnd={(e) => e.stopPropagation()}
          >
            <PromptPanel
              customPrompt={customPrompt}
              setCustomPrompt={setCustomPrompt}
              onSavePrompt={onSavePrompt}
              onRestoreDefaultPrompt={onRestoreDefaultPrompt}
              isOpen={showPromptEditor}
              setIsOpen={setShowPromptEditor}
              formality={formality}
              setFormality={setFormality}
              domain={domain}
              setDomain={setDomain}
              glossary={glossary}
              setGlossary={setGlossary}
              mobileFullscreen={true}
              isAutoTranslate={isAutoTranslate}
              setIsAutoTranslate={setIsAutoTranslate}
              isSyncScroll={isSyncScroll}
              setIsSyncScroll={setIsSyncScroll}
            />
          </div>
        </div>
      </div>
    );
  }

  // ========== 桌面端源面板和目标面板（共用） ==========
  const desktopSourcePanel = (
    <SourcePanel
      ref={sourceRef}
      isMaximized={isMaximized}
      isSourceCollapsed={isSourceCollapsed}
      setIsSourceCollapsed={setIsSourceCollapsed}
      srcLang={srcLang}
      setSrcLang={setSrcLang}
      tgtLang={tgtLang}
      setTgtLang={setTgtLang}
      sourceText={sourceText}
      setSourceText={setSourceText}
      sourceMaxChars={sourceMaxChars}
      isSourceOverLimit={isSourceOverLimit}
      isTranslating={isTranslating}
      onSwapLanguages={onSwapLanguages}
      onFilesDropped={onFilesDropped}
      setShowPromptEditor={setShowPromptEditor}
      onClear={onClear}
      onTranslate={onTranslate}
      onCancelTranslation={onCancelTranslation}
      sourceCharCount={sourceCharCount}
      LANGUAGES={LANGUAGES}
      isSyncScroll={isSyncScroll}
      setIsSyncScroll={setIsSyncScroll}
    />
  );

  const desktopTargetPanel = (
    <TargetPanel
      ref={targetRef}
      isMaximized={isMaximized}
      setIsMaximized={setIsMaximized}
      setIsSourceCollapsed={setIsSourceCollapsed}
      sourceText={sourceText}
      srcLang={srcLang}
      tgtLang={tgtLang}
      translatedText={translatedText}
      isTranslating={isTranslating}
      isSyncScroll={isSyncScroll}
      setIsSyncScroll={setIsSyncScroll}
      isEditingTranslation={isEditingTranslation}
      editedTranslation={editedTranslation}
      setEditedTranslation={setEditedTranslation}
      onCancelEdit={onCancelEdit}
      onSaveEditedTranslation={onSaveEditedTranslation}
      translationQuality={translationQuality}
      onRateTranslation={onRateTranslation}
      targetCharCount={targetCharCount}
      onEditTranslation={onEditTranslation}
      onSpeak={onSpeak}
      isSpeaking={isSpeaking}
      onCopyResult={onCopyResult}
      onExportTranslation={onExportTranslation}
      charCount={charCount}
      wordCount={wordCount}
    />
  );

  // ========== 桌面端：根据容器宽度自适应布局 ==========
  const settingsDrawerWidth = 320;

  return (
    <div ref={desktopContainerRef} className="relative h-full overflow-hidden bg-background flex">
      {/* 主内容区：通过 marginRight 推挤让位给抽屉 */}
      <div
        className="flex-1 min-w-0 h-full transition-all duration-300 ease-out"
        style={{ marginRight: showPromptEditor ? settingsDrawerWidth : 0 }}
      >
        {isDesktopNarrow ? (
          // 窄屏时使用上下布局
          <VerticalResizable
            initial={0.4}
            minTop={0.2}
            minBottom={0.3}
            className="bg-background"
            top={desktopSourcePanel}
            bottom={desktopTargetPanel}
          />
        ) : (
          // 正常宽度使用左右布局
          <HorizontalResizable
            initial={0.5}
            minLeft={0.3}
            minRight={0.3}
            className="bg-background"
            left={desktopSourcePanel}
            right={desktopTargetPanel}
          />
        )}
      </div>

      {/* 设置抽屉 */}
      <div
        className={cn(
          "absolute top-0 right-0 h-full transition-transform duration-300 ease-out shadow-lg",
          showPromptEditor ? "translate-x-0" : "translate-x-full"
        )}
        style={{ width: settingsDrawerWidth }}
      >
        <PromptPanel
          customPrompt={customPrompt}
          setCustomPrompt={setCustomPrompt}
          onSavePrompt={onSavePrompt}
          onRestoreDefaultPrompt={onRestoreDefaultPrompt}
          isOpen={showPromptEditor}
          setIsOpen={setShowPromptEditor}
          formality={formality}
          setFormality={setFormality}
          domain={domain}
          setDomain={setDomain}
          glossary={glossary}
          setGlossary={setGlossary}
          isAutoTranslate={isAutoTranslate}
          setIsAutoTranslate={setIsAutoTranslate}
          isSyncScroll={isSyncScroll}
          setIsSyncScroll={setIsSyncScroll}
        />
      </div>
    </div>
  );
};
