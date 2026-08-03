/**
 * 笔记模块 Crepe 编辑器
 * 基于 @milkdown/crepe 的 Markdown 编辑器
 * 
 * 功能：
 * - 自动保存
 * - 笔记资产管理（图片上传）
 * - 与 NotesContext 集成
 * - Find & Replace
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass, FilePlus, FolderPlus, GitDiff, ImageSquare, BookOpen, PencilLine, Robot, ArrowCounterClockwise, X, CircleNotch, WarningCircle, CornersIn, CornersOut, NoteBlank } from '@phosphor-icons/react';
import { COMMAND_EVENTS } from '@/command-palette';
import { CrepeEditor, type CrepeEditorApi } from '@/components/crepe';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { shouldRequestLoadMore, type MarkdownLoadMoreResult } from '@/features/notes/markdownWindow';
import { useNotesOptional } from './NotesContext';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { DsButton } from '@/components/ui/DsButton';
import { NotesEditorHeader } from './components/NotesEditorHeader';
import { NotesEditorToolbar } from './components/NotesEditorToolbar';
import {
  MobileEditorToolbar,
  type MobileEditorToolbarActiveStates,
} from './components/MobileEditorToolbar';
import { FindReplacePanel } from './components/FindReplacePanel';
import {
  consumeNotesFindQuery,
  NOTES_FIND_QUERY_EVENT,
  type NotesFindQuery,
} from './findQueryBridge';
import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../../debug-panel/events/NotesOutlineDebugChannel';
import { isMacOS } from '../../utils/platform';
import { useTauriDragAndDrop } from '../../hooks/useTauriDragAndDrop';
import { useCanvasAIEditHandler } from './hooks/useCanvasAIEditHandler';
import { computeDiffLines } from './hooks/useAIEditState';
import { AIDiffPanel, DiffHunksView } from './AIDiffPanel';
import { dstu } from '@/dstu';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { registerContentDirtyChecker } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { buildMobileEditorCommands } from './mobileEditorCommands';
import { parseWorkbenchDragData, WB_RESOURCE_MIME } from '@/features/workbench/hooks/useDesktopDrop';
import { insertWikilink } from '@/components/crepe/plugins/wikilink/autocomplete';
import { editorViewCtx } from '@milkdown/kit/core';
import { openQuickAssistantWindow } from '@/quick-assistant/window';
import {
  consumeNotesHeadingTarget,
  NOTES_HEADING_TARGET_EVENT,
  notesHeadingTargetMatches,
  type NotesHeadingTarget,
} from './headingTargetBridge';
import {
  CREATE_FROM_WIKILINK_EVENT,
  createNoteFromWikilinkTitle,
  parseCreateFromWikilinkEvent,
  refreshWikilinksAfterCreate,
} from './createFromWikilink';
import {
  buildWikilinkPluginHostConfig,
  refreshWikilinkNotesCache,
} from './wikilinkNotesCache';
import '@/styles/notes-typography.css';
import './styles/notes-editor-chrome.css';
import { applyNoteTemplate } from './noteTemplates';
import { NotesTemplatePanel } from './components/NotesTemplatePanel';
import { dispatchTypedEvent } from '@/events/registry';
import {
  NOTES_ACTIVE_HEADING_EVENT,
  normalizeActiveHeadingText,
  type NotesActiveHeadingDetail,
} from './components/outlineActiveHeadingBridge';
import type { NotesFocusModeEventDetail } from './focusModeOwnership';

const AUTO_SAVE_DEBOUNCE_MS = 1500;
const SAVING_INDICATOR_DELAY_MS = 400;
/** 焦点模式 chrome 淡出/淡入时长（与 notes-editor-chrome.css 的过渡对齐） */
const FOCUS_CHROME_TRANSITION_MS = 200;

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 与后端 dstu_update 的 MAX_CONTENT_SIZE 保持一致（1MB） */
const MAX_NOTE_CONTENT_BYTES = 1024 * 1024;

/** 字数统计：非空白字符数（中文场景下与用户"字数"心智一致） */
const countNoteChars = (markdown: string): number => markdown.replace(/\s/g, '').length;

// ── 移动端底部工具条单实例门控 ──
// 多个可见编辑器实例（分屏/多面板）各自 portal 一条 fixed 工具条到 body，
// 会互相覆写 :root 上的 --mobile-toolbar-* 变量且命令指向非用户正在编辑的实例。
// 以"最近交互（focusin/pointerdown）"的实例为唯一持有者，只渲染一条。
let mobileToolbarOwnerId: string | null = null;
const mobileToolbarOwnerListeners = new Set<() => void>();
const notifyMobileToolbarOwnerChange = () => {
  mobileToolbarOwnerListeners.forEach((fn) => fn());
};
const claimMobileToolbarOwner = (id: string) => {
  if (mobileToolbarOwnerId === id) return;
  mobileToolbarOwnerId = id;
  notifyMobileToolbarOwnerChange();
};
const releaseMobileToolbarOwner = (id: string) => {
  if (mobileToolbarOwnerId !== id) return;
  mobileToolbarOwnerId = null;
  notifyMobileToolbarOwnerChange();
};
const subscribeMobileToolbarOwner = (fn: () => void) => {
  mobileToolbarOwnerListeners.add(fn);
  return () => {
    mobileToolbarOwnerListeners.delete(fn);
  };
};
const getMobileToolbarOwner = () => mobileToolbarOwnerId;

type PendingSavePayload = {
  noteId: string;
  content: string;
};

export type NotesEditorWindowingState = {
  enabled: boolean;
  loadedLineCount: number;
  totalLineCount: number;
  hasMore: boolean;
  isLoadingMore?: boolean;
  loadMoreError?: string | null;
  preloadPx?: number;
};

// ========== DSTU 模式 Props ==========
export interface NotesCrepeEditorProps {
  /** DSTU 模式：初始内容 */
  initialContent?: string;
  /** DSTU 模式：初始标题 */
  initialTitle?: string;
  /** DSTU 模式：保存回调 */
  onSave?: (content: string) => Promise<void>;
  /** DSTU 模式：标题变更回调 */
  onTitleChange?: (title: string) => Promise<void>;
  /** DSTU 模式：笔记 ID（用于事件标识） */
  noteId?: string;
  /** 是否只读 */
  readOnly?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 编辑器操作栏右侧的宿主应用动作（如属性/大纲入口） */
  headerActions?: React.ReactNode;
  /** 编辑器实例变化回调（创建/销毁） */
  onEditorReady?: (api: CrepeEditorApi | null) => void;
  /**
   * ACR R1-13：编辑器 API 就绪/销毁回调（供 workbench noteDriver 注册表）。
   * 与 onEditorReady 并行，互不影响既有 Learning Hub / Context 路径。
   */
  onEditorApiReady?: (api: CrepeEditorApi | null, previousApi?: CrepeEditorApi) => void;
  /** Optional save-state bridge for owning tab strips. */
  onSaveStateChange?: (state: 'saved' | 'saving' | 'dirty') => void;
  /**
   * ACR R1-13：存在时把 isCurrentNoteDirty 挂到 contentDirtyRegistry，
   * 供 probe / canClose 查询（typeId + instanceKey = 资源 id）。
   */
  dirtyRegistryKey?: { typeId: string; instanceKey: string };
  /** Exact Workbench window for local ACR suggestion routing. */
  acrWindowId?: string;
  /** Focus-mode events affect only this owning Notes workspace. */
  focusModeScopeId?: string;
  windowingState?: NotesEditorWindowingState;
  onRequestLoadMore?: (currentMarkdown: string) => Promise<MarkdownLoadMoreResult | null | void>;
  onRetryLoadMore?: () => void;
  /** P1-10：DSTU 模式标签（透传给标题下方的内联标签行） */
  tags?: string[];
  /** P1-10：DSTU 模式标签变更回调 */
  onTagsChange?: (tags: string[]) => Promise<void> | void;
  /**
   * 移动端底部工具条挂在 body（fixed 全宽），侧栏抽屉打开时会盖住抽屉底部
   * 且按钮仍指向编辑器；宿主（NotesHome）在抽屉打开期间置 true 暂时隐藏。
   */
  suppressMobileToolbar?: boolean;
}

export const NotesCrepeEditor: React.FC<NotesCrepeEditorProps> = ({
  initialContent,
  initialTitle,
  onSave: dstuOnSave,
  onTitleChange: dstuOnTitleChange,
  noteId: dstuNoteId,
  readOnly = false,
  className,
  headerActions,
  onEditorReady,
  onEditorApiReady,
  onSaveStateChange,
  dirtyRegistryKey,
  acrWindowId,
  focusModeScopeId,
  windowingState,
  onRequestLoadMore,
  onRetryLoadMore,
  tags,
  onTagsChange,
  suppressMobileToolbar = false,
}) => {
  const { t, i18n } = useTranslation(['notes', 'common']);
  
  // ========== 模式判断 ==========
  // DSTU 模式：通过 props 传入数据
  // Context 模式：通过 NotesContext 获取数据
  const isDstuMode = initialContent !== undefined;
  
  // ========== Context 获取（可选） ==========
  const notesContext = useNotesOptional();
  const contextActive = notesContext?.active;
  const saveNoteContent = notesContext?.saveNoteContent;
  const createNote = notesContext?.createNote;
  const createFolder = notesContext?.createFolder;
  const loadedContentIds = notesContext?.loadedContentIds ?? new Set<string>();
  const setEditor = notesContext?.setEditor;
  const setSidebarRevealId = notesContext?.setSidebarRevealId;

  // ========== 根据模式选择数据源 ==========
  const active = isDstuMode ? null : contextActive;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<string>('');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [editorApi, setEditorApi] = useState<CrepeEditorApi | null>(null);
  const lifecycleApiRef = useRef<CrepeEditorApi | null>(null);
  const pendingSaveQueueRef = useRef<PendingSavePayload[]>([]);
  const inFlightSaveRef = useRef<Promise<void> | null>(null);
  const activeSavePayloadRef = useRef<PendingSavePayload | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  /** 当前笔记草稿是否与上次成功保存快照不同 */
  const [isDirty, setIsDirty] = useState(false);
  /** 最近一次放弃重试后的保存错误（冲突 / 失败） */
  const [saveError, setSaveError] = useState<'failed' | 'conflict' | null>(null);
  /**
   * 保存冲突上下文。mineContent 在事件到达时同步快照自 contentRef
   * （事件派发早于发起方的强制远端刷新，此刻编辑器里仍是用户版本）；
   * serverContent 为发起方随事件带来的远端胜出版本（旧发起方无此字段时
   * 「对比」降级为 dstu.getContent 拉取磁盘最新内容）。
   */
  const [conflictAction, setConflictAction] = useState<null | {
    restoreMine: () => void;
    mineContent: string;
    serverContent?: string;
  }>(null);
  /** 冲突「对比」内联 diff 区展开态（grid-rows 0fr→1fr） */
  const [conflictDiffOpen, setConflictDiffOpen] = useState(false);
  /** 降级拉取到的远端内容（payload 无 serverContent 时） */
  const [conflictRemoteFetched, setConflictRemoteFetched] = useState<string | null>(null);
  const [conflictRemoteStatus, setConflictRemoteStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const conflictDiffRegionId = useId();

  useEffect(() => {
    onSaveStateChange?.(isSaving ? 'saving' : isDirty ? 'dirty' : 'saved');
  }, [isDirty, isSaving, onSaveStateChange]);
  const draftByNoteRef = useRef<Map<string, string>>(new Map());
  const lastSavedMapRef = useRef<Map<string, string>>(new Map());
  const dstuSaveByNoteRef = useRef<Map<string, (content: string) => Promise<void>>>(new Map());
  const noteIdRef = useRef<string | null>(null);
  const prevNoteIdRef = useRef<string | null>(null);
  const isUnmountedRef = useRef(false);
  const programmaticUpdateRef = useRef(false);
  const loadMoreInFlightRef = useRef(false);
  const lastAppliedWindowLineCountRef = useRef<number | null>(null);
  const isComposingRef = useRef(false); // IME 合成状态追踪
  const contentChangedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 内容变化事件防抖
  const saveRetryCountRef = useRef(0); // 🔒 审计修复: 自动保存重试计数（指数退避）

  // Find & Replace 状态
  const [isFindReplaceOpen, setIsFindReplaceOpen] = useState(false);
  const [findInitialQuery, setFindInitialQuery] = useState('');
  /** 面板挂载容器：Cmd/Ctrl+F 已开时用于把焦点送回查找输入框（不改面板 props 面） */
  const findReplaceContainerRef = useRef<HTMLDivElement | null>(null);

  // 字数统计（非空白字符数，防抖更新）
  const [charCount, setCharCount] = useState(0);

  // 切换笔记/内容加载后初始化字数（依赖 id 而非 content：编辑中的字数由 handleChange 防抖更新）
  // ★ F10 修复：不再依赖 initialContent。保存成功会回流新的 initialContent，
  // 若用户在保存后继续输入，这里会把字数回退到保存时点的旧值。
  // 同笔记的外部更新由 notes:external-updated 监听负责刷新字数。
  const activeNoteKey = isDstuMode ? dstuNoteId : active?.id;
  const initialCharSourceRef = useRef('');
  initialCharSourceRef.current = isDstuMode ? (initialContent ?? '') : (active?.content_md ?? '');
  useEffect(() => {
    setCharCount(countNoteChars(initialCharSourceRef.current));
  }, [activeNoteKey]);

  // 阅读模式状态（防止手机滑动时弹出键盘）
  const [readingMode, setReadingMode] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const focusModeOwnerId = useId();
  const focusModeRef = useRef(false);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const templatePanelId = useId();
  const templateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const effectiveReadOnly = readOnly || readingMode;

  // 进入只读/阅读模式时收起模板面板（应用入口已禁用，避免留下无效面板）
  useEffect(() => {
    if (effectiveReadOnly) setTemplateMenuOpen(false);
  }, [effectiveReadOnly]);

  // 焦点模式沉浸过渡：进入时 chrome 先 200ms 淡出再真正隐藏（display:none），
  // 退出时立即恢复布局并播放 200ms 淡入；reduced-motion 下直接切换。
  const [focusChromePhase, setFocusChromePhase] = useState<'visible' | 'exiting' | 'hidden' | 'restoring'>('visible');
  useEffect(() => {
    if (focusMode) {
      if (prefersReducedMotion()) {
        setFocusChromePhase('hidden');
        return;
      }
      setFocusChromePhase('exiting');
      const timer = window.setTimeout(
        () => setFocusChromePhase('hidden'),
        FOCUS_CHROME_TRANSITION_MS,
      );
      return () => window.clearTimeout(timer);
    }
    if (prefersReducedMotion()) {
      setFocusChromePhase('visible');
      return;
    }
    setFocusChromePhase((prev) => (prev === 'visible' ? prev : 'restoring'));
    const timer = window.setTimeout(
      () => setFocusChromePhase('visible'),
      FOCUS_CHROME_TRANSITION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [focusMode]);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((enabled) => !enabled);
  }, []);

  const publishFocusMode = useCallback((enabled: boolean) => {
    if (!focusModeScopeId) return;
    window.dispatchEvent(new CustomEvent<NotesFocusModeEventDetail>(
      'notes:focus-mode-changed',
      { detail: { ownerId: focusModeOwnerId, scopeId: focusModeScopeId, enabled } },
    ));
  }, [focusModeOwnerId, focusModeScopeId]);

  useEffect(() => {
    focusModeRef.current = focusMode;
    publishFocusMode(focusMode);
  }, [focusMode, publishFocusMode]);

  useEffect(() => () => {
    if (focusModeRef.current) publishFocusMode(false);
  }, [publishFocusMode]);

  useEffect(() => {
    if (!focusMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setFocusMode(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [focusMode]);

  const applyTemplate = useCallback((markdown: string) => {
    if (!editorApi || effectiveReadOnly) return;
    // 模板变量：{{date}} / {{time}} 按界面语言本地化，{{title}} 取当前笔记标题
    const noteTitle = (isDstuMode ? initialTitle : contextActive?.title) ?? '';
    editorApi.setMarkdown(applyNoteTemplate(editorApi.getMarkdown(), markdown, {
      title: noteTitle,
      locale: i18n?.resolvedLanguage ?? i18n?.language,
    }));
    editorApi.focus();
    setTemplateMenuOpen(false);
  }, [editorApi, effectiveReadOnly, isDstuMode, initialTitle, contextActive?.title, i18n]);

  // 移动端底部工具条：小屏（与壳层 <768 断点一致）或触屏主指针，且处于编辑态。
  // P0-2：仅看 (pointer: coarse) 会漏掉「窄窗桌面/模拟器」，与壳层断点对齐。
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const isSmallScreen = useIsMobile();
  const isTouchEditingSurface = isSmallScreen || isCoarsePointer;
  // 📱 P0 泄漏修复：编辑器壳层不可见（保活 tab display:none、三屏滑动移出
  // 视口、切换到其他应用视图）时必须收回 body 级工具条，否则它会悬浮在
  // 聊天输入栏 / 待办 / Finder 底栏之上拦截点击。IntersectionObserver 对
  // display:none 与 transform 移出视口的祖先都会上报不相交，天然覆盖全部宿主。
  const [shellInViewport, setShellInViewport] = useState(true);
  const wantsMobileToolbar =
    isTouchEditingSurface && !effectiveReadOnly && !!editorApi && !suppressMobileToolbar && shellInViewport;
  // 单实例门控：多个可见编辑器只让最近交互的实例渲染 body 级工具条
  const mobileToolbarInstanceId = useId();
  const mobileToolbarOwner = useSyncExternalStore(subscribeMobileToolbarOwner, getMobileToolbarOwner);
  useEffect(() => {
    if (!wantsMobileToolbar) return undefined;
    return () => releaseMobileToolbarOwner(mobileToolbarInstanceId);
  }, [wantsMobileToolbar, mobileToolbarInstanceId]);
  useEffect(() => {
    // 无持有者时（首挂载 / 前持有者卸载或退出编辑态）由可用实例认领
    if (wantsMobileToolbar && mobileToolbarOwner === null) {
      claimMobileToolbarOwner(mobileToolbarInstanceId);
    }
  }, [wantsMobileToolbar, mobileToolbarOwner, mobileToolbarInstanceId]);
  const showMobileToolbar = wantsMobileToolbar && mobileToolbarOwner === mobileToolbarInstanceId;
  const [mobileActiveStates, setMobileActiveStates] = useState<MobileEditorToolbarActiveStates>({});

  const dropZoneRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const notesShellRef = useRef<HTMLDivElement>(null);

  // 壳层可见性监听（P0 泄漏修复的数据源）。仅触屏编辑面需要，桌面纯鼠标不挂观察器。
  useEffect(() => {
    if (!isTouchEditingSurface) {
      setShellInViewport(true);
      return undefined;
    }
    const shell = notesShellRef.current;
    if (!shell) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setShellInViewport(entry.isIntersecting);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [isTouchEditingSurface]);

  // 用户在本实例内交互（聚焦/触点）时抢占工具条持有权
  useEffect(() => {
    if (!wantsMobileToolbar) return undefined;
    const shell = notesShellRef.current;
    if (!shell) return undefined;
    const claim = () => claimMobileToolbarOwner(mobileToolbarInstanceId);
    shell.addEventListener('focusin', claim);
    shell.addEventListener('pointerdown', claim);
    return () => {
      shell.removeEventListener('focusin', claim);
      shell.removeEventListener('pointerdown', claim);
    };
  }, [wantsMobileToolbar, mobileToolbarInstanceId]);

  const mobileCommands = buildMobileEditorCommands(editorApi, {
    // P0-4：图片上传归档到当前笔记资产目录
    noteId: isDstuMode ? dstuNoteId : contextActive?.id,
    // 底栏「查找」入口：打开编辑器内联查找替换条
    openFind: () => setIsFindReplaceOpen(true),
  });

  const cancelDebounce = () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
  };

  // ========== 根据模式选择 noteId 和初始值 ==========
  const noteId = isDstuMode ? dstuNoteId : active?.id;
  const initialValue = isDstuMode ? initialContent : (active?.content_md || '');

  useEffect(() => {
    const onFindQuery = (event: Event) => {
      const detail = (event as CustomEvent<Partial<NotesFindQuery>>).detail;
      if (!detail?.query || (detail.noteId && detail.noteId !== noteIdRef.current)) return;
      const query = detail.noteId
        ? consumeNotesFindQuery(detail.noteId) ?? detail.query
        : detail.query;
      setFindInitialQuery(query);
      setIsFindReplaceOpen(true);
    };
    window.addEventListener(NOTES_FIND_QUERY_EVENT, onFindQuery);
    const pending = consumeNotesFindQuery(noteIdRef.current);
    if (pending) {
      setFindInitialQuery(pending);
      setIsFindReplaceOpen(true);
    }
    return () => window.removeEventListener(NOTES_FIND_QUERY_EVENT, onFindQuery);
  }, []);

  useEffect(() => {
    const onConflict = (event: Event) => {
      const detail = (event as CustomEvent<{
        noteId?: string;
        restoreMine?: () => void;
        /** 可选：发起方随事件带来的远端胜出版本（向后兼容旧发起方） */
        serverContent?: string;
      }>).detail;
      if (!detail?.restoreMine || detail.noteId !== noteIdRef.current) return;
      setConflictAction({
        restoreMine: detail.restoreMine,
        // 事件同步派发于发起方 refreshFromDisk(force) 之前，
        // 此刻 contentRef 仍是被冲突顶掉的用户版本。
        mineContent: contentRef.current,
        serverContent: typeof detail.serverContent === 'string' ? detail.serverContent : undefined,
      });
      setConflictDiffOpen(false);
      setConflictRemoteFetched(null);
      setConflictRemoteStatus('idle');
      setSaveError('conflict');
    };
    window.addEventListener('notes:content-conflict', onConflict);
    return () => window.removeEventListener('notes:content-conflict', onConflict);
  }, []);

  // ★ 顺手修复：切换笔记时清掉上一篇的冲突横幅/对比区。
  // 之前 conflictAction 不随 noteId 复位，横幅会带着旧笔记的 restoreMine
  // 一直挂在新笔记上。
  useEffect(() => {
    setConflictAction(null);
    setConflictDiffOpen(false);
    setConflictRemoteFetched(null);
    setConflictRemoteStatus('idle');
  }, [noteId]);

  /** 兼容旧发起方：payload 无 serverContent 时按需拉取磁盘最新版本 */
  const fetchConflictRemote = useCallback(async () => {
    const targetNoteId = noteIdRef.current;
    if (!targetNoteId) return;
    setConflictRemoteStatus('loading');
    const result = await dstu.getContent(`/${targetNoteId}`);
    if (isUnmountedRef.current || targetNoteId !== noteIdRef.current) return;
    if (result.ok && typeof result.value === 'string') {
      setConflictRemoteFetched(result.value);
      setConflictRemoteStatus('idle');
    } else {
      setConflictRemoteStatus('error');
    }
  }, []);

  // 「对比」首次展开且 payload 未携带远端内容时触发降级拉取
  useEffect(() => {
    if (!conflictDiffOpen || !conflictAction) return;
    if (conflictAction.serverContent !== undefined || conflictRemoteFetched !== null) return;
    if (conflictRemoteStatus !== 'idle') return;
    void fetchConflictRemote();
  }, [conflictDiffOpen, conflictAction, conflictRemoteFetched, conflictRemoteStatus, fetchConflictRemote]);

  const conflictRemoteContent = conflictAction
    ? (conflictAction.serverContent ?? conflictRemoteFetched)
    : null;

  // 方向：远端（当前编辑器内容）→ 我的版本。
  // + 行 = 我的版本独有、− 行 = 远端独有，与「恢复我的版本」将应用的变化一致。
  const conflictDiffLines = useMemo(() => {
    if (!conflictAction || conflictRemoteContent == null) return null;
    return computeDiffLines(conflictRemoteContent, conflictAction.mineContent);
  }, [conflictAction, conflictRemoteContent]);

  const conflictDiffStats = useMemo(() => {
    if (!conflictDiffLines) return null;
    return {
      added: conflictDiffLines.filter((line) => line.type === 'added').length,
      removed: conflictDiffLines.filter((line) => line.type === 'removed').length,
    };
  }, [conflictDiffLines]);

  /** 冲突两个行动按钮的公共收尾：清横幅/对比区，「恢复我的版本」再执行回写 */
  const resolveConflict = useCallback((mode: 'mine' | 'remote', action: { restoreMine: () => void }) => {
    setConflictAction(null);
    setConflictDiffOpen(false);
    setConflictRemoteFetched(null);
    setConflictRemoteStatus('idle');
    setSaveError(null);
    if (mode === 'mine') action.restoreMine();
  }, []);

  useEffect(() => {
    if (!editorApi || !showMobileToolbar) return undefined;
    const update = () => {
      const crepe = editorApi.getCrepe();
      if (!crepe) return;
      crepe.editor.action((ctx) => {
        const state = ctx.get(editorViewCtx).state;
        const markNames = new Set(state.selection.$from.marks().map((mark) => mark.type.name));
        const ancestorNames = new Set<string>();
        for (let depth = state.selection.$from.depth; depth >= 0; depth -= 1) {
          ancestorNames.add(state.selection.$from.node(depth).type.name);
        }
        const parent = state.selection.$from.parent;
        const headingLevel = parent.type.name === 'heading' ? Number(parent.attrs.level) : 0;
        setMobileActiveStates({
          bold: markNames.has('strong'),
          italic: markNames.has('emphasis') || markNames.has('em'),
          strikethrough: markNames.has('strike_through') || markNames.has('strikethrough'),
          h1: headingLevel === 1,
          h2: headingLevel === 2,
          h3: headingLevel === 3,
          bullet: ancestorNames.has('bullet_list'),
          task: ancestorNames.has('task_list') || ancestorNames.has('task_item'),
        });
      });
    };
    update();
    document.addEventListener('selectionchange', update);
    window.addEventListener('keyup', update, true);
    window.addEventListener('pointerup', update, true);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('keyup', update, true);
      window.removeEventListener('pointerup', update, true);
    };
  }, [editorApi, showMobileToolbar]);

  // Keep each note bound to the save callback that owns its original path.
  // A queued draft may finish after the component has switched to another note.
  useLayoutEffect(() => {
    if (isDstuMode && noteId && dstuOnSave) {
      dstuSaveByNoteRef.current.set(noteId, dstuOnSave);
    }
  }, [isDstuMode, noteId, dstuOnSave]);

  useEffect(() => {
    noteIdRef.current = noteId ?? null;
  }, [noteId]);

  // ★ Y8 修复：超限提示去重（同一笔记只提示一次，保存成功后复位）
  const oversizeNotifiedRef = useRef<Set<string>>(new Set());

  // ========== 保存逻辑（支持 DSTU 模式） ==========
  const executeSave = useCallback(async ({ noteId: targetNoteId, content }: PendingSavePayload) => {
    if (readOnly) {
      return;
    }
    // ★ Y8 修复：前端预检内容大小，与后端 1MB 限制对齐。
    // 之前超限内容只会在后端静默失败并无限重试，用户无感知。
    if (content.length > MAX_NOTE_CONTENT_BYTES / 4 &&
        new TextEncoder().encode(content).length > MAX_NOTE_CONTENT_BYTES) {
      if (!oversizeNotifiedRef.current.has(targetNoteId)) {
        oversizeNotifiedRef.current.add(targetNoteId);
        showGlobalNotification(
          'error',
          t('notes:actions.content_too_large')
        );
      }
      const error = new Error('Note content exceeds 1MB limit');
      (error as Error & { isNonRetryable?: boolean }).isNonRetryable = true;
      throw error;
    }
    if (isDstuMode) {
      const saveTarget = dstuSaveByNoteRef.current.get(targetNoteId);
      if (!saveTarget) {
        console.warn('[NotesCrepeEditor] DSTU save target is no longer available', {
          targetNoteId,
        });
        const error = new Error('stale_note_payload');
        (error as Error & { isNonRetryable?: boolean }).isNonRetryable = true;
        throw error;
      }
      await saveTarget(content);
    } else {
      // Context 模式：调用 NotesContext.saveNoteContent
      if (saveNoteContent) {
        await saveNoteContent(targetNoteId, content);
      }
    }
    oversizeNotifiedRef.current.delete(targetNoteId);
    // ★ A6-18：仅当笔记仍被跟踪（草稿仍在或为当前笔记）时回写快照。
    // 否则切换笔记后保存完成会把已清理的条目重新塞回 Map，长会话下
    // lastSavedMapRef 持有大量历史笔记全文，内存无界增长。
    if (draftByNoteRef.current.has(targetNoteId) || targetNoteId === noteIdRef.current) {
      lastSavedMapRef.current.set(targetNoteId, content);
    } else {
      lastSavedMapRef.current.delete(targetNoteId);
    }
    if (!isUnmountedRef.current && targetNoteId === noteIdRef.current) {
      setLastSaved(new Date());
      setSaveError(null);
      const draft = draftByNoteRef.current.get(targetNoteId);
      setIsDirty(typeof draft === 'string' && draft !== content);
    }
  }, [isDstuMode, saveNoteContent, readOnly, t]);

  const dequeuePending = () => {
    if (!pendingSaveQueueRef.current.length) {
      return null;
    }
    return pendingSaveQueueRef.current.shift() ?? null;
  };

  const runPendingSave = useCallback(() => {
    if (inFlightSaveRef.current) {
      return inFlightSaveRef.current;
    }
    if (pendingSaveQueueRef.current.length === 0) {
      return Promise.resolve();
    }

    if (!savingTimerRef.current) {
      savingTimerRef.current = setTimeout(() => {
        if (!isUnmountedRef.current) {
          setIsSaving(true);
        }
      }, SAVING_INDICATOR_DELAY_MS);
    }

    // One shared promise drains every payload queued while a save is in flight.
    // This is important during unmount: cleanup can enqueue the latest draft and
    // the already-running save will still await and persist it before settling.
    const promise = (async () => {
      const terminalErrorsByNote = new Map<string, unknown>();
      try {
        let payload = dequeuePending();
        while (payload) {
          activeSavePayloadRef.current = payload;
          try {
            await executeSave(payload);
            saveRetryCountRef.current = 0;
            terminalErrorsByNote.delete(payload.noteId);
          } catch (error) {
            const flagged = error as Error & { isNoteConflict?: boolean; isNonRetryable?: boolean };
            if (flagged?.isNoteConflict || flagged?.isNonRetryable) {
              console.warn('[NotesCrepeEditor] ⚠️ 保存已放弃（冲突或不可重试）:', error);
              saveRetryCountRef.current = 0;
              if (!isUnmountedRef.current && payload.noteId === noteIdRef.current) {
                setSaveError(flagged?.isNoteConflict ? 'conflict' : 'failed');
              }
              terminalErrorsByNote.set(payload.noteId, error);
            } else {
              console.error('[NotesCrepeEditor] ❌ 自动保存失败', error);
              const MAX_RETRIES = 5;
              if (saveRetryCountRef.current < MAX_RETRIES) {
                pendingSaveQueueRef.current.unshift(payload);
                saveRetryCountRef.current++;
                const backoffMs = Math.min(
                  1000 * Math.pow(2, saveRetryCountRef.current - 1),
                  16000,
                );
                await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
              } else {
                console.error('[NotesCrepeEditor] ❌ 自动保存达到最大重试次数，放弃重试');
                saveRetryCountRef.current = 0;
                if (!isUnmountedRef.current && payload.noteId === noteIdRef.current) {
                  setSaveError('failed');
                }
                showGlobalNotification(
                  'error',
                  t('notes:actions.auto_save_failed')
                );
                terminalErrorsByNote.set(payload.noteId, error);
              }
            }
          }
          activeSavePayloadRef.current = null;
          payload = dequeuePending();
        }

        if (terminalErrorsByNote.size > 0) {
          throw terminalErrorsByNote.values().next().value;
        }
      } finally {
        activeSavePayloadRef.current = null;
        inFlightSaveRef.current = null;
        if (savingTimerRef.current) {
          clearTimeout(savingTimerRef.current);
          savingTimerRef.current = null;
        }
        if (!isUnmountedRef.current) {
          setIsSaving(false);
        }
      }
    })();
    inFlightSaveRef.current = promise;
    return promise;
  }, [executeSave, t]);

  const queueSave = useCallback((content: string, overrideNoteId?: string | null) => {
    const resolvedNoteId = overrideNoteId ?? noteIdRef.current;
    if (!resolvedNoteId) {
      return Promise.resolve();
    }
    draftByNoteRef.current.set(resolvedNoteId, content);
    const lastSavedSnapshot = lastSavedMapRef.current.get(resolvedNoteId) ?? '';
    if (!isUnmountedRef.current && resolvedNoteId === noteIdRef.current) {
      setIsDirty(lastSavedSnapshot !== content);
    }

    const queuedTarget = [...pendingSaveQueueRef.current]
      .reverse()
      .find((item) => item.noteId === resolvedNoteId);
    const activeTarget = activeSavePayloadRef.current?.noteId === resolvedNoteId
      ? activeSavePayloadRef.current
      : null;
    const pipelineTarget = queuedTarget?.content ?? activeTarget?.content ?? lastSavedSnapshot;
    if (pipelineTarget === content) {
      return runPendingSave();
    }
    
    pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter((item) => item.noteId !== resolvedNoteId);
    pendingSaveQueueRef.current.push({ noteId: resolvedNoteId, content });
    return runPendingSave();
  }, [runPendingSave]);

  const flushNoteDraft = useCallback((targetNoteId?: string | null) => {
    const resolvedNoteId = targetNoteId ?? noteIdRef.current;
    if (!resolvedNoteId) {
      return Promise.resolve();
    }
    cancelDebounce();
    const draft = draftByNoteRef.current.get(resolvedNoteId);
    if (typeof draft !== 'string') {
      return Promise.resolve();
    }
    return queueSave(draft, resolvedNoteId);
  }, [queueSave]);

  // 切换笔记时保存草稿 & 清理旧条目防止内存泄漏
  const MAX_DRAFT_ENTRIES = 10;
  useEffect(() => {
    const prevId = prevNoteIdRef.current;
    if (prevId && prevId !== noteId) {
      const prevDraft = draftByNoteRef.current.get(prevId);
      if (typeof prevDraft === 'string') {
        queueSave(prevDraft, prevId)
          .catch(() => {})
          .finally(() => {
            if (noteIdRef.current !== prevId) {
              dstuSaveByNoteRef.current.delete(prevId);
            }
          });
      } else {
        dstuSaveByNoteRef.current.delete(prevId);
      }
      // 保存已入队，清理旧笔记的草稿/快照条目，避免 Map 无限增长
      draftByNoteRef.current.delete(prevId);
      lastSavedMapRef.current.delete(prevId);
    }

    // 兜底：如果 Map 仍超过上限（例如快速连续切换），驱逐最早条目
    if (draftByNoteRef.current.size > MAX_DRAFT_ENTRIES) {
      const firstKey = draftByNoteRef.current.keys().next().value;
      if (firstKey && firstKey !== noteId) {
        draftByNoteRef.current.delete(firstKey);
        lastSavedMapRef.current.delete(firstKey);
      }
    }

    prevNoteIdRef.current = noteId ?? null;
  }, [noteId, queueSave]);

  // 🔧 修复：追踪上一次初始化的 noteId，避免同一笔记的内容被重复重置
  const lastInitializedNoteIdRef = useRef<string | null>(null);
  
  // 重置内容引用
  // 🔧 重要修复：只在 noteId 真正变化时才重置 draftByNoteRef 和 lastSavedMapRef
  // 之前的实现会在 initialValue 变化时也重置，导致用户编辑被覆盖
  useEffect(() => {
    const isNewNote = noteId !== lastInitializedNoteIdRef.current;

    cancelDebounce();
    contentRef.current = initialValue;
    
    // 🔧 关键修复：只在以下情况重置 draftByNoteRef 和 lastSavedMapRef：
    // 1. noteId 变化（切换到新笔记）
    // 2. 或者该笔记尚未初始化（首次打开）
    if (noteId && isNewNote) {
      // 检查是否已有草稿（用户可能之前编辑过但未保存）
      const existingDraft = draftByNoteRef.current.get(noteId);
      const hasExistingDraft = existingDraft !== undefined && existingDraft !== '';
      
      if (hasExistingDraft) {
        // 只更新 lastSavedMapRef（用于比较），不覆盖用户的草稿
        lastSavedMapRef.current.set(noteId, initialValue || '');
      } else {
        // 新笔记或无草稿，正常初始化
        draftByNoteRef.current.set(noteId, initialValue || '');
        lastSavedMapRef.current.set(noteId, initialValue || '');
      }
      
      lastInitializedNoteIdRef.current = noteId;
    } else if (noteId && !isNewNote) {
      // 同一笔记的 initialValue 变化（可能是内容加载完成）
      // 只在以下情况更新：
      // 1. 当前 draftByNoteRef 为空或未设置（内容尚未加载）
      // 2. 且 initialValue 不为空（真正的内容加载完成）
      const currentDraft = draftByNoteRef.current.get(noteId);
      const isDraftEmpty = currentDraft === undefined || currentDraft === '';
      const isInitialValueValid = initialValue && initialValue.length > 0;
      
      if (isDraftEmpty && isInitialValueValid) {
        draftByNoteRef.current.set(noteId, initialValue);
        lastSavedMapRef.current.set(noteId, initialValue);
      }
    }
    
    // ★ F2 修复：lastSaved 只在切换笔记时复位。
    // DSTU 模式下保存成功会回流新的 initialValue（active 恒为 null），
    // 之前无条件 setLastSaved(null) 会把刚设置的"已保存 HH:mm"立即清掉，
    // 导致保存状态指示器永远不可见。
    if (isNewNote) {
      setLastSaved(active?.updated_at ? new Date(active.updated_at) : null);
      setSaveError(null);
      if (noteId) {
        const draft = draftByNoteRef.current.get(noteId);
        const saved = lastSavedMapRef.current.get(noteId) ?? '';
        setIsDirty(typeof draft === 'string' && draft !== saved);
      } else {
        setIsDirty(false);
      }
    } else if (!isDstuMode && active?.updated_at) {
      // Context 模式：保留原行为，updated_at 推进时刷新显示
      setLastSaved(new Date(active.updated_at));
    }
    // 🔧 修复：不再在 initialValue 变化时重置 editorApi
    // 之前的实现会导致：initialValue 变化时 setEditorApi(null)，但如果 contentVersionKey 不变
    // （比如 DSTU 模式下 noteId 相同），CrepeEditor 不会重新挂载，onReady 不会被调用，
    // editorApi 保持为 null，工具栏永久禁用
  }, [initialValue, noteId, active?.updated_at, isDstuMode]);

  // 🔧 新增：只在 noteId 变化时重置 editorApi（这会触发 CrepeEditor 重新挂载）
  useLayoutEffect(() => {
    setEditorApi(null);
  }, [noteId]);

  const handleManualSave = useCallback(async () => {
    if (effectiveReadOnly) return;
    setSaveError(null);
    await flushNoteDraft();
  }, [flushNoteDraft, effectiveReadOnly]);

  const saveStatus: 'saved' | 'saving' | 'unsaved' | 'failed' | 'conflict' = isSaving
    ? 'saving'
    : saveError === 'conflict'
      ? 'conflict'
      : saveError === 'failed'
        ? 'failed'
        : isDirty
          ? 'unsaved'
          : 'saved';

  const handleChange = useCallback((markdown: string) => {
    if (effectiveReadOnly) {
      return;
    }
    if (programmaticUpdateRef.current) {
      contentRef.current = markdown;
      if (noteId) {
        draftByNoteRef.current.set(noteId, markdown);
        const lastSavedSnapshot = lastSavedMapRef.current.get(noteId) ?? '';
        setIsDirty(markdown !== lastSavedSnapshot);
      }
      setCharCount(countNoteChars(markdown));
      return;
    }
    contentRef.current = markdown;
    if (noteId) {
      draftByNoteRef.current.set(noteId, markdown);
      const lastSavedSnapshot = lastSavedMapRef.current.get(noteId) ?? '';
      setIsDirty(markdown !== lastSavedSnapshot);
    }
    cancelDebounce();
    saveTimerRef.current = setTimeout(() => {
      // ★ F4 修复：保存失败已在 runPendingSave 内部重试并通知用户，
      // 这里兜底 catch 防止 rejection 进入全局 unhandledrejection 上报
      queueSave(markdown).catch(() => {});
    }, AUTO_SAVE_DEBOUNCE_MS);
    
    // IME 合成期间跳过实时事件派发，避免卡顿
    // 合成结束后会由 compositionend 事件触发一次派发
    if (isComposingRef.current) {
      return;
    }
    
    // 清除之前的内容变化定时器
    if (contentChangedTimerRef.current) {
      clearTimeout(contentChangedTimerRef.current);
    }
    
    // 防抖派发内容变化事件（500ms），用于大纲等组件实时更新
    // ★ Y1 修复：DSTU 模式下也使用真实 noteId（之前的 'dstu-note' 占位符
    // 与 NotesContextPanel 按 noteId 过滤的逻辑不匹配，导致大纲无法实时更新）
    const eventNoteId = noteId;
    contentChangedTimerRef.current = setTimeout(() => {
      if (isUnmountedRef.current) return;
      setCharCount(countNoteChars(markdown));
      window.dispatchEvent(new CustomEvent('notes:content-changed', {
        detail: { noteId: eventNoteId, content: markdown }
      }));
    }, 500);
  }, [noteId, queueSave, effectiveReadOnly]);

  // 保存 ref
  const flushNoteDraftRef = useRef(flushNoteDraft);
  const setEditorRef = useRef(setEditor);
  flushNoteDraftRef.current = flushNoteDraft;
  setEditorRef.current = setEditor;

  // 清理
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      cancelDebounce();
      if (savingTimerRef.current) {
        clearTimeout(savingTimerRef.current);
        savingTimerRef.current = null;
      }
      if (contentChangedTimerRef.current) {
        clearTimeout(contentChangedTimerRef.current);
        contentChangedTimerRef.current = null;
      }
      // 仅 Context 模式下清除编辑器引用
      if (setEditorRef.current) {
        setEditorRef.current(null);
      }
      flushNoteDraftRef.current()?.catch(() => {});
    };
  }, []);

  // 监听 IME composition 事件，在合成期间跳过实时事件派发
  // 🔧 修复：绑定到编辑器容器而非 window，避免换行后首次输入法卡顿
  useEffect(() => {
    const container = dropZoneRef.current;
    if (!container) return;
    
    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };
    
    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      // 🔧 性能修复：不再在 compositionend 时立即派发事件
      // 之前的做法会绕过 500ms 防抖，导致首字符输入卡顿
      // 现在统一由 handleChange 中的防抖机制处理事件派发
    };
    
    // 使用 capture: true 确保在事件冒泡前捕获，避免与 ProseMirror 内部处理竞争
    container.addEventListener('compositionstart', handleCompositionStart, { capture: true });
    container.addEventListener('compositionend', handleCompositionEnd, { capture: true });
    
    return () => {
      container.removeEventListener('compositionstart', handleCompositionStart, { capture: true });
      container.removeEventListener('compositionend', handleCompositionEnd, { capture: true });
    };
  }, [isDstuMode]);

  useEffect(() => {
    const container = dropZoneRef.current;
    if (!container || !editorApi || effectiveReadOnly) return;
    const onDragOver = (event: DragEvent) => {
      if (!Array.from(event.dataTransfer?.types ?? []).includes(WB_RESOURCE_MIME)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer) return;
      const resource = parseWorkbenchDragData(event.dataTransfer);
      if (!resource || resource.resourceType !== 'note') return;
      event.preventDefault();
      event.stopPropagation();
      const crepe = editorApi.getCrepe();
      if (!crepe) return;
      crepe.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const point = view.posAtCoords({ left: event.clientX, top: event.clientY });
        const position = point?.pos ?? view.state.selection.from;
        insertWikilink(view, position, position, resource.title);
        view.focus();
      });
    };
    container.addEventListener('dragover', onDragOver, true);
    container.addEventListener('drop', onDrop, true);
    return () => {
      container.removeEventListener('dragover', onDragOver, true);
      container.removeEventListener('drop', onDrop, true);
    };
  }, [editorApi, effectiveReadOnly]);

  // 🔧 修复：监听 canvas:content-changed 事件，用于后端 Canvas 工具更新笔记后刷新编辑器
  useEffect(() => {
    const handleCanvasContentChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ noteId: string; newContent?: string }>;
      const { noteId: updatedNoteId, newContent } = customEvent.detail;
      
      // 只处理当前激活笔记的更新
      const currentNoteId = noteIdRef.current;
      if (updatedNoteId !== currentNoteId) {
        return;
      }
      
      // 如果有新内容，直接使用；否则从 active 获取
      if (newContent !== undefined && editorApi && currentNoteId) {
        // ★ A6-19：对齐 R3 外部更新语义——编辑器有未保存修改时不静默覆盖，
        // 避免吃掉用户正在输入的内容；冲突留待下次保存由乐观锁/冲突流程显式解决
        const draft = draftByNoteRef.current.get(currentNoteId);
        const lastSavedSnapshot = lastSavedMapRef.current.get(currentNoteId) ?? '';
        const isDirty =
          (typeof draft === 'string' && draft !== lastSavedSnapshot) ||
          pendingSaveQueueRef.current.some((p) => p.noteId === currentNoteId) ||
          inFlightSaveRef.current !== null;
        if (isDirty) {
          console.warn('[NotesCrepeEditor] ⚠️ canvas 更新到达时存在未保存修改，跳过静默覆盖');
          return;
        }
        // 更新编辑器内容
        editorApi.setMarkdown(newContent);
        // 更新本地引用，避免被误判为未保存
        contentRef.current = newContent;
        draftByNoteRef.current.set(currentNoteId, newContent);
        lastSavedMapRef.current.set(currentNoteId, newContent);
      }
    };
    
    window.addEventListener('canvas:content-changed', handleCanvasContentChanged);
    
    return () => {
      window.removeEventListener('canvas:content-changed', handleCanvasContentChanged);
    };
  }, [editorApi]);

  // ★ R3 修复：监听外部更新事件（其他面板/AI 工具/冲突解决），原位刷新编辑器内容。
  // force=false：仅在编辑器无未保存修改时应用（watch 静默同步，避免覆盖正在输入的内容）；
  // force=true：强制应用（保存冲突时外部版本胜出，调用方已通知用户）。
  useEffect(() => {
    const handleExternalUpdated = (event: Event) => {
      const { noteId: targetNoteId, content: newContent, force } =
        (event as CustomEvent<{ noteId: string; content: string; force?: boolean }>).detail;
      const currentNoteId = noteIdRef.current;
      if (!currentNoteId || targetNoteId !== currentNoteId) {
        return;
      }

      if (!force) {
        const draft = draftByNoteRef.current.get(currentNoteId);
        const lastSavedSnapshot = lastSavedMapRef.current.get(currentNoteId) ?? '';
        const isDirty =
          (typeof draft === 'string' && draft !== lastSavedSnapshot) ||
          pendingSaveQueueRef.current.some((p) => p.noteId === currentNoteId) ||
          inFlightSaveRef.current !== null;
        // 有未保存修改时不静默覆盖；冲突会在下次保存时由乐观锁显式处理
        if (isDirty) {
          return;
        }
      } else {
        // 强制刷新：丢弃该笔记排队中的旧保存与防抖，避免外部版本再次被覆盖
        cancelDebounce();
        pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter(
          (p) => p.noteId !== currentNoteId
        );
      }

      contentRef.current = newContent;
      draftByNoteRef.current.set(currentNoteId, newContent);
      lastSavedMapRef.current.set(currentNoteId, newContent);

      if (editorApi && editorApi.getMarkdown() !== newContent) {
        editorApi.setMarkdown(newContent);
      }
      setCharCount(countNoteChars(newContent));
      setLastSaved(new Date());
      // 外部版本已应用：清掉失败/冲突态与脏标记，避免 Header 仍显示 Conflict/Unsaved
      if (!isUnmountedRef.current) {
        setSaveError(null);
        setIsDirty(false);
      }
    };

    window.addEventListener('notes:external-updated', handleExternalUpdated);
    return () => {
      window.removeEventListener('notes:external-updated', handleExternalUpdated);
    };
  }, [editorApi]);

  // ★ F1 修复：显式保存请求（冲突恢复"恢复我的版本"等场景）。
  // 绕过 queueSave 的 lastSaved 去重（恢复路径中 draft 与 lastSaved 已被
  // external-updated 同步为同一值，常规入队会被跳过）。
  useEffect(() => {
    const handleRequestSave = (event: Event) => {
      const { noteId: targetNoteId, content } =
        (event as CustomEvent<{ noteId: string; content: string }>).detail;
      if (!targetNoteId || targetNoteId !== noteIdRef.current) {
        return;
      }
      contentRef.current = content;
      draftByNoteRef.current.set(targetNoteId, content);
      pendingSaveQueueRef.current = pendingSaveQueueRef.current.filter(
        (p) => p.noteId !== targetNoteId
      );
      pendingSaveQueueRef.current.push({ noteId: targetNoteId, content });
      runPendingSave().catch(() => {});
    };

    window.addEventListener('notes:request-save', handleRequestSave);
    return () => {
      window.removeEventListener('notes:request-save', handleRequestSave);
    };
  }, [runPendingSave]);

  // 宿主 wikilink 索引：挂载时拉取；创建后由 createFromWikilink upsert
  useEffect(() => {
    void refreshWikilinkNotesCache();
  }, []);

  useEffect(() => {
    if (!editorApi || !noteId) return;
    const scroll = (heading: string) => {
      // Level 0 asks Crepe to match the heading text across all heading levels.
      // 精确匹配谓词与 [[Note#Heading]] 补全/解析共用同一套规范化
      //（大小写、全半角、中文标点、空白折叠），避免锚点漂移。
      editorApi.scrollToHeading?.(heading, 0, heading.toLowerCase().trim(), (docHeading) =>
        notesHeadingTargetMatches(docHeading, heading)
      );
    };
    const onHeadingTarget = (event: Event) => {
      const detail = (event as CustomEvent<NotesHeadingTarget>).detail;
      if (detail?.noteId !== noteId || !detail.heading) return;
      consumeNotesHeadingTarget(noteId);
      scroll(detail.heading);
    };
    window.addEventListener(NOTES_HEADING_TARGET_EVENT, onHeadingTarget);
    const pending = consumeNotesHeadingTarget(noteId);
    if (pending) scroll(pending);
    return () => window.removeEventListener(NOTES_HEADING_TARGET_EVENT, onHeadingTarget);
  }, [editorApi, noteId]);

  // 未解析 wikilink 点击 → 创建笔记 → 刷新链接样式 → DSTU_OPEN_NOTE
  useEffect(() => {
    const handleCreateFromWikilink = (event: Event) => {
      const title = parseCreateFromWikilinkEvent(event);
      if (!title) return;
      void createNoteFromWikilinkTitle(title).then((noteId) => {
        if (!noteId || isUnmountedRef.current) return;
        refreshWikilinksAfterCreate(editorApi, title);
      });
    };

    window.addEventListener(CREATE_FROM_WIKILINK_EVENT, handleCreateFromWikilink);
    return () => {
      window.removeEventListener(CREATE_FROM_WIKILINK_EVENT, handleCreateFromWikilink);
    };
  }, [editorApi]);

  // 自动保存兜底：窗口隐藏（切到别的 App / 最小化）时立即冲刷待保存草稿，
  // 不等 1.5s 防抖到期，降低桌面端强杀进程时的丢字风险。
  useEffect(() => {
    const flushOnHide = () => {
      if (document.visibilityState !== 'hidden') return;
      cancelDebounce();
      flushNoteDraftRef.current()?.catch(() => {});
    };
    document.addEventListener('visibilitychange', flushOnHide);
    return () => document.removeEventListener('visibilitychange', flushOnHide);
  }, []);

  // beforeunload
  // ★ Y5 修复：检查所有笔记的草稿/保存队列（含后台 tab 的笔记），
  // 而不只是当前激活笔记，防止切换标签页后未保存内容被静默丢弃。
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      let hasPending =
        pendingSaveQueueRef.current.length > 0 || inFlightSaveRef.current !== null;

      if (!hasPending) {
        for (const [id, draft] of draftByNoteRef.current) {
          const lastSavedSnapshot = lastSavedMapRef.current.get(id) ?? '';
          if (draft !== lastSavedSnapshot) {
            hasPending = true;
            break;
          }
        }
      }

      if (hasPending) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // 键盘快捷键（注册在 document 上，处理后 stopPropagation 防止命令系统重复触发）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        const activeEl = document.activeElement as HTMLElement | null;
        const isEditorFocused = !!activeEl && !!dropZoneRef.current?.contains(activeEl);
        if (effectiveReadOnly || !isEditorFocused) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        handleManualSave()
          .then(() => showGlobalNotification('success', t('notes:actions.save_success')))
          .catch(() => showGlobalNotification('error', t('notes:actions.save_failed')));
        return;
      }
      // Cmd/Ctrl+F：打开编辑器内查找替换（编辑器或面板拥有焦点时生效）
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'f') {
        const activeEl = document.activeElement as HTMLElement | null;
        const isEditorFocused = !!activeEl && !!dropZoneRef.current?.contains(activeEl);
        // 已打开时按 Cmd+F 重新聚焦查找输入框；未聚焦编辑器时不拦截（避免干扰其他面板）
        if (!isEditorFocused && !isFindReplaceOpen) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (isFindReplaceOpen) {
          // 面板已开：把焦点送回查找输入框并全选，方便直接换词
          const input = findReplaceContainerRef.current?.querySelector('input');
          if (input instanceof HTMLInputElement) {
            input.focus();
            input.select();
          }
        } else {
          setIsFindReplaceOpen(true);
        }
        return;
      }
      // Cmd/Ctrl+Shift+U：进入/退出焦点模式
      //（mod+shift+f 已被库级搜索命令占用，见 notes.commands.ts）
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        const activeEl = document.activeElement as HTMLElement | null;
        const isEditorFocused = !!activeEl && !!dropZoneRef.current?.contains(activeEl);
        // 编辑器聚焦时进入；焦点模式已开时随处可退出
        if (!isEditorFocused && !focusModeRef.current) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        toggleFocusMode();
        return;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleManualSave, effectiveReadOnly, t, isFindReplaceOpen, toggleFocusMode]);

  // Find/Replace handlers
  const handleFindReplaceClose = useCallback(() => {
    setIsFindReplaceOpen(false);
    // 焦点回到编辑器
    editorApi?.focus();
  }, [editorApi]);

  // ========== 内容加载状态（支持 DSTU 模式） ==========
  const hasSelection = isDstuMode ? true : !!active;

  // ★ 使用统一的 Tauri 拖拽 Hook（仅提供视觉反馈，文件处理由 CrepeEditor 内部完成）
  const { isDragging: isDraggingOver } = useTauriDragAndDrop({
    dropZoneRef,
    onDropFiles: () => {}, // 不处理文件，由 CrepeEditor 内部处理
    isEnabled: hasSelection && !effectiveReadOnly,
    feedbackOnly: true, // 仅提供拖拽状态反馈
    feedbackExtensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'heif'], // 仅对图片显示反馈
    debugZoneId: 'notes-crepe-editor',
  });
  // DSTU 模式下内容已通过 props 传入，始终认为已加载
  const isContentLoaded = isDstuMode ? true : loadedContentIds.has(noteId ?? '');
  // 使用 noteId + 内容加载状态作为 key
  // - noteId 变化时重新创建编辑器（切换笔记）
  // - 内容加载完成时重新创建编辑器（确保使用正确的初始内容）
  // - updated_at 变化（自动保存）不会导致重建
  // ★ R1 修复：DSTU 模式下 key 只由 noteId 决定。
  // 之前以 `initialValue ? 'loaded' : 'empty'` 区分加载状态，导致新建空笔记
  // 首次自动保存后（'' → 非空）编辑器整体重挂载，丢失光标位置与撤销历史，
  // 重挂载窗口期的输入也会丢失。内容归属的正确性现由 NoteContentView 在
  // 渲染前保证（content 未就绪时不渲染编辑器）。
  const contentVersionKey = isDstuMode 
    ? `dstu:${noteId || 'new'}`
    : (noteId ? `${noteId}:${isContentLoaded ? 'loaded' : 'loading'}` : 'note-empty');

  useEffect(() => {
    if (!hasSelection) {
      setEditorRef.current(null);
    }
  }, [hasSelection]);

  // 编辑器就绪回调
  const handleEditorReady = useCallback((api: CrepeEditorApi) => {
    const lifecycleApi: CrepeEditorApi = {
      ...api,
      flushPendingSave: async () => {
        const targetNoteId = noteIdRef.current;
        if (!targetNoteId) return;

        // Crepe 的 onChange 有 250ms 合并窗口。ACR 不能在它尚未回调时
        // 就把视觉插入误报为“已自动保存”，因此直接以编辑器当前全文刷新草稿。
        const currentMarkdown = api.getMarkdown();
        contentRef.current = currentMarkdown;
        draftByNoteRef.current.set(targetNoteId, currentMarkdown);
        const saved = lastSavedMapRef.current.get(targetNoteId) ?? '';
        setIsDirty(currentMarkdown !== saved);
        await flushNoteDraftRef.current(targetNoteId);
      },
    };

    setEditorApi(lifecycleApi);
    lifecycleApiRef.current = lifecycleApi;
    onEditorReady?.(lifecycleApi);
    onEditorApiReady?.(lifecycleApi);
    // 将 Crepe API 设置到 Context（仅 Context 模式）
    if (!isDstuMode && setEditor) {
      setEditor(lifecycleApi);
    }
  }, [isDstuMode, onEditorReady, onEditorApiReady, setEditor]);

  useEffect(() => {
    return () => {
      onEditorReady?.(null);
      const previousApi = lifecycleApiRef.current;
      lifecycleApiRef.current = null;
      onEditorApiReady?.(null, previousApi ?? undefined);
    };
  }, [onEditorReady, onEditorApiReady]);

  // AI 编辑保存回调（用于 Canvas AI 编辑后自动保存）
  // DSTU / workbench：走 props.onSave（NoteContentView.handleSave）；
  // legacy Context Canvas：走 saveNoteContent。
  const handleAISave = useCallback(async (content: string) => {
    if (isDstuMode) {
      if (dstuOnSave) {
        await dstuOnSave(content);
      }
    } else if (noteId && saveNoteContent) {
      await saveNoteContent(noteId, content);
    }
  }, [isDstuMode, dstuOnSave, noteId, saveNoteContent]);

  // ACR R1-13：DSTU 下 hasSelection/isContentLoaded 恒为 true，故 workbench note 窗
  // 同样监听 canvas:ai-edit-request → AIDiffPanel；legacy Context 条件不变。
  const {
    aiEditState,
    handleAccept,
    handleReject,
    isApplying: isAIEditApplying,
    checkpoint: aiCheckpoint,
    rollbackCheckpoint,
    dismissCheckpoint,
  } = useCanvasAIEditHandler({
    noteId,
    editorApi,
    onSave: handleAISave,
    enabled: hasSelection && isContentLoaded,
    windowId: acrWindowId,
  });

  const captureViewportMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return null;
    return {
      scrollTop: Math.round(viewport.scrollTop),
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
    };
  }, []);

  const isCurrentNoteDirty = useCallback(() => {
    const currentNoteId = noteIdRef.current;
    if (!currentNoteId) return false;
    const draft = draftByNoteRef.current.get(currentNoteId);
    const lastSavedSnapshot = lastSavedMapRef.current.get(currentNoteId) ?? '';
    return (
      (typeof draft === 'string' && draft !== lastSavedSnapshot) ||
      pendingSaveQueueRef.current.some((payload) => payload.noteId === currentNoteId) ||
      inFlightSaveRef.current !== null
    );
  }, []);

  // ACR R1-13：把真实 isDirty 接入 contentDirtyRegistry（probe / canClose）
  useEffect(() => {
    if (!dirtyRegistryKey) return;
    return registerContentDirtyChecker(
      dirtyRegistryKey.typeId,
      dirtyRegistryKey.instanceKey,
      isCurrentNoteDirty,
    );
  }, [dirtyRegistryKey?.typeId, dirtyRegistryKey?.instanceKey, isCurrentNoteDirty]);

  const applyWindowExpansion = useCallback((result: MarkdownLoadMoreResult) => {
    if (!editorApi || !noteId) {
      return;
    }
    const wasDirty = isCurrentNoteDirty();
    const selection = editorApi.captureSelection?.() ?? null;
    const viewportMetrics = captureViewportMetrics();

    programmaticUpdateRef.current = true;
    editorApi.setMarkdown(result.loadedMarkdown);
    contentRef.current = result.loadedMarkdown;
    draftByNoteRef.current.set(noteId, result.loadedMarkdown);
    if (!wasDirty) {
      lastSavedMapRef.current.set(noteId, result.loadedMarkdown);
    }
    setCharCount(countNoteChars(result.loadedMarkdown));

    requestAnimationFrame(() => {
      const viewport = scrollViewportRef.current;
      if (viewport && viewportMetrics) {
        viewport.scrollTop = viewportMetrics.scrollTop;
      }
      editorApi.restoreSelection?.(selection);
      lastAppliedWindowLineCountRef.current = result.loadedLineCount;
      programmaticUpdateRef.current = false;
    });
  }, [captureViewportMetrics, editorApi, isCurrentNoteDirty, noteId]);

  const handleWindowScroll = useCallback(() => {
    if (
      !windowingState?.enabled ||
      !windowingState.hasMore ||
      windowingState.isLoadingMore ||
      loadMoreInFlightRef.current ||
      !editorApi ||
      !onRequestLoadMore
    ) {
      return;
    }

    const metrics = captureViewportMetrics();
    if (!metrics || !shouldRequestLoadMore(metrics, windowingState.preloadPx)) {
      return;
    }

    loadMoreInFlightRef.current = true;
    void onRequestLoadMore(editorApi.getMarkdown())
      .then((result) => {
        if (result) {
          applyWindowExpansion(result);
        }
      })
      .finally(() => {
        loadMoreInFlightRef.current = false;
      });
  }, [applyWindowExpansion, captureViewportMetrics, editorApi, onRequestLoadMore, windowingState]);

  // ── 大纲滚动跟随：rAF 节流地广播视口顶部附近的当前标题 ──
  const activeHeadingRafRef = useRef<number | null>(null);
  const lastActiveHeadingKeyRef = useRef<string | null>(null);

  const publishActiveHeading = useCallback(() => {
    if (activeHeadingRafRef.current !== null) return;
    activeHeadingRafRef.current = requestAnimationFrame(() => {
      activeHeadingRafRef.current = null;
      const viewport = scrollViewportRef.current;
      const container = dropZoneRef.current;
      const currentNoteId = noteIdRef.current;
      if (!viewport || !container || !currentNoteId || isUnmountedRef.current) return;
      const headingEls = container.querySelectorAll<HTMLElement>(
        '.crepe-editor-wrapper h1, .crepe-editor-wrapper h2, .crepe-editor-wrapper h3, .crepe-editor-wrapper h4, .crepe-editor-wrapper h5, .crepe-editor-wrapper h6',
      );
      if (headingEls.length === 0) return;
      // 视口顶部下方 96px 作为"当前阅读行"锚点；取其上方最近的标题
      const anchorTop = viewport.getBoundingClientRect().top + 96;
      let current: HTMLElement | null = null;
      for (const el of headingEls) {
        if (el.getBoundingClientRect().top <= anchorTop) {
          current = el;
        } else {
          break;
        }
      }
      const target = current ?? headingEls[0];
      const text = normalizeActiveHeadingText(target.textContent ?? '');
      if (!text) return;
      const level = Number(target.tagName.slice(1)) || 0;
      // 同名同级标题按文档序去歧义
      let occurrence = 0;
      for (const el of headingEls) {
        if (el === target) break;
        if (
          el.tagName === target.tagName &&
          normalizeActiveHeadingText(el.textContent ?? '') === text
        ) {
          occurrence += 1;
        }
      }
      const key = `${currentNoteId}:${level}:${occurrence}:${text}`;
      if (key === lastActiveHeadingKeyRef.current) return;
      lastActiveHeadingKeyRef.current = key;
      dispatchTypedEvent(NOTES_ACTIVE_HEADING_EVENT, {
        noteId: currentNoteId,
        text,
        level,
        occurrence,
      } satisfies NotesActiveHeadingDetail);
    });
  }, []);

  useEffect(() => () => {
    if (activeHeadingRafRef.current !== null) {
      cancelAnimationFrame(activeHeadingRafRef.current);
      activeHeadingRafRef.current = null;
    }
  }, []);

  // 切换笔记后允许立即重新广播（key 含 noteId，这里只是显式复位）
  useEffect(() => {
    lastActiveHeadingKeyRef.current = null;
  }, [noteId]);

  // ── 移动端工具条滚动收起：下滑隐藏、上滑/到顶恢复；键盘弹出时不收起 ──
  const [mobileToolbarCollapsed, setMobileToolbarCollapsed] = useState(false);
  const lastScrollTopRef = useRef(0);

  const handleMobileToolbarScroll = useCallback(() => {
    if (!showMobileToolbar) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const top = viewport.scrollTop;
    const delta = top - lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    // 接近顶部 / 底部时始终展示（底部常有待勾选任务列表）
    const nearEdge = top < 24 ||
      top + viewport.clientHeight >= viewport.scrollHeight - 24;
    if (nearEdge || delta < -4) {
      setMobileToolbarCollapsed(false);
    } else if (delta > 12) {
      setMobileToolbarCollapsed(true);
    }
  }, [showMobileToolbar]);

  // 工具条隐藏条件变化（键盘收起 / 切换笔记 / 退出编辑态）时恢复展示
  useEffect(() => {
    if (!showMobileToolbar) setMobileToolbarCollapsed(false);
  }, [showMobileToolbar]);

  const handleViewportScroll = useCallback(() => {
    handleWindowScroll();
    publishActiveHeading();
    handleMobileToolbarScroll();
  }, [handleWindowScroll, publishActiveHeading, handleMobileToolbarScroll]);

  // 处理大纲滚动事件
  useEffect(() => {
    const handleScrollToHeading = (e: CustomEvent<{ text: string; normalizedText?: string; level: number; noteId?: string }>) => {
      // ★ Y2 修复：事件携带 noteId 时按当前笔记过滤，
      // 防止多个可见编辑器实例（分屏/多面板）同时响应滚动
      if (e.detail.noteId && noteIdRef.current && e.detail.noteId !== noteIdRef.current) {
        return;
      }
      const viewportMetrics = captureViewportMetrics();
      emitOutlineDebugLog({
        category: 'event',
        action: 'scrollToHeading:received',
        details: {
          heading: e.detail,
          noteId: active?.id || null,
          hasEditor: !!editorApi,
          viewportMetrics,
        },
      });
      emitOutlineDebugSnapshot({
        noteId: active?.id || null,
        heading: {
          text: e.detail.text,
          normalized: e.detail.normalizedText,
          level: e.detail.level,
        },
        scrollEvent: {
          reason: 'scrollToHeading:received',
          targetPos: null,
          resolvedPos: null,
          exactMatch: undefined,
        },
        editorState: {
          hasView: !!editorApi,
          hasSelection: false,
          containerScrollTop: viewportMetrics?.scrollTop ?? null,
          containerScrollHeight: viewportMetrics?.scrollHeight ?? null,
          containerClientHeight: viewportMetrics?.clientHeight ?? null,
        },
        domState: {
          viewportExists: !!viewportMetrics,
          viewportSelector: '.notes-editor .scroll-area__viewport',
        },
      });
      if (editorApi?.scrollToHeading) {
        editorApi.scrollToHeading(e.detail.text, e.detail.level, e.detail.normalizedText);
      }
    };

    window.addEventListener('notes:scroll-to-heading' as any, handleScrollToHeading as any);
    return () => {
      window.removeEventListener('notes:scroll-to-heading' as any, handleScrollToHeading as any);
    };
  }, [active?.id, captureViewportMetrics, editorApi]);

  // ★ 拖拽视觉反馈已通过 useTauriDragAndDrop hook 统一处理（见上方）

  // 空状态
  if (!hasSelection) {
    const ShortcutKey = ({ children }: { children: React.ReactNode }) => (
      <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
        {children}
      </kbd>
    );

    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-8 max-w-md w-full p-6 ui-zoom-fade-in">
          <div className="flex flex-col items-center gap-2 text-center">
            <h3 className="text-lg font-medium text-foreground/90">
              {t('notes:editor.empty_state.title')}
            </h3>
            <p className="text-sm text-muted-foreground/70">
              {t('notes:editor.empty_state.description')}
            </p>
          </div>

          <div className="w-full max-w-2xl flex flex-wrap items-stretch justify-center gap-3">
            <DsButton
              onClick={() => {
                if (createNote) {
                  void createNote();
                  return;
                }
                // DSTU / Learning Hub：走命令事件，避免 Context createNote 为空时空点
                window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_CREATE_NEW));
              }}
              disabled={readOnly}
              className="w-full min-w-[220px] h-auto py-3 justify-between text-left"
              size="lg"
              variant="default"
            >
              <div className="flex items-center gap-3 text-sm font-medium text-foreground/80">
                <FilePlus size={16} className="text-muted-foreground transition-colors" />
                {t('notes:sidebar.actions.new_note')}
              </div>
              <div className="flex items-center gap-1">
                <ShortcutKey>{isMacOS() ? '⌘N' : 'Ctrl+N'}</ShortcutKey>
              </div>
            </DsButton>

            <DsButton
              onClick={async () => {
                if (createFolder) {
                  const id = await createFolder();
                  if (id) {
                    setSidebarRevealId?.(id);
                  }
                  return;
                }
                window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_CREATE_FOLDER));
              }}
              disabled={readOnly}
              className="w-full min-w-[220px] h-auto py-3 justify-between text-left"
              size="lg"
              variant="default"
            >
              <div className="flex items-center gap-3 text-sm font-medium text-foreground/80">
                <FolderPlus size={16} className="text-muted-foreground transition-colors" />
                {t('notes:editor.empty_state.actions.new_folder')}
              </div>
            </DsButton>

            <DsButton
              onClick={() => {
                try {
                  // Context 侧栏 + Learning Hub 侧栏各听不同事件，一并派发
                  window.dispatchEvent(new CustomEvent('notes:focus-sidebar-search'));
                  window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_FOCUS_SEARCH));
                } catch (error: unknown) {
                  console.warn('[NotesCrepeEditor] Failed to dispatch focus-search events:', error);
                }
              }}
              disabled={readOnly}
              className="w-full min-w-[220px] h-auto py-3 justify-between text-left"
              size="lg"
              variant="default"
            >
              <div className="flex items-center gap-3 text-sm font-medium text-foreground/80">
                <MagnifyingGlass size={16} className="text-muted-foreground transition-colors" />
                {t('notes:editor.empty_state.actions.search_note')}
              </div>
            </DsButton>
          </div>
        </div>
      </div>
    );
  }

  // DSTU 模式下始终渲染，Context 模式下需要 noteId
  if (!isDstuMode && !noteId) return null;

  return (
    <ErrorBoundary name="NotesEditor">
    <div
      ref={notesShellRef}
      className={cn("notes-crepe-shell flex-1 min-h-0 flex flex-col bg-background relative", className)}
      // display:none（宿主样式）在 chrome 淡出完成后才生效，保证 200ms 沉浸过渡可见
      data-focus-mode={focusMode && focusChromePhase === 'hidden' ? 'true' : 'false'}
      data-focus-chrome={focusChromePhase}
    >
      {/* 内容加载中遮罩 - 覆盖在编辑器上方 */}
      {!isContentLoaded && (
        <div data-wb-blur-surface className="absolute inset-0 z-20 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <span className="loading loading-spinner loading-lg text-muted-foreground/60" />
        </div>
      )}

      {/* 图片拖拽覆盖层 */}
      {isDraggingOver && (
        <div 
          className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none ui-rise-in"
          style={{ backgroundColor: 'hsl(var(--background) / 0.72)' }}
        >
          <div 
            className="flex flex-col items-center gap-3 px-7 py-5 rounded-[var(--radius-shell-control,12px)] pointer-events-none"
            style={{ 
              backgroundColor: 'hsl(var(--background))',
              border: '1px dashed hsl(var(--border))',
              boxShadow: 'var(--notes-popup-shadow, 0 4px 16px hsl(var(--shadow-base) / 0.12))'
            }}
          >
            <div 
              className="w-9 h-9 rounded-sm flex items-center justify-center"
              style={{ backgroundColor: 'hsl(var(--muted))' }}
            >
              <ImageSquare size={20} style={{ color: 'hsl(var(--muted-foreground))' }} />
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <span 
                className="text-sm font-medium"
                style={{ color: 'hsl(var(--foreground))' }}
              >
                {t('notes:editor.image_upload.drop_overlay_title')}
              </span>
              <span 
                className="text-xs"
                style={{ color: 'hsl(var(--muted-foreground))' }}
              >
                {t('notes:editor.image_upload.drop_overlay_hint')}
              </span>
            </div>
          </div>
        </div>
      )}

      {conflictAction && (
        <div
          className="notes-conflict-banner flex-shrink-0 flex-wrap"
          role="alert"
        >
          <WarningCircle
            size={16}
            weight="fill"
            className="shrink-0 text-[hsl(var(--warning,38_70%_45%))]"
            aria-hidden
          />
          <span className="min-w-[160px] font-medium text-foreground/90">
            {t('notes:editor.conflict_refreshed')}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <DsButton
              variant="ghost"
              size="sm"
              className={cn(
                'h-6 px-2 text-xs [@media(pointer:coarse)]:min-h-11',
                conflictDiffOpen
                  ? 'bg-[var(--interactive-hover)] text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setConflictDiffOpen((open) => !open)}
              aria-expanded={conflictDiffOpen}
              aria-controls={conflictDiffRegionId}
            >
              <GitDiff size={13} className="mr-1" aria-hidden />
              {conflictDiffOpen
                ? t('notes:editorV2.conflict_compare_hide', 'Hide comparison')
                : t('notes:editorV2.conflict_compare', 'Compare')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs [@media(pointer:coarse)]:min-h-11"
              onClick={() => resolveConflict('mine', conflictAction)}
            >
              {t('notes:editor.conflict_restore_mine')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:min-h-11"
              onClick={() => resolveConflict('remote', conflictAction)}
            >
              {t('notes:editor.conflict_keep_remote', 'Keep remote')}
            </DsButton>
          </div>
        </div>
      )}

      {/* 冲突「对比」：编辑器上方内联展开的只读 diff 区（grid-rows 0fr→1fr），
          非浮层、随文档流参与布局；reduced-motion 下瞬时切换 */}
      {conflictAction && (
        <div
          id={conflictDiffRegionId}
          className={cn(
            'grid flex-shrink-0 transition-[grid-template-rows] duration-200 ease-[var(--dropdown-ease,cubic-bezier(0.22,1,0.36,1))] motion-reduce:transition-none',
            conflictDiffOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
          aria-hidden={!conflictDiffOpen}
          // inert：收起时阻止内部按钮被 Tab 聚焦（React 18 类型未收录该属性，需绕过）
          {...(!conflictDiffOpen
            ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>)
            : {})}
        >
          <div
            className={cn(
              'min-h-0 overflow-hidden bg-background',
              // 收起（0fr）时内容高度为 0 但边框仍占 1px，会在横幅下多出一道线；仅展开时描边
              conflictDiffOpen && 'border-b border-border',
            )}
          >
            <div className="mx-auto w-full max-w-[var(--notes-content-max-w)] px-5 py-2 sm:px-12">
              <section
                aria-label={t('notes:editorV2.conflict_diff_title', 'My version vs remote version')}
                className="flex max-h-[min(40vh,360px)] flex-col overflow-hidden rounded-[var(--radius-shell-control,12px)] border border-border bg-card shadow-[0_1px_3px_hsl(var(--shadow-base)/0.08)]"
              >
                <div className="flex flex-shrink-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5">
                  <GitDiff size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 truncate text-xs font-medium">
                    {t('notes:editorV2.conflict_diff_title', 'My version vs remote version')}
                  </span>
                  {conflictDiffStats && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      <span className="text-[hsl(var(--success))]">+{conflictDiffStats.added}</span>
                      {' / '}
                      <span className="text-[hsl(var(--destructive))]">-{conflictDiffStats.removed}</span>
                    </span>
                  )}
                  <span className="ml-auto hidden shrink-0 text-[11px] text-muted-foreground/80 sm:inline">
                    {t('notes:editorV2.conflict_diff_legend', '+ mine · − remote')}
                  </span>
                </div>

                {conflictDiffLines ? (
                  conflictDiffStats && (conflictDiffStats.added > 0 || conflictDiffStats.removed > 0) ? (
                    <CustomScrollArea className="min-h-0 flex-1" viewportClassName="py-1">
                      <DiffHunksView lines={conflictDiffLines} />
                    </CustomScrollArea>
                  ) : (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      {t('notes:editorV2.conflict_diff_identical', 'Both versions are identical')}
                    </div>
                  )
                ) : conflictRemoteStatus === 'error' ? (
                  <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                    <span>{t('notes:editorV2.conflict_diff_load_failed', 'Could not load the remote version')}</span>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => { void fetchConflictRemote(); }}
                    >
                      {t('notes:editorV2.conflict_diff_retry', 'Retry')}
                    </DsButton>
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                    <CircleNotch size={14} className="animate-spin motion-reduce:animate-none" aria-hidden />
                    <span>{t('notes:editorV2.conflict_diff_loading', 'Loading remote version…')}</span>
                  </div>
                )}

                <div className="flex flex-shrink-0 items-center justify-end gap-1.5 border-t border-border/60 bg-muted/20 px-3 py-2">
                  <DsButton
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={() => resolveConflict('remote', conflictAction)}
                  >
                    {t('notes:editor.conflict_keep_remote', 'Keep remote')}
                  </DsButton>
                  <DsButton
                    size="sm"
                    className="h-7"
                    onClick={() => resolveConflict('mine', conflictAction)}
                  >
                    {t('notes:editor.conflict_restore_mine')}
                  </DsButton>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {/* 桌面编辑器风格的轻量 pane 操作栏；文档标题随正文滚动。 */}
      <div className="notes-editor-header-section sticky top-0 z-10 w-full flex-shrink-0 bg-background">
        <div className="notes-editor-chrome-row mx-auto flex w-full max-w-[var(--notes-content-max-w)] items-center gap-1 px-5 sm:px-12">
            <NotesEditorToolbar editor={editorApi} readOnly={effectiveReadOnly} />
          <div className="ml-auto flex items-center gap-1">
            {!readOnly && (
              <CommonTooltip content={t('notes:toolbar.note_templates', 'Note templates')} position="bottom">
                <DsButton
                  ref={templateTriggerRef}
                  variant="ghost"
                  iconOnly
                  size="sm"
                  className={cn(
                    'h-7 w-7 transition-colors',
                    templateMenuOpen
                      ? 'bg-[var(--interactive-hover)] text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setTemplateMenuOpen((prev) => !prev)}
                  aria-label={t('notes:toolbar.note_templates', 'Note templates')}
                  aria-expanded={templateMenuOpen}
                  aria-controls={templatePanelId}
                >
                  <NoteBlank size={16} />
                </DsButton>
              </CommonTooltip>
            )}
            <CommonTooltip content={t('notes:toolbar.ask_agent', 'Ask Agent')} position="bottom">
              <DsButton
                variant="ghost"
                iconOnly
                size="sm"
                className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => { void openQuickAssistantWindow(); }}
                aria-label={t('notes:toolbar.ask_agent', 'Ask Agent')}
              >
                <Robot size={16} />
              </DsButton>
            </CommonTooltip>
            {/* 查找替换按钮 */}
            <CommonTooltip content={t('notes:toolbar.find_replace')} position="bottom">
              <DsButton
                variant="ghost"
                iconOnly
                size="sm"
                className={cn(
                  'h-7 w-7 flex-shrink-0 transition-colors',
                  isFindReplaceOpen ? 'bg-[var(--interactive-hover)] text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setIsFindReplaceOpen((prev) => !prev)}
                aria-label={t('notes:toolbar.find_replace')}
                aria-pressed={isFindReplaceOpen}
              >
                <MagnifyingGlass size={16} />
              </DsButton>
            </CommonTooltip>
            {/* 阅读模式切换按钮 - 仅在非外部 readOnly 时显示 */}
            {!readOnly && (
              <CommonTooltip
                content={readingMode ? t('notes:toolbar.editing_mode') : t('notes:toolbar.reading_mode')}
                position="bottom"
              >
                <DsButton
                  variant="ghost"
                  iconOnly
                  size="sm"
                  className={cn(
                    "h-7 w-7 flex-shrink-0 transition-colors",
                    readingMode
                      ? "bg-[var(--interactive-hover)] text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => {
                    const next = !readingMode;
                    // 进入阅读模式时先 flush 草稿，防止丢失未保存内容
                    if (next) {
                      void flushNoteDraft().catch(() => {});
                    }
                    setReadingMode(next);
                    // readonly 状态由 CrepeEditor 的 readonly prop 自动同步，无需手动调用 setReadonly
                  }}
                  aria-label={readingMode ? t('notes:toolbar.editing_mode') : t('notes:toolbar.reading_mode')}
                  aria-pressed={readingMode}
                >
                  {readingMode ? <BookOpen size={16} /> : <PencilLine size={16} />}
                </DsButton>
              </CommonTooltip>
            )}
            <CommonTooltip
              content={`${focusMode ? t('notes:toolbar.exit_focus_mode', 'Exit focus mode') : t('notes:toolbar.focus_mode', 'Focus mode')} (${isMacOS() ? '⌘⇧U' : 'Ctrl+Shift+U'})`}
              position="bottom"
            >
              <DsButton
                variant="ghost"
                iconOnly
                size="sm"
                className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-foreground"
                onClick={toggleFocusMode}
                aria-label={focusMode ? t('notes:toolbar.exit_focus_mode', 'Exit focus mode') : t('notes:toolbar.focus_mode', 'Focus mode')}
                aria-pressed={focusMode}
              >
                {focusMode ? <CornersIn size={16} /> : <CornersOut size={16} />}
              </DsButton>
            </CommonTooltip>
            {headerActions}
          </div>
        </div>

        {/* 模板内联面板：编辑器顶部随文档流展开（grid-rows 0fr→1fr），无浮层遮挡；
            方向键在卡片间移动、Enter 应用、Esc 收起（见 NotesTemplatePanel） */}
        {!readOnly && (
          <NotesTemplatePanel
            open={templateMenuOpen}
            onRequestClose={() => setTemplateMenuOpen(false)}
            onApplyTemplate={(template) => applyTemplate(template.markdown)}
            disabled={effectiveReadOnly || !editorApi}
            panelId={templatePanelId}
            triggerRef={templateTriggerRef}
          />
        )}

        {/* ★ 2.1 AI 编辑检查点：接受后仍可整轮回滚。
            内联 info bar（参与布局、不遮挡文档标题），随 pane 顶栏保持可见 */}
        {aiCheckpoint && !aiEditState.isActive && (
          <div className="notes-ai-checkpoint-bar w-full border-t border-border/50 bg-[hsl(var(--primary)/0.05)] ui-rise-in" role="status">
            <div className="mx-auto flex w-full max-w-[var(--notes-content-max-w)] items-center gap-2 px-5 py-1.5 sm:px-12">
              <Robot size={14} className="text-primary shrink-0" />
              <span className="min-w-0 truncate text-xs text-foreground">{t('notes:aiCheckpoint.applied')}</span>
              <div className="ml-auto flex flex-shrink-0 items-center gap-1">
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:min-h-11"
                  onClick={() => { void rollbackCheckpoint(); }}
                >
                  <ArrowCounterClockwise size={12} className="mr-1" />
                  {t('notes:aiCheckpoint.rollback')}
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                  onClick={dismissCheckpoint}
                  aria-label={t('notes:aiCheckpoint.keep')}
                >
                  <X size={12} />
                </DsButton>
              </div>
            </div>
          </div>
        )}
      </div>

      {focusMode && (
        <CommonTooltip content={`${t('notes:toolbar.exit_focus_mode', 'Exit focus mode')} (${isMacOS() ? '⌘⇧U' : 'Ctrl+Shift+U'})`} position="left">
          <DsButton
            variant="ghost"
            iconOnly
            size="sm"
            className="notes-focus-exit h-8 w-8"
            onClick={toggleFocusMode}
            aria-label={t('notes:toolbar.exit_focus_mode', 'Exit focus mode')}
          >
            <CornersIn size={17} />
          </DsButton>
        </CommonTooltip>
      )}
      
      {/* 查找替换面板 - 固定在 header 下方，不随内容滚动 */}
      <div className="relative" ref={findReplaceContainerRef}>
        {isFindReplaceOpen && (
          <FindReplacePanel 
            editorApi={editorApi}
            onClose={handleFindReplaceClose}
            readOnly={effectiveReadOnly}
            initialQuery={findInitialQuery}
          />
        )}
      </div>

      {/* AI 编辑 Diff：编辑器上方内联卡片区（有界高度），正文保持可见可滚动 */}
      {aiEditState.isActive && (
        <AIDiffPanel
          state={aiEditState}
          onAccept={handleAccept}
          onReject={handleReject}
          isApplying={isAIEditApplying}
          suspendShortcuts={isFindReplaceOpen}
        />
      )}

      <CustomScrollArea
        className="notes-editor-content-scroll flex-1"
        viewportClassName="overflow-x-visible"
        viewportRef={scrollViewportRef}
        viewportProps={{ onScroll: handleViewportScroll }}
      >
        {/* 编辑器内容区域 */}
        <div
          className="notes-editor-content w-full max-w-[var(--notes-content-max-w)] mx-auto min-h-full px-5 sm:px-12 relative flex flex-col"
          style={{
            // P0-3：移动端底部 padding = 工具条实际高度 + 实际键盘遮挡 + safe-area + 滚过末尾余量。
            // 两个变量由 MobileEditorToolbar 写在 :root（隐藏时移除，走 fallback）。
            paddingBottom: showMobileToolbar
              ? 'calc(var(--mobile-toolbar-height, 52px) + var(--mobile-toolbar-keyboard-offset, 0px) + var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 12vh)'
              : '30vh',
          }}
          ref={dropZoneRef}
        >
          <NotesEditorHeader
            lastSaved={lastSaved}
            saveStatus={saveStatus}
            onRetrySave={effectiveReadOnly ? undefined : handleManualSave}
            charCount={charCount}
            initialTitle={isDstuMode ? initialTitle : undefined}
            onTitleChange={isDstuMode && !effectiveReadOnly ? dstuOnTitleChange : undefined}
            noteId={noteId}
            readOnly={effectiveReadOnly}
            tags={tags}
            onTagsChange={effectiveReadOnly ? undefined : onTagsChange}
          />
          <CrepeEditor
            key={contentVersionKey}
            noteId={noteId}
            className="flex-1 min-h-[40vh] ui-rise-in"
            defaultValue={initialValue}
            onChange={handleChange}
            onReady={handleEditorReady}
            readonly={effectiveReadOnly}
            plugins={{
              wikilink: buildWikilinkPluginHostConfig(),
            }}
          />
          {windowingState?.enabled && (windowingState.hasMore || windowingState.isLoadingMore || windowingState.loadMoreError) && (
            <div className="mt-6 flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground/70">
              {windowingState.isLoadingMore ? (
                <>
                  <CircleNotch size={14} className="animate-spin text-primary" />
                  <span>{t('notes:editor.windowing.loading_more')}</span>
                </>
              ) : windowingState.loadMoreError ? (
                <>
                  <span>{t('notes:editor.windowing.load_more_failed')}</span>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={onRetryLoadMore}
                  >
                    {t('notes:editor.windowing.retry')}
                  </DsButton>
                </>
              ) : null}
            </div>
          )}
        </div>
      </CustomScrollArea>

      <MobileEditorToolbar
        visible={showMobileToolbar}
        collapsed={mobileToolbarCollapsed}
        commands={mobileCommands}
        activeStates={mobileActiveStates}
      />
    </div>
    </ErrorBoundary>
  );
};

export default NotesCrepeEditor;
