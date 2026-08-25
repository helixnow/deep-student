import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MessageSearchBar } from '../MessageSearchBar';

const baseProps = {
  query: '',
  matchCount: 0,
  activeMatchIndex: 0,
  activeMessageId: null,
  activeOccurrenceIndex: 0,
  onQueryChange: vi.fn(),
  onPrevious: vi.fn(),
  onNext: vi.fn(),
  onClose: vi.fn(),
  onNavigate: vi.fn(),
};

describe('MessageSearchBar placement', () => {
  it('uses the desktop titlebar layout when placed in the header slot', () => {
    const { container } = render(<MessageSearchBar {...baseProps} placement="header" />);
    const root = container.querySelector('[data-slot="message-search-bar"]');
    const search = container.querySelector('[role="search"]');

    expect(root).toHaveClass('relative', 'h-full');
    expect(root).not.toHaveClass('fixed');
    expect(search).toHaveClass('h-12', 'bg-background/95');
  });

  it('keeps the floating layout as the default for mobile and fallback rendering', () => {
    render(<MessageSearchBar {...baseProps} />);
    // floating 形态由组件自身 createPortal 到 document.body，不在 render 容器内
    const root = document.body.querySelector('[data-slot="message-search-bar"]');

    expect(root).toHaveClass('fixed', 'right-4', 'top-2');
    expect(root).not.toHaveClass('h-full');
  });
});
