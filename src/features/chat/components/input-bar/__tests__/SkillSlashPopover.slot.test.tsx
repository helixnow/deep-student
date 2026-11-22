import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { defineUiPlugin } from '@/ui-sdk';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { createDefaultPanelStates } from '../../../core/types/common';

vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/hooks/usePdfProcessingProgress', () => ({ usePdfProcessingProgress: vi.fn() }));
vi.mock('@/hooks/useTauriDragAndDrop', () => ({ useTauriDragAndDrop: () => ({ isDragging: false, dropZoneProps: {} }) }));
vi.mock('@/components/layout/MobileLayoutContext', () => ({
  useMobileLayoutSafe: () => ({ isMobile: false, isFullscreenContent: false }),
}));
vi.mock('../../../skills/registry', () => ({
  skillRegistry: { getAll: () => [], markSkillsLoaded: vi.fn() },
  subscribeToSkillRegistry: () => () => {},
}));

import { InputBarUI } from '../InputBarUI';

describe('chat.composer.commands slot in SkillSlashPopover & InputBarUI', () => {
  let kernel: UiKernel;

  beforeEach(async () => {
    cleanup();
    kernel = new UiKernel(memoryRegistryAdapters());
    await installOfficialUiPlugins(kernel);
  });

  afterEach(async () => {
    cleanup();
    await kernel.dispose();
  });

  function ControlledInputBar({
    initialValue = '/',
    onSendSpy = vi.fn(),
  }: {
    initialValue?: string;
    onSendSpy?: ReturnType<typeof vi.fn>;
  }) {
    const [value, setValue] = useState(initialValue);
    return (
      <UiKernelProvider kernel={kernel}>
        <InputBarUI
          sessionId="chat-sess-99"
          inputValue={value}
          canSend={value.trim().length > 0}
          canAbort={false}
          isStreaming={false}
          attachments={[]}
          panelStates={createDefaultPanelStates()}
          onInputChange={setValue}
          onSend={() => onSendSpy(value)}
          onAbort={vi.fn()}
          onAddAttachment={vi.fn()}
          onUpdateAttachment={vi.fn()}
          onRemoveAttachment={vi.fn()}
          onClearAttachments={vi.fn()}
          onSetPanelState={vi.fn()}
          placeholder="Ask anything"
        />
      </UiKernelProvider>
    );
  }

  it('filters invalid command names, strips slash + space, passes context with send(), and catches errors', async () => {
    const observed: { sessionId?: string; input?: string; initial?: string; afterInsert?: string } = {};
    const validRun = vi.fn((ctx) => {
      observed.sessionId = ctx.sessionId;
      observed.input = ctx.input;
      observed.initial = ctx.getInput();
      ctx.insertText('drill: ');
      observed.afterInsert = ctx.getInput();
      ctx.send();
    });
    const sendWithArgRun = vi.fn((ctx) => {
      ctx.send('override prompt');
    });

    const plugin = defineUiPlugin({
      meta: { id: 'community.slash', version: '1.0.0' },
      apply(ctx) {
        ctx.ui.contribute('chat.composer.commands', {
          id: 'quiz',
          value: { name: 'quizMe', label: 'Quiz Me', description: 'Run a quiz', run: validRun },
        });
        ctx.ui.contribute('chat.composer.commands', {
          id: 'override',
          value: { name: 'customSend', label: 'Custom Send', run: sendWithArgRun },
        });
        ctx.ui.contribute('chat.composer.commands', {
          id: 'invalid-name',
          value: { name: 'bad name!', label: 'Invalid Cmd', run: vi.fn() },
        });
        ctx.ui.contribute('chat.composer.commands', {
          id: 'broken',
          value: { name: 'explode', label: 'Explode', run: () => { throw new Error('slash boom'); } },
        });
      },
    });

    await act(async () => {
      await kernel.install(plugin, { origin: 'community' });
    });

    const sendSpy = vi.fn();
    render(<ControlledInputBar initialValue="/quiz topic" onSendSpy={sendSpy} />);
    const textarea = screen.getByPlaceholderText('Ask anything') as HTMLTextAreaElement;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(5, 5);
      fireEvent.change(textarea, { target: { value: '/quiz topic', selectionStart: 5 } });
    });

    const quizOption = await screen.findByText('/quizMe');
    expect(screen.queryByText('/bad name!')).toBeNull();
    fireEvent.pointerDown(quizOption.closest('[role="option"]')!);

    await waitFor(() => {
      expect(validRun).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith('drill: topic');
    });
    expect(observed).toEqual({
      sessionId: 'chat-sess-99',
      input: 'topic',
      initial: 'topic',
      afterInsert: 'drill: topic',
    });

    fireEvent.change(textarea, { target: { value: '/custom', selectionStart: 7 } });
    const overrideOption = await screen.findByText('/customSend');
    fireEvent.pointerDown(overrideOption.closest('[role="option"]')!);
    await waitFor(() => {
      expect(sendWithArgRun).toHaveBeenCalledTimes(1);
      expect(sendSpy).toHaveBeenCalledWith('override prompt');
    });

    fireEvent.change(textarea, { target: { value: '/exp', selectionStart: 4 } });
    const brokenOption = await screen.findByText('/explode');
    fireEvent.pointerDown(brokenOption.closest('[role="option"]')!);
    await waitFor(() => {
      expect(kernel.errors.list('community.slash').some(r => r.phase === 'report' && r.slot === 'chat.composer.commands')).toBe(true);
    });
  });
});
