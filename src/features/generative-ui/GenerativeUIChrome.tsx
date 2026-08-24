import React from 'react';
import { ArrowClockwise, Check, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { AiContentLabel } from '@/components/shared/AiContentLabel';
import { cn } from '@/utils/cn';
import type { GenerativeUIAction } from './types';

export interface GenerativeUIChromeProps {
  isStreaming?: boolean;
  onAction?: (action: GenerativeUIAction) => void;
  className?: string;
}

/** AI 生成标记 + Human-in-the-loop 操作栏 */
export function GenerativeUIChrome({ isStreaming, onAction, className }: GenerativeUIChromeProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2',
        className,
      )}
      data-generative-ui-chrome
    >
      <div className="flex items-center gap-1.5">
        <AiContentLabel variant="badge" showIcon />
        {isStreaming ? (
          <span className="text-xs text-muted-foreground">生成中…</span>
        ) : null}
      </div>
      {!isStreaming && onAction ? (
        <div className="flex items-center gap-1">
          <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAction({ type: 'accept' })}>
            <Check className="mr-1 h-3.5 w-3.5" aria-hidden />
            接受
          </DsButton>
          <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAction({ type: 'regenerate' })}>
            <ArrowClockwise className="mr-1 h-3.5 w-3.5" aria-hidden />
            重新生成
          </DsButton>
          <DsButton variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onAction({ type: 'dismiss' })}>
            <X className="mr-1 h-3.5 w-3.5" aria-hidden />
            忽略
          </DsButton>
        </div>
      ) : null}
    </div>
  );
}
