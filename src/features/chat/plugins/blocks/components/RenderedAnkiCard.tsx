import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnkiTemplateCardFace } from '@/components/anki/AnkiTemplateCardFace';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';

interface RenderedAnkiCardProps {
  card: AnkiCard;
  template: CustomAnkiTemplate;
  flippable?: boolean;
  compact?: boolean;
  className?: string;
  onClick?: (event: React.MouseEvent) => void;
}

export const RenderedAnkiCard: React.FC<RenderedAnkiCardProps> = ({
  card,
  template,
  flippable = true,
  compact = true,
  className,
  onClick,
}) => {
  const { t } = useTranslation('anki');
  const [showBack, setShowBack] = useState(false);

  const flip = useCallback(() => {
    if (flippable) setShowBack((previous) => !previous);
  }, [flippable]);

  const handleClick = useCallback((event: React.MouseEvent) => {
    if (flippable) {
      event.stopPropagation();
      flip();
    }
    onClick?.(event);
  }, [flip, flippable, onClick]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!flippable || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
    flip();
  }, [flip, flippable]);

  const side = showBack ? 'back' : 'front';
  return (
    <div
      className={[
        'relative overflow-hidden rounded-lg border bg-card transition-colors',
        flippable ? 'cursor-pointer' : '',
        className,
      ].filter(Boolean).join(' ')}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={flippable ? 'button' : undefined}
      tabIndex={flippable ? 0 : undefined}
      aria-label={flippable
        ? (showBack ? t('chatV2.front') : t('chatV2.back'))
        : undefined}
    >
      <AnkiTemplateCardFace
        card={card}
        template={template}
        side={side}
        compact={compact}
        className="min-h-[7rem]"
        emptyText={t('chatV2.noContent')}
      />
      {flippable ? (
        <div className="pointer-events-none absolute bottom-1 right-2 select-none text-[10px] text-muted-foreground/60">
          {showBack ? t('chatV2.front') : t('chatV2.back')} ↩
        </div>
      ) : null}
    </div>
  );
};

export const PlainAnkiCard: React.FC<{
  card: AnkiCard;
  className?: string;
  onClick?: (event: React.MouseEvent) => void;
}> = ({ card, className, onClick }) => {
  const front = card.front ?? card.fields?.Front ?? '';
  const back = card.back ?? card.fields?.Back ?? '';
  return (
    <div className={className} onClick={onClick}>
      <div className="truncate text-sm font-medium">{front}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">{back}</div>
    </div>
  );
};
