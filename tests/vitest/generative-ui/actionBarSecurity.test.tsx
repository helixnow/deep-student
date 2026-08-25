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
      if (key === 'action.unregistered_label') return '未注册操作';
      if (key === 'a11y.action_bar_label') return '操作栏';
      return key;
    },
  }),
}));
import { ActionBarBlock } from '@/features/generative-ui/components/ActionBarBlock';
import { resolveEffectiveRiskLevel } from '@/features/generative-ui/actions';

describe('resolveEffectiveRiskLevel', () => {
  it('uses handler risk when higher than model', () => {
    expect(resolveEffectiveRiskLevel('low', 'high')).toBe('high');
  });

  it('uses model risk when higher than handler', () => {
    expect(resolveEffectiveRiskLevel('high', 'low')).toBe('high');
  });
});

describe('ActionBarBlock security', () => {
  it('opens alert dialog for high effective risk from handler', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'delete-all', label: '删除全部', riskLevel: 'low' }]}
        actionHandlers={{
          'delete-all': { id: 'delete-all', label: '删除全部', riskLevel: 'high', handler },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: '删除全部' }));
    expect(screen.getByText('确认：删除全部')).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();
  });

  it('uses the trusted handler label from the first high-risk affordance', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'delete-all', label: '查看详情', riskLevel: 'low' }]}
        actionHandlers={{
          'delete-all': { id: 'delete-all', label: '删除全部', riskLevel: 'high', handler },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: '查看详情' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除全部' }));
    expect(screen.getByText('确认：删除全部')).toBeInTheDocument();
  });

  it('does not let a model label disguise an immediately executed low-risk handler', async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'batch-index', label: '仅查看状态', riskLevel: 'low' }]}
        actionHandlers={{
          'batch-index': {
            id: 'batch-index',
            label: '开始批量索引',
            riskLevel: 'low',
            handler,
          },
        }}
      />,
    );

    expect(screen.queryByRole('button', { name: '仅查看状态' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开始批量索引' }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('moves focus into the confirm dialog when opened', async () => {
    const user = userEvent.setup();
    render(
      <ActionBarBlock
        actions={[{ id: 'delete-all', label: '删除全部', riskLevel: 'low' }]}
        actionHandlers={{
          'delete-all': { id: 'delete-all', label: '删除全部', riskLevel: 'high', handler: vi.fn() },
        }}
      />,
    );
    await user.click(screen.getByRole('button', { name: '删除全部' }));
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it('does not treat prototype keys as registered handlers', () => {
    render(
      <ActionBarBlock
        actions={[{ id: 'toString', label: '伪造', riskLevel: 'low' }]}
        actionHandlers={{
          'start-review': { id: 'start-review', label: '复习', riskLevel: 'low', handler: vi.fn() },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: '未注册操作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '伪造' })).not.toBeInTheDocument();
  });

  it('emits onAction when no handler registry is provided', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ActionBarBlock
        actions={[{ id: 'preview', label: '预览', riskLevel: 'low' }]}
        onAction={onAction}
      />,
    );
    await user.click(screen.getByRole('button', { name: '预览' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'execute', actionId: 'preview' });
  });

  it('disables unregistered action ids when handlers registry is provided', () => {
    render(
      <ActionBarBlock
        actions={[{ id: 'fake-action', label: '伪造操作', riskLevel: 'low' }]}
        actionHandlers={{
          'start-review': { id: 'start-review', label: '复习', riskLevel: 'low', handler: vi.fn() },
        }}
      />,
    );
    expect(screen.queryByRole('button', { name: '未注册操作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '伪造操作' })).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
});
