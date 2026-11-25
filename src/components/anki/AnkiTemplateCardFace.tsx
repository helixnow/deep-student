import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassMinus, MagnifyingGlassPlus, X } from '@phosphor-icons/react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { vfsFileApi } from '@/api/vfsFileApi';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';
import type { SandboxImageClickPayload } from '@/components/previews/HtmlSandboxPreview';
import { DsButton } from '@/components/ui/DsButton';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import {
  TemplateRenderService,
  type DetailedCardRenderResult,
} from '@/services/templateRenderService';
import { applyClozeMarkup, extractClozeOrdinals, type TemplateRenderIssue } from '@/services/ankiTemplateEngine';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { formatAnchorShortLocator, parseSemanticAnchor } from '@/ui-kernel/contracts/interop';
import { buildCardFaceCss, useCardFaceSurfaceColor, useDocumentDarkMode } from './utils/cardFaceStyles';
import { cardHtmlNeedsKatex, renderCardFaceLatexHtml, renderCardTemplateMath } from './utils/cardFaceLatex';
import { useKatexSandboxCss } from './utils/katexSandboxCss';
import {
  CARD_FACE_HELPER_SCRIPT,
  clearCardMediaCache,
  extractInlineMediaNames,
  injectCardMedia,
  isAnkiMediaRef,
  isAudioMediaRef,
  isInteractiveCardHtml,
  isVideoMediaRef,
  lookupCardMedia,
  looksLikeHtml,
  mediaBasename,
  soundNames,
  useCardMediaState,
} from './utils/cardMedia';
import {
  normalizeOcclusionSpec,
  occlusionBoxPercentStyle,
  parseOcclusionSpec,
  type OcclusionSpec,
} from './utils/imageOcclusion';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { cn } from '@/utils/cn';

export type AnkiCardFace = 'front' | 'back';
export type OcclusionStudyMode = 'hide-one' | 'hide-all';

export interface OcclusionCardStageProps {
  spec: OcclusionSpec;
  side: AnkiCardFace;
  mode: OcclusionStudyMode;
  targetClozeIndex: number;
  imageSrc?: string | null;
  title?: string;
  extraNote?: string;
  sourceAnchorUri?: string;
  compact?: boolean;
  className?: string;
}

const MAX_IMAGE_LRU_ENTRIES = 64;
const resolvedImageLruCache = new Map<string, string>();

function setImageCache(key: string, value: string): void {
  if (resolvedImageLruCache.has(key)) {
    resolvedImageLruCache.delete(key);
  } else if (resolvedImageLruCache.size >= MAX_IMAGE_LRU_ENTRIES) {
    const oldest = resolvedImageLruCache.keys().next().value;
    if (oldest !== undefined) resolvedImageLruCache.delete(oldest);
  }
  resolvedImageLruCache.set(key, value);
}

function getSyncImageSrc(imageRef: string, explicitSrc?: string | null): string | null {
  if (typeof explicitSrc === 'string' && explicitSrc.trim()) {
    return explicitSrc.trim();
  }
  const ref = imageRef.trim();
  if (!ref) return null;
  if (/^(data:|blob:|https?:|asset:)/i.test(ref)) return ref;
  const cached = resolvedImageLruCache.get(ref);
  return cached ?? null;
}

function useResolvedOcclusionImageSrc(imageRef: string, explicitSrc?: string | null): string | null {
  const syncSrc = getSyncImageSrc(imageRef, explicitSrc);
  const [asyncSrc, setAsyncSrc] = useState<string | null>(syncSrc);

  useEffect(() => {
    const immediate = getSyncImageSrc(imageRef, explicitSrc);
    if (immediate) {
      setAsyncSrc(immediate);
      return;
    }
    const ref = imageRef.trim();
    if (!ref) {
      setAsyncSrc(null);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        if (ref.toLowerCase().startsWith('vfs://')) {
          const fileId = ref.slice('vfs://'.length).trim();
          if (!fileId) return;
          const res = await vfsFileApi.getContent(fileId);
          if (cancelled) return;
          if (res?.found && typeof res.content === 'string' && res.content.trim()) {
            const raw = res.content.trim();
            const url = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
            setImageCache(ref, url);
            setAsyncSrc(url);
            return;
          }
          return;
        }

        try {
          const mediaUrl = await invoke<string>('read_anki_media', { path: ref });
          if (cancelled) return;
          if (typeof mediaUrl === 'string' && mediaUrl.trim()) {
            setImageCache(ref, mediaUrl.trim());
            setAsyncSrc(mediaUrl.trim());
            return;
          }
        } catch {
          // Fall back to Tauri asset protocol when not in anki_media directory.
        }

        const converted = convertFileSrc(ref);
        if (!cancelled && converted) {
          setImageCache(ref, converted);
          setAsyncSrc(converted);
        }
      } catch {
        if (!cancelled) setAsyncSrc(null);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [imageRef, explicitSrc]);

  return syncSrc ?? asyncSrc;
}

export const OcclusionCardStage: React.FC<OcclusionCardStageProps> = ({
  spec,
  side,
  mode,
  targetClozeIndex,
  imageSrc: explicitImageSrc,
  title,
  extraNote,
  sourceAnchorUri,
  compact = false,
  className,
}) => {
  const { t } = useTranslation('flashcards');
  const safeSpec = useMemo(() => normalizeOcclusionSpec(spec), [spec]);
  const resolvedSrc = useResolvedOcclusionImageSrc(safeSpec?.imageRef ?? spec.imageRef ?? '', explicitImageSrc);

  const activeTarget = useMemo(() => {
    const boxes = safeSpec?.boxes ?? [];
    if (boxes.length === 0) return 1;
    if (Number.isSafeInteger(targetClozeIndex) && boxes.some((b) => b.clozeIndex === targetClozeIndex)) {
      return targetClozeIndex;
    }
    return boxes[0].clozeIndex;
  }, [safeSpec, targetClozeIndex]);

  const stageIdentity = `${safeSpec?.imageRef ?? ''}:${activeTarget}:${side}:${mode}`;
  const [peekState, setPeekState] = useState<{ key: string; indices: Set<number> }>(() => ({
    key: stageIdentity,
    indices: new Set(),
  }));
  const peekedSiblings = peekState.key === stageIdentity ? peekState.indices : new Set<number>();

  const toggleSiblingPeek = useCallback(
    (clozeIndex: number) => {
      setPeekState((prev) => {
        const next = new Set(prev.key === stageIdentity ? prev.indices : []);
        if (next.has(clozeIndex)) next.delete(clozeIndex);
        else next.add(clozeIndex);
        return { key: stageIdentity, indices: next };
      });
    },
    [stageIdentity],
  );

  const parsedAnchor = useMemo(
    () => (sourceAnchorUri ? parseSemanticAnchor(sourceAnchorUri) : null),
    [sourceAnchorUri],
  );
  const shortLocator = useMemo(
    () => (parsedAnchor ? formatAnchorShortLocator(parsedAnchor) : ''),
    [parsedAnchor],
  );

  const handleRevealSource = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (!sourceAnchorUri) return;
      void getAppKernel().anchors.reveal(sourceAnchorUri, { splitIfClosed: true, pulse: true });
    },
    [sourceAnchorUri],
  );

  if (!safeSpec) return null;

  const targetBoxes = safeSpec.boxes.filter((box) => box.clozeIndex === activeTarget);
  const targetAnswerLabel = targetBoxes
    .map((box) => box.label.trim())
    .filter(Boolean)
    .join(' / ');

  return (
    <div
      data-testid="image-occlusion-card-view"
      data-side={side}
      data-mode={mode}
      data-target-cloze={activeTarget}
      className={cn('flex w-full flex-col items-center gap-3', className)}
    >
      {title ? (
        <div className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate font-medium text-foreground/90">{title}</span>
          <span className="font-mono tabular-nums text-[11px] text-muted-foreground">
            #{activeTarget}
          </span>
        </div>
      ) : null}

      <div
        data-testid="occlusion-stage-frame"
        className={cn(
          'relative inline-block w-full overflow-hidden rounded-lg border border-border/35 bg-muted/20',
          compact ? 'max-w-[420px]' : 'max-w-[680px]',
        )}
      >
        {resolvedSrc ? (
          <img
            src={resolvedSrc}
            alt={title ?? ''}
            draggable={false}
            className={cn(
              'block w-full select-none object-contain',
              compact ? 'max-h-64' : 'max-h-[440px]',
            )}
          />
        ) : (
          <div
            aria-hidden="true"
            className={cn('w-full bg-muted/30', compact ? 'h-44' : 'h-64')}
          />
        )}

        <div
          data-testid="occlusion-masks-layer"
          className="pointer-events-none absolute inset-0"
        >
          {safeSpec.boxes.map((box, index) => {
            const posStyle = occlusionBoxPercentStyle(box);
            const isTarget = box.clozeIndex === activeTarget;

            if (side === 'front') {
              if (isTarget) {
                return (
                  <div
                    key={`${box.clozeIndex}-${index}`}
                    data-testid="occlusion-mask-target"
                    data-mask-role="target"
                    data-masked="true"
                    data-cloze-index={box.clozeIndex}
                    style={posStyle}
                    className="absolute flex select-none items-center justify-center rounded-[4px] border border-primary/80 bg-primary text-primary-foreground shadow-sm"
                  >
                    <span className="font-mono tabular-nums text-xs font-semibold leading-none">
                      #{box.clozeIndex}
                    </span>
                  </div>
                );
              }

              if (mode === 'hide-all') {
                return (
                  <div
                    key={`${box.clozeIndex}-${index}`}
                    data-testid="occlusion-mask-sibling"
                    data-mask-role="sibling"
                    data-masked="true"
                    data-cloze-index={box.clozeIndex}
                    style={posStyle}
                    className="absolute flex select-none items-center justify-center rounded-[4px] border border-border/70 bg-muted/95 text-muted-foreground"
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60"
                      aria-hidden="true"
                    />
                  </div>
                );
              }

              return (
                <div
                  key={`${box.clozeIndex}-${index}`}
                  data-testid="occlusion-context-unmasked"
                  data-mask-role="sibling"
                  data-masked="false"
                  data-cloze-index={box.clozeIndex}
                  style={posStyle}
                  className="pointer-events-none absolute rounded-[4px] border border-dashed border-border/45 bg-transparent"
                />
              );
            }

            // side === 'back'
            if (isTarget) {
              return (
                <div
                  key={`${box.clozeIndex}-${index}`}
                  data-testid="occlusion-revealed-target"
                  data-mask-role="target"
                  data-masked="false"
                  data-cloze-index={box.clozeIndex}
                  style={posStyle}
                  className="pointer-events-none absolute rounded-[4px] border-2 border-success bg-success/10"
                />
              );
            }

            if (mode === 'hide-all') {
              const isPeeked = peekedSiblings.has(box.clozeIndex);
              return (
                <button
                  key={`${box.clozeIndex}-${index}`}
                  type="button"
                  data-testid="occlusion-back-sibling"
                  data-mask-role="sibling"
                  data-masked={isPeeked ? 'false' : 'true'}
                  data-cloze-index={box.clozeIndex}
                  style={{ ...posStyle, pointerEvents: 'auto' }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleSiblingPeek(box.clozeIndex);
                  }}
                  className={cn(
                    'absolute flex items-center justify-center rounded-[4px] transition-colors',
                    isPeeked
                      ? 'border border-dashed border-border/55 bg-transparent'
                      : 'border border-border/50 bg-muted/75 text-muted-foreground hover:bg-muted/60',
                  )}
                >
                  {!isPeeked ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50"
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              );
            }

            return (
              <div
                key={`${box.clozeIndex}-${index}`}
                data-testid="occlusion-back-context"
                data-mask-role="sibling"
                data-masked="false"
                data-cloze-index={box.clozeIndex}
                style={posStyle}
                className="pointer-events-none absolute rounded-[4px] border border-dashed border-border/35 bg-transparent"
              />
            );
          })}
        </div>
      </div>

      {side === 'back' && (targetAnswerLabel || extraNote) ? (
        <>
          <div className="h-px w-full bg-border/35" aria-hidden="true" />
          <div
            data-testid="occlusion-answer-caption"
            className="flex w-full flex-col gap-1.5 text-left"
          >
            {targetAnswerLabel ? (
              <div className="flex items-baseline gap-2 text-sm text-foreground">
                <span className="font-mono tabular-nums text-xs font-semibold text-primary">
                  #{activeTarget}
                </span>
                <span className="font-medium">{targetAnswerLabel}</span>
              </div>
            ) : null}
            {extraNote ? (
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                {extraNote}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {parsedAnchor && sourceAnchorUri ? (
        <div className="flex w-full items-center justify-end">
          <button
            type="button"
            data-testid="occlusion-reveal-source"
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={handleRevealSource}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-card/90 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            <span>{t('occlusion.revealSource', { defaultValue: '回到原处' })}</span>
            {shortLocator ? (
              <span className="font-mono tabular-nums text-foreground/85">
                · {shortLocator}
              </span>
            ) : null}
          </button>
        </div>
      ) : null}
    </div>
  );
};

export interface AnkiTemplateCardFaceProps {
  card: AnkiCard;
  template?: CustomAnkiTemplate | null;
  side: AnkiCardFace;
  compact?: boolean;
  className?: string;
  fallbackText?: string;
  emptyText?: string;
  /** 是否内联展示模板渲染问题（默认展示） */
  showRenderIssues?: boolean;
  /**
   * 舞台高度（px）：传入时模板的 .card 背景铺满该高度、内容垂直居中——
   * 与 Anki 复习窗口一致，模板本身就是卡片，宿主不再另套卡片框。
   */
  stageHeight?: number;
  /**
   * 复习舞台：卡面含提示折叠 / 音频 / 链接 / 模板脚本时放开 iframe 指针事件，
   * 点击空白处经 `onFrameClick` 交给宿主（翻面）；不含时整块透传给宿主。
   */
  interactiveFrame?: boolean;
  onFrameClick?: () => void;
  /**
   * 交互式卡面的 iframe 会吃掉指针事件，文档自身滚不动时由辅助脚本转发滚轮；
   * 复习舞台用它驱动外层统一 viewport 滚动（WebKit 不会自动把滚轮链回宿主）。
   */
  onFrameWheel?: (deltaY: number, deltaMode: number) => void;
  /** 图片全分辨率缩放灯箱开关状态变化回调（复习舞台据此在灯箱打开期间屏蔽翻面与滑动手势） */
  onImageLightboxChange?: (open: boolean) => void;
}

function defaultFaceText(card: AnkiCard, side: AnkiCardFace): string {
  if (side === 'back') {
    return card.back || card.fields?.Back || card.text || '';
  }
  return card.front || card.fields?.Front || card.text || '';
}

const SOUND_MARKER_RE = /\[sound:[^\]]*\]/gi;

export function extractAccessibleCardText(html: string, fallback = ''): string {
  const cleanText = (input: string): string =>
    input
      .replace(SOUND_MARKER_RE, '')
      .replace(/[ \t\r]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  if (html && typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      doc
        .querySelectorAll(
          'style, script, noscript, template, audio, video, .anki-sound-player, .anki-sound, .anki-sound-btn, .anki-sound-play, [aria-hidden="true"], .sr-only',
        )
        .forEach((node) => node.remove());
      doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, hr, blockquote').forEach((block) => {
        block.append('\n');
      });
      const extracted = cleanText(doc.body?.textContent ?? '');
      if (extracted) return extracted;
    } catch {
      // fall through to regex fallback
    }
  }

  const stripFallback = (input: string): string =>
    cleanText(
      input
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    );

  return stripFallback(html) || stripFallback(fallback);
}

/**
 * apkg 导入卡携带 AnkiCardOrd（0 起）：Cloze 笔记的第 N 张卡对应 c(N+1) 空位。
 * 仅对 Cloze 模板生效；本地生成卡无 ord（一卡多空全遮，属已知限制）。
 */
function resolveClozeOrdinal(
  card: AnkiCard,
  template?: CustomAnkiTemplate | null,
): number | null {
  if (template && (template.note_type ?? '').trim().toLowerCase() !== 'cloze') return null;
  const raw = card.extra_fields?.AnkiCardOrd ?? card.fields?.AnkiCardOrd;
  const ord = typeof raw === 'string'
    ? (/^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN)
    : typeof raw === 'number'
      ? raw
      : Number.NaN;
  if (!Number.isInteger(ord) || ord < 0) return null;
  return ord + 1;
}

/** 卡面图片地址解析：优先用 read_anki_media 解析的 data URL，其次 data:/blob:/http(s)；仅非 anki_media 路径退回 asset protocol。 */
function resolveCardImageSrc(image: string, media: ReadonlyMap<string, string>): string | null {
  const value = image.trim();
  if (!value) return null;
  const fromMedia = lookupCardMedia(media, value);
  if (fromMedia) return fromMedia;
  if (/^(data:|blob:|https?:|asset:)/i.test(value)) return value;
  if (isAnkiMediaRef(value)) return null;
  try {
    return convertFileSrc(value);
  } catch {
    return null;
  }
}

const RenderIssueNotice: React.FC<{ issues: TemplateRenderIssue[] }> = ({ issues }) => {
  const { t } = useTranslation('flashcards');
  if (issues.length === 0) return null;
  const primary = issues[0];
  const extra = issues.length - 1;
  return (
    <div
      data-anki-render-issues={issues.length}
      className="mt-1 rounded border border-warning/50 bg-warning/10 px-2 py-1 text-xs leading-snug text-warning"
    >
      {t('card.renderIssue', { message: primary.message })}
      {extra > 0 ? t('card.renderIssueMore', { count: extra }) : ''}
    </div>
  );
};

const LIGHTBOX_ZOOM_MIN = 0.5;
const LIGHTBOX_ZOOM_MAX = 4;
const LIGHTBOX_ZOOM_STEP = 0.5;

const CardImageLightbox: React.FC<{
  image: SandboxImageClickPayload;
  onClose: () => void;
}> = ({ image, onClose }) => {
  const { t } = useTranslation('common');
  const [zoomMode, setZoomMode] = useState<'fit' | 'custom'>('fit');
  const [scale, setScale] = useState<number>(1);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);

  const handleKeyDown = useCallback((rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      event.stopPropagation();
      setZoomMode('custom');
      setScale((prev) => Math.min(LIGHTBOX_ZOOM_MAX, Number((prev + LIGHTBOX_ZOOM_STEP).toFixed(2))));
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      event.stopPropagation();
      setZoomMode('custom');
      setScale((prev) => Math.max(LIGHTBOX_ZOOM_MIN, Number((prev - LIGHTBOX_ZOOM_STEP).toFixed(2))));
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      event.stopPropagation();
      setZoomMode('fit');
      setScale(1);
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      // 避免灯箱打开期间按空格/回车误触发底层复习卡翻面
      event.preventDefault();
      event.stopPropagation();
    }
  }, [onClose]);

  useEventRegistry(
    [{ target: 'window', type: 'keydown', listener: handleKeyDown, options: true }],
    [handleKeyDown],
  );

  const handleZoomIn = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setZoomMode('custom');
    setScale((prev) => Math.min(LIGHTBOX_ZOOM_MAX, Number((prev + LIGHTBOX_ZOOM_STEP).toFixed(2))));
  }, []);

  const handleZoomOut = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setZoomMode('custom');
    setScale((prev) => Math.max(LIGHTBOX_ZOOM_MIN, Number((prev - LIGHTBOX_ZOOM_STEP).toFixed(2))));
  }, []);

  const handleToggleFitOrReset = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (zoomMode === 'fit') {
      setZoomMode('custom');
      setScale(1);
    } else {
      setZoomMode('fit');
      setScale(1);
    }
  }, [zoomMode]);

  const handleImageClick = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (zoomMode === 'fit') {
      setZoomMode('custom');
      setScale(1.5);
    } else {
      setZoomMode('fit');
      setScale(1);
    }
  }, [zoomMode]);

  const stopBubble = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  const zoomStyle: React.CSSProperties | undefined = useMemo(() => {
    if (zoomMode === 'fit') return undefined;
    if (naturalSize && naturalSize.width > 0) {
      return {
        width: `${Math.round(naturalSize.width * scale)}px`,
        height: 'auto',
        maxWidth: 'none',
        maxHeight: 'none',
      };
    }
    return {
      transform: `scale(${scale})`,
      transformOrigin: 'center center',
      maxWidth: 'none',
      maxHeight: 'none',
    };
  }, [naturalSize, scale, zoomMode]);

  const content = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.alt || t('imageViewer.zoomInOut', { defaultValue: 'Zoom' })}
      data-testid="anki-image-lightbox"
      data-anki-image-lightbox="true"
      className="fixed inset-0 z-modal flex flex-col items-center justify-center bg-black/85 backdrop-blur-xs"
      onPointerDown={stopBubble}
      onMouseDown={stopBubble}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="fixed right-4 top-4 z-10 flex items-center gap-2"
        onClick={stopBubble}
        onPointerDown={stopBubble}
      >
        <DsButton
          type="button"
          variant="ghost"
          iconOnly
          data-testid="anki-image-lightbox-zoom-out"
          aria-label={t('imageViewer.zoomOut', { defaultValue: 'Zoom out' })}
          title={t('imageViewer.zoom_out', { defaultValue: 'Zoom out (-)' })}
          onClick={handleZoomOut}
          className="h-11 min-w-11 rounded-lg border border-white/25 bg-black/65 px-2.5 text-sm text-white hover:bg-black/85 hover:text-white focus-visible:ring-white/80"
        >
          <MagnifyingGlassMinus size={18} aria-hidden="true" />
        </DsButton>
        <DsButton
          type="button"
          variant="ghost"
          data-testid="anki-image-lightbox-reset"
          aria-label={t('imageViewer.reset', { defaultValue: 'Reset' })}
          title={t('imageViewer.reset_title', { defaultValue: 'Reset (0)' })}
          onClick={handleToggleFitOrReset}
          className="h-11 min-w-14 rounded-lg border border-white/25 bg-black/65 px-3 font-mono text-xs font-medium tabular-nums text-white hover:bg-black/85 hover:text-white focus-visible:ring-white/80"
        >
          {zoomMode === 'fit' ? '1:1' : `${Math.round(scale * 100)}%`}
        </DsButton>
        <DsButton
          type="button"
          variant="ghost"
          iconOnly
          data-testid="anki-image-lightbox-zoom-in"
          aria-label={t('imageViewer.zoomIn', { defaultValue: 'Zoom in' })}
          title={t('imageViewer.zoom_in', { defaultValue: 'Zoom in (+)' })}
          onClick={handleZoomIn}
          className="h-11 min-w-11 rounded-lg border border-white/25 bg-black/65 px-2.5 text-sm text-white hover:bg-black/85 hover:text-white focus-visible:ring-white/80"
        >
          <MagnifyingGlassPlus size={18} aria-hidden="true" />
        </DsButton>
        <DsButton
          type="button"
          variant="ghost"
          iconOnly
          data-testid="anki-image-lightbox-close"
          aria-label={t('imageViewer.close', { defaultValue: 'Close (Esc)' })}
          title={t('imageViewer.close', { defaultValue: 'Close (Esc)' })}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
          className="h-11 min-w-11 rounded-lg border border-white/25 bg-black/65 px-2.5 text-sm text-white hover:bg-black/85 hover:text-white focus-visible:ring-white/80"
        >
          <X size={18} aria-hidden="true" />
        </DsButton>
      </div>

      <div
        data-testid="anki-image-lightbox-backdrop"
        className="flex h-full w-full items-center justify-center overflow-auto p-6 pt-20"
        onClick={(event) => {
          event.stopPropagation();
          if (event.target === event.currentTarget) {
            onClose();
          }
        }}
      >
        <img
          data-testid="anki-image-lightbox-img"
          src={image.src}
          alt={image.alt}
          draggable={false}
          onClick={handleImageClick}
          onLoad={(event) => {
            const el = event.currentTarget;
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              setNaturalSize({ width: el.naturalWidth, height: el.naturalHeight });
            }
          }}
          style={zoomStyle}
          className={cn(
            'select-none rounded shadow-2xl',
            zoomMode === 'fit'
              ? 'max-h-[86vh] max-w-[94vw] cursor-zoom-in object-contain'
              : 'cursor-zoom-out',
          )}
        />
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(content, document.body);
  }
  return content;
};

export const AnkiTemplateCardFace: React.FC<AnkiTemplateCardFaceProps> = ({
  card,
  template,
  side,
  compact = true,
  className,
  fallbackText,
  emptyText = '',
  showRenderIssues = true,
  stageHeight,
  interactiveFrame = false,
  onFrameClick,
  onFrameWheel,
  onImageLightboxChange,
}) => {
  const { t: tCommon } = useTranslation('common');
  const rawExtraFields = useMemo<Record<string, string> | null>(() => {
    const dynamicExtra = (card as AnkiCard & { extraFields?: Record<string, string> }).extraFields;
    return dynamicExtra ?? card.extra_fields ?? card.fields ?? null;
  }, [card]);
  const occlusionSpec = useMemo(() => parseOcclusionSpec(rawExtraFields), [rawExtraFields]);

  const darkMode = useDocumentDarkMode();
  const surfaceColor = useCardFaceSurfaceColor();
  const [mediaRetryNonce, setMediaRetryNonce] = useState(0);
  const [lightboxImage, setLightboxImage] = useState<SandboxImageClickPayload | null>(null);

  useEffect(() => {
    setLightboxImage(null);
  }, [card.id, side]);

  useEffect(() => {
    onImageLightboxChange?.(lightboxImage !== null);
  }, [lightboxImage, onImageLightboxChange]);

  useEffect(() => () => {
    onImageLightboxChange?.(false);
  }, [onImageLightboxChange]);

  const handleOpenLightbox = useCallback((payload: SandboxImageClickPayload) => {
    if (!payload.src) return;
    setLightboxImage(payload);
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setLightboxImage(null);
  }, []);

  const handleRetryMedia = useCallback(() => {
    clearCardMediaCache();
    setMediaRetryNonce((n) => n + 1);
  }, []);

  const rendered = useMemo<DetailedCardRenderResult | null>(() => {
    if (occlusionSpec || !template) return null;
    // renderCardDetailed 内部结构化捕获所有异常，不会抛出；[sound:] 原样保留，下面换成 <audio>
    return TemplateRenderService.renderCardDetailed(card, template, {
      clozeOrdinal: resolveClozeOrdinal(card, template),
      soundStrategy: 'keep',
    });
  }, [card, occlusionSpec, template]);

  const faceResult = rendered?.[side] ?? null;
  const htmlContent = faceResult?.html?.trim() || '';
  const issues = faceResult?.issues ?? [];
  const plainText = fallbackText ?? defaultFaceText(card, side);
  const frontHtml = rendered?.front?.html ?? (template ? '' : defaultFaceText(card, 'front'));
  const backHtml = rendered?.back?.html ?? (template ? '' : defaultFaceText(card, 'back'));
  const rawFaceHtml = useMemo(() => {
    if (occlusionSpec) return '';
    if (htmlContent) return htmlContent;
    if (!template && extractClozeOrdinals(plainText).length > 0) {
      return applyClozeMarkup(plainText, { side, ordinal: resolveClozeOrdinal(card) });
    }
    if (!template && looksLikeHtml(plainText)) {
      // 外部 Anki 牌组的字段是 HTML：按 HTML 渲染，而不是当纯文本转义
      return plainText;
    }
    return '';
  }, [occlusionSpec, htmlContent, template, plainText, card, side]);

  const inlineMediaRefs = useMemo(
    () => (occlusionSpec ? undefined : extractInlineMediaNames(rawFaceHtml)),
    [occlusionSpec, rawFaceHtml],
  );
  const { media, loading: mediaLoading } = useCardMediaState(
    occlusionSpec ? undefined : card.images,
    inlineMediaRefs,
    mediaRetryNonce,
  );

  const faceHtml = useMemo(() => {
    if (!rawFaceHtml) return '';
    // 背面不自动重放正面的音频（同 Anki：{{FrontSide}} 里的音频不自动播放）
    const noAutoplay = side === 'back' ? soundNames(frontHtml) : undefined;
    return injectCardMedia(rawFaceHtml, media, { noAutoplay, mediaLoading });
  }, [rawFaceHtml, side, frontHtml, media, mediaLoading]);
  // 卡面公式与聊天侧一致由 KaTeX 自带字体排版（htmlAndMathml + iframe 内 data: 字体），
  // 不依赖设备数学字体（#461）。样式首次下载期间先出纯 MathML，就绪后切换。
  const katexCss = useKatexSandboxCss(cardHtmlNeedsKatex(faceHtml));
  const previewHtml = useMemo(
    () => (faceHtml ? renderCardTemplateMath(faceHtml, katexCss ? 'htmlAndMathml' : 'mathml') : ''),
    [faceHtml, katexCss],
  );
  const frameInteractive = interactiveFrame && isInteractiveCardHtml(previewHtml);
  const frameHtml = frameInteractive ? `${previewHtml}${CARD_FACE_HELPER_SCRIPT}` : previewHtml;
  const accessibleFaceText = useMemo(
    () => (previewHtml ? extractAccessibleCardText(previewHtml, plainText) : ''),
    [previewHtml, plainText],
  );
  // 媒体异步加载完成后重建 ShadowDomPreview，避免预加载阶段 0px 坏图把 iframe 高度锁死。
  const mediaSignature = useMemo(() => {
    if (media.size === 0) return `m:0:${mediaLoading ? '1' : '0'}`;
    return `m:${Array.from(media.keys()).sort().join(',')}:${mediaLoading ? '1' : '0'}`;
  }, [media, mediaLoading]);

  // fallback 视图：\( \)、\[ \]、$、$$ 公式经 KaTeX 渲染；无公式时保持纯文本零成本
  const latexHtml = useMemo(
    () => (!occlusionSpec && plainText ? renderCardFaceLatexHtml(plainText) : null),
    [occlusionSpec, plainText],
  );
  const referencedInAnyFace = useMemo(() => {
    const refs = new Set<string>();
    for (const name of extractInlineMediaNames(frontHtml)) refs.add(name.toLowerCase());
    for (const name of extractInlineMediaNames(backHtml)) refs.add(name.toLowerCase());
    for (const name of extractInlineMediaNames(rawFaceHtml)) refs.add(name.toLowerCase());
    return refs;
  }, [frontHtml, backHtml, rawFaceHtml]);

  const { imageSrcs, audioAttachments } = useMemo(() => {
    if (occlusionSpec) return { imageSrcs: [] as string[], audioAttachments: [] as Array<{ name: string; src: string }> };
    const imgs: string[] = [];
    const audios: Array<{ name: string; src: string }> = [];
    const seenImgs = new Set<string>();
    const seenAudios = new Set<string>();
    for (const raw of card.images ?? []) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const base = mediaBasename(trimmed);
      // HTML 模式下跳过已被正反面内联引用的附件，避免重复展示或在正面剧透背面图片
      if (previewHtml && base && referencedInAnyFace.has(base.toLowerCase())) continue;
      if (isAudioMediaRef(trimmed)) {
        const src = resolveCardImageSrc(trimmed, media);
        if (src && !seenAudios.has(src)) {
          seenAudios.add(src);
          audios.push({ name: base || trimmed, src });
        }
        continue;
      }
      if (isVideoMediaRef(trimmed)) continue;
      const src = resolveCardImageSrc(trimmed, media);
      if (src && !seenImgs.has(src)) {
        seenImgs.add(src);
        imgs.push(src);
      }
    }
    return { imageSrcs: imgs, audioAttachments: audios };
  }, [occlusionSpec, card.images, media, previewHtml, referencedInAnyFace]);

  const hasInteractiveAttachments = imageSrcs.length > 0 || audioAttachments.length > 0;
  const hasInteractiveContent = frameInteractive || hasInteractiveAttachments;

  const stageMode = stageHeight != null && stageHeight > 0;
  const cssContent = useMemo(
    // 舞台 CSS（.card 铺满 + 纵向居中）见 CARD_FACE_STAGE_CSS：body 保持块级布局，
    // 模板「纸张」的 max-width + margin:0 auto 才按 Anki 语义取自然宽度。
    () => buildCardFaceCss(template?.css_style, { darkMode, surfaceColor, stage: stageMode }),
    [template?.css_style, darkMode, surfaceColor, stageMode],
  );

  if (occlusionSpec) {
    const mode: OcclusionStudyMode = rawExtraFields?._occlusion_mode === 'hide-all'
      ? 'hide-all'
      : 'hide-one';
    const parsedTarget = Number(rawExtraFields?._occlusion_target);
    const targetClozeIndex = Number.isSafeInteger(parsedTarget) && parsedTarget >= 1
      ? parsedTarget
      : (resolveClozeOrdinal(card, template) ?? occlusionSpec.boxes[0]?.clozeIndex ?? 1);
    const sourceAnchorUri = rawExtraFields?._source_anchor;
    const extraNote = rawExtraFields?.Extra;

    return (
      <div
        className={cn(className)}
        data-anki-card-face={side}
        data-render-mode="occlusion"
      >
        <OcclusionCardStage
          spec={occlusionSpec}
          side={side}
          mode={mode}
          targetClozeIndex={targetClozeIndex}
          extraNote={extraNote}
          sourceAnchorUri={sourceAnchorUri}
          compact={compact}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(className, interactiveFrame && !hasInteractiveContent && 'pointer-events-none')}
      data-anki-card-face={side}
      data-render-mode={htmlContent ? 'template' : previewHtml ? 'html' : 'plain'}
      data-interactive={hasInteractiveContent ? 'true' : undefined}
    >
      {previewHtml ? (
        <>
          <ShadowDomPreview
            key={mediaSignature}
            htmlContent={frameHtml}
            cssContent={cssContent}
            compact={compact}
            fidelity="anki"
            darkMode={darkMode}
            minHeight={stageMode ? stageHeight : undefined}
            className={interactiveFrame && !frameInteractive ? 'pointer-events-none' : undefined}
            onFrameClick={frameInteractive ? onFrameClick : undefined}
            onFrameImageClick={frameInteractive ? handleOpenLightbox : undefined}
            onFrameSoundClick={frameInteractive ? handleRetryMedia : undefined}
            onFrameWheel={frameInteractive ? onFrameWheel : undefined}
            trustedCss={katexCss ?? undefined}
          />
          {accessibleFaceText ? (
            <div
              data-testid={`anki-card-face-${side}-text`}
              data-anki-accessible-text={side}
              className="sr-only select-text whitespace-pre-wrap"
            >
              {accessibleFaceText}
            </div>
          ) : null}
          {imageSrcs.length > 0 || audioAttachments.length > 0 ? (
            <div className="mt-3 flex w-full flex-col items-center gap-2">
              {imageSrcs.map((src) => (
                <DsButton
                  key={src}
                  type="button"
                  variant="ghost"
                  data-anki-zoom-trigger="true"
                  aria-label={tCommon('imageViewer.zoomIn', { defaultValue: 'Zoom in' })}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleOpenLightbox({ src, alt: '' });
                  }}
                  className="h-auto max-w-full cursor-zoom-in rounded border-0 bg-transparent p-0 hover:bg-transparent"
                >
                  <img
                    src={src}
                    alt=""
                    loading="lazy"
                    className="max-h-64 max-w-full rounded object-contain"
                  />
                </DsButton>
              ))}
              {audioAttachments.map((item) => (
                <div
                  key={item.src}
                  className="flex w-full max-w-[320px] justify-center"
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <audio
                    className="anki-audio w-full"
                    controls
                    preload="metadata"
                    src={item.src}
                    data-sound-file={item.name}
                  />
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex min-w-0 flex-col items-center gap-3">
          {latexHtml ? (
            <div
              className={cn(
                'whitespace-pre-wrap break-words leading-[1.7] tracking-[-0.01em] text-foreground',
                compact ? 'text-sm font-normal' : 'max-w-[60ch] text-[18px] font-normal sm:text-[20px]',
              )}
              // 安全：非公式文本已 HTML 转义，公式为 KaTeX（trust:false）输出
              dangerouslySetInnerHTML={{ __html: latexHtml }}
            />
          ) : (
            <div
              className={cn(
                'whitespace-pre-wrap break-words leading-[1.7] tracking-[-0.01em] text-foreground',
                compact ? 'text-sm font-normal' : 'max-w-[60ch] text-[18px] font-normal sm:text-[20px]',
              )}
            >
              {plainText || emptyText}
            </div>
          )}
          {imageSrcs.map((src) => (
            <DsButton
              key={src}
              type="button"
              variant="ghost"
              data-anki-zoom-trigger="true"
              aria-label={tCommon('imageViewer.zoomIn', { defaultValue: 'Zoom in' })}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                handleOpenLightbox({ src, alt: '' });
              }}
              className="h-auto max-w-full cursor-zoom-in rounded border-0 bg-transparent p-0 hover:bg-transparent"
            >
              <img
                src={src}
                alt=""
                loading="lazy"
                className="max-h-64 max-w-full rounded object-contain"
              />
            </DsButton>
          ))}
          {audioAttachments.map((item) => (
            <div
              key={item.src}
              className="flex w-full max-w-[320px] justify-center"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <audio
                className="anki-audio w-full"
                controls
                preload="metadata"
                src={item.src}
                data-sound-file={item.name}
              />
            </div>
          ))}
        </div>
      )}
      {showRenderIssues ? <RenderIssueNotice issues={issues} /> : null}
      {lightboxImage ? (
        <CardImageLightbox image={lightboxImage} onClose={handleCloseLightbox} />
      ) : null}
    </div>
  );
};

export default AnkiTemplateCardFace;
