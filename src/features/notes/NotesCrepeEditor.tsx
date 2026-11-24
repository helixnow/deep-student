/**
 * 笔记模块 Crepe 编辑器（基于 @milkdown/crepe 的 Markdown 编辑器）
 *
 * 编排层职责：
 * - 组合 save engine / conflict / focus mode / AI review 等独立 hook
 * - 托管 CrepeEditor 生命周期、全文 API、窗口化懒加载与跨组件事件桥接
 * - 渲染顶栏 chrome、横幅区、正文滚动区与历史/模板/查找/移动工具条
 */

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowCounterClockwise, BookOpen, CaretDown, CircleNotch, Code, CornersIn, DotsThree, ImageSquare, PencilLine, Robot, Sparkle, TreeStructure, X } from '@phosphor-icons/react';
import { editorViewCtx } from '@milkdown/kit/core';
import type { EditorState } from '@milkdown/prose/state';
import type { CrepeFormattingState } from '@/components/crepe/formattingState';
import { CrepeEditor, type CrepeEditorApi } from '@/components/crepe';
import { isSelectionClozed, isSelectionHighlighted, toggleClozeSelection, toggleHighlightSelection } from '@/components/crepe/plugins/highlight';
import type { CrepeSelectionAction } from '@/components/crepe/types';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useMobileResourceMenu } from '@/components/layout/MobileResourceMenuContext';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { ImageOcclusionBuilderModal } from '@/components/anki/occlusion/ImageOcclusionBuilderModal';
import { dispatchTypedEvent } from '@/events/registry';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useTauriDragAndDrop } from '@/hooks/useTauriDragAndDrop';
import { SelectionToolbar, useTextSelection } from '@/shared/selection';
import { cn } from '@/utils/cn';
import { getErrorMessage } from '@/utils/errorUtils';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { isMacOS, isMobilePlatform } from '@/utils/platform';
import { openQuickAssistantWindow } from '@/quick-assistant/window';
import { insertWikilink } from '@/components/crepe/plugins/wikilink/autocomplete';
import { parseWorkbenchDragData, WB_RESOURCE_MIME } from '@/features/workbench/hooks/useDesktopDrop';
import type { ContentSaveState } from '@/features/workbench/apps/content/contentDirtyRegistry';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { requestHandoutSyncToMindmap } from '@/ui-kernel/services/handoutSyncBridge';
import { extractProvenanceLinksFromHandout } from '@/ui-kernel/services/mindmapHandoutBridge';
import { emitOutlineDebugLog, emitOutlineDebugSnapshot } from '../../debug-panel/events/NotesOutlineDebugChannel';

import { AIDiffPanel } from './AIDiffPanel';
import { useAIReview } from './aiReview';
import { isReviewShortcut } from './aiReviewModel';
import { resolveBannerSlots, type BannerId } from './bannerPriority';
import { FindReplacePanel } from './components/FindReplacePanel';
import { MobileEditorToolbar } from './components/MobileEditorToolbar';
import { NoteFloatingToc } from './components/NoteFloatingToc';
import type { NoteSourceEditorHandle } from './components/NoteSourceEditor';
import { NotesConflictBanner } from './components/NotesConflictBanner';
import { NotesEditorHeader, type NoteBreadcrumbItem } from './components/NotesEditorHeader';
import { NotesPageActionsMenu } from './components/NotesPageActionsMenu';
import { NotesReviewCheckinBanner } from './components/NotesReviewCheckinBanner';
import { NotesSaveIndicator } from './components/NotesSaveIndicator';
import { NotesTemplatePanel } from './components/NotesTemplatePanel';
import { NOTES_ACTIVE_HEADING_EVENT, normalizeActiveHeadingText, type NotesActiveHeadingDetail } from './components/outlineActiveHeadingBridge';
import { CREATE_FROM_WIKILINK_EVENT, createNoteFromWikilinkTitle, parseCreateFromWikilinkEvent, refreshWikilinksAfterCreate } from './createFromWikilink';
import { consumeNotesFindQuery, NOTES_FIND_QUERY_EVENT, type NotesFindQuery } from './findQueryBridge';
import { createFullDocumentApi, type FullDocumentApi, type FullDocumentSearchApi, type FullDocumentViewHost } from './fullDocument';
import { generateCardsFromNote, readNoteMarkdown } from './generateCardsFromNote';
import { consumeNotesHeadingTarget, NOTES_HEADING_TARGET_EVENT, notesHeadingTargetMatches, type NotesHeadingTarget } from './headingTargetBridge';
import { useNoteConflict } from './hooks/useNoteConflict';
import { prefersReducedMotion, useNoteFocusMode } from './hooks/useNoteFocusMode';
import { AUTO_SAVE_DEBOUNCE_MS, countNoteChars, fullMarkdownForReporting, useNoteSaveEngine } from './hooks/useNoteSaveEngine';
import { emitNoteBlockAutoExcerpt, registerNoteBlockRevealHandler } from './inlineCards/noteBlockExcerptBridge';
import { mergeExpandedMarkdown, shouldRequestLoadMore, type MarkdownLoadMoreResult } from './markdownWindow';
import { buildMobileEditorCommands } from './mobileEditorCommands';
import { applyNoteFormat, applyReviewedNote, bindNoteEditorHost, readNoteFormat, resetNoteUndo } from './noteEditorHost';
import { NoteFormatGate } from './NoteFormatGate';
import { NoteHistoryPanel } from './NoteHistoryPanel';
import { noteHostCoordinator } from './noteHostCoordinator';
import { resolveNoteReviewScope, saveReviewAs } from './noteReviewHost';
import { useNotesChromeSlot } from './notesChromeSlot';
import { captureTemplateInsertion, templateDocumentHost, type TemplateInsertionBookmark } from './noteTemplateHost';
import { applyNoteTemplate, fillUnsetTemplateLearningProps, type NoteTemplate, type NoteTemplateLearningPropsHost } from './noteTemplates';
import { consumeNotesQuoteTarget, findQuoteBlockIndex, NOTES_QUOTE_TARGET_EVENT, type NotesQuoteTarget } from './quoteTarget';
import { useTemplateLearningPropsHost } from './useTemplateLearningPropsHost';
import { buildWikilinkPluginHostConfig, refreshWikilinkNotesCache } from './wikilinkNotesCache';

import '@/styles/notes-typography.css';
import './styles/notes-editor-chrome.css';

/** 源码模式编辑器懒加载：@codemirror/lang-markdown 仅在用户切换到 Markdown 源码视图时拉取 */
const NoteSourceEditor = React.lazy(() =>
  import('./components/NoteSourceEditor').then((module) => ({
    default: module.NoteSourceEditor,
  })),
);

/** 「荧光笔高亮」浮条图标（24×24 填充，Material border_color，Apache-2.0） */
const HIGHLIGHT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M17.75 7L14 3.25l-10 10V17h3.75l10-10zm2.96-2.96c.39-.39.39-1.02 0-1.41L18.37.29a.9959.9959 0 0 0-1.41 0L15 2.25 18.75 6l1.96-1.96zM2 20h20v4H2v-4z"/></svg>';
/** 「挖空制卡」浮条图标（24×24 填充，Material style / Cloze，Apache-2.0） */
const CLOZE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 5h4v2H6v10h2v2H4V5zm16 0v14h-4v-2h2V7h-2V5h4zM9 11h6v2H9v-2z"/></svg>';
/** 「问 AI」浮条图标（24×24 填充，Sparkle，Apache-2.0） */
const ASK_AI_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4L12 2zm7 14l1 2.7L22.7 20 20 21l-1 2.7L18 21l-2.7-1 2.7-1 1-2.7z"/></svg>';
/** 「加入聊天」浮条图标（24×24 填充，Material add_comment，Apache-2.0） */
const ADD_TO_CHAT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M22 4c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4zm-2 13.17L18.83 16H4V4h16v13.17zM13 5h-2v4H7v2h4v4h2v-4h4V9h-4z"/></svg>';
/** 「摘录到导图」浮条图标（24×24 填充，Material account_tree，Apache-2.0） */
const EXCERPT_TO_MINDMAP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z"/></svg>';

/** 专注模式下仅保留的数据安全/阻断级与进行中的交互式 AI 审阅横幅（排除 header-section 隐藏 DOM 与非关键提示） */
const FOCUS_MODE_CRITICAL_BANNERS: ReadonlySet<BannerId> = new Set<BannerId>([
  'conflict',
  'host-refresh-error',
  'draft-persistence-error',
  'recovery-draft',
  'ai-diff',
  'ai-collapsed',
]);

// ── 移动端底部工具条单实例门控 ──
// 多个可见编辑器实例（分屏/多面板）以"最近交互（focusin/pointerdown）"的实例为唯一持有者。
let mobileToolbarOwnerId: string | null = null;
const mobileToolbarOwnerListeners = new Set<() => void>();
const notifyMobileToolbarOwnerChange = () => { mobileToolbarOwnerListeners.forEach((fn) => fn()); };
const claimMobileToolbarOwner = (id: string) => { if (mobileToolbarOwnerId !== id) { mobileToolbarOwnerId = id; notifyMobileToolbarOwnerChange(); } };
const releaseMobileToolbarOwner = (id: string) => { if (mobileToolbarOwnerId === id) { mobileToolbarOwnerId = null; notifyMobileToolbarOwnerChange(); } };
const subscribeMobileToolbarOwner = (fn: () => void) => { mobileToolbarOwnerListeners.add(fn); return () => { mobileToolbarOwnerListeners.delete(fn); }; };
const getMobileToolbarOwner = () => mobileToolbarOwnerId;

export type NotesEditorWindowingState = {
  enabled: boolean;
  loadedLineCount: number;
  totalLineCount: number;
  hasMore: boolean;
  isLoadingMore?: boolean;
  loadMoreError?: string | null;
  preloadPx?: number;
};

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
  /** Add host-owned full-document operations before any editor consumer receives the API. */
  extendEditorApi?: (api: CrepeEditorApi) => CrepeEditorApi;
  /** ACR R1-13：编辑器 API 就绪/销毁回调（供 workbench noteDriver 注册表）。 */
  onEditorApiReady?: (api: CrepeEditorApi | null, previousApi?: CrepeEditorApi) => void;
  /** Optional save-state bridge for owning tab strips. */
  onSaveStateChange?: (state: ContentSaveState) => void;
  /** ACR R1-13：存在时把 isCurrentNoteDirty 挂到 contentDirtyRegistry（probe / canClose）。 */
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
  /** 移动端抽屉/子屏打开或标签不活跃期间置 true，暂时隐藏 body 级底部工具条。 */
  suppressMobileToolbar?: boolean;
  /** DSTU 文档面包屑路径（由工作区或资源库宿主传入） */
  breadcrumbs?: readonly NoteBreadcrumbItem[];
  /** 点击面包屑项时的宿主导航回调 */
  onBreadcrumbClick?: (item: NoteBreadcrumbItem) => void;
  /** 右侧常驻大纲面板已打开时抑制画布右侧悬浮目录 */
  suppressFloatingToc?: boolean;
}

export const NotesCrepeEditor: React.FC<NotesCrepeEditorProps> = (props) => (
  <NoteFormatGate noteId={props.noteId}>
    <NotesCrepeEditorBody {...props} />
  </NoteFormatGate>
);

const NotesCrepeEditorBody: React.FC<NotesCrepeEditorProps> = ({
  initialContent = '',
  initialTitle,
  onSave,
  onTitleChange,
  noteId,
  readOnly = false,
  className,
  headerActions,
  onEditorReady,
  extendEditorApi,
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
  breadcrumbs,
  onBreadcrumbClick,
  suppressFloatingToc = false,
}) => {
  const { t, i18n } = useTranslation(['notes', 'common', 'chatV2']);
  const hostInstanceId = useId();
  const templatePanelId = useId();
  const mobileToolbarInstanceId = useId();

  // ── 编辑器实例与 DOM 引用 ──
  const [editorApi, setEditorApi] = useState<CrepeEditorApi | null>(null);
  const lifecycleApiRef = useRef<CrepeEditorApi | null>(null);
  const baseApiRef = useRef<CrepeEditorApi | null>(null);
  const editorNoteIdRef = useRef<string | null>(null);
  const [hostBusy, setHostBusy] = useState(false);
  const [hostRefreshError, setHostRefreshError] = useState<string | null>(null);
  const programmaticUpdateRef = useRef(false);
  const currentRenderedNoteRef = useRef<string | null>(null);
  currentRenderedNoteRef.current = noteId ?? null;
  const loadMoreInFlightRef = useRef(false);
  const lastAppliedWindowLineCountRef = useRef<number | null>(null);
  const windowingStateRef = useRef(windowingState);
  windowingStateRef.current = windowingState;

  const dropZoneRef = useRef<HTMLDivElement>(null);
  const selectionContainerRef = useRef<HTMLDivElement>(null);
  const noteSelection = useTextSelection(selectionContainerRef);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const notesShellRef = useRef<HTMLDivElement>(null);
  const findReplaceContainerRef = useRef<HTMLDivElement | null>(null);
  const templateTriggerRef = useRef<HTMLButtonElement | null>(null);
  const templateInsertionRef = useRef<TemplateInsertionBookmark | null>(null);
  const pageActionsRef = useRef<HTMLDivElement | null>(null);
  const pendingTemplatePropsRef = useRef<{
    template: NoteTemplate;
    markdown: string;
    baseline: ReturnType<NoteTemplateLearningPropsHost['getProps']>;
    next: Record<string, unknown>;
  } | null>(null);

  // ── 模式与面板 UI 状态 ──
  const [readingMode, setReadingMode] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const sourceModeRef = useRef(false);
  sourceModeRef.current = sourceMode;
  const [sourceDraft, setSourceDraft] = useState(initialContent);
  const sourceDraftRef = useRef(initialContent);
  sourceDraftRef.current = sourceDraft;
  const sourceEditorRef = useRef<NoteSourceEditorHandle | null>(null);
  const pendingSourceFocusRef = useRef(false);
  const togglingSourceModeRef = useRef(false);
  const [liveTocMarkdown, setLiveTocMarkdown] = useState(initialContent);
  const tocSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishActiveHeadingRef = useRef<() => void>(() => {});
  const [isReviewDue, setIsReviewDue] = useState(false);
  const [selectedCharCount, setSelectedCharCount] = useState(0);
  const [bannerQueueExpanded, setBannerQueueExpanded] = useState(false);
  const [isFindReplaceOpen, setIsFindReplaceOpen] = useState(false);
  const [findInitialQuery, setFindInitialQuery] = useState('');
  const [charCount, setCharCount] = useState<number | undefined>(undefined);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [generatingCards, setGeneratingCards] = useState(false);
  const [generatingMindmap, setGeneratingMindmap] = useState(false);
  const [syncingHandout, setSyncingHandout] = useState(false);
  const [pageActionsOpen, setPageActionsOpen] = useState(false);

  const effectiveReadOnly = readOnly || readingMode || hostBusy || hostRefreshError !== null;
  const userReadOnlyRef = useRef(readOnly || readingMode);
  userReadOnlyRef.current = readOnly || readingMode;
  const learningPropsHost = useTemplateLearningPropsHost(noteId, effectiveReadOnly);

  // ── 1. 焦点模式 ──
  const focus = useNoteFocusMode({ focusModeScopeId });

  const handleExternalContentSync = useCallback((nextMarkdown: string) => {
    setSourceDraft(nextMarkdown);
    setLiveTocMarkdown(nextMarkdown);
  }, []);

  // ── 2. 自动保存 / 草稿恢复 / 脏状态引擎 ──
  const save = useNoteSaveEngine({
    noteId, initialContent, initialTitle, onSave, readOnly, effectiveReadOnly,
    acrWindowId, hostInstanceId, dirtyRegistryKey, onSaveStateChange,
    editorApi, lifecycleApiRef, editorNoteIdRef, currentRenderedNoteRef,
    programmaticUpdateRef, dropZoneRef, onCharCountChange: setCharCount,
    sourceModeRef, onExternalContentSync: handleExternalContentSync,
  });

  // ── 3. 保存冲突与内联 Diff 对比 ──
  const conflict = useNoteConflict({
    noteId,
    noteIdRef: save.noteIdRef,
    contentRef: save.contentRef,
    isUnmountedRef: save.isUnmountedRef,
    onConflictDetected: () => save.setSaveError('conflict'),
    onConflictResolved: () => save.setSaveError(null),
  });

  // ── 切换笔记 / 只读态复位 ──
  const initialCharSourceRef = useRef('');
  initialCharSourceRef.current = initialContent;
  useEffect(() => {
    const api = editorNoteIdRef.current === noteId ? lifecycleApiRef.current : null;
    const full = api
      ? fullMarkdownForReporting(api, initialCharSourceRef.current)
      : windowingStateRef.current?.hasMore ? undefined : initialCharSourceRef.current;
    setCharCount(full === undefined ? undefined : countNoteChars(full));
  }, [noteId]);

  useEffect(() => {
    if (tocSyncTimerRef.current) {
      clearTimeout(tocSyncTimerRef.current);
      tocSyncTimerRef.current = null;
    }
    setHistoryOpen(false);
    setTemplateMenuOpen(false);
    setIsFindReplaceOpen(false);
    setFindInitialQuery('');
    sourceModeRef.current = false;
    pendingSourceFocusRef.current = false;
    togglingSourceModeRef.current = false;
    setSourceMode(false);
    setIsReviewDue(false);
    setBannerQueueExpanded(false);
    setSelectedCharCount(0);
    setLiveTocMarkdown(initialCharSourceRef.current);
    setSourceDraft(initialCharSourceRef.current);
    save.fullViewMaterializedRef.current = false;
    templateInsertionRef.current = null;
    pendingTemplatePropsRef.current = null;
    setHostBusy(!!noteId && save.lockedNotesRef.current.has(noteId));
    setHostRefreshError(noteId && save.invalidNotesRef.current.has(noteId) ? t('notes:host.pending_refresh', '笔记等待刷新。') : null);
    save.bumpDocumentRevision();
  }, [noteId, save.bumpDocumentRevision, save.fullViewMaterializedRef, save.invalidNotesRef, save.lockedNotesRef, t]);

  useEffect(() => () => {
    if (tocSyncTimerRef.current) {
      clearTimeout(tocSyncTimerRef.current);
      tocSyncTimerRef.current = null;
    }
  }, []);

  const clearNoteSelectionRef = useRef(noteSelection.clear);
  clearNoteSelectionRef.current = noteSelection.clear;
  useEffect(() => {
    clearNoteSelectionRef.current();
    setSelectedCharCount(0);
  }, [noteId, sourceMode]);

  useEffect(() => { if (effectiveReadOnly) setTemplateMenuOpen(false); }, [effectiveReadOnly]);

  // ── 响应式视口、宿主 chrome slot 与移动端底部工具条门控 ──
  const isCoarsePointer = useMediaQuery('(pointer: coarse)');
  const isSmallScreen = useIsMobile();
  const mobileResourceMenu = useMobileResourceMenu();
  const hasMobileResourceMenu = isSmallScreen && mobileResourceMenu !== undefined;
  const notesChromeSlot = useNotesChromeSlot();
  const isTouchEditingSurface = isSmallScreen || isCoarsePointer;

  useEffect(() => { setPageActionsOpen(false); }, [noteId, hasMobileResourceMenu]);
  useEffect(() => {
    if (!pageActionsOpen) return;
    const frame = requestAnimationFrame(() => {
      pageActionsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pageActionsOpen]);

  const [shellInViewport, setShellInViewport] = useState(true);
  const wantsMobileToolbar = isTouchEditingSurface && !effectiveReadOnly && !sourceMode && !!editorApi && !suppressMobileToolbar && shellInViewport;
  const mobileToolbarOwner = useSyncExternalStore(subscribeMobileToolbarOwner, getMobileToolbarOwner);
  useEffect(() => {
    if (!wantsMobileToolbar) return undefined;
    return () => releaseMobileToolbarOwner(mobileToolbarInstanceId);
  }, [wantsMobileToolbar, mobileToolbarInstanceId]);
  useEffect(() => {
    if (wantsMobileToolbar && mobileToolbarOwner === null) claimMobileToolbarOwner(mobileToolbarInstanceId);
  }, [wantsMobileToolbar, mobileToolbarOwner, mobileToolbarInstanceId]);
  const showMobileToolbar = wantsMobileToolbar && mobileToolbarOwner === mobileToolbarInstanceId;

  const [formattingState, setFormattingState] = useState<CrepeFormattingState>({});
  const handleFormattingChange = useCallback((next: CrepeFormattingState) => {
    setFormattingState((cur) => Object.keys(next).every((k) => cur[k as keyof CrepeFormattingState] === next[k as keyof CrepeFormattingState]) ? cur : next);
  }, []);

  useEffect(() => {
    if (!isTouchEditingSurface && !notesChromeSlot) { setShellInViewport(true); return undefined; }
    const shell = notesShellRef.current;
    if (!shell) return undefined;
    setShellInViewport(shell.getClientRects().length > 0);
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setShellInViewport(entry.isIntersecting);
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, [isTouchEditingSurface, notesChromeSlot]);

  useEffect(() => {
    if (!wantsMobileToolbar) return undefined;
    const shell = notesShellRef.current;
    if (!shell) return undefined;
    const claim = () => claimMobileToolbarOwner(mobileToolbarInstanceId);
    shell.addEventListener('focusin', claim);
    shell.addEventListener('pointerdown', claim);
    return () => { shell.removeEventListener('focusin', claim); shell.removeEventListener('pointerdown', claim); };
  }, [wantsMobileToolbar, mobileToolbarInstanceId]);

  const mobileCommands = buildMobileEditorCommands(editorApi, {
    noteId,
    enableGenerateCards: true,
    noteTitle: initialTitle,
    openFind: () => setIsFindReplaceOpen(true),
  });

  // ── 笔记工具动作（模板 / 制卡 / 导图 / 讲义回写） ──
  const applyTemplate = useCallback(async (template: NoteTemplate) => {
    if (!editorApi || effectiveReadOnly) return;
    try {
      const api = editorApi as FullDocumentApi;
      const baseline = api.getFullDocument();
      const pending = pendingTemplatePropsRef.current;
      if (pending && pending.template === template && pending.baseline.noteId === baseline.noteId && pending.markdown === baseline.markdown) {
        await learningPropsHost.saveProps(pending.next, pending.baseline);
        pendingTemplatePropsRef.current = null;
        setTemplateMenuOpen(false);
        return;
      }
      const propsBaseline = template.learningPreset ? learningPropsHost.getProps() : undefined;
      const saved = await api.replaceFullDocument(
        applyNoteTemplate(baseline.markdown, template.markdown, { title: initialTitle ?? '', locale: i18n?.resolvedLanguage ?? i18n?.language }),
        baseline,
      );
      setSourceDraft(saved.markdown);
      setLiveTocMarkdown(saved.markdown);
      if (propsBaseline && template.learningPreset) {
        const next = fillUnsetTemplateLearningProps(propsBaseline.props, template.learningPreset);
        pendingTemplatePropsRef.current = { template, markdown: saved.markdown, baseline: propsBaseline, next };
        await learningPropsHost.saveProps(next, propsBaseline);
        pendingTemplatePropsRef.current = null;
      }
      api.focus();
      setTemplateMenuOpen(false);
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [editorApi, effectiveReadOnly, initialTitle, i18n, learningPropsHost]);

  const handleGenerateCards = useCallback(() => {
    if (!editorApi || generatingCards) return;
    setGeneratingCards(true);
    void generateCardsFromNote({
      editor: editorApi, noteTitle: initialTitle, noteId,
      translate: (key, defaultValue) => { const r = t(key, { defaultValue }); return typeof r === 'string' ? r : defaultValue; },
    }).finally(() => setGeneratingCards(false));
  }, [editorApi, generatingCards, initialTitle, noteId, t]);

  const handleGenerateMindmap = useCallback(() => {
    if (!editorApi || generatingMindmap) return;
    setGeneratingMindmap(true);
    void import('./noteToMindmap').then(({ generateMindmapFromNote }) => generateMindmapFromNote({
      markdown: readNoteMarkdown(editorApi), noteTitle: initialTitle ?? '', noteId,
      translate: (key, defaultValue, options) => { const r = t(key, { defaultValue, ...options }); return typeof r === 'string' ? r : defaultValue; },
    })).finally(() => setGeneratingMindmap(false));
  }, [editorApi, generatingMindmap, initialTitle, noteId, t]);

  const handleSyncHandoutToMindmap = useCallback(() => {
    if (!editorApi || !noteId || syncingHandout) return;
    const markdown = readNoteMarkdown(editorApi);
    if (!markdown.trim()) {
      showGlobalNotification('error', t('notes:generateMindmap.syncEmpty', '这篇笔记还没有正文，无法同步回导图'));
      return;
    }
    const mindmapIds = [...new Set(
      extractProvenanceLinksFromHandout(markdown).filter((l) => l.anchor.kind === 'mindmap').map((l) => l.anchor.resourceId.trim()).filter(Boolean),
    )];
    if (mindmapIds.length === 0) {
      showGlobalNotification('error', t('notes:generateMindmap.syncNoSource', '这篇笔记没有来自思维导图的出处，先从导图导出一份精读讲义再同步'));
      return;
    }
    if (mindmapIds.length > 1) {
      showGlobalNotification('warning', t('notes:generateMindmap.syncMultipleSources', { count: mindmapIds.length, defaultValue: '这篇笔记引用了 {{count}} 张不同的导图，请拆分讲义后分别同步' }));
      return;
    }
    setSyncingHandout(true);
    void requestHandoutSyncToMindmap({ noteId, noteTitle: initialTitle ?? undefined, mindmapId: mindmapIds[0]!, markdown })
      .then((summary) => {
        if (!summary.ok) {
          showGlobalNotification('warning', summary.reason === 'mindmap-not-open' || summary.reason === 'timeout'
            ? t('notes:generateMindmap.syncNotOpen', '请先打开原思维导图再同步')
            : t('notes:generateMindmap.syncEmpty', '这篇笔记还没有正文，无法同步回导图'));
          return;
        }
        if (summary.updated === 0 && summary.added === 0) {
          showGlobalNotification('info', t('notes:generateMindmap.syncNoChanges', '讲义与导图已经一致，无需同步'));
          return;
        }
        showGlobalNotification('success', t('notes:generateMindmap.syncSuccess', {
          updated: summary.updated, added: summary.added,
          defaultValue: '已同步回思维导图：更新 {{updated}} 个节点，新增 {{added}} 个节点',
        }));
      })
      .catch((error) => showGlobalNotification('error', t('notes:generateMindmap.syncFailed', { error: getErrorMessage(error), defaultValue: '同步回思维导图失败：{{error}}' })))
      .finally(() => setSyncingHandout(false));
  }, [editorApi, noteId, syncingHandout, initialTitle, t]);

  // ── 选区操作（高亮 / 挖空制卡 / 问 AI / 引用到聊天 / 摘录到导图） ──
  const scheduleTocMarkdownSync = useCallback((fallback: string, immediate = false) => {
    if (tocSyncTimerRef.current) {
      clearTimeout(tocSyncTimerRef.current);
      tocSyncTimerRef.current = null;
    }
    const commit = () => {
      const full = fullMarkdownForReporting(lifecycleApiRef.current, fallback, sourceModeRef.current) ?? fallback;
      setLiveTocMarkdown((prev) => (prev === full ? prev : full));
    };
    if (immediate) {
      commit();
    } else {
      tocSyncTimerRef.current = setTimeout(() => {
        tocSyncTimerRef.current = null;
        if (!save.isUnmountedRef.current) commit();
      }, 200);
    }
  }, [save.isUnmountedRef]);

  useEffect(() => {
    const onContentChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId?: string; content?: string }>).detail;
      if (!detail || detail.noteId !== noteId || typeof detail.content !== 'string') return;
      setLiveTocMarkdown((prev) => (prev === detail.content ? prev : detail.content!));
    };
    window.addEventListener('notes:content-changed', onContentChanged);
    return () => window.removeEventListener('notes:content-changed', onContentChanged);
  }, [noteId]);

  const handleRichEditorChange = useCallback((nextMarkdown: string) => {
    scheduleTocMarkdownSync(nextMarkdown, false);
    save.handleChange(nextMarkdown);
  }, [scheduleTocMarkdownSync, save.handleChange]);

  const handleSourceChange = useCallback((nextMarkdown: string) => {
    setSourceDraft(nextMarkdown);
    setLiveTocMarkdown(nextMarkdown);
    save.handleDocumentChange();
    save.handleChange(nextMarkdown);
  }, [save.handleChange, save.handleDocumentChange]);

  const handleSourceEditorRef = useCallback((instance: NoteSourceEditorHandle | null) => {
    sourceEditorRef.current = instance;
    if (instance && pendingSourceFocusRef.current && sourceModeRef.current) {
      pendingSourceFocusRef.current = false;
      requestAnimationFrame(() => {
        if (sourceModeRef.current) instance.focus();
      });
    }
  }, []);

  const handleToggleSourceMode = useCallback(() => {
    if (togglingSourceModeRef.current) return;
    if (!sourceModeRef.current) {
      togglingSourceModeRef.current = true;
      setIsFindReplaceOpen(false);
      setTemplateMenuOpen(false);
      clearNoteSelectionRef.current();
      setSelectedCharCount(0);

      const enterSourceMode = async () => {
        try {
          const isWindowed =
            editorApi?.isDocumentWindowed?.() ?? windowingStateRef.current?.hasMore === true;
          const materialize = (editorApi as FullDocumentSearchApi | null)?.materializeFullDocument;
          if (isWindowed && typeof materialize === 'function') {
            await materialize();
          }
          if (save.isUnmountedRef.current || currentRenderedNoteRef.current !== (noteId ?? null)) return;
          const snapshot =
            fullMarkdownForReporting(editorApi, save.contentRef.current || initialCharSourceRef.current) ??
            editorApi?.getMarkdown?.() ??
            save.contentRef.current ??
            initialCharSourceRef.current;
          save.contentRef.current = snapshot;
          if (noteId) {
            save.draftByNoteRef.current.set(noteId, snapshot);
          }
          setSourceDraft(snapshot);
          setLiveTocMarkdown(snapshot);
          setCharCount(countNoteChars(snapshot));
          sourceModeRef.current = true;
          pendingSourceFocusRef.current = true;
          setSourceMode(true);
          requestAnimationFrame(() => {
            if (sourceModeRef.current && sourceEditorRef.current) {
              pendingSourceFocusRef.current = false;
              sourceEditorRef.current.focus();
            }
          });
        } catch (error) {
          showGlobalNotification('error', error instanceof Error ? error.message : String(error));
        } finally {
          togglingSourceModeRef.current = false;
        }
      };
      void enterSourceMode();
      return;
    }

    // 切回所见即所得前，以源码权威草稿同步回 Crepe（内容未变则跳过）
    const latest =
      (noteId ? save.draftByNoteRef.current.get(noteId) : undefined) ??
      save.contentRef.current ??
      sourceDraftRef.current;
    const crepeCurrent = baseApiRef.current?.getMarkdown?.();
    const wasDirty = save.isCurrentNoteDirty();

    sourceModeRef.current = false;
    pendingSourceFocusRef.current = false;
    setSourceMode(false);
    clearNoteSelectionRef.current();
    setSelectedCharCount(0);
    setLiveTocMarkdown(latest);
    setCharCount(countNoteChars(latest));

    if (editorApi && crepeCurrent !== latest) {
      programmaticUpdateRef.current = true;
      try {
        editorApi.setMarkdown(latest);
      } catch {
        /* 编辑器正在重挂载时由 initialContent 接管 */
      }
      if (!wasDirty) {
        save.unsavedDocChangeRef.current = false;
        save.setIsDirty(false);
      }
      requestAnimationFrame(() => {
        programmaticUpdateRef.current = false;
        if (!sourceModeRef.current) {
          editorApi.focus?.();
        }
      });
    } else {
      requestAnimationFrame(() => {
        if (!sourceModeRef.current) {
          editorApi?.focus?.();
        }
      });
    }
  }, [
    editorApi,
    noteId,
    save.contentRef,
    save.draftByNoteRef,
    save.isCurrentNoteDirty,
    save.isUnmountedRef,
    save.setIsDirty,
    save.unsavedDocChangeRef,
  ]);

  // Notion 式选区字数浮标：监听文档内文本选区变化（编辑态与阅读态通用）
  useEffect(() => {
    if (sourceMode || !shellInViewport) {
      setSelectedCharCount(0);
      return undefined;
    }
    const isExcludedNode = (node: Node | null): boolean => {
      if (!node) return true;
      const el = node instanceof Element ? node : node.parentElement;
      return Boolean(el?.closest('.notes-document-header, input, textarea'));
    };
    const updateSelectionCount = () => {
      const container = selectionContainerRef.current;
      const sel = typeof window !== 'undefined' ? window.getSelection() : null;
      if (!container || !sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelectedCharCount(0);
        return;
      }
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
        setSelectedCharCount(0);
        return;
      }
      const proseMirror = container.querySelector('.ProseMirror');
      if (!proseMirror) {
        setSelectedCharCount(0);
        return;
      }
      const range = sel.getRangeAt(0);
      if (
        !proseMirror.contains(range.startContainer) ||
        !proseMirror.contains(range.endContainer) ||
        isExcludedNode(range.startContainer) ||
        isExcludedNode(range.endContainer)
      ) {
        setSelectedCharCount(0);
        return;
      }
      const chars = sel.toString().replace(/\s/g, '').length;
      setSelectedCharCount(chars);
    };
    const shell = notesShellRef.current;
    const handleFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget as Node | null;
      if (!nextTarget || !shell?.contains(nextTarget)) {
        setSelectedCharCount(0);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        setSelectedCharCount(0);
      }
    };
    document.addEventListener('selectionchange', updateSelectionCount);
    shell?.addEventListener('focusout', handleFocusOut);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('selectionchange', updateSelectionCount);
      shell?.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [sourceMode, shellInViewport]);

  const resolveSelectionHeading = useCallback((): string | null => {
    let heading: string | null = null;
    try {
      const view = editorApi?.getCrepe?.()?.editor.ctx.get(editorViewCtx);
      if (view) {
        const from = view.state.selection.from;
        view.state.doc.nodesBetween(0, from, (node, pos) => {
          if (node.type.name === 'heading' && pos < from) heading = node.textContent.trim() || heading;
          return true;
        });
      }
    } catch { /* 编辑器未就绪 */ }
    return heading;
  }, [editorApi]);

  const handleSelectionHighlight = useCallback(() => {
    if (effectiveReadOnly) return;
    try {
      const view = editorApi?.getCrepe?.()?.editor.ctx.get(editorViewCtx);
      if (view && !view.isDestroyed) toggleHighlightSelection(view);
    } catch { /* 编辑器未就绪 */ }
  }, [editorApi, effectiveReadOnly]);

  const handleSelectionCloze = useCallback(() => {
    if (effectiveReadOnly) return;
    try {
      const view = editorApi?.getCrepe?.()?.editor.ctx.get(editorViewCtx);
      if (view && !view.isDestroyed) toggleClozeSelection(view);
    } catch { /* 编辑器未就绪 */ }
  }, [editorApi, effectiveReadOnly]);

  const handleSelectionAddAsContext = useCallback((text: string) => {
    if (!noteId) return;
    const heading = resolveSelectionHeading();
    void import('@/features/chat/context/selectionRef').then(({ selectionToChat }) =>
      selectionToChat({ text, source: { kind: 'note', sourceId: noteId, title: initialTitle ?? undefined, locator: heading ? `heading:${heading}` : undefined } }),
    );
  }, [noteId, initialTitle, resolveSelectionHeading]);

  const handleSelectionAskAi = useCallback((text: string) => {
    handleSelectionAddAsContext(text);
    if (!isMobilePlatform()) {
      void openQuickAssistantWindow().catch(() => {});
    }
  }, [handleSelectionAddAsContext]);

  const handleSelectionExcerptToMindmap = useCallback((text: string) => {
    if (!noteId || !text.trim()) return;
    let blockId: string | undefined;
    try {
      const view = editorApi?.getCrepe?.()?.editor.ctx.get(editorViewCtx);
      if (view && !view.isDestroyed) {
        const { $from } = view.state.selection;
        for (let depth = $from.depth; depth >= 1; depth -= 1) {
          const attrs = $from.node(depth).attrs as Record<string, unknown> | undefined;
          const attrId = attrs?.dsBlockId ?? attrs?.blockId;
          if (typeof attrId === 'string' && attrId.trim()) {
            blockId = attrId.trim();
            break;
          }
        }
        if (!blockId) {
          const domPos = view.domAtPos($from.pos);
          const el = domPos.node instanceof Element ? domPos.node : domPos.node.parentElement;
          const host = el?.closest('[data-ds-block-id], [data-block-id]');
          const domId = host?.getAttribute('data-ds-block-id') ?? host?.getAttribute('data-block-id');
          if (domId?.trim()) blockId = domId.trim();
        }
      }
    } catch { /* 编辑器未就绪 */ }
    const hasActiveMindmap = Boolean(getAppKernel()?.dnd?.hasAutoExcerptListeners?.());
    const payload = emitNoteBlockAutoExcerpt({ noteId, blockId, noteTitle: initialTitle ?? undefined, headingPath: resolveSelectionHeading() ?? undefined, markdownText: text });
    if (!payload) { showGlobalNotification('error', t('notes:selection.excerptToMindmapFailed', '摘录失败：当前笔记未就绪')); return; }
    if (!hasActiveMindmap) {
      showGlobalNotification('warning', t('notes:selection.excerptToMindmapNoTarget', '当前没有开启「划选即入图」的思维导图，请先打开导图并开启「划选即入图」后重试'));
      return;
    }
    showGlobalNotification('success', t('notes:selection.excerptToMindmapSent', '已发送摘录到思维导图'));
  }, [editorApi, noteId, initialTitle, resolveSelectionHeading, t]);

  const resolveSelectionEditorState = useCallback((arg?: unknown): EditorState | null => {
    if (arg && typeof arg === 'object') {
      if ('selection' in arg && 'doc' in arg) return arg as EditorState;
      if ('state' in arg && (arg as { state?: unknown }).state) {
        const candidate = (arg as { state: unknown }).state;
        if (candidate && typeof candidate === 'object' && 'selection' in candidate && 'doc' in candidate) {
          return candidate as EditorState;
        }
      }
      if ('get' in arg && typeof (arg as { get: unknown }).get === 'function') {
        try {
          const view = (arg as { get: (k: unknown) => { state?: EditorState } | undefined }).get(editorViewCtx);
          if (view?.state) return view.state;
        } catch { /* ignore */ }
      }
    }
    try {
      const view = editorApi?.getCrepe?.()?.editor.ctx.get(editorViewCtx);
      return view && !view.isDestroyed ? view.state : null;
    } catch {
      return null;
    }
  }, [editorApi]);

  const selectionActions = useMemo<CrepeSelectionAction[]>(() => {
    if (!noteId) return [];
    const highlightAction = {
      key: 'highlight',
      label: t('notes:selection.highlight', '荧光笔高亮'),
      icon: HIGHLIGHT_ICON,
      active: (arg?: unknown) => {
        if (effectiveReadOnly) return false;
        const state = resolveSelectionEditorState(arg);
        return state ? isSelectionHighlighted(state) : false;
      },
      run: () => handleSelectionHighlight(),
    };
    const clozeAction = {
      key: 'cloze',
      label: t('notes:selection.cloze', '挖空制卡'),
      icon: CLOZE_ICON,
      active: (arg?: unknown) => {
        if (effectiveReadOnly) return false;
        const state = resolveSelectionEditorState(arg);
        return state ? isSelectionClozed(state) : false;
      },
      run: () => handleSelectionCloze(),
    };
    return [
      highlightAction as CrepeSelectionAction,
      clozeAction as CrepeSelectionAction,
      { key: 'ask-ai', label: t('notes:selection.askAi', '问 AI'), icon: ASK_AI_ICON, run: handleSelectionAskAi },
      { key: 'add-to-chat', label: t('chatV2:selectionToolbar.addToChat', '引用到聊天'), icon: ADD_TO_CHAT_ICON, run: handleSelectionAddAsContext },
      { key: 'excerpt-to-mindmap', label: t('notes:selection.excerptToMindmap', '摘录到导图'), icon: EXCERPT_TO_MINDMAP_ICON, run: handleSelectionExcerptToMindmap },
    ];
  }, [noteId, effectiveReadOnly, resolveSelectionEditorState, handleSelectionHighlight, handleSelectionCloze, handleSelectionAskAi, handleSelectionAddAsContext, handleSelectionExcerptToMindmap, t]);

  // ── 查找、定位、Wikilink 与拖放监听 ──
  useEffect(() => {
    const onFindQuery = (event: Event) => {
      const detail = (event as CustomEvent<Partial<NotesFindQuery>>).detail;
      if (!detail?.query || (detail.noteId && detail.noteId !== noteId)) return;
      const query = detail.noteId ? (consumeNotesFindQuery(detail.noteId) ?? detail.query) : detail.query;
      if (sourceModeRef.current) {
        sourceEditorRef.current?.openSearch();
        return;
      }
      setFindInitialQuery(query);
      setIsFindReplaceOpen(true);
    };
    window.addEventListener(NOTES_FIND_QUERY_EVENT, onFindQuery);
    const pending = consumeNotesFindQuery(noteId);
    if (pending) {
      if (sourceModeRef.current) {
        sourceEditorRef.current?.openSearch();
      } else {
        setFindInitialQuery(pending);
        setIsFindReplaceOpen(true);
      }
    }
    return () => window.removeEventListener(NOTES_FIND_QUERY_EVENT, onFindQuery);
  }, [noteId]);

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
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        insertWikilink(view, position, position, resource.title);
        view.focus();
      });
    };
    container.addEventListener('dragover', onDragOver, true);
    container.addEventListener('drop', onDrop, true);
    return () => { container.removeEventListener('dragover', onDragOver, true); container.removeEventListener('drop', onDrop, true); };
  }, [editorApi, effectiveReadOnly]);

  useEffect(() => { void refreshWikilinkNotesCache(); }, []);

  useEffect(() => {
    if (!editorApi || !noteId) return;
    const scroll = async (heading: string) => {
      try { await (editorApi as FullDocumentSearchApi).materializeFullDocument(); }
      catch (error) { showGlobalNotification('error', String(error)); return; }
      editorApi.scrollToHeading?.(heading, 0, heading.toLowerCase().trim(), (docHeading) => notesHeadingTargetMatches(docHeading, heading));
    };
    const onHeadingTarget = (event: Event) => {
      const detail = (event as CustomEvent<NotesHeadingTarget>).detail;
      if (detail?.noteId !== noteId || !detail.heading) return;
      consumeNotesHeadingTarget(noteId);
      void scroll(detail.heading);
    };
    window.addEventListener(NOTES_HEADING_TARGET_EVENT, onHeadingTarget);
    const pending = consumeNotesHeadingTarget(noteId);
    if (pending) void scroll(pending);
    return () => window.removeEventListener(NOTES_HEADING_TARGET_EVENT, onHeadingTarget);
  }, [editorApi, noteId]);

  const locateQuote = useCallback(async (quote: string) => {
    if (!editorApi) return;
    try { await (editorApi as FullDocumentSearchApi).materializeFullDocument(); }
    catch (error) { showGlobalNotification('error', String(error)); return; }
    try {
      const view = editorApi.getCrepe?.()?.editor.ctx.get(editorViewCtx);
      if (!view || view.isDestroyed) return;
      const positions: number[] = [];
      const texts: string[] = [];
      view.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        positions.push(pos);
        texts.push(node.textContent);
        return false;
      });
      const index = findQuoteBlockIndex(texts, quote);
      const dom = index >= 0 ? view.nodeDOM(positions[index]) : null;
      if (!(dom instanceof HTMLElement)) return;
      dom.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
      dom.classList.remove('crepe-heading-locate-flash');
      void dom.offsetWidth;
      dom.classList.add('crepe-heading-locate-flash');
      window.setTimeout(() => dom.classList.remove('crepe-heading-locate-flash'), 1300);
    } catch { /* 编辑器已卸载 */ }
  }, [editorApi]);

  const handleQuoteTarget = useCallback((event: Event) => {
    const detail = (event as CustomEvent<NotesQuoteTarget>).detail;
    if (!editorApi || !noteId || detail?.noteId !== noteId || !detail.quote) return;
    consumeNotesQuoteTarget(noteId);
    void locateQuote(detail.quote);
  }, [editorApi, noteId, locateQuote]);
  useEventRegistry([{ target: 'window', type: NOTES_QUOTE_TARGET_EVENT, listener: handleQuoteTarget }], [handleQuoteTarget]);
  useEffect(() => {
    if (!editorApi || !noteId) return;
    const pending = consumeNotesQuoteTarget(noteId);
    if (pending) void locateQuote(pending);
  }, [editorApi, noteId, locateQuote]);

  useEffect(() => {
    if (!editorApi || !noteId) return;
    return registerNoteBlockRevealHandler({
      noteId,
      isFocused: () => Boolean(typeof document !== 'undefined' && document.activeElement && notesShellRef.current?.contains(document.activeElement)),
      materializeFullDocument: () => (editorApi as FullDocumentSearchApi).materializeFullDocument?.(),
      focusBlock: (blockId) => Boolean(editorApi.focusBlock?.(blockId)),
      pulseBlock: (blockId) => {
        try {
          const view = editorApi.getCrepe?.()?.editor.ctx.get(editorViewCtx);
          if (!view || view.isDestroyed) return;
          let blockPos = -1;
          view.state.doc.forEach((node, pos) => { if (node.attrs?.dsBlockId === blockId) blockPos = pos; });
          const dom = blockPos >= 0 ? view.nodeDOM(blockPos) : null;
          if (dom instanceof HTMLElement) {
            dom.classList.remove('crepe-heading-locate-flash');
            void dom.offsetWidth;
            dom.classList.add('crepe-heading-locate-flash');
            window.setTimeout(() => dom.classList.remove('crepe-heading-locate-flash'), 1300);
          }
        } catch { /* Ignore pulse failure if view unmounts concurrently. */ }
      },
      scrollToHeading: (heading) => editorApi.scrollToHeading?.(heading, 0, heading.toLowerCase().trim(), (docHeading) => notesHeadingTargetMatches(docHeading, heading)),
      scrollToTop: () => scrollViewportRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }),
    });
  }, [editorApi, noteId]);

  useEffect(() => {
    const handleCreateFromWikilink = (event: Event) => {
      const title = parseCreateFromWikilinkEvent(event);
      if (!title) return;
      void createNoteFromWikilinkTitle(title).then((createdNoteId) => {
        if (!createdNoteId || save.isUnmountedRef.current) return;
        refreshWikilinksAfterCreate(editorApi, title);
      });
    };
    window.addEventListener(CREATE_FROM_WIKILINK_EVENT, handleCreateFromWikilink);
    return () => window.removeEventListener(CREATE_FROM_WIKILINK_EVENT, handleCreateFromWikilink);
  }, [editorApi, save.isUnmountedRef]);

  // ── 键盘快捷键（Cmd/Ctrl+S、Cmd/Ctrl+F、Cmd/Ctrl+Shift+U） ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isReviewShortcut(e) || save.isComposingRef.current) return;
      const activeEl = document.activeElement as HTMLElement | null;
      const isEditorFocused = !!activeEl && !!dropZoneRef.current?.contains(activeEl);
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        if (effectiveReadOnly || !isEditorFocused) return;
        e.preventDefault(); e.stopPropagation();
        save.handleManualSave()
          .then(() => showGlobalNotification('success', t('notes:actions.save_success')))
          .catch(() => showGlobalNotification('error', t('notes:actions.save_failed')));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === 'f') {
        if (!isEditorFocused && !isFindReplaceOpen) return;
        e.preventDefault(); e.stopPropagation();
        if (sourceModeRef.current) {
          sourceEditorRef.current?.openSearch();
          return;
        }
        if (isFindReplaceOpen) {
          const input = findReplaceContainerRef.current?.querySelector('input');
          if (input instanceof HTMLInputElement) { input.focus(); input.select(); }
        } else {
          setIsFindReplaceOpen(true);
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'u') {
        if (!isEditorFocused && !focus.focusModeRef.current) return;
        e.preventDefault(); e.stopPropagation();
        focus.toggleFocusMode();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
        if (!isEditorFocused) return;
        e.preventDefault(); e.stopPropagation();
        handleToggleSourceMode();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [save.handleManualSave, save.isComposingRef, effectiveReadOnly, t, isFindReplaceOpen, focus.toggleFocusMode, focus.focusModeRef, handleToggleSourceMode]);

  const handleFindReplaceClose = useCallback(() => {
    setIsFindReplaceOpen(false);
    editorApi?.focus();
  }, [editorApi]);

  const { isDragging: isDraggingOver } = useTauriDragAndDrop({
    dropZoneRef,
    onDropFiles: () => {},
    isEnabled: !effectiveReadOnly,
    feedbackOnly: true,
    feedbackExtensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'heif'],
    debugZoneId: 'notes-crepe-editor',
  });

  useLayoutEffect(() => {
    if (editorNoteIdRef.current !== (noteId ?? null)) setEditorApi(null);
  }, [noteId]);

  // ── CrepeEditor 就绪与全文 API 装配 ──
  const handleEditorReady = useCallback((api: CrepeEditorApi) => {
    baseApiRef.current = api;
    const lifecycleApi: FullDocumentViewHost = {
      ...api,
      getMarkdown: () => (
        sourceModeRef.current && noteId && currentRenderedNoteRef.current === noteId
          ? (save.draftByNoteRef.current.get(noteId) ?? save.contentRef.current)
          : api.getMarkdown()
      ),
      flushPendingSave: async () => {
        const targetNoteId = noteId;
        if (!targetNoteId || currentRenderedNoteRef.current !== targetNoteId) throw new Error(t('notes:fullDocument.errors.stale_editor'));
        const currentMarkdown = sourceModeRef.current
          ? (save.draftByNoteRef.current.get(targetNoteId) ?? save.contentRef.current)
          : api.getMarkdown();
        save.contentRef.current = currentMarkdown;
        save.draftByNoteRef.current.set(targetNoteId, currentMarkdown);
        save.setIsDirty(currentMarkdown !== (save.lastSavedMapRef.current.get(targetNoteId) ?? ''));
        await save.flushNoteDraftRef.current(targetNoteId);
      },
    };
    const extended = extendEditorApi?.(lifecycleApi) ?? lifecycleApi;
    const sharedApi = createFullDocumentApi(extended, {
      noteId: noteId ?? '',
      isCurrent: () => !save.isUnmountedRef.current && currentRenderedNoteRef.current === noteId && lifecycleApiRef.current === sharedApi,
      revision: () => save.documentRevisionRef.current,
      isWindowed: () => extended.isDocumentWindowed?.() ?? windowingStateRef.current?.hasMore === true,
      retainFailure: (markdown, error, previousMarkdown) => { if (noteId) save.retainFailedDraft(noteId, markdown, error, previousMarkdown); },
      projectView: (apply) => {
        if (!noteId) return;
        const before = api.getMarkdown();
        const full = extended.getFullMarkdown?.() ?? before;
        const project = (prefix: string) => {
          const canonicalPrefix = api.normalizeMarkdown?.(prefix) ?? prefix;
          const merged = mergeExpandedMarkdown(before, canonicalPrefix, full);
          return api.normalizeMarkdown?.(merged) ?? merged;
        };
        const savedPrefix = save.lastSavedMapRef.current.get(noteId) ?? before;
        const wasDirty = save.unsavedDocChangeRef.current || (api.normalizeMarkdown?.(savedPrefix) ?? savedPrefix) !== before;
        let saved = project(savedPrefix);
        save.cancelDebounce();
        save.projectingFullViewRef.current = true;
        let next: string;
        try { next = apply(); } finally { save.projectingFullViewRef.current = false; }
        save.fullViewMaterializedRef.current = true;
        if (!wasDirty) saved = next;
        save.projectedMarkdownRef.current = next;
        save.contentRef.current = next;
        save.draftByNoteRef.current.set(noteId, next);
        save.lastSavedMapRef.current.set(noteId, saved);
        save.pendingSaveQueueRef.current = save.pendingSaveQueueRef.current.map((payload) => {
          if (payload.noteId !== noteId) return payload;
          const fullContent = project(payload.content);
          return { ...payload, content: fullContent, fullContent };
        });
        save.unsavedDocChangeRef.current = false;
        save.setIsDirty(next !== saved);
        setCharCount(countNoteChars(next));
        setLiveTocMarkdown(next);
        setSourceDraft(next);
        window.dispatchEvent(new CustomEvent('notes:content-changed', { detail: { noteId, content: next } }));
        if (next !== saved) save.saveTimerRef.current = setTimeout(() => { void save.queueSave(next, noteId).catch(() => {}); }, AUTO_SAVE_DEBOUNCE_MS);
      },
    });
    setEditorApi(sharedApi);
    lifecycleApiRef.current = sharedApi;
    editorNoteIdRef.current = noteId ?? null;
    if (extended.getFullMarkdown || !windowingStateRef.current?.hasMore) {
      const fullMarkdown = sharedApi.getFullMarkdown();
      setCharCount(countNoteChars(fullMarkdown));
      setLiveTocMarkdown(fullMarkdown);
      window.dispatchEvent(new CustomEvent('notes:content-changed', { detail: { noteId, content: fullMarkdown } }));
    }
    requestAnimationFrame(() => {
      if (!save.isUnmountedRef.current && currentRenderedNoteRef.current === (noteId ?? null)) {
        publishActiveHeadingRef.current();
      }
    });
    onEditorReady?.(sharedApi);
    onEditorApiReady?.(sharedApi);
  }, [
    noteId, extendEditorApi, onEditorReady, onEditorApiReady, t,
    save.retainFailedDraft, save.queueSave, save.cancelDebounce, save.setIsDirty,
    save.contentRef, save.draftByNoteRef, save.lastSavedMapRef, save.pendingSaveQueueRef,
    save.unsavedDocChangeRef, save.saveTimerRef, save.flushNoteDraftRef, save.isUnmountedRef,
    save.documentRevisionRef, save.projectingFullViewRef, save.projectedMarkdownRef, save.fullViewMaterializedRef,
  ]);

  useEffect(() => () => {
    onEditorReady?.(null);
    const previousApi = lifecycleApiRef.current;
    lifecycleApiRef.current = null;
    onEditorApiReady?.(null, previousApi ?? undefined);
  }, [onEditorReady, onEditorApiReady]);

  // ── AI 审阅与 Agent 直接写入撤销 ──
  const {
    aiEditState, handleAccept, handleReject, isApplying: isAIEditApplying,
    checkpoint: aiCheckpoint, checkpoints: aiCheckpoints, rollbackCheckpoint, dismissCheckpoint,
    session: aiReview, setCollapsed: setAIReviewCollapsed, decideGroup: decideAIReviewGroup,
    copyCandidate: copyAICandidate, persistenceStatus: aiPersistenceStatus, persistenceError: aiPersistenceError,
    retryPersistence: retryAIReviewPersistence, recoveryOptions: aiRecoveryOptions,
    restoreCandidate: restoreAICandidate, officialReviewProps, scopeProps,
  } = useAIReview({
    noteId, noteTitle: initialTitle, editorApi, enabled: true, windowId: acrWindowId,
    host: {
      acquireReviewLease: () => {
        if (!editorApi?.acquireReviewLease) throw new Error(t('notes:host.review_lease_not_ready', '审阅交互锁尚未就绪。'));
        return editorApi.acquireReviewLease();
      },
      resolveScope: (kind) => resolveNoteReviewScope(editorApi as FullDocumentSearchApi, kind),
      applyDocument: (markdown, baseline) => applyReviewedNote(editorApi as FullDocumentSearchApi, markdown, baseline),
      saveAs: (markdown, operationId, baseline) => noteHostCoordinator.withLockedNotes(
        baseline ? [noteId!, baseline.noteId] : [noteId!],
        async () => {
          await noteHostCoordinator.flushPendingSaves(baseline ? [noteId!, baseline.noteId] : [noteId!]);
          return saveReviewAs(markdown, operationId, noteId!, initialTitle ?? '', baseline, noteHostCoordinator.getLeaseAuth(noteId));
        },
      ),
    },
  });

  // One Escape closes one surface. Bubble after popovers/editor handlers, never during IME.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !isReviewShortcut(event) || save.isComposingRef.current) return;
      if (!notesShellRef.current?.contains(document.activeElement) && !focus.focusMode) return;
      if (historyOpen || pageActionsOpen || document.querySelector('[data-state="open"][role="dialog"], [data-state="open"][role="menu"]')) return;
      if (isFindReplaceOpen) return;
      if (templateMenuOpen) { event.preventDefault(); setTemplateMenuOpen(false); return; }
      if (conflict.conflictDiffOpen) { event.preventDefault(); conflict.setConflictDiffOpen(false); return; }
      if (aiReview && !aiReview.collapsed) return;
      if (focus.focusMode) { event.preventDefault(); focus.setFocusMode(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [focus.focusMode, focus.setFocusMode, historyOpen, pageActionsOpen, isFindReplaceOpen, templateMenuOpen, aiReview, conflict.conflictDiffOpen, conflict.setConflictDiffOpen, save.isComposingRef]);

  const [agentWrite, setAgentWrite] = useState<{ before: string; after: string; stale: boolean } | null>(null);
  useEffect(() => { setAgentWrite(null); }, [noteId]);
  useEffect(() => {
    const onAgentApplied = (event: Event) => {
      const detail = (event as CustomEvent<{ noteId: string; windowId?: string; before: string; after: string }>).detail;
      if (!detail || detail.noteId !== save.noteIdRef.current) return;
      if (detail.windowId && acrWindowId && detail.windowId !== acrWindowId) return;
      setAgentWrite((prev) => ({ before: prev && !prev.stale ? prev.before : detail.before, after: detail.after, stale: false }));
    };
    window.addEventListener('notes:agent-applied', onAgentApplied);
    return () => window.removeEventListener('notes:agent-applied', onAgentApplied);
  }, [acrWindowId, save.noteIdRef]);

  const undoAgentWrite = useCallback(async () => {
    if (!agentWrite || !editorApi || effectiveReadOnly) return;
    const api = editorApi as FullDocumentApi;
    const current = api.getFullDocument?.().markdown ?? editorApi.getMarkdown();
    const normalize = (md: string) => editorApi.normalizeMarkdown?.(md) ?? md;
    if (normalize(current) !== normalize(agentWrite.after)) {
      setAgentWrite({ ...agentWrite, stale: true });
      showGlobalNotification('warning', t('notes:agentWrite.stale', '笔记在 AI 修改后又有改动，无法安全撤销；可在「历史版本」中恢复。'));
      return;
    }
    try {
      const baseline = api.getFullDocument?.();
      if (api.replaceFullDocument && baseline) await api.replaceFullDocument(agentWrite.before, baseline);
      else { editorApi.setMarkdown(agentWrite.before); await editorApi.flushPendingSave?.(); }
      editorApi.agentFlashChange?.(agentWrite.after, agentWrite.before);
      setSourceDraft(agentWrite.before);
      setLiveTocMarkdown(agentWrite.before);
      setAgentWrite(null);
      showGlobalNotification('success', t('notes:agentWrite.undone', '已撤销 AI 的修改'));
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : String(error));
    }
  }, [agentWrite, editorApi, effectiveReadOnly, t]);

  // ── 宿主协调器绑定（锁 / 冲刷 / 刷新 / 格式能力） ──
  useEffect(() => {
    if (!editorApi || !noteId || !baseApiRef.current) return;
    const base = baseApiRef.current;
    const api = editorApi as FullDocumentSearchApi & FullDocumentViewHost;
    let active = true;
    const refresh = async () => {
      try {
        if (!api.refreshDocumentFromDisk) throw new Error(t('notes:host.refresh_unsupported', '此笔记宿主尚未提供完整刷新能力。'));
        await api.refreshDocumentFromDisk();
        if (!active) return;
        const refreshedMarkdown = fullMarkdownForReporting(api, save.contentRef.current, sourceModeRef.current);
        if (refreshedMarkdown !== undefined) {
          setSourceDraft(refreshedMarkdown);
          setLiveTocMarkdown(refreshedMarkdown);
        }
        resetNoteUndo(base);
        if (base.setDocumentCapabilities) applyNoteFormat(base, await readNoteFormat(noteId));
        save.invalidNotesRef.current.delete(noteId);
        base.setReadonly?.(userReadOnlyRef.current || save.lockedNotesRef.current.has(noteId));
        setHostRefreshError(null);
      } catch (error) {
        if (active) setHostRefreshError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    };
    const release = bindNoteEditorHost(base, {
      id: hostInstanceId, noteId, windowId: acrWindowId, api, dirty: save.isCurrentNoteDirty,
      lock: () => {
        if ((base.getUploadState?.().pending ?? 0) > 0) throw new Error(t('notes:host.wait_for_uploads', '请等待图片上传完成或取消上传后再操作。'));
        save.lockedNotesRef.current.add(noteId);
        save.cancelDebounce();
        save.pendingSaveQueueRef.current = save.pendingSaveQueueRef.current.filter((p) => p.noteId !== noteId);
        const unlock = base.acquireReviewLease?.();
        base.setReadonly?.(true);
        setHostBusy(true);
        return () => {
          save.lockedNotesRef.current.delete(noteId);
          unlock?.();
          if (active) { base.setReadonly?.(userReadOnlyRef.current || save.invalidNotesRef.current.has(noteId)); setHostBusy(false); }
        };
      },
      settle: async () => { await save.inFlightSaveRef.current; },
      flush: async () => {
        save.privilegedFlushRef.current = true;
        try {
          await api.flushPendingSave!();
          if (save.isCurrentNoteDirty()) throw new Error(t('notes:host.draft_unconfirmed', '笔记草稿尚未确认保存，已取消操作。'));
        } finally { save.privilegedFlushRef.current = false; }
      },
      invalidate: () => {
        save.invalidNotesRef.current.add(noteId);
        base.setReadonly?.(true);
        save.cancelDebounce();
        save.pendingSaveQueueRef.current = save.pendingSaveQueueRef.current.filter((p) => p.noteId !== noteId);
        setHostRefreshError(t('notes:host.refreshing', '笔记已更新，正在刷新正文。'));
      },
      refresh,
    });
    if (base.setDocumentCapabilities) {
      void readNoteFormat(noteId)
        .then((format) => { if (active) applyNoteFormat(base, format); })
        .catch((error) => { if (active) { save.invalidNotesRef.current.add(noteId); base.setReadonly?.(true); setHostRefreshError(String(error)); } });
    }
    return () => { active = false; release(); };
  }, [editorApi, noteId, hostInstanceId, acrWindowId, save.isCurrentNoteDirty, save.cancelDebounce, save.pendingSaveQueueRef, save.inFlightSaveRef, save.lockedNotesRef, save.invalidNotesRef, save.privilegedFlushRef, t]);

  // ── 窗口化滚动加载、大纲滚动跟随与移动端工具条收起 ──
  const captureViewportMetrics = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return null;
    return { scrollTop: Math.round(viewport.scrollTop), scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight };
  }, []);

  const applyWindowExpansion = useCallback((result: MarkdownLoadMoreResult) => {
    if (!editorApi || !noteId) return;
    const wasDirty = save.isCurrentNoteDirty();
    if (currentRenderedNoteRef.current !== noteId || lifecycleApiRef.current !== editorApi) return;
    const selection = editorApi.captureSelection?.() ?? null;
    const viewportMetrics = captureViewportMetrics();
    save.cancelDebounce();
    programmaticUpdateRef.current = true;
    editorApi.setMarkdown(result.loadedMarkdown);
    save.contentRef.current = result.loadedMarkdown;
    save.draftByNoteRef.current.set(noteId, result.loadedMarkdown);
    if (!wasDirty) save.lastSavedMapRef.current.set(noteId, result.loadedMarkdown);
    try {
      const fullAfterExpand = editorApi.getFullMarkdown?.() ?? result.loadedMarkdown;
      setCharCount(countNoteChars(fullAfterExpand));
      setLiveTocMarkdown(fullAfterExpand);
    } catch {
      setCharCount(undefined);
      setLiveTocMarkdown(result.loadedMarkdown);
    }
    requestAnimationFrame(() => {
      if (currentRenderedNoteRef.current !== noteId || lifecycleApiRef.current !== editorApi) return;
      const viewport = scrollViewportRef.current;
      if (viewport && viewportMetrics) viewport.scrollTop = viewportMetrics.scrollTop;
      editorApi.restoreSelection?.(selection);
      lastAppliedWindowLineCountRef.current = result.loadedLineCount;
      programmaticUpdateRef.current = false;
      if (wasDirty) void save.queueSave(editorApi.getMarkdown(), noteId).catch(() => {});
    });
  }, [captureViewportMetrics, editorApi, noteId, save.isCurrentNoteDirty, save.queueSave, save.cancelDebounce, save.contentRef, save.draftByNoteRef, save.lastSavedMapRef]);

  const handleWindowScroll = useCallback(() => {
    if (!windowingState?.enabled || !windowingState.hasMore || editorApi?.isDocumentWindowed?.() === false || isFindReplaceOpen || windowingState.isLoadingMore || loadMoreInFlightRef.current || !editorApi || !onRequestLoadMore) return;
    const metrics = captureViewportMetrics();
    if (!metrics || !shouldRequestLoadMore(metrics, windowingState.preloadPx)) return;
    loadMoreInFlightRef.current = true;
    const source = editorApi.getMarkdown();
    void onRequestLoadMore(source)
      .then((result) => {
        if (result && !save.fullViewMaterializedRef.current && currentRenderedNoteRef.current === noteId && lifecycleApiRef.current === editorApi) {
          applyWindowExpansion({ ...result, loadedMarkdown: mergeExpandedMarkdown(source, editorApi.getMarkdown(), result.loadedMarkdown) });
        }
      })
      .catch((error) => showGlobalNotification('error', error instanceof Error ? error.message : String(error)))
      .finally(() => { loadMoreInFlightRef.current = false; });
  }, [applyWindowExpansion, captureViewportMetrics, editorApi, onRequestLoadMore, windowingState, noteId, isFindReplaceOpen, save.fullViewMaterializedRef]);

  const activeHeadingRafRef = useRef<number | null>(null);
  const lastActiveHeadingKeyRef = useRef<string | null>(null);
  const publishActiveHeading = useCallback(() => {
    if (activeHeadingRafRef.current !== null) return;
    activeHeadingRafRef.current = requestAnimationFrame(() => {
      activeHeadingRafRef.current = null;
      const viewport = scrollViewportRef.current;
      const container = dropZoneRef.current;
      const currentNoteId = save.noteIdRef.current;
      if (!viewport || !container || !currentNoteId || save.isUnmountedRef.current) return;
      const headingEls = container.querySelectorAll<HTMLElement>('.crepe-editor-wrapper h1, .crepe-editor-wrapper h2, .crepe-editor-wrapper h3, .crepe-editor-wrapper h4, .crepe-editor-wrapper h5, .crepe-editor-wrapper h6');
      if (headingEls.length === 0) return;
      const anchorTop = viewport.getBoundingClientRect().top + 96;
      let current: HTMLElement | null = null;
      for (const el of headingEls) {
        if (el.getBoundingClientRect().top <= anchorTop) current = el;
        else break;
      }
      const target = current ?? headingEls[0];
      const text = normalizeActiveHeadingText(target.textContent ?? '');
      if (!text) return;
      const level = Number(target.tagName.slice(1)) || 0;
      let occurrence = 0;
      for (const el of headingEls) {
        if (el === target) break;
        if (el.tagName === target.tagName && normalizeActiveHeadingText(el.textContent ?? '') === text) occurrence += 1;
      }
      const key = `${currentNoteId}:${level}:${occurrence}:${text}`;
      if (key === lastActiveHeadingKeyRef.current) return;
      lastActiveHeadingKeyRef.current = key;
      dispatchTypedEvent(NOTES_ACTIVE_HEADING_EVENT, { noteId: currentNoteId, text, level, occurrence } satisfies NotesActiveHeadingDetail);
    });
  }, [save.noteIdRef, save.isUnmountedRef]);
  publishActiveHeadingRef.current = publishActiveHeading;

  useEffect(() => () => { if (activeHeadingRafRef.current !== null) { cancelAnimationFrame(activeHeadingRafRef.current); activeHeadingRafRef.current = null; } }, []);
  useEffect(() => { lastActiveHeadingKeyRef.current = null; }, [noteId]);

  const [mobileToolbarCollapsed, setMobileToolbarCollapsed] = useState(false);
  const lastScrollTopRef = useRef(0);
  const handleMobileToolbarScroll = useCallback(() => {
    if (!showMobileToolbar) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const top = viewport.scrollTop;
    const delta = top - lastScrollTopRef.current;
    lastScrollTopRef.current = top;
    const nearEdge = top < 24 || top + viewport.clientHeight >= viewport.scrollHeight - 24;
    if (nearEdge || delta < -4) setMobileToolbarCollapsed(false);
    else if (delta > 12) setMobileToolbarCollapsed(true);
  }, [showMobileToolbar]);
  useEffect(() => { if (!showMobileToolbar) setMobileToolbarCollapsed(false); }, [showMobileToolbar]);

  const handleViewportScroll = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (viewport) notesShellRef.current?.toggleAttribute('data-scrolled', viewport.scrollTop > 4);
    handleWindowScroll();
    publishActiveHeading();
    handleMobileToolbarScroll();
  }, [handleWindowScroll, publishActiveHeading, handleMobileToolbarScroll]);

  useEffect(() => {
    const handleScrollToHeading = async (e: CustomEvent<{ text: string; normalizedText?: string; level: number; occurrence?: number; noteId?: string }>) => {
      if (e.detail.noteId && save.noteIdRef.current && e.detail.noteId !== save.noteIdRef.current) return;
      const viewportMetrics = captureViewportMetrics();
      emitOutlineDebugLog({ category: 'event', action: 'scrollToHeading:received', details: { heading: e.detail, noteId: save.noteIdRef.current || null, hasEditor: !!editorApi, viewportMetrics } });
      emitOutlineDebugSnapshot({
        noteId: save.noteIdRef.current || null,
        heading: { text: e.detail.text, normalized: e.detail.normalizedText, level: e.detail.level },
        scrollEvent: { reason: 'scrollToHeading:received', targetPos: null, resolvedPos: null, exactMatch: undefined },
        editorState: { hasView: !!editorApi, hasSelection: false, containerScrollTop: viewportMetrics?.scrollTop ?? null, containerScrollHeight: viewportMetrics?.scrollHeight ?? null, containerClientHeight: viewportMetrics?.clientHeight ?? null },
        domState: { viewportExists: !!viewportMetrics, viewportSelector: '.notes-editor .scroll-area__viewport' },
      });
      if (editorApi?.scrollToHeading) {
        try { await (editorApi as FullDocumentSearchApi).materializeFullDocument(); }
        catch (error) { showGlobalNotification('error', String(error)); return; }
        editorApi.scrollToHeading(e.detail.text, e.detail.level, e.detail.normalizedText, undefined, e.detail.occurrence ?? 0);
      }
    };
    window.addEventListener('notes:scroll-to-heading' as any, handleScrollToHeading as any);
    return () => window.removeEventListener('notes:scroll-to-heading' as any, handleScrollToHeading as any);
  }, [captureViewportMetrics, editorApi, save.noteIdRef]);

  // ── 页面级操作栏与菜单 ──
  const readingModeAction = !readOnly && (
    <DsButton variant="ghost" size="sm" className="notes-chrome-text-button"
      role={hasMobileResourceMenu ? 'menuitem' : undefined}
      aria-label={readingMode ? t('notes:toolbar.editing_mode') : t('notes:toolbar.reading_mode')}
      aria-pressed={readingMode}
      onClick={() => { if (!readingMode) void save.flushNoteDraft().catch(() => {}); setReadingMode((prev) => !prev); }}>
      {readingMode ? <PencilLine size={15} /> : <BookOpen size={15} />}
      <span>{readingMode ? t('notes:chrome.edit') : t('notes:chrome.read')}</span>
    </DsButton>
  );

  const pageActions = (
    <NotesPageActionsMenu
      noteId={noteId} readOnly={readOnly} effectiveReadOnly={effectiveReadOnly} editorReady={!!editorApi}
      hasMobileResourceMenu={hasMobileResourceMenu} isTouchEditingSurface={isTouchEditingSurface}
      templateMenuOpen={templateMenuOpen} templatePanelId={templatePanelId}
      onToggleTemplateMenu={() => {
        if (!templateMenuOpen && editorApi) {
          try { templateInsertionRef.current = captureTemplateInsertion(editorApi as FullDocumentSearchApi); }
          catch (error) { templateInsertionRef.current = null; showGlobalNotification('error', String(error)); }
        }
        setTemplateMenuOpen((prev) => !prev);
      }}
      generatingCards={generatingCards} onGenerateCards={handleGenerateCards}
      generatingMindmap={generatingMindmap} onGenerateMindmap={handleGenerateMindmap}
      syncingHandout={syncingHandout} onSyncHandoutToMindmap={handleSyncHandoutToMindmap}
      onOpenHistory={() => setHistoryOpen(true)}
      isFindReplaceOpen={isFindReplaceOpen}
      onToggleFindReplace={() => {
        if (sourceModeRef.current) {
          sourceEditorRef.current?.openSearch();
        } else {
          setIsFindReplaceOpen((prev) => !prev);
        }
      }}
      readingModeAction={readingModeAction} focusMode={focus.focusMode} onToggleFocusMode={focus.toggleFocusMode}
      extraViewActions={(
        <DsButton
          variant="ghost"
          size="sm"
          role={hasMobileResourceMenu ? 'menuitem' : undefined}
          onClick={handleToggleSourceMode}
          aria-pressed={sourceMode}
        >
          <Code size={16} />
          <span>{sourceMode ? t('notes:sourceMode.exit', '返回可视化编辑') : t('notes:sourceMode.toggle', 'Markdown 源码')}</span>
          <kbd>{isMacOS() ? '⌘⇧M' : 'Ctrl+Shift+M'}</kbd>
        </DsButton>
      )}
      hasMoreWindowedContent={windowingState?.hasMore} hostBusy={hostBusy}
      onMaterializeFullDocument={() => {
        if (editorApi) void (editorApi as FullDocumentSearchApi).materializeFullDocument().catch((error) => showGlobalNotification('error', String(error)));
      }}
      acrWindowId={acrWindowId}
    />
  );

  const hasPortalChromeHost = Boolean(notesChromeSlot) && shellInViewport && !hasMobileResourceMenu;
  const portalChrome = hasPortalChromeHost && !focus.focusMode;
  const chromeActions = (
    <>
      <NotesSaveIndicator saveStatus={save.saveStatus} lastSaved={save.lastSaved} charCount={charCount}
        readOnly={effectiveReadOnly} onRetrySave={effectiveReadOnly ? undefined : save.handleManualSave} />
      {!isTouchEditingSurface && readingModeAction}
      <Popover open={pageActionsOpen} onOpenChange={setPageActionsOpen}>
        <PopoverTrigger asChild>
          <DsButton ref={templateTriggerRef} variant="ghost" size="sm" className="notes-chrome-text-button"
            aria-haspopup="dialog" aria-label={t('notes:toolbar.page_actions', 'More note actions')}>
            <DotsThree size={16} weight="bold" className="notes-chrome-compact-icon" aria-hidden="true" />
            <span>{t('notes:chrome.page')}</span><CaretDown size={12} className="notes-chrome-caret" />
          </DsButton>
        </PopoverTrigger>
        <PopoverContent ref={pageActionsRef} align="end" className="w-64 max-h-[min(80vh,600px)] overflow-y-auto p-1"
          aria-label={t('notes:toolbar.page_actions', 'More note actions')}
          aria-hidden={!pageActionsOpen || undefined}
          {...(!pageActionsOpen ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>) : {})}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || isComposingKeyEvent(event)) return;
            event.preventDefault(); event.stopPropagation();
            setPageActionsOpen(false); templateTriggerRef.current?.focus();
          }}
          onClick={(event) => {
            if (!(event.target as HTMLElement).closest('button:not([data-keep-open])')) return;
            setPageActionsOpen(false); templateTriggerRef.current?.focus();
          }}>
          {pageActions}
        </PopoverContent>
      </Popover>
      {headerActions}
    </>
  );

  // ★ R1 修复：key 只由 noteId 决定，避免窗口化或自动保存触发编辑器重挂载。
  const contentVersionKey = `dstu:${noteId || 'new'}`;

  // 顶部横幅单槽位优先级仲裁：同一时刻主区域只渲染最高优先级横幅，避免多横幅雪崩挤压正文
  const rawActiveBannerIds: BannerId[] = [];
  if (conflict.conflictAction) rawActiveBannerIds.push('conflict');
  if (hostRefreshError) rawActiveBannerIds.push('host-refresh-error');
  if (save.draftPersistenceError) rawActiveBannerIds.push('draft-persistence-error');
  if (save.recoveryDraft && save.recoveryDraft.noteId === noteId) rawActiveBannerIds.push('recovery-draft');
  if (save.recoveredDrafts.length > 0) rawActiveBannerIds.push('recovered-drafts');
  if (aiPersistenceError || aiRecoveryOptions.length > 0) rawActiveBannerIds.push('ai-recovery');
  if (aiEditState.isActive && !aiReview?.collapsed) rawActiveBannerIds.push('ai-diff');
  if (aiReview?.collapsed) rawActiveBannerIds.push('ai-collapsed');
  if (agentWrite && !aiEditState.isActive) rawActiveBannerIds.push('agent-write');
  if (aiCheckpoint && !aiEditState.isActive) rawActiveBannerIds.push('ai-checkpoint');
  if (!effectiveReadOnly && !focus.focusMode && isReviewDue) rawActiveBannerIds.push('review-due');
  const activeBannerIds = focus.focusMode
    ? rawActiveBannerIds.filter((id) => FOCUS_MODE_CRITICAL_BANNERS.has(id))
    : rawActiveBannerIds;
  const bannerSlots = resolveBannerSlots(activeBannerIds, {
    coVisibleBanners: ['ai-diff', 'agent-write'],
  });
  const shouldCollapseQueue = bannerSlots.hiddenCount >= 2;
  useEffect(() => {
    if (!shouldCollapseQueue && bannerQueueExpanded) {
      setBannerQueueExpanded(false);
    }
  }, [shouldCollapseQueue, bannerQueueExpanded]);
  const showBanner = (id: BannerId): boolean =>
    bannerSlots.primary === id ||
    bannerSlots.secondary.includes(id) ||
    (bannerSlots.queued.includes(id) && (!shouldCollapseQueue || bannerQueueExpanded));

  return (
    <ErrorBoundary name="NotesEditor">
      <div
        ref={notesShellRef}
        className={cn('notes-crepe-shell flex-1 min-h-0 flex flex-col bg-background relative', className)}
        data-focus-mode={focus.isChromeHidden ? 'true' : 'false'}
        data-focus-chrome={focus.focusChromePhase}
      >
        {hasMobileResourceMenu && mobileResourceMenu?.element && shellInViewport && !suppressMobileToolbar && createPortal(
          <div onClick={(event) => { if ((event.target as HTMLElement).closest('button:not([data-keep-open])')) mobileResourceMenu.close(); }}>
            {pageActions}{headerActions}
          </div>,
          mobileResourceMenu.element,
        )}

        {isDraggingOver && (
          <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none ui-rise-in"
            style={{ backgroundColor: 'hsl(var(--background) / 0.72)' }}>
            <div className="flex flex-col items-center gap-3 px-7 py-5 rounded-[var(--radius-shell-control,12px)] pointer-events-none"
              style={{ backgroundColor: 'hsl(var(--background))', border: '1px dashed hsl(var(--border))', boxShadow: 'var(--notes-popup-shadow, 0 4px 16px hsl(var(--shadow-base) / 0.12))' }}>
              <div className="w-9 h-9 rounded-sm flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--muted))' }}>
                <ImageSquare size={20} style={{ color: 'hsl(var(--muted-foreground))' }} />
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <span className="text-sm font-medium" style={{ color: 'hsl(var(--foreground))' }}>{t('notes:editor.image_upload.drop_overlay_title')}</span>
                <span className="text-xs" style={{ color: 'hsl(var(--muted-foreground))' }}>{t('notes:editor.image_upload.drop_overlay_hint')}</span>
              </div>
            </div>
          </div>
        )}

        {showBanner('conflict') && (
          <NotesConflictBanner
            conflictAction={conflict.conflictAction}
            conflictDiffOpen={conflict.conflictDiffOpen}
            onToggleDiffOpen={() => conflict.setConflictDiffOpen((open) => !open)}
            conflictDiffRegionId={conflict.conflictDiffRegionId}
            conflictDiffLines={conflict.conflictDiffLines}
            conflictDiffStats={conflict.conflictDiffStats}
            conflictRemoteStatus={conflict.conflictRemoteStatus}
            onRetryFetchRemote={() => { void conflict.fetchConflictRemote(); }}
            onResolve={conflict.resolveConflict}
          />
        )}

        <div className="notes-editor-header-section sticky top-0 z-10 w-full flex-shrink-0 bg-background"
          data-mobile-hosted={hasMobileResourceMenu || undefined}
          data-chrome-portaled={hasPortalChromeHost || undefined}>
          {!hasMobileResourceMenu && !hasPortalChromeHost && (
            <div className="notes-editor-chrome-row notes-column flex items-center gap-1">
              <div className="ml-auto flex shrink-0 items-center gap-1">{chromeActions}</div>
            </div>
          )}
          {hasMobileResourceMenu && !focus.focusMode && (
            <div className="notes-mobile-save-bar notes-column flex items-center justify-end gap-1 py-1" data-testid="notes-mobile-save-bar">
              <NotesSaveIndicator saveStatus={save.saveStatus} lastSaved={save.lastSaved} charCount={charCount}
                readOnly={effectiveReadOnly} onRetrySave={effectiveReadOnly ? undefined : save.handleManualSave} />
            </div>
          )}
          {portalChrome && notesChromeSlot && createPortal(chromeActions, notesChromeSlot)}

          <NotesReviewCheckinBanner
            noteId={noteId}
            effectiveReadOnly={effectiveReadOnly}
            focusMode={focus.focusMode}
            hidden={!showBanner('review-due')}
            onDueChange={setIsReviewDue}
          />

          {!readOnly && (
            <NotesTemplatePanel
              key={noteId} open={templateMenuOpen} onRequestClose={() => setTemplateMenuOpen(false)}
              onApplyTemplate={applyTemplate} disabled={effectiveReadOnly || !editorApi}
              panelId={templatePanelId} triggerRef={templateTriggerRef}
              documentHost={editorApi && !effectiveReadOnly ? templateDocumentHost(
                editorApi as FullDocumentSearchApi, () => templateInsertionRef.current,
                { title: initialTitle ?? '', locale: i18n?.resolvedLanguage ?? i18n?.language },
              ) : undefined}
              learningPropsHost={!effectiveReadOnly ? learningPropsHost : undefined}
            />
          )}

          {agentWrite && !aiEditState.isActive && showBanner('agent-write') && (
            <div className="notes-ai-checkpoint-bar w-full border-t border-border/50 bg-[hsl(var(--primary)/0.05)] ui-rise-in" role="status">
              <div className="notes-column flex items-center gap-2 py-1.5">
                <Robot size={14} className="text-primary shrink-0" />
                <span className="min-w-0 truncate text-xs text-foreground">
                  {agentWrite.stale ? t('notes:agentWrite.stale_short', 'AI 修改后笔记又有改动，撤销请用历史版本') : t('notes:agentWrite.applied', 'AI 刚修改了这篇笔记')}
                </span>
                <div className="ml-auto flex flex-shrink-0 items-center gap-1">
                  <DsButton variant="ghost" size="sm" disabled={agentWrite.stale || effectiveReadOnly}
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
                    onClick={() => { void undoAgentWrite(); }}>
                    <ArrowCounterClockwise size={12} className="mr-1" />{t('notes:agentWrite.undo', '撤销本次修改')}
                  </DsButton>
                  <DsButton variant="ghost" size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                    onClick={() => setAgentWrite(null)} aria-label={t('notes:agentWrite.keep', '保留修改')}>
                    <X size={12} />
                  </DsButton>
                </div>
              </div>
            </div>
          )}

          {aiCheckpoint && !aiEditState.isActive && showBanner('ai-checkpoint') && (
            <div className="notes-ai-checkpoint-bar w-full border-t border-border/50 bg-[hsl(var(--primary)/0.05)] ui-rise-in" role="status">
              <div className="notes-column flex items-center gap-2 py-1.5">
                <Robot size={14} className="text-primary shrink-0" />
                <span className="min-w-0 truncate text-xs text-foreground">
                  {aiCheckpoint.stale ? t('notes:aiCheckpoint.stale')
                    : aiCheckpoints.length > 1 ? t('notes:aiCheckpoint.appliedCount', { count: aiCheckpoints.length })
                      : t('notes:aiCheckpoint.applied')}
                </span>
                <div className="ml-auto flex flex-shrink-0 items-center gap-1">
                  <DsButton variant="ghost" size="sm" disabled={aiCheckpoint.stale}
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
                    onClick={() => { void rollbackCheckpoint(); }}>
                    <ArrowCounterClockwise size={12} className="mr-1" />{t('notes:aiCheckpoint.rollback')}
                  </DsButton>
                  <DsButton variant="ghost" size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                    onClick={() => dismissCheckpoint()} aria-label={t('notes:aiCheckpoint.keep')}>
                    <X size={12} />
                  </DsButton>
                </div>
              </div>
            </div>
          )}
        </div>

        {focus.focusMode && (
          <CommonTooltip content={`${t('notes:toolbar.exit_focus_mode', 'Exit focus mode')} (${isMacOS() ? '⌘⇧U' : 'Ctrl+Shift+U'})`} position="left">
            <DsButton variant="ghost" iconOnly size="sm"
              className="notes-focus-exit h-8 w-8 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
              onClick={focus.toggleFocusMode} aria-label={t('notes:toolbar.exit_focus_mode', 'Exit focus mode')}>
              <CornersIn size={17} />
            </DsButton>
          </CommonTooltip>
        )}

        <div className="relative shrink-0" ref={findReplaceContainerRef}>
          {isFindReplaceOpen && (
            <FindReplacePanel editorApi={editorApi} onClose={handleFindReplaceClose} readOnly={effectiveReadOnly} initialQuery={findInitialQuery} />
          )}
        </div>

        {hostRefreshError && showBanner('host-refresh-error') && (
          <div role="alert" className="notes-banner" data-tone="warning"><div className="notes-column notes-banner-row">
            <span className="flex-1">{hostRefreshError}</span>
            <DsButton variant="ghost" size="sm" disabled={hostBusy} onClick={() => {
              if (noteId) void noteHostCoordinator.withLockedNotes([noteId], () => noteHostCoordinator.refreshNotes([noteId])).catch((error) => showGlobalNotification('error', String(error)));
            }}>{t('notes:host.retry_refresh', '重试刷新')}</DsButton>
          </div></div>
        )}
        {save.draftPersistenceError && showBanner('draft-persistence-error') && (
          <div role="alert" className="notes-banner" data-tone="warning"><div className="notes-column notes-banner-row">
            <span className="flex-1">{t('notes:host.draft_persist_failed', { defaultValue: '草稿持久化失败：{{error}}', error: save.draftPersistenceError })}</span>
            <DsButton variant="ghost" size="sm" onClick={save.retryDraftPersistence}>{t('notes:host.retry_draft_store', '重试草稿存储')}</DsButton>
          </div></div>
        )}
        {save.recoveredDrafts.length > 0 && showBanner('recovered-drafts') && (
          <div className="notes-banner" role="status"><div className="notes-column notes-banner-row">
            <span className="flex-1">{t('notes:host.drafts_found', '已找到未保存草稿')}</span>
            {save.recoveredDrafts.map((draft, index) => (
              <DsButton key={draft.persistenceId} variant="ghost" size="sm" onClick={() => { if (noteId) save.setRecoveryDraft({ ...draft, noteId }); }}>
                {t('notes:host.view_draft', { defaultValue: '查看草稿 {{index}}', index: index + 1 })}
              </DsButton>
            ))}
          </div></div>
        )}
        {save.recoveryDraft && save.recoveryDraft.noteId === noteId && showBanner('recovery-draft') && (
          <div role="alert" className="notes-banner" data-tone="warning"><div className="notes-column notes-banner-row">
            <span className="flex-1">{save.recoveryDraft.error}</span>
            <DsButton variant="ghost" size="sm" onClick={() => { void save.copyRecoveryDraft(); }}>{t('notes:editor.copy_retained_draft', '复制保留草稿')}</DsButton>
            <DsButton variant="ghost" size="sm" onClick={() => { void save.saveRecoveryAs(); }}>{t('notes:host.save_draft_as_note', '草稿另存为笔记')}</DsButton>
            <DsButton variant="ghost" size="sm" disabled={effectiveReadOnly || save.isSaving} onClick={() => { void save.handleManualSave().catch(() => {}); }}>{t('notes:editor.retry_current_draft', '重试保存当前正文')}</DsButton>
            <DsButton variant="ghost" size="sm" disabled={effectiveReadOnly || save.isSaving} onClick={() => { void save.restoreRecoveryDraft(); }}>{t('notes:editor.restore_retained_draft', '恢复保留草稿并保存')}</DsButton>
            {save.recoveryDraft.previousMarkdown !== undefined && <>
              <DsButton variant="ghost" size="sm" onClick={() => { void save.copyRecoveryDraft(true); }}>{t('notes:editor.copy_previous_draft', '复制操作前草稿')}</DsButton>
              <DsButton variant="ghost" size="sm" disabled={effectiveReadOnly || save.isSaving} onClick={() => { void save.restoreRecoveryDraft(true); }}>{t('notes:editor.restore_previous_draft', '恢复操作前草稿')}</DsButton>
            </>}
            <DsButton variant="ghost" size="sm" onClick={() => { void save.discardRecoveryDraft(); }}>{t('notes:editor.discard_retained_draft', '丢弃保留草稿')}</DsButton>
          </div></div>
        )}
        {(aiPersistenceError || aiRecoveryOptions.length > 0) && showBanner('ai-recovery') && (
          <div role="alert" className="notes-banner" data-tone="warning"><div className="notes-column notes-banner-row">
            <span className="flex-1">{aiPersistenceError ?? t('notes:aiReview.recovery_available')}</span>
            {aiRecoveryOptions.map((option, index) => (
              <DsButton key={option.id} variant="ghost" size="sm" disabled={aiPersistenceStatus === 'loading'}
                onClick={() => { void restoreAICandidate(option.id); }}>
                {t('notes:aiReview.restore_candidate', { index: index + 1, date: new Date(option.createdAt).toLocaleString() })}
              </DsButton>
            ))}
            <DsButton variant="ghost" size="sm" disabled={aiPersistenceStatus === 'loading' || aiPersistenceStatus === 'saving'}
              onClick={() => { void retryAIReviewPersistence(); }}>{t('common:retry')}</DsButton>
          </div></div>
        )}
        {aiReview?.collapsed && showBanner('ai-collapsed') && (
          <div role="status" className="notes-banner"><div className="notes-column notes-banner-row">
            <span className="flex-1">{t('notes:aiDiff.suspended', 'AI 建议已收起，候选与分组决定已保留。')}</span>
            <DsButton variant="ghost" size="sm" onClick={() => setAIReviewCollapsed(false)}>{t('notes:aiDiff.reopen', '继续审阅')}</DsButton>
            <DsButton variant="ghost" size="sm" onClick={() => { void copyAICandidate(); }}>{t('notes:aiDiff.copy_candidate', '复制候选')}</DsButton>
            <DsButton variant="ghost" size="sm" disabled={isAIEditApplying} onClick={() => { void handleReject(); }}>{t('notes:aiDiff.discard', '丢弃建议')}</DsButton>
          </div></div>
        )}
        {aiEditState.isActive && !aiReview?.collapsed && showBanner('ai-diff') && (
          <AIDiffPanel
            {...officialReviewProps} {...scopeProps}
            state={aiEditState} review={aiReview} noteTitle={initialTitle}
            onAccept={() => { void handleAccept(); }}
            onApplySelected={() => { void handleAccept(false); }}
            onReject={handleReject}
            onSuspend={() => setAIReviewCollapsed(true)}
            onCopy={() => { void copyAICandidate(); }}
            onDecideGroup={decideAIReviewGroup}
            readOnly={effectiveReadOnly} isApplying={isAIEditApplying}
            suspendShortcuts={historyOpen || isFindReplaceOpen || templateMenuOpen || pageActionsOpen || conflict.conflictDiffOpen}
            canHandleShortcut={() => !save.isComposingRef.current && !!notesShellRef.current?.contains(document.activeElement)}
          />
        )}
        {shouldCollapseQueue && (
          <div className="notes-banner" role="status">
            <div className="notes-column notes-banner-row">
              <button
                type="button"
                className="notes-banner-queue-toggle"
                aria-expanded={bannerQueueExpanded}
                onClick={() => setBannerQueueExpanded((expanded) => !expanded)}
              >
                {bannerQueueExpanded
                  ? t('notes:bannerQueue.collapse', '收起其余通知')
                  : t('notes:bannerQueue.more', { defaultValue: '还有 {{count}} 条通知', count: bannerSlots.hiddenCount })}
              </button>
            </div>
          </div>
        )}

        <CustomScrollArea className="notes-editor-content-scroll flex-1" viewportClassName="overflow-x-visible"
          viewportRef={scrollViewportRef} viewportProps={{ onScroll: handleViewportScroll }}>
          <div
            className="notes-editor-content notes-column min-h-full relative flex flex-col"
            style={{
              paddingBottom: showMobileToolbar
                ? 'calc(var(--mobile-toolbar-height, 52px) + var(--mobile-toolbar-keyboard-offset, 0px) + var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 12vh)'
                : '30vh',
            }}
            ref={(el) => { dropZoneRef.current = el; selectionContainerRef.current = el; }}
            onMouseDown={(event) => {
              if (event.button !== 0 || effectiveReadOnly || sourceMode) return;
              const target = event.target as HTMLElement;
              if (target.closest('.ProseMirror, button, input, textarea, a, [role="menu"], [role="dialog"], .notes-document-header, .milkdown-block-handle')) return;
              const editorEl = event.currentTarget.querySelector('.ProseMirror');
              if (!editorEl || event.clientY <= editorEl.getBoundingClientRect().bottom) return;
              event.preventDefault();
              editorApi?.focusEnd?.();
            }}
          >
            {effectiveReadOnly && !sourceMode && (
              <SelectionToolbar
                selectedText={noteSelection.selectedText} selectionRect={noteSelection.selectionRect}
                isVisible={noteSelection.isVisible} containerRef={selectionContainerRef} onClear={noteSelection.clear}
                onAddAsContext={noteId ? handleSelectionAddAsContext : undefined}
                extraActions={noteId ? [
                  {
                    key: 'ask-ai',
                    label: t('notes:selection.askAi', '问 AI'),
                    icon: ({ touchTarget }) => <Sparkle size={touchTarget ? 16 : 14} />,
                    run: handleSelectionAskAi,
                  },
                  {
                    key: 'excerpt-to-mindmap',
                    label: t('notes:selection.excerptToMindmap', '摘录到导图'),
                    icon: ({ touchTarget }) => <TreeStructure size={touchTarget ? 16 : 14} />,
                    run: handleSelectionExcerptToMindmap,
                  },
                ] : undefined}
                hideUnavailableActions dismissOnLeaveView={null}
              />
            )}
            <NotesEditorHeader
              lastSaved={save.lastSaved} saveStatus={save.saveStatus}
              onRetrySave={effectiveReadOnly ? undefined : save.handleManualSave}
              charCount={charCount} initialTitle={initialTitle}
              onTitleChange={!effectiveReadOnly ? onTitleChange : undefined}
              noteId={noteId} readOnly={effectiveReadOnly} tags={tags}
              onTagsChange={effectiveReadOnly ? undefined : onTagsChange}
              breadcrumbs={breadcrumbs}
              onBreadcrumbClick={onBreadcrumbClick}
              onExitToBody={() => {
                if (sourceModeRef.current) {
                  sourceEditorRef.current?.focus();
                } else {
                  editorApi?.focusStart?.();
                }
              }}
              // RUST-FIX(RF-W09-new-note-title-focus): 等正文编辑器就绪后再聚焦标题
              autoFocusTitle={!effectiveReadOnly && editorApi !== null && !initialContent.trim()}
            />
            {sourceMode && (
              <React.Suspense fallback={<div className="py-8 text-xs text-muted-foreground">{t('common:loading')}</div>}>
                <NoteSourceEditor
                  ref={handleSourceEditorRef}
                  value={sourceDraft}
                  readOnly={effectiveReadOnly}
                  onChange={handleSourceChange}
                  onExitSourceMode={handleToggleSourceMode}
                  className="flex-1 min-h-[40vh]"
                />
              </React.Suspense>
            )}
            <div className={cn('flex-1 flex-col min-h-0', sourceMode ? 'hidden' : 'flex')} hidden={sourceMode}>
              <CrepeEditor
                key={contentVersionKey} noteId={noteId} className="flex-1 min-h-[40vh] ui-rise-in"
                defaultValue={initialContent} onChange={handleRichEditorChange}
                onDocumentChange={save.handleDocumentChange} onFormattingChange={handleFormattingChange}
                onReady={handleEditorReady} readonly={effectiveReadOnly} selectionActions={selectionActions}
                plugins={{ wikilink: buildWikilinkPluginHostConfig(), inlineCards: noteId ? { noteId } : true, highlight: true }}
              />
            </div>
            {windowingState?.enabled && (windowingState.hasMore || windowingState.isLoadingMore || windowingState.loadMoreError) && (
              <div className="mt-6 flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground/70">
                {windowingState.isLoadingMore ? (
                  <><CircleNotch size={14} className="animate-spin text-primary" /><span>{t('notes:editor.windowing.loading_more')}</span></>
                ) : windowingState.loadMoreError ? (
                  <>
                    <span>{t('notes:editor.windowing.load_more_failed')}</span>
                    <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs [@media(pointer:coarse)]:!min-h-11" onClick={onRetryLoadMore}>
                      {t('notes:editor.windowing.retry')}
                    </DsButton>
                  </>
                ) : null}
              </div>
            )}
          </div>
        </CustomScrollArea>

        <NoteFloatingToc
          noteId={noteId}
          markdown={liveTocMarkdown}
          hidden={suppressFloatingToc || sourceMode || focus.focusMode || isTouchEditingSurface}
          onNavigateHeading={(target) => {
            if (!editorApi?.scrollToHeading) return;
            void (editorApi as FullDocumentSearchApi).materializeFullDocument?.()
              .then(() => editorApi.scrollToHeading(target.text, target.level, undefined, undefined, target.occurrence))
              .catch(() => editorApi.scrollToHeading(target.text, target.level, undefined, undefined, target.occurrence));
          }}
        />

        {selectedCharCount > 0 && !sourceMode && (
          <div
            className="notes-selection-counter"
            role="status"
            aria-live="polite"
            data-testid="notes-selection-counter"
            data-above-mobile-toolbar={showMobileToolbar && !mobileToolbarCollapsed ? 'true' : undefined}
          >
            {t('notes:selection.count', { defaultValue: '已选 {{count}} 字', count: selectedCharCount })}
          </div>
        )}

        {noteId && (
          <NoteHistoryPanel
            noteId={noteId} open={historyOpen} onOpenChange={setHistoryOpen}
            withOverwrite={(operation) => noteHostCoordinator.withLockedNotes([noteId], operation)}
            beforeOverwrite={async () => { await noteHostCoordinator.flushPendingSaves([noteId]); return true; }}
            onRestoredCurrent={async () => { noteHostCoordinator.invalidateNotes([noteId]); await noteHostCoordinator.refreshNotes([noteId]); }}
            onRestoredCopy={() => { void refreshWikilinkNotesCache(); }}
          />
        )}

        <MobileEditorToolbar visible={showMobileToolbar} collapsed={mobileToolbarCollapsed} commands={mobileCommands} activeStates={formattingState} />
        <ImageOcclusionBuilderModal defaultDeckName={initialTitle || undefined} />
      </div>
    </ErrorBoundary>
  );
};

export default NotesCrepeEditor;
