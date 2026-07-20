import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnkiTemplateCardFace } from '@/components/anki/AnkiTemplateCardFace';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/utils/cn';
import { ClozeText } from './AnkiClozeText';
import type { AnkiCard, CustomAnkiTemplate } from '@/types';
import './chat-anki-cards.css';

interface RenderedAnkiCardProps {
  card: AnkiCard;
  template: CustomAnkiTemplate;
  flippable?: boolean;
  compact?: boolean;
  className?: string;
  onClick?: (event: React.MouseEvent) => void;
}

/** 翻面动画时序：150ms 转出 + 200ms 转入（与 chat-anki-cards.css 保持一致） */
const FLIP_OUT_MS = 150;
const FLIP_IN_MS = 200;

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
  const [flipPhase, setFlipPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const flipTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  useEffect(() => {
    const timers = flipTimersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
    };
  }, []);

  const flip = useCallback(() => {
    if (!flippable) return;
    if (prefersReducedMotion) {
      setShowBack((previous) => !previous);
      return;
    }
    // 动画进行中忽略重复触发，避免中途换面造成闪烁
    if (flipPhase !== 'idle') return;
    setFlipPhase('out');
    flipTimersRef.current.push(
      setTimeout(() => {
        setShowBack((previous) => !previous);
        setFlipPhase('in');
        flipTimersRef.current.push(
          setTimeout(() => setFlipPhase('idle'), FLIP_IN_MS),
        );
      }, FLIP_OUT_MS),
    );
  }, [flippable, prefersReducedMotion, flipPhase]);

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
      className={cn(
        'canki-flip-wrap relative overflow-hidden rounded-lg border bg-card transition-colors',
        flippable && 'cursor-pointer hover:border-primary/35 active:bg-muted/30',
        className,
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={flippable ? 'button' : undefined}
      tabIndex={flippable ? 0 : undefined}
      aria-label={flippable
        ? t(showBack ? 'chatBlock.flipToFront' : 'chatBlock.flipToBack')
        : undefined}
    >
      <div
        className={cn(
          'canki-flip-face',
          flipPhase === 'out' && 'canki-flip-out',
          flipPhase === 'in' && 'canki-flip-in',
        )}
      >
        <AnkiTemplateCardFace
          card={card}
          template={template}
          side={side}
          compact={compact}
          className="min-h-[7rem]"
          emptyText={t('chatV2.noContent')}
        />
      </div>
      {flippable ? (
        <div className="pointer-events-none absolute bottom-1 right-2 select-none text-[10px] text-muted-foreground/60 transition-opacity">
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
      <div className="truncate text-sm font-medium">
        <ClozeText text={front} revealed={false} />
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        <ClozeText text={back} revealed />
      </div>
    </div>
  );
};
