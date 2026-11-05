import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/lib/utils';
import {
  InkPageView,
  type InkPageViewHandle,
  type InkSelectionMode,
  type InkSelectionRegion,
  type InkToolSettings,
} from './InkPageView';
import { InkToolbar } from './InkToolbar';
import { flushInkEditor, registerInkEditorSession, type InkEditorSession } from './editorSession';
import { enqueueInkDocumentExit, useInkDocument } from './useInkDocument';
import { useInkBackground } from './useInkBackground';
import {
  clampEraserSize,
  clampInkOpacity,
  clampInkWidth,
  inkStyleColor,
  loadInkToolPreferences,
  normalizeHexColor,
  saveInkToolPreferences,
  type InkToolName,
  type InkToolStyleSettings,
} from './toolSettings';
import { selectedInkObjects } from './selection';
import {
  InkPasteGeometryError,
  parseInkClipboard,
  pasteInkClipboard,
  serializeInkClipboard,
} from './clipboard';
import { copyTextToClipboard, readTextFromClipboard } from '@/utils/clipboardUtils';
import type { InkPage, InkRect, InkRuling } from './types';

export interface InkAskAiRequest {
  documentId: string;
  pageId: string;
  revision: string;
  crop?: InkRect;
}

export interface InkEditorProps {
  documentId: string;
  className?: string;
  initialPageId?: string;
  exportControls?: React.ReactNode;
  onAskAi?: (request: InkAskAiRequest) => void;
  onExport?: (documentId: string, pageId: string, revision: string) => void;
}

type InkHistory = { undo: InkPage[]; redo: InkPage[] };

export function InkEditor({ documentId, className, initialPageId, exportControls, onAskAi, onExport }: InkEditorProps) {
  const { t } = useTranslation('ink');
  const docState = useInkDocument(documentId, initialPageId);
  const { getSnapshot: getDocumentSnapshot, savePage: commitPage, flush: flushDocument, persistDraft: persistDocumentDraft, setActiveStroke } = docState;
  const inkBackground = useInkBackground({
    documentId,
    status: docState.status,
    manifest: docState.manifest,
    pageRef: docState.pageRef,
  });
  const pageViewRef = useRef<InkPageViewHandle>(null);
  const activeStrokeRef = useRef(false);
  const interactionEpochRef = useRef(0);
  const documentRef = useRef(docState);
  documentRef.current = docState;
  const handleActiveStrokeChange = useCallback((active: boolean) => {
    if (documentRef.current.getSnapshot === getDocumentSnapshot) activeStrokeRef.current = active;
    setActiveStroke(active);
  }, [getDocumentSnapshot, setActiveStroke]);
  const historiesRef = useRef(new Map<string, InkHistory>());
  const [historyRevision, setHistoryRevision] = useState(0);
  const seenRemoteReloadRef = useRef(docState.remoteReloadSequence);
  const [tool, setTool] = useState<InkToolName>('pen');
  const [initialToolPreferences] = useState(() => loadInkToolPreferences());
  const [settingsByTool, setSettingsByTool] = useState<Record<InkToolName, InkToolStyleSettings>>(() => ({
    pen: { ...initialToolPreferences.settings.pen },
    highlighter: { ...initialToolPreferences.settings.highlighter },
  }));
  const [erasing, setErasing] = useState(false);
  const [eraserSize, setEraserSize] = useState(initialToolPreferences.eraserSize);
  const [touchDrawing, setTouchDrawing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewportIntentRef = useRef({ documentId, manual: false, resetPan: false, fitZoom: 1 });
  if (viewportIntentRef.current.documentId !== documentId) {
    viewportIntentRef.current = { documentId, manual: false, resetPan: true, fitZoom: 1 };
  }
  const preserveViewport = useCallback(() => {
    viewportIntentRef.current.manual = true;
  }, []);
  const handleViewportWidthChange = useCallback((width: number) => {
    const current = documentRef.current;
    const intent = viewportIntentRef.current;
    if (current.manifest?.document_id !== documentId || !current.pageRef || !Number.isFinite(width) || width <= 0) return;
    const fitZoom = Math.min(1, width / current.pageRef.width);
    if (intent.manual || activeStrokeRef.current) return;
    intent.fitZoom = fitZoom;
    setZoom(fitZoom);
    if (intent.resetPan) {
      intent.resetPan = false;
      setPan({ x: 0, y: 0 });
    }
  }, [documentId]);
  const [renameValue, setRenameValue] = useState('');
  const [pageError, setPageError] = useState(false);
  const [selectionMode, setSelectionMode] = useState<InkSelectionMode>('none');
  const [selection, setSelection] = useState<InkSelectionRegion | null>(null);
  const [pasteError, setPasteError] = useState<'too-large' | null>(null);
  const selectionRef = useRef<InkSelectionRegion | null>(null);
  selectionRef.current = selection;
  const clipboardQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueClipboard = useCallback((task: () => Promise<void>) => {
    const run = clipboardQueueRef.current.then(task, task);
    clipboardQueueRef.current = run.catch(() => undefined);
    return run;
  }, []);
  const clipboardSourceRef = useRef<{
    documentId: string;
    pageId: string;
    text: string;
  } | null>(null);
  const toolPreferencesInitializedRef = useRef(false);

  // The first effect run only reflects the lazy load above; later style or
  // eraser changes are persisted by the best-effort preference helper.
  useEffect(() => {
    if (!toolPreferencesInitializedRef.current) {
      toolPreferencesInitializedRef.current = true;
      return;
    }
    saveInkToolPreferences({ settings: settingsByTool, eraserSize });
  }, [settingsByTool, eraserSize]);

  const pageId = docState.page?.page_id;
  const historyFor = (page: InkPage): InkHistory => historiesRef.current.get(page.page_id) ?? { undo: [], redo: [] };
  const history = docState.page ? historyFor(docState.page) : { undo: [], redo: [] };
  const selectedObjectsForCopy = useMemo(() => {
    if (!docState.page || !selection) return [];
    return selectedInkObjects(docState.page, selection.polygon);
  }, [docState.page, selection]);

  useEffect(() => {
    if (seenRemoteReloadRef.current === docState.remoteReloadSequence || !pageId) return;
    seenRemoteReloadRef.current = docState.remoteReloadSequence;
    // A remote reload advances the document epoch, so every cached page snapshot
    // is based on a revision that is no longer canonical. Ordinary page
    // navigation does not change remoteReloadSequence and keeps its local history.
    historiesRef.current.clear();
    setHistoryRevision((revision) => revision + 1);
  }, [pageId, docState.remoteReloadSequence]);

  useEffect(() => {
    activeStrokeRef.current = false;
    historiesRef.current.clear();
    setHistoryRevision((revision) => revision + 1);
  }, [documentId]);

  // 选区是 transient UI state：翻页或远端 epoch 变化后失效，绝不写入页面/manifest。
  useEffect(() => {
    setSelection(null);
    setSelectionMode('none');
    setPasteError(null);
  }, [pageId, docState.remoteReloadSequence]);

  // 目标对象被编辑/粘贴/删除（page 引用变化）后，旧选区也不应继续生效。
  useEffect(() => {
    setSelection(null);
  }, [docState.page]);

  // 远端保存冲突后旧选区/旧对象不再可信；正常保存路径保持不变。
  useEffect(() => {
    if (docState.saveStatus === 'conflict') setSelection(null);
  }, [docState.saveStatus]);

  // 翻页 / 工具 / 橡皮 / 选择模式 / remote epoch 变化都会让旧的 paste 交互失效。
  useEffect(() => {
    interactionEpochRef.current += 1;
  }, [pageId, docState.remoteReloadSequence, selectionMode, erasing, tool]);

  useEffect(() => () => {
    interactionEpochRef.current += 1;
  }, []);

  const finishAndFlush = useCallback(async () => {
    const current = getDocumentSnapshot();
    if (documentRef.current.getSnapshot !== getDocumentSnapshot) throw new Error('Ink editor document changed before flush.');
    await pageViewRef.current?.finishStroke();
    const finished = getDocumentSnapshot();
    if (documentRef.current.getSnapshot !== getDocumentSnapshot || finished.remoteReloadSequence !== current.remoteReloadSequence) {
      throw new Error('Ink editor changed while finishing input.');
    }
    await flushDocument();
    const latest = getDocumentSnapshot();
    if (documentRef.current.getSnapshot !== getDocumentSnapshot || latest.page?.page_id !== current.page?.page_id
      || latest.remoteReloadSequence !== current.remoteReloadSequence || latest.saveStatus !== 'saved' || activeStrokeRef.current) {
      throw new Error('Ink editor changed during flush.');
    }
    return latest;
  }, [getDocumentSnapshot, flushDocument]);

  const toggleSelectionMode = useCallback((mode: InkSelectionMode) => {
    setSelection(null);
    setErasing(false);
    setSelectionMode((current) => (current === mode ? 'none' : mode));
  }, []);

  const handleSelectionChange = useCallback((next: InkSelectionRegion | null) => {
    setSelection(next);
  }, []);

  const handleSelectionCopy = useCallback(() => {
    const page = documentRef.current.getSnapshot().page;
    const region = selectionRef.current;
    if (!region || !page) return;
    if (selectedInkObjects(page, region.polygon).length === 0) return;
    const pageIdAtClick = page.page_id;

    void enqueueClipboard(async () => {
      try {
        const current = documentRef.current.getSnapshot();
        if (!current.page || current.page.page_id !== pageIdAtClick) return;
        const region = selectionRef.current;
        if (!region) return;
        const objects = selectedInkObjects(current.page, region.polygon);
        if (objects.length === 0) return;

        setPageError(false);
        const text = serializeInkClipboard(objects);
        await copyTextToClipboard(text);
        // Source identity is published only after the write actually succeeds.
        clipboardSourceRef.current = {
          documentId,
          pageId: current.page.page_id,
          text,
        };
      } catch {
        setPageError(true);
      }
    });
  }, [documentId, enqueueClipboard]);

  const handleSelectionAskAi = useCallback(async () => {
    if (!onAskAi) return;
    const activeSelection = selectionRef.current;
    const startPageId = pageId;
    const startRemoteSequence = docState.remoteReloadSequence;
    if (!activeSelection || !startPageId) return;

    try {
      setPageError(false);
      const latest = await finishAndFlush();
      if (!latest.page || !latest.manifest
        || latest.page.page_id !== startPageId
        || latest.remoteReloadSequence !== startRemoteSequence) return;
      onAskAi({
        documentId,
        pageId: latest.page.page_id,
        revision: latest.manifest.revision,
        crop: activeSelection.bounds,
      });
    } catch {
      setPageError(true);
    }
  }, [documentId, docState.remoteReloadSequence, finishAndFlush, onAskAi, pageId]);

  const persistCurrentDraft = useCallback(async () => {
    const current = documentRef.current;
    await pageViewRef.current?.finishStroke();
    await current.persistDraft();
  }, []);

  const sessionPageId = docState.manifest?.pages[0]?.page_id;
  const session = useMemo<InkEditorSession | null>(() => {
    if (!sessionPageId) return null;
    return {
      key: { document_id: documentId, page_id: sessionPageId },
      isDirty: () => {
        const current = getDocumentSnapshot();
        return (documentRef.current.getSnapshot === getDocumentSnapshot && activeStrokeRef.current)
          || (current.saveStatus !== 'saved' && current.saveStatus !== 'loading');
      },
      flush: async () => { await finishAndFlush(); },
      persistDraft: persistDocumentDraft,
    };
  }, [documentId, sessionPageId, getDocumentSnapshot, persistDocumentDraft, finishAndFlush]);

  useEffect(() => {
    if (!session) return;
    const view = pageViewRef.current;
    const getSnapshot = getDocumentSnapshot;
    const unregister = registerInkEditorSession(session);
    return () => {
      unregister();
      void enqueueInkDocumentExit(documentId, async () => {
        try {
          await view?.finishStroke();
          const status = getSnapshot().saveStatus;
          if (session.isDirty() && (status === 'pending' || status === 'saving')) await flushDocument();
          else await session.persistDraft();
        } catch {
          await session.persistDraft();
        }
      }).catch(() => undefined);
    };
  }, [documentId, flushDocument, getDocumentSnapshot, session]);

  const onVisibilityHidden = useCallback(() => {
    if (documentRef.current.status !== 'ready' || globalThis.document.visibilityState !== 'hidden') return;
    void persistCurrentDraft().catch(() => undefined);
  }, [persistCurrentDraft]);
  const onPageHide = useCallback(() => {
    if (documentRef.current.status !== 'ready') return;
    void persistCurrentDraft().catch(() => undefined);
  }, [persistCurrentDraft]);
  useEventRegistry([
    { target: 'document', type: 'visibilitychange', listener: onVisibilityHidden },
    { target: 'window', type: 'pagehide', listener: onPageHide },
  ], [onVisibilityHidden, onPageHide]);

  const onPageChange = useCallback(async (page: InkPage, expectedRevision?: string) => {
    const current = getDocumentSnapshot();
    const previous = current.page;
    if (!previous || previous.page_id !== page.page_id || previous === page) return;
    if (expectedRevision !== undefined && current.manifest?.revision !== expectedRevision) {
      throw new Error('Ink page revision changed before commit');
    }
    if (documentRef.current.getSnapshot !== getDocumentSnapshot) {
      await commitPage(page, expectedRevision);
      return;
    }
    const currentHistory = historyFor(previous);
    if (currentHistory.undo[currentHistory.undo.length - 1] !== page) {
      historiesRef.current.set(page.page_id, { undo: [...currentHistory.undo, previous], redo: [] });
      setHistoryRevision((revision) => revision + 1);
    }
    await commitPage(page, expectedRevision);
  }, [getDocumentSnapshot, commitPage]);

  const handleSelectionPaste = useCallback(() => {
    const target = documentRef.current.getSnapshot();
    if (!target.page || !target.pageRef || !target.manifest || target.status !== 'ready') return;
    const captured = {
      documentId,
      pageId: target.page.page_id,
      remoteReloadSequence: target.remoteReloadSequence,
      revision: target.manifest.revision,
      epoch: interactionEpochRef.current,
    };
    const isStillTarget = () => {
      const current = documentRef.current.getSnapshot();
      return captured.documentId === documentId
        && interactionEpochRef.current === captured.epoch
        && current.status === 'ready'
        && current.page?.page_id === captured.pageId
        && current.remoteReloadSequence === captured.remoteReloadSequence
        && current.manifest?.revision === captured.revision
        && current.saveStatus !== 'conflict'
        && current.saveStatus !== 'storage-error'
        && !activeStrokeRef.current;
    };

    void enqueueClipboard(async () => {
      if (!isStillTarget()) return;
      try {
        setPageError(false);
        setPasteError(null);
        const text = await readTextFromClipboard();
        if (!isStillTarget() || !text) return;
        const payload = parseInkClipboard(text);

        if (!isStillTarget()) return;
        const current = documentRef.current.getSnapshot();
        if (!current.page || !current.pageRef) return;
        const source = clipboardSourceRef.current;
        const samePage = Boolean(
          source
          && source.documentId === documentId
          && source.pageId === current.page.page_id
          && source.text === text,
        );
        const crossPageCenter = pageViewRef.current?.getViewportCenter() ?? {
          x: Math.max(0, Math.min(current.pageRef.width, current.pageRef.width / 2)),
          y: Math.max(0, Math.min(current.pageRef.height, current.pageRef.height / 2)),
        };
        const nextPage = pasteInkClipboard(payload, {
          page: current.page,
          pageRef: current.pageRef,
          ...(samePage
            ? { offset: { x: 16, y: 16 } }
            : { center: crossPageCenter }),
        });
        // Target may have changed while building the page; never commit a stale paste.
        if (!isStillTarget()) return;
        // Keep a paste atomic against the revision captured before clipboard access.
        await onPageChange(nextPage, captured.revision);
        setSelection(null);
      } catch (error) {
        if (error instanceof InkPasteGeometryError) {
          setPasteError('too-large');
        } else {
          setPageError(true);
        }
      }
    });
  }, [documentId, enqueueClipboard, onPageChange]);

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.repeat) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    const key = event.key.toLowerCase();
    if (key === 'c') {
      if (!selectionRef.current) return;
      event.preventDefault();
      void handleSelectionCopy();
      return;
    }
    if (key === 'v') {
      if (selectionMode === 'none') return;
      event.preventDefault();
      void handleSelectionPaste();
    }
  }, [handleSelectionCopy, handleSelectionPaste, selectionMode]);

  const applyHistory = useCallback(async (direction: 'undo' | 'redo') => {
    const current = documentRef.current.getSnapshot().page;
    if (!current) return;
    const currentHistory = historyFor(current);
    const source = direction === 'undo' ? currentHistory.undo : currentHistory.redo;
    if (!source.length) return;
    const target = source[source.length - 1];
    const nextHistory: InkHistory = direction === 'undo'
      ? { undo: source.slice(0, -1), redo: [...currentHistory.redo, current] }
      : { undo: [...currentHistory.undo, current], redo: source.slice(0, -1) };
    historiesRef.current.set(current.page_id, nextHistory);
    setHistoryRevision((revision) => revision + 1);
    await documentRef.current.savePage(target);
  }, []);

  const changePage = useCallback(async (offset: number) => {
    try {
      setPageError(false);
      const current = documentRef.current;
      await pageViewRef.current?.finishStroke();
      if (documentRef.current.getSnapshot !== current.getSnapshot) return;
      const state = current.getSnapshot();
      if (!state.manifest || !state.page) return;
      const index = state.manifest.pages.findIndex((pageRef) => pageRef.page_id === state.page?.page_id);
      const target = state.manifest.pages[index + offset];
      if (target) await current.selectPage(target.page_id);
    } catch {
      setPageError(true);
    }
  }, []);

  const appendPage = useCallback(async (ruling: InkRuling) => {
    try {
      setPageError(false);
      const current = documentRef.current;
      await pageViewRef.current?.finishStroke();
      if (documentRef.current.getSnapshot !== current.getSnapshot) return;
      const pageRef = current.getSnapshot().pageRef;
      if (pageRef) await current.appendPage(pageRef.width, pageRef.height, ruling);
    } catch {
      setPageError(true);
    }
  }, []);

  const renamePage = useCallback(async () => {
    try {
      setPageError(false);
      const current = documentRef.current;
      await pageViewRef.current?.finishStroke();
      if (documentRef.current.getSnapshot !== current.getSnapshot) return;
      await current.rename(renameValue);
    } catch {
      setPageError(true);
    }
  }, [renameValue]);

  const setZoomClamped = (next: number) => {
    preserveViewport();
    const minimum = Math.min(0.5, viewportIntentRef.current.fitZoom);
    setZoom(Math.min(4, Math.max(minimum, Number(next.toFixed(2)))));
  };
  const movePage = (x: number, y: number) => {
    preserveViewport();
    setPan((current) => ({ x: current.x + x, y: current.y + y }));
  };

  const currentSettings = settingsByTool[tool];
  const updateToolSettings = useCallback((patch: Partial<InkToolStyleSettings>) => {
    setSettingsByTool((current) => ({ ...current, [tool]: { ...current[tool], ...patch } }));
  }, [tool]);

  const toolSettings: InkToolSettings = {
    tool,
    color: inkStyleColor(currentSettings, tool),
    width: currentSettings.width,
    pressure_enabled: true,
    touchDrawing,
    zoom,
    panX: pan.x,
    panY: pan.y,
    eraserSize,
  };

  const content = docState.status === 'loading' ? (
    <div className="p-3 text-sm text-muted-foreground" role="status">{t('status.loading')}</div>
  ) : docState.status === 'error' ? (
    <div className="p-3 text-sm text-destructive" role="alert">{t('errors.loadFailed')}</div>
  ) : docState.page && docState.pageRef && docState.manifest ? (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <InkToolbar
        status={docState.saveStatus}
        pageIndex={docState.manifest.pages.findIndex((pageRef) => pageRef.page_id === docState.page?.page_id)}
        pageCount={docState.manifest.pages.length}
        pageTitle={docState.manifest.title}
        canUndo={history.undo.length > 0}
        canRedo={history.redo.length > 0}
        tool={tool}
        color={currentSettings.color}
        width={currentSettings.width}
        opacity={currentSettings.opacity}
        eraserSize={eraserSize}
        erasing={erasing}
        touchDrawing={touchDrawing}
        zoom={zoom}
        selectionMode={selectionMode}
        selectionActive={selection !== null}
        selectionCanCopy={selectedObjectsForCopy.length > 0}
        renameValue={renameValue}
        onRenameValue={setRenameValue}
        onReloadRemote={() => { void docState.reloadRemote().catch(() => setPageError(true)); }}
        onKeepDraft={() => { void persistCurrentDraft().catch(() => setPageError(true)); }}
        onRetrySave={() => { void finishAndFlush().catch(() => setPageError(true)); }}
        onRetryStorage={() => {
          const current = documentRef.current;
          void pageViewRef.current?.finishStroke().then(() => current.retryDraftStorage()).catch(() => setPageError(true));
        }}
        onSelectTool={(nextTool) => {
          setTool(nextTool);
          setErasing(false);
          setSelectionMode('none');
          setSelection(null);
        }}
        onSelectColor={(nextColor) => {
          updateToolSettings({ color: normalizeHexColor(nextColor) ?? nextColor });
          setErasing(false);
        }}
        onSelectWidth={(nextWidth) => updateToolSettings({ width: clampInkWidth(tool, nextWidth) })}
        onSelectOpacity={(nextOpacity) => updateToolSettings({ opacity: clampInkOpacity(nextOpacity) })}
        onSelectEraserSize={(nextSize) => setEraserSize(clampEraserSize(nextSize))}
        onToggleEraser={() => {
          setErasing((value) => !value);
          setSelectionMode('none');
          setSelection(null);
        }}
        onSelectSelectionMode={toggleSelectionMode}
        onSelectionCopy={() => { void handleSelectionCopy(); }}
        onSelectionPaste={() => { void handleSelectionPaste(); }}
        onSelectionAskAi={onAskAi ? () => { void handleSelectionAskAi(); } : undefined}
        onUndo={() => { void applyHistory('undo'); }}
        onRedo={() => { void applyHistory('redo'); }}
        onPreviousPage={() => { void changePage(-1); }}
        onNextPage={() => { void changePage(1); }}
        onAppendPage={(ruling) => { void appendPage(ruling); }}
        onRename={() => { void renamePage(); }}
        onAskAi={onAskAi ? () => {
          void finishAndFlush().then((current) => {
            if (current.page && current.manifest) {
              onAskAi({
                documentId,
                pageId: current.page.page_id,
                revision: current.manifest.revision,
              });
            }
          }).catch(() => setPageError(true));
        } : undefined}
        onExport={onExport ? () => {
          void finishAndFlush().then((current) => {
            if (current.page && current.manifest) onExport(documentId, current.page.page_id, current.manifest.revision);
          }).catch(() => setPageError(true));
        } : undefined}
        exportControls={exportControls}
        onZoomIn={() => setZoomClamped(zoom + 0.25)}
        onZoomOut={() => setZoomClamped(zoom - 0.25)}
        onPanLeft={() => movePage(-20, 0)}
        onPanRight={() => movePage(20, 0)}
        onPanUp={() => movePage(0, -20)}
        onPanDown={() => movePage(0, 20)}
        onToggleTouchDrawing={() => setTouchDrawing((value) => !value)}
        translate={(key) => t(key)}
      />
      {inkBackground.error && <div role="alert" className="shrink-0 px-3 py-1 text-sm text-destructive">{t('errors.backgroundLoadFailed')}</div>}
      {pageError && <div role="alert" className="shrink-0 px-3 py-1 text-sm text-destructive">{t('errors.operationFailed')}</div>}
      {pasteError === 'too-large' && (
        <div role="alert" data-testid="ink-selection-too-large" className="shrink-0 px-3 py-1 text-sm text-destructive">
          {t('errors.selectionTooLarge')}
        </div>
      )}
      <InkPageView
        ref={pageViewRef}
        documentId={documentId}
        pageRef={docState.pageRef}
        page={docState.page}
        background={inkBackground.background}
        tool={toolSettings}
        erasing={erasing}
        selectionMode={selectionMode}
        selectionBounds={selection?.bounds ?? null}
        onSelectionChange={handleSelectionChange}
        onViewportWidthChange={handleViewportWidthChange}
        onViewportInteraction={preserveViewport}
        onPageChange={onPageChange}
        onError={() => setPageError(true)}
        onActiveStrokeChange={handleActiveStrokeChange}
        ariaLabel={t('canvas.label')}
      />
      <output className="sr-only" data-testid="ink-history-revision">{historyRevision}</output>
    </div>
  ) : null;

  return (
    <ErrorBoundary name="ink-editor" fallback={<div className="p-3 text-sm text-destructive" role="alert">{t('errors.loadFailed')}</div>}>
      <section
        className={cn('relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden', className)}
        data-testid="ink-editor"
        data-document-id={documentId}
        aria-busy={docState.status === 'loading'}
        onKeyDown={handleEditorKeyDown}
      >
        {content}
        <output className="sr-only" data-testid="ink-editor-flush-state" aria-live="polite">
          {docState.status === 'ready' ? 'ready' : docState.status}
        </output>
      </section>
    </ErrorBoundary>
  );
}

export { flushInkEditor };
