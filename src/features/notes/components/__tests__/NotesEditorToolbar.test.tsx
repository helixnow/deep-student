import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrepeEditorApi } from '@/components/crepe/types';
import { generateCardsFromText } from '@/features/anki/generateCardsFromText';
import { NotesEditorToolbar } from '../NotesEditorToolbar';

vi.mock('@/features/anki/generateCardsFromText', () => ({
  MIN_CONTENT_LENGTH_FOR_CARDS: 10,
  generateCardsFromText: vi.fn(async () => ({ ok: true as const })),
}));

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
    getMarkdown: vi.fn(() => '# 光合作用\n叶绿体把光能转成化学能。'),
    ...overrides,
  } as unknown as CrepeEditorApi;
}

describe('NotesEditorToolbar', () => {
  beforeEach(() => {
    vi.mocked(generateCardsFromText).mockClear();
  });

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

  it('exposes a generate-cards action that feeds the note body to the shared card pipeline', async () => {
    const editor = makeEditor();
    render(<NotesEditorToolbar editor={editor} />);

    const trigger = screen.getByRole('button', { name: 'generateCards' });
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(generateCardsFromText).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(generateCardsFromText).mock.calls[0][0]).toMatchObject({
      content: '# 光合作用\n叶绿体把光能转成化学能。',
    });
  });

  it('prefers the full document over the loaded window when generating cards', async () => {
    const editor = makeEditor({
      getMarkdown: vi.fn(() => 'visible prefix only'),
      getFullMarkdown: vi.fn(() => 'visible prefix only\nplus the windowed tail'),
    });
    render(<NotesEditorToolbar editor={editor} />);

    fireEvent.click(screen.getByRole('button', { name: 'generateCards' }));

    await waitFor(() => {
      expect(generateCardsFromText).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(generateCardsFromText).mock.calls[0][0].content).toBe(
      'visible prefix only\nplus the windowed tail',
    );
  });

  it('keeps the generate-cards action disabled without an editor', () => {
    render(<NotesEditorToolbar editor={null} />);

    expect(screen.getByRole('button', { name: 'generateCards' })).toBeDisabled();
  });
});
