import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { loadNotebookPage } = vi.hoisted(() => ({ loadNotebookPage: vi.fn() }));

vi.mock('../NotebookPage', () => {
  loadNotebookPage();
  return {
    default: ({ isActive }: { isActive?: boolean }) => <div data-testid="lazy-notebook-page" data-active={String(isActive)} />,
  };
});

import { LazyNotebookPage } from '../index';

describe('public LazyNotebookPage entry', () => {
  it('does not load NotebookPage from the public index until rendered and forwards active state', async () => {
    expect(loadNotebookPage).not.toHaveBeenCalled();
    const view = render(<LazyNotebookPage isActive={false} />);
    expect(await screen.findByTestId('lazy-notebook-page')).toHaveAttribute('data-active', 'false');
    expect(loadNotebookPage).toHaveBeenCalledTimes(1);
    view.rerender(<LazyNotebookPage isActive />);
    expect(screen.getByTestId('lazy-notebook-page')).toHaveAttribute('data-active', 'true');
    expect(loadNotebookPage).toHaveBeenCalledTimes(1);
  });
});
