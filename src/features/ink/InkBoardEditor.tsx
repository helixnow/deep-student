/**
 * v2 infinite-board UI host.
 *
 * This is deliberately a small host around the existing XState-free board
 * document hook, chunk planner, renderer, camera, selection, clipboard and
 * tool-setting modules. It does not duplicate the paged InkEditor and it does
 * not widen v1.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/shad/Dialog';
import { cn } from '@/utils/cn';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { copyTextToClipboard, readTextFromClipboard } from '@/utils/clipboardUtils';
import {
  getInkBoardOverview as fetchInkBoardOverview,
  type InkBoardOverview as InkBoardOverviewWire,
} from './api';
import {
  INK_COLOR_PRESETS,
  INK_ERASER_SIZES,
  clampEraserSize,
  clampInkWidth,
  inkStyleColor,
  loadInkToolPreferences,
  saveInkToolPreferences,
  widthPresetsFor,
  type InkToolName,
  type InkToolStyleSettings,
} from './toolSettings';
import {
  parseInkClipboard,
  serializeInkClipboard,
  type InkClipboardObject,
} from './clipboard';
import { clampCamera, loadCameraState, saveCameraState, zoomCameraAt, type Camera } from './camera';
import { useInkBoardDocument, type InkBoardFlushTarget } from './useInkBoardDocument';
import {
  InkBoardView,
  type InkBoardSelection,
  type InkBoardSelectionMode,
  type InkBoardToolSettings,
  type InkBoardViewHandle,
} from './InkBoardView';
import type {
  InkBoardBounds,
  InkBoardObject,
  InkObjectContent,
  InkRect,
} from './types';

/** Explicit board-world crop handed to AI/export consumers. */
export interface InkBoardCropRequest {
  documentId: string;
  pageId: string;
  revision: string;
  crop: InkBoardBounds;
}

export type InkBoardExportFormat = 'png' | 'pdf';

export interface InkBoardExportRequest extends InkBoardCropRequest {
  format: InkBoardExportFormat;
  pageWidth: number;
  pageHeight: number;
  paginate: boolean;
}

export interface InkBoardEditorProps {
  documentId: string;
  className?: string;
  /** Optional finite N-2 crop consumer (Chat reference). */
  onAskAi?: (request: InkBoardCropRequest) => void | Promise<void>;
  /** Optional finite export consumer (PNG/PDF artifact). `false` keeps the dialog open. */
  onExport?: (request: InkBoardExportRequest) => void | boolean | Promise<void | boolean>;
}

/**
 * Local normalized copy of the bounded native summary. `maxZIndex === null`
 * means the board has no objects yet. A decimal string above
 * Number.MAX_SAFE_INTEGER is rejected explicitly, never truncated.
 */
interface InkBoardZSummary {
  pageId: string;
  revision: string;
  maxZIndex: number | null;
}

function parseMaxZIndex(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('Board overview max_z_index is not decimal.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('Board overview max_z_index exceeds Number.MAX_SAFE_INTEGER.');
  }
  return parsed;
}

function normalizeOverview(
  response: InkBoardOverviewWire,
  documentId: string,
  pageId: string,
  expectedRevision: string,
): InkBoardZSummary {
  if (!response || typeof response !== 'object') throw new Error('Board overview is unavailable.');
  if (response.document_id !== documentId) throw new Error('Board overview document does not match.');
  if (response.page_id !== pageId) throw new Error('Board overview page does not match.');
  if (response.revision !== expectedRevision) {
    throw new Error('Board overview revision does not match the loaded board.');
  }
  return {
    pageId,
    revision: response.revision,
    maxZIndex: parseMaxZIndex(response.max_z_index),
  };
}

function newBoardObjectId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) throw new Error('crypto.randomUUID is unavailable.');
  return `ink-board-${uuid}`;
}

function translateContent(content: InkObjectContent, dx: number, dy: number): InkObjectContent {
  switch (content.kind) {
    case 'stroke':
      return {
        ...content,
        samples: content.samples.map((sample) => ({ ...sample, x: sample.x + dx, y: sample.y + dy })),
        style: { ...content.style },
      };
    case 'text':
      return { ...content, rect: { ...content.rect, x: content.rect.x + dx, y: content.rect.y + dy } };
    case 'rect':
    case 'ellipse':
    case 'region_highlight':
      return { ...content, rect: { ...content.rect, x: content.rect.x + dx, y: content.rect.y + dy } };
    case 'arrow':
      return {
        ...content,
        from: { x: content.from.x + dx, y: content.from.y + dy },
        to: { x: content.to.x + dx, y: content.to.y + dy },
      };
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT'
    || target.tagName === 'TEXTAREA'
    || target.tagName === 'SELECT'
    || Boolean(target.closest('[contenteditable="true"]'));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, a, [role="button"], [role="menuitem"], [role="option"]'));
}

export function InkBoardEditor({ documentId, className, onAskAi, onExport }: InkBoardEditorProps) {
  const { t } = useTranslation(['ink', 'dstu', 'common']);
  const isMobile = useIsMobile();
  const viewRef = useRef<InkBoardViewHandle>(null);
  const boardSaveTimerRef = useRef<number | undefined>(undefined);
  const boardSaveTargetRef = useRef<{
    documentId: string;
    pageId: string;
    revisionEpoch: number;
  } | null>(null);
  const cancelAutoSave = useCallback(() => {
    if (boardSaveTimerRef.current !== undefined) {
      window.clearTimeout(boardSaveTimerRef.current);
      boardSaveTimerRef.current = undefined;
    }
    boardSaveTargetRef.current = null;
  }, []);
  const renderedInputTargetRef = useRef<InkBoardFlushTarget | null>(null);
  const finishInput = useCallback(async (target?: InkBoardFlushTarget) => {
    const rendered = renderedInputTargetRef.current;
    if (target && (!rendered
      || rendered.documentId !== target.documentId
      || rendered.pageId !== target.pageId
      || rendered.revisionEpoch !== target.revisionEpoch)) {
      throw new Error('Ink board input session changed.');
    }
    const view = viewRef.current;
    cancelAutoSave();
    try {
      await view?.finishStroke?.();
    } finally {
      if (viewRef.current === view) cancelAutoSave();
    }
  }, [cancelAutoSave]);
  const doc = useInkBoardDocument(documentId, { beforeFlush: finishInput });
  // Hook methods are stable useCallbacks; destructure them so effects/callbacks
  // depend on the actual stable functions instead of the per-render `doc`
  // object (which would otherwise re-run every render / cycles).
  const {
    manifest,
    surface,
    status: documentStatus,
    loadVisible,
    insertObjects,
    removeObjects: removeBoardObjects,
    undo,
    redo,
    save,
    setCamera,
  } = doc;
  const docRef = useRef(doc);
  docRef.current = doc;
  renderedInputTargetRef.current = doc.status === 'ready' && manifest?.document_id === documentId
    ? { documentId, pageId: manifest.surface.page_id, revisionEpoch: doc.revisionEpoch }
    : null;
  const [tool, setTool] = useState<InkToolName>('pen');
  const [initialPreferences] = useState(() => loadInkToolPreferences());
  const [settingsByTool, setSettingsByTool] = useState<Record<InkToolName, InkToolStyleSettings>>(() => ({
    pen: { ...initialPreferences.settings.pen },
    highlighter: { ...initialPreferences.settings.highlighter },
  }));
  const [eraserSize, setEraserSize] = useState(initialPreferences.eraserSize);
  const [erasing, setErasing] = useState(false);
  const [touchDrawing, setTouchDrawing] = useState(false);
  const [selectionMode, setSelectionMode] = useState<InkBoardSelectionMode>('none');
  const [selection, setSelection] = useState<InkBoardSelection | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [spaceDown, setSpaceDown] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<InkBoardExportFormat>('png');
  const [exportPageWidthInput, setExportPageWidthInput] = useState('800');
  const [exportPageHeightInput, setExportPageHeightInput] = useState('600');
  const [exportRegion, setExportRegion] = useState<InkRect | null>(null);
  const [exportSubmitting, setExportSubmitting] = useState(false);
  const clipboardSourceRef = useRef<{ documentId: string; text: string } | null>(null);
  const [overview, setOverview] = useState<
    | { status: 'loading' }
    | { status: 'ready'; value: InkBoardZSummary }
    | { status: 'error'; error: unknown }
  >({ status: 'loading' });
  const [overviewRetry, setOverviewRetry] = useState(0);
  const overviewReadyRef = useRef(false);
  const overviewAuthorityRef = useRef<{
    documentId: string;
    pageId: string;
    revisionEpoch: number;
  } | null>(null);
  const nextZRef = useRef<number | null>(null);
  const preferencesInitializedRef = useRef(false);
  const cameraHydratedRef = useRef(false);
  const cameraSaveTimerRef = useRef<number | undefined>(undefined);
  const latestCameraRef = useRef<Camera | null>(null);
  const boardMountedRef = useRef(true);
  const documentIdRef = useRef(documentId);
  documentIdRef.current = documentId;

  const objects = useMemo(() => doc.chunks.flatMap((chunk) => chunk.objects), [doc.chunks]);
  const selectedObjects = useMemo(() => {
    if (!selection) return [];
    const ids = new Set(selection.objectIds);
    return objects.filter((object) => ids.has(object.id));
  }, [objects, selection]);

  const overviewReady = overview.status === 'ready'
    && Boolean(manifest)
    && overview.value.revision === manifest?.revision;
  overviewReadyRef.current = overviewReady;

  // A successfully validated summary authorizes z allocation for the same
  // document/page/epoch. An own save advances the manifest revision without
  // changing the epoch, so that authority and its monotonic nextZ survive the
  // revision bump. Document, page or remote-epoch changes require a fresh
  // successful summary; a stale response never installs authority.
  const hasOverviewAuthority = useCallback((): boolean => {
    const authority = overviewAuthorityRef.current;
    if (!authority || nextZRef.current === null) return false;
    const current = docRef.current;
    return current.status === 'ready'
      && documentIdRef.current === authority.documentId
      && current.manifest?.surface.page_id === authority.pageId
      && current.revisionEpoch === authority.revisionEpoch;
  }, []);

  useEffect(() => {
    // A different document starts with no verified summary or z cursor.
    overviewAuthorityRef.current = null;
    nextZRef.current = null;
  }, [documentId]);
  const camera = useMemo<Camera>(() => ({
    x: doc.camera.x,
    y: doc.camera.y,
    zoom: doc.camera.scale,
  }), [doc.camera.x, doc.camera.y, doc.camera.scale]);

  useEffect(() => {
    if (!preferencesInitializedRef.current) {
      preferencesInitializedRef.current = true;
      return;
    }
    saveInkToolPreferences({ settings: settingsByTool, eraserSize });
  }, [settingsByTool, eraserSize]);

  useEffect(() => {
    if (cameraHydratedRef.current) return;
    cameraHydratedRef.current = true;
    const saved = loadCameraState(documentId);
    if (saved) setCamera({ x: saved.x, y: saved.y, scale: saved.zoom });
  }, [documentId, setCamera]);

  useEffect(() => {
    if (!manifest || documentStatus !== 'ready') {
      setOverview({ status: 'loading' });
      return;
    }
    let active = true;
    const targetDocumentId = documentId;
    const targetPageId = manifest.surface.page_id;
    const targetRevision = manifest.revision;
    const targetEpoch = doc.revisionEpoch;
    setOverview({ status: 'loading' });
    void fetchInkBoardOverview({
      document_id: targetDocumentId,
      expected_revision: targetRevision,
    }).then((response) => {
      if (!active) return;
      const current = docRef.current;
      if (documentIdRef.current !== targetDocumentId
        || current.status !== 'ready'
        || current.manifest?.revision !== targetRevision
        || current.manifest?.surface.page_id !== targetPageId
        || current.revisionEpoch !== targetEpoch) return;
      const value = normalizeOverview(response, targetDocumentId, targetPageId, targetRevision);
      const next = value.maxZIndex === null ? 0 : value.maxZIndex + 1;
      nextZRef.current = nextZRef.current === null ? next : Math.max(nextZRef.current, next);
      overviewAuthorityRef.current = {
        documentId: targetDocumentId,
        pageId: targetPageId,
        revisionEpoch: targetEpoch,
      };
      setOverview({ status: 'ready', value });
    }).catch((error: unknown) => {
      if (!active) return;
      const current = docRef.current;
      if (documentIdRef.current !== targetDocumentId
        || current.manifest?.revision !== targetRevision
        || current.manifest?.surface.page_id !== targetPageId
        || current.revisionEpoch !== targetEpoch) return;
      setOverview({ status: 'error', error });
    });
    return () => { active = false; };
  }, [doc.revisionEpoch, documentId, documentStatus, manifest, overviewRetry]);

  useEffect(() => {
    if (overview.status !== 'ready') return;
    const next = overview.value.maxZIndex === null ? 0 : overview.value.maxZIndex + 1;
    nextZRef.current = nextZRef.current === null ? next : Math.max(nextZRef.current, next);
  }, [overview]);

  // Fetch only chunks intersecting the settled viewport. The hook keeps its
  // own 16 MiB batching/cache policy; this effect just supplies the world rect.
  useEffect(() => {
    if (documentStatus !== 'ready' || !manifest) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      const bounds = viewRef.current?.getViewportWorldRect();
      if (!bounds) return;
      void loadVisible(bounds).catch((error: unknown) => {
        if (active) setNotice(errorMessage(error, t('ink:errors.operationFailed')));
      });
    }, 80);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [camera.x, camera.y, camera.zoom, loadVisible, manifest, documentStatus, t]);

  useEffect(() => {
    setSelection(null);
  }, [doc.revisionEpoch, tool, erasing, selectionMode]);

  const onKeyUp = useCallback((event: Event) => {
    if ((event as KeyboardEvent).code === 'Space') setSpaceDown(false);
  }, []);
  const onBlur = useCallback(() => setSpaceDown(false), []);
  useEventRegistry([
    { target: 'window', type: 'keyup', listener: onKeyUp },
    { target: 'window', type: 'blur', listener: onBlur },
  ], [onKeyUp, onBlur]);

  const handleCameraChange = useCallback((next: Camera) => {
    // The hook camera is the single runtime fact. Clamp before it reaches the
    // hook so input mapping and rendering cannot diverge at the zoom limits.
    const clamped = clampCamera(next);
    setCamera({ x: clamped.x, y: clamped.y, scale: clamped.zoom });
    latestCameraRef.current = clamped;
    if (cameraSaveTimerRef.current !== undefined) window.clearTimeout(cameraSaveTimerRef.current);
    cameraSaveTimerRef.current = window.setTimeout(() => {
      cameraSaveTimerRef.current = undefined;
      saveCameraState(documentId, clamped);
    }, 150);
  }, [documentId, setCamera]);

  const zoomBoardBy = useCallback((factor: number) => {
    const size = viewRef.current?.getViewportSize?.() ?? { width: 1, height: 1 };
    handleCameraChange(zoomCameraAt(camera, {
      x: Math.max(1, size.width) / 2,
      y: Math.max(1, size.height) / 2,
    }, camera.zoom * factor));
  }, [camera, handleCameraChange]);

  useEffect(() => () => {
    if (cameraSaveTimerRef.current !== undefined) window.clearTimeout(cameraSaveTimerRef.current);
    if (latestCameraRef.current) saveCameraState(documentId, latestCameraRef.current);
  }, [documentId]);

  /**
   * Coalesce completed host gestures into one debounced canonical save. The
   * hook keeps its explicit-save contract and its own no-dirty/blocked replay
   * guards; this timer only supplies the idle trigger.
   */
  const scheduleAutoSave = useCallback(() => {
    const current = docRef.current;
    const pageId = current.manifest?.surface.page_id;
    if (current.status !== 'ready' || !pageId) return;
    if (boardSaveTimerRef.current !== undefined) {
      window.clearTimeout(boardSaveTimerRef.current);
    }
    boardSaveTargetRef.current = {
      documentId,
      pageId,
      revisionEpoch: current.revisionEpoch,
    };
    boardSaveTimerRef.current = window.setTimeout(() => {
      boardSaveTimerRef.current = undefined;
      const expected = boardSaveTargetRef.current;
      boardSaveTargetRef.current = null;
      if (!expected || !boardMountedRef.current) return;
      const latest = docRef.current;
      if (documentIdRef.current !== expected.documentId) return;
      if (latest.status !== 'ready') return;
      if (latest.manifest?.surface.page_id !== expected.pageId) return;
      if (latest.revisionEpoch !== expected.revisionEpoch) return;
      if (latest.saveStatus === 'loading'
        || latest.saveStatus === 'conflict'
        || latest.saveStatus === 'storage-error') return;
      try {
        void Promise.resolve(latest.save()).catch((error: unknown) => {
          if (!boardMountedRef.current || documentIdRef.current !== expected.documentId) return;
          setNotice(errorMessage(error, t('ink:errors.operationFailed')));
        });
      } catch (error) {
        if (!boardMountedRef.current || documentIdRef.current !== expected.documentId) return;
        setNotice(errorMessage(error, t('ink:errors.operationFailed')));
      }
    }, 1000);
  }, [documentId, t]);

  useEffect(() => {
    boardMountedRef.current = true;
    return () => {
      boardMountedRef.current = false;
      cancelAutoSave();
    };
  }, [cancelAutoSave]);

  useEffect(() => () => {
    // A remote revision or document change invalidates the pending target; a
    // late timer must never save across documents or epochs.
    cancelAutoSave();
  }, [cancelAutoSave, doc.revisionEpoch, documentId]);

  const allocateZIndexes = useCallback((count: number): number[] | null => {
    if (!hasOverviewAuthority() || nextZRef.current === null) return null;
    const start = nextZRef.current;
    const end = start + count - 1;
    if (start < 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
    nextZRef.current = end + 1;
    return Array.from({ length: count }, (_, index) => start + index);
  }, [hasOverviewAuthority]);

  const commitStroke = useCallback(async (
    content: Extract<InkObjectContent, { kind: 'stroke' }>,
  ) => {
    const currentManifest = manifest;
    if (!currentManifest || !hasOverviewAuthority()) {
      setNotice(t('ink:board.summaryUnavailable'));
      return false;
    }
    const z = allocateZIndexes(1)?.[0];
    if (z === undefined) {
      setNotice(t('ink:board.summaryUnavailable'));
      return false;
    }
    try {
      await insertObjects([{
        id: newBoardObjectId(),
        author: 'user',
        created_at: Date.now(),
        z_index: z,
        content,
      }]);
      scheduleAutoSave();
      setNotice(null);
    } catch (error) {
      setNotice(errorMessage(error, t('ink:errors.operationFailed')));
      throw error;
    }
  }, [allocateZIndexes, hasOverviewAuthority, insertObjects, manifest, scheduleAutoSave, t]);

  const removeObjects = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      await removeBoardObjects(ids);
      scheduleAutoSave();
      setSelection(null);
      setNotice(null);
    } catch (error) {
      setNotice(errorMessage(error, t('ink:errors.operationFailed')));
      throw error;
    }
  }, [removeBoardObjects, scheduleAutoSave, t]);

  const handleSelectionChange = useCallback((next: InkBoardSelection | null) => {
    setSelection(next);
  }, []);

  const handleCopy = useCallback(async () => {
    if (selectedObjects.length === 0) return;
    try {
      const text = serializeInkClipboard(selectedObjects);
      await copyTextToClipboard(text);
      clipboardSourceRef.current = { documentId, text };
      setNotice(null);
    } catch (error) {
      setNotice(errorMessage(error, t('ink:errors.operationFailed')));
    }
  }, [documentId, selectedObjects, t]);

  const handlePaste = useCallback(async () => {
    const targetDocumentId = documentId;
    const targetEpoch = docRef.current.revisionEpoch;
    const targetPageId = docRef.current.manifest?.surface.page_id;
    try {
      const text = await readTextFromClipboard();
      if (!text) return;
      const target = docRef.current;
      if (target.revisionEpoch !== targetEpoch
        || target.manifest?.surface.page_id !== targetPageId) {
        return;
      }
      const payload = parseInkClipboard(text);
      const source = clipboardSourceRef.current;
      const sameSource = source?.documentId === targetDocumentId && source.text === text;
      let dx = 16;
      let dy = 16;
      if (!sameSource) {
        const viewport = viewRef.current?.getViewportWorldRect();
        if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
          setNotice(t('ink:board.exportRegionUnavailable'));
          return;
        }
        dx = viewport.x + viewport.width / 2 - (payload.bounds.x + payload.bounds.width / 2);
        dy = viewport.y + viewport.height / 2 - (payload.bounds.y + payload.bounds.height / 2);
      }
      const zIndexes = allocateZIndexes(payload.objects.length);
      if (!zIndexes) {
        setNotice(t('ink:board.summaryUnavailable'));
        return;
      }
      const pasted: InkBoardObject[] = payload.objects.map((entry: InkClipboardObject, index) => ({
        id: newBoardObjectId(),
        author: 'user',
        created_at: Date.now(),
        z_index: zIndexes[index],
        content: translateContent(entry.content, dx, dy),
      }));
      if (docRef.current.revisionEpoch !== targetEpoch
        || docRef.current.manifest?.surface.page_id !== targetPageId) {
        return;
      }
      await insertObjects(pasted);
      scheduleAutoSave();
      setNotice(null);
    } catch (error) {
      setNotice(errorMessage(error, t('ink:errors.operationFailed')));
    }
  }, [allocateZIndexes, documentId, insertObjects, scheduleAutoSave, t]);

  const handleUndo = useCallback(() => {
    setSelection(null);
    void undo()
      .then(() => scheduleAutoSave())
      .catch((error: unknown) => setNotice(errorMessage(error, t('ink:errors.operationFailed'))));
  }, [scheduleAutoSave, t, undo]);

  const handleRedo = useCallback(() => {
    setSelection(null);
    void redo()
      .then(() => scheduleAutoSave())
      .catch((error: unknown) => setNotice(errorMessage(error, t('ink:errors.operationFailed'))));
  }, [redo, scheduleAutoSave, t]);

  const handleSave = useCallback(() => {
    cancelAutoSave();
    void save().catch((error: unknown) => setNotice(errorMessage(error, t('ink:errors.operationFailed'))));
  }, [cancelAutoSave, save, t]);

  const exportGrid = useMemo(() => {
    if (!exportRegion) return { columns: 0, rows: 0, count: 0, valid: false };
    const pageWidth = Number(exportPageWidthInput);
    const pageHeight = Number(exportPageHeightInput);
    if (!Number.isFinite(pageWidth) || pageWidth <= 0
      || !Number.isFinite(pageHeight) || pageHeight <= 0) {
      return { columns: 0, rows: 0, count: 0, valid: false };
    }
    const columns = Math.ceil(exportRegion.width / pageWidth);
    const rows = Math.ceil(exportRegion.height / pageHeight);
    const count = columns * rows;
    return {
      columns,
      rows,
      count,
      valid: Number.isSafeInteger(count) && count > 0 && count <= 500,
    };
  }, [exportPageHeightInput, exportPageWidthInput, exportRegion]);

  const finishAndFlush = useCallback(async () => {
    const target = docRef.current;
    const pageId = target.manifest?.surface.page_id;
    await finishInput();
    const current = docRef.current;
    if (documentIdRef.current !== documentId
      || current.manifest?.surface.page_id !== pageId
      || current.revisionEpoch !== target.revisionEpoch) {
      throw new Error('Ink board session changed.');
    }
    await current.flush();
  }, [documentId, finishInput]);

  const handleAskAi = useCallback(() => {
    if (!onAskAi) return;
    void (async () => {
      try {
        setNotice(null);
        await finishAndFlush();
        // Read the post-CAS identity instead of the pre-gesture closure. The
        // overview is bounded summary state and carries the stable revision
        // that the native renderer will validate.
        const latest = await fetchInkBoardOverview({ document_id: documentId });
        if (!latest
          || latest.document_id !== documentId
          || typeof latest.revision !== 'string'
          || latest.revision.length === 0
          || typeof latest.page_id !== 'string'
          || latest.page_id.length === 0) {
          throw new Error('Board overview is unavailable after flush.');
        }
        const crop: InkRect | null = selectionRef.current?.bounds
          ?? viewRef.current?.getViewportWorldRect()
          ?? null;
        if (!crop || crop.width <= 0 || crop.height <= 0) {
          throw new Error('Board crop is unavailable.');
        }
        await onAskAi({
          documentId,
          pageId: latest.page_id,
          revision: latest.revision,
          crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
        });
      } catch (error) {
        setNotice(errorMessage(error, t('ink:errors.operationFailed')));
      }
    })();
  }, [documentId, finishAndFlush, onAskAi, t]);

  const openExportDialog = useCallback(() => {
    if (!onExport) return;
    const crop: InkRect | null = selectionRef.current?.bounds
      ?? viewRef.current?.getViewportWorldRect()
      ?? null;
    if (!crop || crop.width <= 0 || crop.height <= 0) {
      setNotice(t('ink:board.exportRegionUnavailable'));
      return;
    }
    const region = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    setExportRegion(region);
    setExportFormat('png');
    setExportPageWidthInput(String(Math.max(1, Math.round(region.width))));
    setExportPageHeightInput(String(Math.max(1, Math.round(region.height))));
    setNotice(null);
    setExportOpen(true);
  }, [onExport, t]);

  const submitExport = useCallback(() => {
    if (!onExport || !exportRegion || exportSubmitting) return;
    const format = exportFormat;
    const pageWidth = format === 'png'
      ? Math.max(1, exportRegion.width)
      : Number(exportPageWidthInput);
    const pageHeight = format === 'png'
      ? Math.max(1, exportRegion.height)
      : Number(exportPageHeightInput);
    if (!Number.isFinite(pageWidth) || pageWidth <= 0
      || !Number.isFinite(pageHeight) || pageHeight <= 0) {
      setNotice(t('ink:board.exportInvalidGrid'));
      return;
    }
    if (format === 'pdf' && !exportGrid.valid) {
      setNotice(t('ink:board.exportTooManyPages'));
      return;
    }
    setExportSubmitting(true);
    void (async () => {
      try {
        setNotice(null);
        await finishAndFlush();
        const latest = await fetchInkBoardOverview({ document_id: documentId });
        if (!latest
          || latest.document_id !== documentId
          || typeof latest.revision !== 'string'
          || latest.revision.length === 0
          || typeof latest.page_id !== 'string'
          || latest.page_id.length === 0) {
          throw new Error('Board overview is unavailable after flush.');
        }
        const accepted = await onExport({
          documentId,
          pageId: latest.page_id,
          revision: latest.revision,
          crop: { ...exportRegion },
          format,
          pageWidth,
          pageHeight,
          paginate: format === 'pdf',
        });
        if (accepted !== false) setExportOpen(false);
      } catch (error) {
        setNotice(errorMessage(error, t('ink:errors.operationFailed')));
      } finally {
        setExportSubmitting(false);
      }
    })();
  }, [
    documentId,
    exportFormat,
    exportGrid.valid,
    exportPageHeightInput,
    exportPageWidthInput,
    exportRegion,
    exportSubmitting,
    finishAndFlush,
    onExport,
    t,
  ]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.repeat || isFormTarget(event.target)) return;
    if (event.code === 'Space' && !isInteractiveTarget(event.target)) {
      event.preventDefault();
      setSpaceDown(true);
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) handleRedo();
      else handleUndo();
    } else if (key === 'y') {
      event.preventDefault();
      handleRedo();
    } else if (key === 'c' && selectedObjects.length > 0) {
      event.preventDefault();
      void handleCopy();
    } else if (key === 'v') {
      event.preventDefault();
      void handlePaste();
    }
  }, [handleCopy, handlePaste, handleRedo, handleUndo, selectedObjects.length]);

  const boardTool = useMemo<InkBoardToolSettings>(() => ({
    tool,
    color: inkStyleColor(settingsByTool[tool], tool),
    width: settingsByTool[tool].width,
    eraserSize,
    touchDrawing,
  }), [eraserSize, settingsByTool, tool, touchDrawing]);

  const updateSettings = (patch: Partial<InkToolStyleSettings>) => {
    setSettingsByTool((current) => ({ ...current, [tool]: { ...current[tool], ...patch } }));
  };

  const selectTool = (next: InkToolName) => {
    setTool(next);
    setErasing(false);
    setSelectionMode('none');
    setSelection(null);
  };

  const toggleSelectionMode = (mode: Exclude<InkBoardSelectionMode, 'none'>) => {
    setSelection(null);
    setErasing(false);
    setSelectionMode((current) => (current === mode ? 'none' : mode));
  };

  if (doc.status === 'loading') {
    return (
      <div className={cn('flex h-full items-center justify-center gap-2', className)} role="status">
        <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden />
        <span>{t('ink:status.loading')}</span>
      </div>
    );
  }
  if (doc.status === 'error' || !manifest || !surface) {
    return (
      <div className={cn('p-3 text-sm text-destructive', className)} role="alert">
        {t('ink:errors.loadFailed')}
      </div>
    );
  }

  const overviewState = overview.status === 'ready'
    ? (overviewReady ? 'ready' : 'revision-mismatch')
    : overview.status;
  const currentSettings = settingsByTool[tool];
  const widthPresets = widthPresetsFor(tool);

  return (
    <section
      data-testid="ink-board-editor"
      data-document-id={documentId}
      data-loaded-chunks={doc.chunks.length}
      className={cn('flex h-full min-h-0 flex-col', className)}
      onKeyDown={handleKeyDown}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border/50 px-2 py-1">
        <output
          data-testid="ink-board-save-state"
          data-state={doc.saveStatus}
          role={doc.saveStatus === 'storage-error' ? 'alert' : 'status'}
          aria-live="polite"
          className="min-h-6 text-xs text-muted-foreground"
        >
          {t(`ink:status.${doc.saveStatus}`)}
        </output>
        <span data-testid="ink-board-title" className="max-w-48 truncate text-sm font-medium" title={manifest.title}>
          {manifest.title}
        </span>
        <DsButton data-testid="ink-board-tool-pen" size="sm" variant={tool === 'pen' && !erasing ? 'default' : 'ghost'} aria-pressed={tool === 'pen' && !erasing} onClick={() => selectTool('pen')}>
          {t('ink:tools.pen')}
        </DsButton>
        <DsButton data-testid="ink-board-tool-highlighter" size="sm" variant={tool === 'highlighter' && !erasing ? 'default' : 'ghost'} aria-pressed={tool === 'highlighter' && !erasing} onClick={() => selectTool('highlighter')}>
          {t('ink:tools.highlighter')}
        </DsButton>
        <DsButton data-testid="ink-board-eraser-tool" size="sm" variant={erasing ? 'default' : 'ghost'} aria-pressed={erasing} onClick={() => { setErasing((value) => !value); setSelectionMode('none'); setSelection(null); }}>
          {t('ink:tools.eraser')}
        </DsButton>
        <DsButton data-testid="ink-board-undo" size="sm" variant="ghost" disabled={doc.undoDepth === 0} onClick={handleUndo}>{t('ink:actions.undo')}</DsButton>
        <DsButton data-testid="ink-board-redo" size="sm" variant="ghost" disabled={doc.redoDepth === 0} onClick={handleRedo}>{t('ink:actions.redo')}</DsButton>
        <DsButton data-testid="ink-board-select-rectangle" size="sm" variant={selectionMode === 'rectangle' ? 'default' : 'ghost'} aria-pressed={selectionMode === 'rectangle'} onClick={() => toggleSelectionMode('rectangle')}>{t('ink:actions.selectRectangle')}</DsButton>
        <DsButton data-testid="ink-board-select-lasso" size="sm" variant={selectionMode === 'lasso' ? 'default' : 'ghost'} aria-pressed={selectionMode === 'lasso'} onClick={() => toggleSelectionMode('lasso')}>{t('ink:actions.selectLasso')}</DsButton>
        <DsButton data-testid="ink-board-selection-copy" size="sm" variant="ghost" disabled={selectedObjects.length === 0} onClick={() => void handleCopy()}>{t('ink:actions.copySelection')}</DsButton>
        <DsButton data-testid="ink-board-selection-paste" size="sm" variant="ghost" onClick={() => void handlePaste()}>{t('ink:actions.pasteSelection')}</DsButton>
        <DsButton data-testid="ink-board-touch-draw-toggle" size="sm" variant={touchDrawing ? 'default' : 'ghost'} aria-pressed={touchDrawing} onClick={() => setTouchDrawing((value) => !value)}>
          {t(touchDrawing ? 'ink:actions.touchDrawOn' : 'ink:actions.touchDrawOff')}
        </DsButton>
        <DsButton data-testid="ink-board-zoom-out" size="sm" variant="ghost" onClick={() => zoomBoardBy(1 / 1.25)}>{t('ink:actions.zoomOut')}</DsButton>
        <output data-testid="ink-board-zoom-level" className="min-w-12 text-center text-xs tabular-nums">{Math.round(camera.zoom * 100)}%</output>
        <DsButton data-testid="ink-board-zoom-in" size="sm" variant="ghost" onClick={() => zoomBoardBy(1.25)}>{t('ink:actions.zoomIn')}</DsButton>
        <DsButton data-testid="ink-board-save" size="sm" variant="ghost" disabled={doc.saveStatus === 'saved'} onClick={handleSave}>{t('ink:board.save')}</DsButton>
        <DsButton
          data-testid="ink-board-ask-ai"
          size="sm"
          variant="ghost"
          disabled={!onAskAi}
          aria-disabled={!onAskAi}
          title={onAskAi ? t('ink:actions.askAi') : t('ink:board.askAiUnavailable')}
          onClick={handleAskAi}
        >
          {t('ink:actions.askAi')}
        </DsButton>
        <DsButton
          data-testid="ink-board-export"
          size="sm"
          variant="ghost"
          disabled={!onExport}
          aria-disabled={!onExport}
          title={onExport ? t('ink:actions.export') : t('ink:board.exportUnavailable')}
          onClick={openExportDialog}
        >
          {t('ink:actions.export')}
        </DsButton>
        <DsButton data-testid="ink-board-settings-toggle" size="sm" variant="ghost" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((value) => !value)}>
          {t('ink:styleSettings.open')}
        </DsButton>
      </div>

      {settingsOpen && (
        <div data-testid="ink-board-settings" className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border/50 px-2 py-1">
          <div role="group" aria-label={t('ink:colors.label')} className="flex flex-wrap items-center gap-1">
            {INK_COLOR_PRESETS.map((preset) => (
              <DsButton
                key={preset.id}
                data-testid={`ink-board-color-${preset.id}`}
                size="icon"
                variant={currentSettings.color === preset.value ? 'default' : 'ghost'}
                aria-label={t(preset.labelKey)}
                aria-pressed={currentSettings.color === preset.value}
                onClick={() => { updateSettings({ color: preset.value }); setErasing(false); }}
              >
                <span className="block h-4 w-4 rounded-full border border-border" style={{ backgroundColor: preset.value }} />
              </DsButton>
            ))}
          </div>
          <div role="group" aria-label={t('ink:width.label')} className="flex flex-wrap items-center gap-1">
            {widthPresets.map((preset) => (
              <DsButton
                key={preset.value}
                data-testid={`ink-board-width-${preset.value}`}
                size="sm"
                variant={currentSettings.width === preset.value ? 'default' : 'ghost'}
                aria-pressed={currentSettings.width === preset.value}
                onClick={() => updateSettings({ width: clampInkWidth(tool, preset.value) })}
              >
                {preset.value}
              </DsButton>
            ))}
          </div>
          <div role="group" aria-label={t('ink:eraser.label')} className="flex flex-wrap items-center gap-1">
            {INK_ERASER_SIZES.map((size) => (
              <DsButton
                key={size}
                data-testid={`ink-board-eraser-size-${size}`}
                size="sm"
                variant={eraserSize === size ? 'default' : 'ghost'}
                aria-pressed={eraserSize === size}
                onClick={() => setEraserSize(clampEraserSize(size))}
              >
                {size}
              </DsButton>
            ))}
          </div>
        </div>
      )}

      {notice && (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {notice}
        </div>
      )}
      {overview.status === 'error' && (
        <div role="alert" data-testid="ink-board-overview-error" className="flex flex-wrap items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>{t('ink:board.summaryUnavailable')}</span>
          <DsButton
            data-testid="ink-board-overview-retry"
            size="sm"
            variant="ghost"
            onClick={() => setOverviewRetry((value) => value + 1)}
          >
            {t('common:retry')}
          </DsButton>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <InkBoardView
          key={`${documentId}:${surface.page_id}:${doc.revisionEpoch}`}
          ref={viewRef}
          surface={surface}
          objects={objects}
          camera={camera}
          tool={boardTool}
          erasing={erasing}
          selectionMode={selectionMode}
          selection={selection}
          spaceDown={spaceDown}
          ariaLabel={t('ink:board.canvasLabel')}
          onCameraChange={handleCameraChange}
          onCommitStroke={commitStroke}
          onErase={removeObjects}
          onSelectionChange={handleSelectionChange}
          onError={(error) => setNotice(errorMessage(error, t('ink:errors.operationFailed')))}
        />
      </div>
      <output data-testid="ink-board-overview-state" data-state={overviewState} className="sr-only">
        {overviewState}
      </output>
      <span className="sr-only">{isMobile ? t('ink:board.navigationTouch') : t('ink:board.navigationDesktop')}</span>

      <Dialog open={exportOpen} onOpenChange={(open) => { if (!exportSubmitting) setExportOpen(open); }}>
        <DialogContent data-testid="ink-board-export-dialog" className="max-h-[90dvh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('ink:board.exportTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <DsButton
              data-testid="ink-board-export-format-png"
              size="sm"
              variant={exportFormat === 'png' ? 'default' : 'ghost'}
              aria-pressed={exportFormat === 'png'}
              onClick={() => setExportFormat('png')}
            >
              {t('ink:board.exportPng')}
            </DsButton>
            <DsButton
              data-testid="ink-board-export-format-pdf"
              size="sm"
              variant={exportFormat === 'pdf' ? 'default' : 'ghost'}
              aria-pressed={exportFormat === 'pdf'}
              onClick={() => setExportFormat('pdf')}
            >
              {t('ink:board.exportPdf')}
            </DsButton>
          </div>
          {exportFormat === 'pdf' && (
            <div className="flex flex-col gap-3">
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>{t('ink:board.pageWidth')}</span>
                <Input
                  data-testid="ink-board-export-page-width"
                  className="w-28"
                  inputMode="decimal"
                  value={exportPageWidthInput}
                  onChange={(event) => setExportPageWidthInput(event.target.value)}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>{t('ink:board.pageHeight')}</span>
                <Input
                  data-testid="ink-board-export-page-height"
                  className="w-28"
                  inputMode="decimal"
                  value={exportPageHeightInput}
                  onChange={(event) => setExportPageHeightInput(event.target.value)}
                />
              </label>
              <div
                data-testid="ink-board-export-preview"
                data-row-major="true"
                data-page-count={exportGrid.count}
                data-region={JSON.stringify(exportRegion)}
                className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
              >
                {exportGrid.count <= 0
                  ? t('ink:board.exportInvalidGrid')
                  : exportGrid.valid
                    ? t('ink:board.exportPreview', { count: exportGrid.count, columns: exportGrid.columns, rows: exportGrid.rows })
                    : t('ink:board.exportTooManyPages')}
              </div>
            </div>
          )}
          <DialogFooter className="flex flex-wrap items-center justify-end gap-2">
            <DsButton variant="ghost" size="sm" onClick={() => setExportOpen(false)}>
              {t('common:actions.cancel')}
            </DsButton>
            <DsButton
              data-testid="ink-board-export-submit"
              size="sm"
              disabled={exportSubmitting || !exportRegion || (exportFormat === 'pdf' && !exportGrid.valid)}
              onClick={submitExport}
            >
              {t('ink:board.exportSubmit')}
            </DsButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
