import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UiKernel } from '@/ui-kernel/kernel';
import { UiKernelProvider } from '@/ui-kernel/react';
import { defineUiPlugin } from '@/ui-sdk';
import { installOfficialUiPlugins } from '@/ui-plugins/official/install';
import { memoryRegistryAdapters } from '@/ui-plugins/testing/registries';
import { MessageActions } from '../message/MessageActions';

describe('chat.message.actions slot in MessageActions', () => {
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

  it('filters by roles, enables overflow menu when contributed actions exist, and runs callback with sessionId and content', async () => {
    const assistantRun = vi.fn();
    const userOnlyRun = vi.fn();
    const MsgIcon = ({ size }: { size?: number }) => <span data-testid="msg-slot-icon" data-size={size}>M</span>;

    const plugin = defineUiPlugin({
      meta: { id: 'community.msg-actions', version: '1.0.0' },
      apply(ctx) {
        ctx.ui.contribute('chat.message.actions', {
          id: 'save-snippet',
          value: {
            label: 'Save Snippet',
            icon: MsgIcon,
            roles: ['assistant'],
            run: assistantRun,
          },
        });
        ctx.ui.contribute('chat.message.actions', {
          id: 'user-only',
          value: {
            label: 'User Only Action',
            roles: ['user'],
            run: userOnlyRun,
          },
        });
        ctx.ui.contribute('chat.message.actions', {
          id: 'broken-action',
          value: {
            label: 'Broken Message Action',
            run: () => { throw new Error('msg action boom'); },
          },
        });
      },
    });

    await act(async () => {
      await kernel.install(plugin, { origin: 'community' });
    });

    const user = userEvent.setup();
    render(
      <UiKernelProvider kernel={kernel}>
        <MessageActions
          messageId="msg-42"
          sessionId="sess-7"
          getMessageContent={() => 'Assistant explanation'}
          isUser={false}
          isLocked={false}
          canEdit={false}
          canDelete={false}
          alwaysExpanded
          onCopy={async () => {}}
          onDelete={async () => {}}
        />
      </UiKernelProvider>,
    );

    const moreTrigger = screen.getByRole('button', { name: /更多|more/i });
    await user.click(moreTrigger);

    const item = await screen.findByText('Save Snippet');
    expect(screen.queryByText('User Only Action')).toBeNull();
    expect(screen.getByTestId('msg-slot-icon')).toBeInTheDocument();

    await user.click(item);
    expect(assistantRun).toHaveBeenCalledWith({
      messageId: 'msg-42',
      role: 'assistant',
      content: 'Assistant explanation',
      sessionId: 'sess-7',
    });

    await user.click(screen.getByRole('button', { name: /更多|more/i }));
    await user.click(await screen.findByText('Broken Message Action'));
    await waitFor(() => {
      expect(kernel.errors.list('community.msg-actions').some(r => r.phase === 'report' && r.slot === 'chat.message.actions')).toBe(true);
    });
  });
});
