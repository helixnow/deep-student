import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState, type Transaction } from '@milkdown/prose/state';
import type { CrepeEditorApi } from '@/components/crepe/types';

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

function createEditor(windowed = false) {
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: { content: 'text*' },
      text: {},
    },
  });
  const view = {
    state: EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph', null, schema.text('cat cat'))]),
    }),
    dispatch: vi.fn((tr: Transaction) => { view.state = view.state.apply(tr); }),
    domAtPos: () => ({ node: document.createElement('p'), offset: 0 }),
  };
  const api = {
    getCrepe: () => ({ editor: { action: (run: (ctx: unknown) => void) => run({ get: () => view }) } }),
    isDocumentWindowed: () => windowed,
  } as unknown as CrepeEditorApi;
  return { api, view };
}

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
    // Inline under the editor chrome (border-b), not a floating absolute card.
    expect(panel.className).toContain('relative');
    expect(panel.className).toContain('border-b');
    expect(panel.className).toContain('ui-drop-in');
  });
});

describe('FindReplacePanel empty state', () => {
  it('shows 0/0 for empty results (not a stale 1/1)', () => {
    render(<FindReplacePanel editorApi={null} onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: '查找' });
    fireEvent.change(input, { target: { value: 'nothing' } });
    expect(screen.getByText('0/0')).toBeInTheDocument();
    expect(screen.getByTitle('无匹配结果')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
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
    expect(screen.getByText('0/0')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('FindReplacePanel search scope', () => {
  it('always describes the loaded scope, including when matches exist', () => {
    const { api } = createEditor(true);
    render(<FindReplacePanel editorApi={api} onClose={vi.fn()} initialQuery="cat" />);
    expect(screen.getByText('1/2')).toBeInTheDocument();
    const scope = '范围：当前笔记已加载部分（长文），未加载内容不参与查找和替换。';
    expect(screen.getByText(scope)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '查找' })).toHaveAccessibleDescription(scope);
    fireEvent.click(screen.getByRole('button', { name: '展开替换' }));
    expect(screen.getByRole('textbox', { name: '替换为' })).toHaveAccessibleDescription(scope);

    fireEvent.change(screen.getByRole('textbox', { name: '查找' }), { target: { value: 'missing' } });
    expect(screen.getByTitle('已加载部分无匹配（长文）')).toBeInTheDocument();
  });

  it('does not promise whole-document coverage when the host does not supply windowing information', () => {
    render(<FindReplacePanel editorApi={null} onClose={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: '查找' })).toHaveAccessibleDescription(
      '范围：当前笔记已加载内容；不跨段落或内嵌对象匹配。',
    );
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
  it.each([
    { isComposing: true },
    { isComposing: false, keyCode: 229 },
  ])('does not navigate, replace, close or consume editor shortcuts during composition (%j)', (composition) => {
    const { api, view } = createEditor();
    const onClose = vi.fn();
    render(<FindReplacePanel editorApi={api} onClose={onClose} initialQuery="cat" />);
    fireEvent.click(screen.getByRole('button', { name: '展开替换' }));
    const find = screen.getByRole('textbox', { name: '查找' });
    const replace = screen.getByRole('textbox', { name: '替换为' });
    fireEvent.change(replace, { target: { value: 'dog' } });
    view.dispatch.mockClear();

    for (const input of [find, replace]) {
      for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'F3']) {
        expect(fireEvent.keyDown(input, { key, ...composition })).toBe(true);
      }
      for (const key of ['Enter', 'f', 'z', 'y']) {
        expect(fireEvent.keyDown(input, { key, ctrlKey: true, ...composition })).toBe(true);
      }
    }
    expect(screen.getByRole('search')).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(view.dispatch).not.toHaveBeenCalled();
    expect(view.state.doc.textContent).toBe('cat cat');
    act(() => { vi.runAllTimers(); });
    expect(onClose).not.toHaveBeenCalled();

    // Normal keys remain actionable once composition has ended.
    fireEvent.keyDown(find, { key: 'Enter' });
    expect(screen.getByText('2/2')).toBeInTheDocument();
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true });
    expect(screen.getByText('1/2')).toBeInTheDocument();
    fireEvent.keyDown(replace, { key: 'Enter' });
    expect(view.state.doc.textContent).toBe('dog cat');
    fireEvent.keyDown(replace, { key: 'Enter', ctrlKey: true });
    expect(view.state.doc.textContent).toBe('dog dog');
    fireEvent.keyDown(replace, { key: 'Escape' });
    act(() => { vi.runAllTimers(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

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
