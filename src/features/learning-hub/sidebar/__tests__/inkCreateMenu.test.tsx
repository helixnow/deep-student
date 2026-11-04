import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FinderCreateMenuItems } from '@/features/learning-hub/components/finder/FinderQuickAccess';
import { INK_BOARD_CREATE_ENABLED } from '@/features/ink';

/**
 * The existing SidebarFinderToolbar create menu is the mode choice. These
 * tests define the minimal protocol: one menu with explicit paged and board
 * choices. The menu reads the single `INK_BOARD_CREATE_ENABLED` capability
 * constant, and an explicit false still preserves the hideable branch.
 */
describe('sidebar finder ink create choices', () => {
  it('shows the paged ink item and withholds the free-canvas item while the board cap is off', () => {
    const onNewInk = vi.fn();
    render(<FinderCreateMenuItems onNewInk={onNewInk} boardInkEnabled={false} />);

    const pagedItem = screen.getByTestId('finder-create-ink-paged');
    expect(pagedItem).toHaveAttribute('data-ink-mode', 'paged');
    expect(screen.queryByTestId('finder-create-ink-board')).not.toBeInTheDocument();

    fireEvent.click(pagedItem);
    expect(onNewInk).toHaveBeenCalledWith('paged');
  });

  it('routes the free-canvas choice to board mode and keeps paged as the default choice', () => {
    const onNewInk = vi.fn();
    render(<FinderCreateMenuItems onNewInk={onNewInk} boardInkEnabled />);

    const boardItem = screen.getByTestId('finder-create-ink-board');
    expect(boardItem).toHaveAttribute('data-ink-mode', 'board');
    const pagedItem = screen.getByTestId('finder-create-ink-paged');
    expect(pagedItem).toHaveAttribute('data-ink-mode', 'paged');

    fireEvent.click(boardItem);
    expect(onNewInk).toHaveBeenCalledWith('board');

    fireEvent.click(pagedItem);
    expect(onNewInk).toHaveBeenLastCalledWith('paged');
  });

  /**
   * Positive regression for the enabled single capability switch: the real
   * menu wiring passes `INK_BOARD_CREATE_ENABLED`, so the board choice is
   * shown and paged stays selectable. The explicit-false test above keeps the
   * hideable branch as the security negative.
   */
  it('board enabled: default create menu exposes the board choice and keeps paged selectable', () => {
    const onNewInk = vi.fn();
    render(
      <FinderCreateMenuItems
        onNewInk={onNewInk}
        boardInkEnabled={INK_BOARD_CREATE_ENABLED}
      />,
    );
    expect(INK_BOARD_CREATE_ENABLED).toBe(true);

    const boardItem = screen.getByTestId('finder-create-ink-board');
    expect(boardItem).toHaveAttribute('data-ink-mode', 'board');
    const pagedItem = screen.getByTestId('finder-create-ink-paged');
    expect(pagedItem).toHaveAttribute('data-ink-mode', 'paged');

    fireEvent.click(boardItem);
    expect(onNewInk).toHaveBeenCalledWith('board');

    fireEvent.click(pagedItem);
    expect(onNewInk).toHaveBeenLastCalledWith('paged');
  });
});
