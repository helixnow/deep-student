import type { StoreApi } from 'zustand';

import type { ChatStore } from '../../core/types';
import { generateId } from '../../core/store/createChatStore';

type BlockingInteraction = NonNullable<ChatStore['pendingBlockingInteraction']>;

export interface PlaygroundAskUserResponse {
  selectedTexts: string[];
  selectedIndices: number[];
  customText: string | null;
  source: 'user_click' | 'custom_input' | 'mixed';
}

export interface PlaygroundToolApprovalResponse {
  approved: boolean;
  remember: boolean;
  reason?: string;
}

export type PlaygroundAskUserInteraction = Extract<BlockingInteraction, { kind: 'ask_user' }> & {
  respond?: (response: PlaygroundAskUserResponse) => Promise<void>;
};

export type PlaygroundToolApprovalInteraction = Extract<BlockingInteraction, { kind: 'tool_approval' }> & {
  respond?: (response: PlaygroundToolApprovalResponse) => Promise<void>;
};

export type PlaygroundToolLimitInteraction = Extract<BlockingInteraction, { kind: 'tool_limit' }>;

export type PlaygroundBlockingInteraction =
  | PlaygroundAskUserInteraction
  | PlaygroundToolApprovalInteraction
  | PlaygroundToolLimitInteraction;

export interface PlaygroundAskUserTemplate {
  question: string;
  options: Array<string | { label?: string; value?: string; text?: string }>;
  multiple?: boolean;
  allowCustom?: boolean;
  timeoutSeconds?: number | null;
  context?: string;
}

export interface PlaygroundToolApprovalTemplate {
  toolName: string;
  arguments: Record<string, unknown>;
  sensitivity: 'low' | 'medium' | 'high';
  description?: string;
  timeoutSeconds?: number;
}

export interface PlaygroundToolLimitTemplate {
  content: string;
}

function normalizeAskUserOptions(
  options: PlaygroundAskUserTemplate['options'],
): string[] {
  return options
    .map((option) => {
      if (typeof option === 'string') return option;
      if (!option || typeof option !== 'object') return String(option ?? '');
      if (typeof option.label === 'string') return option.label;
      if (typeof option.value === 'string') return option.value;
      if (typeof option.text === 'string') return option.text;
      try {
        return JSON.stringify(option);
      } catch {
        return String(option);
      }
    })
    .filter((option) => option.length > 0);
}

function clearMatchingBlockingInteraction(
  store: StoreApi<ChatStore>,
  kind: BlockingInteraction['kind'],
  blockId: string,
) {
  const current = store.getState().pendingBlockingInteraction;
  if (!current || current.kind !== kind) return;
  if ('blockId' in current && current.blockId !== blockId) return;
  store.getState().clearBlockingInteraction();
}

export function createPlaygroundAskUserInteraction(
  store: StoreApi<ChatStore>,
  blockId: string,
  template: PlaygroundAskUserTemplate,
): PlaygroundAskUserInteraction {
  const toolCallId = generateId('ask');

  return {
    kind: 'ask_user',
    blockId,
    toolCallId,
    question: template.question,
    options: normalizeAskUserOptions(template.options),
    multiple: template.multiple ?? false,
    allowCustom: template.allowCustom ?? true,
    timeoutSeconds: template.timeoutSeconds ?? null,
    context: template.context,
    respond: async (response) => {
      store.getState().setBlockResult(blockId, {
        selected: response.selectedTexts,
        selected_indices: response.selectedIndices,
        custom_text: response.customText ?? null,
        source: response.source,
      });
      clearMatchingBlockingInteraction(store, 'ask_user', blockId);
    },
  };
}

export function createPlaygroundToolApprovalInteraction(
  store: StoreApi<ChatStore>,
  blockId: string,
  template: PlaygroundToolApprovalTemplate,
): PlaygroundToolApprovalInteraction {
  const toolCallId = generateId('approval');

  return {
    kind: 'tool_approval',
    toolCallId,
    toolName: template.toolName,
    arguments: template.arguments,
    sensitivity: template.sensitivity,
    description: template.description ?? '',
    timeoutSeconds: template.timeoutSeconds ?? 45,
    respond: async ({ approved, remember, reason }) => {
      store.getState().updateBlock(blockId, {
        status: approved ? 'success' : 'error',
        error: approved ? undefined : reason ?? 'user_rejected',
        toolOutput: {
          approved,
          remember,
          reason: reason ?? null,
        },
        endedAt: Date.now(),
      });

      const current = store.getState().pendingBlockingInteraction;
      if (!current || current.kind !== 'tool_approval' || current.toolCallId !== toolCallId) {
        return;
      }

      store.getState().setBlockingInteraction({
        ...current,
        resolvedStatus: approved ? 'approved' : reason === 'timeout' ? 'timeout' : 'rejected',
        resolvedReason: reason,
      });

      window.setTimeout(() => {
        const latest = store.getState().pendingBlockingInteraction;
        if (latest && latest.kind === 'tool_approval' && latest.toolCallId === toolCallId) {
          store.getState().clearBlockingInteraction();
        }
      }, 900);
    },
  };
}

export function createPlaygroundToolLimitInteraction(
  store: StoreApi<ChatStore>,
  blockId: string,
  template: PlaygroundToolLimitTemplate,
): PlaygroundToolLimitInteraction {
  return {
    kind: 'tool_limit',
    blockId,
    content: template.content,
    onContinue: async () => {
      store.getState().updateBlockStatus(blockId, 'success');
      clearMatchingBlockingInteraction(store, 'tool_limit', blockId);
    },
  };
}
