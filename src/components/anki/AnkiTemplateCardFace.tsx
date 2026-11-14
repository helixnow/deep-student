import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { vfsFileApi } from '@/api/vfsFileApi';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';
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
  injectCardMedia,
  isInteractiveCardHtml,
  looksLikeHtml,
  soundNames,
  useCardMediaMap,
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
}

function defaultFaceText(card: AnkiCard, side: AnkiCardFace): string {
  if (side === 'back') {
    return card.back || card.fields?.Back || card.text || '';
  }
  return card.front || card.fields?.Front || card.text || '';
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

/** 卡面图片地址解析：data:/blob:/http(s) 直接使用；本地绝对路径走 asset protocol。 */
function resolveCardImageSrc(image: string): string | null {
  const value = image.trim();
  if (!value) return null;
  if (/^(data:|blob:|https?:|asset:)/i.test(value)) return value;
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
}) => {
  const rawExtraFields = useMemo<Record<string, string> | null>(() => {
    const dynamicExtra = (card as AnkiCard & { extraFields?: Record<string, string> }).extraFields;
    return dynamicExtra ?? card.extra_fields ?? card.fields ?? null;
  }, [card]);
  const occlusionSpec = useMemo(() => parseOcclusionSpec(rawExtraFields), [rawExtraFields]);

  const darkMode = useDocumentDarkMode();
  const surfaceColor = useCardFaceSurfaceColor();
  const media = useCardMediaMap(occlusionSpec ? undefined : card.images);

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
  const faceHtml = useMemo(() => {
    if (occlusionSpec) return '';
    let html = '';
    if (htmlContent) {
      html = htmlContent;
    } else if (!template && extractClozeOrdinals(plainText).length > 0) {
      html = applyClozeMarkup(plainText, { side, ordinal: resolveClozeOrdinal(card) });
    } else if (!template && looksLikeHtml(plainText)) {
      // 外部 Anki 牌组的字段是 HTML：按 HTML 渲染，而不是当纯文本转义
      html = plainText;
    }
    if (!html) return '';
    // 背面不自动重放正面的音频（同 Anki：{{FrontSide}} 里的音频不自动播放）
    const noAutoplay = side === 'back' ? soundNames(frontHtml) : undefined;
    return injectCardMedia(html, media, { noAutoplay });
  }, [occlusionSpec, htmlContent, template, plainText, card, side, media, frontHtml]);
  // 卡面公式与聊天侧一致由 KaTeX 自带字体排版（htmlAndMathml + iframe 内 data: 字体），
  // 不依赖设备数学字体（#461）。样式首次下载期间先出纯 MathML，就绪后切换。
  const katexCss = useKatexSandboxCss(cardHtmlNeedsKatex(faceHtml));
  const previewHtml = useMemo(
    () => (faceHtml ? renderCardTemplateMath(faceHtml, katexCss ? 'htmlAndMathml' : 'mathml') : ''),
    [faceHtml, katexCss],
  );
  const frameInteractive = interactiveFrame && isInteractiveCardHtml(previewHtml);
  const frameHtml = frameInteractive ? `${previewHtml}${CARD_FACE_HELPER_SCRIPT}` : previewHtml;

  // fallback 视图：\( \)、\[ \]、$、$$ 公式经 KaTeX 渲染；无公式时保持纯文本零成本
  const latexHtml = useMemo(
    () => (!occlusionSpec && plainText ? renderCardFaceLatexHtml(plainText) : null),
    [occlusionSpec, plainText],
  );
  const imageSrcs = useMemo(
    () => (occlusionSpec ? [] : card.images ?? [])
      .filter((image) => !/\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm|mp4)$/i.test(image.trim()))
      .map(resolveCardImageSrc)
      .filter((src): src is string => src != null),
    [occlusionSpec, card.images],
  );

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
      className={cn(className, interactiveFrame && !frameInteractive && 'pointer-events-none')}
      data-anki-card-face={side}
      data-render-mode={htmlContent ? 'template' : previewHtml ? 'html' : 'plain'}
      data-interactive={frameInteractive ? 'true' : undefined}
    >
      {previewHtml ? (
        <ShadowDomPreview
          htmlContent={frameHtml}
          cssContent={cssContent}
          compact={compact}
          fidelity="anki"
          minHeight={stageMode ? stageHeight : undefined}
          onFrameClick={frameInteractive ? onFrameClick : undefined}
          onFrameWheel={frameInteractive ? onFrameWheel : undefined}
          trustedCss={katexCss ?? undefined}
        />
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
            <img
              key={src}
              src={src}
              alt=""
              loading="lazy"
              className="max-h-64 max-w-full rounded object-contain"
            />
          ))}
        </div>
      )}
      {showRenderIssues ? <RenderIssueNotice issues={issues} /> : null}
    </div>
  );
};

export default AnkiTemplateCardFace;
