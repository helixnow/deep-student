import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesAPI } from '@/utils/notesApi';
import { noteAppearanceKey, parseNoteAppearance, useNoteAppearance, isValidNoteIcon } from './noteAppearance';
import { NotesEditorHeader } from './components/NotesEditorHeader';
import { NotePageLayoutOptions } from './components/NotePageLayoutOptions';

vi.mock('@/utils/notesApi', () => ({
  NotesAPI: { getPref: vi.fn(), setPref: vi.fn() },
}));
vi.mock('./NotesContext', () => ({ useNotesOptional: () => null }));
vi.mock('./hooks/useTagSuggestions', () => ({
  useTagSuggestions: () => ({ suggestions: [], isLoading: false, highlightIndex: -1 }),
}));

beforeEach(() => {
  vi.mocked(NotesAPI.getPref).mockReset().mockResolvedValue(null);
  vi.mocked(NotesAPI.setPref).mockReset().mockResolvedValue(true);
});

describe('note appearance persistence', () => {
  it('reads saved presets/icons and limits unsupported preference values', () => {
    expect(parseNoteAppearance('{"preset":"compact","icon":"📚"}')).toMatchObject({ preset: 'compact', icon: '📚' });
    expect(parseNoteAppearance('{"preset":"custom","icon":"unknown","font":"comic"}')).toEqual({ preset: 'standard', icon: '', smallText: false, fullWidth: false, font: 'default' });
    expect(parseNoteAppearance('invalid')).toMatchObject({ preset: 'standard', icon: '' });
  });

  it('migrates legacy exclusive presets to independent Notion toggles; explicit booleans win', () => {
    expect(parseNoteAppearance('{"preset":"compact"}')).toMatchObject({ smallText: true, fullWidth: false });
    expect(parseNoteAppearance('{"preset":"wide"}')).toMatchObject({ smallText: false, fullWidth: true });
    expect(parseNoteAppearance('{"preset":"wide","fullWidth":false,"smallText":true,"font":"serif"}'))
      .toMatchObject({ smallText: true, fullWidth: false, font: 'serif' });
  });

  it('shares writes between two hosts of one note, preserving the other appearance field', async () => {
    vi.mocked(NotesAPI.getPref).mockResolvedValue('{"preset":"compact","icon":"📚"}');
    const first = renderHook(() => useNoteAppearance('appearance-shared'));
    const second = renderHook(() => useNoteAppearance('appearance-shared'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(NotesAPI.getPref).toHaveBeenCalledTimes(1);
    await act(() => first.result.current.update({ fullWidth: true }));
    expect(JSON.parse(vi.mocked(NotesAPI.setPref).mock.calls[0][1])).toMatchObject({ icon: '📚', smallText: true, fullWidth: true });
    expect(second.result.current.value).toMatchObject({ icon: '📚', smallText: true, fullWidth: true });
    first.unmount();
    second.unmount();
    const reopened = renderHook(() => useNoteAppearance('appearance-shared'));
    expect(reopened.result.current.value).toMatchObject({ icon: '📚', fullWidth: true });
  });

  it('does not apply a late load to a different note', async () => {
    let finishFirst!: (value: string) => void;
    vi.mocked(NotesAPI.getPref).mockImplementation((key) => key.endsWith('appearance-old')
      ? new Promise((resolve) => { finishFirst = resolve; })
      : Promise.resolve('{"preset":"wide","icon":"💡"}'));
    const view = renderHook(({ id }) => useNoteAppearance(id), { initialProps: { id: 'appearance-old' } });
    view.rerender({ id: 'appearance-new' });
    await waitFor(() => expect(view.result.current.value.preset).toBe('wide'));
    await act(async () => { finishFirst('{"preset":"compact","icon":"📚"}'); });
    expect(view.result.current.value).toMatchObject({ preset: 'wide', icon: '💡' });
  });

  it('keeps the persisted appearance on write failure and supports selecting again', async () => {
    vi.mocked(NotesAPI.setPref).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = renderHook(() => useNoteAppearance('appearance-write-failure'));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(() => view.result.current.update({ fullWidth: true }));
    expect(view.result.current.error).toBe('save');
    expect(view.result.current.value.fullWidth).toBe(false);
    await act(() => view.result.current.update({ fullWidth: true }));
    expect(view.result.current.value.fullWidth).toBe(true);
    expect(view.result.current.error).toBeNull();
  });

  it('retries a failed read before allowing writes', async () => {
    vi.mocked(NotesAPI.getPref).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('{"preset":"compact"}');
    const view = renderHook(() => useNoteAppearance('appearance-read-failure'));
    await waitFor(() => expect(view.result.current.error).toBe('load'));
    await act(() => view.result.current.update({ fullWidth: true }));
    expect(NotesAPI.setPref).not.toHaveBeenCalled();
    await act(() => view.result.current.reload());
    expect(view.result.current.value.preset).toBe('compact');
  });
});

describe('document appearance entry', () => {
  it('keeps the header affordance icon-only and persists the chosen icon', async () => {
    const view = render(<div className="notes-crepe-shell"><NotesEditorHeader noteId="appearance-header" initialTitle="Reading" lastSaved={null} readOnly /></div>);
    fireEvent.click(screen.getByRole('button', { name: '页面图标' }));
    const dialog = await screen.findByRole('dialog', { name: '页面图标' });
    expect(screen.queryByRole('button', { name: '宽幅' })).not.toBeInTheDocument();
    const idea = screen.getByRole('button', { name: '灵感' });
    await waitFor(() => expect(idea).not.toBeDisabled());
    fireEvent.click(idea);
    await waitFor(() => expect(view.container.querySelector('header')).toHaveTextContent('💡'));
    expect(JSON.parse(vi.mocked(NotesAPI.setPref).mock.calls.at(-1)![1])).toMatchObject({ icon: '💡' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '页面图标' })).toHaveFocus();
  });

  it('page-menu layout toggles combine and drive the header data attributes the shell styles read', async () => {
    const view = render(<div className="notes-crepe-shell">
      <NotePageLayoutOptions noteId="appearance-layout" />
      <NotesEditorHeader noteId="appearance-layout" initialTitle="Reading" lastSaved={null} readOnly />
    </div>);
    const small = screen.getByRole('switch', { name: '小字号' });
    await waitFor(() => expect(small).not.toBeDisabled());
    fireEvent.click(small);
    await waitFor(() => expect(small).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(screen.getByRole('switch', { name: '全宽' }));
    const header = view.container.querySelector('header')!;
    await waitFor(() => expect(header).toHaveAttribute('data-notes-full-width', 'true'));
    expect(header).toHaveAttribute('data-notes-small-text', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /衬线/ }));
    await waitFor(() => expect(header).toHaveAttribute('data-notes-font', 'serif'));
    expect(screen.getByRole('radio', { name: /衬线/ })).toHaveAttribute('aria-checked', 'true');
    for (const el of screen.getAllByRole('switch')) expect(el).toHaveAttribute('data-keep-open');
  });

  it('keeps page-level commands such as history out of the document header', () => {
    render(<NotesEditorHeader noteId="appearance-no-history" initialTitle="Reading" lastSaved={null} readOnly />);
    expect(screen.queryByRole('button', { name: '历史版本' })).not.toBeInTheDocument();
  });

  it('blocks a second in-flight write', async () => {
    let finishSave!: (saved: boolean) => void;
    vi.mocked(NotesAPI.setPref).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<NotePageLayoutOptions noteId="appearance-keyboard" />);
    const small = screen.getByRole('switch', { name: '小字号' });
    await waitFor(() => expect(small).not.toBeDisabled());
    fireEvent.click(small);
    fireEvent.click(screen.getByRole('switch', { name: '全宽' }));
    expect(NotesAPI.setPref).toHaveBeenCalledOnce();
    await act(async () => { finishSave(true); });
    expect(small).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: '全宽' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('page icon validation', () => {
  it('accepts any single emoji and rejects text or oversized values', () => {
    for (const icon of ['', '📐', '⚗️', '❤️', '🧑‍🔬']) expect(isValidNoteIcon(icon)).toBe(true);
    for (const icon of ['abc', '📐 📐', 'x'.repeat(20), 42, null]) expect(isValidNoteIcon(icon)).toBe(false);
  });

  it('keeps a stored custom emoji and drops an invalid one', () => {
    expect(parseNoteAppearance('{"preset":"wide","icon":"🦉"}')).toMatchObject({ preset: 'wide', icon: '🦉' });
    expect(parseNoteAppearance('{"preset":"wide","icon":"<b>"}')).toMatchObject({ preset: 'wide', icon: '' });
  });
});
