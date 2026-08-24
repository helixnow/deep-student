import React from 'react';
import { cn } from '@/utils/cn';
import type { TextBlockProps } from '../schema';

export function TextBlock({ heading, body, density }: TextBlockProps) {
  return (
    <div className={cn('min-w-0 space-y-2', density === 'compact' && 'space-y-1')}>
      {heading ? (
        <h4 className={cn('font-semibold', density === 'compact' ? 'text-sm' : 'text-base')}>
          {heading}
        </h4>
      ) : null}
      <p
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
