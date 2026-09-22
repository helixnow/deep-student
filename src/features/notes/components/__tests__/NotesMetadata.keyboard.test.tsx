import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotesEditorHeader } from '../NotesEditorHeader';
import { NotesContextPanel } from '../../NotesContextPanel';

const suggestions = vi.hoisted(() => ({ move: vi.fn(() => true), set: vi.fn() }));
vi.mock('@/features/notes/NotesContext', () => ({ useNotesOptional: () => null }));
vi.mock('@/features/notes/noteAppearance', () => ({
  NOTE_APPEARANCE_PRESETS: ['standard', 'compact', 'wide'], NOTE_APPEARANCE_ICONS: ['', '📚'],
  useNoteAppearance: () => ({ value: { preset: 'standard', icon: '' }, update: vi.fn(), loading: false }),
}));
vi.mock('@/features/notes/hooks/useTagSuggestions', () => ({ useTagSuggestions: () => ({
  suggestions: ['中文'], isLoading: false, highlightIndex: -1, highlighted: null,
  moveHighlight: suggestions.move, setHighlightIndex: suggestions.set,
}) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/dstu', () => ({ dstu: {}, updatedAtToVersionToken: vi.fn() }));
vi.mock('@/components/custom-scroll-area', () => ({ CustomScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }) }));

describe.each([{ isComposing: true }, { keyCode: 229 }])('note metadata IME (%j)', (composition) => {
  it('keeps title candidates focused and only commits a later normal Enter', async () => {
    const save = vi.fn(async () => {});
    render(<NotesEditorHeader noteId="ime-title" initialTitle="Original" lastSaved={null} onTitleChange={save} />);
    const title = screen.getByRole('textbox', { name: 'notes:header.documentTitle' });
    act(() => title.focus());
    fireEvent.change(title, { target: { value: '中文标题' } });
    for (const key of ['Enter', 'Escape']) expect(fireEvent.keyDown(title, { key, ...composition })).toBe(true);
    expect(title).toHaveFocus();
    expect(title).toHaveValue('中文标题');
    expect(save).not.toHaveBeenCalled();
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => expect(save).toHaveBeenCalledExactlyOnceWith('中文标题'));
  });

  it('leaves tag candidates and arrows to IME, then cancels back to the add button', () => {
    suggestions.move.mockClear();
    const save = vi.fn();
    render(<NotesEditorHeader noteId="ime-tags" initialTitle="Title" lastSaved={null} tags={[]} onTagsChange={save} />);
    fireEvent.click(screen.getByRole('button', { name: 'notes:header.add_tags' }));
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '中文' } });
    for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
      expect(fireEvent.keyDown(input, { key, ...composition })).toBe(true);
    }
    expect(input).toHaveFocus();
    expect(input).toHaveValue('中文');
    expect(save).not.toHaveBeenCalled();
    expect(suggestions.move).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(suggestions.move).toHaveBeenCalledWith(1);
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'notes:header.add_tags' })).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
  });

  it('protects context tag add/rename, restores keyboard focus, and retains outline collapse', () => {
    const save = vi.fn(async () => {});
    const props = { noteId: 'ime-context', title: 'Title', tags: ['原标签'], content: '# Parent\n\n## Child', onTagsChange: save };
    const view = render(<NotesContextPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'notes:editorV2.outline_collapse' }));
    fireEvent.click(screen.getByRole('button', { name: 'notes:context.add_tag' }));
    const input = screen.getByPlaceholderText('notes:context.add_tag');
    fireEvent.change(input, { target: { value: '中文' } });
    for (const key of ['Enter', 'Escape']) expect(fireEvent.keyDown(input, { key, ...composition })).toBe(true);
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'notes:context.add_tag' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'notes:header.rename_tag: 原标签' }));
    const rename = screen.getByRole('textbox', { name: 'notes:header.rename_tag' });
    fireEvent.change(rename, { target: { value: '新标签' } });
    for (const key of ['Enter', 'Escape']) expect(fireEvent.keyDown(rename, { key, ...composition })).toBe(true);
    expect(rename).toHaveValue('新标签');
    fireEvent.keyDown(rename, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'notes:header.rename_tag: 原标签' })).toHaveFocus();
    expect(save).not.toHaveBeenCalled();
    view.rerender(<NotesContextPanel {...props} updatedAt={Date.now()} />);
    expect(screen.queryByRole('button', { name: 'Child' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'notes:editorV2.outline_expand' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not let the document Popover handler close appearance during IME Escape', async () => {
    render(<NotesEditorHeader noteId="ime-appearance" initialTitle="Title" lastSaved={null} />);
    const trigger = screen.getByRole('button', { name: 'notes:appearance.label' });
    fireEvent.click(trigger);
    const panel = screen.getByRole('dialog');
    fireEvent.keyDown(panel, { key: 'Escape', ...composition });
    expect(panel).toHaveAttribute('data-state', 'open');
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
