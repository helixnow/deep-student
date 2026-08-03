import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';
import {
  TemplateRenderService,
  type DetailedCardRenderResult,
} from '@/services/templateRenderService';
import type { TemplateRenderIssue } from '@/services/ankiTemplateEngine';
import { buildCardFaceCss, useDocumentDarkMode } from './utils/cardFaceStyles';
import { renderCardFaceLatexHtml } from './utils/cardFaceLatex';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

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
  template: CustomAnkiTemplate,
): number | null {
  if ((template.note_type ?? '').trim().toLowerCase() !== 'cloze') return null;
  const raw = card.extra_fields?.AnkiCardOrd ?? card.fields?.AnkiCardOrd;
  const ord = typeof raw === 'string'
    ? Number.parseInt(raw.trim(), 10)
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
      className="mt-1 rounded border border-warning/50 bg-warning/10 px-2 py-1 text-[11px] leading-snug text-warning"
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
}) => {
  const darkMode = useDocumentDarkMode();

  const rendered = useMemo<DetailedCardRenderResult | null>(() => {
    if (!template) return null;
    // renderCardDetailed 内部结构化捕获所有异常，不会抛出
    return TemplateRenderService.renderCardDetailed(card, template, {
      clozeOrdinal: resolveClozeOrdinal(card, template),
    });
  }, [card, template]);

  const faceResult = rendered?.[side] ?? null;
  const htmlContent = faceResult?.html?.trim() || '';
  const issues = faceResult?.issues ?? [];
  const plainText = fallbackText ?? defaultFaceText(card, side);

  // fallback 视图：\( \)、\[ \]、$、$$ 公式经 KaTeX 渲染；无公式时保持纯文本零成本
  const latexHtml = useMemo(
    () => (plainText ? renderCardFaceLatexHtml(plainText) : null),
    [plainText],
  );
  const imageSrcs = useMemo(
    () => (card.images ?? [])
      .map(resolveCardImageSrc)
      .filter((src): src is string => src != null),
    [card.images],
  );

  const cssContent = useMemo(
    () => buildCardFaceCss(template?.css_style, { darkMode }),
    [template?.css_style, darkMode],
  );

  return (
    <div
      className={className}
      data-anki-card-face={side}
      data-render-mode={htmlContent ? 'template' : 'plain'}
    >
      {htmlContent && template ? (
        <ShadowDomPreview
          htmlContent={htmlContent}
          cssContent={cssContent}
          compact={compact}
          fidelity="anki"
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
