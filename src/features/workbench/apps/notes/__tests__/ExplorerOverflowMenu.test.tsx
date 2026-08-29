import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExplorerOverflowMenu, type ExplorerOverflowAction } from '../ExplorerOverflowMenu';

function actions(overrides: Partial<ExplorerOverflowAction>[] = []): ExplorerOverflowAction[] {
  const base: ExplorerOverflowAction[] = [
    { key: 'refresh', label: '刷新', icon: <i />, onSelect: vi.fn() },
    { key: 'trash', label: '回收站', icon: <i />, onSelect: vi.fn() },
    { key: 'backlinks', label: '链接笔记', icon: <i />, onSelect: vi.fn(), active: true },
  ];
  return base.map((action, index) => ({ ...action, ...overrides[index] }));
}

describe('ExplorerOverflowMenu', () => {
  it('opens on trigger click, runs the action, then closes and restores focus', () => {
    const list = actions();
    render(<ExplorerOverflowMenu label="更多操作" actions={list} />);

    const trigger = screen.getByRole('button', { name: '更多操作' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('menuitem', { name: '刷新' }));
    expect(list[0].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('marks two-state actions as checked menu items', () => {
    render(<ExplorerOverflowMenu label="更多操作" actions={actions()} />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitemcheckbox', { name: '链接笔记' }))
      .toHaveAttribute('aria-checked', 'true');
  });

  it('closes on Escape and on outside pointerdown', () => {
    render(
      <div>
        <button type="button">outside</button>
        <ExplorerOverflowMenu label="更多操作" actions={actions()} />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: '更多操作' });

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('cycles focus through enabled items with arrow keys', () => {
    render(<ExplorerOverflowMenu label="更多操作" actions={actions([{}, { disabled: true }])} />);
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

    const menu = screen.getByRole('menu');
    expect(screen.getByRole('menuitem', { name: '刷新' })).toHaveFocus();

    // 下移跳过 disabled 的「回收站」，落在「链接笔记」
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemcheckbox', { name: '链接笔记' })).toHaveFocus();

    // 再下移回卷到第一项
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: '刷新' })).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitemcheckbox', { name: '链接笔记' })).toHaveFocus();
  });
});
