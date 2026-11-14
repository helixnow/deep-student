import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkshopProposalCard } from '../components/WorkshopProposalCard';
import type { WorkshopItem } from '../types';

const item: WorkshopItem = {
  id: 'user.words', proposalId: 'proposal', name: '每日单词', version: '2.0.0',
  capabilities: [], changes: [], trust: 'full', phase: 'installed', visualVerified: false,
};

describe('WorkshopProposalCard recovery status', () => {
  it('makes immediate use and automatic next-start loading explicit after installation', () => {
    render(<WorkshopProposalCard item={item} onAction={vi.fn()} onRepair={vi.fn()} />);
    expect(screen.getByText('已生效（支持立即使用，重启应用后同样自动加载）')).toBeInTheDocument();
  });

  it('offers continued AI repair after an authoritative safe rollback', () => {
    const onRepair = vi.fn();
    render(<WorkshopProposalCard item={{ ...item, phase: 'failed', rollback: 'restored' }} onAction={vi.fn()} onRepair={onRepair} />);
    expect(screen.getByText('已自动回退至安全状态')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '让 AI 继续修复' }));
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/已生效/)).toBeNull();
  });

  it('does not claim safety on unknown or failed rollback', () => {
    const view = render(<WorkshopProposalCard item={{ ...item, phase: 'failed' }} onAction={vi.fn()} onRepair={vi.fn()} />);
    expect(screen.queryByText('已自动回退至安全状态')).toBeNull();
    view.rerender(<WorkshopProposalCard item={{ ...item, phase: 'failed', rollback: 'failed' }} onAction={vi.fn()} onRepair={vi.fn()} busy />);
    expect(screen.queryByText('已自动回退至安全状态')).toBeNull();
    expect(screen.getByRole('button', { name: '让 AI 继续修复' })).toBeDisabled();
  });
});
