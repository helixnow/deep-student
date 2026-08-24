/**
 * Chat V2 — Generative UI 块渲染插件
 *
 * toolOutput.intent 携带结构化 UI 意图，由 GenerativeUIRenderer 渲染。
 */

import React from 'react';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  extractGenerativeUIIntent,
  GENERATIVE_UI_BLOCK_TYPE,
} from '@/features/generative-ui/bridge/chatBlockBridge';

function GenerativeUIBlockComponent({ block, isStreaming }: BlockComponentProps) {
  const extracted = extractGenerativeUIIntent(
    block.toolOutput,
    block.content,
    block.toolInput,
    block.id,
  );
  if (!extracted) {
    return (
      <div className="text-sm text-muted-foreground px-1" data-block-type={GENERATIVE_UI_BLOCK_TYPE}>
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

blockRegistry.register(GENERATIVE_UI_BLOCK_TYPE, {
  type: GENERATIVE_UI_BLOCK_TYPE,
  component: GenerativeUIBlockComponent,
  onAbort: 'keep-content',
});

export { GenerativeUIBlockComponent };
