import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { InkPageView, type InkPageViewHandle, type InkToolSettings } from './InkPageView';
import { InkToolbar } from './InkToolbar';
import { flushInkEditor, registerInkEditorSession, type InkEditorSession } from './editorSession';
import { useInkDocument } from './useInkDocument';
import { loadInkBackground, type InkBackgroundLease } from './background';
import { getFrozenInkRenderInputs } from './renderBridge';
import { composeSourceHighlights } from './sourceHighlights';
import type { InkPage, InkRuling } from './types';

export interface InkEditorProps {
  documentId: string;
  className?: string;
  initialPageId?: string;
  onAskAi?: (documentId: string, pageId: string, revision: string) => void;
  onExport?: (documentId: string, pageId: string, revision: string) => void;
}

type InkHistory = { undo: InkPage[]; redo: InkPage[] };
type InkTool = 'pen' | 'highlighter';
type InkColor = 'black' | 'red' | 'blue';
type InkWidth = 'small' | 'medium' | 'large';
const COLORS: Record<InkColor, { pen: string; highlighter: string }> = {
  black: { pen: '#000000', highlighter: '#00000080' },
  red: { pen: '#ff0000', highlighter: '#ff000080' },
  blue: { pen: '#0000ff', highlighter: '#0000ff80' },
};
const WIDTHS: Record<InkWidth, number> = { small: 2, medium: 8, large: 12 };
export function InkEditor({ documentId, className, initialPageId, onAskAi, onExport }: InkEditorProps) {
  const { t } = useTranslation('ink');
  const docState = useInkDocument(documentId, initialPageId);
  const pageViewRef = useRef<InkPageViewHandle>(null);
  const activeStrokeRef = useRef(false);
  const documentRef = useRef(docState);
  documentRef.current = docState;
  const historiesRef = useRef(new Map<string, InkHistory>());
  const [historyRevision, setHistoryRevision] = useState(0);
  const seenRemoteReloadRef = useRef(docState.remoteReloadSequence);
  const [tool, setTool] = useState<InkTool>('pen');
  const [color, setColor] = useState<InkColor>('black');
  const [width, setWidth] = useState<InkWidth>('medium');
  const [erasing, setErasing] = useState(false);
  const [touchDrawing, setTouchDrawing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [renameValue, setRenameValue] = useState('');
  const [background, setBackground] = useState<CanvasImageSource | undefined>();
  const backgroundLeaseRef = useRef<InkBackgroundLease | undefined>(undefined);
  const composedBackgroundRef = useRef<HTMLCanvasElement | undefined>(undefined);
  const [backgroundError, setBackgroundError] = useState(false);
  const [pageError, setPageError] = useState(false);

  const pageId = docState.page?.page_id;
  const historyFor = (page: InkPage): InkHistory => historiesRef.current.get(page.page_id) ?? { undo: [], redo: [] };
  const history = docState.page ? historyFor(docState.page) : { undo: [], redo: [] };

  useEffect(() => {
    if (seenRemoteReloadRef.current === docState.remoteReloadSequence || !pageId) return;
    seenRemoteReloadRef.current = docState.remoteReloadSequence;
    // A remote reload advances the document epoch, so every cached page snapshot
    // is based on a revision that is no longer canonical. Ordinary page
    // navigation does not change remoteReloadSequence and keeps its local history.
    historiesRef.current.clear();
    setHistoryRevision((revision) => revision + 1);
  }, [pageId, docState.remoteReloadSequence]);

  const finishAndFlush = useCallback(async () => {
    await pageViewRef.current?.finishStroke();
    await documentRef.current.flush();
  }, []);

  const persistCurrentDraft = useCallback(async () => {
    await pageViewRef.current?.finishStroke();
    await documentRef.current.persistDraft();
  }, []);

  const session = useMemo<InkEditorSession | null>(() => {
    if (!pageId) return null;
    return {
      key: { document_id: documentId, page_id: pageId },
      isDirty: () => activeStrokeRef.current || (documentRef.current.saveStatus !== 'saved' && documentRef.current.saveStatus !== 'loading'),
      flush: finishAndFlush,
      persistDraft: () => documentRef.current.persistDraft(),
    };
  }, [documentId, pageId, finishAndFlush]);

  useEffect(() => {
    if (!session) return;
    const unregister = registerInkEditorSession(session);
    return () => { void session.persistDraft().catch(() => undefined).finally(unregister); };
  }, [session]);

  const onVisibilityHidden = useCallback(() => {
    if (documentRef.current.status !== 'ready' || globalThis.document.visibilityState !== 'hidden') return;
    void persistCurrentDraft();
  }, [persistCurrentDraft]);
  const onPageHide = useCallback(() => {
    if (documentRef.current.status !== 'ready') return;
    void persistCurrentDraft();
  }, [persistCurrentDraft]);
  useEventRegistry([
    { target: 'document', type: 'visibilitychange', listener: onVisibilityHidden },
    { target: 'window', type: 'pagehide', listener: onPageHide },
  ], [onVisibilityHidden, onPageHide]);

  useEffect(() => {
    const pageRef = docState.pageRef;
    const manifest = docState.manifest;
    let cancelled = false;
    backgroundLeaseRef.current?.dispose();
    backgroundLeaseRef.current = undefined;
    if (composedBackgroundRef.current) {
      composedBackgroundRef.current.width = 0;
      composedBackgroundRef.current.height = 0;
      composedBackgroundRef.current = undefined;
    }
    setBackground(undefined);
    setBackgroundError(false);
    if (docState.status !== 'ready' || !pageRef || !manifest) return;

    void (async () => {
      let lease: InkBackgroundLease | undefined;
      try {
        let highlights: Array<Record<string, unknown>> = [];
        if (manifest.source.kind === 'resource') {
          const inputs = await getFrozenInkRenderInputs(documentId, manifest.revision, pageRef.page_id);
          if (inputs.revision !== manifest.revision || inputs.page_ref.page_id !== pageRef.page_id
            || inputs.page.page_id !== pageRef.page_id) throw new Error('Frozen Ink render inputs do not match the open page revision.');
          highlights = inputs.highlights;
        }
        lease = await loadInkBackground(pageRef);
        if (cancelled) {
          lease.dispose();
          return;
        }
        backgroundLeaseRef.current = lease;
        const composed = composeSourceHighlights(lease.background, pageRef, highlights);
        if (composed) composedBackgroundRef.current = composed;
        setBackground(composed ?? lease.background);
      } catch {
        lease?.dispose();
        if (!cancelled) setBackgroundError(true);
      }
    })();

    return () => {
      cancelled = true;
      backgroundLeaseRef.current?.dispose();
      backgroundLeaseRef.current = undefined;
      if (composedBackgroundRef.current) {
        composedBackgroundRef.current.width = 0;
        composedBackgroundRef.current.height = 0;
        composedBackgroundRef.current = undefined;
      }
    };
  }, [documentId, docState.status, docState.pageRef, docState.manifest]);

  const onPageChange = useCallback(async (page: InkPage) => {
    const previous = documentRef.current.page;
    if (!previous || previous.page_id !== page.page_id || previous === page) return;
    const currentHistory = historyFor(previous);
    if (currentHistory.undo[currentHistory.undo.length - 1] !== page) {
      historiesRef.current.set(page.page_id, { undo: [...currentHistory.undo, previous], redo: [] });
      setHistoryRevision((revision) => revision + 1);
    }
    await documentRef.current.savePage(page);
  }, []);

  const applyHistory = useCallback(async (direction: 'undo' | 'redo') => {
    const current = documentRef.current.page;
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
    await pageViewRef.current?.finishStroke();
    await documentRef.current.flush();
    const state = documentRef.current;
    if (!state.manifest || !state.page) return;
    const index = state.manifest.pages.findIndex((pageRef) => pageRef.page_id === state.page?.page_id);
    const target = state.manifest.pages[index + offset];
    if (target) await state.selectPage(target.page_id);
  }, []);

  const appendPage = useCallback(async (ruling: InkRuling) => {
    try {
      setPageError(false);
      await pageViewRef.current?.finishStroke();
      await documentRef.current.flush();
      const pageRef = documentRef.current.pageRef;
      if (pageRef) await documentRef.current.appendPage(pageRef.width, pageRef.height, ruling);
    } catch {
      setPageError(true);
    }
  }, []);

  const renamePage = useCallback(async () => {
    try {
      setPageError(false);
      await documentRef.current.flush();
      await documentRef.current.rename(renameValue);
    } catch {
      setPageError(true);
    }
  }, [renameValue]);

  const setZoomClamped = (next: number) => {
    setZoom(Math.min(4, Math.max(0.5, Number(next.toFixed(2)))));
  };

  const toolSettings: InkToolSettings = {
    tool,
    color: COLORS[color][tool],
    width: WIDTHS[width],
    pressure_enabled: true,
    touchDrawing,
    zoom,
    panX: pan.x,
    panY: pan.y,
  };

  const content = docState.status === 'loading' ? (
    <div className="p-3 text-sm text-muted-foreground" role="status">{t('status.loading')}</div>
  ) : docState.status === 'error' ? (
    <div className="p-3 text-sm text-destructive" role="alert">{t('errors.loadFailed')}</div>
  ) : docState.page && docState.pageRef && docState.manifest ? (
    <div className="flex min-h-0 flex-col gap-2">
      <InkToolbar
        status={docState.saveStatus}
        pageIndex={docState.manifest.pages.findIndex((pageRef) => pageRef.page_id === docState.page?.page_id)}
        pageCount={docState.manifest.pages.length}
        pageTitle={docState.manifest.title}
        canUndo={history.undo.length > 0}
        canRedo={history.redo.length > 0}
        tool={tool}
        color={color}
        width={width}
        erasing={erasing}
        touchDrawing={touchDrawing}
        zoom={zoom}
        renameValue={renameValue}
        onRenameValue={setRenameValue}
        onReloadRemote={() => { void docState.reloadRemote(); }}
        onKeepDraft={() => { void persistCurrentDraft(); }}
        onRetrySave={() => { void docState.retrySave(); }}
        onRetryStorage={() => { void docState.retryDraftStorage(); }}
        onSelectTool={(nextTool) => { setTool(nextTool); setErasing(false); }}
        onSelectColor={(nextColor) => { setColor(nextColor); setErasing(false); }}
        onSelectWidth={setWidth}
        onToggleEraser={() => setErasing((value) => !value)}
        onUndo={() => { void applyHistory('undo'); }}
        onRedo={() => { void applyHistory('redo'); }}
        onPreviousPage={() => { void changePage(-1); }}
        onNextPage={() => { void changePage(1); }}
        onAppendPage={(ruling) => { void appendPage(ruling); }}
        onRename={() => { void renamePage(); }}
        onAskAi={onAskAi ? () => {
          void finishAndFlush().then(() => {
            const current = documentRef.current;
            if (current.page && current.manifest) onAskAi(documentId, current.page.page_id, current.manifest.revision);
          }).catch(() => setPageError(true));
        } : undefined}
        onExport={onExport ? () => {
          void finishAndFlush().then(() => {
            const current = documentRef.current;
            if (current.page && current.manifest) onExport(documentId, current.page.page_id, current.manifest.revision);
          }).catch(() => setPageError(true));
        } : undefined}
        onZoomIn={() => setZoomClamped(zoom + 0.25)}
        onZoomOut={() => setZoomClamped(zoom - 0.25)}
        onPanLeft={() => setPan((current) => ({ ...current, x: current.x - 20 }))}
        onPanRight={() => setPan((current) => ({ ...current, x: current.x + 20 }))}
        onPanUp={() => setPan((current) => ({ ...current, y: current.y - 20 }))}
        onPanDown={() => setPan((current) => ({ ...current, y: current.y + 20 }))}
        onToggleTouchDrawing={() => setTouchDrawing((value) => !value)}
        translate={(key) => t(key)}
      />
      {backgroundError && <div role="alert" className="text-sm text-destructive">{t('errors.backgroundLoadFailed')}</div>}
      {pageError && <div role="alert" className="text-sm text-destructive">{t('errors.operationFailed')}</div>}
      <InkPageView
        ref={pageViewRef}
        documentId={documentId}
        pageRef={docState.pageRef}
        page={docState.page}
        background={background}
        tool={toolSettings}
        erasing={erasing}
        onPageChange={onPageChange}
        onActiveStrokeChange={(active) => {
          activeStrokeRef.current = active;
          documentRef.current.setActiveStroke(active);
        }}
        ariaLabel={t('canvas.label')}
      />
      <output className="sr-only" data-testid="ink-history-revision">{historyRevision}</output>
    </div>
  ) : null;

  return (
    <ErrorBoundary name="ink-editor" fallback={<div className="p-3 text-sm text-destructive" role="alert">{t('errors.loadFailed')}</div>}>
      <section className={className} data-testid="ink-editor" data-document-id={documentId} aria-busy={docState.status === 'loading'}>
        {content}
        <output className="sr-only" data-testid="ink-editor-flush-state" aria-live="polite">
          {docState.status === 'ready' ? 'ready' : docState.status}
        </output>
      </section>
    </ErrorBoundary>
  );
}

export { flushInkEditor };
