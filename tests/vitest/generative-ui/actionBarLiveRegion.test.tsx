import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'action.confirm_title') return `确认：${params?.label ?? ''}`;
      if (key === 'action.confirm_inline') return `确认：${params?.label ?? ''}`;
      if (key === 'action.confirm_desc') return '确认描述';
      if (key === 'action.confirm_execute') return '确认执行';
      if (key === 'action.unregistered_hint') return '未注册';
      if (key === 'action.unregistered_label') return '未注册操作';
      if (key === 'action.undo') return '撤销';
      if (key === 'action.undo_empty') return '没有可撤销的操作';
      if (key === 'action.live_ok') return `${params?.label ?? ''} completed`;
      if (key === 'action.live_error') return `${params?.label ?? ''} failed`;
      if (key === 'action.live_timeout') return `${params?.label ?? ''} timed out`;
      if (key === 'action.live_rate_limit')
        return `${params?.label ?? ''} too fast, try again shortly`;
      if (key === 'action.live_undo') return 'Last action undone';
      if (key === 'action.live_undo_error') return 'Undo failed';
      if (key === 'a11y.action_bar_label') return '操作栏';
      return key;
    },
  }),
}));

import { ActionBarBlock } from '@/features/generative-ui/components/ActionBarBlock';
import { wrapActionWithRateLimit } from '@/features/generative-ui/handlers/actionRateLimit';
import { wrapActionWithTimeout } from '@/features/generative-ui/handlers/actionTimeout';
import { GenerativeActionUndoStack } from '@/features/generative-ui/handlers/actionUndoStack';
import type { GenerativeActionDefinition } from '@/features/generative-ui/types';

function def(
  id: string,
  label: string,
  riskLevel: GenerativeActionDefinition['riskLevel'] = 'low',
  handler: GenerativeActionDefinition['handler'] = vi.fn(),
  extra?: Partial<GenerativeActionDefinition>,
): GenerativeActionDefinition {
  return { id, label, riskLevel, handler, ...extra };
}

function liveRegion(): HTMLElement {
  const el = document.querySelector('[data-action-live]');
  expect(el).toBeInstanceOf(HTMLElement);
  return el as HTMLElement;
}

describe('ActionBarBlock live region', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces success after a registered low-risk action executes', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'save', label: '保存', riskLevel: 'low' }]}
        actionHandlers={{ save: def('save', '保存', 'low', handler) }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    expect(liveRegion()).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('保存 completed');
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('mutates the live region when the same outcome is announced twice', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'save', label: '保存', riskLevel: 'low' }]}
        actionHandlers={{ save: def('save', '保存', 'low', handler) }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    const button = screen.getByRole('button', { name: '保存' });
    await user.click(button);
    await waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
      expect(liveRegion()).toHaveTextContent('保存 completed');
    });
    const firstAnnouncementNode = liveRegion().firstElementChild;
    expect(firstAnnouncementNode).not.toBeNull();

    await user.click(button);
    await waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
      expect(liveRegion().firstElementChild).not.toBe(firstAnnouncementNode);
    });
    expect(liveRegion()).toHaveTextContent('保存 completed');
  });

  it('announces failure when the handler throws', async () => {
    const user = userEvent.setup();
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    render(
      <ActionBarBlock
        actions={[{ id: 'save', label: '保存', riskLevel: 'low' }]}
        actionHandlers={{ save: def('save', '保存', 'low', handler) }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('保存 failed');
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('marks unregistered actions and does not execute them', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'fake-action', label: '伪造操作', riskLevel: 'low' }]}
        actionHandlers={{
          'start-review': def('start-review', '复习', 'low', handler),
        }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    expect(screen.queryByRole('button', { name: '未注册操作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '伪造操作' })).not.toBeInTheDocument();

    expect(handler).not.toHaveBeenCalled();
    expect(liveRegion()).toHaveTextContent('');
  });

  it('announces undo success when a reversible handler returns { undo }', async () => {
    const user = userEvent.setup();
    const undo = vi.fn(async () => {});
    const handler = vi.fn(async () => ({ undo }));
    render(
      <ActionBarBlock
        actions={[{ id: 'save', label: '保存', riskLevel: 'low' }]}
        actionHandlers={{ save: def('save', '保存', 'low', handler) }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('保存 completed');
    });

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('Last action undone');
    });
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('announces undo failure without rethrowing to the window', async () => {
    const user = userEvent.setup();
    const undo = vi.fn(async () => {
      throw new Error('undo exploded');
    });
    const handler = vi.fn(async () => ({ undo }));
    render(
      <ActionBarBlock
        actions={[{ id: 'save', label: '保存', riskLevel: 'low' }]}
        actionHandlers={{ save: def('save', '保存', 'low', handler) }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
    });

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('Undo failed');
    });
  });

  it('announces timeout when the wrapped handler hangs', async () => {
    vi.useFakeTimers();
    const wrapped = wrapActionWithTimeout(
      def('save', '保存', 'low', () => new Promise(() => {})),
      { timeoutMs: 10 },
    );
    render(
      <ActionBarBlock
        actions={[{ id: 'save', label: '保存', riskLevel: 'low' }]}
        actionHandlers={{ save: wrapped }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(liveRegion()).toHaveTextContent('保存 timed out');
  });

  it('announces rate-limit when a second click arrives during cooldown', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    const wrapped = wrapActionWithRateLimit(def('save', '保存', 'low', handler), {
      cooldownMs: 10_000,
    });
    render(
      <ActionBarBlock
        actions={[{ id: 'save', label: '保存', riskLevel: 'low' }]}
        actionHandlers={{ save: wrapped }}
        undoStack={new GenerativeActionUndoStack({ sink: () => undefined })}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('保存 completed');
    });
    expect(handler).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(liveRegion()).toHaveTextContent('保存 too fast, try again shortly');
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
