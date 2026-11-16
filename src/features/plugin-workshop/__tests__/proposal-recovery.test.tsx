import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkshopProposalCard } from '../components/WorkshopProposalCard';
import type { WorkshopItem } from '../types';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<object>()), ...(await import('../../plugin-manager/__tests__/i18nMock')).i18nMock() }));

const item: WorkshopItem = {
  id: 'user.words', proposalId: 'proposal', name: '公式速查', version: '2.0.0', previousVersion: '1.0.0',
  capabilities: [], changes: [], trust: 'full', phase: 'installed', places: [{ kind: 'app', title: '公式速查' }],
};

describe('WorkshopProposalCard after the decision', () => {
  it('installed: one primary by kind, 「让 AI 改」, the rest in ⋯; no risk block and no file extension', () => {
    const onAction = vi.fn();
    const onRepair = vi.fn();
    render(<WorkshopProposalCard embedded item={item} onAction={onAction} onRepair={onRepair} />);
    expect(screen.getByTestId('workshop-installed').textContent).toBe('装好了，现在就能用；重启应用后也会自动加载。');
    expect(screen.queryByTestId('workshop-risk')).toBeNull();
    expect(screen.queryByText(/\.dstuplugin/)).toBeNull();
    for (const old of ['试用', '撤销', '导出 .dstuplugin', '让 AI 修改']) expect(screen.queryByRole('button', { name: old })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开公式速查' }));
    expect(onAction).toHaveBeenCalledWith('try');
    fireEvent.click(screen.getByRole('button', { name: '让 AI 改' }));
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '更多操作' })).toBeInTheDocument();
  });

  it.each([
    [[{ kind: 'selectionButton' as const }], '去笔记里试试'],
    [[{ kind: 'agentTool' as const, title: '查课表' }], '试一句『查课表』'],
  ])('primary action follows what it adds (%j)', (places, label) => {
    render(<WorkshopProposalCard embedded item={{ ...item, places }} onAction={vi.fn()} onRepair={vi.fn()} />);
    expect(screen.getByTestId('workshop-primary').textContent).toBe(label);
  });

  it('uninstalled: 「恢复」, never 打开', () => {
    const onAction = vi.fn();
    render(<WorkshopProposalCard embedded item={{ ...item, phase: 'undone' }} onAction={onAction} onRepair={vi.fn()} />);
    expect(screen.queryByTestId('workshop-primary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(onAction).toHaveBeenCalledWith('restore');
  });

  it('crash isolation: plain sentence, 「让 AI 修」 and 「回到上一版」, raw text folded', () => {
    const onAction = vi.fn();
    const onRepair = vi.fn();
    render(<WorkshopProposalCard item={{ ...item, name: '编成口诀', phase: 'failed', error: 'UI_ERROR_BUDGET: Render failed 3 times' }} onAction={onAction} onRepair={onRepair} />);
    expect(screen.getByText('『编成口诀』出错太多次，已经先关掉了，你的笔记和资料不受影响。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '让 AI 修' }));
    expect(onRepair).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '回到上一版' }));
    expect(onAction).toHaveBeenCalledWith('restore');
    expect(screen.getByTestId('workshop-error-technical').textContent).toContain('UI_ERROR_BUDGET');
  });

  it('interrupted generation: 「继续做」 runs the same proposal again directly (F8)', () => {
    const onAction = vi.fn();
    render(<WorkshopProposalCard item={{ ...item, previousVersion: undefined, phase: 'failed', error: 'WORKSHOP_STATE: background generation interrupted by Host shutdown' }} onAction={onAction} onRepair={vi.fn()} />);
    expect(screen.getByText('生成被中断了（应用关闭了）。点「继续做」接着做。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续做' }));
    expect(onAction).toHaveBeenCalledWith('confirm');
    expect(screen.queryByRole('button', { name: '回到上一版' })).toBeNull();
  });

  it('does not claim safety on unknown or failed rollback', () => {
    const view = render(<WorkshopProposalCard item={{ ...item, phase: 'failed' }} onAction={vi.fn()} onRepair={vi.fn()} />);
    expect(screen.queryByText('已经回到能用的状态。')).toBeNull();
    view.rerender(<WorkshopProposalCard item={{ ...item, phase: 'failed', rollback: 'restored' }} onAction={vi.fn()} onRepair={vi.fn()} busy />);
    expect(screen.getByText('已经回到能用的状态。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '让 AI 修' })).toBeDisabled();
  });
});
