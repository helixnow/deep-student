/**
 * Chat V2 — Generative UI 块渲染插件
 *
 * toolOutput.intent 携带结构化 UI 意图，由 GenerativeUIRenderer 渲染。
 */

import React from 'react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { extractGenerativeUIIntent } from '@/features/generative-ui/bridge/chatBlockBridge';

function GenerativeUIBlockComponent({ block, isStreaming }: BlockComponentProps) {
  const extracted = extractGenerativeUIIntent(block.toolOutput);
  if (!extracted) {
    return (
      <div className="text-sm text-muted-foreground px-1" data-block-type="generative_ui">
        无 UI 意图数据
      </div>
    );
  }

  return (
    <GenerativeUIRenderer
      intent={extracted.intent}
      isStreaming={isStreaming ?? extracted.isStreaming}
      showChrome={!isStreaming}
    />
  );
}

blockRegistry.register('generative_ui', {
  type: 'generative_ui',
  component: GenerativeUIBlockComponent,
  onAbort: 'keep-content',
});

export { GenerativeUIBlockComponent };
