import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Check, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { AiContentLabel } from '@/components/shared/AiContentLabel';
import { cn } from '@/utils/cn';
import { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';
import type { GenerativeUIAction } from './types';

export interface GenerativeUIChromeProps {
  isStreaming?: boolean;
  onAction?: (action: GenerativeUIAction) => void;
  className?: string;
}

export function GenerativeUIChrome({ isStreaming, onAction, className }: GenerativeUIChromeProps) {
  const { t } = useTranslation('generativeUi');
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2',
        className,
      )}
      data-generative-ui-chrome
      data-reduced-motion={prefersReducedMotion ? 'true' : undefined}
      aria-busy={isStreaming || undefined}
    >
      <div className="flex items-center gap-1.5">
        <AiContentLabel variant="badge" showIcon />
        {isStreaming ? (
          <span
            className="generative-ui-stream-indicator"
            data-stream-indicator
            data-reduced-motion={prefersReducedMotion ? 'true' : undefined}
            aria-hidden
          >
            <span className="generative-ui-stream-dot" />
            <span className="generative-ui-stream-dot" />
            <span className="generative-ui-stream-dot" />
          </span>
        ) : null}
        <span
          aria-live="polite"
          aria-atomic="true"
          className={cn(isStreaming ? 'text-xs text-muted-foreground' : 'sr-only')}
        >
          {isStreaming ? t('chrome.streaming') : t('chrome.stream_done')}
        </span>
      </div>
      {!isStreaming && onAction ? (
        <div className="flex items-center gap-1">
          <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAction({ type: 'accept' })}>
            <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t('chrome.accept')}
          </DsButton>
          <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAction({ type: 'regenerate' })}>
            <ArrowClockwise className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t('chrome.regenerate')}
          </DsButton>
          <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAction({ type: 'dismiss' })}>
            <X className="mr-1 h-3.5 w-3.5" aria-hidden />
            {t('chrome.dismiss')}
          </DsButton>
        </div>
      ) : null}
    </div>
  );
}
