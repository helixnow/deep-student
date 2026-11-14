/**
 * Interactive SVG Image Occlusion Card Builder Modal.
 *
 * Entry points:
 * 1. Global `'ds:open-image-occlusion-builder'` CustomEvent (e.g. from PDF region capture
 *    or LibraryScreen toolbar), guarded by a singleton owner stack so split-pane hosts
 *    never open duplicate dialogs.
 * 2. Optional controlled `open` / `onOpenChange` props for isolated component testing.
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageSquare, Plus, Trash, UploadSimple } from '@phosphor-icons/react';
import { vfsFileApi } from '@/api/vfsFileApi';
import { addTypedEventListener, dispatchTypedEvent } from '@/events';
import { MAX_OCCLUSION_BOXES } from '@/components/anki/utils/imageOcclusion';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog } from '@/components/ui/DsDialog';
import { Input } from '@/components/ui/shad/Input';
import {
  fnv1a64Hex,
  formatAnchorShortLocator,
  type SemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { cn } from '@/utils/cn';
import {
  MIN_OCCLUSION_BOX_RATIO,
  saveCompiledOcclusionCards,
  type OcclusionStudyMode,
} from './occlusionCompiler';

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const EDITABLE_SELECTOR = [
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(', ');

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (EDITABLE_TAGS.has(el.tagName) || el.isContentEditable) return true;
  return typeof el.closest === 'function' && Boolean(el.closest(EDITABLE_SELECTOR));
}

export const OPEN_IMAGE_OCCLUSION_BUILDER_EVENT = 'ds:open-image-occlusion-builder';

/** Minimum pointer drag size in CSS pixels to prevent stray clicks from creating tiny masks. */
export const MIN_OCCLUSION_DRAW_PX = 8;

const ACCEPTED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
]);

export interface OpenImageOcclusionBuilderDetail {
  imageBlob?: Blob | null;
  imageDataUrl?: string | null;
  imageRef?: string | null;
  naturalWidth?: number;
  naturalHeight?: number;
  sourceAnchor?: SemanticAnchor;
  sourceTitle?: string;
  defaultDeckName?: string;
}

export function openImageOcclusionBuilder(detail: OpenImageOcclusionBuilderDetail = {}): void {
  dispatchTypedEvent(OPEN_IMAGE_OCCLUSION_BUILDER_EVENT, detail);
}

export interface EditableOcclusionBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  clozeIndex: number;
}

type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se';

type DragInteraction =
  | {
      kind: 'draw';
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startNormX: number;
      startNormY: number;
      currentClientX: number;
      currentClientY: number;
      currentNormX: number;
      currentNormY: number;
    }
  | {
      kind: 'move';
      pointerId: number;
      boxId: string;
      startNormX: number;
      startNormY: number;
      origX: number;
      origY: number;
      origW: number;
      origH: number;
    }
  | {
      kind: 'resize';
      pointerId: number;
      boxId: string;
      corner: ResizeCorner;
      origX: number;
      origY: number;
      origW: number;
      origH: number;
    };

// Module-level singleton owner stack so mounting <ImageOcclusionBuilderModal /> in both
// NotesCrepeEditor and FlashcardsApp never opens two modals simultaneously.
const mountedBuilderOwners: string[] = [];

function registerBuilderOwner(ownerId: string): () => void {
  if (!mountedBuilderOwners.includes(ownerId)) {
    mountedBuilderOwners.push(ownerId);
  }
  return () => {
    const idx = mountedBuilderOwners.indexOf(ownerId);
    if (idx >= 0) {
      mountedBuilderOwners.splice(idx, 1);
    }
  };
}

function isPrimaryBuilderOwner(ownerId: string): boolean {
  return (
    mountedBuilderOwners.length === 0 ||
    mountedBuilderOwners[mountedBuilderOwners.length - 1] === ownerId
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function renumberBoxes(boxes: EditableOcclusionBox[]): EditableOcclusionBox[] {
  return boxes.map((box, index) => ({
    ...box,
    clozeIndex: index + 1,
  }));
}

function extractBase64Payload(dataUrl: string): { mimeType: string; base64Content: string } | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  return {
    mimeType: match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase(),
    base64Content: match[2].replace(/\s+/g, ''),
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Failed to read image blob as data URL'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

let boxSeq = 0;
function nextBoxId(): string {
  boxSeq += 1;
  return `io_box_${boxSeq}`;
}

export interface ImageOcclusionBuilderModalProps {
  /** Optional controlled open state (defaults to global event-driven singleton mode). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialDetail?: OpenImageOcclusionBuilderDetail;
  defaultDeckName?: string;
}

export const ImageOcclusionBuilderModal: React.FC<ImageOcclusionBuilderModalProps> = ({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  initialDetail,
  defaultDeckName,
}) => {
  const { t } = useTranslation('flashcards');
  const ownerId = useId();
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const svgStageRef = useRef<SVGSVGElement | null>(null);
  const imageReadSeqRef = useRef(0);
  const sessionSeqRef = useRef(0);
  const savingRef = useRef(false);

  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? controlledOpen : internalOpen;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next);
      }
      controlledOnOpenChange?.(next);
    },
    [isControlled, controlledOnOpenChange],
  );

  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageRef, setImageRef] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 });
  const [sourceAnchor, setSourceAnchor] = useState<SemanticAnchor | undefined>(undefined);
  const [sourceTitle, setSourceTitle] = useState<string>('');
  const [deckName, setDeckName] = useState<string>('');
  const [extraNote, setExtraNote] = useState<string>('');
  const [mode, setMode] = useState<OcclusionStudyMode>('hide-one');
  const [boxes, setBoxes] = useState<EditableOcclusionBox[]>([]);
  const [selectedBoxId, setSelectedBoxId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragInteraction | null>(null);
  const [saving, setSaving] = useState(false);

  const applyLaunchDetail = useCallback(
    (detail: OpenImageOcclusionBuilderDetail | undefined) => {
      const imageReadSeq = ++imageReadSeqRef.current;
      sessionSeqRef.current += 1;
      savingRef.current = false;
      const nextAnchor = detail?.sourceAnchor;
      const nextTitle = detail?.sourceTitle?.trim() || nextAnchor?.label?.trim() || '';
      const resolvedDeck =
        detail?.defaultDeckName?.trim() ||
        defaultDeckName?.trim() ||
        nextTitle ||
        t('occlusion.defaultDeck');

      setImageBlob(detail?.imageBlob ?? null);
      setImageDataUrl(detail?.imageDataUrl ?? null);
      setImageRef(detail?.imageRef ?? null);
      setNaturalSize({
        w: detail?.naturalWidth && detail.naturalWidth > 0 ? detail.naturalWidth : 800,
        h: detail?.naturalHeight && detail.naturalHeight > 0 ? detail.naturalHeight : 600,
      });
      setSourceAnchor(nextAnchor);
      setSourceTitle(nextTitle);
      setDeckName(resolvedDeck);
      setExtraNote('');
      setMode('hide-one');
      setBoxes([]);
      setSelectedBoxId(null);
      setDragState(null);
      setSaving(false);

      if (detail?.imageBlob && !detail?.imageDataUrl) {
        void blobToDataUrl(detail.imageBlob)
          .then((url) => {
            if (imageReadSeq === imageReadSeqRef.current) setImageDataUrl(url);
          })
          .catch(() => {});
      }
    },
    [defaultDeckName, t],
  );

  // Register singleton event listener when running in global host mode.
  useEffect(() => {
    if (isControlled) return;
    const unregister = registerBuilderOwner(ownerId);
    const handleOpenEvent = (detail: OpenImageOcclusionBuilderDetail) => {
      if (!isPrimaryBuilderOwner(ownerId)) return;
      applyLaunchDetail(detail);
      setInternalOpen(true);
    };
    const unlisten = addTypedEventListener(OPEN_IMAGE_OCCLUSION_BUILDER_EVENT, handleOpenEvent);
    return () => {
      unlisten();
      unregister();
    };
  }, [isControlled, ownerId, applyLaunchDetail]);

  // Apply initialDetail when controlled modal transitions to open.
  const prevControlledOpenRef = useRef(false);
  useEffect(() => {
    if (isControlled && controlledOpen && !prevControlledOpenRef.current) {
      applyLaunchDetail(initialDetail);
    }
    prevControlledOpenRef.current = Boolean(controlledOpen);
  }, [isControlled, controlledOpen, initialDetail, applyLaunchDetail]);

  useEffect(() => {
    if (!open) {
      imageReadSeqRef.current += 1;
      sessionSeqRef.current += 1;
      savingRef.current = false;
      setImageBlob(null);
      setImageDataUrl(null);
      setImageRef(null);
      setDragState(null);
      setBoxes([]);
    }
  }, [open]);

  useEffect(() => () => {
    imageReadSeqRef.current += 1;
    sessionSeqRef.current += 1;
  }, []);

  const ingestFileOrBlob = useCallback(
    async (blob: Blob) => {
      if (savingRef.current) return;
      const imageReadSeq = ++imageReadSeqRef.current;
      const mime = (blob.type || '').toLowerCase();
      if (mime && !ACCEPTED_IMAGE_MIMES.has(mime)) {
        showGlobalNotification('warning', t('occlusion.invalidImage'));
        return;
      }
      try {
        const dataUrl = await blobToDataUrl(blob);
        if (imageReadSeq !== imageReadSeqRef.current) return;
        setImageBlob(blob);
        setImageDataUrl(dataUrl);
        setImageRef(null);
        setBoxes([]);
        setSelectedBoxId(null);
      } catch {
        if (imageReadSeq === imageReadSeqRef.current) {
          showGlobalNotification('error', t('occlusion.invalidImage'));
        }
      }
    },
    [t],
  );

  // Support pasting PNG/JPEG/WebP from clipboard while modal is open.
  useEffect(() => {
    if (!open) return;
    const handlePaste = (event: ClipboardEvent) => {
      const active = document.activeElement;
      if (isEditableTarget(active)) {
        return;
      }
      const items = Array.from(event.clipboardData?.items ?? []);
      const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
      const file = imageItem?.getAsFile() ?? event.clipboardData?.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;
      event.preventDefault();
      void ingestFileOrBlob(file);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [open, ingestFileOrBlob]);

  const removeBox = useCallback((boxId: string) => {
    setBoxes((prev) => renumberBoxes(prev.filter((b) => b.id !== boxId)));
    setSelectedBoxId((prev) => (prev === boxId ? null : prev));
  }, []);

  // Keyboard shortcuts (`Delete` / `Backspace` / `Escape`) in capture phase so Escape removes
  // a selected box (or cancels an active draw) without letting DsDialog close the modal.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isComposingKeyEvent(event)) return;
      if (savingRef.current) return;
      const inTextInput = isEditableTarget(event.target);

      if (event.key === 'Escape') {
        if (dragState) {
          event.preventDefault();
          event.stopPropagation();
          setDragState(null);
          return;
        }
        if (selectedBoxId && !inTextInput) {
          event.preventDefault();
          event.stopPropagation();
          removeBox(selectedBoxId);
          return;
        }
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedBoxId && !inTextInput) {
        event.preventDefault();
        event.stopPropagation();
        removeBox(selectedBoxId);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, dragState, selectedBoxId, removeBox]);

  const resolveStageGeometry = useCallback(
    (clientX: number, clientY: number): { normX: number; normY: number; widthPx: number; heightPx: number } => {
      const rect = svgStageRef.current?.getBoundingClientRect();
      const widthPx = rect && rect.width > 0 ? rect.width : naturalSize.w || 800;
      const heightPx = rect && rect.height > 0 ? rect.height : naturalSize.h || 600;
      const leftPx = rect ? rect.left : 0;
      const topPx = rect ? rect.top : 0;
      return {
        normX: clamp01((clientX - leftPx) / widthPx),
        normY: clamp01((clientY - topPx) / heightPx),
        widthPx,
        heightPx,
      };
    },
    [naturalSize.h, naturalSize.w],
  );

  const handleStagePointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if ((event.button !== undefined && event.button !== 0) || saving) return;
      if (boxes.length >= MAX_OCCLUSION_BOXES) {
        showGlobalNotification('info', t('occlusion.maxBoxesHint', { max: MAX_OCCLUSION_BOXES }));
        return;
      }
      event.preventDefault();
      event.currentTarget.focus();
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic pointer events in unit tests may not have an active pointerId.
      }
      const { normX, normY } = resolveStageGeometry(event.clientX, event.clientY);
      setSelectedBoxId(null);
      setDragState({
        kind: 'draw',
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startNormX: normX,
        startNormY: normY,
        currentClientX: event.clientX,
        currentClientY: event.clientY,
        currentNormX: normX,
        currentNormY: normY,
      });
    },
    [boxes.length, resolveStageGeometry, saving, t],
  );

  const handleBoxPointerDown = useCallback(
    (event: React.PointerEvent<SVGGElement>, box: EditableOcclusionBox) => {
      if ((event.button !== undefined && event.button !== 0) || saving) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        svgStageRef.current?.setPointerCapture?.(event.pointerId);
      } catch {
        // Ignore in synthetic test environments.
      }
      const { normX, normY } = resolveStageGeometry(event.clientX, event.clientY);
      setSelectedBoxId(box.id);
      setDragState({
        kind: 'move',
        pointerId: event.pointerId,
        boxId: box.id,
        startNormX: normX,
        startNormY: normY,
        origX: box.x,
        origY: box.y,
        origW: box.w,
        origH: box.h,
      });
    },
    [resolveStageGeometry, saving],
  );

  const handleCornerPointerDown = useCallback(
    (event: React.PointerEvent<SVGRectElement>, box: EditableOcclusionBox, corner: ResizeCorner) => {
      if ((event.button !== undefined && event.button !== 0) || saving) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        svgStageRef.current?.setPointerCapture?.(event.pointerId);
      } catch {
        // Ignore in synthetic test environments.
      }
      setSelectedBoxId(box.id);
      setDragState({
        kind: 'resize',
        pointerId: event.pointerId,
        boxId: box.id,
        corner,
        origX: box.x,
        origY: box.y,
        origW: box.w,
        origH: box.h,
      });
    },
    [saving],
  );

  const handleStagePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      const { normX, normY } = resolveStageGeometry(event.clientX, event.clientY);

      if (dragState.kind === 'draw') {
        setDragState((prev) =>
          prev && prev.kind === 'draw'
            ? {
                ...prev,
                currentClientX: event.clientX,
                currentClientY: event.clientY,
                currentNormX: normX,
                currentNormY: normY,
              }
            : prev,
        );
        return;
      }

      if (dragState.kind === 'move') {
        const dx = normX - dragState.startNormX;
        const dy = normY - dragState.startNormY;
        const nextX = Math.max(0, Math.min(1 - dragState.origW, dragState.origX + dx));
        const nextY = Math.max(0, Math.min(1 - dragState.origH, dragState.origY + dy));
        setBoxes((prev) =>
          prev.map((box) =>
            box.id === dragState.boxId ? { ...box, x: nextX, y: nextY } : box,
          ),
        );
        return;
      }

      if (dragState.kind === 'resize') {
        const origRight = dragState.origX + dragState.origW;
        const origBottom = dragState.origY + dragState.origH;
        let left = dragState.origX;
        let top = dragState.origY;
        let right = origRight;
        let bottom = origBottom;

        if (dragState.corner === 'nw' || dragState.corner === 'sw') {
          left = Math.max(0, Math.min(origRight - MIN_OCCLUSION_BOX_RATIO, normX));
        } else {
          right = Math.min(1, Math.max(dragState.origX + MIN_OCCLUSION_BOX_RATIO, normX));
        }

        if (dragState.corner === 'nw' || dragState.corner === 'ne') {
          top = Math.max(0, Math.min(origBottom - MIN_OCCLUSION_BOX_RATIO, normY));
        } else {
          bottom = Math.min(1, Math.max(dragState.origY + MIN_OCCLUSION_BOX_RATIO, normY));
        }

        setBoxes((prev) =>
          prev.map((box) =>
            box.id === dragState.boxId
              ? { ...box, x: left, y: top, w: right - left, h: bottom - top }
              : box,
          ),
        );
      }
    },
    [dragState, resolveStageGeometry],
  );

  const finalizeDrag = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!dragState || event.pointerId !== dragState.pointerId) return;
      try {
        event.currentTarget.releasePointerCapture?.(dragState.pointerId);
      } catch {
        // Ignore in synthetic test environments.
      }

      if (dragState.kind === 'draw') {
        const { normX: endNormX, normY: endNormY, widthPx, heightPx } = resolveStageGeometry(
          event.clientX,
          event.clientY,
        );
        const left = clamp01(Math.min(dragState.startNormX, endNormX));
        const top = clamp01(Math.min(dragState.startNormY, endNormY));
        const right = clamp01(Math.max(dragState.startNormX, endNormX));
        const bottom = clamp01(Math.max(dragState.startNormY, endNormY));
        const w = right - left;
        const h = bottom - top;
        const pixelW = w * widthPx;
        const pixelH = h * heightPx;

        setDragState(null);

        // Reject accidental tiny clicks (< 8px or < 1% normalized width/height).
        if (
          pixelW < MIN_OCCLUSION_DRAW_PX ||
          pixelH < MIN_OCCLUSION_DRAW_PX ||
          w < MIN_OCCLUSION_BOX_RATIO ||
          h < MIN_OCCLUSION_BOX_RATIO
        ) {
          return;
        }

        setBoxes((prev) => {
          if (prev.length >= MAX_OCCLUSION_BOXES) return prev;
          const id = nextBoxId();
          const created: EditableOcclusionBox = {
            id,
            x: left,
            y: top,
            w,
            h,
            label: '',
            clozeIndex: prev.length + 1,
          };
          setSelectedBoxId(id);
          return [...prev, created];
        });
        return;
      }

      setDragState(null);
    },
    [dragState, resolveStageGeometry],
  );

  const draftPreviewRect = useMemo(() => {
    if (!dragState || dragState.kind !== 'draw') return null;
    const left = clamp01(Math.min(dragState.startNormX, dragState.currentNormX));
    const top = clamp01(Math.min(dragState.startNormY, dragState.currentNormY));
    const w = clamp01(Math.max(dragState.startNormX, dragState.currentNormX)) - left;
    const h = clamp01(Math.max(dragState.startNormY, dragState.currentNormY)) - top;
    return { x: left, y: top, w, h };
  }, [dragState]);

  const selectedBox = useMemo(
    () => boxes.find((box) => box.id === selectedBoxId) ?? null,
    [boxes, selectedBoxId],
  );

  const uniqueCardCount = useMemo(
    () => new Set(boxes.map((box) => box.clozeIndex)).size,
    [boxes],
  );

  const sourceLocator = useMemo(
    () => (sourceAnchor ? formatAnchorShortLocator(sourceAnchor) : ''),
    [sourceAnchor],
  );

  const handleSave = useCallback(async () => {
    if (savingRef.current || boxes.length === 0 || (!imageDataUrl && !imageRef)) return;
    savingRef.current = true;
    const sessionSeq = sessionSeqRef.current;
    setSaving(true);
    try {
      let resolvedRef = imageRef?.trim() || '';
      let uploadedSourceId: string | undefined;

      if (!resolvedRef.startsWith('vfs://')) {
        let dataUrl = imageDataUrl;
        if (!dataUrl && imageBlob) {
          dataUrl = await blobToDataUrl(imageBlob);
        }
        if (dataUrl) {
          const parsed = extractBase64Payload(dataUrl);
          if (parsed) {
            try {
              const ext = parsed.mimeType === 'image/webp' ? 'webp' : parsed.mimeType === 'image/jpeg' ? 'jpg' : 'png';
              const uploaded = await vfsFileApi.upload({
                name: `occlusion-${Date.now()}.${ext}`,
                mimeType: parsed.mimeType,
                base64Content: parsed.base64Content,
                fileType: 'image',
              });
              if (uploaded?.sourceId) {
                uploadedSourceId = uploaded.sourceId;
                resolvedRef = `vfs://${uploaded.sourceId}`;
              }
            } catch {
              // Fallback to dataUrl when running in offline/test environments without VFS backend.
            }
          }
          if (!resolvedRef) {
            resolvedRef = dataUrl;
          }
        }
      }

      if (!resolvedRef) {
        throw new Error(t('occlusion.invalidImage'));
      }

      const documentScopeId =
        sourceAnchor?.resourceId ||
        uploadedSourceId ||
        `io_doc_${fnv1a64Hex(resolvedRef)}`;

      if (sessionSeq !== sessionSeqRef.current) return;
      const result = await saveCompiledOcclusionCards({
        documentScopeId,
        imageRef: resolvedRef,
        boxes: boxes.map((box) => ({
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          label: box.label.trim() || t('occlusion.regionDefaultLabel', { index: box.clozeIndex }),
          clozeIndex: box.clozeIndex,
        })),
        mode,
        title: sourceTitle || deckName.trim() || t('occlusion.defaultDeck'),
        extraNote: extraNote.trim() || undefined,
        deckName: deckName.trim() || t('occlusion.defaultDeck'),
        sourceAnchor,
      });

      if (sessionSeq !== sessionSeqRef.current) return;
      showGlobalNotification('success', t('occlusion.savedToast', { count: result.cards.length }));
      setOpen(false);
    } catch (error) {
      console.error('[ImageOcclusionBuilderModal] Failed to save occlusion cards:', error);
      if (sessionSeq === sessionSeqRef.current) showGlobalNotification('error', t('occlusion.saveFailed'));
    } finally {
      if (sessionSeq === sessionSeqRef.current) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }, [
    boxes,
    deckName,
    extraNote,
    imageBlob,
    imageDataUrl,
    imageRef,
    mode,
    saving,
    setOpen,
    sourceAnchor,
    sourceTitle,
    t,
  ]);

  const hasImage = Boolean(imageDataUrl || imageRef);
  const canSave = hasImage && uniqueCardCount > 0 && !saving;

  return (
    <DsDialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) setOpen(next);
      }}
      maxWidth="max-w-3xl"
      aria-labelledby={titleId}
    >
      <div className="flex max-h-[85vh] flex-col overflow-hidden text-foreground" data-testid="image-occlusion-builder-modal">
        {/* Header */}
        <header className="flex items-center justify-between gap-3 border-b border-border/35 px-5 py-3.5 pr-12">
          <div className="flex min-w-0 items-center gap-2.5">
            <ImageSquare size={16} className="shrink-0 text-primary" aria-hidden="true" />
            <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">
              {t('occlusion.modalTitle')}
            </h2>
            {sourceLocator ? (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/35 bg-muted/50 px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground"
                data-testid="occlusion-source-badge"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                {sourceLocator}
              </span>
            ) : null}
          </div>
          <span
            className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
            data-testid="occlusion-box-counter"
          >
            {boxes.length}/{MAX_OCCLUSION_BOXES}
          </span>
        </header>

        {/* Controls row: Mode switch + Deck name + Change image */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/35 bg-muted/20 px-5 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('occlusion.modeLabel')}</span>
            <div
              role="group"
              aria-label={t('occlusion.modeLabel')}
              className="inline-flex items-center rounded-lg border border-border/35 bg-muted/40 p-0.5"
            >
              {(['hide-one', 'hide-all'] as const).map((candidate) => {
                const active = mode === candidate;
                return (
                  <button
                    key={candidate}
                    type="button"
                    aria-pressed={active}
                    data-testid={`occlusion-mode-${candidate}`}
                    onClick={() => setMode(candidate)}
                    className={cn(
                      'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                      active
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {candidate === 'hide-one' ? t('occlusion.modeHideOne') : t('occlusion.modeHideAll')}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0">{t('occlusion.deckLabel')}</span>
              <Input
                value={deckName}
                onChange={(e) => setDeckName(e.target.value)}
                placeholder={t('occlusion.deckPlaceholder')}
                className="h-7 w-36 text-xs"
                data-testid="occlusion-deck-input"
              />
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              data-testid="occlusion-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void ingestFileOrBlob(file);
                e.target.value = '';
              }}
            />
            {hasImage ? (
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => fileInputRef.current?.click()}
              >
                <UploadSimple size={14} />
                <span>{t('occlusion.changeImage')}</span>
              </DsButton>
            ) : null}
          </div>
        </div>

        {/* Main Canvas Area */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {!hasImage ? (
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className="flex min-h-[240px] cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border/50 bg-muted/20 p-6 text-center transition-colors hover:bg-muted/35"
              data-testid="occlusion-empty-dropzone"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border/35 bg-card text-muted-foreground">
                <Plus size={18} />
              </div>
              <p className="max-w-sm text-xs text-muted-foreground">{t('occlusion.uploadPrompt')}</p>
              <DsButton type="button" variant="default" size="sm" className="text-xs">
                <UploadSimple size={14} />
                <span>{t('occlusion.chooseImage')}</span>
              </DsButton>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-lg border border-border/35 bg-muted/20 p-2">
              <div className="relative inline-block max-w-full select-none overflow-hidden rounded-md">
                <img
                  src={imageDataUrl ?? imageRef ?? ''}
                  alt={sourceTitle || t('occlusion.modalTitle')}
                  draggable={false}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                      setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
                    }
                  }}
                  className="block max-h-[48vh] w-auto max-w-full object-contain select-none"
                />
                <svg
                  ref={svgStageRef}
                  tabIndex={-1}
                  data-testid="occlusion-svg-stage"
                  viewBox="0 0 1000 1000"
                  preserveAspectRatio="none"
                  onPointerDown={handleStagePointerDown}
                  onPointerMove={handleStagePointerMove}
                  onPointerUp={finalizeDrag}
                  onPointerCancel={() => setDragState(null)}
                  className="absolute inset-0 h-full w-full cursor-crosshair touch-none"
                >
                  {boxes.map((box) => {
                    const isSelected = box.id === selectedBoxId;
                    const rx = box.x * 1000;
                    const ry = box.y * 1000;
                    const rw = box.w * 1000;
                    const rh = box.h * 1000;
                    const handleSize = 18;
                    const half = handleSize / 2;

                    return (
                      <g
                        key={box.id}
                        data-testid={`occlusion-draft-box-${box.clozeIndex}`}
                        data-selected={isSelected ? 'true' : 'false'}
                        onPointerDown={(e) => handleBoxPointerDown(e, box)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          removeBox(box.id);
                        }}
                        className="cursor-move"
                      >
                        <rect
                          x={rx}
                          y={ry}
                          width={rw}
                          height={rh}
                          rx={6}
                          ry={6}
                          fill={isSelected ? 'hsl(var(--primary) / 0.34)' : 'hsl(var(--primary) / 0.22)'}
                          stroke={isSelected ? 'hsl(var(--primary))' : 'hsl(var(--primary) / 0.8)'}
                          strokeWidth={isSelected ? 4 : 2.5}
                          vectorEffect="non-scaling-stroke"
                        />
                        <text
                          x={rx + rw / 2}
                          y={ry + rh / 2}
                          textAnchor="middle"
                          dominantBaseline="central"
                          fill="hsl(var(--foreground))"
                          fontSize={28}
                          fontWeight={600}
                          className="pointer-events-none select-none font-mono tabular-nums"
                        >
                          #{box.clozeIndex}
                        </text>
                        {isSelected
                          ? (
                              [
                                ['nw', rx, ry, 'nwse-resize'],
                                ['ne', rx + rw, ry, 'nesw-resize'],
                                ['sw', rx, ry + rh, 'nesw-resize'],
                                ['se', rx + rw, ry + rh, 'nwse-resize'],
                              ] as const
                            ).map(([corner, cx, cy, cursor]) => (
                              <rect
                                key={corner}
                                data-testid={`occlusion-resize-${corner}`}
                                x={cx - half}
                                y={cy - half}
                                width={handleSize}
                                height={handleSize}
                                fill="hsl(var(--card))"
                                stroke="hsl(var(--primary))"
                                strokeWidth={2}
                                vectorEffect="non-scaling-stroke"
                                style={{ cursor }}
                                onPointerDown={(e) => handleCornerPointerDown(e, box, corner)}
                              />
                            ))
                          : null}
                      </g>
                    );
                  })}

                  {draftPreviewRect && draftPreviewRect.w > 0 && draftPreviewRect.h > 0 ? (
                    <rect
                      data-testid="occlusion-drawing-preview"
                      x={draftPreviewRect.x * 1000}
                      y={draftPreviewRect.y * 1000}
                      width={draftPreviewRect.w * 1000}
                      height={draftPreviewRect.h * 1000}
                      fill="hsl(var(--primary) / 0.18)"
                      stroke="hsl(var(--primary))"
                      strokeDasharray="6 4"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      className="pointer-events-none"
                    />
                  ) : null}
                </svg>
              </div>
            </div>
          )}

          {/* Selected Box Inspector + Optional Extra Back Note */}
          {hasImage ? (
            <div className="flex flex-col gap-2.5">
              {selectedBox ? (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/35 bg-muted/25 px-3 py-2"
                  data-testid="occlusion-selected-inspector"
                >
                  <span className="shrink-0 font-mono text-xs font-medium tabular-nums text-primary">
                    {t('occlusion.selectedRegionLabel', { index: selectedBox.clozeIndex })}
                  </span>
                  <Input
                    value={selectedBox.label}
                    maxLength={48}
                    onChange={(e) => {
                      const val = e.target.value.slice(0, 48);
                      setBoxes((prev) =>
                        prev.map((b) => (b.id === selectedBox.id ? { ...b, label: val } : b)),
                      );
                    }}
                    placeholder={t('occlusion.boxLabelPlaceholder')}
                    className="h-7 min-w-[160px] flex-1 text-xs"
                    data-testid="occlusion-box-label-input"
                  />
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeBox(selectedBox.id)}
                    className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                    data-testid="occlusion-delete-box-btn"
                  >
                    <Trash size={14} />
                    <span>{t('occlusion.deleteBox')}</span>
                  </DsButton>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('occlusion.maxBoxesHint', { max: MAX_OCCLUSION_BOXES })}
                </p>
              )}

              <Input
                value={extraNote}
                onChange={(e) => setExtraNote(e.target.value)}
                placeholder={t('occlusion.extraNotePlaceholder')}
                className="h-8 text-xs"
                data-testid="occlusion-extra-note-input"
              />
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-border/35 bg-muted/15 px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                uniqueCardCount > 0 ? 'bg-success' : 'bg-muted-foreground/40',
              )}
              aria-hidden="true"
            />
            <span className="font-mono tabular-nums" data-testid="occlusion-card-count-preview">
              {t('occlusion.cardCountPreview', { count: uniqueCardCount })}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setOpen(false)}
              className="text-xs"
            >
              {t('occlusion.cancel')}
            </DsButton>
            <DsButton
              type="button"
              variant="primary"
              size="sm"
              disabled={!canSave}
              onClick={() => void handleSave()}
              className="text-xs"
              data-testid="occlusion-save-btn"
            >
              {saving ? t('occlusion.saving') : t('occlusion.saveAndEnqueue')}
            </DsButton>
          </div>
        </footer>
      </div>
    </DsDialog>
  );
};

export default ImageOcclusionBuilderModal;
