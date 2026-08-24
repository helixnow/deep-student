import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import type { TextBlockProps } from '../schema';

export function TextBlock({ heading, body, density }: TextBlockProps) {
  const { t } = useTranslation('generativeUi');
  const headingId = React.useId();
  return (
    <div
      className={cn('min-w-0 space-y-2', density === 'compact' && 'space-y-1')}
      role="region"
      aria-labelledby={heading ? headingId : undefined}
      aria-label={heading ? undefined : t('a11y.text_label')}
    >
      {heading ? (
        <h4
          id={headingId}
          dir="auto"
          className={cn('font-semibold', density === 'compact' ? 'text-sm' : 'text-base')}
        >
          {heading}
        </h4>
      ) : null}
      <p
        dir="auto"
        className={cn(
          'whitespace-pre-wrap text-muted-foreground',
          density === 'compact' ? 'text-xs leading-snug' : 'text-sm leading-relaxed',
        )}
      >
        {body}
      </p>
    </div>
  );
}
