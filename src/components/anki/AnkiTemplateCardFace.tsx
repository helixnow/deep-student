import React, { useMemo } from 'react';
import { ShadowDomPreview } from '@/components/ShadowDomPreview';
import { TemplateRenderService } from '@/services/templateRenderService';
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
}

function defaultFaceText(card: AnkiCard, side: AnkiCardFace): string {
  if (side === 'back') {
    return card.back || card.fields?.Back || card.text || '';
  }
  return card.front || card.fields?.Front || card.text || '';
}

export const AnkiTemplateCardFace: React.FC<AnkiTemplateCardFaceProps> = ({
  card,
  template,
  side,
  compact = true,
  className,
  fallbackText,
  emptyText = '',
}) => {
  const rendered = useMemo(() => {
    if (!template) return null;
    try {
      return TemplateRenderService.renderCard(card, template);
    } catch (error: unknown) {
      console.error('[AnkiTemplateCardFace] Render failed:', error);
      return null;
    }
  }, [card, template]);

  const htmlContent = rendered?.[side]?.trim() || '';
  const plainText = fallbackText ?? defaultFaceText(card, side);

  return (
    <div
      className={className}
      data-anki-card-face={side}
      data-render-mode={htmlContent ? 'template' : 'plain'}
    >
      {htmlContent && template ? (
        <ShadowDomPreview
          htmlContent={htmlContent}
          cssContent={template.css_style || ''}
          compact={compact}
          fidelity="anki"
        />
      ) : (
        <div className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">
          {plainText || emptyText}
        </div>
      )}
    </div>
  );
};

export default AnkiTemplateCardFace;
