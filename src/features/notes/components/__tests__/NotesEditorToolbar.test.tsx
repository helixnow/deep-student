import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CrepeEditorApi } from '@/components/crepe/types';
import { NotesEditorToolbar } from '../NotesEditorToolbar';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) =>
      key === 'notes:toolbar.label' ? '格式化' : defaultValue ?? key.split('.').at(-1) ?? key,
  }),
}));

vi.mock('@/components/shared/CommonTooltip', () => ({
  CommonTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeEditor(overrides: Partial<CrepeEditorApi> = {}): CrepeEditorApi {
  return {
    toggleBold: vi.fn(),
    toggleItalic: vi.fn(),
    toggleStrikethrough: vi.fn(),
    toggleInlineCode: vi.fn(),
    setHeading: vi.fn(),
    toggleBulletList: vi.fn(),
    toggleOrderedList: vi.fn(),
    toggleTaskList: vi.fn(),
    toggleBlockquote: vi.fn(),
    insertHr: vi.fn(),
    insertCodeBlock: vi.fn(),
    insertLink: vi.fn(),
    insertImage: vi.fn(),
    insertTable: vi.fn(),
    insertAtCursor: vi.fn(),
    focus: vi.fn(),
    getCrepe: vi.fn(() => null),
    ...overrides,
  } as unknown as CrepeEditorApi;
}

describe('NotesEditorToolbar', () => {
  it('keeps every formatting command keyboard reachable in one quiet menu', () => {
    const editor = makeEditor();

    render(<NotesEditorToolbar editor={editor} />);

    const toolbar = screen.getByRole('toolbar', { name: '格式化' });
    const formatTrigger = screen.getByRole('button', { name: '格式化' });
    expect(toolbar).toContainElement(formatTrigger);
    expect(formatTrigger).not.toHaveAttribute('tabindex', '-1');

    fireEvent.click(formatTrigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    const bold = screen.getByRole('menuitem', { name: /bold/ });
    fireEvent.click(bold);
    expect(editor.toggleBold).toHaveBeenCalledTimes(1);

    fireEvent.click(formatTrigger);
    expect(screen.getByRole('menuitem', { name: 'strikethrough' })).toBeInTheDocument();
  });

  it('exposes callout / toggle / wikilink insert entries in the overflow menu', () => {
    const editor = makeEditor();
    render(<NotesEditorToolbar editor={editor} />);

    fireEvent.click(screen.getByRole('button', { name: '格式化' }));
    expect(screen.getByRole('menuitem', { name: 'callout' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'toggle' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'wikilink' })).toBeInTheDocument();
  });

  it('wikilink entry inserts a [[ trigger through the existing autocomplete path', () => {
    const editor = makeEditor();
    render(<NotesEditorToolbar editor={editor} />);

    fireEvent.click(screen.getByRole('button', { name: '格式化' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'wikilink' }));
    expect(editor.focus).toHaveBeenCalled();
    expect(editor.insertAtCursor).toHaveBeenCalledWith('[[');
  });

  it('callout / toggle entries degrade to no-op without a crepe instance', () => {
    const editor = makeEditor({ getCrepe: vi.fn(() => null) });
    render(<NotesEditorToolbar editor={editor} />);

    fireEvent.click(screen.getByRole('button', { name: '格式化' }));
    expect(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'callout' }));
    }).not.toThrow();
    fireEvent.click(screen.getByRole('button', { name: '格式化' }));
    expect(() => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'toggle' }));
    }).not.toThrow();
    expect(editor.getCrepe).toHaveBeenCalled();
  });

  it('supports roving tabindex arrow-key navigation in the overflow menu', () => {
    const editor = makeEditor();
    render(<NotesEditorToolbar editor={editor} />);

    fireEvent.click(screen.getByRole('button', { name: '格式化' }));
    const menu = screen.getByRole('menu');
    const items = screen.getAllByRole('menuitem');
    expect(items.length).toBeGreaterThan(2);

    // 初始：仅第一项可 Tab 到
    expect(items[0]).toHaveAttribute('tabindex', '0');
    expect(items[1]).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[1]).toHaveAttribute('tabindex', '0');
    expect(items[0]).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(items[0]).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: 'End' });
    expect(items[items.length - 1]).toHaveAttribute('tabindex', '0');
    expect(document.activeElement).toBe(items[items.length - 1]);

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveAttribute('tabindex', '0');
  });
});
