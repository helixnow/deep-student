import React, { useMemo } from 'react';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';
import {
  TemplateRenderService,
  type DetailedCardRenderResult,
} from '@/services/templateRenderService';
import type { TemplateRenderIssue } from '@/services/ankiTemplateEngine';
import { buildCardFaceCss, useDocumentDarkMode } from './utils/cardFaceStyles';
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

const RenderIssueNotice: React.FC<{ issues: TemplateRenderIssue[] }> = ({ issues }) => {
  if (issues.length === 0) return null;
  const primary = issues[0];
  const extra = issues.length - 1;
  return (
    <div
      data-anki-render-issues={issues.length}
      className="mt-1 rounded border border-amber-400/50 bg-amber-50/80 px-2 py-1 text-[11px] leading-snug text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
    >
      模板渲染问题：{primary.message}
      {extra > 0 ? `（另有 ${extra} 个问题）` : ''}
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
    return TemplateRenderService.renderCardDetailed(card, template);
  }, [card, template]);

  const faceResult = rendered?.[side] ?? null;
  const htmlContent = faceResult?.html?.trim() || '';
  const issues = faceResult?.issues ?? [];
  const plainText = fallbackText ?? defaultFaceText(card, side);

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
        <div className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">
          {plainText || emptyText}
        </div>
      )}
      {showRenderIssues ? <RenderIssueNotice issues={issues} /> : null}
    </div>
  );
};

export default AnkiTemplateCardFace;
