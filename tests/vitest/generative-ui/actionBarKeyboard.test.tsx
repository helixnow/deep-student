import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
      if (key === 'action.undo') return '撤销';
      if (key === 'action.undo_empty') return '没有可撤销的操作';
      if (key === 'a11y.action_bar_label') return '操作栏';
      return key;
    },
  }),
}));

import { ActionBarBlock } from '@/features/generative-ui/components/ActionBarBlock';
import { GenerativeActionUndoStack } from '@/features/generative-ui/handlers/actionUndoStack';
import type { ActionBarProps } from '@/features/generative-ui/schema';
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

function renderBar(options?: {
  actions?: ActionBarProps['actions'];
  actionHandlers?: Record<string, GenerativeActionDefinition>;
  undoStack?: GenerativeActionUndoStack;
}) {
  const undoStack =
    options?.undoStack ?? new GenerativeActionUndoStack({ sink: () => undefined });
  const actions =
    options?.actions ??
    ([
      { id: 'save', label: '保存', riskLevel: 'low' },
      { id: 'export', label: '导出', riskLevel: 'low' },
    ] satisfies ActionBarProps['actions']);
  const actionHandlers =
    options?.actionHandlers ??
    ({
      save: def('save', '保存'),
      export: def('export', '导出'),
    } satisfies Record<string, GenerativeActionDefinition>);
  render(
    <ActionBarBlock
      actions={actions}
      actionHandlers={actionHandlers}
      undoStack={undoStack}
    />,
  );
  return { undoStack, actionHandlers };
}

describe('ActionBarBlock keyboard', () => {
  it('moves toolbar focus with ArrowRight and ArrowLeft, wrapping at the ends', async () => {
    const user = userEvent.setup();
    renderBar();

    const save = screen.getByRole('button', { name: '保存' });
    const exp = screen.getByRole('button', { name: '导出' });
    expect(save).toHaveAttribute('tabindex', '0');
    expect(exp).toHaveAttribute('tabindex', '-1');

    save.focus();
    await user.keyboard('{ArrowRight}');
    expect(exp).toHaveFocus();
    expect(exp).toHaveAttribute('tabindex', '0');
    expect(save).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{ArrowRight}');
    expect(save).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(exp).toHaveFocus();
  });

  it('cancels medium inline confirmation with Escape without executing', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    renderBar({
      actions: [{ id: 'export', label: '导出', riskLevel: 'medium' }],
      actionHandlers: { export: def('export', '导出', 'medium', handler) },
    });

    await user.click(screen.getByRole('button', { name: '导出' }));
    expect(screen.getByRole('button', { name: '确认：导出' })).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: '确认：导出' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出' })).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();
  });

  it('closes high-risk confirm dialog with Escape without executing', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    renderBar({
      actions: [{ id: 'delete-all', label: '删除全部', riskLevel: 'low' }],
      actionHandlers: { 'delete-all': def('delete-all', '删除全部', 'high', handler) },
    });

    await user.click(screen.getByRole('button', { name: '删除全部' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets keyboard users reach and activate Undo', async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    const undoStack = new GenerativeActionUndoStack({ sink: () => undefined });
    undoStack.push({ actionId: 'save', undo });

    renderBar({
      undoStack,
      actions: [
        { id: 'save', label: '保存', riskLevel: 'low' },
        { id: 'export', label: '导出', riskLevel: 'low' },
      ],
      actionHandlers: {
        save: def('save', '保存'),
        export: def('export', '导出'),
      },
    });

    const undoButton = screen.getByRole('button', { name: '撤销' });
    expect(undoButton).toBeEnabled();
    expect(undoButton).toHaveAttribute('tabindex', '-1');

    screen.getByRole('button', { name: '保存' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: '导出' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(undoButton).toHaveFocus();
    expect(undoButton).toHaveAttribute('tabindex', '0');

    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(undo).toHaveBeenCalledTimes(1);
    });
  });

  it('does not execute high-risk actions when Enter only opens confirm', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    renderBar({
      actions: [{ id: 'wipe', label: '清空', riskLevel: 'high' }],
      actionHandlers: { wipe: def('wipe', '清空', 'high', handler) },
    });

    screen.getByRole('button', { name: '清空' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();
  });
});
