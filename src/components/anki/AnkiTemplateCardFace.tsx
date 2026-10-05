import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';
import {
  TemplateRenderService,
  type DetailedCardRenderResult,
} from '@/services/templateRenderService';
import { applyClozeMarkup, extractClozeOrdinals, type TemplateRenderIssue } from '@/services/ankiTemplateEngine';
import { buildCardFaceCss, useCardFaceSurfaceColor, useDocumentDarkMode } from './utils/cardFaceStyles';
import { renderCardFaceLatexHtml, renderCardTemplateMath } from './utils/cardFaceLatex';
import {
  CARD_FACE_HELPER_SCRIPT,
  injectCardMedia,
  isInteractiveCardHtml,
  looksLikeHtml,
  soundNames,
  useCardMediaMap,
} from './utils/cardMedia';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import { cn } from '@/utils/cn';

export type AnkiCardFace = 'front' | 'back';

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
}) => {
  const darkMode = useDocumentDarkMode();
  const surfaceColor = useCardFaceSurfaceColor();
  const media = useCardMediaMap(card.images);

  const rendered = useMemo<DetailedCardRenderResult | null>(() => {
    if (!template) return null;
    // renderCardDetailed 内部结构化捕获所有异常，不会抛出；[sound:] 原样保留，下面换成 <audio>
    return TemplateRenderService.renderCardDetailed(card, template, {
      clozeOrdinal: resolveClozeOrdinal(card, template),
      soundStrategy: 'keep',
    });
  }, [card, template]);

  const faceResult = rendered?.[side] ?? null;
  const htmlContent = faceResult?.html?.trim() || '';
  const issues = faceResult?.issues ?? [];
  const plainText = fallbackText ?? defaultFaceText(card, side);
  const frontHtml = rendered?.front?.html ?? (template ? '' : defaultFaceText(card, 'front'));
  const previewHtml = useMemo(() => {
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
    return renderCardTemplateMath(injectCardMedia(html, media, { noAutoplay }));
  }, [htmlContent, template, plainText, card, side, media, frontHtml]);
  const frameInteractive = interactiveFrame && isInteractiveCardHtml(previewHtml);
  const frameHtml = frameInteractive ? `${previewHtml}${CARD_FACE_HELPER_SCRIPT}` : previewHtml;

  // fallback 视图：\( \)、\[ \]、$、$$ 公式经 KaTeX 渲染；无公式时保持纯文本零成本
  const latexHtml = useMemo(
    () => (plainText ? renderCardFaceLatexHtml(plainText) : null),
    [plainText],
  );
  const imageSrcs = useMemo(
    () => (card.images ?? [])
      .filter((image) => !/\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm|mp4)$/i.test(image.trim()))
      .map(resolveCardImageSrc)
      .filter((src): src is string => src != null),
    [card.images],
  );

  const stageMode = stageHeight != null && stageHeight > 0;
  const cssContent = useMemo(
    // 舞台 CSS（.card 铺满 + 纵向居中）见 CARD_FACE_STAGE_CSS：body 保持块级布局，
    // 模板「纸张」的 max-width + margin:0 auto 才按 Anki 语义取自然宽度。
    () => buildCardFaceCss(template?.css_style, { darkMode, surfaceColor, stage: stageMode }),
    [template?.css_style, darkMode, surfaceColor, stageMode],
  );

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
        />
      ) : (
        <div className="flex min-w-0 flex-col items-center gap-2">
          {latexHtml ? (
            <div
              className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed"
              // 安全：非公式文本已 HTML 转义，公式为 KaTeX（trust:false）输出
              dangerouslySetInnerHTML={{ __html: latexHtml }}
            />
          ) : (
            <div className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">
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
