import React from 'react';
import { cn } from '@/utils/cn';
import { GenerativeUIRenderer } from '../GenerativeUIRenderer';
import type { GenerativeUIAction, GenerativeActionDefinition, GenerativeUIIntent } from '../types';

export interface GenerativeUIPanelProps {
  intent: GenerativeUIIntent | string | null;
  isStreaming?: boolean;
  title?: string;
  className?: string;
  onAction?: (action: GenerativeUIAction) => void;
  actionHandlers?: Record<string, GenerativeActionDefinition>;
  emptyLabel?: string;
}

/**
 * 可嵌入 Chat 侧栏 / Copilot 区域的生成式 UI 面板壳
 */
export function GenerativeUIPanel({
  intent,
  isStreaming = false,
  title,
  className,
  onAction,
  actionHandlers,
  emptyLabel = '暂无 AI 界面内容',
}: GenerativeUIPanelProps) {
  if (!intent) {
    return (
      <div
        className={cn(
          'rounded-lg border border-dashed border-border/60 p-4 text-sm text-muted-foreground',
          className,
        )}
        data-generative-ui-panel-empty
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className={cn('generative-ui-panel space-y-2', className)} data-generative-ui-panel>
      {title ? <h4 className="text-sm font-medium px-0.5">{title}</h4> : null}
      <GenerativeUIRenderer
        intent={intent}
        isStreaming={isStreaming}
        onAction={onAction}
        actionHandlers={actionHandlers}
      />
    </div>
  );
}
