/**
 * 确定性 copy-block — 把当前 Generative UI 中单个 block 的 JSON 复制到剪贴板。
 * low risk，无副作用，不走 HITL。
 */
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import type { GenerativeActionDefinition, GenerativeBlockIntent, GenerativeUIIntent } from '../types';

export const COPY_BLOCK_ACTION_ID = 'copy-block' as const;

export interface CopyBlockActionLabels {
  copyBlock: string;
}

export interface CopyBlockActionOptions {
  blockId?: string;
  blockIndex?: number;
}

function resolveCopyBlock(
  intent: GenerativeUIIntent,
  options?: CopyBlockActionOptions,
): GenerativeBlockIntent | undefined {
  const blocks = intent.blocks ?? [];
  if (options?.blockId) {
    const byId = blocks.find((block) => block.id === options.blockId);
    if (byId) return byId;
  }
  if (typeof options?.blockIndex === 'number') {
    const byIndex = blocks[options.blockIndex];
    if (byIndex) return byIndex;
  }
  return blocks[0];
}

export function serializeGenerativeUIBlock(block: GenerativeBlockIntent): string {
  return JSON.stringify(block, null, 2);
}

export function createCopyBlockActionHandlers(
  intent: GenerativeUIIntent,
  labels: CopyBlockActionLabels,
  options?: CopyBlockActionOptions,
): Record<string, GenerativeActionDefinition> {
  return {
    [COPY_BLOCK_ACTION_ID]: {
      id: COPY_BLOCK_ACTION_ID,
      label: labels.copyBlock,
      riskLevel: 'low',
      handler: async () => {
        const block = resolveCopyBlock(intent, options);
        if (!block) return;
        const text = serializeGenerativeUIBlock(block);
        if (!text) return;
        await copyTextToClipboard(text);
      },
    },
  };
}
