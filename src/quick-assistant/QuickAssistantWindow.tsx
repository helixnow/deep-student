import '@/styles/tailwind.css';
import '@/styles/shadcn-variables.css';
import '@/i18n';
import './quick-assistant.css';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Brain,
  CaretLeft,
  Check,
  ClipboardText,
  CopySimple,
  FileMagnifyingGlass,
  Lightbulb,
  MagnifyingGlass,
  NotePencil,
  PushPin,
  PushPinSlash,
  Sparkle,
  SpinnerGap,
  Stack,
  Student,
  Translate,
  X,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import useTheme from '@/hooks/useTheme';
import { initializeFontSetting } from '@/hooks/useAppInitialization';
import { cn } from '@/lib/utils';
import {
  getQuickAssistantConfig,
  readQuickAssistantPinned,
  saveQuickAssistantPinned,
} from './config';
import {
  getActiveTodoSummary,
  getQuickReviewSnapshot,
  inferQuickActions,
  isCaptureLikeText,
  looksLikeSecret,
  performImageOcr,
  QUICK_RUN_STOPPED,
  rateQuickReviewCard,
  saveAsCard,
  saveAsMistake,
  saveAsNote,
  saveAsTodo,
  searchLearningHistory,
  startQuickLearningAction,
  type QuickLearningAction,
  type QuickReviewSnapshot,
  type QuickRunHandle,
  type QuickSearchResult,
} from './service';
import QuickMarkdown from './QuickMarkdown';
import {
  QUICK_ASSISTANT_SHOWN_EVENT,
  hideCurrentQuickAssistantWindow,
  openQuickAssistantTarget,
} from './window';

type Route = 'home' | 'answer' | 'search' | 'review' | 'status';
type SaveKind = 'note' | 'mistake' | 'card' | 'todo';
type Notice = { text: string; kind: 'info' | 'success' | 'error' } | null;

const CAPTURE_LIMIT = 20_000;

const ACTION_ICONS: Record<QuickLearningAction, Icon> = {
  ask: Sparkle,
  explain: Brain,
  translate: Translate,
  summarize: Stack,
  hint: Lightbulb,
};

type FeatureKind = 'search' | 'review' | 'status';

const FEATURE_ICONS: Record<FeatureKind, Icon> = {
  search: MagnifyingGlass,
  review: Student,
  status: Stack,
};

type HomeItem =
  | { kind: 'llm'; action: QuickLearningAction }
  | { kind: 'search' }
  | { kind: 'review' }
  | { kind: 'status' };

const THEME_STORAGE_KEYS = {
  mode: 'dstu-theme-mode',
  palette: 'dstu-theme-palette',
  customColor: 'dstu-theme-custom-color',
} as const;

/**
 * 主窗口的主题 / 语言修改会落到 localStorage，但对应的自定义事件不跨窗口，
 * 常驻的小窗永远收不到。每次呼出时重读一遍存储并广播给本窗口的 useTheme，
 * 保证小窗与主窗口的外观保持一致。
 */
function syncPreferencesFromStorage(): void {
  try {
    const mode = localStorage.getItem(THEME_STORAGE_KEYS.mode);
    if (mode === 'light' || mode === 'dark' || mode === 'auto') {
      window.dispatchEvent(new CustomEvent('dstu-theme-mode-changed', { detail: { mode } }));
    }
    const palette = localStorage.getItem(THEME_STORAGE_KEYS.palette);
    if (palette) {
      window.dispatchEvent(new CustomEvent('dstu-theme-palette-changed', {
        detail: {
          palette,
          customColor: localStorage.getItem(THEME_STORAGE_KEYS.customColor) || undefined,
        },
      }));
    }
    const language = localStorage.getItem('i18nextLng');
    if (language && language !== i18n.language) void i18n.changeLanguage(language);
  } catch {
    // localStorage 不可用时保持当前偏好
  }
}

function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(String(i18n.t('quickAssistant:errors.image_read_failed'))));
    reader.readAsDataURL(file);
  });
}

function stripSnippetHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function isImeEvent(event: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return native.isComposing || event.key === 'Process';
}

function homeItemKey(item: HomeItem): string {
  return item.kind === 'llm' ? `llm-${item.action}` : item.kind;
}

export const QuickAssistantWindow: React.FC = () => {
  useTheme();
  const { t } = useTranslation('quickAssistant');
  const [route, setRoute] = useState<Route>('home');
  const [input, setInput] = useState('');
  const [capture, setCapture] = useState('');
  const [captureTruncated, setCaptureTruncated] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentAction, setCurrentAction] = useState<QuickLearningAction>('ask');
  const [askedContent, setAskedContent] = useState('');
  const [askedExpanded, setAskedExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pinned, setPinned] = useState(false);
  const [savedKinds, setSavedKinds] = useState<Set<SaveKind>>(new Set());
  const [searchResults, setSearchResults] = useState<QuickSearchResult[]>([]);
  const [review, setReview] = useState<QuickReviewSnapshot | null>(null);
  const [reviewRevealed, setReviewRevealed] = useState(false);
  const [reviewStartedAt, setReviewStartedAt] = useState(Date.now());
  const [todoSummary, setTodoSummary] = useState<Awaited<ReturnType<typeof getActiveTodoSummary>>>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const lastShownAtRef = useRef(Date.now());
  const lastClipboardRef = useRef<string | null>(null);
  const runRef = useRef<QuickRunHandle | null>(null);
  // 供事件回调读取最新交互状态（避免闭包过期导致的误判）
  const interactionRef = useRef({ route, busy, input, answer });
  useEffect(() => {
    interactionRef.current = { route, busy, input, answer };
  }, [route, busy, input, answer]);

  /** 捕获内容 + 用户补充提问，作为动作推断与执行的完整上下文。 */
  const content = useMemo(() => {
    const parts = [capture.trim(), input.trim()].filter(Boolean);
    return parts.join('\n\n');
  }, [capture, input]);

  const homeItems = useMemo<HomeItem[]>(() => [
    ...inferQuickActions(content).map((action) => ({ kind: 'llm' as const, action })),
    { kind: 'search' },
    { kind: 'review' },
    { kind: 'status' },
  ], [content]);

  const isItemDisabled = useCallback(
    (item: HomeItem) => item.kind === 'llm' && !content,
    [content],
  );

  // 当前选中项失效（如清空内容后 LLM 动作被禁用）时，跳到第一个可用项
  useEffect(() => {
    if (route !== 'home') return;
    const item = homeItems[selectedIndex];
    if (!item || isItemDisabled(item)) {
      const first = homeItems.findIndex((candidate) => !isItemDisabled(candidate));
      if (first >= 0 && first !== selectedIndex) setSelectedIndex(first);
    }
  }, [route, homeItems, selectedIndex, isItemDisabled]);

  const notify = useCallback((text: string, kind: NonNullable<Notice>['kind'] = 'info') => {
    setNotice({ text, kind });
  }, []);

  const focusInput = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  const setCaptureFromText = useCallback((raw: string) => {
    const value = raw.trim();
    setCapture(value.slice(0, CAPTURE_LIMIT));
    setCaptureTruncated(value.length > CAPTURE_LIMIT);
    setSelectedIndex(0);
  }, []);

  const loadClipboard = useCallback(async () => {
    const config = await getQuickAssistantConfig();
    if (!config.readClipboard) return;
    // 用户已有进行中的状态（在其他视图 / 正在生成 / 输入过问题）时不打扰，
    // 避免呼出小窗就把上一轮上下文静默替换掉。
    const state = interactionRef.current;
    if (state.route !== 'home' || state.busy || state.input || state.answer) return;
    try {
      const value = (await readText()).trim();
      if (!value || value === lastClipboardRef.current) return;
      lastClipboardRef.current = value;
      if (looksLikeSecret(value)) return;
      setCaptureFromText(value);
    } catch {
      // Clipboard permission may be unavailable on first launch.
    }
  }, [setCaptureFromText]);

  const clearCapture = useCallback(() => {
    setCapture('');
    setCaptureTruncated(false);
    setSelectedIndex(0);
    focusInput();
  }, [focusInput]);

  const goHome = useCallback(() => {
    setRoute('home');
    setAnswer('');
    setSessionId(null);
    setAskedContent('');
    setAskedExpanded(false);
    setNotice(null);
    setSavedKinds(new Set());
    setSearchResults([]);
    setReviewRevealed(false);
    setSelectedIndex(0);
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    void readQuickAssistantPinned().then(setPinned);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen(QUICK_ASSISTANT_SHOWN_EVENT, () => {
      lastShownAtRef.current = Date.now();
      setNotice(null);
      // 窗口常驻复用：每次呼出时重读全局字体/字号/主题/语言，同步主窗口里的最新设置
      void initializeFontSetting();
      syncPreferencesFromStorage();
      void loadClipboard();
      focusInput();
    }).then((fn) => { unlisten = fn; });
    syncPreferencesFromStorage();
    void loadClipboard();
    focusInput();
    return () => unlisten?.();
  }, [loadClipboard, focusInput]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      const focusSettled = Date.now() - lastShownAtRef.current > 350;
      if (!payload && focusSettled && !pinned && !busy) void hideCurrentQuickAssistantWindow();
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [pinned, busy]);

  const actionLabel = useCallback(
    (action: QuickLearningAction) => t(`actions.${action}.label`),
    [t],
  );

  const handleAction = useCallback(async (action: QuickLearningAction) => {
    if (busy) return;
    if (!content) {
      notify(t('messages.need_content'));
      focusInput();
      return;
    }
    setBusy(true);
    setAnswer('');
    setSessionId(null);
    setSavedKinds(new Set());
    setCurrentAction(action);
    setAskedContent(content);
    setAskedExpanded(false);
    setRoute('answer');
    notify(t('messages.working', { action: actionLabel(action) }));
    try {
      const handle = await startQuickLearningAction(content, action, setAnswer);
      runRef.current = handle;
      setSessionId(handle.sessionId);
      const result = await handle.completion;
      setAnswer(result.answer);
      notify(t('messages.done'), 'success');
    } catch (error) {
      const stopped = error instanceof Error && error.name === QUICK_RUN_STOPPED;
      notify(error instanceof Error ? error.message : String(error), stopped ? 'info' : 'error');
    } finally {
      runRef.current = null;
      setBusy(false);
    }
  }, [busy, content, focusInput, notify, t, actionLabel]);

  const runSearch = useCallback(async (query: string) => {
    if (query.trim().length < 2 || busy) return;
    setBusy(true);
    notify(t('search.searching'));
    try {
      const results = await searchLearningHistory(query);
      setSearchResults(results);
      if (results.length) {
        notify(t('search.found', { count: results.length }), 'success');
      } else {
        notify(t('search.none'));
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, notify, t]);

  // 搜索视图输入防抖自动查询（Enter 仍可立即触发）
  useEffect(() => {
    if (route !== 'search') return;
    const value = input.trim();
    if (value.length < 2) return;
    const timer = window.setTimeout(() => { void runSearch(value); }, 350);
    return () => window.clearTimeout(timer);
  }, [route, input, runSearch]);

  const openReview = useCallback(async () => {
    setRoute('review');
    setNotice(null);
    setBusy(true);
    try {
      setReview(await getQuickReviewSnapshot());
      setReviewRevealed(false);
      setReviewStartedAt(Date.now());
    } finally {
      setBusy(false);
    }
  }, []);

  const openStatus = useCallback(async () => {
    setRoute('status');
    setNotice(null);
    setBusy(true);
    try {
      setTodoSummary(await getActiveTodoSummary());
    } finally {
      setBusy(false);
    }
  }, []);

  const executeItem = useCallback((item: HomeItem) => {
    if (item.kind === 'llm') {
      void handleAction(item.action);
      return;
    }
    if (item.kind === 'search') {
      setRoute('search');
      setSearchResults([]);
      setNotice(null);
      focusInput();
      if (input.trim().length >= 2) void runSearch(input);
      return;
    }
    if (item.kind === 'review') void openReview();
    if (item.kind === 'status') void openStatus();
  }, [handleAction, focusInput, input, runSearch, openReview, openStatus]);

  const handleEscape = useCallback(() => {
    if (busy && runRef.current) {
      runRef.current.cancel();
      return;
    }
    if (route !== 'home') {
      goHome();
      return;
    }
    void hideCurrentQuickAssistantWindow();
  }, [busy, route, goHome]);

  const moveSelection = useCallback((direction: 1 | -1) => {
    setSelectedIndex((value) => {
      const length = homeItems.length;
      for (let step = 1; step <= length; step++) {
        const next = (((value + direction * step) % length) + length) % length;
        if (!isItemDisabled(homeItems[next])) return next;
      }
      return value;
    });
  }, [homeItems, isItemDisabled]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeEvent(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        handleEscape();
        return;
      }
      if (route === 'home') {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveSelection(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveSelection(-1);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          const item = homeItems[selectedIndex] ?? homeItems[0];
          if (isItemDisabled(item)) {
            notify(t('messages.need_content'));
            return;
          }
          executeItem(item);
          return;
        }
        if (event.key === 'Backspace' && !input && capture) {
          event.preventDefault();
          clearCapture();
        }
        return;
      }
      if (route === 'search' && event.key === 'Enter') {
        event.preventDefault();
        void runSearch(input);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [route, homeItems, selectedIndex, input, capture, executeItem, handleEscape, clearCapture, runSearch, moveSelection, isItemDisabled, notify, t]);

  const handlePaste = useCallback(async (event: React.ClipboardEvent<HTMLInputElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      setBusy(true);
      notify(t('messages.ocr_running'));
      try {
        const dataUrl = await imageFileToDataUrl(image);
        const text = await performImageOcr(dataUrl);
        if (text) {
          setCaptureFromText(text);
          lastClipboardRef.current = text;
        }
        if (text) {
          notify(t('messages.ocr_done'), 'success');
        } else {
          notify(t('messages.ocr_empty'));
        }
      } catch (error) {
        notify(String(error), 'error');
      } finally {
        setBusy(false);
      }
      return;
    }
    const text = event.clipboardData.getData('text/plain');
    if (route === 'home' && isCaptureLikeText(text)) {
      // 学习材料进捕获区，输入框留给用户自己的问题。
      event.preventDefault();
      setCaptureFromText(text);
      lastClipboardRef.current = text.trim();
    }
  }, [route, notify, t, setCaptureFromText]);

  const handleSave = useCallback(async (kind: SaveKind) => {
    const source = askedContent || content;
    if (!source || busy || savedKinds.has(kind)) return;
    const target = t(`answer.${kind}`);
    setBusy(true);
    notify(t('messages.saving', { target }));
    try {
      if (kind === 'note') await saveAsNote(source, answer);
      if (kind === 'mistake') await saveAsMistake(source, answer);
      if (kind === 'card') await saveAsCard(source, answer);
      if (kind === 'todo') await saveAsTodo(source, answer);
      setSavedKinds((prev) => new Set(prev).add(kind));
      notify(t('messages.saved', { target }), 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }, [askedContent, content, answer, busy, savedKinds, notify, t]);

  const handleCopyAnswer = useCallback(async () => {
    if (!answer) return;
    try {
      await writeText(answer);
      lastClipboardRef.current = answer;
      notify(t('messages.copied'), 'success');
    } catch {
      notify(t('messages.copy_failed'), 'error');
    }
  }, [answer, notify, t]);

  const togglePinned = useCallback(() => {
    setPinned((value) => {
      void saveQuickAssistantPinned(!value);
      return !value;
    });
  }, []);

  const rateCard = useCallback(async (rating: number) => {
    if (!review?.card) return;
    setBusy(true);
    try {
      await rateQuickReviewCard(review.card.id, rating, Date.now() - reviewStartedAt);
      setReview(await getQuickReviewSnapshot());
      setReviewRevealed(false);
      setReviewStartedAt(Date.now());
      notify(t('review.rated'), 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }, [review, reviewStartedAt, notify, t]);

  const footerHint = useMemo(() => {
    if (notice) return notice.text;
    if (route === 'home') return t('footer.home');
    if (route === 'answer' && busy) return t('footer.answer_busy');
    return t('footer.back');
  }, [notice, route, busy, t]);

  const backButton = (
    <button className="qa-back" onClick={goHome}>
      <CaretLeft size={14} />{t('common:back', '返回')}
    </button>
  );

  const activeItem = homeItems[selectedIndex];
  const activeDescendant = route === 'home' && activeItem ? `qa-opt-${homeItemKey(activeItem)}` : undefined;
  const overdueIds = useMemo(
    () => new Set((todoSummary?.overdueItems ?? []).map((item) => item.id)),
    [todoSummary],
  );
  const saveButtons: Array<{ kind: SaveKind; icon: Icon }> = [
    { kind: 'note', icon: NotePencil },
    { kind: 'mistake', icon: FileMagnifyingGlass },
    { kind: 'card', icon: Stack },
    { kind: 'todo', icon: Check },
  ];

  return (
    <main className="qa-shell">
      <header className="qa-titlebar" data-tauri-drag-region>
        <div className="qa-brand" data-tauri-drag-region>
          <span className="qa-brand-mark"><Brain size={16} weight="fill" /></span>
          <span data-tauri-drag-region>{t('title')}</span>
        </div>
        <div className="qa-window-actions">
          <button
            className={cn('qa-icon-button', pinned && 'is-active')}
            onClick={togglePinned}
            title={pinned ? t('window.unpin') : t('window.pin')}
            aria-label={pinned ? t('window.unpin') : t('window.pin')}
          >
            {pinned ? <PushPinSlash size={15} /> : <PushPin size={15} />}
          </button>
          <button
            className="qa-icon-button"
            onClick={() => void hideCurrentQuickAssistantWindow()}
            title={t('window.hide')}
            aria-label={t('window.hide')}
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {route === 'home' && (
        <section className="qa-content qa-home">
          <div className="qa-input-row">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => { setInput(event.target.value); setSelectedIndex(0); }}
              onPaste={(event) => void handlePaste(event)}
              placeholder={capture ? t('input.placeholder_with_capture') : t('input.placeholder')}
              className="qa-input"
              spellCheck={false}
              aria-controls="qa-menu"
              aria-activedescendant={activeDescendant}
            />
          </div>

          {capture && (
            <div className="qa-capture-chip">
              <span className="qa-capture-icon"><ClipboardText size={14} /></span>
              <span className="qa-capture-text">{capture}</span>
              <span className="qa-capture-count">
                {t(captureTruncated ? 'capture.chars_truncated' : 'capture.chars', { count: capture.length.toLocaleString() })}
              </span>
              <button className="qa-capture-clear" onClick={clearCapture} title={t('capture.clear')} aria-label={t('capture.clear')}>
                <X size={13} />
              </button>
            </div>
          )}

          <div className="qa-menu" id="qa-menu" role="listbox" aria-label={t('menu.aria_label')}>
            {homeItems.map((item, index) => {
              const key = homeItemKey(item);
              const label = item.kind === 'llm' ? t(`actions.${item.action}.label`) : t(`features.${item.kind}.label`);
              const hint = item.kind === 'llm' ? t(`actions.${item.action}.hint`) : t(`features.${item.kind}.hint`);
              const IconComponent = item.kind === 'llm' ? ACTION_ICONS[item.action] : FEATURE_ICONS[item.kind];
              const disabled = isItemDisabled(item);
              return (
                <React.Fragment key={key}>
                  {index === 3 && <div className="qa-menu-divider" />}
                  <button
                    id={`qa-opt-${key}`}
                    className={cn('qa-menu-item', index === selectedIndex && 'is-active', disabled && 'is-dim')}
                    role="option"
                    aria-selected={index === selectedIndex}
                    aria-disabled={disabled || undefined}
                    onMouseMove={() => setSelectedIndex((value) => (value === index ? value : index))}
                    onClick={() => {
                      if (disabled) {
                        notify(t('messages.need_content'));
                        focusInput();
                        return;
                      }
                      executeItem(item);
                    }}
                  >
                    <span className="qa-menu-icon"><IconComponent size={16} /></span>
                    <span className="qa-menu-copy">
                      <strong>{label}</strong>
                      <small>{hint}</small>
                    </span>
                    {item.kind === 'llm' && index === 0 && Boolean(content) && (
                      <span className="qa-menu-badge">{t('menu.recommended')}</span>
                    )}
                    {index === selectedIndex && <span className="qa-menu-enter">↵</span>}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </section>
      )}

      {route === 'answer' && (
        <section className="qa-content qa-answer-view">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">{actionLabel(currentAction)}</span>
            <button
              className="qa-icon-button"
              onClick={() => void handleCopyAnswer()}
              disabled={!answer}
              title={t('answer.copy')}
              aria-label={t('answer.copy')}
            >
              <CopySimple size={15} />
            </button>
          </div>
          {askedContent && (
            <button
              type="button"
              className={cn('qa-asked', askedExpanded && 'is-expanded')}
              onClick={() => setAskedExpanded((value) => !value)}
              title={t('asked.toggle')}
            >
              {askedContent}
            </button>
          )}
          <article className="qa-answer" aria-live="polite">
            {answer
              ? <QuickMarkdown content={answer} />
              : <div className="qa-loading"><SpinnerGap size={17} className="qa-spin" />{t('answer.thinking')}</div>}
          </article>
          {answer && !busy && (
            <div className="qa-save-row">
              <span>{t('answer.save_to')}</span>
              {saveButtons.map(({ kind, icon: SaveIcon }) => {
                const saved = savedKinds.has(kind);
                return (
                  <button
                    key={kind}
                    className={cn(saved && 'is-saved')}
                    disabled={saved}
                    onClick={() => void handleSave(kind)}
                  >
                    {saved ? <Check size={14} /> : <SaveIcon size={14} />}
                    {t(`answer.${kind}`)}
                  </button>
                );
              })}
              {sessionId && (
                <button className="qa-continue" onClick={() => void openQuickAssistantTarget({ kind: 'session', id: sessionId })}>
                  {t('answer.continue_in_main')}<ArrowRight size={14} />
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {route === 'search' && (
        <section className="qa-content qa-search-view">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">{t('search.title')}</span>
          </div>
          <div className="qa-input-row">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('input.search_placeholder')}
              className="qa-input"
              spellCheck={false}
            />
          </div>
          <div className="qa-results">
            {searchResults.map((result) => (
              <button
                key={`${result.kind}-${result.id}`}
                className="qa-result"
                onClick={() => void openQuickAssistantTarget(
                  result.kind === 'resource'
                    ? { kind: 'resource', id: result.id, path: result.path }
                    : { kind: 'session', id: result.id },
                )}
              >
                <span className="qa-result-icon">{result.kind === 'resource' ? <NotePencil size={16} /> : <Brain size={16} />}</span>
                <span className="qa-result-copy"><strong>{result.title}</strong><small>{stripSnippetHtml(result.snippet)}</small></span>
                <ArrowRight size={15} />
              </button>
            ))}
            {!searchResults.length && !busy && (
              <div className="qa-empty"><MagnifyingGlass size={22} /><span>{t('search.empty')}</span></div>
            )}
          </div>
        </section>
      )}

      {route === 'review' && (
        <section className="qa-content qa-review">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">{t('review.title')}</span>
            {review && review.dueCount > 0 && (
              <span className="qa-subhead-meta">
                {t('review.remaining', { count: review.dueCount >= 50 ? '50+' : review.dueCount })}
              </span>
            )}
          </div>
          {busy ? <div className="qa-empty"><SpinnerGap size={22} className="qa-spin" />{t('review.preparing')}</div> : review?.card ? (
            <>
              <div className="qa-review-front">{review.card.front || review.card.text || t('review.unnamed')}</div>
              {reviewRevealed ? (
                <>
                  <div className="qa-review-back">{review.card.back || t('review.no_answer')}</div>
                  <div className="qa-rating-row">
                    <button data-rating="1" onClick={() => void rateCard(1)}>{t('review.again')}</button>
                    <button data-rating="2" onClick={() => void rateCard(2)}>{t('review.hard')}</button>
                    <button data-rating="3" onClick={() => void rateCard(3)}>{t('review.good')}</button>
                    <button data-rating="4" onClick={() => void rateCard(4)}>{t('review.easy')}</button>
                  </div>
                </>
              ) : <button className="qa-primary-button" onClick={() => setReviewRevealed(true)}>{t('review.show_answer')}</button>}
            </>
          ) : (
            <div className="qa-empty">
              <Check size={28} weight="bold" />
              <strong>{t('review.done_title')}</strong>
              <span>{t('review.done_subtitle')}</span>
            </div>
          )}
        </section>
      )}

      {route === 'status' && (
        <section className="qa-content qa-status">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">{t('status.title')}</span>
          </div>
          <div className="qa-status-grid">
            <div><span>{t('status.pending')}</span><strong>{todoSummary?.stats.totalPending ?? 0}</strong></div>
            <div><span>{t('status.today_due')}</span><strong>{todoSummary?.stats.todayDue ?? 0}</strong></div>
            <div className={cn((todoSummary?.stats.overdueCount ?? 0) > 0 && 'is-alert')}>
              <span>{t('status.overdue')}</span><strong>{todoSummary?.stats.overdueCount ?? 0}</strong>
            </div>
            <div><span>{t('status.today_completed')}</span><strong>{todoSummary?.stats.todayCompleted ?? 0}</strong></div>
          </div>
          <div className="qa-status-list">
            {[...(todoSummary?.overdueItems ?? []), ...(todoSummary?.todayItems ?? [])].slice(0, 5).map((item) => (
              <div key={item.id} className={cn(overdueIds.has(item.id) && 'is-overdue')}>
                <span>{item.title}</span><small>{item.listTitle}</small>
              </div>
            ))}
          </div>
          <button className="qa-primary-button" onClick={() => void openQuickAssistantTarget({ kind: 'view', view: 'todo' })}>
            {t('status.open_plan')}<ArrowRight size={15} />
          </button>
        </section>
      )}

      <footer className="qa-footer">
        <span className={cn(notice?.kind === 'error' && 'is-error', notice?.kind === 'success' && 'is-success')}>
          {busy && <SpinnerGap size={12} className="qa-spin" />}{footerHint}
        </span>
      </footer>
    </main>
  );
};

export default QuickAssistantWindow;
