import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: vi.fn(),
}));

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        if (opts && typeof opts.defaultValue === 'string' && key === '__missing__') {
          return opts.defaultValue;
        }
        return key;
      },
    }),
  };
});

import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { createStreamingBlockSaver } from '../core/middleware/autoSave';
import { skillRegistry, subscribeToSkillRegistry } from '../skills/registry';
import { executeUpsertStreamingBlock } from '../adapters/tauri/sessionCommands';
import type { TauriAdapterHost } from '../adapters/tauri/adapterHost';
import { createChatStore } from '../core/store/createChatStore';
import type { LoadSessionResponseType } from '../core/types';
import { BlockingApprovalBar } from '../components/input-bar/BlockingApprovalBar';
import { MessageActions } from '../components/message/MessageActions';
import { MessageInlineEdit } from '../components/message/MessageInlineEdit';
import {
  clearPendingBranchContinuationsForTest,
  consumePendingBranchContinuation,
  setPendingBranchContinuation,
} from '../navigation/pendingBranchContinuation';

describe('Track R2-A chat fixes', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    clearPendingBranchContinuationsForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  describe('S4-01 reload settled state and stale upsert guards', () => {
    it('cancels throttled streaming block saves when cancelBlock(blockId) is called', () => {
      vi.useFakeTimers();
      const saver = createStreamingBlockSaver();
      const saveSpy = vi.fn().mockResolvedValue(undefined);
      const unregister = saver.registerSaveCallback('sess_cancel', saveSpy);

      saver.scheduleBlockSave('blk_done', 'msg_1', 'content', 'partial text', 'sess_cancel');
      saver.cancelBlock?.('blk_done');

      act(() => {
        vi.advanceTimersByTime(6000);
      });

      expect(saveSpy).not.toHaveBeenCalled();
      unregister();
    });

    it('skips chat_v2_upsert_streaming_block when block is already settled or session is no longer streaming', async () => {
      const store = createChatStore('sess_guard');
      store.setState((prev) => {
        const blocks = new Map(prev.blocks);
        blocks.set('blk_settled', {
          id: 'blk_settled',
          messageId: 'msg_1',
          type: 'content',
          content: 'final answer',
          status: 'success',
          order: 0,
        });
        blocks.set('blk_running', {
          id: 'blk_running',
          messageId: 'msg_1',
          type: 'content',
          content: 'partial',
          status: 'running',
          order: 1,
        });
        return {
          ...prev,
          sessionStatus: 'streaming',
          blocks,
        };
      });

      const host = {
        sessionId: 'sess_guard',
        getCurrentState: () => store.getState(),
      } as unknown as TauriAdapterHost;

      await executeUpsertStreamingBlock(host, 'blk_settled', 'msg_1', 'content', 'stale partial');
      expect(invokeMock).not.toHaveBeenCalled();

      store.setState({ sessionStatus: 'idle' });
      await executeUpsertStreamingBlock(host, 'blk_running', 'msg_1', 'content', 'stale partial');
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('settles stale thinking block with status=success, aborted=false when followed by non-empty content block', () => {
      const store = createChatStore('sess_restore_ok');
      const now = Date.now();
      const response: LoadSessionResponseType = {
        session: {
          id: 'sess_restore_ok',
          title: 'Completed Turn',
          mode: 'chat',
          createdAt: now,
          updatedAt: now,
        },
        messages: [
          {
            id: 'msg_user_1',
            sessionId: 'sess_restore_ok',
            role: 'user',
            blockIds: ['blk_u1'],
            timestamp: now,
          },
          {
            id: 'msg_asst_1',
            sessionId: 'sess_restore_ok',
            role: 'assistant',
            blockIds: ['blk_think_1', 'blk_content_1'],
            timestamp: now + 10,
          },
        ],
        blocks: [
          {
            id: 'blk_u1',
            messageId: 'msg_user_1',
            type: 'content',
            content: 'Hello',
            status: 'success',
            order: 0,
          },
          {
            id: 'blk_think_1',
            messageId: 'msg_asst_1',
            type: 'thinking',
            content: 'Let me think carefully',
            status: 'running',
            order: 0,
          },
          {
            id: 'blk_content_1',
            messageId: 'msg_asst_1',
            type: 'content',
            content: 'Here is the formal final answer.',
            status: 'success',
            order: 1,
          },
        ],
      };

      store.getState().restoreFromBackend(response);
      const restoredThinking = store.getState().blocks.get('blk_think_1');
      expect(restoredThinking?.status).toBe('success');
      expect(restoredThinking?.aborted).toBe(false);
    });

    it('marks stale running thinking block aborted=true when no subsequent non-empty content block exists', () => {
      const store = createChatStore('sess_restore_aborted');
      const now = Date.now();
      const response: LoadSessionResponseType = {
        session: {
          id: 'sess_restore_aborted',
          title: 'Interrupted Turn',
          mode: 'chat',
          createdAt: now,
          updatedAt: now,
        },
        messages: [
          {
            id: 'msg_asst_stop',
            sessionId: 'sess_restore_aborted',
            role: 'assistant',
            blockIds: ['blk_think_only'],
            timestamp: now,
          },
        ],
        blocks: [
          {
            id: 'blk_think_only',
            messageId: 'msg_asst_stop',
            type: 'thinking',
            content: 'Partial thinking...',
            status: 'running',
            order: 0,
          },
        ],
      };

      store.getState().restoreFromBackend(response);
      const restoredThinking = store.getState().blocks.get('blk_think_only');
      expect(restoredThinking?.status).toBe('success');
      expect(restoredThinking?.aborted).toBe(true);
    });
  });

  describe('S4-06 skill_trust_request approval UX', () => {
    it('notifies skill registry subscribers when markSkillsLoaded completes', () => {
      skillRegistry.reset();
      expect(skillRegistry.isSkillsLoaded()).toBe(false);
      const listener = vi.fn();
      const unsub = subscribeToSkillRegistry(listener);
      skillRegistry.markSkillsLoaded();
      expect(skillRegistry.isSkillsLoaded()).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });
    it('renders explicit approve & trust / reject buttons for builtin-skill_trust_request', async () => {
      invokeMock.mockResolvedValue(undefined);
      render(
        <BlockingApprovalBar
          sessionId="sess_skill_trust"
          interaction={{
            kind: 'tool_approval',
            toolCallId: 'call_trust_1',
            toolName: 'builtin-skill_trust_request',
            arguments: JSON.stringify({
              skillId: 'demo-skill',
              skillPath: '/Users/test/.deepstudent/skills/demo-skill',
            }),
            sensitivity: 'high',
            description: 'Request trust for demo-skill',
            timeoutSeconds: 60,
          }}
        />,
      );

      const approveBtn = screen.getByTestId('skill-trust-approve-btn');
      const rejectBtn = screen.getByTestId('skill-trust-reject-btn');
      expect(approveBtn).toHaveTextContent('approval.skillTrustApprove');
      expect(rejectBtn).toHaveTextContent('approval.skillTrustReject');

      fireEvent.click(approveBtn);
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          'chat_v2_tool_approval_respond',
          expect.objectContaining({
            sessionId: 'sess_skill_trust',
            toolCallId: 'call_trust_1',
            toolName: 'builtin-skill_trust_request',
            approved: true,
          }),
        );
      });
    });
  });

  describe('S4-02 regenerate action and branching confirmations', () => {
    it('renders visible regenerate button on desktop latest assistant message and compact mobile', async () => {
      const kernel = new UiKernel(memoryRegistryAdapters());
      const onRetry = vi.fn().mockResolvedValue(undefined);

      const { rerender } = render(
        <UiKernelProvider kernel={kernel}>
          <MessageActions
            messageId="msg_a1"
            role="assistant"
            content="Assistant response"
            sessionId="sess_regen"
            canEdit={false}
            canDelete={false}
            alwaysExpanded={true}
            onCopy={async () => {}}
            onRetry={onRetry}
          />
        </UiKernelProvider>,
      );

      const desktopRegenBtn = screen.getByTestId('message-regenerate-button');
      expect(desktopRegenBtn).toHaveAttribute('title', 'messageItem.actions.regenerate');
      fireEvent.click(desktopRegenBtn);
      await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));

      rerender(
        <UiKernelProvider kernel={kernel}>
          <MessageActions
            messageId="msg_a1"
            role="assistant"
            content="Assistant response"
            sessionId="sess_regen"
            canEdit={false}
            canDelete={false}
            compactMobile={true}
            onCopy={async () => {}}
            onRetry={onRetry}
          />
        </UiKernelProvider>,
      );

      const mobileRegenBtn = screen.getByTestId('message-regenerate-button');
      expect(mobileRegenBtn).toHaveAttribute('aria-label', 'messageItem.actions.regenerate');
      await kernel.dispose();
    });

    it('renders branch choice alongside overwrite confirm in MessageInlineEdit', () => {
      const onBranchAndConfirm = vi.fn();
      const onConfirm = vi.fn();
      const onCancel = vi.fn();

      render(
        <MessageInlineEdit
          value="Edited question"
          onChange={vi.fn()}
          onConfirm={vi.fn()}
          onCancel={onCancel}
          confirmPrompt={{
            count: 2,
            onConfirm,
            onBranchAndConfirm,
            onCancel,
          }}
        />,
      );

      const branchBtn = screen.getByTestId('edit-downstream-branch-button');
      expect(branchBtn).toHaveTextContent('chatV2:messageItem.editConfirm.branchAndSend');
      fireEvent.click(branchBtn);
      expect(onBranchAndConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('stores and consumes one-shot pending branch continuations', () => {
      setPendingBranchContinuation('sess_branch_99', { type: 'regenerate_last' });
      expect(consumePendingBranchContinuation('sess_branch_99')).toEqual({ type: 'regenerate_last' });
      expect(consumePendingBranchContinuation('sess_branch_99')).toBeNull();
    });
  });
});
