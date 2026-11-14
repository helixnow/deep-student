import '@testing-library/jest-dom/vitest';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';
import {
  InputBarUI,
  createPastedTextPill,
  expandInputWithPills,
  globalSessionDraftLru,
  shouldCollapsePasteAsPill,
  shouldShowFloatingPreemptControl,
} from '../InputBarUI';
import { useInputBarV2 } from '../useInputBarV2';
import { createDefaultPanelStates } from '../../../core/types/common';
import type { ContextWindowUsage } from '../contextWindowUsage';

const { showGlobalNotificationMock } = vi.hoisted(() => ({
  showGlobalNotificationMock: vi.fn(),
}));

vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: showGlobalNotificationMock,
}));

vi.mock('@/features/chat/readiness/readinessGate', () => ({
  resolveChatReadiness: vi.fn(async () => ({ ok: true })),
  triggerOpenSettingsModels: vi.fn(),
}));

vi.mock('@/hooks/usePdfProcessingProgress', () => ({
  usePdfProcessingProgress: vi.fn(),
}));

vi.mock('@/hooks/useTauriDragAndDrop', () => ({
  useTauriDragAndDrop: () => ({
    isDragging: false,
    dropZoneProps: {},
  }),
}));

vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({
    isMobile: false,
    isFullscreenContent: false,
  }),
}));

function buildUsage(usedTokens: number, limitTokens = 100_000): ContextWindowUsage {
  const usedPercent = Math.round((usedTokens / limitTokens) * 100);
  return {
    usedTokens,
    remainingTokens: Math.max(0, limitTokens - usedTokens),
    limitTokens,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    usedLabel: `${Math.round(usedTokens / 1000)}k`,
    remainingLabel: `${Math.round((limitTokens - usedTokens) / 1000)}k`,
    source: 'api',
  };
}

function renderInputBar(props: Partial<React.ComponentProps<typeof InputBarUI>> = {}) {
  return render(
    <InputBarUI
      inputValue=""
      canSend={true}
      canAbort={true}
      isStreaming={false}
      attachments={[]}
      panelStates={createDefaultPanelStates()}
      onInputChange={vi.fn()}
      onSend={vi.fn()}
      onAbort={vi.fn()}
      onAddAttachment={vi.fn()}
      onUpdateAttachment={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onClearAttachments={vi.fn()}
      onSetPanelState={vi.fn()}
      placeholder="输入消息"
      {...props}
    />,
  );
}

describe('InputBar Last-Mile Wiring (Lane 1)', () => {
  beforeEach(() => {
    globalSessionDraftLru.clear();
    showGlobalNotificationMock.mockClear();
  });

  describe('1. Large Paste Pill (>1000 chars or >20 lines)', () => {
    it('evaluates helper predicates and pill expansion accurately', () => {
      expect(shouldCollapsePasteAsPill('short text')).toBe(false);
      expect(shouldCollapsePasteAsPill('a'.repeat(1000))).toBe(false);
      expect(shouldCollapsePasteAsPill('a'.repeat(1001))).toBe(true);

      const twentyLines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n');
      const twentyOneLines = Array.from({ length: 21 }, (_, i) => `L${i + 1}`).join('\n');
      expect(shouldCollapsePasteAsPill(twentyLines)).toBe(false);
      expect(shouldCollapsePasteAsPill(twentyOneLines)).toBe(true);

      const pill = createPastedTextPill('block-alpha');
      expect(expandInputWithPills('请帮我分析', [pill])).toBe('block-alpha\n\n请帮我分析');
      expect(expandInputWithPills('', [pill])).toBe('block-alpha');
    });

    it('collapses >1000 chars and >20 lines pastes into pills, supports expand and remove', () => {
      const onInputChange = vi.fn();
      renderInputBar({
        sessionId: 'sess-paste-1',
        inputValue: '前缀说明',
        onInputChange,
      });

      const textarea = screen.getByTestId('input-bar-v2-textarea');
      const longCharsText = 'X'.repeat(1205);
      const pasteEvent1 = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent1, 'clipboardData', {
        value: {
          files: [],
          getData: (type: string) => (type === 'text/plain' ? longCharsText : ''),
        },
      });

      act(() => {
        textarea.dispatchEvent(pasteEvent1);
      });
      expect(pasteEvent1.defaultPrevented).toBe(true);

      const pillsBar = screen.getByTestId('large-paste-pills-bar');
      expect(pillsBar).toBeInTheDocument();
      expect(pillsBar).toHaveTextContent('1205');

      // Paste >20 lines text as second pill
      const multiLineText = Array.from({ length: 24 }, (_, idx) => `line_${idx + 1}`).join('\n');
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          getData: (type: string) => (type === 'text/plain' ? multiLineText : ''),
        },
      });

      expect(pillsBar).toHaveTextContent('24 行');

      // Click expand on the first pill -> merges content back into input and removes that pill
      const expandButtons = within(pillsBar).getAllByRole('button', { name: '展开' });
      expect(expandButtons).toHaveLength(2);
      fireEvent.click(expandButtons[0]);

      expect(onInputChange).toHaveBeenCalledWith(`前缀说明\n${longCharsText}`);
      expect(within(screen.getByTestId('large-paste-pills-bar')).getAllByRole('button', { name: '展开' })).toHaveLength(1);

      // Click remove (×) on the remaining pill -> removes the bar completely
      const removeButton = within(screen.getByTestId('large-paste-pills-bar')).getByText('×');
      fireEvent.click(removeButton);
      expect(screen.queryByTestId('large-paste-pills-bar')).not.toBeInTheDocument();
    });

    it('allows sending when inputValue is empty if pastedPills exist, expanding and clearing pills before onSend', () => {
      const callSequence: string[] = [];
      const onInputChange = vi.fn((val: string) => {
        callSequence.push(`input:${val.length}`);
      });
      const onSend = vi.fn(() => {
        callSequence.push('send');
      });

      renderInputBar({
        sessionId: 'sess-paste-send',
        inputValue: '',
        canSend: false,
        onInputChange,
        onSend,
      });

      expect(screen.getByTestId('btn-send')).toBeDisabled();

      const textarea = screen.getByTestId('input-bar-v2-textarea');
      const pastedPayload = 'Z'.repeat(1150);
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          getData: (type: string) => (type === 'text/plain' ? pastedPayload : ''),
        },
      });

      expect(screen.getByTestId('large-paste-pills-bar')).toBeInTheDocument();
      const sendBtn = screen.getByTestId('btn-send');
      expect(sendBtn).toBeEnabled();

      fireEvent.click(sendBtn);

      expect(onInputChange).toHaveBeenCalledWith(pastedPayload);
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(callSequence).toEqual([`input:${pastedPayload.length}`, 'send']);
      expect(screen.queryByTestId('large-paste-pills-bar')).not.toBeInTheDocument();
    });
  });

  describe('2. 16-Session LRU Draft Store (globalSessionDraftLru)', () => {
    it('automatically saves and restores text and pastedPills across session switches', () => {
      function StatefulHarness() {
        const [sessionId, setSessionId] = useState('session-alpha');
        const [textBySession, setTextBySession] = useState<Record<string, string>>({
          'session-alpha': '',
          'session-beta': '',
        });

        const currentInput = textBySession[sessionId] ?? '';

        return (
          <div>
            <button
              type="button"
              data-testid="switch-to-alpha"
              onClick={() => {
                // Simulate fresh store input cleared on switch before InputBarUI restores draft
                setTextBySession((prev) => ({ ...prev, 'session-alpha': '' }));
                setSessionId('session-alpha');
              }}
            >
              Alpha
            </button>
            <button
              type="button"
              data-testid="switch-to-beta"
              onClick={() => {
                setTextBySession((prev) => ({ ...prev, 'session-beta': '' }));
                setSessionId('session-beta');
              }}
            >
              Beta
            </button>
            <InputBarUI
              sessionId={sessionId}
              inputValue={currentInput}
              canSend={true}
              canAbort={false}
              isStreaming={false}
              attachments={[]}
              panelStates={createDefaultPanelStates()}
              onInputChange={(next) =>
                setTextBySession((prev) => ({ ...prev, [sessionId]: next }))
              }
              onSend={vi.fn()}
              onAbort={vi.fn()}
              onAddAttachment={vi.fn()}
              onUpdateAttachment={vi.fn()}
              onRemoveAttachment={vi.fn()}
              onClearAttachments={vi.fn()}
              onSetPanelState={vi.fn()}
            />
          </div>
        );
      }

      render(<StatefulHarness />);

      const textarea = screen.getByTestId('input-bar-v2-textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Alpha 未发送草稿' } });

      const alphaLargePaste = Array.from({ length: 22 }, (_, i) => `alpha-line-${i}`).join('\n');
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          getData: (type: string) => (type === 'text/plain' ? alphaLargePaste : ''),
        },
      });

      expect(screen.getByTestId('large-paste-pills-bar')).toHaveTextContent('22 行');
      expect(globalSessionDraftLru.getDraft('session-alpha')?.text).toBe('Alpha 未发送草稿');
      expect(globalSessionDraftLru.getDraft('session-alpha')?.pastedPills).toHaveLength(1);

      // Switch to session-beta -> composer is clean, no pills leaked from alpha
      fireEvent.click(screen.getByTestId('switch-to-beta'));
      expect(textarea.value).toBe('');
      expect(screen.queryByTestId('large-paste-pills-bar')).not.toBeInTheDocument();

      // Switch back to session-alpha -> restores both draft text and pasted pill
      fireEvent.click(screen.getByTestId('switch-to-alpha'));
      expect(textarea.value).toBe('Alpha 未发送草稿');
      expect(screen.getByTestId('large-paste-pills-bar')).toHaveTextContent('22 行');
    });

    it('caps globalSessionDraftLru capacity at 16 sessions and evicts the oldest draft', () => {
      for (let i = 1; i <= 18; i += 1) {
        globalSessionDraftLru.saveDraft(`sess-${i}`, {
          text: `draft-${i}`,
          attachments: [],
          pastedPills: [],
        });
      }

      expect(globalSessionDraftLru.size()).toBe(16);
      expect(globalSessionDraftLru.getDraft('sess-1')).toBeNull();
      expect(globalSessionDraftLru.getDraft('sess-2')).toBeNull();
      expect(globalSessionDraftLru.getDraft('sess-3')?.text).toBe('draft-3');
      expect(globalSessionDraftLru.getDraft('sess-18')?.text).toBe('draft-18');
    });
  });

  describe('3. Streaming Queue / Steer Floating Preempt Bar', () => {
    it('shows floating-preempt-bar only when streaming with draft content, supporting Queue and Steer ordering', async () => {
      expect(
        shouldShowFloatingPreemptControl({
          isStreaming: true,
          hasDraftText: false,
          isExecutingCommand: false,
        }),
      ).toBe(false);
      expect(
        shouldShowFloatingPreemptControl({
          isStreaming: true,
          hasDraftText: true,
          isExecutingCommand: false,
        }),
      ).toBe(true);

      const events: string[] = [];
      const onStop = vi.fn(() => {
        events.push('stop');
      });
      const onSend = vi.fn(() => {
        events.push('send');
      });

      const { rerender } = renderInputBar({
        isStreaming: true,
        queueEnabled: true,
        inputValue: '',
        onAbort: onStop,
        onSend,
      });

      // Empty draft while streaming -> floating bar hidden
      expect(screen.queryByTestId('floating-preempt-bar')).not.toBeInTheDocument();

      // Draft present while streaming -> floating bar visible
      rerender(
        <InputBarUI
          inputValue="补充约束条件"
          canSend={false}
          queueEnabled={true}
          canAbort={true}
          isStreaming={true}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={onSend}
          onAbort={onStop}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
        />,
      );

      const preemptBar = screen.getByTestId('floating-preempt-bar');
      expect(preemptBar).toBeInTheDocument();

      // 1) Queue button triggers onSend directly without stopping
      fireEvent.click(screen.getByTestId('floating-queue-btn'));
      expect(events).toEqual(['send']);

      events.length = 0;

      // 2) Steer button calls onStop first, then calls onSend on next microtask
      fireEvent.click(screen.getByTestId('floating-steer-btn'));
      expect(events).toEqual(['stop']);

      await waitFor(() => {
        expect(events).toEqual(['stop', 'send']);
      });
      expect(onStop.mock.invocationCallOrder[0]).toBeLessThan(
        onSend.mock.invocationCallOrder[1],
      );
    });

    it('hides floating-queue-btn when queueEnabled=false, disables it when queueFull=true, and respects allowSteer=false', () => {
      const { rerender } = renderInputBar({
        isStreaming: true,
        queueEnabled: false,
        canAbort: true,
        inputValue: '流式期间草稿',
      });

      expect(screen.getByTestId('floating-preempt-bar')).toBeInTheDocument();
      expect(screen.queryByTestId('floating-queue-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('floating-steer-btn')).toBeInTheDocument();

      // queueEnabled=true & queueFull=true -> Queue button rendered but disabled
      rerender(
        <InputBarUI
          inputValue="流式期间草稿"
          canSend={false}
          queueEnabled={true}
          queueFull={true}
          canAbort={true}
          isStreaming={true}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onAbort={vi.fn()}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
        />,
      );
      expect(screen.getByTestId('floating-queue-btn')).toBeDisabled();

      // allowSteer=false & queueEnabled=true -> Steer hidden, Queue visible
      rerender(
        <InputBarUI
          inputValue="流式期间草稿"
          canSend={false}
          queueEnabled={true}
          queueFull={false}
          allowSteer={false}
          canAbort={true}
          isStreaming={true}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={vi.fn()}
          onAbort={vi.fn()}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
        />,
      );
      expect(screen.getByTestId('floating-queue-btn')).toBeEnabled();
      expect(screen.queryByTestId('floating-steer-btn')).not.toBeInTheDocument();
    });

    it('waits for async onAbort to finish before flushing pills and triggering onSend on Steer, without leaking expanded text into LRU draft', async () => {
      let resolveAbort!: () => void;
      const abortPromise = new Promise<void>((resolve) => {
        resolveAbort = resolve;
      });
      const onAbort = vi.fn(() => abortPromise);
      const onSend = vi.fn();
      let latestInput = '附加说明';

      const { rerender } = renderInputBar({
        sessionId: 'sess-async-steer',
        isStreaming: true,
        queueEnabled: false,
        canAbort: true,
        inputValue: latestInput,
        onInputChange: (val) => {
          latestInput = val;
        },
        onAbort,
        onSend,
      });

      const textarea = screen.getByTestId('input-bar-v2-textarea');
      const largePaste = 'P'.repeat(1100);
      fireEvent.paste(textarea, {
        clipboardData: {
          files: [],
          getData: (type: string) => (type === 'text/plain' ? largePaste : ''),
        },
      });

      expect(screen.getByTestId('large-paste-pills-bar')).toBeInTheDocument();
      expect(globalSessionDraftLru.getDraft('sess-async-steer')?.pastedPills).toHaveLength(1);

      // Click Steer while onAbort is pending
      fireEvent.click(screen.getByTestId('floating-steer-btn'));
      expect(onAbort).toHaveBeenCalledTimes(1);
      expect(onSend).not.toHaveBeenCalled();
      // Pill must still be intact before async abort resolves
      expect(screen.getByTestId('large-paste-pills-bar')).toBeInTheDocument();

      // Resolve async abort
      await act(async () => {
        resolveAbort();
        await abortPromise;
      });

      await waitFor(() => {
        expect(onSend).toHaveBeenCalledTimes(1);
      });
      expect(latestInput).toBe(`${largePaste}\n\n附加说明`);
      expect(screen.queryByTestId('large-paste-pills-bar')).not.toBeInTheDocument();

      // Re-render with expanded text (as parent store would before clearing) -> must NOT leak expanded text back into LRU
      rerender(
        <InputBarUI
          sessionId="sess-async-steer"
          inputValue={latestInput}
          canSend={true}
          queueEnabled={false}
          canAbort={false}
          isStreaming={false}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={vi.fn()}
          onSend={onSend}
          onAbort={onAbort}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
        />,
      );
      expect(globalSessionDraftLru.getDraft('sess-async-steer')).toBeNull();
    });

    it('closes the state-machine loop in useInputBarV2.steerMessage for both queueEnabled=true and queueEnabled=false', async () => {
      const callOrder: string[] = [];
      const mockStore = createStore<any>((set, get) => ({
        sessionId: 'sess-hook-steer',
        inputValue: '抢占指令 A',
        attachments: [],
        pendingContextRefs: [],
        panelStates: createDefaultPanelStates(),
        sessionStatus: 'streaming',
        queuedMessages: [{ id: 'q_existing', content: '旧排队项', status: 'pending' }],
        permissionPresetSyncing: false,
        canSend: () => get().sessionStatus === 'idle',
        canAbort: () => get().sessionStatus === 'streaming',
        setInputValue: (val: string) => set({ inputValue: val }),
        setPendingParallelModelIds: vi.fn(),
        clearAttachments: vi.fn(),
        enqueueMessage: vi.fn((content: string) => {
          callOrder.push(`enqueue:${content}`);
          set((s: any) => ({
            queuedMessages: [
              ...s.queuedMessages,
              { id: 'q_new', content, status: 'pending' },
            ],
          }));
        }),
        markSteered: vi.fn((id: string) => {
          callOrder.push(`markSteered:${id}`);
        }),
        promoteQueued: vi.fn((id: string) => {
          callOrder.push(`promote:${id}`);
        }),
        abortStream: vi.fn(async () => {
          callOrder.push('abort');
          set({ sessionStatus: 'idle' });
        }),
        maybeDequeue: vi.fn(async () => {
          callOrder.push('maybeDequeue');
        }),
        sendMessage: vi.fn(async (content: string) => {
          callOrder.push(`send:${content}`);
        }),
      }));

      // 1) queueEnabled=true: enqueues, marks steered, promotes to head, aborts stream, then dequeues
      const { result, rerender } = renderHook(
        ({ queueEnabled }) => useInputBarV2(mockStore as any, { queueEnabled }),
        { initialProps: { queueEnabled: true } },
      );

      await act(async () => {
        await result.current.steerMessage();
      });

      expect(callOrder).toEqual([
        'enqueue:抢占指令 A',
        'markSteered:q_new',
        'promote:q_new',
        'abort',
        'maybeDequeue',
      ]);

      // 2) queueEnabled=false: awaits abortStream first, then sends directly without losing draft
      callOrder.length = 0;
      mockStore.setState({
        sessionStatus: 'streaming',
        inputValue: '无队列抢占指令 B',
        queuedMessages: [],
      });
      rerender({ queueEnabled: false });

      await act(async () => {
        await result.current.steerMessage();
      });

      expect(callOrder).toEqual(['abort', 'send:无队列抢占指令 B']);
      expect(mockStore.getState().inputValue).toBe('');
    });
  });

  describe('4. ComposerToolbar ContextWindowUsageRing data-usage-level & 6-level reasoning effort', () => {
    it('switches data-usage-level across normal (<=0.7), warn (>0.7), and danger (>0.9)', () => {
      const baseProps = {
        inputValue: '',
        canSend: false,
        canAbort: false,
        isStreaming: false,
        attachments: [],
        panelStates: createDefaultPanelStates(),
        onInputChange: vi.fn(),
        onSend: vi.fn(),
        onAbort: vi.fn(),
        onAddAttachment: vi.fn(),
        onUpdateAttachment: vi.fn(),
        onRemoveAttachment: vi.fn(),
        onClearAttachments: vi.fn(),
        onSetPanelState: vi.fn(),
        enableThinking: true,
        thinkingDepthValue: 'xhigh' as const,
        onToggleThinking: vi.fn(),
      };

      const { rerender } = render(
        <InputBarUI {...baseProps} contextWindowUsage={buildUsage(50_000, 100_000)} />,
      );

      expect(screen.getByTestId('context-window-usage-control')).toHaveAttribute(
        'data-usage-level',
        'normal',
      );
      expect(screen.getByTestId('context-window-usage-ring')).toHaveAttribute(
        'data-usage-level',
        'normal',
      );
      expect(screen.getByTestId('thinking-runtime-control')).toHaveAttribute(
        'data-reasoning-effort',
        'xhigh',
      );

      // Boundary 70% -> still normal (ratio === 0.7)
      rerender(
        <InputBarUI {...baseProps} contextWindowUsage={buildUsage(70_000, 100_000)} />,
      );
      expect(screen.getByTestId('context-window-usage-ring')).toHaveAttribute(
        'data-usage-level',
        'normal',
      );

      // 75% (ratio = 0.75 > 0.7) -> warn
      rerender(
        <InputBarUI {...baseProps} contextWindowUsage={buildUsage(75_000, 100_000)} />,
      );
      expect(screen.getByTestId('context-window-usage-control')).toHaveAttribute(
        'data-usage-level',
        'warn',
      );
      expect(screen.getByTestId('context-window-usage-ring')).toHaveAttribute(
        'data-usage-level',
        'warn',
      );

      // Boundary 90% (ratio === 0.9) -> still warn
      rerender(
        <InputBarUI {...baseProps} contextWindowUsage={buildUsage(90_000, 100_000)} />,
      );
      expect(screen.getByTestId('context-window-usage-ring')).toHaveAttribute(
        'data-usage-level',
        'warn',
      );

      // 95% (ratio = 0.95 > 0.9) -> danger
      rerender(
        <InputBarUI {...baseProps} contextWindowUsage={buildUsage(95_000, 100_000)} />,
      );
      expect(screen.getByTestId('context-window-usage-control')).toHaveAttribute(
        'data-usage-level',
        'danger',
      );
      expect(screen.getByTestId('context-window-usage-ring')).toHaveAttribute(
        'data-usage-level',
        'danger',
      );
    });
  });
});
