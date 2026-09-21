import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesAPI } from '@/utils/notesApi';
import { noteAppearanceKey, parseNoteAppearance, useNoteAppearance } from './noteAppearance';
import { NotesEditorHeader } from './components/NotesEditorHeader';

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
    expect(parseNoteAppearance('{"preset":"compact","icon":"📚"}')).toEqual({ preset: 'compact', icon: '📚' });
    expect(parseNoteAppearance('{"preset":"custom","icon":"unknown"}')).toEqual({ preset: 'standard', icon: '' });
    expect(parseNoteAppearance('invalid')).toEqual({ preset: 'standard', icon: '' });
  });

  it('shares writes between two hosts of one note, preserving the other appearance field', async () => {
    vi.mocked(NotesAPI.getPref).mockResolvedValue('{"preset":"compact","icon":"📚"}');
    const first = renderHook(() => useNoteAppearance('appearance-shared'));
    const second = renderHook(() => useNoteAppearance('appearance-shared'));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(NotesAPI.getPref).toHaveBeenCalledTimes(1);
    await act(() => first.result.current.update({ preset: 'wide' }));
    expect(NotesAPI.setPref).toHaveBeenCalledWith(noteAppearanceKey('appearance-shared'), '{"preset":"wide","icon":"📚"}');
    expect(second.result.current.value).toEqual({ preset: 'wide', icon: '📚' });
    first.unmount();
    second.unmount();
    const reopened = renderHook(() => useNoteAppearance('appearance-shared'));
    expect(reopened.result.current.value).toEqual({ preset: 'wide', icon: '📚' });
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
    expect(view.result.current.value).toEqual({ preset: 'wide', icon: '💡' });
  });

  it('keeps the persisted appearance on write failure and supports selecting again', async () => {
    vi.mocked(NotesAPI.setPref).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = renderHook(() => useNoteAppearance('appearance-write-failure'));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(() => view.result.current.update({ preset: 'wide' }));
    expect(view.result.current.error).toBe('save');
    expect(view.result.current.value.preset).toBe('standard');
    await act(() => view.result.current.update({ preset: 'wide' }));
    expect(view.result.current.value.preset).toBe('wide');
    expect(view.result.current.error).toBeNull();
  });

  it('retries a failed read before allowing writes', async () => {
    vi.mocked(NotesAPI.getPref).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('{"preset":"compact"}');
    const view = renderHook(() => useNoteAppearance('appearance-read-failure'));
    await waitFor(() => expect(view.result.current.error).toBe('load'));
    await act(() => view.result.current.update({ preset: 'wide' }));
    expect(NotesAPI.setPref).not.toHaveBeenCalled();
    await act(() => view.result.current.reload());
    expect(view.result.current.value.preset).toBe('compact');
  });
});

describe('document appearance entry', () => {
  it('connects the read-only page menu to the persisted state consumed by the shell', async () => {
    const onOpenHistory = vi.fn();
    const view = render(<div className="notes-crepe-shell"><NotesEditorHeader noteId="appearance-header" initialTitle="Reading" lastSaved={null} readOnly onOpenHistory={onOpenHistory} /></div>);
    fireEvent.click(screen.getByRole('button', { name: '页面外观' }));
    const wide = await screen.findByRole('button', { name: '宽幅' });
    await waitFor(() => expect(wide).not.toBeDisabled());
    fireEvent.click(wide);
    await waitFor(() => expect(view.container.querySelector('header')).toHaveAttribute('data-notes-preset', 'wide'));
    expect(wide).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '灵感' }));
    await waitFor(() => expect(view.container.querySelector('header')).toHaveTextContent('💡'));
    expect(NotesAPI.setPref).toHaveBeenLastCalledWith(noteAppearanceKey('appearance-header'), '{"preset":"wide","icon":"💡"}');
    const dialog = screen.getByRole('dialog', { name: '页面外观' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '页面外观' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '历史版本' }));
    expect(onOpenHistory).toHaveBeenCalledOnce();
  });

  it('omits history until the host supplies its callback', () => {
    render(<NotesEditorHeader noteId="appearance-no-history" initialTitle="Reading" lastSaved={null} readOnly />);
    expect(screen.queryByRole('button', { name: '历史版本' })).not.toBeInTheDocument();
  });

  it('keeps keyboard focus while saving and blocks a second in-flight write', async () => {
    let finishSave!: (saved: boolean) => void;
    vi.mocked(NotesAPI.setPref).mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    render(<NotesEditorHeader noteId="appearance-keyboard" initialTitle="Reading" lastSaved={null} readOnly />);
    fireEvent.click(screen.getByRole('button', { name: '页面外观' }));
    const wide = await screen.findByRole('button', { name: '宽幅' });
    await waitFor(() => expect(wide).not.toBeDisabled());
    // Wait for the popover's initial focus placement before choosing a preset.
    await waitFor(() => expect(screen.getByRole('button', { name: '标准' })).toHaveFocus());
    wide.focus();
    fireEvent.click(wide);
    expect(wide).toHaveFocus();
    expect(wide).not.toBeDisabled();
    expect(wide).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: '紧凑' }));
    expect(NotesAPI.setPref).toHaveBeenCalledOnce();
    await act(async () => { finishSave(true); });
    expect(wide).toHaveFocus();
    expect(wide).toHaveAttribute('aria-pressed', 'true');
  });
});
