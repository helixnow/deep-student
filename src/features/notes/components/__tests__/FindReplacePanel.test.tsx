import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FindReplacePanel } from '../FindReplacePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue?: string) => defaultValue ?? _key,
  }),
}));

describe('FindReplacePanel accessibility', () => {
  it('provides names for the search region, inputs, and icon-only controls', () => {
    const onClose = vi.fn();
    render(<FindReplacePanel editorApi={null} onClose={onClose} />);

    expect(screen.getByRole('search', { name: '查找和替换' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '查找' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一个 (Shift+Enter)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一个 (Enter)' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '展开替换' }));
    expect(screen.getByRole('textbox', { name: '替换为' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收起替换' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
