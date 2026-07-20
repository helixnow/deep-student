import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FavoritesSection, type FavoritesSectionItem } from '../FavoritesSection';

const items: FavoritesSectionItem[] = [
  { id: 'note_1', name: 'Algebra', type: 'note' },
  { id: 'mindmap_2', name: 'Geometry', type: 'mindmap' },
];

describe('FavoritesSection', () => {
  it('renders items and opens on click', () => {
    const onOpen = vi.fn();
    const onUnfavorite = vi.fn();
    render(
      <FavoritesSection items={items} onOpen={onOpen} onUnfavorite={onUnfavorite} />,
    );

    expect(screen.getByText('Algebra')).toBeInTheDocument();
    expect(screen.getByText('Geometry')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Algebra$/i }));
    expect(onOpen).toHaveBeenCalledWith(items[0]);
  });

  it('unfavorites via star button', () => {
    const onOpen = vi.fn();
    const onUnfavorite = vi.fn();
    render(
      <FavoritesSection items={items} onOpen={onOpen} onUnfavorite={onUnfavorite} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /取消收藏 Algebra|Unfavorite Algebra/i }));
    expect(onUnfavorite).toHaveBeenCalledWith(items[0]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows empty state when there are no favorites', () => {
    render(
      <FavoritesSection items={[]} onOpen={vi.fn()} onUnfavorite={vi.fn()} />,
    );
    expect(screen.getByText(/暂无收藏|No favorites/i)).toBeInTheDocument();
  });

  it('collapses and expands when the header is toggled', () => {
    const onExpandedChange = vi.fn();
    render(
      <FavoritesSection
        items={items}
        onOpen={vi.fn()}
        onUnfavorite={vi.fn()}
        expanded
        onExpandedChange={onExpandedChange}
      />,
    );

    const header = screen.getByRole('button', { expanded: true });
    expect(header).toHaveClass('nfs-header');
    expect(screen.getByText('Algebra')).toBeInTheDocument();

    fireEvent.click(header);
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });

  it('hides the list from assistive tech when collapsed (uncontrolled)', () => {
    render(
      <FavoritesSection
        items={items}
        onOpen={vi.fn()}
        onUnfavorite={vi.fn()}
        defaultExpanded={false}
      />,
    );

    const header = screen.getByRole('button', { expanded: false });
    const section = header.closest('section');
    expect(section).toHaveAttribute('data-expanded', 'false');
    // 列表保持挂载以支持 0fr→1fr 折叠动画，收起时通过 aria-hidden 屏蔽
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('list', { hidden: true })).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(header);
    expect(screen.getByRole('list')).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByText('Algebra')).toBeInTheDocument();
  });

  it('marks the active favorite', () => {
    render(
      <FavoritesSection
        items={items}
        onOpen={vi.fn()}
        onUnfavorite={vi.fn()}
        activeId="mindmap_2"
      />,
    );

    const active = screen.getByRole('button', { current: 'page' });
    expect(active).toHaveAccessibleName('Geometry');
    const row = active.closest('.nfs-item');
    expect(row).toHaveClass('is-active');
    expect(within(row as HTMLElement).getByRole('button', { name: /^Geometry$/i })).toBe(active);
  });
});
