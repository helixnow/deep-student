import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FindReplacePanel } from '../FindReplacePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string | { defaultValue?: string }) => {
      const table: Record<string, string> = {
        'notes:findReplace.panelLabel': '查找和替换',
        'notes:findReplace.findLabel': '查找',
        'notes:findReplace.replaceLabel': '替换为',
        'notes:findReplace.showReplace': '展开替换',
        'notes:findReplace.hideReplace': '收起替换',
        'notes:findReplace.prev': '上一个 (Shift+Enter)',
        'notes:findReplace.next': '下一个 (Enter)',
        'notes:findReplace.noMatch': '无匹配结果',
        'common:close': '关闭',
      };
      if (table[key]) return table[key];
      if (typeof defaultValue === 'string') return defaultValue;
      if (defaultValue && typeof defaultValue === 'object' && defaultValue.defaultValue) {
        return defaultValue.defaultValue;
      }
      return key;
    },
  }),
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

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

    // 关闭走退场动画：先标记 closing，延时后回调 onClose
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.getByRole('search', { name: '查找和替换' })).toHaveAttribute('data-state', 'closing');
    act(() => {
      vi.runAllTimers();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders as an inline top bar (not a floating corner card)', () => {
    render(<FindReplacePanel editorApi={null} onClose={vi.fn()} />);
    const panel = screen.getByRole('search', { name: '查找和替换' });
    expect(panel.className).toContain('inset-x-0');
    expect(panel.className).toContain('top-0');
    expect(panel.className).toContain('ui-drop-in');
  });
});

describe('FindReplacePanel empty state', () => {
  it('shows friendly no-match text instead of 0/0', () => {
    render(<FindReplacePanel editorApi={null} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: '查找' });
    fireEvent.change(input, { target: { value: 'nothing' } });
    expect(screen.getByText('无匹配结果')).toBeInTheDocument();
    expect(screen.queryByText('0/0')).not.toBeInTheDocument();
  });
});

describe('FindReplacePanel regex mode', () => {
  it('exposes a regex toggle with pressed state', () => {
    render(<FindReplacePanel editorApi={null} onClose={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: '使用正则表达式' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows invalid-regex feedback for broken patterns', () => {
    render(<FindReplacePanel editorApi={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '使用正则表达式' }));
    const input = screen.getByRole('textbox', { name: '查找' });
    fireEvent.change(input, { target: { value: '([' } });
    expect(screen.getByText('无效正则表达式')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');

    // 合法正则后恢复为常规无匹配提示（editorApi 为 null 时恒为 0 匹配）
    fireEvent.change(input, { target: { value: 'a+' } });
    expect(screen.queryByText('无效正则表达式')).not.toBeInTheDocument();
    expect(screen.getByText('无匹配结果')).toBeInTheDocument();
  });
});

describe('FindReplacePanel focusSignal', () => {
  it('re-focuses and selects the find input when focusSignal changes', () => {
    const { rerender } = render(
      <FindReplacePanel editorApi={null} onClose={vi.fn()} focusSignal={0} />,
    );
    const input = screen.getByRole('textbox', { name: '查找' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    input.blur();
    expect(document.activeElement).not.toBe(input);

    rerender(<FindReplacePanel editorApi={null} onClose={vi.fn()} focusSignal={1} />);
    expect(document.activeElement).toBe(input);
  });
});

describe('FindReplacePanel keyboard', () => {
  it('closes with exit transition on Escape from the find input', () => {
    const onClose = vi.fn();
    render(<FindReplacePanel editorApi={null} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '查找' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.runAllTimers();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('intercepts F3 / Shift+F3 at document level without throwing when editor is absent', () => {
    render(<FindReplacePanel editorApi={null} onClose={vi.fn()} />);
    expect(() => {
      fireEvent.keyDown(document, { key: 'F3' });
      fireEvent.keyDown(document, { key: 'F3', shiftKey: true });
    }).not.toThrow();
  });
});
