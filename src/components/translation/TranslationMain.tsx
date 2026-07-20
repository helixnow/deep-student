import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SourcePanel } from './SourcePanel';
import { TargetPanel } from './TargetPanel';
import { PromptPanel } from './PromptPanel';
import { LanguageSelect } from './LanguageSelect';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { HorizontalResizable, VerticalResizable } from '../shared/Resizable';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '../ui/shad/Switch';
import { Label } from '../ui/shad/Label';
import { CommonTooltip } from '../shared/CommonTooltip';
import { ArrowsLeftRight, CircleNotch, Columns, GearSix, Rows } from '@phosphor-icons/react';
import { cn } from '@/utils/cn';

interface TranslationMainProps {
  srcLang: string;
  setSrcLang: (lang: string) => void;
  tgtLang: string;
  setTgtLang: (lang: string) => void;
  sourceText: string;
  setSourceText: (text: string) => void;
  sourceMaxChars?: number;
  isSourceOverLimit?: boolean;
  translatedText: string;
  isTranslating: boolean;
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
  /** auto 模式下的检测语言（代码），用于选择器回显与交换按钮解锁 */
  detectedLang?: string | null;
  /** 是否自动聚焦原文输入框（非活跃标签页实例应传 false） */
  autoFocusSource?: boolean;

  // 常用开关
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

type LayoutMode = 'split' | 'stacked';

/** localStorage key：布局方式偏好（左右 / 上下） */
const LAYOUT_STORAGE_KEY = 'translation.workbench.layout';

function loadLayoutMode(): LayoutMode {
  try {
    return window.localStorage.getItem(LAYOUT_STORAGE_KEY) === 'stacked' ? 'stacked' : 'split';
  } catch {
    return 'split';
  }
}

/** 桌面端内联设置列宽度（文档流内，非 overlay） */
const SETTINGS_PANEL_WIDTH = 320;

/** 主区窄于该宽度时强制上下布局 */
const NARROW_LAYOUT_THRESHOLD = 500;

/** 触屏命中区扩展：32px 图标钮扩到 ≥44px，视觉不变（与 InputBarUI.coarseHitAreaClass 同款范式） */
const COARSE_HIT =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1.5 [@media(pointer:coarse)]:after:content-['']";

export const TranslationMain: React.FC<TranslationMainProps> = ({
  srcLang,
  setSrcLang,
  tgtLang,
  setTgtLang,
  sourceText,
  setSourceText,
  sourceMaxChars,
  isSourceOverLimit,
  translatedText,
  isTranslating,
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
  detectedLang = null,
  autoFocusSource = true,
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

  const rootRef = useRef<HTMLDivElement>(null);

  // ========== 布局模式（左右 / 上下，SegmentedControl 切换，持久化） ==========
  const [layoutMode, setLayoutModeState] = useState<LayoutMode>(() => loadLayoutMode());
  const setLayoutMode = useCallback((mode: LayoutMode) => {
    setLayoutModeState(mode);
    try {
      window.localStorage.setItem(LAYOUT_STORAGE_KEY, mode);
    } catch {
      // localStorage 不可用时静默降级（仅失去布局记忆）
    }
  }, []);

  // 主区宽度检测：窄于阈值时强制上下布局
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const [mainAreaWidth, setMainAreaWidth] = useState(0);

  useEffect(() => {
    const el = mainAreaRef.current;
    if (!el || isSmallScreen) return;

    const updateWidth = () => setMainAreaWidth(el.clientWidth);
    updateWidth();

    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isSmallScreen]);

  const isDesktopNarrow = !isSmallScreen && mainAreaWidth > 0 && mainAreaWidth < NARROW_LAYOUT_THRESHOLD;
  const effectiveStacked = isSmallScreen || isDesktopNarrow || layoutMode === 'stacked';
  const layoutControlValue: LayoutMode = isDesktopNarrow ? 'stacked' : layoutMode;

  // ========== 移动端：设置区展开时注册 Android 返回键（返回 = 收起设置） ==========
  useEffect(() => {
    if (!isSmallScreen || !showPromptEditor) return;
    return registerBackHandler(() => {
      setShowPromptEditor(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, showPromptEditor, setShowPromptEditor]);

  // ========== 同步滚动 ==========
  // 通过根容器捕获阶段监听 scroll，按 [data-translation-scroll="source"|"target"]
  // 识别滚动容器（由 SourcePanel / TargetPanel 保证挂载该属性）。
  // 捕获监听不依赖具体 DOM 节点，面板内部切换（编辑/对照/流式）重挂载后依然生效。
  const syncLockRef = useRef<{ owner: 'source' | 'target' | null; timer: number | null }>({
    owner: null,
    timer: null,
  });

  useEffect(() => {
    if (!isSyncScroll) return;
    const root = rootRef.current;
    if (!root) return;
    const lock = syncLockRef.current;

    const handleScroll = (event: Event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement)) return;
      const role = el.getAttribute('data-translation-scroll');
      if (role !== 'source' && role !== 'target') return;

      // 防循环：对侧因程序滚动触发的 scroll 事件在锁定窗口内直接忽略
      if (lock.owner && lock.owner !== role) return;

      const counterpartRole = role === 'source' ? 'target' : 'source';
      const counterpart = root.querySelector<HTMLElement>(
        `[data-translation-scroll="${counterpartRole}"]`
      );
      if (!counterpart) return;

      lock.owner = role;

      const fromScrollable = el.scrollHeight - el.clientHeight;
      const toScrollable = counterpart.scrollHeight - counterpart.clientHeight;
      if (fromScrollable > 0 && toScrollable > 0) {
        const next = (el.scrollTop / fromScrollable) * toScrollable;
        if (Math.abs(counterpart.scrollTop - next) > 1) {
          counterpart.scrollTop = next;
        }
      }

      if (lock.timer !== null) window.clearTimeout(lock.timer);
      lock.timer = window.setTimeout(() => {
        lock.owner = null;
        lock.timer = null;
      }, 80);
    };

    root.addEventListener('scroll', handleScroll, true);
    return () => {
      root.removeEventListener('scroll', handleScroll, true);
      if (lock.timer !== null) window.clearTimeout(lock.timer);
      lock.owner = null;
      lock.timer = null;
    };
  }, [isSyncScroll]);

  // ========== 顶部工具栏 ==========
  const languageOptions = useMemo(
    () =>
      LANGUAGES.filter((lang) => lang.code !== 'auto').map((lang) => ({
        code: lang.code,
        label: t(lang.label),
      })),
    [t]
  );

  // 互换按钮 180° 旋转动画：累计角度，方向感连续
  const [swapSpin, setSwapSpin] = useState(0);
  const handleSwapClick = useCallback(() => {
    setSwapSpin((count) => count + 1);
    onSwapLanguages();
  }, [onSwapLanguages]);

  // auto 模式下已有检测结果时允许交换（对齐 DeepL：用检测语言交换）
  // 编辑译文时禁止：交换会改写译文，踩踏未保存的编辑内容
  const canSwap = !isTranslating && !isEditingTranslation && (srcLang !== 'auto' || !!detectedLang);

  const toolbar = (
    <div data-wb-blur-surface className="h-12 shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-1 sm:gap-2 px-3 sm:px-4 border-b bg-background/50 backdrop-blur z-20">
      {/* 左：布局切换（仅桌面；窄容器时强制上下布局并禁用） */}
      <div className="hidden sm:flex items-center justify-start">
        <SegmentedControl<LayoutMode>
          ariaLabel={t('translation:workbench.layout.label')}
          value={layoutControlValue}
          onValueChange={setLayoutMode}
          size="compact"
          options={[
            {
              value: 'split',
              label: <Columns size={14} />,
              ariaLabel: t('translation:workbench.layout.split'),
              title: t('translation:workbench.layout.split'),
              disabled: isDesktopNarrow,
            },
            {
              value: 'stacked',
              label: <Rows size={14} />,
              ariaLabel: t('translation:workbench.layout.stacked'),
              title: t('translation:workbench.layout.stacked'),
              disabled: isDesktopNarrow,
            },
          ]}
        />
      </div>

      {/* 中：语向选择 + 互换（DeepL 式居中布局） */}
      <div className="flex items-center justify-center gap-1 sm:gap-2 min-w-0">
        <LanguageSelect
          value={srcLang}
          onChange={setSrcLang}
          languages={languageOptions}
          includeAuto
          detectedLanguage={detectedLang}
          disabled={isTranslating}
          className="min-w-0"
        />
        <CommonTooltip
          content={`${t('translation:actions.swap_languages')} · ${t('translation:shortcuts.swap')}`}
        >
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={handleSwapClick}
            disabled={!canSwap}
            className={cn(COARSE_HIT, 'h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground')}
            aria-label={t('translation:actions.swap_languages')}
          >
            <span
              className="inline-flex transition-transform duration-[var(--dropdown-open-dur)] ease-[var(--ease-standard)] motion-reduce:transition-none"
              style={{ transform: `rotate(${swapSpin * 180}deg)` }}
            >
              <ArrowsLeftRight size={16} />
            </span>
          </NotionButton>
        </CommonTooltip>
        <LanguageSelect
          value={tgtLang}
          onChange={setTgtLang}
          languages={languageOptions}
          disabled={isTranslating}
          className="min-w-0"
        />
      </div>

      {/* 右：翻译中指示 + 常用开关 + 设置开合 */}
      <div className="flex items-center justify-end gap-1 sm:gap-2 min-w-0">
        {isTranslating && (
          <span className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
            <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" />
            {t('translation:actions.translating')}
          </span>
        )}

        <div className="hidden lg:flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[var(--interactive-hover)] transition-colors">
          <Switch
            id="toolbar-auto-translate"
            checked={isAutoTranslate}
            onCheckedChange={setIsAutoTranslate}
          />
          <Label
            htmlFor="toolbar-auto-translate"
            className="text-xs font-medium text-muted-foreground cursor-pointer whitespace-nowrap"
          >
            {t('translation:workbench.toolbar.auto_translate')}
          </Label>
        </div>

        <div className="hidden lg:flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[var(--interactive-hover)] transition-colors">
          <Switch
            id="toolbar-sync-scroll"
            checked={isSyncScroll}
            onCheckedChange={setIsSyncScroll}
          />
          <Label
            htmlFor="toolbar-sync-scroll"
            className="text-xs font-medium text-muted-foreground cursor-pointer whitespace-nowrap"
          >
            {t('translation:sync_scroll')}
          </Label>
        </div>

        <div className="hidden lg:block w-px h-4 bg-border" />

        <CommonTooltip content={t('translation:prompt_editor.title')}>
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={() => setShowPromptEditor(!showPromptEditor)}
            aria-label={t('translation:prompt_editor.title')}
            aria-expanded={showPromptEditor}
            className={cn(
              COARSE_HIT,
              'h-8 w-8 shrink-0',
              showPromptEditor
                ? 'text-primary bg-primary/10'
                : 'text-muted-foreground/60 hover:text-foreground'
            )}
          >
            <GearSix size={16} />
          </NotionButton>
        </CommonTooltip>
      </div>
    </div>
  );

  // ========== 双栏面板 ==========
  const sourcePanelNode = (
    <SourcePanel
      sourceText={sourceText}
      setSourceText={setSourceText}
      sourceMaxChars={sourceMaxChars}
      isSourceOverLimit={isSourceOverLimit}
      isTranslating={isTranslating}
      onFilesDropped={onFilesDropped}
      onClear={onClear}
      onTranslate={onTranslate}
      onCancelTranslation={onCancelTranslation}
      sourceCharCount={sourceCharCount}
      autoFocus={autoFocusSource}
    />
  );

  const targetPanelNode = (
    <TargetPanel
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
    />
  );

  // ========== 设置区（内联，无抽屉 / 无 overlay） ==========
  // 移动端：工具栏下方高度过渡展开；桌面端：右侧文档流列宽度过渡展开。
  // 关闭态经 visibility 过渡转为 hidden，退出焦点链与无障碍树。
  const mobileSettingsSection = (
    <div
      className={cn(
        'shrink-0 overflow-hidden bg-background',
        'transition-[height,visibility] duration-[var(--panel-open-dur)] ease-[var(--panel-ease)] motion-reduce:transition-none',
        showPromptEditor ? 'visible h-[min(60vh,420px)] border-b' : 'invisible h-0'
      )}
      aria-hidden={!showPromptEditor}
    >
      <div className="h-[min(60vh,420px)]">
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
  );

  const desktopSettingsColumn = (
    <div
      className={cn(
        'relative h-full shrink-0 overflow-hidden',
        'transition-[width,visibility] duration-[var(--panel-open-dur)] ease-[var(--panel-ease)] motion-reduce:transition-none',
        showPromptEditor ? 'visible' : 'invisible'
      )}
      style={{ width: showPromptEditor ? SETTINGS_PANEL_WIDTH : 0 }}
      aria-hidden={!showPromptEditor}
    >
      {/* 内层固定宽度并锚定右侧：过渡期间内容不回流，呈现滑入效果 */}
      <div className="absolute inset-y-0 right-0 h-full" style={{ width: SETTINGS_PANEL_WIDTH }}>
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
        />
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden bg-background">
      {toolbar}

      {/* 移动端：设置区内联展开在工具栏下方，推挤内容而非遮挡 */}
      {isSmallScreen && mobileSettingsSection}

      <div className="flex-1 min-h-0 flex">
        <div ref={mainAreaRef} className="flex-1 min-w-0 h-full">
          {effectiveStacked ? (
            <VerticalResizable
              initial={0.4}
              minTop={0.2}
              minBottom={0.3}
              className="bg-background"
              top={sourcePanelNode}
              bottom={targetPanelNode}
            />
          ) : (
            <HorizontalResizable
              initial={0.5}
              minLeft={0.3}
              minRight={0.3}
              className="bg-background"
              left={sourcePanelNode}
              right={targetPanelNode}
            />
          )}
        </div>

        {/* 桌面端：设置区为文档流内联列（宽度过渡），不遮挡主内容 */}
        {!isSmallScreen && desktopSettingsColumn}
      </div>
    </div>
  );
};
