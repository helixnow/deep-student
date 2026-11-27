import '@/styles/tailwind.css';
import '@/styles/shadcn-variables.css';
import '@/styles/theme-colors.css';
import '@/styles/typography.css';
import '@/features/workbench/styles/workbench.css';
import '@/i18n';
import './quick-assistant.css';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Brain,
  CaretLeft,
  Cards,
  ChatCircleText,
  Check,
  CheckSquare,
  ClipboardText,
  CopySimple,
  FileMagnifyingGlass,
  Lightbulb,
  MagnifyingGlass,
  NotePencil,
  PushPin,
  PushPinSlash,
  SpinnerGap,
  Stack,
  Translate,
  X,
  XCircle,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import useTheme from '@/hooks/useTheme';
import { initializeFontSetting } from '@/hooks/useAppInitialization';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import { isMacOS } from '@/utils/platform';
import { isTauriRuntime } from '@/utils/shared';
import { syncNativeWindowAppearance } from '@/utils/sidebarTranslucency';
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
  saveAsCard,
  saveAsMistake,
  saveAsNote,
  saveAsTodo,
  searchLearningHistory,
  shouldAutoCaptureClipboard,
  startQuickLearningAction,
  type QuickLearningAction,
  type QuickRunHandle,
  type QuickSearchResult,
} from './service';
import QuickMarkdown from './QuickMarkdown';
import {
  QUICK_ASSISTANT_SHOWN_EVENT,
  hideCurrentQuickAssistantWindow,
  openQuickAssistantTarget,
} from './window';

type Route = 'home' | 'answer' | 'search';
type SaveKind = 'note' | 'mistake' | 'card' | 'todo';
type QuickCaptureKind = 'note' | 'todo';
type Notice = { text: string; kind: 'info' | 'success' | 'error' } | null;

const CAPTURE_LIMIT = 20_000;
const INLINE_SEARCH_LIMIT = 3;

/**
 * macOS 下建窗时已挂载原生玻璃材质，WebView 侧叠低不透明 tint；
 * 其他平台无原生材质，保持近实心面板。
 */
const NATIVE_GLASS = isTauriRuntime && isMacOS();

const ACTION_ICONS: Record<QuickLearningAction, Icon> = {
  ask: ChatCircleText,
  explain: Brain,
  translate: Translate,
  summarize: Stack,
  hint: Lightbulb,
};

type HomeItem =
  | { kind: 'attach_clipboard'; group: 'clipboard'; preview: string }
  | { kind: 'llm'; group: 'ai'; action: QuickLearningAction }
  | { kind: 'capture_save'; group: 'capture'; target: QuickCaptureKind }
  | { kind: 'inline_result'; group: 'records'; result: QuickSearchResult }
  | { kind: 'open_search'; group: 'records' }
  | { kind: 'workspace'; group: 'workspace'; target: 'search' | 'flashcards' | 'todo' | 'chat-v2' };

interface WorkspaceBadges {
  dueCards: number;
  todayTodos: number;
}

const THEME_STORAGE_KEYS = {
  mode: 'dstu-theme-mode',
  palette: 'dstu-theme-palette',
  customColor: 'dstu-theme-custom-color',
  glassClarity: 'desktop.workbenchGlassClarity',
} as const;

const DEFAULT_GLASS_CLARITY = 55;

function syncGlassClarityFromStorage(): void {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEYS.glassClarity);
    const parsed = raw !== null && raw.trim() !== '' ? Number(raw) : Number.NaN;
    const clarity = Number.isFinite(parsed)
      ? Math.round(Math.min(100, Math.max(0, parsed)))
      : DEFAULT_GLASS_CLARITY;
    const ratio = Number((clarity / 100).toFixed(2));
    const root = document.documentElement;
    root.style.setProperty('--wb-glass-clarity', String(clarity));
    root.style.setProperty('--wb-glass-clarity-ratio', String(ratio));
  } catch {
    // localStorage 不可用时使用 workbench.tokens.css 默认值
  }
}

/**
 * 主窗口的主题 / 语言修改会落到 localStorage，但自定义事件不跨窗口，
 * 每次呼出时重读存储并广播给本窗口的 useTheme，保持外观一致。
 */
function syncPreferencesFromStorage(): void {
  try {
    const queryTheme = new URLSearchParams(window.location.search).get('theme');
    const mode = queryTheme === 'light' || queryTheme === 'dark'
      ? queryTheme
      : localStorage.getItem(THEME_STORAGE_KEYS.mode);
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
    syncGlassClarityFromStorage();
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

function singleLinePreview(value: string, maxLen = 64): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
}

function isImeEvent(event: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return native.isComposing || event.key === 'Process';
}

function homeItemKey(item: HomeItem): string {
  if (item.kind === 'llm') return `llm-${item.action}`;
  if (item.kind === 'capture_save') return `capture-${item.target}`;
  if (item.kind === 'inline_result') return `rec-${item.result.kind}-${item.result.id}`;
  if (item.kind === 'workspace') return `ws-${item.target}`;
  return item.kind;
}

export const QuickAssistantWindow: React.FC = () => {
  const { isDarkMode } = useTheme();
  const { t } = useTranslation('quickAssistant');
  const [route, setRoute] = useState<Route>('home');
  const [input, setInput] = useState('');
  const [capture, setCapture] = useState('');
  const [captureTruncated, setCaptureTruncated] = useState(false);
  /** 剪贴板里被自动捕获跳过（如路径/URL/短标识符）的候选文本，仅在空态作为可选项提示 */
  const [clipboardCandidate, setClipboardCandidate] = useState('');
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
  const [inlineResults, setInlineResults] = useState<QuickSearchResult[]>([]);
  const [searchResults, setSearchResults] = useState<QuickSearchResult[]>([]);
  const [searchIndex, setSearchIndex] = useState(0);
  const [badges, setBadges] = useState<WorkspaceBadges>({ dueCards: 0, todayTodos: 0 });

  const inputRef = useRef<HTMLInputElement>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const lastShownAtRef = useRef(Date.now());
  const lastClipboardRef = useRef<string | null>(null);
  const runRef = useRef<QuickRunHandle | null>(null);
  const interactionRef = useRef({ route, busy, input, answer });
  useEffect(() => {
    interactionRef.current = { route, busy, input, answer };
  }, [route, busy, input, answer]);

  /** 捕获内容 + 用户补充提问，作为动作推断与执行的完整上下文。 */
  const content = useMemo(() => {
    const parts = [capture.trim(), input.trim()].filter(Boolean);
    return parts.join('\n\n');
  }, [capture, input]);

  const homeItems = useMemo<HomeItem[]>(() => {
    if (content) {
      const items: HomeItem[] = [
        ...inferQuickActions(content).map((action) => ({ kind: 'llm' as const, group: 'ai' as const, action })),
        { kind: 'capture_save', group: 'capture', target: 'note' },
        { kind: 'capture_save', group: 'capture', target: 'todo' },
      ];
      if (inlineResults.length > 0) {
        for (const result of inlineResults.slice(0, INLINE_SEARCH_LIMIT)) {
          items.push({ kind: 'inline_result', group: 'records', result });
        }
        if (inlineResults.length > INLINE_SEARCH_LIMIT) {
          items.push({ kind: 'open_search', group: 'records' });
        }
      }
      return items;
    }

    const items: HomeItem[] = [];
    if (clipboardCandidate) {
      items.push({
        kind: 'attach_clipboard',
        group: 'clipboard',
        preview: singleLinePreview(clipboardCandidate, 44),
      });
    }
    items.push(
      { kind: 'workspace', group: 'workspace', target: 'search' },
      { kind: 'workspace', group: 'workspace', target: 'flashcards' },
      { kind: 'workspace', group: 'workspace', target: 'todo' },
      { kind: 'workspace', group: 'workspace', target: 'chat-v2' },
    );
    return items;
  }, [content, clipboardCandidate, inlineResults]);

  useEffect(() => {
    if (route !== 'home') return;
    if (selectedIndex >= homeItems.length) {
      setSelectedIndex(Math.max(0, homeItems.length - 1));
    }
  }, [route, homeItems.length, selectedIndex]);

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
    setClipboardCandidate('');
    setSelectedIndex(0);
  }, []);

  const refreshWorkspaceBadges = useCallback(async () => {
    try {
      const [reviewSnap, todoSnap] = await Promise.all([
        getQuickReviewSnapshot().catch(() => ({ card: null, dueCount: 0 })),
        getActiveTodoSummary().catch(() => null),
      ]);
      setBadges({
        dueCards: reviewSnap.dueCount,
        todayTodos: (todoSnap?.stats.todayDue ?? 0) + (todoSnap?.stats.overdueCount ?? 0),
      });
    } catch {
      // 静默忽略，仅作为辅助计数
    }
  }, []);

  const loadClipboard = useCallback(async () => {
    const config = await getQuickAssistantConfig();
    if (!config.readClipboard) return;
    const state = interactionRef.current;
    if (state.route !== 'home' || state.busy || state.input || state.answer) return;
    try {
      const value = (await readText()).trim();
      if (!value || value === lastClipboardRef.current) return;
      lastClipboardRef.current = value;
      if (looksLikeSecret(value)) return;
      if (shouldAutoCaptureClipboard(value)) {
        setCaptureFromText(value);
      } else {
        setClipboardCandidate(value.slice(0, CAPTURE_LIMIT));
      }
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
    setSearchIndex(0);
    setSelectedIndex(0);
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    void readQuickAssistantPinned().then(setPinned);
  }, []);

  useEffect(() => {
    if (!NATIVE_GLASS) return;
    document.documentElement.dataset.nativeMaterial = 'true';
    return () => { delete document.documentElement.dataset.nativeMaterial; };
  }, []);

  useEffect(() => {
    if (!NATIVE_GLASS) return;
    void syncNativeWindowAppearance(isDarkMode);
  }, [isDarkMode]);

  const playEnterAnimation = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    shell.classList.remove('is-entering');
    void shell.offsetWidth;
    shell.classList.add('is-entering');
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    playEnterAnimation();
    if (isTauriRuntime) {
      void listen(QUICK_ASSISTANT_SHOWN_EVENT, () => {
        lastShownAtRef.current = Date.now();
        setNotice(null);
        playEnterAnimation();
        void initializeFontSetting();
        syncPreferencesFromStorage();
        void loadClipboard();
        void refreshWorkspaceBadges();
        focusInput();
      }).then((fn) => { unlisten = fn; }).catch(() => {});
    }
    syncPreferencesFromStorage();
    if (isTauriRuntime) {
      void loadClipboard();
      void refreshWorkspaceBadges();
    }
    focusInput();
    return () => unlisten?.();
  }, [loadClipboard, refreshWorkspaceBadges, focusInput, playEnterAnimation]);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten: (() => void) | null = null;
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      const focusSettled = Date.now() - lastShownAtRef.current > 350;
      if (!payload && focusSettled && !pinned && !busy) void hideCurrentQuickAssistantWindow();
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => unlisten?.();
  }, [pinned, busy]);

  // Home 视图输入 ≥2 字时实时就地检索自己的笔记和历史会话
  useEffect(() => {
    if (route !== 'home' || !isTauriRuntime) return;
    const query = input.trim();
    if (query.length < 2) {
      setInlineResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchLearningHistory(query)
        .then((results) => {
          if (!cancelled) setInlineResults(results);
        })
        .catch(() => {
          if (!cancelled) setInlineResults([]);
        });
    }, 260);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [route, input]);

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

  /** 0 延迟速记：不经 AI 直接把当前内容存为笔记或待办 */
  const handleDirectCapture = useCallback(async (target: QuickCaptureKind) => {
    if (busy || !content) return;
    const label = t(`answer.${target}`);
    setBusy(true);
    notify(t('messages.saving', { target: label }));
    try {
      if (target === 'note') await saveAsNote(content, '');
      if (target === 'todo') await saveAsTodo(content, '');
      setInput('');
      setCapture('');
      setCaptureTruncated(false);
      setInlineResults([]);
      setSelectedIndex(0);
      notify(t('messages.saved', { target: label }), 'success');
      void refreshWorkspaceBadges();
      focusInput();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }, [busy, content, t, notify, refreshWorkspaceBadges, focusInput]);

  const runSearch = useCallback(async (query: string) => {
    if (query.trim().length < 2 || busy) return;
    setBusy(true);
    notify(t('search.searching'));
    try {
      const results = await searchLearningHistory(query);
      setSearchResults(results);
      setSearchIndex(0);
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

  useEffect(() => {
    if (route !== 'search') return;
    const value = input.trim();
    if (value.length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = window.setTimeout(() => { void runSearch(value); }, 280);
    return () => window.clearTimeout(timer);
  }, [route, input, runSearch]);

  const openSearchResult = useCallback((result: QuickSearchResult) => {
    void openQuickAssistantTarget(
      result.kind === 'resource'
        ? { kind: 'resource', id: result.id, path: result.path }
        : { kind: 'session', id: result.id },
    );
  }, []);

  const executeItem = useCallback((item: HomeItem) => {
    if (item.kind === 'attach_clipboard') {
      setCaptureFromText(clipboardCandidate);
      focusInput();
      return;
    }
    if (item.kind === 'llm') {
      void handleAction(item.action);
      return;
    }
    if (item.kind === 'capture_save') {
      void handleDirectCapture(item.target);
      return;
    }
    if (item.kind === 'inline_result') {
      openSearchResult(item.result);
      return;
    }
    if (item.kind === 'open_search') {
      setRoute('search');
      setSearchResults(inlineResults);
      setSearchIndex(0);
      setNotice(null);
      focusInput();
      return;
    }
    if (item.kind === 'workspace') {
      if (item.target === 'search') {
        setRoute('search');
        setSearchResults([]);
        setSearchIndex(0);
        setNotice(null);
        focusInput();
        return;
      }
      void openQuickAssistantTarget({ kind: 'view', view: item.target });
    }
  }, [clipboardCandidate, setCaptureFromText, focusInput, handleAction, handleDirectCapture, openSearchResult, inlineResults]);

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
    if (route === 'home') {
      setSelectedIndex((value) => {
        const length = homeItems.length;
        if (length === 0) return 0;
        return (((value + direction) % length) + length) % length;
      });
      return;
    }
    if (route === 'search') {
      setSearchIndex((value) => {
        const length = searchResults.length;
        if (length === 0) return 0;
        return (((value + direction) % length) + length) % length;
      });
    }
  }, [route, homeItems.length, searchResults.length]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
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
        if (item) executeItem(item);
        return;
      }
      if (event.key === 'Backspace' && !input && capture) {
        event.preventDefault();
        clearCapture();
      }
      return;
    }
    if (route === 'search') {
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
        const active = searchResults[searchIndex];
        if (active) {
          openSearchResult(active);
        } else {
          void runSearch(input);
        }
      }
    }
  }, [route, homeItems, selectedIndex, searchResults, searchIndex, input, capture, handleEscape, moveSelection, executeItem, clearCapture, openSearchResult, runSearch]);

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

  const activeItem = homeItems[selectedIndex];
  const activeDescendant = route === 'home' && activeItem ? `qa-opt-${homeItemKey(activeItem)}` : undefined;

  const saveButtons: Array<{ kind: SaveKind; icon: Icon }> = [
    { kind: 'note', icon: NotePencil },
    { kind: 'mistake', icon: FileMagnifyingGlass },
    { kind: 'card', icon: Stack },
    { kind: 'todo', icon: Check },
  ];

  const windowControls = (
    <div className="qa-window-actions">
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        className={cn('qa-icon-button', pinned && 'is-active')}
        onClick={togglePinned}
        title={pinned ? t('window.unpin') : t('window.pin')}
        aria-label={pinned ? t('window.unpin') : t('window.pin')}
      >
        {pinned ? <PushPinSlash size={15} /> : <PushPin size={15} />}
      </DsButton>
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        className="qa-icon-button"
        onClick={() => void hideCurrentQuickAssistantWindow()}
        title={t('window.hide')}
        aria-label={t('window.hide')}
      >
        <X size={15} />
      </DsButton>
    </div>
  );

  const renderGroupLabel = (group: HomeItem['group']) => {
    if (group === 'clipboard') return t('groups.clipboard');
    if (group === 'ai') return t('groups.ai');
    if (group === 'capture') return t('groups.capture');
    if (group === 'records') return t('groups.records');
    return t('groups.workspace');
  };

  const renderItemMeta = (item: HomeItem): { icon: Icon; label: string; hint?: string; trailing?: string } => {
    if (item.kind === 'attach_clipboard') {
      return {
        icon: ClipboardText,
        label: t('clipboard.attach'),
        hint: item.preview,
      };
    }
    if (item.kind === 'llm') {
      return {
        icon: ACTION_ICONS[item.action],
        label: t(`actions.${item.action}.label`),
        hint: t(`actions.${item.action}.hint`),
      };
    }
    if (item.kind === 'capture_save') {
      return {
        icon: item.target === 'note' ? NotePencil : CheckSquare,
        label: t(`quick_capture.${item.target}.label`),
        hint: t(`quick_capture.${item.target}.hint`),
      };
    }
    if (item.kind === 'inline_result') {
      return {
        icon: item.result.kind === 'resource' ? NotePencil : ChatCircleText,
        label: item.result.title,
        hint: stripSnippetHtml(item.result.snippet),
      };
    }
    if (item.kind === 'open_search') {
      return {
        icon: MagnifyingGlass,
        label: t('search.view_all', { count: inlineResults.length }),
      };
    }
    if (item.target === 'search') {
      return {
        icon: MagnifyingGlass,
        label: t('features.search.label'),
        hint: t('features.search.hint'),
      };
    }
    if (item.target === 'flashcards') {
      return {
        icon: Cards,
        label: t('features.review.label'),
        hint: t('features.review.hint'),
        trailing: badges.dueCards > 0
          ? t('review.remaining', { count: badges.dueCards >= 50 ? '50+' : badges.dueCards })
          : undefined,
      };
    }
    if (item.target === 'todo') {
      return {
        icon: CheckSquare,
        label: t('features.status.label'),
        hint: t('features.status.hint'),
        trailing: badges.todayTodos > 0 ? t('status.today_badge', { count: badges.todayTodos }) : undefined,
      };
    }
    return {
      icon: ChatCircleText,
      label: t('features.open_main.label'),
      hint: t('features.open_main.hint'),
    };
  };

  const handleShellPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    if (rect.width <= 0) return;
    const xPct = Math.max(4, Math.min(96, ((event.clientX - rect.left) / rect.width) * 100));
    shell.style.setProperty('--qa-cursor-x', `${xPct.toFixed(1)}%`);
    if (shell.dataset.qaShimmer !== 'true') shell.dataset.qaShimmer = 'true';
  }, []);

  const handleShellPointerLeave = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    delete shell.dataset.qaShimmer;
  }, []);

  return (
    <main
      ref={shellRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onPointerMove={handleShellPointerMove}
      onPointerLeave={handleShellPointerLeave}
      data-tauri-drag-region="deep"
      className="qa-shell wb-glass wb-glass-rim"
    >
      {/* 顶部整宽拖拽把手带（16px）：随手可抓，不增加独立标题栏噪音 */}
      <div className="qa-grabber" data-tauri-drag-region="deep" aria-hidden="true">
        <span className="qa-grabber-pill" />
      </div>

      {/* 顶栏即命令输入条（空白与图标处同样可拖，输入与按钮自动排除） */}
      <header className="qa-topbar" data-tauri-drag-region="deep">
        {route === 'home' && (
          <>
            <MagnifyingGlass size={16} className="qa-topbar-icon" aria-hidden="true" />
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => { setInput(event.target.value); setSelectedIndex(0); }}
              onPaste={(event) => void handlePaste(event)}
              placeholder={capture ? t('input.placeholder_with_capture') : t('input.placeholder')}
              className="qa-input"
              spellCheck={false}
              aria-label={t('title')}
              aria-controls="qa-menu"
              aria-activedescendant={activeDescendant}
            />
            {input && (
              <>
                <DsButton
                  variant="ghost"
                  size="sm"
                  iconOnly
                  className="qa-icon-button"
                  onClick={() => { setInput(''); setSelectedIndex(0); focusInput(); }}
                  title={t('input.clear')}
                  aria-label={t('input.clear')}
                >
                  <XCircle size={15} weight="fill" />
                </DsButton>
                <span className="qa-topbar-divider" aria-hidden="true" />
              </>
            )}
          </>
        )}

        {route === 'search' && (
          <>
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              className="qa-icon-button"
              onClick={goHome}
              title={t('common:back', '返回')}
              aria-label={t('common:back', '返回')}
            >
              <CaretLeft size={16} />
            </DsButton>
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => { setInput(event.target.value); setSearchIndex(0); }}
              placeholder={t('input.search_placeholder')}
              className="qa-input"
              spellCheck={false}
              aria-label={t('search.title')}
            />
          </>
        )}

        {route === 'answer' && (
          <>
            <DsButton
              variant="ghost"
              size="sm"
              className="qa-back"
              onClick={goHome}
            >
              <CaretLeft size={15} />
              <span>{actionLabel(currentAction)}</span>
            </DsButton>
            <div className="qa-topbar-spacer" data-tauri-drag-region="deep" />
            <DsButton
              variant="ghost"
              size="sm"
              iconOnly
              className="qa-icon-button"
              onClick={() => void handleCopyAnswer()}
              disabled={!answer}
              title={t('answer.copy')}
              aria-label={t('answer.copy')}
            >
              <CopySimple size={15} />
            </DsButton>
          </>
        )}

        {windowControls}
      </header>

      {route === 'home' && (
        <section className="qa-body">
          {capture && (
            <div className="qa-context-strip" data-tauri-drag-region="false">
              <ClipboardText size={13} className="qa-context-icon" aria-hidden="true" />
              <span className="qa-context-text">{singleLinePreview(capture, 96)}</span>
              <span className="qa-context-count">
                {t(captureTruncated ? 'capture.chars_truncated' : 'capture.chars', { count: capture.length.toLocaleString() })}
              </span>
              <DsButton
                variant="ghost"
                size="sm"
                iconOnly
                className="qa-context-clear"
                onClick={clearCapture}
                title={t('capture.clear')}
                aria-label={t('capture.clear')}
              >
                <X size={12} />
              </DsButton>
            </div>
          )}

          <div className="qa-menu" id="qa-menu" role="listbox" aria-label={t('menu.aria_label')}>
            {homeItems.map((item, index) => {
              const key = homeItemKey(item);
              const prev = homeItems[index - 1];
              const showGroup = !prev || prev.group !== item.group;
              const active = index === selectedIndex;
              const { icon: IconComponent, label, hint, trailing } = renderItemMeta(item);
              return (
                <React.Fragment key={key}>
                  {showGroup && (
                    <div className={cn('qa-group-label', index > 0 && 'has-gap')}>
                      {renderGroupLabel(item.group)}
                    </div>
                  )}
                  <div
                    id={`qa-opt-${key}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={active}
                    className={cn('qa-row', active && 'is-active')}
                    onMouseMove={() => setSelectedIndex((value) => (value === index ? value : index))}
                    onClick={() => executeItem(item)}
                  >
                    <IconComponent size={15} className="qa-row-icon" aria-hidden="true" />
                    <span className="qa-row-main">
                      <span className="qa-row-label">{label}</span>
                      {hint && <span className="qa-row-hint">{hint}</span>}
                    </span>
                    {trailing && <span className="qa-row-meta">{trailing}</span>}
                    {active && <span className="qa-row-enter" aria-hidden="true">↵</span>}
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </section>
      )}

      {route === 'answer' && (
        <section className="qa-body qa-answer-view">
          {askedContent && (
            <div
              role="button"
              tabIndex={0}
              className={cn('qa-asked', askedExpanded && 'is-expanded')}
              onClick={() => setAskedExpanded((value) => !value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setAskedExpanded((value) => !value);
                }
              }}
              title={t('asked.toggle')}
            >
              {askedContent}
            </div>
          )}
          <article className="qa-answer" aria-live="polite" data-tauri-drag-region="false">
            {answer
              ? <QuickMarkdown content={answer} />
              : <div className="qa-loading"><SpinnerGap size={15} className="qa-spin" /><span>{t('answer.thinking')}</span></div>}
          </article>
          {answer && !busy && (
            <div className="qa-save-bar">
              <span className="qa-save-label">{t('answer.save_to')}</span>
              {saveButtons.map(({ kind, icon: SaveIcon }) => {
                const saved = savedKinds.has(kind);
                return (
                  <DsButton
                    key={kind}
                    variant="ghost"
                    size="sm"
                    className={cn('qa-save-btn', saved && 'is-saved')}
                    disabled={saved}
                    onClick={() => void handleSave(kind)}
                  >
                    {saved ? <Check size={13} /> : <SaveIcon size={13} />}
                    <span>{t(`answer.${kind}`)}</span>
                  </DsButton>
                );
              })}
              {sessionId && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="qa-continue-btn"
                  onClick={() => void openQuickAssistantTarget({ kind: 'session', id: sessionId })}
                >
                  <span>{t('answer.continue_in_main')}</span>
                  <ArrowRight size={13} />
                </DsButton>
              )}
            </div>
          )}
        </section>
      )}

      {route === 'search' && (
        <section className="qa-body">
          <div className="qa-menu" role="listbox" aria-label={t('search.title')}>
            {searchResults.map((result, index) => {
              const active = index === searchIndex;
              return (
                <div
                  key={`${result.kind}-${result.id}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={active}
                  className={cn('qa-row', active && 'is-active')}
                  onMouseMove={() => setSearchIndex((value) => (value === index ? value : index))}
                  onClick={() => openSearchResult(result)}
                >
                  {result.kind === 'resource'
                    ? <NotePencil size={15} className="qa-row-icon" aria-hidden="true" />
                    : <ChatCircleText size={15} className="qa-row-icon" aria-hidden="true" />}
                  <span className="qa-row-main">
                    <span className="qa-row-label">{result.title}</span>
                    <span className="qa-row-hint">{stripSnippetHtml(result.snippet)}</span>
                  </span>
                  {active && <span className="qa-row-enter" aria-hidden="true">↵</span>}
                </div>
              );
            })}
            {!searchResults.length && !busy && (
              <div className="qa-empty">
                <span>{input.trim().length >= 2 ? t('search.none') : t('search.empty')}</span>
              </div>
            )}
          </div>
        </section>
      )}

      <footer className="qa-footer">
        <span className={cn('qa-footer-status', notice?.kind === 'error' && 'is-error', notice?.kind === 'success' && 'is-success')}>
          {busy && <SpinnerGap size={12} className="qa-spin" />}
          {notice?.text ?? ''}
        </span>
        <span className="qa-footer-keys" aria-hidden="true">
          {route === 'home' ? (
            <>
              <kbd>↑↓</kbd><span>{t('footer.select')}</span>
              <kbd>↵</kbd><span>{t('footer.run')}</span>
              <kbd>Esc</kbd><span>{t('footer.hide')}</span>
            </>
          ) : route === 'answer' && busy ? (
            <>
              <kbd>Esc</kbd><span>{t('footer.stop')}</span>
            </>
          ) : (
            <>
              <kbd>Esc</kbd><span>{t('footer.back_short')}</span>
            </>
          )}
        </span>
      </footer>
    </main>
  );
};

export default QuickAssistantWindow;
