import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkshopConfirmationCard } from '../WorkshopConfirmationCard';
import { WorkshopCreations } from '../WorkshopCreations';
import { useWorkshop } from '../useWorkshop';
import { workshopActions, type WorkshopAdapter, type WorkshopItem } from '../types';

const item: WorkshopItem = {
  id: 'vocabulary', proposalId: 'proposal-1', name: '每日单词', version: '2', previousVersion: '1',
  capabilities: ['service:notes'], changes: ['新增错题入口'], trust: 'full', phase: 'proposed', visualVerified: false,
};

describe('plugin workshop UI (adapter component tests, not Host E2E)', () => {
  it('RF-P4-plugin-workshop-ui: shows exact version, capabilities, trust risk and changes; requires an explicit click', () => {
    const onAction = vi.fn();
    render(<WorkshopConfirmationCard item={item} onAction={onAction} />);
    expect(screen.getByText('service:notes')).toBeTruthy();
    expect(screen.getByText('相对 1 的变化')).toBeTruthy();
    expect(screen.getByText('新增错题入口')).toBeTruthy();
    expect(screen.getByText(/可能访问本机数据/)).toBeTruthy();
    expect(screen.getByText('视觉未验证')).toBeTruthy();
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '创建/安装' }));
    expect(onAction).toHaveBeenCalledWith('confirm');
  });

  it('permits cancellation during generation, not once installation is accepted', () => {
    const onAction = vi.fn();
    const view = render(<WorkshopConfirmationCard item={{ ...item, phase: 'generating' }} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onAction).toHaveBeenCalledWith('cancel');
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'installing' }} onAction={onAction} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not claim recovery on an ordinary failure', () => {
    const view = render(<WorkshopConfirmationCard item={{ ...item, phase: 'failed', error: '编译失败' }} onAction={vi.fn()} />);
    expect(screen.getByText('编译失败')).toBeTruthy();
    expect(screen.queryByText(/已回到上一个可用版本/)).toBeNull();
    view.rerender(<WorkshopConfirmationCard item={{ ...item, phase: 'failed', rollback: 'restored' }} onAction={vi.fn()} />);
    expect(screen.getByText(/已回到上一个可用版本/)).toBeTruthy();
  });

  it('offers restore/export/modify for an undone creation without regenerating it', () => {
    const onAction = vi.fn();
    const onModify = vi.fn();
    const undone = { ...item, phase: 'undone' as const };
    render(<WorkshopCreations items={[undone]} onAction={onAction} onModify={onModify} />);
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));
    expect(onAction).toHaveBeenCalledWith('restore', undone);
    expect(onModify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '让 AI 修改' }));
    expect(onModify).toHaveBeenCalledWith(undone);
    expect(screen.queryByRole('button', { name: '试用' })).toBeNull();
  });

  it('allows installed creations to be tried, disabled, undone and exported', () => {
    expect(workshopActions('installed')).toEqual(['try', 'disable', 'undo', 'export']);
    expect(workshopActions('failed')).toEqual([]);
  });

  it('deduplicates confirmation clicks and uses the returned Host state', async () => {
    let resolve!: (value: { item: WorkshopItem }) => void;
    const adapter: WorkshopAdapter = {
      list: vi.fn().mockResolvedValue([item]), get: vi.fn(), subscribe: () => vi.fn(),
      act: vi.fn(() => new Promise(done => { resolve = done; })),
    };
    const { result } = renderHook(() => useWorkshop(adapter));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { void result.current.act('confirm', item); void result.current.act('confirm', item); });
    expect(adapter.act).toHaveBeenCalledTimes(1);
    expect(result.current.items[0].phase).toBe('proposed');
    await act(async () => { resolve({ item: { ...item, phase: 'generating' } }); });
    expect(result.current.items[0].phase).toBe('generating');
  });

  it('reconciles ambiguous failures without claiming installed or rolled back', async () => {
    const adapter: WorkshopAdapter = {
      list: vi.fn().mockResolvedValue([item]), get: vi.fn(), subscribe: () => vi.fn(),
      act: vi.fn().mockRejectedValue(new Error('connection lost')),
    };
    const { result } = renderHook(() => useWorkshop(adapter));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { await result.current.act('confirm', item); });
    expect(adapter.list).toHaveBeenCalledTimes(2);
    expect(result.current.items[0].phase).toBe('proposed');
    expect(result.current.error).toBe('connection lost');
  });

  it('omits outer Card border and padding when embedded inside chat tool output', () => {
    const { container, rerender } = render(
      <WorkshopConfirmationCard item={item} onAction={vi.fn()} />,
    );
    const standalone = container.firstElementChild as HTMLElement;
    expect(standalone.className).toContain('border');
    expect(standalone.className).toContain('rounded-[var(--radius-card)]');

    rerender(<WorkshopConfirmationCard item={item} embedded onAction={vi.fn()} />);
    const embeddedRoot = container.firstElementChild as HTMLElement;
    expect(embeddedRoot.className).toContain('space-y-3');
    expect(embeddedRoot.className).not.toContain('rounded-[var(--radius-card)]');
    expect(embeddedRoot.className).not.toContain('border-border');
    expect(screen.getByRole('button', { name: '创建/安装' })).toBeInTheDocument();
  });
});
